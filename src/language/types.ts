/******************************************************************************
 * tetaue type system — the internal type representation behind inference.
 *
 * Types are Hindley–Milner monotypes extended with:
 *   - row types `{ a: int, b: string | r }` (record rows with an optional
 *     row variable tail) — the engine of row polymorphism;
 *   - Haskell-style `maybe T` ("a t or SQL NULL"). Maybe is a
 *     distinct type constructor: `T` and `maybe T` never unify, so
 *     nullability is always explicit;
 *   - the parameterized `query { row }` type for tables/pipelines.
 *   - constrained variables such as `Num t`, preserved by type schemes.
 *
 * Variables are kind-flexible (a fresh variable becomes a row variable the
 * first time it is unified with a row) and live in a mutable binding store
 * owned by a TypeUniverse — one universe per inference run.
 *
 * See docs/design/type-system.md for the full specification.
 ******************************************************************************/

export type PrimName = 'int' | 'float' | 'decimal' | 'string' | 'bool' | 'date' | 'timestamp';
export type ScalarTypeClass = 'Num' | 'Frac' | 'Eq' | 'Ord' | 'DateTime' | 'Semigroup' | 'Monoid';
export type ContainerTypeClass = 'Functor' | 'Applicative' | 'Alternative' | 'Monad';
export type TypeClass = ScalarTypeClass | ContainerTypeClass;

const TYPE_CLASS_INSTANCES: Readonly<Record<ScalarTypeClass, ReadonlySet<PrimName>>> = {
    Num: new Set(['int', 'float', 'decimal']),
    Frac: new Set(['float', 'decimal']),
    Eq: new Set(['int', 'float', 'decimal', 'string', 'bool', 'date', 'timestamp']),
    Ord: new Set(['int', 'float', 'decimal', 'string', 'bool', 'date', 'timestamp']),
    // Calendar-valued scalars: the input/output class of the date family
    // (extract, date_add, date_diff, date_trunc, date_format, to_unixtime).
    DateTime: new Set(['date', 'timestamp']),
    Semigroup: new Set(['string']),
    Monoid: new Set(['string']),
};

/** Whether a primitive type implements one of the compiler-owned classes. */
export function isTypeClassInstance(constraint: ScalarTypeClass, type: PrimName): boolean {
    return TYPE_CLASS_INSTANCES[constraint].has(type);
}

/** Closed higher-kinded instances supported by the current runtime. */
export type FunctorName = 'maybe' | 'list' | 'query';

export function isFunctorInstance(name: FunctorName): boolean {
    return name === 'maybe' || name === 'list' || name === 'query';
}

export function isContainerTypeClassInstance(constraint: ContainerTypeClass, name: FunctorName): boolean {
    if (constraint === 'Functor') return isFunctorInstance(name);
    return name === 'maybe' || name === 'list';
}

export type Type =
    | { kind: 'var'; id: number }
    | { kind: 'prim'; name: PrimName }
    /** A SQL predicate: either bool or maybe bool (three-valued logic). */
    | { kind: 'truth' }
    | { kind: 'maybe'; of: Type; flattenNullExtension?: boolean }
    | { kind: 'fun'; from: Type; to: Type }
    | { kind: 'list'; of: Type }
    /** A record row: unordered label → type map, plus an optional tail variable. */
    | { kind: 'row'; fields: Map<string, Type>; tail: Type | null }
    | { kind: 'query'; row: Type }
    /** An ORDER BY item (`asc`/`desc`). */
    | { kind: 'order' }
    /**
     * A prelude builtin reference. Transparent in unification and pretty
     * printing, but the tag survives generalization/instantiation so a
     * builtin bound to a user name (`by = sort`) keeps its special static
     * checks — referential transparency at the type level.
     */
    | { kind: 'builtin'; name: string; of: Type }
    /**
     * An aggregate-mode expression (`sum o.total`, `count o.id`, ...) — "the
     * value of type `t`, aggregated". Transparent in unification (like `maybe`),
     * so comparisons/arithmetic on aggregate results work; the mode is
     * enforced by the fold/map mode checks in inference, which inspect the
     * raw (pre-unification) field types.
     */
    | { kind: 'agg'; of: Type }
    /** A group-mode expression (`group o.user_id`). Transparent in unification. */
    | { kind: 'group'; of: Type }
    /** A window-only expression (`row_number`, `lag`, ...) that must be wrapped by `over`. */
    | { kind: 'window'; of: Type };

