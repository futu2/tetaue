/******************************************************************************
 * tetaue type inference — a Hindley–Milner pass with row polymorphism.
 *
 * Runs over the same module list as the interpreter (imports first, root
 * last, one shared environment) and computes a static type for every
 * expression. Diagnostics are emitted as { node, message } and are phrased to
 * match the interpreter's messages where the two passes share a check, so the
 * aggregation layer can dedupe by (node, message).
 *
 * Row polymorphism: a row lambda is typed once against fresh row variables
 * (`u => u.age >= 18` : `forall r. { age: int? | r } -> bool`) and
 * instantiated at each use. Nullability is Maybe-style (`t?`, absorbed in
 * unification); numerics are strict (int and float are unrelated). See
 * docs/design/type-system.md.
 ******************************************************************************/
import type { AstNode } from 'langium';
import {
    isAccessExpression, isAscription, isApplication, isBinaryExpression,
    isBooleanLiteral, isCaseExpression, isDollarParam, isFunType, isIdentifier, isLambda,
    isLambdaBinaryExpression, isListLiteral, isListType, isMapLiteral, isNullLiteral, isNullType,
    isNumberLiteral, isQueryType, isRecordType, isStringLiteral, isTypeParen,
    isTypeVar, isUnaryMinus,
    type Binding, type CaseExpression, type Expr, type Model,
} from './generated/ast.js';
import type { Type as LangiumType } from './generated/ast.js';
import {
    TypeUniverse, UnifyError, type Scheme, type Type, type VarKind,
    fun, listOf, nullable, prim, queryOf, rowOf,
} from './types.js';
import type { NumberLiteral, UnaryExpression } from './generated/ast.js';
import type { ProjectModule } from './imports.js';
import { moduleOf } from './imports.js';
import { parseStringLiteral } from './interpreter.js';

export interface InferDiagnostic {
    node: AstNode | undefined;
    message: string;
}

/** Builtins whose application takes ALL arguments at once (no currying). */
const VARIADIC_BUILTINS = new Set(['concat', 'greatest', 'least', 'round', 'substring', 'lpad', 'rpad', 'regex_extract', 'lag', 'lead']);

/**
 * Result of a project inference pass: diagnostics plus the static type
 * recorded for every expression and binding node, used by hover and
 * completion (`. `-field access) in the language server.
 */
export interface InferProjectResult {
    diagnostics: InferDiagnostic[];
    /** Static type of each expression / binding node, keyed by node identity. */
    nodeTypes: Map<AstNode, Type>;
    /** Rendered (resolved) type text of a node, or undefined. */
    typeOf(node: AstNode): string | undefined;
    /** Row fields of a node's type (unwrapping `?`), with rendered types, or undefined. */
    fieldsOf(node: AstNode): { name: string; type: string }[] | undefined;
}

const PRIM_NAMES = ['int', 'float', 'string', 'bool', 'date', 'timestamp'] as const;
type PrimName = (typeof PRIM_NAMES)[number];

function isPrimName(name: string): name is PrimName {
    return (PRIM_NAMES as readonly string[]).includes(name);
}

/** A literal is `float` iff its source text contains '.', so `100.0` is float. */
function numberLiteralType(e: NumberLiteral): 'int' | 'float' {
    return e.$cstNode?.text.includes('.') ? 'float' : 'int';
}

function isNumericPrim(t: Type): boolean {
    return t.kind === 'prim' && (t.name === 'int' || t.name === 'float');
}

/**
 * Scope-collision message helpers — worded identically to the interpreter's
 * (`interpreter.ts`) so `mergeDiagnostics` dedupes the pair.
 */
function conflictMessage(name: string, existing: string, newcomer: string): string {
    return `name '${name}' (${newcomer}) conflicts with ${existing}`;
}

class Inferencer {
    u = new TypeUniverse();
    env = new Map<string, Scheme>();
    /**
     * The prelude schemes, cloned into every module's env (each module gets
     * its own copy so per-module imports/bindings never leak elsewhere).
     */
    preludeEnv = new Map<string, Scheme>();
    /**
     * Namespace aliases of the CURRENT module (`import "x.tetaue" as t`):
     * alias -> the target module's exported binding schemes. Qualified access
     * `t.binding` instantiates the exported scheme (row polymorphism is
     * preserved through a namespace). Reset per module.
     */
    modules = new Map<string, Map<string, Scheme>>();
    diagnostics: InferDiagnostic[] = [];
    /** Static type recorded for every expression / binding node (hover, completion). */
    nodeTypes = new Map<AstNode, Type>();

    private diag(node: AstNode | undefined, message: string): void {
        this.diagnostics.push({ node, message });
    }

    // -----------------------------------------------------------------------
    // Prelude
    // -----------------------------------------------------------------------

    /** Build a polymorphic scheme: named free variables, generalized. */
    private poly(vars: [string, VarKind][], build: (...types: Type[]) => Type): Scheme {
        const types: Type[] = [];
        for (const [name, kind] of vars) {
            types.push(this.u.fresh(kind === 'row' ? 'row' : 'flex', name));
        }
        return this.u.generalize([], build(...types));
    }

