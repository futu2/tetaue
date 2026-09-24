/******************************************************************************
 * tetaue SQL renderer — normalizes a Query value, then lowers it to SQL.
 *
 * Dialect definitions live in `render/dialects.ts`; this file owns expression,
 * query-plan, and final SQL rendering.
 ******************************************************************************/
import { querySchema } from '../core/ir.js';
import type { JoinKind, Query, SetOp, SqlNode } from '../core/ir.js';
import { optimizeQuery } from './optimize.js';
import { checkDialectCapabilities } from './capabilities.js';
import { DIALECTS, isDialect, quoteQualifiedName, type DialectSpec, type RenderFormat } from './render/dialects.js';
import { defaultSqlName, loweringFor } from './render/lowerings.js';

export { DIALECTS, isDialect } from './render/dialects.js';
export type { DialectSpec, RenderFormat } from './render/dialects.js';

const JOIN_SQL: Record<JoinKind, string> = {
    inner: 'INNER JOIN', left: 'LEFT JOIN', right: 'RIGHT JOIN', full: 'FULL JOIN',
};
/** Indent width for the pretty layout (pg_format-style 4 spaces). */
const INDENT = '    ';

/** Indent every line of `text` by `prefix`. */
function indentLines(text: string, prefix: string): string {
    return text.split('\n').map(line => prefix + line).join('\n');
}

/**
 * Flatten a top-level `AND` chain into its operands so the pretty printer
 * can lay each predicate out on its own line. The interpreter stores
 * `a AND b AND c` as `(a AND b) AND c`; recursion yields `[a, b, c]`. Any
 * other expression is a single element. Precedence is preserved when
 * operands are re-rendered (an embedded OR is parenthesized), so splitting
 * never changes the query's meaning.
 */
function flattenAnds(node: SqlNode): SqlNode[] {
    if (node.kind === 'bin' && node.op === 'AND') {
        return [...flattenAnds(node.left), ...flattenAnds(node.right)];
    }
    return [node];
}

/**
 * A clause whose items can be laid out one per line in pretty mode
 * (SELECT list, GROUP BY, ORDER BY). A single item stays inline.
 */
function renderListClause(kw: string, items: string[], pretty: boolean): string {
    if (pretty && items.length > 1) {
        return `${kw}\n${items.map((item, i) => `${INDENT}${item}${i < items.length - 1 ? ',' : ''}`).join('\n')}`;
    }
    return `${kw} ${items.join(', ')}`;
}

/**
 * Render a boolean-predicate clause (WHERE/HAVING). In pretty mode each
 * top-level AND operand gets its own line (renderExpr adds precedence
 * parens); in compact mode the historical single-line rendering — each
 * predicate parenthesized when there is more than one — is kept verbatim.
 */
function renderPredicateClause(kw: string, conds: SqlNode[], ctx: RenderCtx, pretty: boolean): string {
    if (pretty) {
        const parts = conds.flatMap(flattenAnds).map(c => renderExpr(c, ctx, precOf('AND')));
        if (parts.length === 1) return `${kw} ${parts[0]}`;
        return `${kw}\n${INDENT}${parts.join(`\n${INDENT}AND `)}`;
    }
    const rendered = conds.map(c => renderExpr(c, ctx));
    return rendered.length === 1
        ? `${kw} ${rendered[0]}`
        : `${kw} ${rendered.map(w => `(${w})`).join(' AND ')}`;
}

export type ParameterState = Map<string, number>;
type CteMap = ReadonlyMap<Query, string>;

interface RenderCtx {
    dialect: DialectSpec;
    qualify: boolean;
    readonly diagnostics: RenderDiagnostic[];
    readonly parameters: ParameterState;
    readonly ctes: CteMap;
    /** Table aliases visible from enclosing query scopes. */
    readonly outerAliases: ReadonlySet<string>;
    /** Table aliases introduced by the query currently being rendered. */
    readonly innerAliases: ReadonlySet<string>;
}

function renderFailure(ctx: RenderCtx, node: SqlNode, message: string): string {
    ctx.diagnostics.push({ message, node });
    return 'NULL';
}

function countTables(q: Query): number {
    return 1 + q.steps.filter(s => s.kind === 'join').length;
}

function lastProjection(q: Query): Extract<Query['steps'][number], { kind: 'map' | 'fold' | 'join' }> | null {
    for (let i = q.steps.length - 1; i >= 0; i--) {
        const step = q.steps[i]!;
        // A join step's merger lambda is a projection too: it selects the
        // result row, so it may supply the SELECT list.
        if (step.kind === 'map' || step.kind === 'fold' || step.kind === 'join') return step;
    }
    return null;
}

