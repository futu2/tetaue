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
 * (`u => u.age >= 18` : `forall r. { age: int | r } -> bool`) and
 * instantiated at each use. Nullability is explicit Haskell-style
 * `(maybe T)` — there is NO implicit T -> maybe T conversion. Holes
 * (`?name`) are unsolved metavariables shared through the module, never
 * generalized. Numerics are strict. See docs/design/type-system.md.
 ******************************************************************************/
import type { AstNode } from 'langium';
import {
    isAccessExpression, isAscription, isApplication, isBinaryExpression,
    isBooleanLiteral, isCaseExpression, isDollarParam, isFunType, isIdentifier, isLambda,
    isLambdaBinaryExpression, isLambdaLetExpression, isLetExpression, isListLiteral, isListType,
    isMapLiteral, isNullLiteral,
    isNumberLiteral, isQualifiedTypeName, isQueryType, isRecordType, isStringLiteral, isTypeAtom, isTypeHole, isTypeParen,
    isTypeVar, isUnaryMinus,
    type Binding, type CaseExpression, type Expr, type Lambda, type MapEntry, type Model,
} from './generated/ast.js';
import type { Type as LangiumType } from './generated/ast.js';
import {
    TypeUniverse, UnifyError, type Scheme, type Type, type VarKind,
    builtinOf, fun, listOf, maybeOf, prim, queryOf, rowOf,
} from './types.js';
import type { NumberLiteral, UnaryExpression } from './generated/ast.js';
import type { ProjectModule, ResolvedImportEdge } from './imports.js';
import { moduleOf } from './imports.js';
import { resolveImportScope, resolveTypeImportScope } from './project-scope.js';
import { checkBinding, parseStringLiteral } from './interpreter.js';
import type { Diagnostic, Value } from './interpreter.js';
import { labelName } from './strings.js';
import { BUILTIN_ALIASES, BUILTIN_SPECS } from './catalog.js';
import { CAST_TYPES, LIST_ARITY } from './builtin.js';

export interface InferDiagnostic {
    node: AstNode | undefined;
    message: string;
}

/** Builtins whose application takes ALL arguments at once (no currying). */
const LIST_BUILTINS = new Set(['concat', 'greatest', 'least', 'round', 'substring', 'lpad', 'rpad', 'regex_extract', 'lag', 'lead']);

/** Date/time builtins whose value arguments must be date or timestamp. */
const DATE_VALUE_ARGUMENTS = new Set(['extract', 'year', 'month', 'day', 'day_of_week', 'hour', 'minute', 'second', 'date_add', 'date_diff', 'date_trunc', 'date_format', 'to_unixtime']);

type CastType = (typeof CAST_TYPES)[number];

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

const PRIM_NAMES = ['int', 'float', 'decimal', 'string', 'bool', 'date', 'timestamp'] as const;
type PrimName = (typeof PRIM_NAMES)[number];

/** Synthetic access inserted by completion; it must not constrain the receiver row. */
const SYNTHETIC_FIELD_PREFIX = '_tetaue_field';

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

export class Inferencer {
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
    /** Module-local type aliases (name -> type AST), reset per module. */
    private typeAliases = new Map<string, LangiumType>();
    /** Namespace aliases for qualified type names (`t.UserRow`). */
    private typeNamespaces = new Map<string, Map<string, LangiumType>>();
    /** Alias names currently being expanded (cycle detection). */
    private activeTypeAliases = new Set<string>();
    diagnostics: InferDiagnostic[] = [];

    /** Pull and clear every pending inference diagnostic. */
    takeDiagnostics(): InferDiagnostic[] {
        const out = this.diagnostics;
        this.diagnostics = [];
        return out;
    }

    /** Pull diagnostics emitted after (and including) `start`. */
    takeDiagnosticsFrom(start: number): InferDiagnostic[] {
        const out = this.diagnostics.slice(start);
        this.diagnostics.length = start;
        return out;
    }
    /**
     * Checks that must run after the whole project has been unified (for
     * example list-element compatibility when the element type is still a
     * row-field variable at the point the list is inferred).
     */
    private deferred: { node: AstNode | undefined; a: Type; b: Type; message: string }[] = [];
    /** Static type recorded for every expression / binding node (hover, completion). */
    nodeTypes = new Map<AstNode, Type>();
    /**
     * Named query parameters share ONE type across the whole project:
     * `param "x"` used as an int in one place and a string elsewhere is a
     * static error, because the renderer deduplicates by name into a single
     * SQL bind placeholder.
     */
    private paramTypes = new Map<string, Type>();

    private diag(node: AstNode | undefined, message: string): void {
        this.diagnostics.push({ node, message });
    }

    private defer(node: AstNode | undefined, a: Type, b: Type, message: string): void {
        this.deferred.push({ node, a, b, message });
    }

    /** Resolve deferred checks once unification has bound all row variables. */
    flushDeferred(): void {
        const strip = (t: Type): Type => {
            let r = this.u.peel(t);
            while (r.kind === 'maybe') r = this.u.peel(r.of);
            return r;
        };
        const nameOf = (t: Type): string => {
            const r = strip(t);
            return r.kind === 'prim' ? r.name : this.u.pretty(t, true);
        };
        for (const check of this.deferred) {
            const a = strip(check.a);
            const b = strip(check.b);
            const compatible = a.kind === 'prim' && b.kind === 'prim'
                && ((isNumericPrim(a) && isNumericPrim(b)) || a.name === b.name);
            if (a.kind === 'prim' && b.kind === 'prim' && !compatible) {
                this.diag(check.node, `${check.message}, got ${nameOf(check.a)} and ${nameOf(check.b)}`);
            }
        }
        this.deferred = [];
    }

    /** True when `name` in `env` is still the prelude scheme, not a local/import shadow. */
    private isPreludeBuiltin(name: string, env: Map<string, Scheme>): boolean {
        const scheme = env.get(name);
        return scheme !== undefined && scheme === this.preludeEnv.get(name);
    }

    // -----------------------------------------------------------------------
    // Prelude
    // -----------------------------------------------------------------------