    private prelude(): void {
        const p = (n: PrimName) => prim(n);

        this.env.set('table', this.poly([['r', 'row']], r => fun(p('string'), queryOf(r))));        const filterScheme = this.poly([['r', 'row']], r => fun(fun(r, p('bool')), fun(queryOf(r), queryOf(r))));
        this.env.set('filter', filterScheme);
        this.env.set('filtered', filterScheme);
        const projectionScheme = this.poly([['r', 'row'], ['s', 'row']], (r, s) =>
            fun(fun(r, rowOf([], s)), fun(queryOf(r), queryOf(rowOf([], s)))));
        this.env.set('map', projectionScheme);
        this.env.set('fold', projectionScheme);
        this.env.set('sort', this.poly([['r', 'row'], ['t', 'type']], (r, t) =>
            fun(fun(r, t), fun(queryOf(r), queryOf(r)))));
        this.env.set('take', this.poly([['r', 'row']], r => fun(p('int'), fun(queryOf(r), queryOf(r)))));
        this.env.set('distinct', this.poly([['r', 'row']], r => fun(queryOf(r), queryOf(r))));
        // merge l r — the result row is the union of both rows (right wins on
        // overlap); inferMerge computes that union directly, this scheme only
        // types bare references and partial applications.
        this.env.set('merge', this.poly([['a', 'row'], ['b', 'row']], (a, b) => fun(a, fun(b, this.u.fresh('row')))));
        // join <kind> <right> <on> <merger> — kind is a string-typed constant
        // (inner/left/right/full), the merger projects the result row.
        this.env.set('join', this.poly([['r', 'row'], ['s', 'row'], ['t', 'row']], (r, s, t) => {
            const on = fun(r, fun(s, p('bool')));       // (l, r) => bool
            const merger = fun(r, fun(s, t));           // (l, r) => row t
            return fun(p('string'), fun(queryOf(s), fun(on, fun(merger, fun(queryOf(r), queryOf(t))))));
        }));
        this.env.set('inner', { vars: [], type: p('string') });
        this.env.set('left', { vars: [], type: p('string') });
        this.env.set('right', { vars: [], type: p('string') });
        this.env.set('full', { vars: [], type: p('string') });
        this.env.set('asc', this.poly([['t', 'type']], t => fun(nullable(t), { kind: 'order' })));
        this.env.set('desc', this.poly([['t', 'type']], t => fun(nullable(t), { kind: 'order' })));
        this.env.set('group', this.poly([['t', 'type']], t => fun(nullable(t), nullable(t))));
        this.env.set('count', this.poly([['t', 'type']], t => fun(nullable(t), p('int'))));
        this.env.set('sum', this.poly([['t', 'type']], t => fun(nullable(t), nullable(t))));
        this.env.set('avg', this.poly([['t', 'type']], t => fun(nullable(t), nullable(p('float')))));
        this.env.set('min', this.poly([['t', 'type']], t => fun(nullable(t), nullable(t))));
        this.env.set('max', this.poly([['t', 'type']], t => fun(nullable(t), nullable(t))));
        this.env.set('list', this.poly([['t', 'type']], t => fun(nullable(t), listOf(nullable(t)))));
        this.env.set('not', { vars: [], type: fun(p('bool'), p('bool')) });
        this.env.set('abs', this.poly([['t', 'type']], t => fun(nullable(t), nullable(t))));
        this.env.set('upper', { vars: [], type: fun(nullable(p('string')), nullable(p('string'))) });
        this.env.set('lower', { vars: [], type: fun(nullable(p('string')), nullable(p('string'))) });
        this.env.set('length', { vars: [], type: fun(nullable(p('string')), nullable(p('int'))) });
        this.env.set('is_in', this.poly([['t', 'type']], t => fun(nullable(t), fun(listOf(nullable(t)), p('bool')))));
        this.env.set('is_not_in', this.env.get('is_in')!);
        this.env.set('coalesce', this.poly([['t', 'type']], t => fun(nullable(t), fun(nullable(t), nullable(t)))));
        // Date & time — inference stays loose on the value argument (any
        // nullable type unifies); the interpreter owns the date/timestamp
        // runtime checks and unit/format literal validation.
        this.env.set('current_date', { vars: [], type: p('date') });
        this.env.set('current_timestamp', { vars: [], type: p('timestamp') });
        this.env.set('extract', this.poly([['t', 'type']], t => fun(nullable(t), fun(p('string'), p('int')))));
        for (const part of ['year', 'month', 'day', 'day_of_week', 'hour', 'minute', 'second'] as const) {
            this.env.set(part, this.poly([['t', 'type']], t => fun(nullable(t), p('int'))));
        }
        this.env.set('date_add', this.poly([['t', 'type']], t => fun(nullable(t), fun(p('string'), fun(p('int'), nullable(t))))));
        this.env.set('date_diff', this.poly([['t', 'type']], t => fun(nullable(t), fun(p('string'), fun(nullable(t), p('int'))))));
        this.env.set('date_trunc', this.poly([['t', 'type']], t => fun(nullable(t), fun(p('string'), p('timestamp')))));
        this.env.set('date_format', this.poly([['t', 'type']], t => fun(nullable(t), fun(p('string'), nullable(p('string'))))));
        this.env.set('date_parse', { vars: [], type: fun(nullable(p('string')), fun(p('string'), p('date'))) });
        this.env.set('to_unixtime', this.poly([['t', 'type']], t => fun(nullable(t), p('int'))));
        this.env.set('from_unixtime', this.poly([['t', 'type']], t => fun(nullable(p('int')), p('timestamp'))));
        // Scalar functions — math. add/sub/mul/div/mod are operators.
        for (const n of ['ceil', 'floor', 'sqrt'] as const) {
            this.env.set(n, this.poly([['t', 'type']], t => fun(nullable(t), nullable(t))));
        }
        this.env.set('pow', this.poly([['a', 'type'], ['b', 'type']], (a, b) => fun(nullable(a), fun(nullable(b), nullable(p('float'))))));
        this.env.set('mod', this.poly([['a', 'type'], ['b', 'type']], (a, b) => fun(nullable(a), fun(nullable(b), nullable(a)))));
        // Scalar functions — strings.
        this.env.set('trim', { vars: [], type: fun(nullable(p('string')), nullable(p('string'))) });
        this.env.set('position', { vars: [], type: fun(nullable(p('string')), fun(nullable(p('string')), p('int'))) });
        this.env.set('replace', { vars: [], type: fun(nullable(p('string')), fun(nullable(p('string')), fun(nullable(p('string')), nullable(p('string'))))) });
        this.env.set('left_substring', { vars: [], type: fun(nullable(p('string')), fun(nullable(p('int')), nullable(p('string')))) });
        this.env.set('right_substring', this.env.get('left_substring')!);
        this.env.set('regex_like', { vars: [], type: fun(nullable(p('string')), fun(nullable(p('string')), p('bool'))) });
        this.env.set('regex_replace', { vars: [], type: fun(nullable(p('string')), fun(nullable(p('string')), fun(nullable(p('string')), nullable(p('string'))))) });
        // Scalar functions — logical & null handling.
        this.env.set('like', this.env.get('regex_like')!);
        this.env.set('null_if', this.poly([['t', 'type']], t => fun(nullable(t), fun(nullable(t), nullable(t)))));
        this.env.set('is_null', this.poly([['t', 'type']], t => fun(nullable(t), p('bool'))));
        this.env.set('is_not_null', this.env.get('is_null')!);
        // Scalar functions — casts. The result type comes from the target
        // type literal, which unification cannot express — stay loose.
        this.env.set('cast', this.poly([['t', 'type']], t => fun(nullable(t), fun(p('string'), this.u.fresh()))));
        this.env.set('try_cast', this.env.get('cast')!);
        // Variadic builtins — the first-argument scheme is enough for bare
        // references; inferApplication intercepts them for the full checks.
        this.env.set('concat', { vars: [], type: fun(nullable(p('string')), fun(nullable(p('string')), nullable(p('string')))) });
        this.env.set('greatest', this.poly([['t', 'type']], t => fun(nullable(t), fun(nullable(t), nullable(t)))));
        this.env.set('least', this.env.get('greatest')!);
        this.env.set('round', this.poly([['t', 'type']], t => fun(nullable(t), nullable(t))));
        this.env.set('substring', { vars: [], type: fun(nullable(p('string')), fun(nullable(p('int')), nullable(p('string')))) });
        this.env.set('lpad', { vars: [], type: fun(nullable(p('string')), fun(nullable(p('int')), nullable(p('string')))) });
        this.env.set('rpad', this.env.get('lpad')!);
        this.env.set('regex_extract', { vars: [], type: fun(nullable(p('string')), fun(nullable(p('string')), nullable(p('string')))) });
        // Window functions. `over` returns its window function's type; the
        // window-only fns are int; lag/lead keep their value's type (the
        // interpreter owns the arg checks).
        this.env.set('over', this.poly([['a', 'type'], ['b', 'type']], (a, b) => fun(a, fun(b, a))));
        for (const n of ['row_number', 'rank', 'dense_rank', 'percent_rank'] as const) {
            this.env.set(n, { vars: [], type: p('int') });
        }
        this.env.set('ntile', { vars: [], type: fun(nullable(p('int')), p('int')) });
        this.env.set('lag', this.poly([['t', 'type']], t => fun(nullable(t), nullable(t))));
        this.env.set('lead', this.env.get('lag')!);
        // The prelude is cloned into every module's env (see inferProject).
        this.preludeEnv = new Map(this.env);
    }