/**
 * The explicit SELECT list for a query whose schema is KNOWN but which has no
 * `map`/`fold`/join projection step (a schema-annotated `table`/`filter`
 * pipeline). Column order follows the root schema, and each column carries the
 * root alias so qualification matches the rest of the query. Returns null when
 * no known schema is available, so the caller falls back to `SELECT *`.
 */
function knownSchemaProjection(q: Query): readonly SqlNode[] | null {
    if (!q.known || q.root.schema.size === 0) return null;
    // A derived-table root with no steps is projected by the inner query.
    if (q.root.from && q.steps.length === 0) return null;
    const alias = q.aliases[0] ?? q.root.name;
    return [...q.root.schema].map(([key, col]) => col.expr ?? {
        kind: 'col' as const, name: key, table: alias, type: col.type,
    });
}

// --- expression rendering --------------------------------------------------

// SQL operator precedence (higher binds tighter)
const PREC: Record<string, number> = {
    '||': 1, OR: 1,
    '&&': 2, AND: 2,
    '=': 3, '!=': 3, '<': 3, '<=': 3, '>': 3, '>=': 3,
    '+': 4, '-': 4,
    '*': 5, '/': 5,
    IN: 6, NOT: 6, 'IS NULL': 6,
    CALL: 7, ATOM: 8,
};

function parenIf(child: string, childPrec: number, parentPrec: number): string {
    return childPrec < parentPrec ? `(${child})` : child;
}

function precOf(key: string): number {
    return PREC[key] ?? 0;
}

function escapeString(value: string, dialect: DialectSpec): string {
    return dialect.stringLiteral(value);
}