export type VarKind = 'type' | 'row';

export interface VarInfo {
    /** Kind once pinned by a row/type constraint; 'flex' until then. */
    kind: 'flex' | 'type' | 'row';
    /** Rigid (skolemized) variables may never be bound — used to check annotations. */
    rigid: boolean;
    /** User-facing name from an annotation, or a generated name for messages. */
    name: string | null;
    /**
     * A named hole (`?name`): never generalized, so every use of the same
     * binding shares one unsolved metavariable until unification fills it.
     */
    hole: boolean;
    /** Type-class constraints which must hold when this variable is bound. */
    classes: ReadonlySet<TypeClass>;
    absorbAsMaybe?: boolean;
}

export interface Scheme {
    /** Quantified variables, in order. */
    vars: { id: number; kind: VarKind; name: string | null; classes: readonly TypeClass[] }[];
    type: Type;
}

/** Raised when two types cannot be unified; carries the resolved operands. */
export class UnifyError extends Error {
    a: Type;
    b: Type;
    constructor(a: Type, b: Type) {
        super('cannot unify');
        this.a = a;
        this.b = b;
    }
}

/** Raised when a type does not implement a required type class. */
export class ConstraintError extends UnifyError {
    constraint: TypeClass;
    constructor(constraint: TypeClass, type: Type) {
        super(type, type);
        this.constraint = constraint;
        this.message = `type does not implement ${constraint}`;
    }
}

const PRIM_NAMES: Record<PrimName, string> = {
    int: 'int', float: 'float', decimal: 'decimal', string: 'string', bool: 'bool',
    date: 'date', timestamp: 'timestamp',
};

export function prim(name: PrimName): Type {
    return { kind: 'prim', name };
}

/** Internal type accepted by SQL three-valued logic predicates. */
export function truthType(): Type {
    return { kind: 'truth' };
}

export function maybeOf(t: Type): Type {
    // Unlike the old `maybe T` design, Maybe is NOT transparent: `maybe T`
    // never unifies with `T`. Nesting is meaningful (Haskell-style).
    return { kind: 'maybe', of: t };
}

/** SQL null extension is idempotent even though explicit Maybe nesting is not. */
export function nullExtendedMaybeOf(t: Type): Type {
    return t.kind === 'maybe' ? t : { kind: 'maybe', of: t, flattenNullExtension: true };
}

export function fun(from: Type, to: Type): Type {
    return { kind: 'fun', from, to };
}

export function listOf(t: Type): Type {
    return { kind: 'list', of: t };
}

export function queryOf(row: Type): Type {
    return { kind: 'query', row };
}

/** Tag a prelude scheme so builtin identity survives first-class bindings. */
export function builtinOf(name: string, of: Type): Type {
    return { kind: 'builtin', name, of };
}

/** Wrap `t` in the aggregate mode: `agg t` ("an aggregate of `t`"). */
export function aggOf(t: Type): Type {
    return t.kind === 'agg' ? t : { kind: 'agg', of: t };
}

/** Wrap `t` in the group mode: `group t` (a GROUP BY key). */
export function groupOf(t: Type): Type {
    return t.kind === 'group' ? t : { kind: 'group', of: t };
}

/** Wrap `t` in the window mode: `window t` (a window-only function result). */
export function windowOf(t: Type): Type {
    return t.kind === 'window' ? t : { kind: 'window', of: t };
}

export function rowOf(fields: [string, Type][], tail: Type | null = null): Type {
    const map = new Map<string, Type>();
    for (const [label, type] of fields) map.set(label, type);
    return { kind: 'row', fields: map, tail };
}

// ---------------------------------------------------------------------------
// TypeUniverse — variable store, resolution, unification
// ---------------------------------------------------------------------------

export class TypeUniverse {
    private bindings = new Map<number, Type>();
    private infos = new Map<number, VarInfo>();
    private nextId = 1;

    fresh(
        kind: 'flex' | 'type' | 'row' = 'flex',
        name: string | null = null,
        classes: readonly TypeClass[] = [],
    ): Type {
        const id = this.nextId++;
        const constrainedKind = kind === 'flex' && classes.length > 0 ? 'type' : kind;
        this.infos = new Map(this.infos).set(id, {
            kind: constrainedKind,
            rigid: false,
            name,
            hole: false,
            classes: new Set(classes),
            absorbAsMaybe: false,
        });
        return { kind: 'var', id };
    }