    // -----------------------------------------------------------------------
    // Entry points
    // -----------------------------------------------------------------------

    /**
     * Infer every binding of every module (imports first, root last). Each
     * module is inferred in its OWN environment — a clone of the prelude,
     * then its own imports (flat exported schemes + namespace aliases), then
     * its own bindings — mirroring the interpreter's scoping exactly. Scope
     * collisions are reported with the interpreter's wording so the merged
     * diagnostics dedupe. Only `export`ed bindings are recorded for
     * importers, as schemes (so qualified access stays polymorphic).
     */
    inferProject(modules: ProjectModule[]): void {
        this.prelude();
        const exportsByModule = new Map<ProjectModule, Map<string, Scheme>>();
        for (const module of modules) {
            this.env = new Map(this.preludeEnv);
            this.modules = new Map<string, Map<string, Scheme>>();
            const scope = new Map<string, string>(); // name -> label (mirrors the interpreter)
            for (const { alias, target, importNode } of module.imports) {
                const targetSchemes = exportsByModule.get(target);
                if (!targetSchemes) continue; // cyclic/missing target — already diagnosed
                const spec = parseStringLiteral(importNode.path);
                // Selective name lists mirror the interpreter: only listed
                // exports are visible; unlisted names are not exported.
                let selected = targetSchemes;
                if (importNode.names && importNode.names.length > 0) {
                    for (const n of importNode.names) {
                        if (!targetSchemes.has(n)) {
                            const keys = [...targetSchemes.keys()];
                            this.diag(importNode, `'${n}' is not exported by '${spec}' — exported: ${keys.length > 0 ? keys.join(', ') : '(none)'}`);
                        }
                    }
                    selected = new Map(
                        importNode.names.filter(n => targetSchemes.has(n)).map(n => [n, targetSchemes.get(n)!]),
                    );
                }
                if (alias !== undefined) {
                    if (scope.has(alias)) {
                        this.diag(importNode, conflictMessage(alias, scope.get(alias)!, 'import alias'));
                        continue;
                    }
                    scope.set(alias, `import alias '${alias}'`);
                    this.modules.set(alias, selected);
                } else {
                    for (const [name, scheme] of selected) {
                        if (scope.has(name)) {
                            this.diag(importNode, conflictMessage(name, scope.get(name)!, `imported from '${spec}'`));
                            continue;
                        }
                        scope.set(name, `'${name}' imported from '${spec}'`);
                        this.env.set(name, scheme);
                    }
                }
            }
            const exported = new Map<string, Scheme>();
            for (const binding of module.model.bindings) {
                if (scope.has(binding.name)) {
                    this.diag(binding, conflictMessage(binding.name, scope.get(binding.name)!, 'a local binding'));
                    // The local binding wins at runtime (the interpreter's env
                    // override replaces the module value) — stop treating the
                    // name as a namespace, or the two passes would diverge on
                    // every downstream error. A no-op for flat-import
                    // collisions (the name is not in `modules`).
                    this.modules.delete(binding.name);
                }
                scope.set(binding.name, `local binding '${binding.name}'`);
                this.inferBinding(binding, exported);
            }
            exportsByModule.set(module, exported);
        }
    }

    private inferBinding(b: Binding, exported: Map<string, Scheme>): void {
        const t = this.inferExpr(b.value, this.env);
        this.nodeTypes.set(b, t);
        if (b.type) {
            const ann = this.translateType(b.type);
            // A bare `table "users"` has the fully polymorphic type `query r` —
            // its schema annotation DEFINES the row, so it constrains the free
            // variable instead of being checked against it. Every other
            // annotation is a signature: at least as general as the inferred
            // type (skolemized, so the annotation cannot narrow it).
            const v = b.value as Expr;
            const isBareTable = isApplication(v) && isIdentifier(v.func)
                && v.func.name === 'table' && v.arguments.length === 1;
            let ok = true;
            if (isBareTable) {
                try {
                    this.u.unify(ann, t);
                } catch (err) {
                    if (!(err instanceof UnifyError)) throw err;
                    ok = false;
                }
            } else {
                const sk = this.u.skolemize(t);
                try {
                    this.u.unify(ann, sk.type);
                } catch (err) {
                    if (!(err instanceof UnifyError)) throw err;
                    ok = false;
                } finally {
                    sk.restore();
                }
            }
            if (!ok) {
                this.diag(b, `annotation type ${this.u.pretty(ann)} does not match inferred type ${this.u.pretty(t)}`);
            }
        }
        const envTypes = [...this.env.values()].map(s => s.type);
        const scheme = this.u.generalize(envTypes, t);
        this.env.set(b.name, scheme);
        // Exported bindings are the module's public surface: importers see
        // their generalized schemes (polymorphism survives qualified access).
        if (b.export) exported.set(b.name, scheme);
    }

    // -----------------------------------------------------------------------
    // Expression inference
    // -----------------------------------------------------------------------

    /** Infer an expression and record its static type (hover, completion). */
    private inferExpr(e: UnaryExpression, env: Map<string, Scheme>): Type {
        const t = this.inferExprInner(e, env);
        this.nodeTypes.set(e, t);
        return t;
    }