export function renderExpr(node: SqlNode, ctx: RenderCtx, parentPrec = 0): string {
    switch (node.kind) {
        case 'in-query': {
            const sub = renderQueryWithDiagnostics(
                node.query,
                ctx.dialect,
                'compact',
                ctx.diagnostics,
                ctx.ctes,
                ctx.parameters,
                new Set([...ctx.outerAliases, ...ctx.innerAliases]),
            );
            const text = `${renderExpr(node.expr, ctx, precOf('IN'))} ${node.negated ? 'NOT ' : ''}IN (${sub})`;
            return parenIf(text, precOf('IN'), parentPrec);
        }
        case 'scalar': {
            const sub = renderQueryWithDiagnostics(
                node.query,
                ctx.dialect,
                'compact',
                ctx.diagnostics,
                ctx.ctes,
                ctx.parameters,
                new Set([...ctx.outerAliases, ...ctx.innerAliases]),
            );
            return parenIf(`(${sub})`, precOf('ATOM'), parentPrec);
        }
        case 'exists': {
            const sub = renderQueryWithDiagnostics(
                node.query,
                ctx.dialect,
                'compact',
                ctx.diagnostics,
                ctx.ctes,
                ctx.parameters,
                new Set([...ctx.outerAliases, ...ctx.innerAliases]),
                true,
            );
            return parenIf(`EXISTS (${sub})`, precOf('ATOM'), parentPrec);
        }
        case 'param': {
            const existing = ctx.parameters.get(node.name);
            const index = existing ?? ctx.parameters.size + 1;
            if (existing === undefined) ctx.parameters.set(node.name, index);
            const text = ctx.dialect.name === 'postgresql' ? '$' + index : '?';
            return parenIf(text, precOf('ATOM'), parentPrec);
        }
        case 'lit': {
            let text: string;
            if (node.value === null) text = 'NULL';
            else if (typeof node.value === 'boolean') text = ctx.dialect.boolLiteral(node.value);
            else if (typeof node.value === 'string') text = escapeString(node.value, ctx.dialect);
            else text = String(node.value);
            return parenIf(text, precOf('ATOM'), parentPrec);
        }
        case 'col': {
            const correlated = node.table !== null
                && ctx.outerAliases.has(node.table)
                && !ctx.innerAliases.has(node.table);
            const q = (ctx.qualify || correlated) && node.table
                ? `${quoteQualifiedName(node.table, ctx.dialect)}.`
                : '';
            return parenIf(`${q}${ctx.dialect.quoteIdentifier(node.name)}`, precOf('ATOM'), parentPrec);
        }
        case 'bare':
            // An unquoted SQL word (EXTRACT(YEAR FROM x) needs YEAR, not
            // 'YEAR') emitted by the sql_bare lowering primitive.
            return parenIf(node.name, precOf('ATOM'), parentPrec);
        case 'fragment': {
            // An uninterpreted SQL fragment from `sql_fragment`: the template's
            // literal text with each `{}` replaced by its rendered argument.
            // `{{` / `}}` are escaped literal braces. A `{:}` hole renders its
            // argument BARE — the SQL text of a string without quoting — which
            // is how a computed SQL KEYWORD reaches the output (`INTERVAL 7
            // {}` needs `DAY`, not `'DAY'`). The result is opaque SQL, so it
            // renders at ATOM precedence — a caller that needs parentheses
            // writes them in the template (`"({})"`).
            let index = 0;
            const text = node.template.replace(/\{\{|\}\}|\{:\}|\{\}/g, match => {
                if (match === '{{') return '{';
                if (match === '}}') return '}';
                const arg = node.args[index++]!;
                if (match === '{:}') {
                    // A bare word: the literal's own text, unquoted. A
                    // non-literal argument is a programming error in the
                    // library, not in a user module, so it renders as SQL text
                    // rather than being silently dropped.
                    return arg.kind === 'lit' && typeof arg.value === 'string'
                        ? arg.value
                        : renderExpr(arg, ctx, precOf('CALL'));
                }
                return renderExpr(arg, ctx, precOf('CALL'));
            });
            return parenIf(text, precOf('ATOM'), parentPrec);
        }
        case 'bin': {
            const prec = precOf(node.op) || 3;
            // Comparisons are non-associative in SQL: parenthesize nested comparisons.
            const isCmp = node.op === '=' || node.op === '!=' || node.op === '<' || node.op === '<=' || node.op === '>' || node.op === '>=';
            const childPrec = isCmp ? prec + 1 : prec;
            const left = renderExpr(node.left, ctx, childPrec);
            const right = renderExpr(node.right, ctx, childPrec);
            const text = `${left} ${node.op} ${right}`;
            return parenIf(text, prec, parentPrec);
        }
        case 'is-null': {
            const inner = renderExpr(node.expr, ctx, precOf('IS NULL'));
            const text = `${inner} IS ${node.negated ? 'NOT ' : ''}NULL`;
            return parenIf(text, precOf('IS NULL'), parentPrec);
        }
        case 'not': {
            const inner = renderExpr(node.expr, ctx, precOf('NOT'));
            return parenIf(`NOT ${inner}`, precOf('NOT'), parentPrec);
        }
        case 'call': {
            const special = renderCall(node, ctx);
            if (special !== null) {
                return parenIf(special, precOf('CALL'), parentPrec);
            }
            const name = defaultSqlName(node.name, ctx.dialect);
            const text = `${name}(${node.args.map(a => renderExpr(a, ctx)).join(', ')})`;
            return parenIf(text, precOf('CALL'), parentPrec);
        }
        case 'current-date':
            return parenIf('CURRENT_DATE', precOf('ATOM'), parentPrec);
        case 'date-literal':
            return parenIf(
                ctx.dialect.name === 'sqlite'
                    ? ctx.dialect.stringLiteral(node.value)
                    : `DATE ${ctx.dialect.stringLiteral(node.value)}`,
                precOf('ATOM'),
                parentPrec,
            );
        case 'timestamp-literal':
            return parenIf(
                ctx.dialect.name === 'sqlite'
                    ? ctx.dialect.stringLiteral(node.value)
                    : `TIMESTAMP ${ctx.dialect.stringLiteral(node.value)}`,
                precOf('ATOM'),
                parentPrec,
            );
        case 'current-timestamp':
            return parenIf('CURRENT_TIMESTAMP', precOf('ATOM'), parentPrec);
        case 'in': {
            const inner = renderExpr(node.expr, ctx, precOf('IN'));
            const text = `${inner} ${node.negated ? 'NOT ' : ''}IN (${node.list.map(i => renderExpr(i, ctx)).join(', ')})`;
            return parenIf(text, precOf('IN'), parentPrec);
        }
        case 'agg': {
            const arg = renderExpr(node.arg, ctx);
            if (node.name === 'countDistinct') {
                const text = node.filter
                    ? `COUNT(DISTINCT CASE WHEN ${renderExpr(node.filter, ctx)} THEN ${arg} END)`
                    : `COUNT(DISTINCT ${arg})`;
                return parenIf(text, precOf('CALL'), parentPrec);
            }
            // `countWhere`/`sumWhere`/... are the filtered forms of the plain
            // aggregate: strip the `Where` suffix so one lookup serves both.
            const baseName = node.name.endsWith('Where') ? node.name.slice(0, -'Where'.length) : node.name;
            const name = defaultSqlName(baseName, ctx.dialect);
            if (!node.filter) {
                const text = `${name}(${arg})`;
                return parenIf(text, precOf('CALL'), parentPrec);
            }
            const cond = renderExpr(node.filter, ctx);
            const filteredArg = `CASE WHEN ${cond} THEN ${arg} END`;
            const text = ctx.dialect.name === 'postgresql' || ctx.dialect.name === 'trino' || ctx.dialect.name === 'sqlite'
                ? `${name}(${arg}) FILTER (WHERE ${cond})`
                : `${name}(${filteredArg})`;
            return parenIf(text, precOf('CALL'), parentPrec);
        }
        case 'group':
            return renderExpr(node.expr, ctx, parentPrec);
        case 'order':
            return renderExpr(node.expr, ctx, parentPrec);
        case 'window': {
            const fn = renderExpr(node.fn, ctx, precOf('CALL'));
            const inner: string[] = [];
            if (node.partition.length > 0) {
                inner.push(`PARTITION BY ${node.partition.map(p => renderExpr(p, ctx)).join(', ')}`);
            }
            if (node.order.length > 0) {
                inner.push(`ORDER BY ${node.order.map(o => `${renderExpr(o.node, ctx)} ${o.dir}`).join(', ')}`);
            }
            if (node.frame) {
                const to = node.frame.end === 0
                    ? 'CURRENT ROW'
                    : `${node.frame.end} FOLLOWING`;
                inner.push(`ROWS BETWEEN ${node.frame.start} PRECEDING AND ${to}`);
            }
            const over = inner.length > 0 ? ` OVER (${inner.join(' ')})` : ' OVER ()';
            return parenIf(`${fn}${over}`, precOf('CALL'), parentPrec);
        }
        case 'case': {
            // `case { c1 => v1, c2 => v2, ..., _ => e }` → CASE WHEN c1 THEN v1 WHEN c2 THEN v2 [ELSE e] END.
            // CASE is standard SQL in every supported dialect, so no per-dialect lowering.
            const text = `CASE ${node.branches.map(b => `WHEN ${renderExpr(b.cond, ctx)} THEN ${renderExpr(b.value, ctx)}`).join(' ')}${node.elseValue ? ` ELSE ${renderExpr(node.elseValue, ctx)}` : ''} END`;
            return parenIf(text, precOf('CALL'), parentPrec);
        }
    }
}