    /** Create a hole (`?name`): flexible, named, and never generalized. */
    freshHole(kind: 'flex' | 'type' | 'row' = 'flex', name: string): Type {
        const id = this.nextId++;
        this.infos = new Map(this.infos).set(id, {
            kind,
            rigid: false,
            name,
            hole: true,
            classes: new Set(),
            absorbAsMaybe: false,
        });
        return { kind: 'var', id };
    }

    varInfo(id: number): VarInfo {
        const info = this.infos.get(id);
        if (!info) throw new Error(`unknown type variable ${id}`);
        return info;
    }

    /** Copy-on-write rigid flag update (VarInfo objects are never mutated). */
    setVarRigid(id: number, rigid: boolean): void {
        const info = this.infos.get(id);
        if (!info) throw new Error(`unknown type variable ${id}`);
        this.infos = new Map(this.infos).set(id, { ...info, rigid });
    }

    /** Mark a row-tail variable so fields absorbed later become maybe. */
    setVarAbsorbAsMaybe(id: number, absorbAsMaybe: boolean): void {
        const info = this.infos.get(id);
        if (!info) throw new Error(`unknown type variable ${id}`);
        this.infos = new Map(this.infos).set(id, { ...info, absorbAsMaybe });
    }

    /** Require `t` to implement a type class, preserving the constraint on variables. */
    constrain(t: Type, constraint: TypeClass): void {
        const snapshot = this.snapshot();
        try {
            this.constrainInternal(t, constraint);
        } catch (err) {
            this.restore(snapshot);
            throw err;
        }
    }

    private constrainInternal(t: Type, constraint: TypeClass): void {
        const r = this.resolve(t);
        if (r.kind === 'var') {
            const info = this.varInfo(r.id);
            if (info.kind === 'row') throw new ConstraintError(constraint, r);
            if (!info.classes.has(constraint)) {
                this.infos = new Map(this.infos).set(r.id, {
                    ...info,
                    kind: info.kind === 'flex' ? 'type' : info.kind,
                    classes: new Set([...info.classes, constraint]),
                });
            }
            return;
        }
        const functorName: FunctorName | null = r.kind === 'maybe' || r.kind === 'list' || r.kind === 'query'
            ? r.kind
            : null;
        if ((constraint === 'Functor' || constraint === 'Applicative' || constraint === 'Alternative' || constraint === 'Monad')
            && functorName !== null && isContainerTypeClassInstance(constraint, functorName)) {
            return;
        }
        if (r.kind === 'builtin' || r.kind === 'maybe' || r.kind === 'agg'
            || r.kind === 'group' || r.kind === 'window') {
            this.constrainInternal(r.of, constraint);
            return;
        }
        if (r.kind === 'list' && (constraint === 'Semigroup' || constraint === 'Monoid')) {
            return;
        }
        if (r.kind === 'prim'
            && constraint !== 'Functor' && constraint !== 'Applicative' && constraint !== 'Alternative' && constraint !== 'Monad'
            && isTypeClassInstance(constraint, r.name)) {
            return;
        }
        throw new ConstraintError(constraint, r);
    }

    /** Follow variable bindings to the root type. */
    resolve(t: Type): Type {
        let cur = t;
        while (cur.kind === 'var') {
            const bound = this.bindings.get(cur.id);
            if (bound === undefined) return cur;
            cur = bound;
        }
        return cur;
    }

    /** Resolve variables and strip transparent builtin tags for structural checks. */
    peel(t: Type): Type {
        let r = this.resolve(t);
        while (r.kind === 'builtin') r = this.resolve(r.of);
        while (r.kind === 'maybe' && r.flattenNullExtension) {
            const inner = this.resolve(r.of);
            if (inner.kind !== 'maybe') break;
            r = inner;
        }
        return r;
    }

        /** Resolve a type through variable bindings. */
    normalize(t: Type): Type {
        return this.resolve(t);
    }

    /** Free (unbound) variable ids reachable from `t`, resolving bindings. */
    freeVars(t: Type): Set<number> {
        const out = new Set<number>();
        const visit = (x: Type): void => {
            const r = this.resolve(x);
            switch (r.kind) {
                case 'var': out.add(r.id); break;
                case 'maybe': visit(r.of); break;
                case 'fun': visit(r.from); visit(r.to); break;
                case 'list': visit(r.of); break;
                case 'row':
                    for (const f of r.fields.values()) visit(f);
                    if (r.tail) visit(r.tail);
                    break;
                case 'query': visit(r.row); break;
                case 'builtin':
                case 'agg': case 'group': case 'window': visit(r.of); break;
                case 'prim': case 'truth': case 'order': break;
            }
        };
        visit(t);
        return out;
    }