    private inferExprInner(e: UnaryExpression, env: Map<string, Scheme>): Type {
        if (isAscription(e)) {
            const operand = this.inferExpr(e.operand!, env);
            const ann = this.translateType(e.type!);
            try {
                this.u.unify(operand, ann);
            } catch (err) {
                if (err instanceof UnifyError) {
                    this.diag(e, `annotation type ${this.u.pretty(ann)} does not match inferred type ${this.u.pretty(operand)}`);
                } else {
                    throw err;
                }
            }
            return operand;
        }
        if (isUnaryMinus(e)) {
            const t = this.inferExpr(e.operand, env);
            const r = this.u.resolve(t);
            if (r.kind === 'prim' && !isNumericPrim(r)) {
                this.diag(e, `unary '-' requires a numeric expression, got ${this.u.pretty(t)}`);
            }
            return t;
        }
        // LambdaBinaryExpression is the `&`/`$`-free chain used for lambda
        // bodies — structurally identical to BinaryExpression.
        if (isBinaryExpression(e) || isLambdaBinaryExpression(e)) return this.inferBinary(e as unknown as import('./generated/ast.js').BinaryExpression, env);
        if (isAccessExpression(e)) return this.inferAccess(e, env);
        if (isApplication(e)) return this.inferApplication(e, env);
        if (isNumberLiteral(e)) return prim(numberLiteralType(e));
        if (isStringLiteral(e)) return prim('string');
        if (isBooleanLiteral(e)) return prim('bool');
        if (isNullLiteral(e)) return nullable(this.u.fresh()); // ∀a. a?
        if (isCaseExpression(e)) return this.inferCase(e, env);
        if (isListLiteral(e)) {
            let item: Type | null = null;
            for (const el of e.elements) {
                const t = this.inferExpr(el, env);
                if (item === null) {
                    item = t;
                } else {
                    try { this.u.unify(item, t); } catch { /* heterogeneous lists are checked at is_in (§11) */ }
                }
            }
            return listOf(item ?? this.u.fresh());
        }
        if (isMapLiteral(e)) {
            const fields: [string, Type][] = [];
            for (const entry of e.entries) {
                fields.push([entry.key, this.inferExpr(entry.value, env)]);
            }
            return rowOf(fields);
        }
        if (isLambda(e)) return this.inferLambda(e, env);
        if (isIdentifier(e)) {
            const scheme = env.get(e.name);
            return scheme ? this.u.instantiate(scheme) : this.u.fresh(); // unknown ids are the interpreter's call
        }
        if (isDollarParam(e)) {
            const scheme = env.get(e.value);
            return scheme ? this.u.instantiate(scheme) : this.u.fresh();
        }
        return this.u.fresh();
    }

    /** An application argument: `$n` expressions become implicit lambdas. */
    private inferArg(e: Expr, env: Map<string, Scheme>): Type {
        const arity = this.dollarArity(e, env);
        if (arity > 0) {
            const newEnv = new Map(env);
            const types: Type[] = [];
            for (let i = 1; i <= arity; i++) {
                const t = this.u.fresh('flex');
                newEnv.set(`$${i}`, { vars: [], type: t });
                types.push(t);
            }
            const body = this.inferExpr(e, newEnv);
            return types.reduceRight((acc, t) => fun(t, acc), body);
        }
        return this.inferExpr(e, env);
    }

    private inferLambda(e: import('./generated/ast.js').Lambda, env: Map<string, Scheme>): Type {
        const p = e.param!;
        const newEnv = new Map(env);
        const rigidVars: number[] = [];
        let paramType: Type;
        if (p.type) {
            paramType = this.translateType(p.type, true, new Map(), rigidVars); // annotation vars are rigid inside the body
        } else {
            paramType = this.u.fresh('flex');
        }
        newEnv.set(p.name ?? '', { vars: [], type: paramType });
        const body = this.inferExpr(e.body as unknown as UnaryExpression, newEnv);
        // Release the rigidity of annotated params: the body must only use the
        // annotated fields, but at USE the row must still absorb extra fields.
        for (const id of rigidVars) this.u.varInfo(id).rigid = false;
        return fun(paramType, body);
    }

    /**
     * Is `e` a qualified module access `t.binding` where `t` is a namespace
     * alias of the current module? The receiver parses as an Application of a
     * bare identifier with no arguments (`t` alone), so unwrap it before the
     * generic receiver inference runs.
     */
    private moduleQualified(e: import('./generated/ast.js').AccessExpression): { module: string; binding: string } | null {
        const recv = e.receiver;
        if (isApplication(recv) && recv.arguments.length === 0 && isIdentifier(recv.func)) {
            const name = recv.func.name;
            if (this.modules.has(name)) return { module: name, binding: e.property };
        }
        return null;
    }

    private inferAccess(e: import('./generated/ast.js').AccessExpression, env: Map<string, Scheme>): Type {
        const mq = this.moduleQualified(e);
        if (mq) {
            // `t.binding`: instantiate the exported binding's scheme, exactly
            // like an identifier reference — a row-polymorphic helper stays
            // polymorphic through the namespace.
            const exported = this.modules.get(mq.module)!;
            const scheme = exported.get(mq.binding);
            if (scheme) return this.u.instantiate(scheme);
            const keys = [...exported.keys()];
            this.diag(e, `module '${mq.module}' has no exported binding '${mq.binding}' — exported: ${keys.length > 0 ? keys.join(', ') : '(none)'}`);
            return this.u.fresh();
        }
        const recv = this.inferExpr(e.receiver, env);
        const r = this.u.resolve(recv);
        if (r.kind === 'query') {
            this.diag(e, `tables have no fields — access columns through a row parameter inside a lambda, e.g. map (u => u.${e.property})`);
            return this.u.fresh();
        }
        let field;
        try {
            field = this.u.fieldOf(recv, e.property);
        } catch (err) {
            if (!(err instanceof UnifyError)) throw err;
            field = null; // e.g. extending a rigid (annotated) row tail
        }
        if (!field) {
            const labels = r.kind === 'row' ? this.u.rowLabels(r) : [];
            this.diag(e, `unknown column '${e.property}'${labels.length > 0 ? ` — available: ${labels.join(', ')}` : ''}`);
            return this.u.fresh();
        }
        return field.type;
    }