    /**
     * Build the prelude environment from the builtin catalog — the single
     * source of truth for every scheme (see catalog.ts). The join kinds are
     * a dedicated `jkind` type, aggregates return `agg t`, `group` returns
     * `group t`, and the list-argument builtins take one list argument, so
     * `join "inner"`, plain fold entries and non-order sort lambdas are all
     * STATIC type errors, not runtime checks.
     */
    prelude(): void {
        for (const spec of BUILTIN_SPECS) {
            const scheme = spec.scheme(this.u);
            this.env.set(spec.name, { ...scheme, type: builtinOf(spec.name, scheme.type) });
        }
        for (const [name, target] of Object.entries(BUILTIN_ALIASES)) {
            const scheme = this.env.get(target);
            if (scheme) {
                this.env.set(name, { ...scheme, type: builtinOf(name, this.u.peel(scheme.type)) });
            }
        }
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
    inferProject(modules: readonly ProjectModule[], importsByModule: ReadonlyMap<ProjectModule, readonly ResolvedImportEdge[]> = new Map()): void {
        this.prelude();
        const exportsByModule = new Map<ProjectModule, Map<string, Scheme>>();
        const typeExportsByModule = new Map<ProjectModule, Map<string, LangiumType>>();
        for (const module of modules) {
            const exported = this.inferModule(
                module,
                importsByModule.get(module) ?? module.imports ?? [],
                exportsByModule,
                typeExportsByModule,
            );
            exportsByModule.set(module, exported);
            typeExportsByModule.set(module, new Map(
                module.model.types.filter(a => a.export).map(a => [a.name, a.type]),
            ));
        }
        this.flushDeferred();
    }

    /**
     * Prepare this inferencer for one module without walking its bindings:
     * clone the prelude, resolve import scopes, install flat and namespaced
     * schemes, and expand module-local type aliases. Returns the shared scope
     * map used by the per-binding typed pass in `checker.ts`.
     *
     * `inferModule` remains a convenience wrapper around
     * `beginModule` + `inferBinding` for standalone `types`/test callers.
     */
    beginModule(
        module: ProjectModule,
        imports: readonly ResolvedImportEdge[],
        exportsByModule: ReadonlyMap<ProjectModule, ReadonlyMap<string, Scheme>>,
        typeExportsByModule: ReadonlyMap<ProjectModule, ReadonlyMap<string, LangiumType>>,
    ): { scope: ReadonlyMap<string, string> } {
        this.env = new Map(this.preludeEnv);
        this.modules = new Map<string, Map<string, Scheme>>();
        const imported = resolveImportScope(module, imports, exportsByModule, typeExportsByModule);
        const importedTypes = resolveTypeImportScope(module, imports, typeExportsByModule);
        for (const d of importedTypes.diagnostics) this.diag(d.node, d.message);
        for (const d of imported.diagnostics) this.diag(d.node, d.message);
        for (const [name, scheme] of imported.flat) this.env.set(name, scheme);
        for (const [alias, selected] of imported.namespaces) this.modules.set(alias, new Map(selected));
        const scope = new Map(imported.scope);
        this.typeAliases = new Map(importedTypes.flat);
        this.typeNamespaces = new Map([...importedTypes.namespaces].map(([k, v]) => [k, new Map(v)]));
        for (const alias of module.model.types) {
            if (this.typeAliases.has(alias.name)) {
                this.diag(alias, `type alias '${alias.name}' conflicts with an imported type alias`);
                continue;
            }
            this.typeAliases.set(alias.name, alias.type);
        }
        return { scope };
    }

    /**
     * Infer one module in an already-prepared environment. Reads import
     * scopes from `exportsByModule` / `typeExportsByModule` (previous
     * modules) and returns the module's exported binding schemes. Callers
     * update the project export maps after the module is processed.
     */
    inferModule(
        module: ProjectModule,
        imports: readonly ResolvedImportEdge[],
        exportsByModule: ReadonlyMap<ProjectModule, ReadonlyMap<string, Scheme>>,
        typeExportsByModule: ReadonlyMap<ProjectModule, ReadonlyMap<string, LangiumType>>,
    ): Map<string, Scheme> {
        const { scope } = this.beginModule(module, imports, exportsByModule, typeExportsByModule);
        const exported = new Map<string, Scheme>();
        for (const binding of module.model.bindings) {
            this.inferBinding(binding, exported, scope);
        }
        return exported;
    }

    inferBinding(b: Binding, exported: Map<string, Scheme>, scope?: ReadonlyMap<string, string>, reportScopeConflict = true): void {
        if (scope && scope.has(b.name)) {
            if (reportScopeConflict) {
                this.diag(b, conflictMessage(b.name, scope.get(b.name)!, 'a local binding'));
            }
            // The local binding wins at runtime (the interpreter's env
            // override replaces the module value) — stop treating the
            // name as a namespace, or the two passes would diverge on
            // every downstream error. A no-op for flat-import
            // collisions (the name is not in `modules`).
            this.modules.delete(b.name);
        }
        const inferred = this.inferExpr(b.value, this.env);
        let t = inferred;
        if (b.type) {
            const ann = this.translateType(b.type);
            // A bare `table "users"` has the fully polymorphic type `query r` —
            // its schema annotation DEFINES the row, so it constrains the free
            // variable instead of being checked against it. Every other
            // annotation is a checked signature: once it passes, the declared
            // type IS the binding type, so a closed-row annotation actually
            // narrows downstream uses.
            const v = b.value as Expr;
            const isBareTable = isApplication(v) && isIdentifier(v.func)
                && v.func.name === 'table' && v.arguments.length === 1
                && this.isPreludeBuiltin('table', this.env);
            let ok = true;
            if (isBareTable) {
                try {
                    this.u.unify(ann, inferred);
                } catch (err) {
                    if (!(err instanceof UnifyError)) throw err;
                    ok = false;
                }
            } else {
                const sk = this.u.skolemize(inferred);
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
                this.diag(b, `annotation type ${this.u.pretty(ann)} does not match inferred type ${this.u.pretty(inferred)}`);
            } else {
                t = ann;
            }
        }
        this.nodeTypes.set(b, t);
        const envTypes = [...this.env.values()].map(s => s.type);
        const scheme = this.u.generalize(envTypes, t);
        this.env.set(b.name, scheme);
        // Exported bindings are the module's public surface: importers see
        // their generalized schemes (polymorphism survives qualified access).
        if (b.export) exported.set(b.name, scheme);
    }

    /**
     * The per-binding typed pass used by `checkProject`: type the binding,
     * then evaluate its runtime IR in the same scope step. Inference owns the
     * scheme and exports; the interpreter owns the SQL Value.
     */
    typedBinding(
        b: Binding,
        exported: Map<string, Scheme>,
        scope: Map<string, string>,
        valueEnv: Map<string, Value>,
        moduleBindings: ReadonlySet<string>,
        seen: ReadonlySet<string>,
        nodeValues?: Map<AstNode, Value>,
    ): { env: Map<string, Value>; seen: Set<string>; value: Value; diagnostics: Diagnostic[] } {
        const diagnostics: Diagnostic[] = [];
        if (scope.has(b.name)) {
            diagnostics.push({
                node: b,
                message: `name '${b.name}' (a local binding) conflicts with ${scope.get(b.name)!}`,
            });
        }

        // Type first against the ORIGINAL imported scope; the runtime
        // diagnostic above is authoritative, so inference only installs the
        // binding scheme and resolves namespace shadowing.
        const inferenceStart = this.diagnostics.length;
        this.inferBinding(b, exported, scope, false);
        diagnostics.push(...this.takeDiagnosticsFrom(inferenceStart));
        scope.set(b.name, `local binding '${b.name}'`);

        const result = checkBinding(b, valueEnv, moduleBindings, seen, nodeValues ? { nodeValues } : {});
        diagnostics.push(...result.diagnostics);
        return { env: result.env, seen: result.seen, value: result.value, diagnostics };
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
        if (isLetExpression(e) || isLambdaLetExpression(e)) {
            // `let x = value in body` is a pure lexical binding. Like a
            // top-level binding, the declared type becomes the local type once
            // the signature check passes, and the local is let-polymorphic.
            const inferred = this.inferExpr(e.value as Expr, env);
            let bound = inferred;
            if (e.type) {
                const ann = this.translateType(e.type);
                const value = e.value as Expr;
                const isBareTable = isApplication(value) && isIdentifier(value.func)
                    && value.func.name === 'table' && value.arguments.length === 1
                    && this.isPreludeBuiltin('table', env);
                const sk = isBareTable ? null : this.u.skolemize(inferred);
                let ok = true;
                try {
                    this.u.unify(ann, sk ? sk.type : inferred);
                } catch (err) {
                    if (!(err instanceof UnifyError)) throw err;
                    ok = false;
                } finally {
                    sk?.restore();
                }
                if (!ok) {
                    this.diag(e, `annotation type ${this.u.pretty(ann)} does not match inferred type ${this.u.pretty(inferred)}`);
                } else {
                    bound = ann;
                }
            }
            const envTypes = [...env.values()].map(s => s.type);
            const scheme = this.u.generalize(envTypes, bound);
            const newEnv = new Map(env);
            newEnv.set(e.name ?? '', scheme);
            return this.inferExpr(e.body as Expr, newEnv);
        }
        if (isUnaryMinus(e)) {
            const t = this.inferExpr(e.operand, env);
            const r = this.u.peel(t);
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
        if (isNullLiteral(e)) return maybeOf(this.u.fresh()); // ∀a. maybe a
        if (isCaseExpression(e)) return this.inferCase(e, env);
        if (isListLiteral(e)) {
            let item: Type | null = null;
            for (const el of e.elements) {
                const t = this.inferExpr(el, env);
                if (item === null) {
                    item = t;
                } else {
                    // Check compatibility WITHOUT binding the first element's
                    // type: heterogeneous lists are tolerated here (is_in and
                    // the list-argument builtins check elements themselves),
                    // but unification must not pin column variables to a later
                    // element's type — `[u.balance, 2]` must not pin balance
                    // to int. Skolemizing makes the check read-only.
                    const sk = this.u.skolemize(item);
                    try {
                        this.u.unify(item, t);
                    } catch {
                        /* heterogeneous lists are checked downstream (§11) */
                    } finally {
                        sk.restore();
                    }
                }
            }
            return listOf(item ?? this.u.fresh());
        }
        if (isMapLiteral(e)) {
            const fields: [string, Type][] = [];
            for (const entry of e.entries) {
                if (entry.value) {
                    fields.push([labelName(entry.key), this.inferExpr(entry.value, env)]);
                } else {
                    const t = this.inferFieldPun(entry, env);
                    fields.push([labelName(entry.key), t]);
                }
            }
            const updated = rowOf(fields);
            if (!e.receiver) return updated;
            // `{ receiver | k = v }` is record-update sugar for
            // `merge receiver { k = v }`.
            const base = this.inferExpr(e.receiver, env);
            const r = this.u.peel(base);
            if (r.kind !== 'row' && r.kind !== 'var') {
                this.diag(e.receiver, `record update expects a record before '|', got type ${this.u.pretty(base)}`);
                return updated;
            }
            return this.inferMerge(base, updated, e);
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
        for (const id of rigidVars) this.u.setVarRigid(id, false);
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
            if (this.modules.has(name)) return { module: name, binding: labelName(e.property) };
        }
        return null;
    }

    private inferAccess(e: import('./generated/ast.js').AccessExpression, env: Map<string, Scheme>): Type {
        const property = labelName(e.property);
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
        const r = this.u.peel(recv);
        if (r.kind === 'query') {
            this.diag(e, `tables have no fields — access columns through a row parameter inside a lambda, e.g. map (u => u.${property})`);
            return this.u.fresh();
        }
        // Completion inserts `u._tetaue_field` into a mid-typing document; it
        // is a probe, not a real column, and must not pin `u`'s row.
        if (property.startsWith(SYNTHETIC_FIELD_PREFIX)) return this.u.fresh();
        let field;
        try {
            field = this.u.fieldOf(recv, property);
        } catch (err) {
            if (!(err instanceof UnifyError)) throw err;
            field = null; // e.g. extending a rigid (annotated) row tail
        }
        if (!field) {
            const labels = r.kind === 'row' ? this.u.rowLabels(r) : [];
            this.diag(e, `unknown column '${property}'${labels.length > 0 ? ` — available: ${labels.join(', ')}` : ''}`);
            return this.u.fresh();
        }
        return field.type;
    }

    private inferBinary(e: import('./generated/ast.js').BinaryExpression, env: Map<string, Scheme>): Type {
        const op = e.operator;
        if (op === '&') {
            // a & f ⇔ f a — ordinary function application with the operands
            // reversed. Type mismatches are reported here as well as by the
            // interpreter; the two passes are deduped when the messages match.
            const a = this.inferExpr(e.left, env);
            const f = this.inferExpr(e.right, env);
            const a1 = this.u.fresh();
            const b1 = this.u.fresh();
            try {
                this.u.unify(f, fun(a1, b1));
                this.u.unify(a, a1);
                return b1;
            } catch (err) {
                if (err instanceof UnifyError) {
                    if (!this.reportNumericMix(e, err)) {
                        this.reportApplyMismatch(e, f, a, e.right, env);
                    }
                } else {
                    throw err;
                }
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
                if (err instanceof UnifyError) {
                    if (!this.reportNumericMix(e, err)) {
                        this.reportApplyMismatch(e, f, a, e.right, env);
                    }
                } else {
                    throw err;
                }
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
                return fun(a, c);
            } catch (err) {
                if (err instanceof UnifyError) {
                    if (!this.reportNumericMix(e, err)) {
                        this.diag(e, `cannot compose ${this.u.pretty(l)} with ${this.u.pretty(r)} — both must be functions`);
                    }
                } else {
                    throw err;
                }
                return this.u.fresh();
            }
        }
        const lt = this.inferExpr(e.left, env);
        const rt = this.inferExpr(e.right, env);
        if (op === '==' || op === '!=' || op === '<' || op === '<=' || op === '>' || op === '>=') {
            const leftNull = this.isNullLiteralNode(e.left);
            const rightNull = this.isNullLiteralNode(e.right);
            try {
                if (leftNull || rightNull) {
                    // null : forall a. maybe a — comparing a nullable value with
                    // null is fine and lowers to IS [NOT] NULL.
                    this.u.unify(lt, rt);
                } else {
                    this.u.unify(lt, rt);
                    const rl = this.u.peel(lt);
                    const rr = this.u.peel(rt);
                    if (rl.kind === 'maybe' || rr.kind === 'maybe') {
                        this.diag(e, `comparison expects non-null values — use is_null/is_not_null or from_maybe, got ${this.u.pretty(lt)} and ${this.u.pretty(rt)}`);
                        return prim('bool');
                    }
                }
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
        // Haskell-base numerics: + - * require the same numeric type; / is
        // fractional division and requires float; use div/mod for integrals.
        if (op === '/') {
            try {
                this.u.unify(lt, prim('float'));
                this.u.unify(rt, prim('float'));
            } catch (err) {
                if (err instanceof UnifyError) {
                    this.diag(e, `'/' requires float operands — use div for integral division, got ${this.u.pretty(lt)} and ${this.u.pretty(rt)}`);
                } else {
                    throw err;
                }
                return this.u.fresh();
            }
            return prim('float');
        }
        // + - *
        try {
            const unified = this.u.unify(lt, rt);
            const rl = this.u.peel(lt);
            const rr = this.u.peel(rt);
            if (rl.kind === 'prim' && rr.kind === 'prim' && isNumericPrim(rl) && isNumericPrim(rr) && rl.name !== rr.name) {
                this.diag(e, `'${op}' requires numeric operands of the same type, got ${this.u.pretty(lt)} and ${this.u.pretty(rt)}`);
            } else if (rl.kind === 'prim' && rr.kind === 'prim' && !isNumericPrim(rl) && !isNumericPrim(rr)) {
                this.diag(e, `'${op}' requires numeric operands, got ${this.u.pretty(lt)} and ${this.u.pretty(rt)}`);
            }
            return unified;
        } catch (err) {
            if (err instanceof UnifyError) {
                const rl = this.u.peel(lt);
                const rr = this.u.peel(rt);
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
        // A builtin keeps its identity in its TYPE, so `f = fold`, `by = sort`
        // and `pick = greatest` behave exactly like a direct prelude use.
        const rawF = this.inferExpr(e.func, env);
        const directName = this.directBuiltinName(e.func, env);
        const boundName = rawF.kind === 'builtin' ? rawF.name : null;
        const funcName = directName ?? boundName;
        // A bare builtin reference (`by = sort`) is a value, not an
        // application of zero arguments: keep the builtin tag so its special
        // typing rules survive first-class bindings.
        if (e.arguments.length === 0) return rawF;
        // `param "name"` — all occurrences of the same parameter name share
        // one named type hole, so conflicting uses cannot both type-check and
        // then collapse onto one SQL bind placeholder at render time.
        if (funcName === 'param' && e.arguments.length === 1) {
            this.inferArg(e.arguments[0]!, env);
            const nameArg = e.arguments[0]!;
            if (isStringLiteral(nameArg)) {
                const parsed = parseStringLiteral(nameArg.value);
                if (parsed.length > 0) {
                    let hole = this.paramTypes.get(parsed);
                    if (!hole) {
                        hole = this.u.freshHole('flex', `param_${parsed.replace(/[^A-Za-z0-9_]/g, '_')}`);
                        this.paramTypes.set(parsed, hole);
                    }
                    return hole;
                }
            }
            return this.u.fresh();
        }
        // `table "users"` — an un-annotated table is a fresh ROW HOLE, not
        // `forall r. query r`: the hole is excluded from generalization, so
        // every use of the same binding feeds one shared metavariable and the
        // schema is inferred from all use sites together.
        if (funcName === 'table' && e.arguments.length === 1) {
            this.inferArg(e.arguments[0]!, env);
            let holeName = 'table';
            const tableArg = e.arguments[0]!;
            if (isStringLiteral(tableArg)) {
                const parsed = parseStringLiteral(tableArg.value);
                holeName = `table_${parsed.replace(/[^A-Za-z0-9_]/g, '_')}`;
            }
            return queryOf(this.u.freshHole('row', holeName));
        }
        // `fold`/`map` — the DSL's mode checks: fold entries must be
        // aggregate/group mode (a plain column is a type error), and the
        // result row strips the modes so downstream sees plain columns.
        if (funcName === 'join' && e.arguments.length === 4) return this.inferJoin(e, env);
        if (funcName === 'scalar' && e.arguments.length === 1) return this.inferScalar(e, env);
        if ((funcName === 'in_query' || funcName === 'not_in_query') && e.arguments.length === 2) return this.inferInQuery(e, env);
        if (funcName === 'fold' && e.arguments.length === 1) return this.inferFold(e, env);
        if (funcName === 'group_by' && e.arguments.length === 1) return this.inferGroupBy(e, env);
        if (funcName === 'map' && e.arguments.length === 1) return this.inferMap(e, env);
        if (funcName === 'select' && e.arguments.length === 1) return this.inferSelect(e, env);
        // `merge` — the result row is the union of both rows (the right
        // record wins on overlapping fields), which the generic fun-type
        // application path cannot express; compute the union directly.
        if (funcName === 'coalesce' && e.arguments.length === 1) return this.inferCoalesceList(e, env);
        if (funcName === 'merge' && e.arguments.length === 1) {
            return this.inferMergePartial(e.arguments[0]!, e, env);
        }
        if (funcName === 'merge' && e.arguments.length === 2) {
            const a = this.inferArg(e.arguments[0]!, env);
            const b = this.inferArg(e.arguments[1]!, env);
            return this.inferMerge(a, b, e);
        }
        if (funcName === 'over') return this.inferOver(e, env);
        if (funcName === 'cast' && e.arguments.length === 2) return this.inferCast(e, env, funcName);
        if (funcName === 'try_cast' && e.arguments.length === 2) return this.inferCast(e, env, funcName);
        let f = this.u.peel(rawF);
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
        if (funcName && LIST_BUILTINS.has(funcName) && e.arguments.length > 0) {
            this.checkListBuiltin(funcName, e, env);
        }
        return f;
    }

    /**
     * `coalesce [a, b, c]` — the list form has the same typing as the
     * curried two-argument form: every element is `maybe T` and the result is
     * `maybe T`.
     */
    private inferCoalesceList(e: import('./generated/ast.js').Application, env: Map<string, Scheme>): Type {
        const listExpr = e.arguments[0]!;
        if (!isListLiteral(listExpr)) return this.u.fresh(); // interpreter reports the shape
        const elements = listExpr.elements;
        if (elements.length < 2) {
            this.diag(listExpr, `coalesce expects at least two expressions, e.g. coalesce [u.nickname, u.email]`);
            return this.u.fresh();
        }
        const inner = this.u.fresh();
        const expected = maybeOf(inner);
        for (const item of elements) {
            const t = this.inferArg(item, env);
            try {
                this.u.unify(expected, t);
            } catch (err) {
                if (err instanceof UnifyError) {
                    this.diag(item, `coalesce requires matching nullable (maybe T) types, got ${this.u.pretty(t)}`);
                } else {
                    throw err;
                }
            }
        }
        return expected;
    }

    /**
     * `merge r` as a partial application: the returned function still
     * carries the row-union typing, so `extend = merge { active = true }`
     * is a reusable row transformer instead of forgetting the left row.
     */
    private inferMergePartial(rightExpr: Expr, e: import('./generated/ast.js').Application, env: Map<string, Scheme>): Type {
        const right = this.inferArg(rightExpr, env);
        const leftVar = this.u.fresh('row');
        const result = this.inferMerge(leftVar, right, e);
        return fun(leftVar, result);
    }

    /**
     * `over fn { partition = [...], order = [...] }` — the wrapped value
     * must be in aggregate mode or window-only mode. The result is the
     * wrapped payload type, so `over (row_number) {...} : int`.
     */
    private inferOver(e: import('./generated/ast.js').Application, env: Map<string, Scheme>): Type {
        if (e.arguments.length === 0) return this.inferExpr(e.func, env);
        const firstExpr = e.arguments[0]!;
        const first = this.inferArg(firstExpr, env);
        const raw = this.u.peel(first);
        if (raw.kind !== 'window' && raw.kind !== 'agg') {
            this.argError('over', 0, firstExpr, first, undefined, undefined);
            return this.u.fresh();
        }
        // Infer the remaining arguments for their own diagnostics; the
        // interpreter owns the spec-record validation.
        for (let i = 1; i < e.arguments.length; i++) {
            this.inferArg(e.arguments[i]!, env);
        }
        return raw.of;
    }

    /** `cast x "int"` / `try_cast x "float"` — the result type is the target. */
    private inferCast(e: import('./generated/ast.js').Application, env: Map<string, Scheme>, name: 'cast' | 'try_cast'): Type {
        this.inferArg(e.arguments[0]!, env);
        const targetExpr = e.arguments[1]!;
        if (isStringLiteral(targetExpr)) {
            const target = parseStringLiteral(targetExpr.value);
            if ((CAST_TYPES as readonly string[]).includes(target)) {
                return prim(target as CastType);
            }
        }
        this.diag(targetExpr, `${name} expects a target type as a string literal — one of: ${CAST_TYPES.join(', ')}`);
        return this.u.fresh();
    }

    /**
     * `join kind right on merger` — for LEFT/RIGHT/FULL joins the
     * null-extended side can produce SQL NULLs, so the merger's output row is
     * explicitly `maybe` on every projected field. INNER joins keep the
     * merger's exact row type.
     */
    private inferJoin(e: import('./generated/ast.js').Application, env: Map<string, Scheme>): Type {
        const kindName = this.joinKindNameOf(e.arguments[0]);
        if (kindName === null) {
            this.argError('join', 0, e.arguments[0]!, this.inferArg(e.arguments[0]!, env), undefined, undefined);
            return this.u.fresh();
        }
        const r = this.u.fresh('row');
        const s = this.u.fresh('row');
        const t = this.u.fresh('flex');
        const rightT = this.inferArg(e.arguments[1]!, env);
        const onT = this.inferArg(e.arguments[2]!, env);
        const mergerT = this.inferArg(e.arguments[3]!, env);
        try {
            this.u.unify(rightT, queryOf(s));
            this.u.unify(onT, fun(r, fun(s, prim('bool'))));
        } catch (err) {
            if (err instanceof UnifyError) {
                this.diag(e, `cannot apply a function of type ${this.u.pretty(mergerT)} to the join arguments`);
            } else {
                throw err;
            }
            return this.u.fresh();
        }
        // `join ... merge` is the advertised full-row-union shorthand. The
        // generic merge scheme returns an unconstrained fresh row, which would
        // lose every projected field and the outer-join nullability of the
        // result. Compute the merge row directly from the left and right rows
        // (right wins on overlap) instead of unifying the generic scheme.
        const mergerIsMerge = mergerT.kind === 'builtin' && mergerT.name === 'merge';
        let row: Type;
        if (mergerIsMerge) {
            // Materialize each side's open-tail fields before merging so the
            // outer-join maybe-wrapping below sees every projected column
            // (otherwise a column carried only in a materialized tail is not
            // wrapped and escapes as non-null).
            const mergeInput = (input: Type): Type => {
                const rt = this.u.peel(input);
                if (rt.kind !== 'row') return input;
                const resolved = this.u.resolveRow(rt);
                return rowOf([...resolved.fields], resolved.tail);
            };
            row = this.inferMerge(mergeInput(r), mergeInput(s), e.arguments[3]!);
        } else {
            try {
                this.u.unify(mergerT, fun(r, fun(s, t)));
            } catch (err) {
                if (err instanceof UnifyError) {
                    this.diag(e, `cannot apply a function of type ${this.u.pretty(mergerT)} to the join arguments`);
                } else {
                    throw err;
                }
                return this.u.fresh();
            }
            row = this.u.peel(t);
            if (row.kind === 'var') {
                const tail = this.u.fresh('row');
                try { this.u.bind(row.id, { kind: 'row', fields: new Map(), tail }); } catch { /* leave open */ }
                row = this.u.peel(t);
            }
        }
        if (row.kind !== 'row') {
            this.argError('join', 3, e.arguments[3]!, mergerT, undefined, undefined);
            return this.u.fresh();
        }
        if (kindName === 'inner') return fun(queryOf(r), queryOf(row));

        // Null-extended columns are nullable in the result. We conservatively
        // wrap every projected field; a future provenance analysis can narrow
        // this to only the fields read from the null-extended side.
        const resolved = this.u.resolveRow(row);
        const fields: [string, Type][] = [...resolved.fields].map(([key, ft]) => {
            const rt = this.u.peel(ft);
            return [key, rt.kind === 'maybe' ? ft : maybeOf(ft)];
        });
        if (resolved.tail) {
            const tailRoot = this.u.resolve(resolved.tail);
            if (tailRoot.kind === 'var') this.u.setVarAbsorbAsMaybe(tailRoot.id, true);
        }
        return fun(queryOf(r), queryOf({ kind: 'row', fields: new Map(fields), tail: resolved.tail }));
    }

    private joinKindNameOf(node: AstNode | undefined): string | null {
        let cur = node;
        while (cur && isApplication(cur) && cur.arguments.length === 0) cur = cur.func;
        if (cur && isIdentifier(cur)) {
            const name = cur.name;
            return name === 'inner' || name === 'left' || name === 'right' || name === 'full' ? name : null;
        }
        return null;
    }

    /**
     * `scalar q` — a scalar subquery. SQL allows exactly one output column;
     * the result is maybe because an empty subquery yields NULL.
     */
    private inferScalar(e: import('./generated/ast.js').Application, env: Map<string, Scheme>): Type {
        const argT = this.inferArg(e.arguments[0]!, env);
        const r = this.u.peel(argT);
        if (r.kind !== 'query') {
            this.diag(e, `scalar expects a query argument, got type ${this.u.pretty(argT)}`);
            return this.u.fresh();
        }
        const row = this.u.peel(r.row);
        if (row.kind === 'var') {
            const tail = this.u.fresh('row');
            try { this.u.bind(row.id, { kind: 'row', fields: new Map(), tail }); } catch { /* leave open */ }
            return maybeOf(this.u.fresh());
        }
        if (row.kind !== 'row') {
            this.diag(e, `scalar expects a query argument, got type ${this.u.pretty(argT)}`);
            return this.u.fresh();
        }
        const fields = [...this.u.resolveRow(row).fields];
        if (fields.length !== 1) {
            this.diag(e, `scalar subquery must return exactly one column, got ${fields.length}`);
            return this.u.fresh();
        }
        return maybeOf(fields[0]![1]);
    }

    /** `in_query x q` / `not_in_query x q` — IN (SELECT ...). */
    private inferInQuery(e: import('./generated/ast.js').Application, env: Map<string, Scheme>): Type {
        const valueT = this.inferArg(e.arguments[0]!, env);
        const queryT = this.inferArg(e.arguments[1]!, env);
        const r = this.u.peel(queryT);
        if (r.kind !== 'query') {
            this.diag(e, `${e.func && isApplication(e.func) && e.func.arguments.length === 0 && isIdentifier(e.func.func) ? e.func.func.name : 'in_query'} expects a query as its second argument, got type ${this.u.pretty(queryT)}`);
            return this.u.fresh();
        }
        const row = this.u.peel(r.row);
        if (row.kind !== 'row') return prim('bool'); // interpreter reports the shape
        const fields = [...this.u.resolveRow(row).fields];
        if (fields.length !== 1) {
            this.diag(e, `in_query subquery must return exactly one column, got ${fields.length}`);
            return prim('bool');
        }
        try {
            this.u.unify(valueT, fields[0]![1]);
        } catch (err) {
            if (err instanceof UnifyError) {
                this.diag(e, `in_query requires matching types, got ${this.u.pretty(valueT)} and ${this.u.pretty(fields[0]![1])}`);
            } else {
                throw err;
            }
        }
        return prim('bool');
    }

    /** `select ["id", "name"]` — a projection narrowing to the listed fields. */
    private inferSelect(e: import('./generated/ast.js').Application, env: Map<string, Scheme>): Type {
        const listExpr = e.arguments[0]!;
        this.inferArg(listExpr, env);
        if (!isListLiteral(listExpr)) {
            this.diag(listExpr, `select expects a list of column-name strings, e.g. select ["id", "name"]`);
            return this.u.fresh();
        }
        const labels: string[] = [];
        const seen = new Set<string>();
        for (const item of listExpr.elements) {
            let strNode: AstNode | undefined = item;
            while (strNode && isApplication(strNode) && strNode.arguments.length === 0) strNode = strNode.func;
            if (!isStringLiteral(strNode)) {
                this.diag(item, `select entries must be string literals`);
                continue;
            }
            const label = parseStringLiteral(strNode.value);
            if (seen.has(label)) this.diag(item, `duplicate column '${label}' in select`);
            seen.add(label);
            labels.push(label);
        }
        if (labels.length === 0) {
            this.diag(listExpr, `select expects at least one column name, e.g. select ["id"]`);
        }
        const r = this.u.fresh('row');
        const fields: [string, Type][] = [];
        for (const label of labels) {
            const field = this.u.fieldOf(r, label);
            fields.push([label, field?.type ?? this.u.fresh()]);
        }
        return fun(queryOf(r), queryOf(rowOf(fields)));
    }

    /**
     * `fold (o => { k = group o.k, s = sum o.v })` — the DSL's aggregate-mode
     * check. The lambda's result must be a record whose fields are ALL in
     * aggregate or group mode (`agg t` / `group t`), with at least one
     * aggregate — a plain column or computed expression is a static type
     * error, no longer deferred to the runtime step application. The result
     * row strips the modes, so downstream steps see plain columns
     * (`query { user_id: int, total: float }`), matching the interpreter's
     * derived-table semantics.
     */
    private inferFold(e: import('./generated/ast.js').Application, env: Map<string, Scheme>): Type {
        const argExpr = e.arguments[0]!;
        const argType = this.inferArg(argExpr, env);
        const r = this.u.peel(argType);
        if (r.kind !== 'fun') {
            this.argError('fold', 0, argExpr, argType, undefined, undefined);
            return this.u.fresh();
        }
        const ret = this.u.peel(r.to);
        if (ret.kind === 'var') {
            // An unconstrained projection (e.g. mid-typing `fold (o => o._x)`):
            // bind it to the open result row like the generic scheme, so the
            // surrounding `&` still resolves the row's fields. The interpreter
            // reports a non-record projection at runtime.
            const s = this.u.fresh('row');
            try { this.u.bind(ret.id, rowOf([], s)); } catch { /* leave open */ }
            return fun(queryOf(r.from), queryOf(rowOf([], s)));
        }
        if (ret.kind !== 'row') {
            this.argError('fold', 0, argExpr, argType, undefined, undefined);
            return this.u.fresh();
        }
        const res = this.u.resolveRow(ret);
        const entryNodes = this.entryNodesOf(argExpr);
        const groupSigs = new Set<string>();
        for (const [key, ft] of res.fields) {
            if (this.u.peel(ft).kind !== 'group') continue;
            const groupArg = this.groupArgumentOf(entryNodes?.get(key));
            const sig = this.accessSignature(groupArg);
            if (sig) groupSigs.add(sig);
        }
        const out: [string, Type][] = [];
        let aggregates = 0;
        for (const [key, ft] of res.fields) {
            const raw = this.u.peel(ft);
            if (raw.kind === 'agg') {
                const entry = entryNodes?.get(key);
                const caseNode = this.unwrapApplicationExpr(entry);
                if (caseNode && isCaseExpression(caseNode)) {
                    const conditionSigs = this.conditionAccessSignatures(caseNode);
                    const ungrouped = [...conditionSigs].some(sig => !groupSigs.has(sig));
                    if (ungrouped) {
                        this.diag(entry ?? argExpr, `fold entry '${key}' case conditions must be constant or use grouped columns`);
                    }
                }
                aggregates++;
                out.push([key, raw.of]);
            } else if (raw.kind === 'group') {
                out.push([key, raw.of]);
            } else {
                this.diag(entryNodes?.get(key) ?? argExpr, `fold entry '${key}' must be wrapped in an aggregate (count, sum, ...) or group`);
                out.push([key, ft]);
            }
        }
        if (aggregates === 0) {
            this.diag(argExpr, `fold must contain at least one aggregate (count, sum, ...)`);
        }
        return fun(queryOf(r.from), queryOf(rowOf(out, res.tail)));
    }

    /**
     * `group_by (o => { user_id = group o.user_id })` — GROUP BY without an
     * aggregate, for SQL deduplication. Every entry must be in group mode and
     * the result row strips the mode so downstream steps see plain columns.
     */
    private inferGroupBy(e: import('./generated/ast.js').Application, env: Map<string, Scheme>): Type {
        const argExpr = e.arguments[0]!;
        const argType = this.inferArg(argExpr, env);
        const r = this.u.peel(argType);
        if (r.kind !== 'fun') {
            this.argError('group_by', 0, argExpr, argType, undefined, undefined);
            return this.u.fresh();
        }
        const ret = this.u.peel(r.to);
        if (ret.kind === 'var') {
            const s = this.u.fresh('row');
            try { this.u.bind(ret.id, rowOf([], s)); } catch { /* leave open */ }
            return fun(queryOf(r.from), queryOf(rowOf([], s)));
        }
        if (ret.kind !== 'row') {
            this.argError('group_by', 0, argExpr, argType, undefined, undefined);
            return this.u.fresh();
        }
        const res = this.u.resolveRow(ret);
        const entryNodes = this.entryNodesOf(argExpr);
        const out: [string, Type][] = [];
        let groups = 0;
        for (const [key, ft] of res.fields) {
            const raw = this.u.peel(ft);
            if (raw.kind === 'group') {
                groups++;
                out.push([key, raw.of]);
            } else {
                this.diag(entryNodes?.get(key) ?? argExpr, `group_by entry '${key}' must be wrapped in group, e.g. group ${key}`);
                out.push([key, ft]);
            }
        }
        if (groups === 0) {
            this.diag(argExpr, `group_by must contain at least one group entry, e.g. group_by (o => { id = group o.id })`);
        }
        return fun(queryOf(r.from), queryOf(rowOf(out, res.tail)));
    }

    /**
     * `map (u => { ... })` — projection mode check: the result row must not
     * contain `group` keys or `order` items (SQL cannot select a GROUP BY key
     * or an ORDER BY item as a value), mirroring the interpreter's
     * rowFromRecord. Aggregate fields are allowed — after a fold the map runs
     * on the aggregated result (nested aggregation), which the interpreter
     * validates positionally. The result row strips modes so downstream
     * columns are plain.
     */
    private inferMap(e: import('./generated/ast.js').Application, env: Map<string, Scheme>): Type {
        const argExpr = e.arguments[0]!;
        const argType = this.inferArg(argExpr, env);
        const r = this.u.peel(argType);
        if (r.kind !== 'fun') {
            this.argError('map', 0, argExpr, argType, undefined, undefined);
            return this.u.fresh();
        }
        const ret = this.u.peel(r.to);
        if (ret.kind === 'var') {
            // An unconstrained projection (e.g. mid-typing `map (u => u._x)`):
            // bind it to the open result row like the generic scheme, so the
            // surrounding `&` still resolves the row's fields. A non-record
            // projection (a scalar, like `map (u => u.age)`) still errors.
            const s = this.u.fresh('row');
            try { this.u.bind(ret.id, rowOf([], s)); } catch { /* leave open */ }
            return fun(queryOf(r.from), queryOf(rowOf([], s)));
        }
        if (ret.kind !== 'row') {
            this.argError('map', 0, argExpr, argType, undefined, undefined);
            return this.u.fresh();
        }
        const res = this.u.resolveRow(ret);
        const entryNodes = this.entryNodesOf(argExpr);
        const out: [string, Type][] = [];
        for (const [key, ft] of res.fields) {
            const raw = this.u.peel(ft);
            if (raw.kind === 'group') {
                this.diag(entryNodes?.get(key) ?? argExpr, `projection entry '${key}' cannot contain group`);
            } else if (raw.kind === 'order') {
                this.diag(entryNodes?.get(key) ?? argExpr, `projection entry '${key}' cannot contain order items (asc/desc)`);
            } else if (raw.kind === 'window') {
                const entry = entryNodes?.get(key);
                const fnName = this.windowFunctionNameOf(entry) ?? 'window function';
                // Anchor on the enclosing pipeline so this diagnostic and the
                // interpreter's validateWindowUses message dedupe exactly.
                this.diag(this.pipelineAnchorOf(e), `${fnName} must be wrapped in over (...) — e.g. over (${fnName}) { partition = [u.dept], order = [desc u.salary] }`);
                out.push([key, raw.of]);
                continue;
            }
            out.push([key, raw.kind === 'agg' ? raw.of : ft]);
        }
        return fun(queryOf(r.from), queryOf(rowOf(out, res.tail)));
    }

    /** Unwrap zero-argument Application wrappers around an expression node. */
    /** Unwrap zero-argument Application wrappers around an expression node. */
    /** Unwrap zero-argument Application wrappers around an expression node. */
    private unwrapApplicationExpr(node: AstNode | undefined): AstNode | undefined {
        let cur = node;
        while (cur && isApplication(cur) && cur.arguments.length === 0) cur = cur.func;
        return cur;
    }

    /** The `u.field` argument of a `group u.field` entry, for condition checks. */
    private groupArgumentOf(node: AstNode | undefined): AstNode | undefined {
        const app = this.unwrapApplicationExpr(node);
        if (app && isApplication(app) && app.arguments.length === 1) {
            return this.unwrapApplicationExpr(app.arguments[0]);
        }
        return undefined;
    }

    private accessSignature(node: AstNode | undefined): string | null {
        const access = this.unwrapApplicationExpr(node);
        if (!access || !isAccessExpression(access)) return null;
        const receiver = access.receiver?.$cstNode?.text ?? '';
        return `${receiver}.${labelName(access.property)}`;
    }

    /** Access signatures (`u.status`) used in a CASE expression's conditions. */
    private conditionAccessSignatures(caseNode: CaseExpression): Set<string> {
        const sigs = new Set<string>();
        for (const branch of caseNode.branches) {
            if (!branch.cond) continue;
            const stack: AstNode[] = [branch.cond];
            while (stack.length > 0) {
                const cur = stack.pop()!;
                const access = this.unwrapApplicationExpr(cur);
                if (access && isAccessExpression(access)) {
                    const sig = this.accessSignature(access);
                    if (sig) sigs.add(sig);
                }
                for (const key of Object.keys(cur)) {
                    if (key.startsWith('$')) continue;
                    const value = (cur as unknown as Record<string, unknown>)[key];
                    if (Array.isArray(value)) {
                        for (const v of value) {
                            if (v && typeof v === 'object' && '$type' in (v as object)) stack.push(v as AstNode);
                        }
                    } else if (value && typeof value === 'object' && '$type' in (value as object)) {
                        stack.push(value as AstNode);
                    }
                }
            }
        }
        return sigs;
    }

    private entryNodesOf(argExpr: Expr): Map<string, AstNode> | null {
        let node: Expr | null = argExpr;
        // `(o => { ... })` parses as a 0-argument Application wrapping the
        // lambda, and `{ k = v }` as a lambda body likewise wraps the map
        // literal — unwrap both before reading the entries.
        while (node && isApplication(node) && node.arguments.length === 0) node = node.func;
        if (!node) return null;
        let body: Expr | null = isLambda(node) ? (node.body as unknown as Expr) : node;
        while (body && isApplication(body) && body.arguments.length === 0) body = body.func;
        if (!body || !isMapLiteral(body)) return null;
        return new Map(body.entries.filter(en => en.value !== undefined).map(en => [labelName(en.key), en.value as AstNode]));
    }

    /**
     * List-argument builtins (`concat [a, b]`, `substring [s, 1, 3]`, ...):
     * the scheme types the FIRST element; this checks every element's static
     * kind and the arity, mirroring the interpreter's runtime checks with
     * matching messages (so the merged diagnostics dedupe).
     */
    private checkListBuiltin(name: string, e: import('./generated/ast.js').Application, env: Map<string, Scheme>): void {
        const listExpr = e.arguments[0];
        if (!listExpr || !isListLiteral(listExpr)) return;
        const elements = listExpr.elements;
        const [min, max] = LIST_ARITY[name] ?? [0, Infinity];
        if (elements.length < min || elements.length > max) {
            this.diag(listExpr, `${name} expects ${min}${max === Infinity ? ' or more' : ` to ${max}`} arguments, got ${elements.length}`);
        }
        const expect = (i: number, kind: 'string' | 'int' | 'numeric'): void => {
            if (i >= elements.length) return;
            const t = this.inferExpr(elements[i]!, env);
            if (kind === 'numeric') {
                const r = this.u.peel(t);
                if (r.kind === 'prim' && !isNumericPrim(r)) {
                    this.diag(elements[i]!, `${name} expects numeric expressions, got type ${this.u.pretty(t)}`);
                }
                return;
            }
            try {
                this.u.unify(kind === 'string' ? prim('string') : prim('int'), t);
            } catch (err) {
                if (err instanceof UnifyError) {
                    this.diag(elements[i]!, `${name} expects ${kind === 'string' ? 'string' : 'numeric'} expressions, got type ${this.u.pretty(t)}`);
                } else {
                    throw err;
                }
            }
        };
        switch (name) {
            case 'concat': elements.forEach((_, i) => expect(i, 'string')); break;
            case 'greatest': case 'least': {
                let base: Type | null = null;
                for (let i = 0; i < elements.length; i++) {
                    const t = this.inferExpr(elements[i]!, env);
                    if (base !== null) {
                        this.defer(listExpr, base, t, `${name} requires matching types`);
                    }
                    base = t;
                }
                break;
            }
            case 'round': expect(0, 'numeric'); expect(1, 'int'); break;
            case 'substring': expect(0, 'string'); expect(1, 'int'); expect(2, 'int'); break;
            case 'lpad': case 'rpad': expect(0, 'string'); expect(1, 'int'); expect(2, 'string'); break;
            case 'regex_extract': expect(0, 'string'); expect(1, 'string'); expect(2, 'int'); break;
            case 'lag': case 'lead':
                if (elements.length >= 2) {
                    const offset = this.inferExpr(elements[1]!, env);
                    const r = this.u.peel(offset);
                    if (r.kind === 'prim' && !isNumericPrim(r)) {
                        this.diag(elements[1]!, `${name} expects a numeric offset, got type ${this.u.pretty(offset)}`);
                    }
                }
                break;
        }
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
        let hasFallback = false;
        // Simple case: `case subject { c1 => v1, ..., _ => v }` is sugar for
        // `subject == c1` conditions — every branch condition unifies with the
        // subject's type instead of being required to be boolean.
        const subjectT = e.subject ? this.inferExpr(e.subject, env) : null;
        for (const b of e.branches) {
            if (b.fallback) {
                hasFallback = true;
            }
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
                    this.u.unify(base, valueT);
                } catch (err) {
                    if (err instanceof UnifyError) {
                        this.diag(b.value, `case requires matching value types, got ${this.u.pretty(base)} and ${this.u.pretty(valueT)}`);
                    } else {
                        throw err;
                    }
                }
            }
        }
        return hasFallback ? (base ?? this.u.fresh()) : maybeOf(base ?? this.u.fresh());
    }

    /**
     * A row or an unconstrained variable (an open row with nothing known
     * yet). Closed non-row types return null — `merge` requires records on
     * both sides.
     */
    private mergeRowShape(t: Type, at: AstNode, which: 'first' | 'second'): { fields: Map<string, Type>; tail: Type | null; varId: number | null } | null {
        const r = this.u.peel(t);
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
            const t = this.u.peel(aShape.tail);
            if (t.kind === 'var' && !this.u.varInfo(t.id).rigid) {
                try { this.u.bind(t.id, resTail); } catch { /* kind conflict: leave open */ }
            }
        } else {
            // Both closed: keep a tail open so the result stays mergeable.
            resTail = this.u.fresh('row');
        }
        return { kind: 'row', fields: resFields, tail: resTail };
    }

    /** The builtin name if `node` is a direct prelude reference (possibly a 0-arg Application). */
    private directBuiltinName(node: AstNode | undefined, env: Map<string, Scheme>): string | null {
        let e = node;
        while (e && isApplication(e) && e.arguments.length === 0) e = e.func;
        if (!e || !isIdentifier(e)) return null;
        return this.isPreludeBuiltin(e.name, env) ? e.name : null;
    }

    /** The window-only builtin name behind a projection entry, for diagnostics. */
    private windowFunctionNameOf(node: AstNode | undefined): string | null {
        let e = node as Expr | undefined;
        while (e && isApplication(e) && e.arguments.length === 0) e = e.func;
        if (!e) return null;
        if (isIdentifier(e)) return e.name;
        if (isApplication(e)) {
            let f: Expr = e.func;
            while (isApplication(f) && f.arguments.length === 0) f = f.func;
            if (isIdentifier(f)) return f.name;
        }
        return null;
    }

    /** The nearest enclosing pipeline/application binary node, for diagnostic dedupe. */
    private pipelineAnchorOf(e: AstNode): AstNode {
        let current: AstNode | undefined = e;
        while (current) {
            const parent: AstNode | undefined = current.$container;
            if (parent && (isBinaryExpression(parent) || isLambdaBinaryExpression(parent))) {
                if (parent.left === current || parent.right === current) return parent;
            }
            current = parent;
        }
        return e;
    }

    /** Report a failed `&` / `$` application when the numeric-mix special case did not apply. */
    private reportApplyMismatch(node: AstNode, fType: Type, aType: Type, applied: AstNode | undefined, env: Map<string, Scheme>): void {
        const r = this.u.peel(fType);
        if (r.kind !== 'fun') {
            this.diag(node, `cannot apply an expression of type ${this.u.pretty(fType)}`);
            return;
        }
        const name = this.directBuiltinName(applied, env);
        if (name) {
            // Builtin argument errors are already produced with the exact
            // interpreter wording when the expression is evaluated; adding a
            // second inference message here would only create duplicates.
            return;
        }
        this.diag(node, `cannot apply a function of type ${this.u.pretty(fType)} to an argument of type ${this.u.pretty(aType)}`);
    }

    /** int/float mixing is invisible to the interpreter (comparable/isNumeric allow it) — inference must report it. */
    private reportNumericMix(node: AstNode, err: UnifyError): boolean {
        const a = this.resolveBase(err.a);
        const b = this.resolveBase(err.b);
        if (a.kind === 'prim' && b.kind === 'prim' && isNumericPrim(a) && isNumericPrim(b) && a.name !== b.name) {
            this.diag(node, `cannot mix int and float (${a.name} vs ${b.name}) — write a literal of the matching type, e.g. ${a.name === 'int' ? '18' : '18.0'}`);
            return true;
        }
        return false;
    }

    /** Resolve through variable bindings and `maybe` wrappers to the base type. */
    private resolveBase(t: Type): Type {
        let r = this.u.peel(t);
        while (r.kind === 'maybe') r = this.u.peel(r.of);
        return r;
    }

    /** Builtin-specific argument diagnostics, aligned with the interpreter. */
    private argError(name: string | null, index: number, node: AstNode, argType: Type, param: Type | undefined, fType: Type | undefined): void {
        const p = (t: Type) => this.u.pretty(t);
        const ret = (t: Type): Type | null => {
            const r = this.u.peel(t);
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
            case 'group_by': {
                const r = ret(argType);
                if (r) this.diag(node, `group_by expects a projection record, got an expression of type ${p(r)}`);
                else this.diag(node, `group_by expects a one-parameter lambda, e.g. group_by (o => { id = group o.id })`);
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
                if (index === 0) this.diag(node, `join expects a join kind as its first argument: inner, left, right or full (a bare identifier, e.g. inner), got an expression of type ${p(argType)}`);
                else if (index === 1) this.diag(node, `join expects a query as its second argument, got an expression of type ${p(argType)} — bind a table or pipeline first, e.g. join inner orders (l => r => ...)`);
                else if (index === 2) this.diag(node, `join 'on' must be a two-argument function (curried), e.g. (l => r => l.id == r.user_id) or ($1.id == $2.user_id), got an expression of type ${p(argType)}`);
                else if (index === 3) this.diag(node, `join 'merger' must be a two-argument function (curried), e.g. (l => r => merge l r) or merge, got an expression of type ${p(argType)}`);
                else this.diag(node, `join takes exactly four arguments: a join kind, the right query, the 'on' function, and the merger function`);
                break;
            case 'over':
                this.diag(node, `over expects a window function (row_number, rank, sum, lag, ...), got ${p(argType)}`);
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

    /** Post-unification checks the scheme types don't capture (numeric, date, order, literals). */
    private postCheckArg(name: string, index: number, argExpr: Expr, argType: Type, node: AstNode): void {
        const r = this.u.peel(argType);
        if (DATE_VALUE_ARGUMENTS.has(name) && index === 0) {
            if (r.kind === 'prim' && r.name !== 'date' && r.name !== 'timestamp') {
                this.diag(node, `${name} expects a date or timestamp expression, got type ${this.u.pretty(argType)}`);
            }
            return;
        }
        if (name === 'date_add' && index === 2) {
            if (r.kind === 'prim' && !isNumericPrim(r)) {
                this.diag(node, `date_add expects a numeric amount, got type ${this.u.pretty(argType)}`);
            }
            return;
        }
        if (name === 'date_diff' && index === 2) {
            if (r.kind === 'prim' && r.name !== 'date' && r.name !== 'timestamp') {
                this.diag(node, `date_diff expects a date or timestamp expression, got type ${this.u.pretty(argType)}`);
            }
            return;
        }
        if ((name === 'sum' || name === 'avg' || name === 'abs'
            || name === 'ceil' || name === 'floor' || name === 'sqrt') && index === 0) {
            if (r.kind === 'prim' && !isNumericPrim(r)) {
                this.diag(node, `${name} expects a numeric expression, got type ${this.u.pretty(argType)}`);
            }
            return;
        }
        if ((name === 'sum_where' || name === 'avg_where') && index === 1) {
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
        if ((name === 'take' || name === 'drop') && index === 0) {
            const okLiteral = isNumberLiteral(argExpr) && Number.isInteger(argExpr.value) && argExpr.value >= 0;
            if (!okLiteral) this.diag(node, `${name} expects a non-negative integer literal`);
            return;
        }
        if (name === 'sort' && index === 0) {
            const rt = this.u.peel(argType);
            if (rt.kind === 'fun') {
                const ret = this.u.peel(rt.to);
                // A concrete return must already BE an order item or a list of
                // them; an unconstrained variable is skolemized so it cannot
                // silently bind to `order`/`[order]` — `sort (u => u.name)`
                // must fail here, not at runtime.
                const isOrder = ret.kind === 'order'
                    || (ret.kind === 'list' && this.u.peel(ret.of).kind === 'order');
                if (!isOrder && ret.kind !== 'var') {
                    this.diag(node, `sort expects order items like asc u.name or a list of them, got an expression of type ${this.u.pretty(ret)}`);
                } else if (ret.kind === 'var') {
                    const sk = this.u.skolemize(ret);
                    try {
                        try {
                            this.u.unify(ret, { kind: 'order' });
                        } catch {
                            try {
                                this.u.unify(ret, listOf({ kind: 'order' }));
                            } catch {
                                this.diag(node, `sort expects order items like asc u.name or a list of them, got an expression of type ${this.u.pretty(ret)}`);
                            }
                        }
                    } finally {
                        sk.restore();
                    }
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
        if (isTypeAtom(t)) {
            if (t.maybeType) return maybeOf(this.translateType(t.maybeType, rigid, names, rigidVars));
            if (t.base) return this.translateType(t.base, rigid, names, rigidVars);
            return this.u.fresh();
        }
        if (isTypeHole(t)) return this.typeHole(t.name);
        if (isFunType(t)) return fun(this.translateType(t.left, rigid, names, rigidVars), this.translateType(t.right, rigid, names, rigidVars));
        if (isListType(t)) return listOf(this.translateType(t.type, rigid, names, rigidVars));
        if (isRecordType(t)) {
            this.checkDuplicateTypeFields(t.fields, 'record type');
            const fields: [string, Type][] = t.fields.map(f => [labelName(f.key), this.translateType(f.type, rigid, names, rigidVars)]);
            const tail = t.tail ? this.typeTailVar(t.tail, rigid, names, rigidVars) : null;
            return rowOf(fields, tail);
        }
        if (isQueryType(t)) {
            this.checkDuplicateTypeFields(t.fields, 'query type');
            const fields: [string, Type][] = t.fields.map(f => [labelName(f.key), this.translateType(f.type, rigid, names, rigidVars)]);
            const tail = t.tail ? this.typeTailVar(t.tail, rigid, names, rigidVars) : null;
            return queryOf(rowOf(fields, tail));
        }
        if (isQualifiedTypeName(t)) {
            const ns = this.typeNamespaces.get(t.receiver);
            const alias = ns?.get(t.name);
            if (!alias) {
                this.diag(t, `unknown type '${t.receiver}.${t.name}'`);
                return this.u.fresh();
            }
            return this.translateType(alias, rigid, names, rigidVars);
        }
        if (isTypeVar(t)) {
            const name = t.name;
            if (isPrimName(name)) return prim(name);
            const alias = this.typeAliases.get(name);
            if (alias) {
                if (this.activeTypeAliases.has(name)) {
                    this.diag(t, `recursive type alias '${name}'`);
                    return this.u.fresh();
                }
                this.activeTypeAliases.add(name);
                try {
                    return this.translateType(alias, rigid, names, rigidVars);
                } finally {
                    this.activeTypeAliases.delete(name);
                }
            }
            if (!/^[a-z]/.test(name)) {
                this.diag(t, `unknown type '${name}'`);
                return this.u.fresh();
            }
            return this.typeOrRowVar(name, 'type', rigid, names, rigidVars);
        }
        return this.u.fresh();
    }

    /** `null` parses as a zero-argument Application wrapping NullLiteral. */
    private isNullLiteralNode(node: AstNode | undefined): boolean {
        let cur: AstNode | undefined = node;
        while (cur && isApplication(cur) && cur.arguments.length === 0) cur = cur.func;
        return isNullLiteral(cur);
    }

    /**
     * `{ id, name }` inside a lambda body is sugar for
     * `{ id = u.id, name = u.name }` where `u` is the lambda parameter.
     */
    private inferFieldPun(entry: MapEntry, env: Map<string, Scheme>): Type {
        const key = labelName(entry.key);
        const lambda = this.enclosingLambda(entry);
        const paramName = lambda?.param?.name;
        if (!paramName) {
            this.diag(entry, `field pun '${key}' requires an enclosing lambda parameter, e.g. map (u => { ${key} })`);
            return this.u.fresh();
        }
        const source = env.get(paramName)?.type;
        if (!source) {
            this.diag(entry, `field pun '${key}' cannot find lambda parameter '${paramName}'`);
            return this.u.fresh();
        }
        const r = this.u.peel(source);
        if (r.kind !== 'row' && r.kind !== 'var') {
            this.diag(entry, `field pun '${key}' expects a row parameter, got type ${this.u.pretty(source)}`);
            return this.u.fresh();
        }
        const field = this.u.fieldOf(source, key);
        return field?.type ?? this.u.fresh();
    }

    private enclosingLambda(node: AstNode): Lambda | null {
        let cur: AstNode | undefined = node;
        let child: AstNode | undefined;
        while (cur) {
            const parent: AstNode | undefined = cur.$container;
            if (parent && isLambda(parent) && (parent.body as unknown as AstNode) === cur) return parent;
            child = cur;
            cur = parent;
        }
        return null;
    }

    /** Duplicate labels in a record/query type collapse silently in a Map — diagnose them. */
    private checkDuplicateTypeFields(fields: readonly { key: string }[], what: string): void {
        const seen = new Set<string>();
        for (const field of fields) {
            const key = labelName(field.key);
            if (seen.has(key)) {
                this.diag(field as unknown as AstNode, `duplicate field '${key}' in ${what}`);
            }
            seen.add(key);
        }
    }

    /** A lowercase type name is a variable; the same name reuses the same var within one annotation. */
    private typeOrRowVar(name: string, kind: VarKind, rigid: boolean, names: Map<string, Type>, rigidVars: number[]): Type {
        const key = `${kind}:${name}`;
        const existing = names.get(key);
        if (existing) return existing;
        const fresh = this.u.fresh(kind === 'row' ? 'row' : 'flex', name);
        if (fresh.kind === 'var' && rigid) {
            this.u.setVarRigid(fresh.id, true);
            rigidVars.push(fresh.id);
        }
        names.set(key, fresh);
        return fresh;
    }

    /** `?name` in a row-tail position is a row hole; elsewhere it is a type hole. */
    private typeTailVar(name: string, rigid: boolean, names: Map<string, Type>, rigidVars: number[]): Type {
        if (name.startsWith('?')) {
            const key = `row-hole:${name}`;
            const existing = names.get(key);
            if (existing) return existing;
            const hole = this.u.freshHole('row', name.slice(1));
            names.set(key, hole);
            return hole;
        }
        return this.typeOrRowVar(name, 'row', rigid, names, rigidVars);
    }

    /** A non-tail `?name` annotation: a named type hole shared within the annotation. */
    private typeHole(name: string): Type {
        return this.u.freshHole('flex', name);
    }

    /** Rendered, resolved type text of a recorded node (friendly var names for hover). */
    typeOf(node: AstNode): string | undefined {
        const t = this.nodeTypes.get(node);
        return t ? this.u.pretty(this.u.peel(t), true, true) : undefined;
    }

    /** Row fields (sorted) of a recorded node's type, unwrapping `maybe` wrappers. */
    fieldsOf(node: AstNode): { name: string; type: string }[] | undefined {
        const t = this.nodeTypes.get(node);
        if (!t) return undefined;
        let r = this.u.peel(t);
        while (r.kind === 'maybe') r = this.u.peel(r.of);
        if (r.kind !== 'row') return undefined;
        return this.u.rowLabels(r).map(name => {
            const field = this.u.lookupField(r, name);
            return { name, type: field ? this.u.pretty(this.u.peel(field.type), true, true) : '?' };
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
export function inferProject(modules: readonly ProjectModule[], importsByModule: ReadonlyMap<ProjectModule, readonly ResolvedImportEdge[]> = new Map()): InferProjectResult {
    const inferencer = new Inferencer();
    inferencer.inferProject(modules, importsByModule);
    return {
        diagnostics: inferencer.diagnostics,
        nodeTypes: inferencer.nodeTypes,
        typeOf: node => inferencer.typeOf(node),
        fieldsOf: node => inferencer.fieldsOf(node),
    };
}

/** Infer a single module (no imports). */
export function infer(model: Model): { diagnostics: InferDiagnostic[] } {
    return inferProject([{ model, uri: undefined, imports: [] }], new Map());
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
    modules: readonly ProjectModule[],
    ...lists: readonly (readonly T[])[]
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