    /** Bind `varId` to `t`; enforces kind, rigidity, and the occurs check. */
    bind(varId: number, t: Type): void {
        if (this.bindings.has(varId)) throw new Error(`type variable ${varId} already bound`);
        const info = this.infos.get(varId)!;
        if (info.rigid && !this.canSpecializeRigidNumeric(info, t)) {
            throw new UnifyError({ kind: 'var', id: varId }, t);
        }
        const r = this.resolve(t);
        if (r.kind === 'var' && r.id === varId) return; // self-binding: no-op
        // Occurs check: the variable must not appear inside `t`.
        if (this.freeVars(t).has(varId)) {
            throw new UnifyError({ kind: 'var', id: varId }, t);
        }
        let thisKind = info.kind;
        if (r.kind === 'var') {
            // Var-to-var bind: propagate the restrictive (row) kind, and
            // reject an explicit row-vs-type conflict.
            const other = this.varInfo(r.id);
            if (thisKind === 'row' && other.kind === 'type') {
                throw new UnifyError({ kind: 'var', id: varId }, t);
            }
            if (thisKind === 'type' && other.kind === 'row') {
                throw new UnifyError({ kind: 'var', id: varId }, t);
            }
            let otherKind = other.kind;
            if (thisKind === 'row') {
                otherKind = 'row';
            } else if (thisKind === 'type' && other.kind === 'flex') {
                otherKind = 'type';
            } else if (other.kind === 'row') {
                thisKind = 'row';
            }
            this.infos = new Map(this.infos).set(r.id, {
                ...other,
                kind: otherKind,
                classes: new Set([...other.classes, ...info.classes]),
                absorbAsMaybe: info.absorbAsMaybe || other.absorbAsMaybe,
            });
        } else {
            // Kind discipline against concrete types: a row-pinned variable
            // can only bind to rows, and a type-pinned variable only to
            // non-rows. First binding pins a flexible variable's kind.
            if (thisKind === 'flex') {
                thisKind = r.kind === 'row' ? 'row' : 'type';
            } else if (thisKind === 'row' && r.kind !== 'row') {
                throw new UnifyError({ kind: 'var', id: varId }, t);
            } else if (thisKind === 'type' && r.kind === 'row') {
                throw new UnifyError({ kind: 'var', id: varId }, t);
            }
            for (const constraint of info.classes) this.constrainInternal(r, constraint);
        }
        if (thisKind !== info.kind) {
            this.infos = new Map(this.infos).set(varId, { ...info, kind: thisKind });
        }
        this.bindings = new Map(this.bindings).set(varId, t);
    }

    /**
     * A rigid (skolemized) variable may be pinned to a concrete type when it
     * is a numeric *literal* (carries a `Num`/`Frac` class) and every one of
     * its classes is satisfied by the target. This lets an annotation
     * specialize a polymorphic numeric literal — `adult: { age: int | r } ->
     * bool = u => u.age >= 18` — where inference proposes `age : Num t, Ord t`.
     * All other rigid bindings remain forbidden.
     */
    private canSpecializeRigidNumeric(info: VarInfo, t: Type): boolean {
        const r = this.resolve(t);
        if (r.kind !== 'prim') return false;
        let numeric = false;
        for (const c of info.classes) {
            // Container classes cannot be satisfied by a concrete scalar.
            if (c === 'Functor' || c === 'Applicative' || c === 'Alternative' || c === 'Monad') {
                return false;
            }
            if (c === 'Num' || c === 'Frac') numeric = true;
            if (!isTypeClassInstance(c as ScalarTypeClass, r.name)) return false;
        }
        return numeric;
    }

    /**
     * Unify two types transactionally: a failed unification leaves no
     * bindings behind. Internal recursion uses `unifyInternal`.
     */
    unify(a: Type, b: Type): Type {
        const snapshot = this.snapshot();
        try {
            return this.unifyInternal(a, b);
        } catch (err) {
            this.restore(snapshot);
            throw err;
        }
    }