    private inferBinary(e: import('./generated/ast.js').BinaryExpression, env: Map<string, Scheme>): Type {
        const op = e.operator;
        if (op === '&') {
            // a & f ⇔ f a  — application; most errors are the interpreter's call,
            // but int/float mixing is silent there (comparable/isNumeric allow it).
            const a = this.inferExpr(e.left, env);
            const f = this.inferExpr(e.right, env);
            const a1 = this.u.fresh();
            const b1 = this.u.fresh();
            try {
                this.u.unify(f, fun(a1, b1));
                this.u.unify(a, a1);
                return b1;
            } catch (err) {
                if (err instanceof UnifyError) this.reportNumericMix(e, err);
                return this.u.fresh();
            }
        }
        if (op === '$') {
            const f = this.inferExpr(e.left, env);
            const a = this.inferExpr(e.right, env);
            const a1 = this.u.fresh();
            const b1 = this.u.fresh();
            try {
                this.u.unify(f, fun(a1, b1));
                this.u.unify(a, a1);
                return b1;
            } catch (err) {
                if (err instanceof UnifyError) this.reportNumericMix(e, err);
                return this.u.fresh();
            }
        }
        if (op === '>>>' || op === '<<<') {
            const l = this.inferExpr(e.left, env);
            const r = this.inferExpr(e.right, env);
            const a = this.u.fresh();
            const b = this.u.fresh();
            const c = this.u.fresh();
            try {
                if (op === '<<<') { // (b -> c) -> (a -> b) -> a -> c
                    this.u.unify(l, fun(b, c));
                    this.u.unify(r, fun(a, b));
                } else { // (a -> b) -> (b -> c) -> a -> c
                    this.u.unify(l, fun(a, b));
                    this.u.unify(r, fun(b, c));
                }
                return c;
            } catch (err) {
                if (err instanceof UnifyError) this.reportNumericMix(e, err);
                return this.u.fresh();
            }
        }
        const lt = this.inferExpr(e.left, env);
        const rt = this.inferExpr(e.right, env);
        if (op === '==' || op === '!=' || op === '<' || op === '<=' || op === '>' || op === '>=') {
            try {
                this.u.unify(nullable(lt), nullable(rt));
            } catch (err) {
                if (err instanceof UnifyError) {
                    this.diag(e, `cannot compare ${this.u.pretty(lt)} with ${this.u.pretty(rt)}`);
                } else {
                    throw err;
                }
            }
            return prim('bool');
        }
        if (op === '&&' || op === '||') {
            try {
                this.u.unify(lt, prim('bool'));
                this.u.unify(rt, prim('bool'));
            } catch (err) {
                if (err instanceof UnifyError) {
                    this.diag(e, `'${op}' requires boolean operands, got ${this.u.pretty(lt)} and ${this.u.pretty(rt)}`);
                } else {
                    throw err;
                }
            }
            return prim('bool');
        }
        // `<>` — the record-merge monoid (right record wins on overlap);
        // same typing as the `merge` builtin.
        if (op === '<>') {
            return this.inferMerge(lt, rt, e);
        }
        // + - * / %
        try {
            const unified = this.u.unify(lt, rt);
            const rl = this.u.resolve(lt);
            const rr = this.u.resolve(rt);
            if (rl.kind === 'prim' && rr.kind === 'prim' && isNumericPrim(rl) && isNumericPrim(rr) && rl.name !== rr.name) {
                this.diag(e, `'${op}' requires numeric operands of the same type, got ${this.u.pretty(lt)} and ${this.u.pretty(rt)}`);
            } else if (rl.kind === 'prim' && rr.kind === 'prim' && !isNumericPrim(rl) && !isNumericPrim(rr)) {
                this.diag(e, `'${op}' requires numeric operands, got ${this.u.pretty(lt)} and ${this.u.pretty(rt)}`);
            }
            return unified;
        } catch (err) {
            if (err instanceof UnifyError) {
                const rl = this.u.resolve(lt);
                const rr = this.u.resolve(rt);
                if (rl.kind === 'prim' && rr.kind === 'prim' && isNumericPrim(rl) && isNumericPrim(rr)) {
                    this.diag(e, `'${op}' requires numeric operands of the same type, got ${this.u.pretty(lt)} and ${this.u.pretty(rt)}`);
                } else {
                    this.diag(e, `'${op}' requires numeric operands, got ${this.u.pretty(lt)} and ${this.u.pretty(rt)}`);
                }
            } else {
                throw err;
            }
            return this.u.fresh();
        }
    }

    // -----------------------------------------------------------------------
    // Application
    // -----------------------------------------------------------------------

    private inferApplication(e: import('./generated/ast.js').Application, env: Map<string, Scheme>): Type {
        const funcName = isIdentifier(e.func) ? e.func.name : null;
        // Variadic builtins (concat, greatest, least, round, substring,
        // lpad/rpad, regex_extract) take all arguments at once. A bare
        // identifier parses as a 0-argument Application — the function value,
        // handled by the generic path below.
        if (funcName && VARIADIC_BUILTINS.has(funcName) && e.arguments.length > 0) {
            const argTypes = e.arguments.map(a => this.inferArg(a, env));
            return this.inferVariadic(funcName, e.arguments, argTypes, e);
        }
        // `merge l r` — the result row is the union of both rows (the right
        // record wins on overlapping fields), which the generic fun-type
        // application path cannot express; compute the union directly.
        if (funcName === 'merge' && e.arguments.length === 2) {
            const a = this.inferArg(e.arguments[0]!, env);
            const b = this.inferArg(e.arguments[1]!, env);
            return this.inferMerge(a, b, e);
        }
        let f = this.inferExpr(e.func, env);
        const argTypes: Type[] = [];
        for (let i = 0; i < e.arguments.length; i++) {
            const argExpr = e.arguments[i]!;
            const argType = this.inferArg(argExpr, env);
            argTypes.push(argType);
            const param = this.u.fresh();
            const result = this.u.fresh();
            let failed = false;
            try {
                this.u.unify(f, fun(param, result));
            } catch (err) {
                if (err instanceof UnifyError) {
                    this.argError(funcName, i, argExpr, argType, param, f);
                    return this.u.fresh();
                }
                throw err;
            }
            try {
                this.u.unify(param, argType);
            } catch (err) {
                if (err instanceof UnifyError) {
                    this.argError(funcName, i, argExpr, argType, param, f);
                    failed = true;
                } else {
                    throw err;
                }
            }
            if (funcName && !failed) this.postCheckArg(funcName, i, argExpr, argType, e);
            f = result;
        }
        if (funcName === 'is_in' || funcName === 'is_not_in') {
            this.checkInList(e, env, argTypes);
        }
        return f;
    }