function renderCall(node: Extract<SqlNode, { kind: 'call' }>, ctx: RenderCtx): string | null {
    const lower = loweringFor(node.name);
    if (!lower) return null; // no special form: the default NAME(...) path

    const d = ctx.dialect;
    return lower({
        name: node.name,
        dialect: d.name,
        arity: node.args.length,
        arg: (k) => renderExpr(node.args[k]!, ctx, precOf('CALL')),
        stringLiteral: (value) => d.stringLiteral(value),
        castTypeName: (tetaueType) => sqlTypeName(tetaueType, d.name),
        literal: (k) => {
            const a = node.args[k];
            return a?.kind === 'lit' && typeof a.value === 'string' ? a.value : null;
        },
        numberLiteral: (k) => {
            const a = node.args[k];
            return a?.kind === 'lit' && typeof a.value === 'number' ? a.value : null;
        },
    });
}

/** tetaue scalar type name → per-dialect SQL cast type. */
function sqlTypeName(t: string, d: string): string {
    switch (t) {
        case 'int': return d === 'hive' ? 'INT' : d === 'mysql' ? 'SIGNED' : 'INTEGER';
        case 'decimal': return d === 'postgresql' ? 'NUMERIC' : 'DECIMAL';
        case 'float': return d === 'sqlite' ? 'REAL' : d === 'postgresql' ? 'DOUBLE PRECISION' : 'DOUBLE';
        case 'string': return d === 'mysql' ? 'CHAR' : d === 'hive' ? 'STRING' : d === 'sqlite' ? 'TEXT' : 'VARCHAR';
        case 'bool':
            return d === 'sqlite' ? 'INTEGER' : 'BOOLEAN';
        case 'date': return 'DATE';
        case 'timestamp': return 'TIMESTAMP';
    }
    return t.toUpperCase();
}

// --- set-operation rendering ------------------------------------------------

const NO_CTES: CteMap = new Map();