    /** Unify two types and require the result to implement a class atomically. */
    unifyConstrained(a: Type, b: Type, constraint: TypeClass): Type {
        const snapshot = this.snapshot();
        try {
            const unified = this.unifyInternal(a, b);
            this.constrainInternal(unified, constraint);
            return unified;
        } catch (err) {
            this.restore(snapshot);
            throw err;
        }
    }

    /** O(1) transaction markers: maps are copy-on-write, so old states stay valid. */
    private snapshot(): { bindings: Map<number, Type>; infos: Map<number, VarInfo>; nextId: number } {
        return { bindings: this.bindings, infos: this.infos, nextId: this.nextId };
    }

    private restore(snapshot: { bindings: Map<number, Type>; infos: Map<number, VarInfo>; nextId: number }): void {
        this.bindings = snapshot.bindings;
        this.infos = snapshot.infos;
        this.nextId = snapshot.nextId;
    }

    /** Unify two types structurally (no implicit Maybe conversion). Throws UnifyError. */
    private unifyInternal(a: Type, b: Type): Type {
        a = this.peelNullExtension(a);
        b = this.peelNullExtension(b);
        if (a === b) return a;
        if (a.kind === 'var' && b.kind === 'var' && a.id === b.id) return a;

        // Builtin tags are transparent; keep the underlying function/value
        // type for structural unification.
        if (a.kind === 'builtin') return this.unifyInternal(a.of, b);
        if (b.kind === 'builtin') return this.unifyInternal(a, b.of);

        if (a.kind === 'var') {
            this.bind(a.id, b);
            return b;
        }
        if (b.kind === 'var') {
            this.bind(b.id, a);
            return a;
        }

        // A SQL predicate may be either non-null bool or nullable bool. The
        // dedicated internal type keeps that choice open until a row schema
        // is known, without making arbitrary scalar types acceptable.
        if (a.kind === 'truth' || b.kind === 'truth') {
            const other = a.kind === 'truth' ? b : a;
            if (other.kind === 'truth') return a;
            if (other.kind === 'prim' && other.name === 'bool') return a.kind === 'truth' ? a : b;
            if (other.kind === 'maybe') {
                const inner = this.resolve(other.of);
                if (inner.kind === 'prim' && inner.name === 'bool') return a.kind === 'truth' ? a : b;
            }
            throw new UnifyError(a, b);
        }

        // `agg`/`group` mode absorption (transparent): unify the
        // payloads and re-wrap. Mixed modes never unify (an aggregate result
        // is not a GROUP BY key and vice versa).
        const aAgg = a.kind === 'agg' ? a.of : null;
        const bAgg = b.kind === 'agg' ? b.of : null;
        const aGroup = a.kind === 'group' ? a.of : null;
        const bGroup = b.kind === 'group' ? b.of : null;
        if (aAgg !== null || bAgg !== null || aGroup !== null || bGroup !== null) {
            if ((aAgg !== null && bGroup !== null) || (aGroup !== null && bAgg !== null)) {
                throw new UnifyError(a, b);
            }
            const inner = this.unifyInternal(aAgg ?? aGroup ?? a, bAgg ?? bGroup ?? b);
            return aAgg !== null || bAgg !== null ? aggOf(inner) : groupOf(inner);
        }

        switch (a.kind) {
            case 'prim':
                if (b.kind === 'prim' && a.name === b.name) return a;
                break;
            case 'fun':
                if (b.kind === 'fun') {
                    this.unifyInternal(a.from, b.from);
                    this.unifyInternal(a.to, b.to);
                    return a;
                }
                break;
            case 'list':
                if (b.kind === 'list') {
                    this.unifyInternal(a.of, b.of);
                    return a;
                }
                break;
            case 'maybe':
                if (b.kind === 'maybe') {
                    this.unifyInternal(a.of, b.of);
                    return a;
                }
                break;
            case 'query':
                if (b.kind === 'query') {
                    this.unifyRow(a.row, b.row);
                    return a;
                }
                break;
            case 'row':
                if (b.kind === 'row') {
                    this.unifyRow(a, b);
                    return a;
                }
                break;
            case 'order':
                if (b.kind === 'order') return a;
                break;
            case 'window':
                if (b.kind === 'window') {
                    this.unifyInternal(a.of, b.of);
                    return a;
                }
                break;
        }
        throw new UnifyError(a, b);
    }

