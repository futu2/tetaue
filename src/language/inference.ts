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
 * generalized. Numeric polymorphism carries a `Num` constraint through
 * generalization and instantiation. See docs/design/type-system.md.
 ******************************************************************************/
import type { AstNode } from 'langium';
import {
    isAccessExpression, isAscription, isApplication, isBinaryExpression,
    isBooleanLiteral, isCaseExpression, isFunType, isIdentifier, isLambda,
    isLetExpression, isListLiteral, isListType,
    isMapLiteral, isNullLiteral, isOperatorSection,
    isNumberLiteral, isQueryType, isRecordType, isStringLiteral, isTypeAtom, isTypeHole, isTypeParen,
    isConstrainedType, isTypeVar, isUnaryMinus,
    type Binding, type CaseExpression, type Expr, type Lambda, type MapEntry, type Model,
} from './generated/ast.js';
import type { Type as LangiumType } from './generated/ast.js';
import {
    ConstraintError, TypeUniverse, UnifyError, type Scheme, type Type, type VarKind,
    builtinOf, fun, isTypeClassInstance, listOf, maybeOf, modeOf, modePayload, nullExtendedMaybeOf, prim, queryOf, rowOf, truthType,
    type ScalarTypeClass, type TypeClass,
} from './types.js';
import type { NumberLiteral, UnaryExpression } from './generated/ast.js';
import type { ProjectModule, ResolvedExportEdge, ResolvedImportEdge } from './imports.js';
import { PRELUDE_NAMESPACES } from './prelude-namespaces.js';
import { moduleOf } from './imports.js';
import { resolveImportScope } from './project-scope.js';
import { checkBinding, missingBindingExpressionMessage, parseStringLiteral, recursiveBindingMessage, topoOrderBindings } from './interpreter.js';
import type { Diagnostic, Value } from './interpreter.js';
import { implicitParamName, labelName } from './strings.js';
import { BUILTIN_ALIASES, BUILTIN_SPECS } from './catalog.js';
import { CAST_TYPES, LIST_ARITY, CORE_TYPE_NAMES, type CoreTypeName } from './builtin.js';
import {
    INTRINSIC_OPERATORS, isBinaryOperator, isIntrinsicOperator, operatorIntrinsicName,
    sectionName, sectionSpelling, type BinaryOperator, type IntrinsicOperator,
} from './operators.js';

export interface InferDiagnostic {
    node: AstNode | undefined;
    message: string;
}

/** Builtins whose application takes ALL arguments at once (no currying). */
const LIST_BUILTINS = new Set(['concat', 'greatest', 'least']);

const JOIN_BUILTINS = {
    joinInner: 'inner',
    joinLeft: 'left',
    joinRight: 'right',
    joinFull: 'full',
} as const;
type JoinBuiltinName = keyof typeof JOIN_BUILTINS;
type JoinKindName = (typeof JOIN_BUILTINS)[JoinBuiltinName];

function isJoinBuiltinName(name: string | null): name is JoinBuiltinName {
    return name !== null && Object.hasOwn(JOIN_BUILTINS, name);
}

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

const PRIM_NAMES = CORE_TYPE_NAMES;
type PrimName = CoreTypeName;

/** Synthetic access inserted by completion; it must not constrain the receiver row. */
const SYNTHETIC_FIELD_PREFIX = '_tetaue_field';

function primitiveName(name: string): PrimName | null {
    return (PRIM_NAMES as readonly string[]).includes(name) ? name as PrimName : null;
}

/** A literal is `float` iff its source text contains '.', so `100.0` is float. */
function numberLiteralType(e: NumberLiteral): 'int' | 'float' {
    return e.$cstNode?.text.includes('.') ? 'float' : 'int';
}

/**
 * A numeric literal is polymorphic, like Haskell's `fromIntegral`: an integer
 * literal (`1`) is `Num t => t` (int | float | decimal), and a decimal-point
 * literal (`1.5`) is `Frac t => t` (float | decimal). The literal adapts to
 * whatever numeric type the surrounding expression forces, so `sum ($ 1 +
 * r.total)` works whether `total` is int, float, or decimal — while `int` and
 * `float` still never mix on values. Unconstrained literals default at
 * generalization (`x = 1 : int`, `x = 1.5 : float`); annotate to pin them.
 */
function numericLiteralScheme(u: TypeUniverse, e: NumberLiteral): Type {
    const cls: ScalarTypeClass = e.$cstNode?.text.includes('.') ? 'Frac' : 'Num';
    return u.fresh('type', null, [cls]);
}

function isNumericPrim(t: Type): boolean {
    return t.kind === 'prim' && isTypeClassInstance('Num', t.name);
}

/**
 * A binding whose whole value is a bare `mempty` reference (still the prelude
 * builtin, not shadowed). Its annotation DEFINES the monoid instance instead
 * of being checked against an inferred one — same convention as a bare
 * `table`'s schema annotation. The grammar wraps a bare identifier in a
 * zero-argument Application, so unwrap those first.
 */
function isBareMempty(v: Expr): boolean {
    let cur: Expr = v;
    while (isApplication(cur) && cur.arguments.length === 0) cur = cur.func;
    return isIdentifier(cur) && cur.name === 'mempty';
}