    /**
     * Variadic builtins: check every argument against the function's expected
     * kind and return the result type. Loose where the interpreter owns the
     * runtime checks (unit/format literals, exact comparability).
     */
    private inferVariadic(name: string, args: Expr[], argTypes: Type[], node: AstNode): Type {
        if (args.length === 0) return this.u.fresh();
        const expect = (index: number, kind: 'string' | 'int' | 'numeric'): void => {
            if (kind === 'numeric') {
                const r = this.u.resolve(argTypes[index]!);
                if (r.kind === 'prim' && !isNumericPrim(r)) {
                    this.diag(args[index]!, `${name} expects a numeric expression, got type ${this.u.pretty(argTypes[index]!)}`);
                }
                return;
            }
            try {
                this.u.unify(nullable(kind === 'string' ? prim('string') : prim('int')), argTypes[index]!);
            } catch (err) {
                if (err instanceof UnifyError) {
                    this.diag(args[index]!, `${name} expects ${kind === 'string' ? 'a string expression' : 'an integer'}, got type ${this.u.pretty(argTypes[index]!)}`);
                } else {
                    throw err;
                }
            }
        };
        switch (name) {
            case 'concat':
                args.forEach((_, i) => expect(i, 'string'));
                return nullable(prim('string'));
            case 'greatest': case 'least': {
                const base = argTypes[0]!;
                for (let i = 1; i < args.length; i++) {
                    try {
                        this.u.unify(nullable(base), argTypes[i]!);
                    } catch (err) {
                        if (err instanceof UnifyError) {
                            this.diag(args[i]!, `${name} requires matching types, got ${this.u.pretty(base)} and ${this.u.pretty(argTypes[i]!)}`);
                        } else {
                            throw err;
                        }
                    }
                }
                return base;
            }
            case 'round':
                expect(0, 'numeric');
                if (args.length === 2) expect(1, 'int');
                return argTypes[0]!;
            case 'substring':
                expect(0, 'string');
                expect(1, 'int');
                if (args.length === 3) expect(2, 'int');
                return nullable(prim('string'));
            case 'lpad': case 'rpad':
                expect(0, 'string');
                expect(1, 'int');
                if (args.length === 3) expect(2, 'string');
                return nullable(prim('string'));
            case 'regex_extract':
                expect(0, 'string');
                expect(1, 'string');
                if (args.length === 3) expect(2, 'int');
                return nullable(prim('string'));
            case 'lag': case 'lead':
                // value of any type; optional int offset; optional default
                if (args.length >= 2) expect(1, 'int');
                return argTypes[0]!;
        }
        return this.u.fresh();
    }

    /**
     * `case { cond => value, ..., _ => value }` — SQL CASE WHEN. Conditions
     * must be boolean; all branch values (and the `_` fallback) unify to one
     * type. The result is nullable because a CASE without an ELSE branch
     * yields NULL. Loose where the interpreter owns the runtime checks (column
     * types inside a lambda body resolve only after the body is inferred).
     */
    private inferCase(e: CaseExpression, env: Map<string, Scheme>): Type {
        if (e.branches.length === 0) return this.u.fresh(); // the interpreter reports this
        let base: Type | null = null;
        // Simple case: `case subject { c1 => v1, ..., _ => v }` is sugar for
        // `subject == c1` conditions — every branch condition unifies with the
        // subject's type instead of being required to be boolean.
        const subjectT = e.subject ? this.inferExpr(e.subject, env) : null;
        for (const b of e.branches) {
            if (!b.fallback) {
                const condT = this.inferExpr(b.cond!, env);
                try {
                    if (subjectT) {
                        this.u.unify(subjectT, condT);
                    } else {
                        this.u.unify(prim('bool'), condT);
                    }
                } catch (err) {
                    if (err instanceof UnifyError) {
                        this.diag(b.cond, subjectT
                            ? `case branch does not match the subject type ${this.u.pretty(subjectT)}: got ${this.u.pretty(condT)}`
                            : `case condition must be a boolean expression, got type ${this.u.pretty(condT)}`);
                    } else {
                        throw err;
                    }
                }
            }
            const valueT = this.inferExpr(b.value!, env);
            if (base === null) {
                base = valueT;
            } else {
                try {
                    this.u.unify(nullable(base), valueT);
                } catch (err) {
                    if (err instanceof UnifyError) {
                        this.diag(b.value, `case requires matching value types, got ${this.u.pretty(base)} and ${this.u.pretty(valueT)}`);
                    } else {
                        throw err;
                    }
                }
            }
        }
        return nullable(base ?? this.u.fresh());
    }

    /**
     * A row or an unconstrained variable (an open row with nothing known
     * yet). Closed non-row types return null — `merge` requires records on
     * both sides.
     */
    private mergeRowShape(t: Type, at: AstNode, which: 'first' | 'second'): { fields: Map<string, Type>; tail: Type | null; varId: number | null } | null {
        const r = this.u.resolve(t);
        if (r.kind === 'row') {
            const resolved = this.u.resolveRow(r);
            return { fields: new Map(resolved.fields), tail: resolved.tail, varId: null };
        }
        if (r.kind === 'var') {
            const info = this.u.varInfo(r.id);
            if (info.kind === 'type' || info.rigid) {
                this.diag(at, `merge expects a record as its ${which} argument, got type ${this.u.pretty(t)}`);
                return null;
            }
            return { fields: new Map(), tail: null, varId: r.id };
        }
        this.diag(at, `merge expects a record as its ${which} argument, got type ${this.u.pretty(t)}`);
        return null;
    }

    /**
     * `merge l r : row` — the right record wins on overlapping fields (JS/Nix
     * object-spread semantics). The result row is r's row with l's
     * non-overlapping fields absorbed.
     *
     * The result tail is fed by at most ONE independent row source: linking
     * two rows into a single tail would leak fields from one side into the
     * other's unification (e.g. a merger `(u, v) => merge u v` inside a join,
     * where the `on` lambda materializes a left field that then cannot be
     * absorbed into the closed right row). Priority: the right side's own
     * open tail; an unconstrained right row becomes the result's open part;
     * only when the right is a closed record does the left side's future
     * fields feed the tail (the common `merge u { ... }` case).
     */
    private inferMerge(a: Type, b: Type, at: AstNode): Type {
        const aShape = this.mergeRowShape(a, at, 'first');
        const bShape = this.mergeRowShape(b, at, 'second');
        if (!aShape || !bShape) return this.u.fresh();

        // The result starts as the right record's row (right wins on
        // overlapping fields) plus the left's non-overlapping fields.
        const resFields = new Map(bShape.fields);
        for (const [label, type] of aShape.fields) {
            if (!resFields.has(label)) resFields.set(label, type);
        }

        let resTail: Type;
        if (bShape.varId !== null) {
            // Unconstrained right row: it IS the result's open part.
            resTail = this.u.fresh('row');
            try { this.u.bind(bShape.varId, { kind: 'row', fields: new Map(), tail: resTail }); } catch { /* leave open */ }
        } else if (bShape.tail) {
            // Right side's open tail flows into the result unchanged.
            resTail = bShape.tail;
        } else if (aShape.varId !== null) {
            // Closed right record: an unconstrained left row becomes the
            // result's open part (fields materialized later still appear).
            resTail = this.u.fresh('row');
            try { this.u.bind(aShape.varId, { kind: 'row', fields: new Map(), tail: resTail }); } catch { /* leave open */ }
        } else if (aShape.tail) {
            // Closed right record: the left's open tail flows into the result.
            resTail = this.u.fresh('row');
            const t = this.u.resolve(aShape.tail);
            if (t.kind === 'var' && !this.u.varInfo(t.id).rigid) {
                try { this.u.bind(t.id, resTail); } catch { /* kind conflict: leave open */ }
            }
        } else {
            // Both closed: keep a tail open so the result stays mergeable.
            resTail = this.u.fresh('row');
        }
        return { kind: 'row', fields: resFields, tail: resTail };
    }