    /** Resolve an idempotent SQL null-extension wrapper once its input is Maybe. */
    private peelNullExtension(t: Type): Type {
        let r = this.resolve(t);
        while (r.kind === 'maybe' && r.flattenNullExtension) {
            const inner = this.resolve(r.of);
            if (inner.kind !== 'maybe') break;
            r = inner;
        }
        return r;
    }

    /** Resolve a row's tail chain, merging fields from materialized tails. */
    resolveRow(r: Extract<Type, { kind: 'row' }>): { fields: Map<string, Type>; tail: Type | null } {
        const fields = new Map<string, Type>();
        for (const [label, type] of r.fields) fields.set(label, type);
        let tail = r.tail;
        while (tail) {
            const rt = this.resolve(tail);
            if (rt.kind === 'row') {
                for (const [label, type] of rt.fields) {
                    if (!fields.has(label)) fields.set(label, type);
                }
                tail = rt.tail;
            } else {
                break; // unbound tail variable
            }
        }
        return { fields, tail };
    }

    private rowTailVar(r: { tail: Type | null }): { id: number } | null {
        if (!r.tail) return null;
        const t = this.resolve(r.tail);
        return t.kind === 'var' ? t : null;
    }

    /**
     * Absorb a label that exists only on one side into the other side's tail.
     * The tail may already be materialized (a previous absorption) — recurse.
     */
    private absorbExtra(label: string, type: Type, row: { fields: Map<string, Type>; tail: Type | null }): void {
        if (!row.tail) {
            throw new UnifyError(rowOf([...row.fields]), rowOf([[label, type]]));
        }
        const t = this.resolve(row.tail);
        if (t.kind === 'row') {
            this.absorbExtra(label, type, t);
            return;
        }
        if (t.kind !== 'var') {
            throw new UnifyError(rowOf([...row.fields]), rowOf([[label, type]]));
        }
        const absorbAsMaybe = this.varInfo(t.id).absorbAsMaybe === true;
        const storedType = absorbAsMaybe ? nullExtendedMaybeOf(type) : type;
        const fresh = this.fresh('row');
        if (absorbAsMaybe && fresh.kind === 'var') this.setVarAbsorbAsMaybe(fresh.id, true);
        this.bind(t.id, { kind: 'row', fields: new Map([[label, storedType]]), tail: fresh });
    }

    /** Unify two rows (or row variables). Shared labels unify; extras move into open tails. */
    unifyRow(a: Type, b: Type): void {
        a = this.resolve(a);
        b = this.resolve(b);
        if (a.kind === 'var' && b.kind === 'var') {
            if (a.id !== b.id) this.bind(a.id, b);
            return;
        }
        if (a.kind === 'var') {
            if (b.kind !== 'row') throw new UnifyError(a, b);
            this.bind(a.id, b);
            return;
        }
        if (b.kind === 'var') {
            if (a.kind !== 'row') throw new UnifyError(a, b);
            this.bind(b.id, a);
            return;
        }
        if (a.kind !== 'row' || b.kind !== 'row') throw new UnifyError(a, b);

        const r1 = this.resolveRow(a);
        const r2 = this.resolveRow(b);
        const labels = new Set<string>([...r1.fields.keys(), ...r2.fields.keys()]);
        for (const label of labels) {
            const f1 = r1.fields.get(label);
            const f2 = r2.fields.get(label);
            if (f1 && f2) {
                this.unifyInternal(f1, f2);
            } else if (f1) {
                this.absorbExtra(label, f1, r2);
            } else {
                this.absorbExtra(label, f2!, r1);
            }
        }
        // Tail closure: after absorption, deep-resolve both rows. The tails are
        // now unbound variables (or nothing) — no recursion needed.
        const rr1 = this.resolveRow(a);
        const rr2 = this.resolveRow(b);
        const t1 = rr1.tail ? this.resolve(rr1.tail) : null;
        const t2 = rr2.tail ? this.resolve(rr2.tail) : null;
        const empty = { kind: 'row', fields: new Map<string, Type>(), tail: null } as Type;
        if (t1 && t2) {
            if (t1.kind === 'var' && t2.kind === 'var') this.unifyInternal(t1, t2);
            else if (t1.kind === 'row' && t2.kind === 'row') this.unifyRow(t1, t2);
            else throw new UnifyError(a, b);
        } else if (t1) {
            if (t1.kind === 'row') this.unifyRow(t1, empty);
            // Sealing a rigid tail with an empty row adds no information — it
            // just closes the row (annotation narrowing); leave it free.
            else if (t1.kind === 'var' && !this.varInfo(t1.id).rigid) this.bind(t1.id, empty);
        } else if (t2) {
            if (t2.kind === 'row') this.unifyRow(t2, empty);
            else if (t2.kind === 'var' && !this.varInfo(t2.id).rigid) this.bind(t2.id, empty);
        }
    }