/** The set-operation primitives whose SQL form needs known schemas. */
const SET_OP_BUILTINS: ReadonlySet<string> = new Set(['union', 'union_all', 'intersect', 'except']);

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
     * The prelude's built-in namespaces (currently just `list.*`), seeded in
     * `prelude()` and cloned into every module as the starting `modules` map
     * (so prelude namespaces are always in scope, like the flat prelude).
     */
    preludeNamespaces = new Map<string, Map<string, Scheme>>();
    /**
     * Namespace aliases of the CURRENT module (`import "x.tetaue" as t`):
     * alias -> the target module's exported binding schemes. Qualified access
     * `t.binding` instantiates the exported scheme (row polymorphism is
     * preserved through a namespace). Reset per module.
     */
    modules = new Map<string, Map<string, Scheme>>();
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

    /**
     * `mempty` uses whose instance is decided by later unification (an
     * ascription, a `<>` operand, a concat/greatest argument, ...). Checked
     * in flushDeferred once the surrounding constraints have bound the type.
     */
    private pendingMempty: { node: AstNode; type: Type; application: import('./generated/ast.js').Application }[] = [];
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
        // `mempty` instance resolution: the use site has unified the type by
        // now (annotation, `<>` operand, list-argument element check, ...).
        for (const use of this.pendingMempty) {
            this.checkMemptyResolved(use);
        }
        this.pendingMempty = [];
    }

    /** Validate one resolved `mempty` use against the closed Monoid instances. */
    private checkMemptyResolved(use: { node: AstNode; type: Type; application: import('./generated/ast.js').Application }): void {
        const r = this.u.peel(use.type);
        const ok = r.kind === 'prim' && r.name === 'string'
            || r.kind === 'list'
            || (r.kind === 'row' && this.u.resolveRow(r).tail === null)
            || r.kind === 'var'; // still unsolved (hole/signature) — other checks own it
        if (ok) return;
        this.diag(use.node, `mempty has no instance for ${this.u.pretty(use.type, true)} — the closed Monoid instances are string, [a], and records (annotate the use site, e.g. (mempty : [int]))`);
    }

    /** True when `name` in `env` is still the prelude scheme, not a local/import shadow. */
    private isPreludeBuiltin(name: string, env: Map<string, Scheme>): boolean {
        const scheme = env.get(name);
        return scheme !== undefined && scheme === this.preludeEnv.get(name);
    }

    /** Whether the application is the prelude `mempty` builtin (no shadowing). */
    private isMemptyApplication(e: import('./generated/ast.js').Application, env: Map<string, Scheme>): boolean {
        return isIdentifier(e.func)
            && e.func.name === 'mempty'
            && this.isPreludeBuiltin('mempty', env);
    }

    // -----------------------------------------------------------------------
    // Prelude
    // -----------------------------------------------------------------------

    /**
     * Build the primitive environment from the builtin catalog plus the hidden
     * operator intrinsics consumed by `prelude.tetaue`. Aggregates return
     * `agg t`, `group` returns `group t`, and the list-argument builtins take
     * one list argument, so plain fold entries and non-order sort lambdas are
     * STATIC type errors, not runtime checks.
     */
    prelude(dialect?: import('./interpreter.js').DialectView): void {
        for (const spec of BUILTIN_SPECS) {
            const scheme = spec.scheme(this.u);
            const tagged = { ...scheme, type: builtinOf(spec.name, scheme.type) };
            this.env.set(spec.name, tagged);
        }
        for (const [name, target] of Object.entries(BUILTIN_ALIASES)) {
            const scheme = this.env.get(target);
            if (scheme) {
                const tagged = { ...scheme, type: builtinOf(name, this.u.peel(scheme.type)) };
                this.env.set(name, tagged);
            }
        }
        for (const operator of INTRINSIC_OPERATORS) {
            const type = this.operatorIntrinsicType(operator);
            const scheme = this.u.generalize([], type);
            this.env.set(operatorIntrinsicName(operator), {
                ...scheme,
                type: builtinOf(`operator:${operator}`, type),
            });
        }
        // The first-class `sql_dialect` value: a record `{ name: string,
        // functions: { canonical: sqlName } }` the prelude branches on. The
        // scheme mirrors the seeded interpreter value exactly.
        const view = dialect ?? { name: 'sqlite', functions: {} };
        const functionFields: [string, Type][] = [];
        for (const canonical of Object.keys(view.functions)) {
            functionFields.push([canonical, prim('string')]);
        }
        const sqlDialectType = rowOf([
            ['name', prim('string')],
            ['functions', rowOf(functionFields)],
        ]);
        this.env.set('sql_dialect', {
            vars: [],
            type: builtinOf('sql_dialect', sqlDialectType),
        });
        // The primitive environment is cloned into every module (see beginModule).
        this.preludeEnv = new Map(this.env);
        // The built-in prelude namespaces (`list.*`, `maybe.*`): maps of each
        // pure combinator's scheme, so `list.map` / `maybe.isJust` resolve
        // like a qualified import (see beginModule, which starts each module
        // from the prelude namespaces).
        this.preludeNamespaces = new Map<string, Map<string, Scheme>>();
        for (const [alias, namespace] of Object.entries(PRELUDE_NAMESPACES)) {
            const schemes = new Map<string, Scheme>();
            for (const [publicName, builtinName] of Object.entries(namespace)) {
                const scheme = this.env.get(builtinName);
                if (scheme) schemes.set(publicName, scheme);
            }
            this.preludeNamespaces.set(alias, schemes);
        }
    }

    /** Static shape of a hidden SQL-aware operator primitive. */
    private operatorIntrinsicType(op: IntrinsicOperator): Type {
        const a = this.u.fresh();
        const b = this.u.fresh();
        const c = this.u.fresh();
        switch (op) {
            case '&&': case '||':
                return fun(prim('bool'), fun(prim('bool'), prim('bool')));
            case '==': case '!=':
                this.u.constrain(a, 'Eq');
                return fun(a, fun(a, prim('bool')));
            case '<': case '<=': case '>': case '>=':
                this.u.constrain(a, 'Ord');
                return fun(a, fun(a, prim('bool')));
            case '/': return fun(prim('float'), fun(prim('float'), prim('float')));
            case '<>': return fun(a, fun(b, c));
            case '+': case '-': case '*':
                this.u.constrain(a, 'Num');
                return fun(a, fun(a, a));
        }
    }

    /** Core type of infix syntax before a source-defined `_op_` binding exists. */
    private fallbackOperatorType(op: IntrinsicOperator): Type {
        return builtinOf(`operator:${op}`, this.operatorIntrinsicType(op));
    }

    private taggedOperator(type: Type): BinaryOperator | null {
        if (type.kind !== 'builtin' || !type.name.startsWith('operator:')) return null;
        const operator = type.name.slice('operator:'.length);
        return isBinaryOperator(operator) ? operator : null;
    }

    /** Preserve the core function behind an ordinary source-level alias. */
    private taggedBuiltin(type: Type): string | null {
        const resolved = this.u.resolve(type);
        return resolved.kind === 'builtin' ? resolved.name : null;
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
    inferProject(
        modules: readonly ProjectModule[],
        importsByModule: ReadonlyMap<ProjectModule, readonly ResolvedImportEdge[]> = new Map(),
        prelude?: ProjectModule,
        reexportsByModule: ReadonlyMap<ProjectModule, readonly ResolvedExportEdge[]> = new Map(),
    ): void {
        this.prelude();
        const exportsByModule = new Map<ProjectModule, Map<string, Scheme>>();
        const allModules = prelude ? [prelude, ...modules] : [...modules];
        for (const module of allModules) {
            const exported = this.inferModule(
                module,
                importsByModule.get(module) ?? module.imports ?? [],
                exportsByModule,
                reexportsByModule.get(module) ?? module.exports ?? [],
            );
            exportsByModule.set(module, exported);
            if (module === prelude) {
                this.preludeEnv = new Map([...this.preludeEnv, ...exported]);
            }
        }
        this.flushDeferred();
    }

    /**
     * Prepare this inferencer for one module without walking its bindings:
     * clone the prelude and resolve import scopes (flat and namespaced
     * schemes). Returns the shared scope map used by the per-binding typed
     * pass in `checker.ts`.
     *
     * `inferModule` remains a convenience wrapper around
     * `beginModule` + `inferBinding` for standalone `types`/test callers.
     */
    beginModule(
        module: ProjectModule,
        imports: readonly ResolvedImportEdge[],
        exportsByModule: ReadonlyMap<ProjectModule, ReadonlyMap<string, Scheme>>,
    ): { scope: ReadonlyMap<string, string> } {
        this.env = new Map(this.preludeEnv);
        this.modules = new Map([...this.preludeNamespaces].map(([alias, ns]) => [alias, new Map(ns)]));
        const imported = resolveImportScope(module, imports, exportsByModule);
        for (const d of imported.diagnostics) this.diag(d.node, d.message);
        for (const [name, scheme] of imported.flat) this.env.set(name, scheme);
        for (const [alias, selected] of imported.namespaces) this.modules.set(alias, new Map(selected));
        const scope = new Map(imported.scope);
        return { scope };
    }

    /**
     * Infer one module in an already-prepared environment. Reads import
     * scopes from `exportsByModule` (previous modules) and returns the
     * module's exported binding schemes. Callers update the project export
     * map after the module is processed.
     */
    inferModule(
        module: ProjectModule,
        imports: readonly ResolvedImportEdge[],
        exportsByModule: ReadonlyMap<ProjectModule, ReadonlyMap<string, Scheme>>,
        reexports: readonly ResolvedExportEdge[] = [],
    ): Map<string, Scheme> {
        const { scope } = this.beginModule(module, imports, exportsByModule);
        const exported = new Map<string, Scheme>();
        // Top-down resolution mirrors the interpreter: bindings are inferred
        // in dependency order (source order as tiebreak) so a definition may
        // reference any other binding in the module. Cycle members are
        // inferred last in source order (their recursion is diagnosed once
        // here; the interpreter reports the same message for dedupe).
        const { order, cycles } = topoOrderBindings(module.model.bindings);
        for (const binding of order) {
            this.inferBinding(binding, exported, scope);
        }
        for (const binding of cycles) {
            this.diag(binding, recursiveBindingMessage(binding.name));
            this.inferBinding(binding, exported, scope);
        }
        // --- re-exports: `export * from "x"` / `export { a as b } from "x"` ---
        // Mirror the interpreter's merge (same wording) so diagnostics dedupe.
        for (const { target, exportNode } of reexports) {
            const targetExports = exportsByModule.get(target);
            if (!targetExports) continue; // cyclic/missing target — already diagnosed
            const spec = parseStringLiteral(exportNode.path);
            const names = exportNode.names.length === 0
                ? [...targetExports.keys()].map(name => ({ name, renamed: undefined as string | undefined }))
                : exportNode.names.map(item => ({ name: item.name, renamed: item.renamed }));
            for (const { name, renamed } of names) {
                const scheme = targetExports.get(name);
                if (scheme === undefined) {
                    const keys = [...targetExports.keys()];
                    this.diag(exportNode, `'${name}' is not exported by '${spec}' — exported: ${keys.length > 0 ? keys.join(', ') : '(none)'}`);
                    continue;
                }
                const localName = renamed ?? name;
                if (exported.has(localName)) {
                    this.diag(exportNode, `re-exported name '${localName}' (from '${spec}') conflicts with an already exported name`);
                    continue;
                }
                exported.set(localName, scheme);
            }
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
        if (!b.value) {
            this.diag(b, missingBindingExpressionMessage(b.name));
            return;
        }
        // A binding annotation supplies an unannotated lambda's parameter
        // type: `f: string -> string = x => x` types the body against
        // `string` (bidirectional), the same way an explicit `(x: string)`
        // parameter annotation does.
        let inferred: Type;
        const bindingValue = b.value as Expr;
        // A lambda value parses as an empty Application wrapping the Lambda
        // (`x => x` -> Application(func=Lambda, args=[])); unwrap it.
        const valueCore = this.unwrapApplicationExpr(bindingValue);
        if (b.type && valueCore && isLambda(valueCore) && !valueCore.param?.type) {
            const annDomain = this.translateType(b.type);
            const domain = annDomain.kind === 'fun' ? annDomain.from : undefined;
            const codomain = annDomain.kind === 'fun' ? annDomain.to : undefined;
            inferred = domain
                ? this.inferLambda(valueCore, this.env, domain, codomain)
                : this.inferExpr(bindingValue, this.env);
        } else {
            inferred = this.inferExpr(bindingValue, this.env);
        }
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
                && v.func.name === 'table'
                && v.arguments.length === 1
                && this.isPreludeBuiltin(v.func.name, this.env);
            let ok = true;
            if (isBareTable) {
                try {
                    this.u.unify(ann, inferred);
                } catch (err) {
                    if (!(err instanceof UnifyError)) throw err;
                    ok = false;
                }
            } else if (isBareMempty(v)) {
                // `x: [int] = mempty` — the annotation DEFINES the instance
                // (the identity is unconstrained on its own). Same rule as a
                // bare table's schema annotation — but the annotation must be
                // one of the closed Monoid instances (string, list, record).
                try {
                    this.u.unify(ann, inferred);
                } catch (err) {
                    if (!(err instanceof UnifyError)) throw err;
                }
                const r = this.u.peel(ann);
                const monoid = r.kind === 'prim' && r.name === 'string'
                    || r.kind === 'list'
                    || r.kind === 'row';
                if (!monoid) {
                    this.diag(b, `mempty has no instance for ${this.u.pretty(ann, true)} — the closed Monoid instances are string, [a], and records`);
                }
                ok = true;
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
        topoCycleNames: ReadonlySet<string> = new Set(),
    ): { env: Map<string, Value>; seen: Set<string>; value: Value; diagnostics: Diagnostic[] } {
        const diagnostics: Diagnostic[] = [];
        if (scope.has(b.name)) {
            diagnostics.push({
                node: b,
                message: `name '${b.name}' (a local binding) conflicts with ${scope.get(b.name)!}`,
            });
        }

        // Recursive cycles are diagnosed once per cycle member here; the
        // interpreter reports the same message (exact-deduped on merge).
        // Duplicate names are handled by `seen` inside checkBinding, so this
        // runs only for the recursion case (topoOrderBindings keeps cycles
        // out of the main order).
        if (topoCycleNames.has(b.name)) {
            diagnostics.push({ node: b, message: recursiveBindingMessage(b.name) });
        }

        // Type first against the ORIGINAL imported scope; the runtime
        // diagnostic above is authoritative, so inference only installs the
        // binding scheme and resolves namespace shadowing.
        const inferenceStart = this.diagnostics.length;
        this.inferBinding(b, exported, scope, false);
        diagnostics.push(...this.takeDiagnosticsFrom(inferenceStart));
        scope.set(b.name, `local binding '${b.name}'`);

        const result = checkBinding(b, valueEnv, moduleBindings, seen, {
            ...(nodeValues ? { nodeValues } : {}),
        });
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
                if (!(err instanceof UnifyError)) throw err;
                // An ascription ON `mempty` picks the instance (`mempty :
                // [int]`); when the annotation cannot match a monoid, point
                // at the instance problem instead of a bare unify mismatch.
                if (isApplication(e.operand) && this.isMemptyApplication(e.operand, env)) {
                    this.diag(e, `mempty has no instance for ${this.u.pretty(ann, true)} — the closed Monoid instances are string, [a], and records`);
                    return ann;
                }
                this.diag(e, `annotation type ${this.u.pretty(ann)} does not match inferred type ${this.u.pretty(operand)}`);
            }
            return operand;
        }
        if (isLetExpression(e)) {
            // `let x = value in body` is a pure lexical binding. Like a
            // top-level binding, the declared type becomes the local type once
            // the signature check passes, and the local is let-polymorphic.
            const inferred = this.inferExpr(e.value as Expr, env);
            let bound = inferred;
            if (e.type) {
                const ann = this.translateType(e.type);
                const value = e.value as Expr;
                const isBareTable = isApplication(value) && isIdentifier(value.func)
                    && value.func.name === 'table'
                    && value.arguments.length === 1
                    && this.isPreludeBuiltin(value.func.name, env);
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
            try {
                this.u.constrain(t, 'Num');
            } catch (err) {
                if (!(err instanceof ConstraintError)) throw err;
                this.diag(e, `unary '-' requires a numeric expression, got ${this.u.pretty(t)}`);
            }
            return t;
        }
        if (isBinaryExpression(e)) return this.inferBinary(e as unknown as import('./generated/ast.js').BinaryExpression, env);
        if (isAccessExpression(e)) return this.inferAccess(e, env);
        if (isApplication(e)) return this.inferApplication(e, env);
        if (isNumberLiteral(e)) return numericLiteralScheme(this.u, e);
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
        if (isOperatorSection(e)) return this.inferOperatorSection(e, env);
        if (isIdentifier(e)) {
            const scheme = env.get(e.name);
            if (scheme) return this.u.instantiate(scheme);
            // `this`/`that` sugar for the first two implicit lambda parameters.
            const dollar = implicitParamName(e.name);
            const param = dollar && env.get(dollar);
            return param ? this.u.instantiate(param) : this.u.fresh(); // unknown ids are the interpreter's call
        }
        return this.u.fresh();
    }

    /** An application argument: `this`/`that` expressions become implicit lambdas. */
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

    private inferLambda(e: import('./generated/ast.js').Lambda, env: Map<string, Scheme>, expectedParam?: Type, expectedResult?: Type): Type {
        const p = e.param!;
        const newEnv = new Map(env);
        const rigidVars: number[] = [];
        let paramType: Type;
        if (p.type) {
            paramType = this.translateType(p.type, true, new Map(), rigidVars); // annotation vars are rigid inside the body
        } else if (expectedParam) {
            // A binding annotation supplies the lambda's parameter type
            // (`f: string -> string = x => x` types the body against
            // `string`). Rigidify its variables so the body cannot extend an
            // open row beyond what the annotation declares, then release them
            // at the use site (the annotation still generalizes).
            paramType = expectedParam;
            for (const id of this.u.freeVars(paramType)) {
                rigidVars.push(id);
                this.u.setVarRigid(id, true);
            }
        } else {
            paramType = this.u.fresh('flex');
        }
        newEnv.set(p.name ?? '', { vars: [], type: paramType });
        // A curried body (`x => y => ...`) is another lambda: descend into it
        // with the NEXT annotation domain/codomain so every parameter is typed
        // against the signature, not just the outer one.
        const bodyCore = this.unwrapApplicationExpr(e.body as unknown as AstNode);
        let body: Type;
        if (expectedResult && expectedResult.kind === 'fun' && bodyCore && isLambda(bodyCore)) {
            body = this.inferLambda(bodyCore, newEnv, expectedResult.from, expectedResult.to);
        } else {
            body = this.inferExpr(e.body as unknown as UnaryExpression, newEnv);
            // The binding annotation's codomain is also a signature: bind the
            // body's fresh result (e.g. a `sql_func` call's open type) to the
            // declared result, so `f: string -> int = x => sql_func "LENGTH" [x]`
            // types the call as int.
            if (expectedResult !== undefined) {
                try {
                    this.u.unify(body, expectedResult);
                } catch (err) {
                    if (!(err instanceof UnifyError)) throw err;
                }
            }
        }
        // Release the rigidity of annotated params: the body must only use the
        // annotated fields, but at USE the row must still absorb extra fields.
        for (const id of rigidVars) this.u.setVarRigid(id, false);
        return fun(paramType, body);
    }

    /** Add SQL outer-join nullability without nesting an existing Maybe. */
    private nullExtend(t: Type): Type {
        return this.u.peel(t).kind === 'maybe' ? t : nullExtendedMaybeOf(t);
    }

    /**
     * Infer a curried two-argument function against known left/right parameter
     * types (join merger, `on`, and any higher-order step argument reached
     * through a bound/partially-applied value). Checking the argument against
     * the expected parameters — instead of inferring it as a fresh row and
     * unifying afterwards — lets field access through a null-extended
     * `(maybe r)` row retain Maybe in the projected result. This is what keeps
     * first-class outer-join steps (e.g. `step = joinLeft orders`) well-typed:
     * their type is a plain function value, so the generic application path
     * checks it here rather than losing the `maybe` the scheme bakes in.
     */
    private inferCheckedTwoArg(e: Expr, env: Map<string, Scheme>, left: Type, right: Type): Type {
        const outer = this.unwrapApplicationExpr(e);
        if (outer && isLambda(outer)) {
            const inner = this.unwrapApplicationExpr(outer.body as unknown as AstNode);
            if (inner && isLambda(inner)) {
                const outerEnv = new Map(env);
                const outerRigid: number[] = [];
                const outerParam = outer.param!.type
                    ? this.translateType(outer.param!.type, true, new Map(), outerRigid)
                    : left;
                outerEnv.set(outer.param!.name ?? '', { vars: [], type: outerParam });

                const innerEnv = new Map(outerEnv);
                const innerRigid: number[] = [];
                const innerParam = inner.param!.type
                    ? this.translateType(inner.param!.type, true, new Map(), innerRigid)
                    : right;
                innerEnv.set(inner.param!.name ?? '', { vars: [], type: innerParam });

                const body = this.inferExpr(inner.body as unknown as UnaryExpression, innerEnv);
                for (const id of [...outerRigid, ...innerRigid]) this.u.setVarRigid(id, false);

                const innerType = fun(innerParam, body);
                const outerType = fun(outerParam, innerType);
                this.nodeTypes.set(inner, innerType);
                this.nodeTypes.set(outer, outerType);
                return outerType;
            }
        }

        const arity = this.dollarArity(e, env);
        if (arity > 0) {
            const contextualEnv = new Map(env);
            const params: Type[] = [];
            for (let i = 1; i <= arity; i++) {
                const param = i === 1 ? left : i === 2 ? right : this.u.fresh('flex');
                contextualEnv.set(`$${i}`, { vars: [], type: param });
                params.push(param);
            }
            const body = this.inferExpr(e, contextualEnv);
            return params.reduceRight((acc, param) => fun(param, acc), body);
        }

        return this.inferArg(e, env);
    }

    /**
     * Fallback for the generic application loop: when blindly unifying a
     * higher-order argument fails (transactional `unify` has already rolled
     * back), if the expected parameter is a curried function `f => g => rest`,
     * re-check the argument against the two expected parameter types. This is
     * what lets bound/partially-applied outer-join steps (`step = joinLeft r`,
     * `step = joinRight r`) type-check: the null-extended side of the scheme is
     * `maybe row`, which a freshly-inferred lambda's open-row parameters cannot
     * unify with. Returns null when there is nothing useful to check (the
     * argument is not a function argument we can re-check).
     */
    private tryFetchCheckedArgType(param: Type, e: Expr, env: Map<string, Scheme>): Type | null {
        const p = this.u.peel(param);
        if (p.kind !== 'fun') return null;
        const pr = this.u.peel(p.to);
        if (pr.kind !== 'fun') return null;
        const checked = this.inferCheckedTwoArg(e, env, p.from, pr.from);
        // A `merge` merger keeps the union-row semantics: compute the merged
        // row directly (right side wins on overlap, and outer-join nullability
        // flows through), so a bound outer-join step used with `merge` still
        // yields a precise output type instead of an unconstrained row.
        if (checked.kind === 'builtin' && checked.name === 'merge') {
            const row = this.inferMerge(p.from, pr.from, e);
            return fun(p.from, fun(pr.from, row));
        }
        return checked;
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
        const nullExtended = r.kind === 'maybe';
        const fieldReceiver = nullExtended ? r.of : recv;
        const receiverRow = this.u.peel(fieldReceiver);
        if (receiverRow.kind === 'query') {
            this.diag(e, `tables have no fields — access columns through a row parameter inside a lambda, e.g. map (u => u.${property})`);
            return this.u.fresh();
        }
        // Completion inserts `u._tetaue_field` into a mid-typing document; it
        // is a probe, not a real column, and must not pin `u`'s row.
        if (property.startsWith(SYNTHETIC_FIELD_PREFIX)) return this.u.fresh();
        let field;
        try {
            // Use the peeled row: the receiver may be a builtin-tagged record
            // (e.g. `sql_dialect`), whose `of` is the row the fields live in.
            field = this.u.fieldOf(receiverRow, property);
        } catch (err) {
            if (!(err instanceof UnifyError)) throw err;
            field = null; // e.g. extending a rigid (annotated) row tail
        }
        if (!field) {
            const labels = receiverRow.kind === 'row' ? this.u.rowLabels(receiverRow) : [];
            this.diag(e, `unknown column '${property}'${labels.length > 0 ? ` — available: ${labels.join(', ')}` : ''}`);
            return this.u.fresh();
        }
        return nullExtended ? this.nullExtend(field.type) : field.type;
    }

    private inferBinary(e: import('./generated/ast.js').BinaryExpression, env: Map<string, Scheme>): Type {
        const op = e.operator as BinaryOperator;
        const lt = this.inferExpr(e.left, env);
        const rt = this.inferExpr(e.right, env);
        const scheme = env.get(sectionSpelling(op));
        const operator = scheme
            ? this.u.instantiate(scheme)
            : isIntrinsicOperator(op)
                ? this.fallbackOperatorType(op)
                : null;
        if (!operator) {
            this.diag(e, `operator '${op}' is not defined`);
            return this.u.fresh();
        }
        const intrinsic = this.taggedOperator(operator);
        if (intrinsic) {
            return this.inferBinaryTypes(intrinsic, lt, rt, e, e.left, e.right);
        }
        const closed = this.taggedBuiltin(operator);
        switch (closed) {
            case 'fmap': return this.inferFmapTypes(lt, rt, e.left, e.right);
            case 'replaceWith': return this.inferReplaceTypes(lt, rt, e.left, e.right);
            case 'ap': return this.inferApTypes(lt, rt, e.left, e.right);
            case 'applyLeft': return this.inferSequenceTypes(lt, rt, e.left, e.right, 'applyLeft', 'left');
            case 'applyRight': return this.inferSequenceTypes(lt, rt, e.left, e.right, 'applyRight', 'right');
            case 'orElse': return this.inferOrElseTypes(lt, rt, e.left, e.right);
            case 'bind': return this.inferBindTypes(lt, rt, e.left, e.right);
            case 'then': return this.inferSequenceTypes(lt, rt, e.left, e.right, 'then', 'right');
        }
        const partial = this.applyInferredFunction(operator, lt, e.left, null);
        return this.applyInferredFunction(partial, rt, e.right, null);
    }

    /**
     * Reject arithmetic on nullable (`maybe`) operands. With polymorphic
     * literals an integer literal now unifies as a variable with a `maybe`
     * column, which would otherwise silently allow `r.id + 1` on a nullable
     * LEFT-JOIN side and render `b.id + 1` (NULL arithmetic). Explicitly
     * guard so nullable columns must be unwrapped (from_maybe / coalesce).
     */
    private rejectModeOperand(node: AstNode, op: string, lt: Type, rt: Type): boolean {
        const kind = (t: Type): string => this.u.peel(t).kind;
        const ka = kind(lt);
        const kb = kind(rt);
        if (ka === 'maybe' || kb === 'maybe') {
            this.diag(node, `'${op}' requires non-null numeric operands — use from_maybe or coalesce to unwrap, got ${this.u.pretty(lt)} and ${this.u.pretty(rt)}`);
            return true;
        }
        // Pipeline modes are not plain scalars and must not be
        // silently absorbed by a numeric literal variable (`row_number + 1`).
        if (modePayload(this.u.peel(lt)) !== null || modePayload(this.u.peel(rt)) !== null) {
            this.diag(node, `'${op}' requires numeric operands, got ${this.u.pretty(lt)} and ${this.u.pretty(rt)}`);
            return true;
        }
        return false;
    }
    /** Static semantics shared by infix expressions and `_op_ a b`. */
    private inferBinaryTypes(
        op: BinaryOperator,
        lt: Type,
        rt: Type,
        node: AstNode,
        leftNode: AstNode,
        rightNode: AstNode,
    ): Type {
        if (op === '==' || op === '!=' || op === '<' || op === '<=' || op === '>' || op === '>=') {
            // Aggregates/window values cannot be compared as plain scalars; a
            // polymorphic literal would otherwise absorb the mode (`row_number
            // == 1`, `sum t == 1`). Nullable `maybe` is handled below (== null).
            const cmpMode = (t: Type): boolean => modePayload(this.u.peel(t)) !== null;
            if (cmpMode(lt) || cmpMode(rt)) {
                this.diag(node, `cannot compare an aggregate or window value with ${this.u.pretty(lt)} and ${this.u.pretty(rt)} — project it through fold/over first`);
                return prim('bool');
            }
            const leftNull = this.isNullLiteralNode(leftNode);
            const rightNull = this.isNullLiteralNode(rightNode);
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
                        this.diag(node, `comparison expects non-null values — use is_null/is_not_null or from_maybe, got ${this.u.pretty(lt)} and ${this.u.pretty(rt)}`);
                        return prim('bool');
                    }
                    this.u.constrain(lt, op === '==' || op === '!=' ? 'Eq' : 'Ord');
                }
            } catch (err) {
                if (err instanceof UnifyError) {
                    this.diag(node, `cannot compare ${this.u.pretty(lt)} with ${this.u.pretty(rt)}`);
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
                    this.diag(node, `'${op}' requires boolean operands, got ${this.u.pretty(lt)} and ${this.u.pretty(rt)}`);
                } else {
                    throw err;
                }
            }
            return prim('bool');
        }
        // `<>` has closed Semigroup/Monoid instances for strings and lists;
        // records retain their structural right-biased merge behavior.
        if (op === '<>') {
            const left = this.u.peel(lt);
            const right = this.u.peel(rt);
            if (left.kind === 'prim' && right.kind === 'prim'
                && left.name === 'string' && right.name === 'string') {
                return prim('string');
            }
            if (left.kind === 'list' && right.kind === 'list') {
                this.u.unify(left.of, right.of);
                return listOf(left.of);
            }
            const rowLike = (t: Type): boolean => {
                const peeled = this.u.peel(t);
                if (peeled.kind === 'row') return true;
                if (peeled.kind !== 'var') return false;
                return this.u.varInfo(peeled.id).kind === 'row';
            };
            const unwrapZeroArg = (node: AstNode): AstNode => {
                let current = node;
                while (isApplication(current) && current.arguments.length === 0) current = current.func;
                return current;
            };
            const bareIdentifier = isIdentifier(unwrapZeroArg(leftNode));
            const concreteNonSemigroup = (t: Type): boolean => {
                const peeled = this.u.peel(t);
                return peeled.kind === 'prim' && peeled.name !== 'string';
            };
            if ((bareIdentifier && concreteNonSemigroup(right))
                || (isIdentifier(unwrapZeroArg(rightNode)) && concreteNonSemigroup(left))) {
                return this.inferMerge(lt, rt, node);
            }
            if (!rowLike(left) && !rowLike(right)) {
                try {
                    return this.u.unifyConstrained(lt, rt, 'Semigroup');
                } catch (err) {
                    if (err instanceof UnifyError) {
                        this.diag(node, `'<>' requires matching Semigroup operands, got ${this.u.pretty(lt)} and ${this.u.pretty(rt)}`);
                        return this.u.fresh();
                    }
                    throw err;
                }
            }
            return this.inferMerge(lt, rt, node);
        }
        // Haskell-base numerics: + - * require the same numeric type; / is
        // fractional division and requires float; use div/mod for integrals.
        if (op === '/') {
            if (this.rejectModeOperand(node, op, lt, rt)) return this.u.fresh();
            try {
                this.u.unify(lt, prim('float'));
                this.u.unify(rt, prim('float'));
            } catch (err) {
                if (err instanceof UnifyError) {
                    this.diag(node, `'/' requires float operands — use div for integral division, got ${this.u.pretty(lt)} and ${this.u.pretty(rt)}`);
                } else {
                    throw err;
                }
                return this.u.fresh();
            }
            return prim('float');
        }
        // + - *: constrained polymorphism, `Num t => t -> t -> t`.
        if (this.rejectModeOperand(node, op, lt, rt)) return this.u.fresh();
        try {
            return this.u.unifyConstrained(lt, rt, 'Num');
        } catch (err) {
            if (err instanceof UnifyError) {
                const rl = this.u.peel(lt);
                const rr = this.u.peel(rt);
                if (rl.kind === 'prim' && rr.kind === 'prim' && isNumericPrim(rl) && isNumericPrim(rr)) {
                    this.diag(node, `'${op}' requires numeric operands of the same type, got ${this.u.pretty(lt)} and ${this.u.pretty(rt)}`);
                } else {
                    this.diag(node, `'${op}' requires numeric operands, got ${this.u.pretty(lt)} and ${this.u.pretty(rt)}`);
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

    /** Type of an Agda-style `_op_` first-class operator reference. */
    private inferOperatorSection(
        e: import('./generated/ast.js').OperatorSection,
        env: Map<string, Scheme>,
    ): Type {
        const scoped = env.get(e.value);
        if (scoped) return this.u.instantiate(scoped);

        const op = sectionName(e.value);
        if (!isBinaryOperator(op)) {
            const scheme = env.get(op);
            if (scheme) return this.u.instantiate(scheme);
            this.diag(e, `unknown operator section '${e.value}' — '${op}' is not defined`);
            return this.u.fresh();
        }
        if (isIntrinsicOperator(op)) return this.fallbackOperatorType(op);
        this.diag(e, `unknown operator section '${e.value}' — '${op}' is not defined`);
        return this.u.fresh();
    }

    private inferOperatorApplication(
        op: BinaryOperator,
        e: import('./generated/ast.js').Application,
        env: Map<string, Scheme>,
        rawFunction: Type,
    ): Type {
        if (e.arguments.length < 2) {
            // Partial application remains ordinary currying. Exact binary
            // checks run once the section receives both arguments directly.
            return this.inferGenericApplication(rawFunction, e, env);
        }
        const leftNode = e.arguments[0]!;
        const rightNode = e.arguments[1]!;
        const left = this.inferArg(leftNode, env);
        const right = this.inferArg(rightNode, env);
        let result = this.inferBinaryTypes(op, left, right, e, leftNode, rightNode);
        for (const argument of e.arguments.slice(2)) {
            result = this.applyInferredFunction(result, this.inferArg(argument, env), argument, null);
        }
        return result;
    }

    private inferGenericApplication(
        rawFunction: Type,
        e: import('./generated/ast.js').Application,
        env: Map<string, Scheme>,
    ): Type {
        let current = this.u.peel(rawFunction);
        for (const argument of e.arguments) {
            current = this.applyInferredFunction(current, this.inferArg(argument, env), argument, null);
        }
        return current;
    }

    /** Human wording for a failed type-class constraint, or null to stay
     *  silent. `fnName` is the builtin being applied (when known) and lets
     *  the date family keep its established "expects a date or timestamp
     *  expression" message. A DateTime failure against a non-prim argument
     *  (an unannotated lambda whose row fields fail later) returns null: the
     *  constraint only surfaces there after deferred row unification, where
     *  the interpreter already reports the exact field precisely — a static
     *  echo would just print the whole lambda type as noise. */
    private constraintMessage(err: ConstraintError, arg: Type, fnName: string | null): string | null {
        if (err.constraint === 'Num') {
            // `date_add`'s amount keeps its established wording (a test pins it).
            return fnName === 'date_add'
                ? `date_add expects a numeric amount, got type ${this.u.pretty(arg)}`
                : `${err.constraint} requires a numeric type, got ${this.u.pretty(arg)}`;
        }
        if (err.constraint === 'Frac') return `a float/decimal literal cannot fit the type required here — write a literal of the matching type (e.g. 18 for an int)`;
        if (err.constraint === 'DateTime') {
            if (this.u.peel(arg).kind !== 'prim') return null;
            return fnName
                ? `${fnName} expects a date or timestamp expression, got type ${this.u.pretty(arg)}`
                : `cannot apply — expects a date or timestamp value, got ${this.u.pretty(arg)}`;
        }
        return `${err.constraint} requires a supported instance, got ${this.u.pretty(arg)}`;
    }

    private applyInferredFunction(f: Type, arg: Type, node: AstNode, name: string | null): Type {
        const param = this.u.fresh();
        const result = this.u.fresh();
        try {
            this.u.unify(f, fun(param, result));
            this.u.unify(param, arg);
        } catch (err) {
            if (err instanceof ConstraintError) {
                const message = this.constraintMessage(err, arg, name);
                if (message !== null) this.diag(node, message);
                return this.u.fresh();
            }
            if (err instanceof UnifyError) {
                if (!this.reportNumericMix(node, err)) this.argError(name, 0, node, arg, param, f);
                return this.u.fresh();
            }
            throw err;
        }
        return result;
    }

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
        const operatorName = boundName?.startsWith('operator:')
            ? boundName.slice('operator:'.length)
            : null;
        if (operatorName && isBinaryOperator(operatorName)) {
            return this.inferOperatorApplication(operatorName, e, env, rawF);
        }
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
        if (isJoinBuiltinName(funcName) && e.arguments.length === 3) {
            return this.inferJoin(e, env, funcName, JOIN_BUILTINS[funcName]);
        }
        if (funcName === 'scalar' && e.arguments.length === 1) return this.inferScalar(e, env);
        if ((funcName === 'in_query' || funcName === 'not_in_query') && e.arguments.length === 2) return this.inferInQuery(e, env);
        if ((funcName === 'is_true' || funcName === 'is_false' || funcName === 'is_unknown') && e.arguments.length === 1) {
            return this.inferTruthPredicate(e, env, funcName);
        }
        if (funcName === 'fold' && e.arguments.length === 1) return this.inferFold(e, env);
        if (funcName === 'map' && e.arguments.length === 1) return this.inferMap(e, env);
        if (funcName === 'select' && e.arguments.length === 1) return this.inferSelect(e, env);
        // `merge` — the result row is the union of both rows (the right
        // record wins on overlapping fields), which the generic fun-type
        // application path cannot express; compute the union directly.
        if (funcName === 'coalesce' && e.arguments.length === 1) return this.inferCoalesceList(e, env);
        if (funcName === 'fmap' && e.arguments.length === 2) return this.inferFmap(e, env);
        if (funcName === 'replaceWith' && e.arguments.length === 2) {
            const left = this.inferArg(e.arguments[0]!, env);
            const right = this.inferArg(e.arguments[1]!, env);
            return this.inferReplaceTypes(left, right, e.arguments[0]!, e.arguments[1]!);
        }
        if (funcName === 'ap' && e.arguments.length === 2) {
            const left = this.inferArg(e.arguments[0]!, env);
            const right = this.inferArg(e.arguments[1]!, env);
            return this.inferApTypes(left, right, e.arguments[0]!, e.arguments[1]!);
        }
        if ((funcName === 'applyLeft' || funcName === 'applyRight' || funcName === 'then') && e.arguments.length === 2) {
            const left = this.inferArg(e.arguments[0]!, env);
            const right = this.inferArg(e.arguments[1]!, env);
            const keep = funcName === 'applyLeft' ? 'left' : 'right';
            return this.inferSequenceTypes(left, right, e.arguments[0]!, e.arguments[1]!, funcName, keep);
        }
        if (funcName === 'orElse' && e.arguments.length === 2) {
            const left = this.inferArg(e.arguments[0]!, env);
            const right = this.inferArg(e.arguments[1]!, env);
            return this.inferOrElseTypes(left, right, e.arguments[0]!, e.arguments[1]!);
        }
        if (funcName === 'bind' && e.arguments.length === 2) {
            const left = this.inferArg(e.arguments[0]!, env);
            const right = this.inferArg(e.arguments[1]!, env);
            return this.inferBindTypes(left, right, e.arguments[0]!, e.arguments[1]!);
        }
        if (funcName === 'merge' && e.arguments.length === 1) {
            return this.inferMergePartial(e.arguments[0]!, e, env);
        }
        // `pick names` / `omit names` — record transformers with a precise
        // static output row (see inferRecordPicker). Fully-applied two-arg
        // forms stay on the generic scheme (sound, imprecise).
        if ((funcName === 'pick' || funcName === 'omit') && e.arguments.length === 1) {
            return this.inferRecordPicker(e, env, funcName);
        }
        if (funcName === 'merge' && e.arguments.length === 2) {
            const a = this.inferArg(e.arguments[0]!, env);
            const b = this.inferArg(e.arguments[1]!, env);
            return this.inferMerge(a, b, e);
        }
        if (funcName === 'over') return this.inferOver(e, env);
        if (funcName === 'cast' && e.arguments.length === 2) return this.inferCast(e, env, funcName);
        if (funcName === 'mempty') return this.inferMempty(e, env);
        let f = this.u.peel(rawF);
        const argTypes: Type[] = [];
        for (let i = 0; i < e.arguments.length; i++) {
            const argExpr = e.arguments[i]!;
            let argType = this.inferArg(argExpr, env);
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
            // A `merge` merger passed to a curried higher-order step (reached
            // through a bound/partially-applied value) under-specifies the
            // result row under blind inference (the union row stays open).
            // Compute the merged row directly — the same special case the
            // direct join path applies — so the output type stays precise.
            if (argType.kind === 'builtin' && argType.name === 'merge') {
                const mp = this.u.peel(param);
                if (mp.kind === 'fun') {
                    const mpr = this.u.peel(mp.to);
                    if (mpr.kind === 'fun') {
                        const mrow = this.inferMerge(mp.from, mpr.from, argExpr);
                        const checkedArg = fun(mp.from, fun(mpr.from, mrow));
                        try {
                            this.u.unify(param, checkedArg);
                            argType = checkedArg;
                            argTypes[i] = checkedArg;
                        } catch {
                            // leave argType as the blind result; the unify below reports.
                        }
                    }
                }
            }
            try {
                this.u.unify(param, argType);
            } catch (err) {
                if (err instanceof ConstraintError) {
                    const message = this.constraintMessage(err, argType, funcName);
                    if (message !== null) this.diag(argExpr, message);
                    return this.u.fresh();
                } else if (err instanceof UnifyError) {
                    // Blindly unifying failed (the transactional unify already
                    // rolled back). If the expected parameter is a curried
                    // function, re-check the argument against its two expected
                    // parameter types — this lets first-class outer-join steps
                    // (bound/partially-applied `joinLeft`/`joinRight`/`joinFull`)
                    // match the `maybe`-wrapped side of the scheme.
                    const checked = this.tryFetchCheckedArgType(param, argExpr, env);
                    let recovered = false;
                    if (checked !== null) {
                        try {
                            this.u.unify(param, checked);
                            argType = checked;
                            argTypes[i] = checked;
                            recovered = true;
                        } catch {
                            // Even checked re-inference fails — keep the original error.
                        }
                    }
                    if (!recovered) {
                        if (!this.reportNumericMix(argExpr, err)) {
                            this.argError(funcName, i, argExpr, argType, param, f);
                        }
                        failed = true;
                    }
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
        if (funcName && SET_OP_BUILTINS.has(funcName)) {
            this.checkSetOpOperand(funcName, e, env);
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
     * Closed Functor dispatch for the executable instances currently supported
     * by the evaluator: maybe values, lists, and query rows.
     */
    private inferFmap(
        e: import('./generated/ast.js').Application,
        env: Map<string, Scheme>,
    ): Type {
        const functionExpr = e.arguments[0]!;
        const mappedExpr = e.arguments[1]!;
        const functionType = this.inferArg(functionExpr, env);
        const mappedType = this.inferArg(mappedExpr, env);
        return this.inferFmapTypes(functionType, mappedType, functionExpr, mappedExpr);
    }

    private inferFmapTypes(
        functionType: Type,
        mappedType: Type,
        functionExpr: AstNode,
        mappedExpr: AstNode,
    ): Type {
        const input = this.u.fresh();
        const output = this.u.fresh();
        try {
            this.u.unify(functionType, fun(input, output));
        } catch (err) {
            if (err instanceof UnifyError) {
                this.diag(functionExpr, `fmap expects a function of one argument, got ${this.u.pretty(functionType)}`);
                return this.u.fresh();
            }
            throw err;
        }

        const container = this.u.peel(mappedType);
        try {
            if (container.kind === 'maybe') {
                this.u.unify(input, container.of);
                return maybeOf(output);
            }
            if (container.kind === 'list') {
                this.u.unify(input, container.of);
                return listOf(output);
            }
            if (container.kind === 'var') {
                // A row field may still be an unresolved variable while its
                // enclosing map lambda is being inferred. Preserve the
                // original Maybe default until the row/schema constraint
                // arrives; concrete list and query containers take the
                // branches above.
                this.u.unify(mappedType, maybeOf(input));
                return maybeOf(output);
            }
            if (container.kind === 'query') {
                const inputRow = this.u.peel(container.row);
                if (inputRow.kind !== 'row' && inputRow.kind !== 'var') {
                    throw new UnifyError(inputRow, container.row);
                }
                this.u.unify(input, container.row);
                const outputRow = this.u.peel(output);
                if (outputRow.kind === 'var') {
                    const tail = this.u.fresh('row');
                    this.u.bind(outputRow.id, rowOf([], tail));
                } else if (outputRow.kind !== 'row') {
                    throw new UnifyError(outputRow, output);
                }
                return queryOf(output);
            }
        } catch (err) {
            if (err instanceof UnifyError) {
                this.diag(mappedExpr, `fmap function and mapped value have incompatible types: ${this.u.pretty(functionType)} and ${this.u.pretty(mappedType)}`);
                return this.u.fresh();
            }
            throw err;
        }

        this.diag(mappedExpr, `fmap has no Functor instance for ${this.u.pretty(mappedType)} — expected maybe, list, or query`);
        return this.u.fresh();
    }

    /** Closed `<$`: replace every value in a Functor with one constant. */
    private inferReplaceTypes(
        valueType: Type,
        mappedType: Type,
        valueExpr: AstNode,
        mappedExpr: AstNode,
    ): Type {
        const container = this.u.peel(mappedType);
        if (container.kind === 'maybe') return maybeOf(valueType);
        if (container.kind === 'list') return listOf(valueType);
        if (container.kind === 'var') {
            const input = this.u.fresh();
            try {
                this.u.unify(mappedType, maybeOf(input));
                return maybeOf(valueType);
            } catch (err) {
                if (!(err instanceof UnifyError)) throw err;
            }
        }
        if (container.kind === 'query') {
            const output = this.u.peel(valueType);
            try {
                if (output.kind === 'var') {
                    this.u.bind(output.id, rowOf([], this.u.fresh('row')));
                } else if (output.kind !== 'row') {
                    throw new UnifyError(output, valueType);
                }
                return queryOf(valueType);
            } catch (err) {
                if (err instanceof UnifyError) {
                    this.diag(valueExpr, `replaceWith over a query requires a record value, got ${this.u.pretty(valueType)}`);
                    return this.u.fresh();
                }
                throw err;
            }
        }
        this.diag(mappedExpr, `replaceWith has no Functor instance for ${this.u.pretty(mappedType)} — expected maybe, list, or query`);
        return this.u.fresh();
    }

    /** Closed `<*>`: apply functions inside the same maybe/list container. */
    private inferApTypes(
        functionsType: Type,
        valuesType: Type,
        functionsExpr: AstNode,
        valuesExpr: AstNode,
    ): Type {
        const input = this.u.fresh();
        const output = this.u.fresh();
        const container = this.u.peel(functionsType);
        try {
            if (container.kind === 'maybe') {
                this.u.unify(container.of, fun(input, output));
                this.u.unify(valuesType, maybeOf(input));
                return maybeOf(output);
            }
            if (container.kind === 'list') {
                this.u.unify(container.of, fun(input, output));
                this.u.unify(valuesType, listOf(input));
                return listOf(output);
            }
            if (container.kind === 'var') {
                const values = this.u.peel(valuesType);
                if (values.kind === 'list') {
                    this.u.unify(functionsType, listOf(fun(values.of, output)));
                    return listOf(output);
                }
                this.u.unify(functionsType, maybeOf(fun(input, output)));
                this.u.unify(valuesType, maybeOf(input));
                return maybeOf(output);
            }
        } catch (err) {
            if (err instanceof UnifyError) {
                this.diag(valuesExpr, `ap requires matching Applicative containers and compatible function/value types, got ${this.u.pretty(functionsType)} and ${this.u.pretty(valuesType)}`);
                return this.u.fresh();
            }
            throw err;
        }
        this.diag(functionsExpr, `ap has no Applicative instance for ${this.u.pretty(functionsType)} — expected maybe or list`);
        return this.u.fresh();
    }

    /** Closed `<*`, `*>`, and `>>`: sequence effects in matching containers. */
    private inferSequenceTypes(
        leftType: Type,
        rightType: Type,
        leftExpr: AstNode,
        rightExpr: AstNode,
        name: 'applyLeft' | 'applyRight' | 'then',
        keep: 'left' | 'right',
    ): Type {
        const left = this.u.peel(leftType);
        const rightItem = this.u.fresh();
        try {
            if (left.kind === 'maybe') {
                this.u.unify(rightType, maybeOf(rightItem));
                return maybeOf(keep === 'left' ? left.of : rightItem);
            }
            if (left.kind === 'list') {
                this.u.unify(rightType, listOf(rightItem));
                return listOf(keep === 'left' ? left.of : rightItem);
            }
            if (left.kind === 'var') {
                const leftItem = this.u.fresh();
                const right = this.u.peel(rightType);
                if (right.kind === 'list') {
                    this.u.unify(leftType, listOf(leftItem));
                    return listOf(keep === 'left' ? leftItem : right.of);
                }
                this.u.unify(leftType, maybeOf(leftItem));
                this.u.unify(rightType, maybeOf(rightItem));
                return maybeOf(keep === 'left' ? leftItem : rightItem);
            }
        } catch (err) {
            if (err instanceof UnifyError) {
                this.diag(rightExpr, `${name} requires two values in the same Applicative container, got ${this.u.pretty(leftType)} and ${this.u.pretty(rightType)}`);
                return this.u.fresh();
            }
            throw err;
        }
        this.diag(leftExpr, `${name} has no Applicative instance for ${this.u.pretty(leftType)} — expected maybe or list`);
        return this.u.fresh();
    }

    /** Closed `<|>`: left-biased maybe choice or list concatenation. */
    private inferOrElseTypes(
        leftType: Type,
        rightType: Type,
        leftExpr: AstNode,
        rightExpr: AstNode,
    ): Type {
        const left = this.u.peel(leftType);
        try {
            if (left.kind === 'maybe') {
                this.u.unify(rightType, maybeOf(left.of));
                return maybeOf(left.of);
            }
            if (left.kind === 'list') {
                this.u.unify(rightType, listOf(left.of));
                return listOf(left.of);
            }
            if (left.kind === 'var') {
                const item = this.u.fresh();
                const right = this.u.peel(rightType);
                if (right.kind === 'list') {
                    this.u.unify(leftType, listOf(right.of));
                    return listOf(right.of);
                }
                this.u.unify(leftType, maybeOf(item));
                this.u.unify(rightType, maybeOf(item));
                return maybeOf(item);
            }
        } catch (err) {
            if (err instanceof UnifyError) {
                this.diag(rightExpr, `orElse requires matching Alternative values, got ${this.u.pretty(leftType)} and ${this.u.pretty(rightType)}`);
                return this.u.fresh();
            }
            throw err;
        }
        this.diag(leftExpr, `orElse has no Alternative instance for ${this.u.pretty(leftType)} — expected maybe or list`);
        return this.u.fresh();
    }

    /** Closed `>>=`: Maybe short-circuiting and list flat-map. */
    private inferBindTypes(
        valueType: Type,
        functionType: Type,
        valueExpr: AstNode,
        functionExpr: AstNode,
    ): Type {
        const value = this.u.peel(valueType);
        const output = this.u.fresh();
        try {
            if (value.kind === 'maybe') {
                this.u.unify(functionType, fun(value.of, maybeOf(output)));
                return maybeOf(output);
            }
            if (value.kind === 'list') {
                this.u.unify(functionType, fun(value.of, listOf(output)));
                return listOf(output);
            }
            if (value.kind === 'var') {
                const functionShape = this.u.peel(functionType);
                if (functionShape.kind === 'fun') {
                    const returned = this.u.peel(functionShape.to);
                    if (returned.kind === 'list') {
                        this.u.unify(valueType, listOf(functionShape.from));
                        return listOf(returned.of);
                    }
                    if (returned.kind === 'maybe') {
                        this.u.unify(valueType, maybeOf(functionShape.from));
                        return maybeOf(returned.of);
                    }
                }
                const input = this.u.fresh();
                this.u.unify(valueType, maybeOf(input));
                this.u.unify(functionType, fun(input, maybeOf(output)));
                return maybeOf(output);
            }
        } catch (err) {
            if (err instanceof UnifyError) {
                this.diag(functionExpr, `bind expects a function returning the same Monad container as ${this.u.pretty(valueType)}, got ${this.u.pretty(functionType)}`);
                return this.u.fresh();
            }
            throw err;
        }
        this.diag(valueExpr, `bind has no Monad instance for ${this.u.pretty(valueType)} — expected maybe or list`);
        return this.u.fresh();
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
        if (raw.kind !== 'mode' || raw.mode === 'group') {
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

    /** `cast x "int"` — the result type is the target. */
    private inferCast(e: import('./generated/ast.js').Application, env: Map<string, Scheme>, name: 'cast'): Type {
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
     * `mempty` — the monoid identity, resolved by the use site (no
     * user-definable instances, so the closed instance table is complete):
     *   - `mempty : string` (the concrete fallback, also the standalone value)
     *   - `mempty : [a]` (any element type)
     *   - `mempty : { ... }` (a closed record; fields stay unknown here and
     *     are pinned by unification against the other `<>` operand)
     * Anything else is an instance error. Ascriptions and inference both
     * funnel through `checkMemptyInstance`, so the annotation IS the lookup.
     */
    private inferMempty(e: import('./generated/ast.js').Application, env: Map<string, Scheme>): Type {
        for (const arg of e.arguments) this.inferArg(arg, env); // arity errors flow below
        const result = this.u.fresh();
        if (e.arguments.length === 1) {
            const t = this.inferExpr(e.func as unknown as Expr, env);
            try {
                this.u.unify(t, fun(result, result));
                return result;
            } catch (err) {
                if (!(err instanceof UnifyError)) throw err;
                this.diag(e, `mempty applied as a function takes exactly one argument — write (mempty : T), e.g. (mempty : (maybe string))`);
                return this.u.fresh();
            }
        }
        if (e.arguments.length > 1) {
            this.diag(e, `mempty takes no arguments — write (mempty : T) to pick the instance, e.g. (mempty : [int])`);
            return this.u.fresh();
        }
        this.checkMemptyInstance(result, e.func, e);
        return result;
    }

    /** Pin a mempty result to the annotated/unified instance; reject non-monoids. */
    private checkMemptyInstance(result: Type, at: AstNode | undefined, e: import('./generated/ast.js').Application): void {
        this.pendingMempty.push({ node: at ?? e, type: result, application: e });
    }

    /**
     * `joinKind right on merger` — the ON predicate sees the original rows;
     * the merger sees `(maybe row)` only on the side an outer join can omit.
     * Its projection therefore determines result nullability field by field.
     */
    private inferJoin(
        e: import('./generated/ast.js').Application,
        env: Map<string, Scheme>,
        name: JoinBuiltinName,
        kindName: JoinKindName,
    ): Type {
        const r = this.u.fresh('row');
        const s = this.u.fresh('row');
        const t = this.u.fresh('flex');
        const rightT = this.inferArg(e.arguments[0]!, env);
        const onT = this.inferArg(e.arguments[1]!, env);
        try {
            this.u.unify(rightT, queryOf(s));
        } catch (err) {
            if (err instanceof UnifyError) {
                this.argError(name, 0, e.arguments[0]!, rightT, queryOf(s), undefined);
            } else {
                throw err;
            }
            return this.u.fresh();
        }
        try {
            this.u.unify(onT, fun(r, fun(s, prim('bool'))));
        } catch (err) {
            if (err instanceof UnifyError) {
                this.argError(name, 1, e.arguments[1]!, onT, fun(r, fun(s, prim('bool'))), undefined);
            } else {
                throw err;
            }
            return this.u.fresh();
        }
        const mergerLeft = kindName === 'right' || kindName === 'full' ? maybeOf(r) : r;
        const mergerRight = kindName === 'left' || kindName === 'full' ? maybeOf(s) : s;
        const mergerT = this.inferCheckedTwoArg(e.arguments[2]!, env, mergerLeft, mergerRight);
        const expectedMerger = fun(mergerLeft, fun(mergerRight, t));
        // A plain `merge` is the advertised full-row-union shorthand. The
        // generic merge scheme returns an unconstrained fresh row, which would
        // lose every projected field. Compute the merge row directly from the
        // merger's possibly null-extended inputs (right wins on overlap).
        const mergerIsMerge = mergerT.kind === 'builtin' && mergerT.name === 'merge';
        let row: Type;
        if (mergerIsMerge) {
            row = this.inferMerge(mergerLeft, mergerRight, e.arguments[2]!);
        } else {
            try {
                this.u.unify(mergerT, expectedMerger);
            } catch (err) {
                if (err instanceof UnifyError) {
                    this.argError(name, 2, e.arguments[2]!, mergerT, expectedMerger, undefined);
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
            this.argError(name, 2, e.arguments[2]!, mergerT, undefined, undefined);
            return this.u.fresh();
        }
        return fun(queryOf(r), queryOf(row));
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

    /** SQL three-valued logic predicates accept bool, maybe bool, or NULL. */
    private inferTruthPredicate(e: import('./generated/ast.js').Application, env: Map<string, Scheme>, name: string): Type {
        const arg = e.arguments[0]!;
        const argType = this.inferArg(arg, env);
        try {
            this.u.unify(argType, truthType());
        } catch (err) {
            if (!(err instanceof UnifyError)) throw err;
            this.diag(e, `${name} expects a boolean or nullable boolean expression, got type ${this.u.pretty(argType)}`);
        }
        return prim('bool');
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

    /**
     * `pick ["id", "name"]` / `omit ["x"]` — record transformers used inside
     * map. The static output row needs the INPUT row's field types, which at
     * this point is the transformer's own fresh row variable: extend it with
     * the listed fields via `fieldOf` (mirroring inferSelect's closed-row
     * trick) and build the output row from those exact types. `pick` closes
     * the output (a downstream typo is a static error, like select);
     * `omit` keeps an open tail (the remaining fields stay accessible).
     */
    private inferRecordPicker(e: import('./generated/ast.js').Application, env: Map<string, Scheme>, kind: 'pick' | 'omit'): Type {
        const listExpr = e.arguments[0]!;
        this.inferArg(listExpr, env);
        if (!isListLiteral(listExpr)) {
            this.diag(listExpr, `${kind} expects a list of field-name strings, e.g. ${kind} ["id", "name"]`);
            return this.u.fresh();
        }
        const names: string[] = [];
        const seen = new Set<string>();
        for (const item of listExpr.elements) {
            let strNode: AstNode | undefined = item;
            while (strNode && isApplication(strNode) && strNode.arguments.length === 0) strNode = strNode.func;
            if (!isStringLiteral(strNode)) {
                this.diag(item, `${kind} entries must be string literals`);
                continue;
            }
            const label = parseStringLiteral(strNode.value);
            if (kind === 'pick' && seen.has(label)) this.diag(item, `duplicate field '${label}' in pick`);
            seen.add(label);
            names.push(label);
        }
        if (names.length === 0) {
            this.diag(listExpr, `${kind} expects at least one field name, e.g. ${kind} ["id"]`);
        }
        const r = this.u.fresh('row');
        const byName = new Map<string, Type>();
        for (const label of names) {
            // fieldOf extends the fresh row, so repeated names share one type.
            const field = this.u.fieldOf(r, label);
            if (field) byName.set(label, field.type);
        }
        if (kind === 'pick') {
            const fields: [string, Type][] = names.map(label => [label, byName.get(label) ?? this.u.fresh()]);
            return fun(listOf(prim('string')), fun(r, rowOf(fields)));
        }
        // omit: the output is the input minus the listed fields. Add the
        // listed fields to the row (fieldOf did), then build the output from
        // the row's OTHER fields plus an open tail SHARED with the input's
        // tail, so unification at the use site materializes the remaining
        // fields into the output row too.
        const resolved = this.u.resolve(r);
        if (resolved.kind !== 'row') return this.u.fresh();
        const row = this.u.resolveRow(resolved);
        const fields: [string, Type][] = [...row.fields]
            .filter(([label]) => !seen.has(label))
            .map(([label, type]) => [label, type]);
        return fun(listOf(prim('string')), fun(r, rowOf(fields, row.tail)));
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
     * `fold (o => { k = group o.k, s = sum o.v })` — the DSL's grouping and
     * aggregate-mode check. The lambda's result must be a record whose fields
     * are ALL in aggregate or group mode (`agg t` / `group t`); a plain column
     * or computed expression is a static type error. A projection made only
     * of group fields is therefore a valid grouping operation. The result row
     * strips the modes, so downstream steps see plain columns
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
            const raw = this.u.peel(ft);
            if (raw.kind !== 'mode' || raw.mode !== 'group') continue;
            const groupArg = this.groupArgumentOf(entryNodes?.get(key));
            const sig = this.accessSignature(groupArg);
            if (sig) groupSigs.add(sig);
        }
        const out: [string, Type][] = [];
        let modes = 0;
        for (const [key, ft] of res.fields) {
            const raw = this.u.peel(ft);
            if (raw.kind === 'mode' && raw.mode === 'agg') {
                const entry = entryNodes?.get(key);
                const caseNode = this.unwrapApplicationExpr(entry);
                if (caseNode && isCaseExpression(caseNode)) {
                    const conditionSigs = this.conditionAccessSignatures(caseNode);
                    const ungrouped = [...conditionSigs].some(sig => !groupSigs.has(sig));
                    if (ungrouped) {
                        this.diag(entry ?? argExpr, `fold entry '${key}' case conditions must be constant or use grouped columns`);
                    }
                }
                modes++;
                out.push([key, raw.of]);
            } else if (raw.kind === 'mode' && raw.mode === 'group') {
                modes++;
                out.push([key, raw.of]);
            } else {
                this.diag(entryNodes?.get(key) ?? argExpr, `fold entry '${key}' must be wrapped in an aggregate (count, sum, ...) or group`);
                out.push([key, ft]);
            }
        }
        if (modes === 0) {
            this.diag(argExpr, `fold must contain at least one aggregate or group entry`);
        }
        return fun(queryOf(r.from), queryOf(rowOf(out, res.tail)));
    }

    /**
     * The inner row -> row projection behind a record transformer
     * constructor (`pick [...]` / `omit [...]` / `rename rule` partially
     * applied to their key configuration). Null when the type is not that
     * shape — then map uses the argument type unchanged.
     */
    private recordTransformerOf(t: Type): Type | null {
        const f = this.u.peel(t);
        if (f.kind !== 'fun') return null;
        const from = this.u.peel(f.from);
        const to = this.u.peel(f.to);
        if (to.kind !== 'fun') return null;
        // pick/omit: `[string] -> {r} -> {s}`; rename: `(string -> string) -> {r} -> {s}`.
        if (from.kind === 'list' || (from.kind === 'fun'
            && this.u.peel(from.from).kind === 'prim' && (this.u.peel(from.from) as { name: string }).name === 'string'
            && this.u.peel(from.to).kind === 'prim' && (this.u.peel(from.to) as { name: string }).name === 'string')) {
            return to;
        }
        return null;
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
        // A record transformer (`pick [...]` / `omit [...]` / `rename rule`)
        // is a curried constructor ([string] -> {r} -> {s}, or
        // (string -> string) -> {r} -> {s}); as map's projection it is the
        // INNER row -> row function — the interpreter applies it to the row
        // (exactly like a partially-applied `merge`, whose leftover is
        // already row -> row).
        const projection = this.recordTransformerOf(argType) ?? argType;
        const r = this.u.peel(projection);
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
            if (raw.kind === 'mode' && raw.mode === 'group') {
                this.diag(entryNodes?.get(key) ?? argExpr, `projection entry '${key}' cannot contain group`);
            } else if (raw.kind === 'order') {
                this.diag(entryNodes?.get(key) ?? argExpr, `projection entry '${key}' cannot contain order items (asc/desc)`);
            } else if (raw.kind === 'mode' && raw.mode === 'window') {
                const entry = entryNodes?.get(key);
                const fnName = this.windowFunctionNameOf(entry) ?? 'window function';
                // Anchor on the enclosing pipeline so this diagnostic and the
                // interpreter's validateWindowUses message dedupe exactly.
                this.diag(this.pipelineAnchorOf(e), `${fnName} must be wrapped in over (...) — e.g. over (${fnName}) { partition = [u.dept], order = [desc u.salary] }`);
                out.push([key, raw.of]);
                continue;
            }
            out.push([key, raw.kind === 'mode' && raw.mode === 'agg' ? raw.of : ft]);
        }
        return fun(queryOf(r.from), queryOf(rowOf(out, res.tail)));
    }

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
     * List-argument builtins (`concat [a, b]`, `greatest [a, b]`, ...): the
     * scheme types the FIRST element; this checks every element's static kind
     * and the arity, mirroring the interpreter's runtime checks with matching
     * messages (so the merged diagnostics dedupe). The heterogeneous/optional
     * builtins (round, substring, lpad/rpad, lag/lead) are curried — a list
     * cannot type `[string, int, ...]` — so they are never checked here.
     */
    private checkListBuiltin(name: string, e: import('./generated/ast.js').Application, env: Map<string, Scheme>): void {
        const listExpr = e.arguments[0];
        if (!listExpr || !isListLiteral(listExpr)) return;
        const elements = listExpr.elements;
        const [min, max] = LIST_ARITY[name] ?? [0, Infinity];
        if (elements.length < min || elements.length > max) {
            this.diag(listExpr, `${name} expects ${min}${max === Infinity ? ' or more' : ` to ${max}`} arguments, got ${elements.length}`);
        }
        switch (name) {
            case 'concat': {
                for (let i = 0; i < elements.length; i++) {
                    const t = this.inferExpr(elements[i]!, env);
                    try {
                        this.u.unify(prim('string'), t);
                    } catch (err) {
                        if (err instanceof UnifyError) {
                            this.diag(elements[i]!, `concat expects string expressions, got type ${this.u.pretty(t)}`);
                        } else {
                            throw err;
                        }
                    }
                }
                break;
            }
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
        }
    }

    /**
     * Set operations (`union`/`intersect`/`except`/`union_all`) match columns
     * POSITIONALLY in SQL, while tetaue rows are unordered records — so the
     * renderer projects an explicit shared column order and rejects operands
     * whose schema is not fully known. Report that here, at the set call,
     * instead of as a render-time surprise.
     */
    private checkSetOpOperand(name: string, e: import('./generated/ast.js').Application, env: Map<string, Scheme>): void {
        const isDynamic = (t: Type | undefined): boolean => {
            if (!t) return true;
            const r = this.u.peel(t);
            if (r.kind === 'builtin') return this.isDynamicSetOperand(this.u.peel(r.of));
            return this.isDynamicSetOperand(r);
        };
        const right = e.arguments[0];
        const rightT = right ? this.nodeTypes.get(right) : undefined;
        if (isDynamic(rightT)) {
            this.diag(right ?? e, `${name} requires known schemas on both operands — annotate each table or project it with map first`);
            return;
        }
        // The LEFT operand arrives through the `_&_` pipeline lambda
        // (`a & union b` evaluates as `union b a`); reach it through the
        // section application when present.
        const section = e.$container;
        const leftArg = section && isApplication(section) && section.arguments[0]
            ? section.arguments[0]
            : null;
        if (!leftArg) return;
        const leftT = this.nodeTypes.get(leftArg);
        if (isDynamic(leftT)) {
            this.diag(leftArg, `${name} requires known schemas on both operands — annotate each table or project it with map first`);
        }
    }

    /** Whether a peeled type is an unknown-schema query row (`query ?table`). */
    private isDynamicSetOperand(r: Type): boolean {
        if (r.kind !== 'query') return false;
        const row = this.u.peel(r.row);
        return row.kind === 'var';
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
    private mergeRowShape(t: Type, at: AstNode, which: 'first' | 'second'): { fields: Map<string, Type>; tail: Type | null; varId: number | null; nullExtended: boolean } | null {
        const outer = this.u.peel(t);
        const nullExtended = outer.kind === 'maybe';
        const r = this.u.peel(nullExtended ? outer.of : outer);
        if (r.kind === 'row') {
            const resolved = this.u.resolveRow(r);
            const fields = new Map<string, Type>();
            for (const [label, type] of resolved.fields) {
                fields.set(label, nullExtended ? this.nullExtend(type) : type);
            }
            return { fields, tail: resolved.tail, varId: null, nullExtended };
        }
        if (r.kind === 'var') {
            const info = this.u.varInfo(r.id);
            if (info.kind === 'type' || info.rigid) {
                this.diag(at, `merge expects a record as its ${which} argument, got type ${this.u.pretty(t)}`);
                return null;
            }
            return { fields: new Map(), tail: null, varId: r.id, nullExtended };
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
        let nullExtendedTail = false;
        if (bShape.varId !== null) {
            // Unconstrained right row: it IS the result's open part.
            resTail = this.u.fresh('row');
            try { this.u.bind(bShape.varId, { kind: 'row', fields: new Map(), tail: resTail }); } catch { /* leave open */ }
            nullExtendedTail = bShape.nullExtended;
        } else if (bShape.tail) {
            // Right side's open tail flows into the result unchanged.
            resTail = bShape.tail;
            nullExtendedTail = bShape.nullExtended;
        } else if (aShape.varId !== null) {
            // Closed right record: an unconstrained left row becomes the
            // result's open part (fields materialized later still appear).
            resTail = this.u.fresh('row');
            try { this.u.bind(aShape.varId, { kind: 'row', fields: new Map(), tail: resTail }); } catch { /* leave open */ }
            nullExtendedTail = aShape.nullExtended;
        } else if (aShape.tail) {
            // Closed right record: the left's open tail flows into the result.
            resTail = this.u.fresh('row');
            const t = this.u.peel(aShape.tail);
            if (t.kind === 'var' && !this.u.varInfo(t.id).rigid) {
                try { this.u.bind(t.id, resTail); } catch { /* kind conflict: leave open */ }
            }
            nullExtendedTail = aShape.nullExtended;
        } else {
            // Both closed: keep a tail open so the result stays mergeable.
            resTail = this.u.fresh('row');
        }
        if (nullExtendedTail) {
            const tail = this.u.resolve(resTail);
            if (tail.kind === 'var') this.u.setVarAbsorbAsMaybe(tail.id, true);
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
            if (parent && isBinaryExpression(parent)) {
                if (parent.left === current || parent.right === current) return parent;
            }
            current = parent;
        }
        return e;
    }

    /** Report strict numeric mixing discovered by an enclosing application. */
    private reportNumericMix(node: AstNode, err: UnifyError): boolean {
        const a = this.resolveBase(err.a);
        const b = this.resolveBase(err.b);
        if (a.kind === 'prim' && b.kind === 'prim' && isNumericPrim(a) && isNumericPrim(b) && a.name !== b.name) {
            const pair = new Set([a.name, b.name]);
            if (pair.has('int') && pair.has('float')) {
                this.diag(node, `cannot mix int and float (${a.name} vs ${b.name}) — write a literal of the matching type, e.g. ${a.name === 'int' ? '18' : '18.0'}`);
            } else {
                this.diag(node, `cannot mix numeric types (${a.name} vs ${b.name}) — use values of the same type`);
            }
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
            case 'filter': {
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
            case 'joinInner':
            case 'joinLeft':
            case 'joinRight':
            case 'joinFull':
                if (index === 0) this.diag(node, `${name} expects a query as its first argument, got an expression of type ${p(argType)} — bind a table or pipeline first, e.g. ${name} orders (l => r => ...)`);
                else if (index === 1) this.diag(node, `${name} 'on' must be a two-argument function (curried), e.g. (l => r => l.id == r.user_id) or (this.id == that.user_id), got an expression of type ${p(argType)}`);
                else if (index === 2) this.diag(node, `${name} 'merger' must be a two-argument function (curried), e.g. (l => r => merge l r) or merge, got an expression of type ${p(argType)}`);
                else this.diag(node, `${name} takes exactly three arguments: the right query, the 'on' function, and the merger function`);
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
            // Curried heterogeneous/optional builtins — messages mirror the
            // interpreter's (interpreter.ts `roundBuiltin` et al.) so the
            // merged diagnostics dedupe. Optional positions carry their
            // `maybe` contract with no type suffix: both passes say exactly
            // the same words.
            case 'round':
                if (index === 0) this.diag(node, `round expects a numeric expression, got type ${p(argType)}`);
                else if (index === 1) this.diag(node, `round expects a numeric scale, got type ${p(argType)}`);
                else this.diag(node, `round takes exactly two arguments, e.g. round u.x 0`);
                break;
            case 'substring':
                if (index === 0) this.diag(node, `substring expects a string expression, got type ${p(argType)}`);
                else if (index === 1) this.diag(node, `substring expects a numeric start position, got type ${p(argType)}`);
                else if (index === 2) this.diag(node, `substring expects its optional length as maybe int, e.g. substring u.name 1 nothing or substring u.name 1 (just 3)`);
                else this.diag(node, `substring takes exactly three arguments, e.g. substring u.name 1 nothing`);
                break;
            case 'lpad': case 'rpad':
                if (index === 0) this.diag(node, `${name} expects a string expression, got type ${p(argType)}`);
                else if (index === 1) this.diag(node, `${name} expects a numeric length, got type ${p(argType)}`);
                else if (index === 2) this.diag(node, `${name} expects a string padding, got type ${p(argType)}`);
                else this.diag(node, `${name} takes exactly three arguments, e.g. ${name} u.code 8 "0"`);
                break;
            case 'lag': case 'lead':
                if (index === 1) this.diag(node, `${name} expects a numeric offset, got type ${p(argType)}`);
                else if (index === 2) this.diag(node, `${name} expects its default to match the value type, e.g. ${name} u.salary 1 (just 0)`);
                else this.diag(node, `${name} takes exactly three arguments, e.g. ${name} u.salary 1 nothing`);
                break;
            default: {
                const applied = fType ? this.u.peel(fType) : null;
                if (applied?.kind === 'fun') {
                    this.diag(node, `cannot apply a function of type ${p(fType!)} to an argument of type ${p(argType)}`);
                } else {
                    this.diag(node, `cannot apply an expression of type ${p(fType ?? argType)}`);
                }
                break;
            }
        }
    }

    /** Post-unification checks the scheme types don't capture (numeric, date, order, literals). */
    private postCheckArg(name: string, index: number, argExpr: Expr, argType: Type, node: AstNode): void {
        const r = this.u.peel(argType);
        // A numeric literal now types as a `Num`/`Frac` variable; it is still
        // definitively not a date (and not a plain numeric elided by the
        // prim-only check), so treat such literal variables as concrete values.
        const isNumericLiteralVar = (rs: Type): boolean => rs.kind === 'var'
            && (this.u.varInfo(rs.id).classes.has('Num') || this.u.varInfo(rs.id).classes.has('Frac'));
        if (DATE_VALUE_ARGUMENTS.has(name) && index === 0) {
            // The DateTime class constraint catches concrete non-date prims
            // during unification; a numeric *literal* is an unconstrained
            // Nat variable until defaulted, so it is rejected here instead.
            if (isNumericLiteralVar(r)) {
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
            // Same as index 0: the DateTime constraint handles prims; only
            // numeric literals need the explicit rejection here.
            if (isNumericLiteralVar(r)) {
                this.diag(node, `date_diff expects a date or timestamp expression, got type ${this.u.pretty(argType)}`);
            }
            return;
        }
        if ((name === 'sum' || name === 'avg' || name === 'abs'
            || name === 'ceil' || name === 'floor' || name === 'sqrt'
            || name === 'round') && index === 0) {
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
        if (isTypeHole(t)) return this.typeHole(t.name, names);
        if (isConstrainedType(t)) {
            // `Num t => t -> t` — apply each typeclass constraint to its type
            // variable, then translate the body with those vars in scope.
            for (const c of t.constraints) {
                const classNames: readonly TypeClass[] = ['Num', 'Frac', 'Eq', 'Ord', 'DateTime', 'Semigroup', 'Monoid', 'Functor', 'Applicative', 'Alternative', 'Monad'];
                if (!classNames.includes(c.name as TypeClass)) {
                    this.diag(c, `unknown typeclass '${c.name}' — the closed typeclasses are: ${classNames.join(', ')}`);
                    continue;
                }
                const tv = this.typeOrRowVar(c.var, 'type', rigid, names, rigidVars);
                try {
                    this.u.constrain(tv, c.name as TypeClass);
                } catch (err) {
                    if (err instanceof ConstraintError) {
                        this.diag(c, `'${c.name}' does not apply here`);
                    } else if (!(err instanceof UnifyError)) throw err;
                }
            }
            return this.translateType(t.type, rigid, names, rigidVars);
        }
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
        if (isTypeVar(t)) {
            const name = t.name;
            const primitive = primitiveName(name);
            if (primitive) return prim(primitive);
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

    /** A non-tail `?name` annotation: all same-name holes in one annotation share one metavariable. */
    private typeHole(name: string, names: Map<string, Type>): Type {
        const key = `type-hole:${name}`;
        const existing = names.get(key);
        if (existing) return existing;
        const hole = this.u.freshHole('flex', name.slice(1));
        names.set(key, hole);
        return hole;
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
    // `this`/`that` implicit lambda parameters (mirrors interpreter.dollarArity)
    // -----------------------------------------------------------------------

    private dollarArity(node: AstNode, env: Map<string, Scheme>): number {
        let arity = 0;
        // Walk the AST subtree for unbound `this`/`that` identifiers (the
        // implicit parameters, internally `$1`/`$2`), skipping those hidden
        // behind an explicit lambda body. An argument in a FUNCTION position of an application
        // (by its callee's scheme) is its own implicit-lambda scope and does
        // not leak its this/that outward, nor does it let this/that be
        // captured by an explicit lambda further out
        // (mirrors interpreter.dollarArity).
        const stack: AstNode[] = [node];
        while (stack.length > 0) {
            const cur = stack.pop()!;
            // `this`/`that` sugar: an unbound identifier naming an implicit
            // parameter (internally $1/$2) contributes its index, unless
            // shadowed by a binding or an already-bound $1/$2 of the same
            // name.
            if (isIdentifier(cur) && !env.has(cur.name)) {
                const dollar = implicitParamName(cur.name);
                if (dollar && !env.has(dollar) && !this.hiddenBehindLambda(cur, env)) {
                    arity = Math.max(arity, Number(dollar.slice(1)));
                }
                continue;
            }
            for (const key of Object.keys(cur)) {
                if (key.startsWith('$')) continue;
                const value = (cur as unknown as Record<string, unknown>)[key];
                if (Array.isArray(value)) {
                    const skipFnArgs = key === 'arguments' && isApplication(cur) ? this.fnArgIndexesOf(cur, env) : undefined;
                    for (let i = 0; i < value.length; i++) {
                        const v = value[i];
                        if (!v || typeof v !== 'object' || !('$type' in (v as object))) continue;
                        if (skipFnArgs?.has(i)) continue;
                        stack.push(v as AstNode);
                    }
                } else if (value && typeof value === 'object' && '$type' in (value as object)) {
                    stack.push(value as AstNode);
                }
            }
        }
        return arity;
    }

    /**
     * Is `node` inside an explicit lambda body WITHOUT an intervening implicit
     * scope? `this`/`that` belong to an explicit lambda only when no
     * function-position application argument sits between it and that lambda
     * (mirrors the interpreter's hiddenBehindLambda).
     */
    private hiddenBehindLambda(node: AstNode, env: Map<string, Scheme>): boolean {
        let cur: AstNode | undefined = node;
        while (cur) {
            const parent: AstNode | undefined = cur.$container;
            if (!parent) break;
            if (isLambda(parent) && parent.body === cur) return true;
            if (isApplication(parent)) {
                const index = parent.arguments.indexOf(cur as import('./generated/ast.js').Expr);
                if (index >= 0 && this.fnArgIndexesOf(parent, env).has(index)) return false;
            }
            cur = parent;
        }
        return false;
    }

    /**
     * Argument indexes of `app` that consume a function — derived from the
     * callee's scheme in scope (builtins and user bindings alike).
     */
    private fnArgIndexesOf(app: import('./generated/ast.js').Application, env: Map<string, Scheme>): Set<number> {
        if (!isIdentifier(app.func)) return new Set();
        const scheme = env.get(app.func.name);
        return scheme ? this.fnArgIndexes(scheme.type) : new Set();
    }

    /** Indexes of a curried type's parameters whose (peeled) type is a function. */
    private fnArgIndexes(t: Type): Set<number> {
        const out = new Set<number>();
        let cur: Type | undefined = t;
        let index = 0;
        while (cur) {
            const r = this.u.peel(cur);
            if (r.kind !== 'fun') break;
            if (this.u.peel(r.from).kind === 'fun') out.add(index);
            cur = r.to;
            index++;
        }
        return out;
    }
}

/** Infer a project: modules in import order (imports first, root last). */
export function inferProject(
    modules: readonly ProjectModule[],
    importsByModule: ReadonlyMap<ProjectModule, readonly ResolvedImportEdge[]> = new Map(),
    prelude?: ProjectModule,
    reexportsByModule: ReadonlyMap<ProjectModule, readonly ResolvedExportEdge[]> = new Map(),
): InferProjectResult {
    const inferencer = new Inferencer();
    inferencer.inferProject(modules, importsByModule, prelude, reexportsByModule);
    return {
        diagnostics: inferencer.diagnostics,
        nodeTypes: inferencer.nodeTypes,
        typeOf: node => inferencer.typeOf(node),
        fieldsOf: node => inferencer.fieldsOf(node),
    };
}

/** Infer a single module (no imports). */
export function infer(model: Model, prelude?: ProjectModule): { diagnostics: InferDiagnostic[] } {
    return inferProject([{ model, uri: undefined, imports: [] }], new Map(), prelude);
}

/**
 * Merge diagnostic lists from the inference pass and the interpreter,
 * dropping exact (node, message) duplicates so each type error is reported
 * once (first occurrence wins). Both passes share the Diagnostic shape. The
 * key includes the owning module's URI, so identical errors at the same
 * offset in DIFFERENT modules are not collapsed into one (this matters in
 * the CLI/LSP render path, where parsed nodes carry no `$document`).
 *
 * The merged list is also ORDERED so the root cause of a failure comes
 * first: the two passes walk bindings in dependency order and both sides
 * anchor pipeline (`&`) failures at the same prelude `_&_` node, so raw
 * emission order is not cause-first. Diagnostics are bucketed per module —
 * cause/scope-entry diagnostics, then shape/aggregate follow-ons, then
 * error-propagation echoes — and each bucket keeps source order, so an
 * imported module's errors never displace the root module's own ordering.
 *
 * Suppression of echoes ("got an error", "cannot apply"):
 *  - "got an error" (the interpreter describing an ERROR value) is dropped
 *    when its module holds no cause — typically the prelude's
 *    `_&_ = x => f => f x` restating the caller's failure;
 *  - "cannot apply" is ambiguous: it is the primary error for a genuinely
 *    mismatched application (e.g. `union` over different rows) AND the
 *    downstream shape of a poisoned inner type. It is dropped only when
 *    another diagnostic's node sits strictly INSIDE its node — a cause
 *    beneath the application proves the failure came from within.
 */
const ECHO_PATTERNS = ['got an error', 'cannot apply'];

const SHAPE_PATTERNS = ['must be', 'cannot contain', 'must produce'];

function bucketOf(message: string): number {
    if (ECHO_PATTERNS.some(pattern => message.includes(pattern))) return 2;
    if (SHAPE_PATTERNS.some(pattern => message.includes(pattern))) return 1;
    return 0;
}

/** Whether `node` sits strictly inside `ancestor` (by $container chains). */
function isStrictDescendant(node: AstNode | undefined, ancestor: AstNode): boolean {
    let current = node?.$container;
    while (current) {
        if (current === ancestor) return true;
        current = current.$container;
    }
    return false;
}

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
    // Per-module cause-first bucketing; unanchored diagnostics keep raw order.
    const byModule = new Map<string, T[]>();
    const unanchored: T[] = [];
    for (const d of out) {
        const moduleUri = d.node ? (moduleOf(d.node, modules)?.uri ?? '') : '';
        if (!moduleUri) {
            unanchored.push(d);
            continue;
        }
        let bucket = byModule.get(moduleUri);
        if (!bucket) byModule.set(moduleUri, bucket = []);
        bucket.push(d);
    }
    const result: T[] = [];
    for (const bucket of byModule.values()) {
        const kept: T[] = [];
        for (const d of bucket) {
            if (bucketOf(d.message) !== 2) {
                kept.push(d);
                continue;
            }
            // An echo survives only when nothing explains it: no "got an
            // error"-family cause elsewhere in the module, and no cause
            // nested inside the echo's own node.
            const isGotError = d.message.includes('got an error');
            const explained = bucket.some(other => {
                if (other === d || bucketOf(other.message) === 2) return false;
                if (isGotError) return true; // any local cause explains it away
                return other.node?.$cstNode && d.node?.$cstNode
                    ? isStrictDescendant(other.node, d.node)
                    : false;
            });
            if (!explained) kept.push(d);
        }
        const cause: T[] = [];
        const shape: T[] = [];
        const echo: T[] = [];
        for (const d of kept) {
            const rank = bucketOf(d.message);
            (rank === 0 ? cause : rank === 1 ? shape : echo).push(d);
        }
        result.push(...cause, ...shape, ...echo);
    }
    result.push(...unanchored);
    return result;
}