function renderSetQuery(q: Query, dialect: DialectSpec, format: RenderFormat, diagnostics: RenderDiagnostic[], ctes: CteMap, parameters: ParameterState, outerAliases: ReadonlySet<string>): string {
    const index = q.steps.findIndex(s => s.kind === 'set');
    const step = q.steps[index]!;
    if (step.kind !== 'set') {
        diagnostics.push({ message: 'internal: set step expected', node: step });
        return 'SELECT * FROM (SELECT NULL) AS "render_error"';
    }
    if (dialect.setOps && !dialect.setOps.includes(step.op)) {
        diagnostics.push({
            message: `${step.op} is not supported for the ${dialect.name} dialect`,
            node: step,
        });
        return 'SELECT NULL';
    }
    // `distinct` is a property of the COMBINED result, not of the left
    // operand: `a & unionAll b & distinct` means "deduplicate the union".
    // Leaving it on `left` would render `SELECT DISTINCT ... FROM a UNION ALL
    // ... FROM b`, where DISTINCT applies to the left operand alone and the
    // right operand's duplicates survive. Peel it off here and re-apply it to
    // the whole set expression below.
    const distinct = q.distinct;
    const left: Query = { ...q, distinct: false, steps: q.steps.slice(0, index) };
    const right = step.right;

    // SQL set operations match columns POSITIONALLY, while tetaue rows are
    // unordered records. Never rely on `SELECT *` here: project an explicit,
    // shared column order on both operands. A dynamic (un-annotated) table
    // has no known order and cannot be rendered safely as a set operand.
    if (!left.known || !right.known) {
        diagnostics.push({
            message: `${step.op} requires known schemas on both operands — annotate each table or project it with map first`,
            node: step,
        });
        return 'SELECT NULL';
    }
    const labels = [...querySchema(left).keys()];
    const rightLabels = new Set(querySchema(right).keys());
    for (const label of labels) {
        if (!rightLabels.has(label)) {
            diagnostics.push({
                message: `${step.op} requires matching columns — right operand is missing '${label}'`,
                node: step,
            });
            return 'SELECT NULL';
        }
    }

    const innerFormat: RenderFormat = format === 'pretty' ? 'pretty' : 'compact';
    const leftSql = renderQueryWithDiagnostics(left, dialect, innerFormat, diagnostics, ctes, parameters, outerAliases);
    const rightSql = renderQueryWithDiagnostics(right, dialect, innerFormat, diagnostics, ctes, parameters, outerAliases);
    const columns = labels.map(label => dialect.quoteIdentifier(label)).join(', ');
    const wrap = (sql: string, alias: string): string => {
        const aliasSql = dialect.quoteIdentifier(alias);
        return format === 'pretty'
            ? `SELECT ${columns}\nFROM (\n${indentLines(sql, INDENT)}\n) AS ${aliasSql}`
            : `SELECT ${columns} FROM (${sql}) AS ${aliasSql}`;
    };
    const leftOp = wrap(leftSql, '_tetaue_left');
    const rightOp = wrap(rightSql, '_tetaue_right');
    const setSql = format === 'pretty' ? `${leftOp}\n${step.op}\n${rightOp}` : `${leftOp} ${step.op} ${rightOp}`;
    if (!distinct) return setSql;
    // A `distinct` over the set operation deduplicates the combined rows, so
    // it must wrap the whole UNION/INTERSECT/EXCEPT rather than either operand.
    const aliasSql = dialect.quoteIdentifier('_tetaue_distinct');
    return format === 'pretty'
        ? `SELECT DISTINCT ${columns}\nFROM (\n${indentLines(setSql, INDENT)}\n) AS ${aliasSql}`
        : `SELECT DISTINCT ${columns} FROM (${setSql}) AS ${aliasSql}`;
}

// --- query rendering -------------------------------------------------------