    /**
     * Read-only field lookup for hover/completion and other non-inference
     * consumers. Never extends or binds the row.
     */
    lookupField(row: Type, label: string): { type: Type; open: boolean } | null {
        const r = this.resolve(row);
        if (r.kind !== 'row') return null;
        const resolved = this.resolveRow(r);
        const f = resolved.fields.get(label);
        return f ? { type: f, open: true } : null;
    }

    /**
     * Field access during inference: reads the field when present, and when
     * the row is open/unconstrained, intentionally extends it with the field.
     * Null only when the row is closed without `l`.
     */
    fieldOf(row: Type, label: string): { type: Type; open: boolean } | null {
        const known = this.lookupField(row, label);
        if (known) return known;
        const r = this.resolve(row);
        if (r.kind === 'var') {
            // An unconstrained variable becomes an open row with the field.
            const fieldType = this.fresh('flex');
            const tail = this.fresh('row');
            this.bind(r.id, { kind: 'row', fields: new Map([[label, fieldType]]), tail });
            return { type: fieldType, open: true };
        }
        if (r.kind !== 'row') return null;
        const resolved = this.resolveRow(r);
        if (resolved.tail) {
            // Open row: extend the tail with the fresh field. The returned
            // type must BE the type stored in the row, so later constraints
            // (e.g. a comparison) propagate into the row.
            const tailVar = this.rowTailVar(resolved);
            if (tailVar) {
                const fieldType = this.fresh('flex');
                const fresh = this.fresh('row');
                this.bind(tailVar.id, { kind: 'row', fields: new Map([[label, fieldType]]), tail: fresh });
                return { type: fieldType, open: true };
            }
            return { type: this.fresh('flex'), open: true };
        }
        return null;
    }

    // -----------------------------------------------------------------------
    // Schemes
    // -----------------------------------------------------------------------

    /** Generalize `t` over variables not free in `envTypes` and not holes. */
    generalize(envTypes: Type[], t: Type): Scheme {
        const envFree = new Set<number>();
        for (const e of envTypes) {
            for (const v of this.freeVars(e)) envFree.add(v);
        }
        const free = [...this.freeVars(t)].filter(v => {
            if (envFree.has(v)) return false;
            const info = this.infos.get(v);
            return info !== undefined && !info.hole;
        });
        const whole = this.resolve(t);
        const vars: Scheme['vars'] = [];
        for (const id of free) {
            const info = this.infos.get(id)!;
            // Haskell-style defaulting for ambiguous numeric *literals*: when
            // the whole type IS a single numeric literal variable (e.g.
            // `x = 1`, `x = 1.5`, `x = 1 + 2.5`) it is pinned to its default
            // (`int` for Num, `float` for Frac) rather than left polymorphic,
            // so a constant reads as a concrete number. Variables that occur
            // inside a row/function/list (`add = x => y => x + y`,
            // `xs = [1]`) are unaffected and stay quantified.
            if (whole.kind === 'var' && whole.id === id) {
                if (info.classes.has('Frac')) {
                    this.bindings.set(id, prim('float'));
                    continue;
                }
                if (info.classes.has('Num')) {
                    this.bindings.set(id, prim('int'));
                    continue;
                }
            }
            vars.push({
                id,
                kind: info.kind === 'row' ? 'row' : 'type',
                name: info.name,
                classes: [...info.classes],
            });
        }
        return { vars, type: t };
    }

    /** Instantiate a scheme: fresh flexible variables for quantified ones. */
    instantiate(s: Scheme): Type {
        if (s.vars.length === 0) return s.type;
        const subst = new Map<number, Type>();
        for (const v of s.vars) {
            const fresh = this.fresh(v.kind === 'row' ? 'row' : 'flex', v.name, v.classes);
            subst.set(v.id, fresh);
        }
        return this.substitute(subst, s.type);
    }

    /** Skolemize free variables of `t`: mark them rigid (may not be bound). */
    skolemize(t: Type): { type: Type; restore: () => void } {
        const vars = [...this.freeVars(t)];
        const prev = new Map<number, boolean>();
        for (const id of vars) {
            prev.set(id, this.varInfo(id).rigid);
            this.setVarRigid(id, true);
        }
        return {
            type: t,
            restore: () => {
                for (const [id, rigid] of prev) this.setVarRigid(id, rigid);
            },
        };
    }