    /** int/float mixing is invisible to the interpreter (comparable/isNumeric allow it) — inference must report it. */
    private reportNumericMix(node: AstNode, err: UnifyError): void {
        const a = this.resolveBase(err.a);
        const b = this.resolveBase(err.b);
        if (a.kind === 'prim' && b.kind === 'prim' && isNumericPrim(a) && isNumericPrim(b) && a.name !== b.name) {
            this.diag(node, `cannot mix int and float (${a.name} vs ${b.name}) — write a literal of the matching type, e.g. ${a.name === 'int' ? '18' : '18.0'}`);
        }
    }

    /** Resolve through variable bindings and `?` wrappers to the base type. */
    private resolveBase(t: Type): Type {
        let r = this.u.resolve(t);
        while (r.kind === 'nullable') r = this.u.resolve(r.of);
        return r;
    }

    /** Builtin-specific argument diagnostics, aligned with the interpreter. */
    private argError(name: string | null, index: number, node: AstNode, argType: Type, param: Type | undefined, fType: Type | undefined): void {
        const p = (t: Type) => this.u.pretty(t);
        const ret = (t: Type): Type | null => {
            const r = this.u.resolve(t);
            return r.kind === 'fun' ? r.to : null;
        };
        switch (name) {
            case 'filter': case 'filtered': {
                const r = ret(argType);
                if (r) this.diag(node, `${name} predicate must be a boolean expression, got type ${p(r)}`);
                else this.diag(node, `${name} expects a one-parameter predicate lambda or function, e.g. ${name} (u => u.age >= 18)`);
                break;
            }
            case 'map': {
                const r = ret(argType);
                if (r) this.diag(node, `projection must be a record like { key = expr, ... }, got an expression of type ${p(r)}`);
                else this.diag(node, `map expects a one-parameter projection lambda or function, e.g. map (u => { id = u.id })`);
                break;
            }
            case 'fold': {
                const r = ret(argType);
                if (r) this.diag(node, `fold expects a projection record, got an expression of type ${p(r)}`);
                else this.diag(node, `fold expects a one-parameter lambda, e.g. fold (o => { user_id = group o.user_id, total = sum o.total })`);
                break;
            }
            case 'sort': {
                const r = ret(argType);
                if (r) this.diag(node, `sort expects order items like asc u.name or a list of them, got an expression of type ${p(r)}`);
                else this.diag(node, `sort expects a one-parameter lambda or function, e.g. sort (u => [asc u.name])`);
                break;
            }
            case 'join':
                if (index === 0) this.diag(node, `join expects a join kind as its first argument: inner, left, right or full (a bare identifier), got an expression of type ${p(argType)}`);
                else if (index === 1) this.diag(node, `join expects a query as its second argument, got an expression of type ${p(argType)} — bind a table or pipeline first, e.g. join inner orders (l => r => ...)`);
                else if (index === 2) this.diag(node, `join 'on' must be a two-argument function (curried), e.g. (l => r => l.id == r.user_id) or ($1.id == $2.user_id), got an expression of type ${p(argType)}`);
                else if (index === 3) this.diag(node, `join 'merger' must be a two-argument function (curried), e.g. (l => r => merge l r) or merge, got an expression of type ${p(argType)}`);
                else this.diag(node, `join takes exactly four arguments: a join kind, the right query, the 'on' function, and the merger function`);
                break;
            case 'take':
                this.diag(node, `take expects a non-negative integer literal`);
                break;
            case 'table':
                if (index === 0) this.diag(node, `table expects a table name string, e.g. table "users"`);
                else this.diag(node, `table takes a single argument (the table name), e.g. table "users"`);
                break;
            case 'upper': case 'lower': case 'length':
                this.diag(node, `${name} expects a string expression, got type ${p(argType)}`);
                break;
            case 'not':
                this.diag(node, `not expects a boolean expression, got type ${p(argType)}`);
                break;
            case 'abs': case 'sum': case 'avg':
                this.diag(node, `${name} expects a numeric expression, got type ${p(argType)}`);
                break;
            case 'coalesce':
                this.diag(node, `coalesce requires matching types, got ${p(param ?? argType)} and ${p(argType)}`);
                break;
            default:
                this.diag(node, `cannot apply an expression of type ${p(fType ?? argType)}`);
        }
    }

    /** Post-unification checks the scheme types don't capture (numeric, order, literals). */
    private postCheckArg(name: string, index: number, argExpr: Expr, argType: Type, node: AstNode): void {
        const r = this.u.resolve(argType);
        if ((name === 'sum' || name === 'avg' || name === 'abs'
            || name === 'ceil' || name === 'floor' || name === 'sqrt') && index === 0) {
            if (r.kind === 'prim' && !isNumericPrim(r)) {
                this.diag(node, `${name} expects a numeric expression, got type ${this.u.pretty(argType)}`);
            }
            return;
        }
        if ((name === 'pow' || name === 'mod') && (index === 0 || index === 1)) {
            if (r.kind === 'prim' && !isNumericPrim(r)) {
                this.diag(node, `${name} expects a numeric expression, got type ${this.u.pretty(argType)}`);
            }
            return;
        }
        if (name === 'take' && index === 0) {
            const okLiteral = isNumberLiteral(argExpr) && Number.isInteger(argExpr.value) && argExpr.value >= 0;
            if (!okLiteral) this.diag(node, `take expects a non-negative integer literal`);
            return;
        }
        if (name === 'sort' && index === 0) {
            const rt = this.u.resolve(argType);
            if (rt.kind === 'fun') {
                const ret = this.u.resolve(rt.to);
                if (ret.kind !== 'var') {
                    const isOrder = ret.kind === 'order' || (ret.kind === 'list' && this.u.resolve(ret.of).kind === 'order');
                    if (!isOrder) this.diag(node, `sort expects order items like asc u.name or a list of them, got an expression of type ${this.u.pretty(ret)}`);
                }
            }
        }
    }

    /** is_in's second argument must be a list of the first argument's type. */
    private checkInList(e: import('./generated/ast.js').Application, env: Map<string, Scheme>, argTypes: Type[]): void {
        if (e.arguments.length < 2) return;
        const first = argTypes[0];
        const listExpr = e.arguments[1]!;
        if (!first || !isListLiteral(listExpr)) return;
        for (const item of listExpr.elements.slice(1)) {
            const itemType = this.inferExpr(item, env);
            try {
                this.u.unify(first, itemType);
            } catch (err) {
                if (err instanceof UnifyError) {
                    this.diag(item, `is_in list items must match type ${this.u.pretty(first)}, got ${this.u.pretty(itemType)}`);
                } else {
                    throw err;
                }
            }
        }
    }