function renderQueryWithDiagnostics(q: Query, dialect: DialectSpec, format: RenderFormat, diagnostics: RenderDiagnostic[], ctes: CteMap = NO_CTES, parameters: ParameterState = new Map(), outerAliases: ReadonlySet<string> = new Set(), existsSubquery = false): string {
    // A set step is a complete relational operation, not a clause in the
    // surrounding SELECT: render it as operand-wrapped UNION/INTERSECT/EXCEPT.
    if (q.steps.some(s => s.kind === 'set')) return renderSetQuery(q, dialect, format, diagnostics, ctes, parameters, outerAliases);

    const innerAliases = new Set(q.aliases);
    const ctx: RenderCtx = { dialect, qualify: countTables(q) > 1, diagnostics, parameters, ctes, innerAliases, outerAliases };
    const pretty = format === 'pretty';
    const clauses: string[] = [];

    let recursivePrefix = '';
    if (q.recursive) {
        if (dialect.recursive === false) {
            diagnostics.push({ message: `recursive CTEs are not supported for the ${dialect.name} dialect`, node: q.recursive });
            return 'SELECT NULL';
        }
        const rec = q.recursive;
        const baseSql = renderQueryWithDiagnostics(q.root.from!, dialect, 'compact', diagnostics, ctes, parameters, outerAliases);
        const termSql = renderQueryWithDiagnostics(rec.term, dialect, 'compact', diagnostics, ctes, parameters, outerAliases);
        const name = dialect.quoteIdentifier(rec.name);
        if (pretty) {
            recursivePrefix = `WITH RECURSIVE ${name} AS (\n${indentLines(baseSql, INDENT)}\nUNION ALL\n${indentLines(termSql, INDENT)}\n)\n`;
        } else {
            recursivePrefix = `WITH RECURSIVE ${name} AS (${baseSql} UNION ALL ${termSql}) `;
        }
    }

    // SELECT
    const projection = lastProjection(q);
    let select: string;
    if (projection) {
        const items = projection.proj.fields.map(({ key, node }) => {
            const rendered = renderExpr(node, ctx);
            const isPlainCol = (node.kind === 'col' && node.name === key)
                || (node.kind === 'group' && node.expr.kind === 'col' && node.expr.name === key);
            return isPlainCol ? rendered : `${rendered} AS ${dialect.quoteIdentifier(key)}`;
        });
        const head = `SELECT${q.distinct ? ' DISTINCT' : ''}`;
        select = pretty && items.length > 1
            ? renderListClause(head, items, true)
            : `${head} ${items.join(', ')}`;
    } else if (existsSubquery) {
        // An EXISTS subquery's select list is irrelevant to SQL semantics, so
        // emit the conventional constant list instead of enumerating columns.
        select = 'SELECT 1';
    } else {
        // No projection step, but the row shape is still known — a
        // schema-annotated `table`/`filter` pipeline. Project the declared
        // columns instead of `*`, so an annotation is a real column contract
        // rather than a type-level claim only. An un-annotated (dynamic) query
        // keeps `SELECT *`.
        const schemaColumns = knownSchemaProjection(q);
        if (schemaColumns) {
            const items = schemaColumns.map(col => renderExpr(col, ctx));
            const head = `SELECT${q.distinct ? ' DISTINCT' : ''}`;
            select = pretty && items.length > 1
                ? renderListClause(head, items, true)
                : `${head} ${items.join(', ')}`;
        } else {
            select = `SELECT${q.distinct ? ' DISTINCT' : ''} *`;
        }
    }
    clauses.push(select);
    // A schema-qualified root name (`public.users`) is aliased to its last
    // segment so column references render as `alias.column`, never
    // `schema.table.column` (invalid in Hive, SQLite, and others). Plain
    // names need no alias — the table name is already a valid qualifier.
    // A derived-table root (a fold wrapped by a later map/join) renders as a
    // subquery with its own alias.
    if (q.root.from) {
        if (q.recursive) {
            clauses.push(`FROM ${dialect.quoteIdentifier(q.recursive.name)}`);
        } else {
            const cteName = ctes.get(q.root.from);
            if (cteName !== undefined) {
                // A CTE reference is a bare table; the site's own alias
                // (`q.aliases[0]`, the name outer columns are qualified
                // with) must be reapplied or every `alias.column` reference
                // would point at a nonexistent table. Skipped when the CTE
                // name already matches.
                const siteAlias = q.aliases[0] ?? q.root.name;
                clauses.push(`FROM ${dialect.quoteIdentifier(cteName)}${cteName !== siteAlias ? ` AS ${dialect.quoteIdentifier(siteAlias)}` : ''}`);
            } else {
                const derivedAlias = q.aliases[0] ?? q.root.name;
                clauses.push(pretty
                    ? `FROM (\n${indentLines(renderQueryWithDiagnostics(q.root.from, dialect, 'pretty', ctx.diagnostics, ctes, ctx.parameters, outerAliases), INDENT)}\n) AS ${dialect.quoteIdentifier(derivedAlias)}`
                    : `FROM (${renderQueryWithDiagnostics(q.root.from, dialect, 'compact', ctx.diagnostics, ctes, ctx.parameters, outerAliases)}) AS ${dialect.quoteIdentifier(derivedAlias)}`);
            }
        }
    } else {
        const rootAlias = q.aliases[0] ?? q.root.name;
        const rootAliasClause = ctx.qualify && rootAlias !== q.root.name
            ? ` AS ${dialect.quoteIdentifier(rootAlias)}`
            : '';
        clauses.push(`FROM ${quoteQualifiedName(q.root.name, dialect)}${rootAliasClause}`);
    }

    // JOINs
    for (const step of q.steps) {
        if (step.kind === 'join') {
            if (step.lateral && dialect.lateral === false) {
                ctx.diagnostics.push({ message: `lateral joins are not supported for the ${dialect.name} dialect`, node: step });
                continue;
            }
            const right = step.right;
            const rightAlias = right.aliases[0] ?? right.root.name;
            const plainTable = !step.lateral && right.steps.length === 0 && !right.distinct && !right.root.from;
            let rightSql: string;
            if (plainTable) {
                // plain table: `JOIN orders [AS orders_1]`
                const aliasClause = rightAlias === right.root.name
                    ? ''
                    : ` AS ${dialect.quoteIdentifier(rightAlias)}`;
                rightSql = `${quoteQualifiedName(right.root.name, dialect)}${aliasClause}`;
            } else {
                // stepped or derived right side: render as a subquery so
                // joins compose
                // Lateral rights are correlated with the left row, so they
                // are never collected as CTEs; guard the lookup anyway.
                const cteName = step.lateral ? undefined : ctes.get(right);
                rightSql = cteName !== undefined
                    // Reapply the join-site alias: the CTE name may differ
                    // from the alias the ON clause qualifies columns with.
                    ? `${dialect.quoteIdentifier(cteName)}${cteName !== rightAlias ? ` AS ${dialect.quoteIdentifier(rightAlias)}` : ''}`
                    : pretty
                        ? `(\n${indentLines(renderQueryWithDiagnostics(right, dialect, 'pretty', ctx.diagnostics, ctes, ctx.parameters, step.lateral ? new Set([...ctx.outerAliases, ...ctx.innerAliases]) : outerAliases), INDENT)}\n) AS ${dialect.quoteIdentifier(rightAlias)}`
                        : `(${renderQueryWithDiagnostics(right, dialect, 'compact', ctx.diagnostics, ctes, ctx.parameters, step.lateral ? new Set([...ctx.outerAliases, ...ctx.innerAliases]) : outerAliases)}) AS ${dialect.quoteIdentifier(rightAlias)}`;
            }
            if (dialect.joinKinds && !dialect.joinKinds.includes(step.joinKind)) {
                ctx.diagnostics.push({
                    message: `${step.joinKind} join is not supported for the ${dialect.name} dialect`,
                    node: step,
                });
                continue;
            }
            const onClause = `ON ${renderExpr(step.on, ctx)}`;
            // In pretty mode a subquery join is laid out vertically so the
            // ON condition sits on its own indented line.
            const joinKeyword = step.lateral ? 'INNER JOIN LATERAL' : JOIN_SQL[step.joinKind];
            clauses.push(pretty && !plainTable
                ? `${joinKeyword} ${rightSql}\n${INDENT}${onClause}`
                : `${joinKeyword} ${rightSql} ${onClause}`);
        }
    }

    // WHERE (predicates applied before aggregation)
    const whereNodes = q.steps
        .filter((s): s is Extract<Query['steps'][number], { kind: 'filter' }> => s.kind === 'filter' && !s.having)
        .map(s => s.cond);
    if (whereNodes.length > 0) {
        clauses.push(renderPredicateClause('WHERE', whereNodes, ctx, pretty));
    }

    // GROUP BY (from the last fold)
    const fold = [...q.steps].reverse().find(s => s.kind === 'fold');
    if (fold && fold.kind === 'fold') {
        const groups = fold.proj.fields
            .filter((f): f is { key: string; node: Extract<SqlNode, { kind: 'group' }> } => f.node.kind === 'group')
            .map(f => renderExpr(f.node.expr, ctx));
        if (groups.length > 0) {
            clauses.push(renderListClause('GROUP BY', groups, pretty));
        }
    }

    // HAVING (predicates applied after aggregation)
    const havingNodes = q.steps
        .filter((s): s is Extract<Query['steps'][number], { kind: 'filter' }> => s.kind === 'filter' && s.having)
        .map(s => s.cond);
    if (havingNodes.length > 0) {
        clauses.push(renderPredicateClause('HAVING', havingNodes, ctx, pretty));
    }

    // ORDER BY
    const sorts = q.steps.filter(s => s.kind === 'sort').flatMap(s => s.items);
    if (sorts.length > 0) {
        clauses.push(renderListClause('ORDER BY', sorts.map(s => `${renderExpr(s.node, ctx)} ${s.dir}`), pretty));
    }

    // LIMIT / OFFSET
    // Within one Query object, interpreter boundaries guarantee that all
    // drop steps precede all take steps. SQL's clause order is exactly that:
    // OFFSET skips first, LIMIT keeps the next rows.
    const drops = q.steps.filter(s => s.kind === 'drop');
    const takes = q.steps.filter(s => s.kind === 'take');
    const offset = drops.reduce((sum, s) => sum + s.n, 0);
    if (offset > 0) {
        const offsetMode = dialect.offset ?? 'standard';
        if (offsetMode === 'none') {
            ctx.diagnostics.push({ message: `OFFSET (drop) is not supported for the ${dialect.name} dialect`, node: drops[0] });
        } else if (takes.length > 0) {
            const last = takes[takes.length - 1]!;
            clauses.push(`LIMIT ${last.n} OFFSET ${offset}`);
        } else if (offsetMode === 'mysql') {
            clauses.push(`LIMIT 18446744073709551615 OFFSET ${offset}`);
        } else if (offsetMode === 'sqlite') {
            clauses.push(`LIMIT -1 OFFSET ${offset}`);
        } else {
            clauses.push(`OFFSET ${offset}`);
        }
    } else if (takes.length > 0) {
        const last = takes[takes.length - 1]!;
        clauses.push(`LIMIT ${last.n}`);
    }

    const body = pretty ? clauses.join('\n') : clauses.join(' ');
    return recursivePrefix + body;
}