    private substitute(subst: Map<number, Type>, t: Type): Type {
        const r = this.resolve(t);
        if (r.kind === 'var') {
            return subst.get(r.id) ?? r;
        }
        switch (r.kind) {
            case 'maybe': {
                const of = this.substitute(subst, r.of);
                return r.flattenNullExtension ? nullExtendedMaybeOf(of) : maybeOf(of);
            }
            case 'fun': return fun(this.substitute(subst, r.from), this.substitute(subst, r.to));
            case 'list': return listOf(this.substitute(subst, r.of));
            case 'row': {
                const fields = new Map<string, Type>();
                for (const [label, type] of r.fields) fields.set(label, this.substitute(subst, type));
                const tail = r.tail ? this.substitute(subst, r.tail) : null;
                return { kind: 'row', fields, tail };
            }
            case 'query': return queryOf(this.substitute(subst, r.row));
            case 'builtin': return builtinOf(r.name, this.substitute(subst, r.of));
            case 'agg': return aggOf(this.substitute(subst, r.of));
            case 'group': return groupOf(this.substitute(subst, r.of));
            case 'window': return windowOf(this.substitute(subst, r.of));
            case 'prim': case 'truth': case 'order': return r;
        }
    }

    // -----------------------------------------------------------------------
    // Pretty printing
    // -----------------------------------------------------------------------

    /**
     * Render a type for messages. Maybe is always visible as
     * `(maybe T)`; holes render as `?name`.
     *
     * Rows are flattened through their open-tail chain (an open row is a
     * linked list of single-field rows after unification) and shown as one
     * record with a single `| tail` — `{ id: int | { name: string | r } }`
     * renders as `{ id: int, name: string | r }`. When `friendlyVars` is
     * true, unnamed variables render as `r`/`t` instead of `r12`/`t12` —
     * used for hover, where only one type is shown at a time.
     */
    pretty(t: Type, showNullable: boolean = false, friendlyVars: boolean = false): string {
        const p = (x: Type, paren: boolean): string => {
            const r = this.peelNullExtension(x);
            switch (r.kind) {
                case 'var': {
                    const info = this.infos.get(r.id)!;
                    if (info.hole) return `?${info.name ?? `h${r.id}`}`;
                    if (info.name) return info.name;
                    if (friendlyVars) return info.kind === 'row' ? 'r' : 't';
                    return info.kind === 'row' ? `r${r.id}` : `t${r.id}`;
                }
                case 'prim': return PRIM_NAMES[r.name];
                case 'truth': return 'bool?';
                case 'maybe':
                    return `(maybe ${p(r.of, false)})`;
                case 'list': return `[${p(r.of, false)}]`;
                case 'row': {
                    const { fields, tail } = this.resolveRow(r);
                    const labels = [...fields.keys()].sort();
                    const body = labels.map(l => `${l}: ${p(fields.get(l)!, false)}`).join(', ');
                    const tailText = tail ? ` | ${p(tail, false)}` : '';
                    return `{ ${body}${tailText} }`;
                }
                case 'query': return `query ${p(r.row, false)}`;
                case 'builtin': return p(r.of, paren);
                case 'agg': return `agg ${p(r.of, false)}`;
                case 'group': return `group ${p(r.of, false)}`;
                case 'window': return `window ${p(r.of, false)}`;
                case 'fun': {
                    const s = `${p(r.from, true)} -> ${p(r.to, false)}`;
                    return paren ? `(${s})` : s;
                }
                case 'order': return 'order';
            }
        };
        const body = p(t, false);
        const constraints: string[] = [];
        for (const id of this.freeVars(t)) {
            const info = this.varInfo(id);
            for (const typeClass of info.classes) {
                constraints.push(`${typeClass} ${p({ kind: 'var', id }, false)}`);
            }
        }
        return constraints.length > 0 ? `${constraints.join(', ')} => ${body}` : body;
    }

    /** Pretty-print a row for "available: ..." lists: `id, name, age`. */
    rowLabels(t: Type): string[] {
        const r = this.resolve(t);
        if (r.kind !== 'row') return [];
        return [...this.resolveRow(r).fields.keys()].sort();
    }
}
