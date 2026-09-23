/******************************************************************************
 * tetaue SQL IR — the symbolic intermediate representation.
 *
 * This is the language-independent plan the evaluator builds and the renderer
 * consumes: scalar expressions (`SqlNode`) and relational structure
 * (`Query` / `QueryStep`), plus the `Schema` metadata that travels with them.
 * It deliberately depends on nothing but Langium's `AstNode` (kept only so a
 * render-time diagnostic can point at source) — no `Value`, no `Ctx`, no
 * evaluator state — so both the interpreter and every back end can import it
 * without a cycle.
 *
 * Extracted verbatim from `interpreter.ts` (stage 1 of
 * docs/design/architecture.md); the definitions are unchanged.
 ******************************************************************************/
import type { AstNode } from 'langium';

export type SqlType = 'int' | 'float' | 'decimal' | 'string' | 'bool' | 'date' | 'timestamp' | 'array' | 'unknown';
export type TypeOrNull = SqlType | 'null';

export interface SqlColumn {
    readonly type: SqlType;
    /** Table name for qualification, or null for computed columns. */
    readonly table: string | null;
    /**
     * For derived columns (projections from map/fold): the defining SQL
     * expression, inlined whenever the column is referenced later in the
     * pipeline (teta-style). Undefined for base table columns.
     */
    readonly expr?: SqlNode;
}
export type Schema = ReadonlyMap<string, SqlColumn>;

export type SqlNodeBase =
    | { readonly kind: 'col'; readonly name: string; readonly table: string | null; readonly type: SqlType }
    | { readonly kind: 'bare'; readonly name: string; readonly type: SqlType }
    | { readonly kind: 'fragment'; readonly template: string; readonly args: readonly SqlNode[]; readonly type: SqlType }
    | { readonly kind: 'lit'; readonly value: number | string | boolean | null; readonly type: TypeOrNull }
    | { readonly kind: 'bin'; readonly op: string; readonly left: SqlNode; readonly right: SqlNode; readonly type: SqlType }
    | { readonly kind: 'is-null'; readonly expr: SqlNode; readonly negated: boolean; readonly type: 'bool' }
    | { readonly kind: 'not'; readonly expr: SqlNode; readonly type: 'bool' }
    | { readonly kind: 'call'; readonly name: string; readonly args: readonly SqlNode[]; readonly type: SqlType }
    | { readonly kind: 'param'; readonly name: string; readonly type: SqlType }
    | { readonly kind: 'current-date'; readonly type: 'date' }
    | { readonly kind: 'date-literal'; readonly value: string; readonly type: 'date' }
    | { readonly kind: 'timestamp-literal'; readonly value: string; readonly type: 'timestamp' }
    | { readonly kind: 'current-timestamp'; readonly type: 'timestamp' }
    | { readonly kind: 'in'; readonly expr: SqlNode; readonly list: readonly SqlNode[]; readonly negated: boolean; readonly type: 'bool' }
    | { readonly kind: 'exists'; readonly query: Query; readonly type: 'bool' }
    | { readonly kind: 'scalar'; readonly query: Query; readonly type: SqlType }
    | { readonly kind: 'in-query'; readonly expr: SqlNode; readonly query: Query; readonly negated: boolean; readonly type: 'bool' }
    | { readonly kind: 'agg'; readonly name: string; readonly arg: SqlNode; readonly filter?: SqlNode; readonly type: SqlType }
    | { readonly kind: 'group'; readonly expr: SqlNode; readonly table: string | null; readonly type: SqlType }
    | { readonly kind: 'order'; readonly expr: SqlNode; readonly dir: 'ASC' | 'DESC'; readonly type: SqlType }
    | { readonly kind: 'window'; readonly fn: SqlNode; readonly partition: readonly SqlNode[]; readonly order: readonly { node: SqlNode; dir: 'ASC' | 'DESC' }[]; readonly frame: { start: number; end: number } | null; readonly type: SqlType }
    | { readonly kind: 'case'; readonly branches: readonly { cond: SqlNode; value: SqlNode }[]; readonly elseValue: SqlNode | null; readonly type: SqlType };

/**
 * Every SQL expression node optionally remembers the source AST node that
 * produced it, so render-time capability errors can be positioned precisely.
 */
export type SqlNode = SqlNodeBase & { readonly ast?: AstNode };

export interface RowNode {
    readonly fields: readonly { key: string; node: SqlNode }[];
}