export interface RenderDiagnostic {
    message: string;
    /** The originating SQL/IR node when known. */
    node?: unknown;
}

export type RenderResult =
    | { ok: true; sql: string; parameters: string[] }
    | { ok: false; diagnostics: RenderDiagnostic[] };

/**
 * Walk the render tree to collect named, non-trivial subqueries in `q` in
 * dependency order so they can be emitted as CTEs. The top-level query is
 * never a CTE. Lateral join rights are correlated with the enclosing left
 * row, so they are never collected (inline only).
 */
function collectCtes(top: Query, dialect: DialectSpec): CteMap {
    const ctes = new Map<Query, string>();
    const used = new Map<string, number>();
    // Real table names anywhere in the render tree (including lateral right
    // subtrees). A CTE must not reuse one: in standard SQL the CTE name is
    // in scope from the WITH keyword on, so `WITH t AS (SELECT * FROM t ...)`
    // self-references the CTE (SQLite: "circular reference") instead of the
    // real table. Suffix the claimed name until it is collision-free.
    const tableNames = new Set<string>();
    const collectTables = (q: Query): void => {
        if (q.root.from) {
            collectTables(q.root.from);
        } else {
            tableNames.add(q.root.name);
        }
        for (const step of q.steps) {
            if (step.kind === 'join' || step.kind === 'set') collectTables(step.right);
        }
    };
    collectTables(top);

    const claim = (name: string): string => {
        let i = used.get(name) ?? 0;
        let candidate = i === 0 ? name : `${name}_${i}`;
        while (tableNames.has(candidate)) {
            i += 1;
            candidate = `${name}_${i}`;
        }
        used.set(name, i + 1);
        return candidate;
    };

    const visit = (q: Query, parent: Query | null): void => {
        if (q.root.from) visit(q.root.from, q);
        for (const step of q.steps) {
            if (step.kind === 'join' && step.lateral) continue; // correlated: inline only
            if (step.kind === 'join' || step.kind === 'set') visit(step.right, q);
        }
        // A shared query is reached once per reference site; claim it on the
        // first visit so repeated references keep a stable, unsuffixed name.
        if (parent !== null && !ctes.has(q) && q.name && (q.steps.length > 0 || q.distinct || q.root.from)) {
            ctes.set(q, claim(q.name));
        }
    };

    visit(top, null);
    return ctes;
}