    // -----------------------------------------------------------------------
    // Type annotations (Langium Type AST → internal Type)
    // -----------------------------------------------------------------------

    private translateType(t: LangiumType, rigid: boolean = false, names: Map<string, Type> = new Map(), rigidVars: number[] = []): Type {
        if (isTypeParen(t)) return this.translateType(t.type, rigid, names, rigidVars);
        if (isNullType(t)) {
            const base = this.translateType(t.base, rigid, names, rigidVars);
            return t.nullable ? nullable(base) : base;
        }
        if (isFunType(t)) return fun(this.translateType(t.left, rigid, names, rigidVars), this.translateType(t.right, rigid, names, rigidVars));
        if (isListType(t)) return listOf(this.translateType(t.type, rigid, names, rigidVars));
        if (isRecordType(t)) {
            const fields: [string, Type][] = t.fields.map(f => [f.key, this.translateType(f.type, rigid, names, rigidVars)]);
            const tail = t.tail ? this.typeOrRowVar(t.tail, 'row', rigid, names, rigidVars) : null;
            return rowOf(fields, tail);
        }
        if (isQueryType(t)) {
            const fields: [string, Type][] = t.fields.map(f => [f.key, this.translateType(f.type, rigid, names, rigidVars)]);
            const tail = t.tail ? this.typeOrRowVar(t.tail, 'row', rigid, names, rigidVars) : null;
            return queryOf(rowOf(fields, tail));
        }
        if (isTypeVar(t)) {
            const name = t.name;
            if (isPrimName(name)) return prim(name);
            if (!/^[a-z]/.test(name)) {
                this.diag(t, `unknown type '${name}'`);
                return this.u.fresh();
            }
            return this.typeOrRowVar(name, 'type', rigid, names, rigidVars);
        }
        return this.u.fresh();
    }

    /** A lowercase type name is a variable; the same name reuses the same var within one annotation. */
    private typeOrRowVar(name: string, kind: VarKind, rigid: boolean, names: Map<string, Type>, rigidVars: number[]): Type {
        const existing = names.get(name);
        if (existing) return existing;
        const fresh = this.u.fresh(kind === 'row' ? 'row' : 'flex', name);
        if (fresh.kind === 'var' && rigid) {
            this.u.varInfo(fresh.id).rigid = true;
            rigidVars.push(fresh.id);
        }
        names.set(name, fresh);
        return fresh;
    }

    /** Rendered, resolved type text of a recorded node (friendly var names for hover). */
    typeOf(node: AstNode): string | undefined {
        const t = this.nodeTypes.get(node);
        return t ? this.u.pretty(this.u.resolve(t), true, true) : undefined;
    }

    /** Row fields (sorted) of a recorded node's type, unwrapping `?` wrappers. */
    fieldsOf(node: AstNode): { name: string; type: string }[] | undefined {
        const t = this.nodeTypes.get(node);
        if (!t) return undefined;
        let r = this.u.resolve(t);
        while (r.kind === 'nullable') r = this.u.resolve(r.of);
        if (r.kind !== 'row') return undefined;
        return this.u.rowLabels(r).map(name => {
            const field = this.u.fieldOf(r, name);
            return { name, type: field ? this.u.pretty(this.u.resolve(field.type), true, true) : '?' };
        });
    }

    // -----------------------------------------------------------------------
    // $n implicit lambda parameters (mirrors the interpreter's dollarArity)
    // -----------------------------------------------------------------------

    private dollarArity(node: AstNode, env: Map<string, Scheme>): number {
        let arity = 0;
        // Walk the AST subtree; `$n` nodes not bound in `env` and not hidden
        // inside an explicit lambda body contribute their index.
        const stack: AstNode[] = [node];
        while (stack.length > 0) {
            const cur = stack.pop()!;
            if (isDollarParam(cur)) {
                if (!env.has(cur.value)) {
                    let hidden = false;
                    let node2: AstNode | undefined = cur;
                    while (node2) {
                        const parent: AstNode | undefined = node2.$container;
                        if (!parent) break;
                        if (isLambda(parent) && parent.body === node2) { hidden = true; break; }
                        node2 = parent;
                    }
                    if (!hidden) arity = Math.max(arity, Number(cur.value.slice(1)));
                }
                continue;
            }
            for (const key of Object.keys(cur)) {
                if (key.startsWith('$')) continue;
                const value = (cur as unknown as Record<string, unknown>)[key];
                if (Array.isArray(value)) {
                    for (const v of value) if (v && typeof v === 'object' && '$type' in (v as object)) stack.push(v as AstNode);
                } else if (value && typeof value === 'object' && '$type' in (value as object)) {
                    stack.push(value as AstNode);
                }
            }
        }
        return arity;
    }
}

/** Infer a project: modules in import order (imports first, root last). */
export function inferProject(modules: ProjectModule[]): InferProjectResult {
    const inferencer = new Inferencer();
    inferencer.inferProject(modules);
    return {
        diagnostics: inferencer.diagnostics,
        nodeTypes: inferencer.nodeTypes,
        typeOf: node => inferencer.typeOf(node),
        fieldsOf: node => inferencer.fieldsOf(node),
    };
}

/** Infer a single module (no imports). */
export function infer(model: Model): { diagnostics: InferDiagnostic[] } {
    return inferProject([{ model, uri: undefined, imports: [] }]);
}

/**
 * Merge diagnostic lists from the inference pass and the interpreter,
 * dropping exact (node, message) duplicates so each type error is reported
 * once (first occurrence wins). Both passes share the Diagnostic shape. The
 * key includes the owning module's URI, so identical errors at the same
 * offset in DIFFERENT modules are not collapsed into one (this matters in
 * the CLI/LSP render path, where parsed nodes carry no `$document`).
 */
export function mergeDiagnostics<T extends { node: AstNode | undefined; message: string }>(
    modules: ProjectModule[],
    ...lists: T[][]
): T[] {
    const seen = new Set<string>();
    const out: T[] = [];
    for (const list of lists) {
        for (const d of list) {
            const moduleUri = d.node ? (moduleOf(d.node, modules)?.uri ?? '') : '';
            const nodeKey = d.node
                ? (d.node.$cstNode
                    ? `${moduleUri}@${d.node.$cstNode.offset}`
                    : `${moduleUri}:${d.node.$type}`)
                : '';
            const key = `${nodeKey}\u0000${d.message}`;
            if (seen.has(key)) continue;
            seen.add(key);
            out.push(d);
        }
    }
    return out;
}