export type JoinKind = 'inner' | 'left' | 'right' | 'full';
export type SetOp = 'UNION' | 'UNION ALL' | 'INTERSECT' | 'EXCEPT';

export type QueryStep =
    | { readonly kind: 'filter'; readonly cond: SqlNode; readonly having: boolean; readonly ast?: AstNode }
    | { readonly kind: 'map'; readonly proj: RowNode; readonly ast?: AstNode }
    | { readonly kind: 'sort'; readonly items: readonly { node: SqlNode; dir: 'ASC' | 'DESC' }[]; readonly ast?: AstNode }
    | { readonly kind: 'take'; readonly n: number; readonly ast?: AstNode }
    | { readonly kind: 'drop'; readonly n: number; readonly ast?: AstNode }
    | { readonly kind: 'fold'; readonly proj: RowNode; readonly ast?: AstNode }
    | { readonly kind: 'join'; readonly joinKind: JoinKind; readonly right: Query; readonly on: SqlNode; readonly proj: RowNode; readonly lateral?: boolean; readonly ast?: AstNode }
    | { readonly kind: 'set'; readonly op: SetOp; readonly right: Query; readonly ast?: AstNode };

export interface Query {
    /**
     * The tetaue binding name this query was assigned, when it came from a
     * binding (`paid = orders & filter ...`). Rendered SQL prefers it for
     * generated aliases (derived tables, joined subqueries) over invented
     * names, so the output reads like the source.
     */
    readonly name?: string;
    readonly root: {
        readonly name: string;
        readonly schema: Schema;
        /**
         * A derived table: the query is `(SELECT ... FROM ... ) AS name` rather
         * than a real table. Set when a pipeline step is applied after a fold
         * (map/join wrap the aggregated result so it can be projected or
         * joined again, teta-style — a fold ends the flat FROM scope).
         */
        readonly from?: Query;
    };
    /**
     * Whether the query's schema is complete. A bare `table "users"` with no
     * binding annotation has an unknown schema (`known: false`): columns are
     * synthesized lazily and type checks relax. `map`/`fold` projections and
     * a schema annotation make it known again.
     */
    readonly known: boolean;
    /**
     * Table aliases in FROM-clause order (root first). A table name that
     * appears more than once in one query gets suffixed aliases (users,
     * users_1, ...) so self-joins stay unambiguous. Column nodes carry the
     * alias in their `table` field.
     */
    readonly aliases: readonly string[];
    readonly steps: readonly QueryStep[];
    readonly distinct: boolean;
    /**
     * When this query is the RESULT of the recursive step, root.from is the
     * initial term, recursive.name is the CTE name, and recursive.term is the
     * recursive term (which references the CTE name as a join source).
     */
    readonly recursive?: { readonly name: string; readonly term: Query };
}

// ---------------------------------------------------------------------------
// Schema derivation
//
// Pure IR -> Schema functions, moved here from `interpreter.ts` so the renderer
// (and any future back end) can compute a query's output schema WITHOUT
// importing the 4,000-line evaluator. They depend only on the IR types above.
// ---------------------------------------------------------------------------

/** The source table a column came from, when it is a plain (or grouped) column. */
export function nodeTable(node: SqlNode): string | null {
    return node.kind === 'col' ? node.table : (node.kind === 'group' ? node.table : null);
}

/**
 * The schema of a projection: a NULL-typed field is a placeholder the
 * interpreter has not resolved yet, so it is left out rather than admitted as a
 * column of type `null`.
 */
export function rowNodeSchema(row: RowNode): Schema {
    const schema = new Map<string, SqlColumn>();
    for (const field of row.fields) {
        if (field.node.type === "null") continue;
        schema.set(field.key, {
            type: field.node.type as SqlType,
            table: nodeTable(field.node),
            expr: field.node,
        });
    }
    return schema;
}

/**
 * The output schema of a query after all its steps. Only the projections
 * (`map` / `fold`, and a join's merger row) change the schema; filters,
 * ordering, limits and set operations preserve it.
 */
export function querySchema(q: Query): Schema {
    let schema: Schema = new Map(q.root.schema);
    for (const step of q.steps) {
        switch (step.kind) {
            case 'filter': case 'sort': case 'take': case 'drop': case 'set': break;
            case 'map': case 'fold': schema = rowNodeSchema(step.proj); break;
            // The join's merger lambda projects the result row (like map).
            case 'join': schema = rowNodeSchema(step.proj); break;
        }
    }
    return schema;
}