/** Assemble the `WITH name AS (...), ...` header for a CTE map. */
function renderCtes(bodies: readonly { name: string; sql: string }[], dialect: DialectSpec): string {
    if (bodies.length === 0) return '';
    return `WITH ${bodies.map((b, i) => `${dialect.quoteIdentifier(b.name)} AS (\n${indentLines(b.sql, INDENT)}\n)${i < bodies.length - 1 ? ',' : ''}`).join('\n')}\n`;
}

/**
 * Pure renderer entry point: lowering errors are data, not exceptions.
 * Dialect capability failures are preflighted before this lowering pass;
 * defensive checks remain in the renderer for malformed hand-built IR.
 * Every named intermediate query is emitted as a `WITH name AS (...)` CTE,
 * so the body references it by name instead of duplicating the subquery.
 */
export function renderQuery(q: Query, dialect: DialectSpec, format: RenderFormat = 'pretty'): RenderResult {
    const diagnostics: RenderDiagnostic[] = [];
    const parameters: ParameterState = new Map();
    try {
        const normalized = optimizeQuery(q);
        const capabilityDiagnostics = checkDialectCapabilities(normalized, dialect);
        if (capabilityDiagnostics.length > 0) return { ok: false, diagnostics: capabilityDiagnostics };
        const ctes = collectCtes(normalized, dialect);
        const bodies = [...ctes].map(([query, name]) => {
            const sql = renderQueryWithDiagnostics(query, dialect, 'compact', diagnostics, ctes, parameters);
            return { name, sql };
        });
        const body = renderQueryWithDiagnostics(normalized, dialect, format, diagnostics, ctes, parameters);
        if (diagnostics.length > 0) return { ok: false, diagnostics };
        return { ok: true, sql: renderCtes(bodies, dialect) + body, parameters: [...parameters.keys()] };
    } catch (err) {
        return {
            ok: false,
            diagnostics: [{
                message: err instanceof Error ? err.message : String(err),
                node: undefined,
            }],
        };
    }
}

/**
 * Compatibility alias: CTE rendering is now the default; this entry point
 * exists for callers that previously opted in explicitly.
 */
export function renderQueryWithCtes(q: Query, dialect: DialectSpec, format: RenderFormat = 'pretty'): RenderResult {
    return renderQuery(q, dialect, format);
}
