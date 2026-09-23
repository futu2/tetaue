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

/**
 * Numeric literals stay *category* variables even though the language has no
 * type classes: a literal is resolved lazily to whatever numeric primitive
 * its context demands, falling back to the category default when nothing
 * demands anything. This keeps `u.balance / 2` working on a `float` column
 * and refuses `u.age + 1.5` on an `int` column, exactly as the old
 * `Num`/`Frac` constraints did — but the rule lives in unification, not in a
 * class table.
 */
export type LiteralCategory = 'num' | 'frac' | 'decimal';

interface LiteralCategoryInfo {
    /** The concrete primitives this literal may still resolve to. */
    candidates: readonly PrimName[];
    /** The primitive it becomes when nothing constrains it. */
    fallback: PrimName;
}

const LITERAL_CATEGORIES: Readonly<Record<LiteralCategory, LiteralCategoryInfo>> = {
    // `1` — any numeric primitive.
    num: { candidates: ['int', 'float', 'decimal'], fallback: 'int' },
    // `1.5` — a fractional primitive, never int.
    frac: { candidates: ['float', 'decimal'], fallback: 'float' },
    // `1.5d` — an explicit decimal literal.
    decimal: { candidates: ['decimal'], fallback: 'decimal' },
};

export type Type =
    | { kind: 'var'; id: number }
    | { kind: 'prim'; name: PrimName }
    /** A SQL predicate: either bool or maybe bool (three-valued logic). */
    | { kind: 'maybe'; of: Type; flattenNullExtension?: boolean }
    | { kind: 'fun'; from: Type; to: Type }
    | { kind: 'list'; of: Type }
    /** A record row: unordered label → type map, plus an optional tail variable. */
    | { kind: 'row'; fields: Map<string, Type>; tail: Type | null }
    /**
     * The FIELD-WISE SQL null extension of a row: `nullRow s` is the schema of
     * the null-extended side of an outer join. Every field `a: τ` of `s`
     * becomes `a: (maybe τ)` (idempotently — an already-maybe field does not
     * gain a second layer), while the row itself is always present.
     *
     * This is what the merger of `joinLeft`/`joinRight`/`joinFull` sees, and
     * it is NOT the same type as `maybe s`:
     *   - `maybe s`   — the whole row may be absent (no such case in SQL);
     *   - `nullRow s` — the row is present, each of its fields may be NULL.
     * `nullRow` reduces lazily: it stays symbolic while `of` is an unbound row
     * variable and expands into a concrete all-maybe row once `of` is known
     * (see TypeUniverse.reduceNullRow, applied by `peel`).
     */
    | { kind: 'nullRow'; of: Type; tail: Type | null }
    | { kind: 'query'; row: Type }
    /** An ORDER BY item (`asc`/`desc`). */
    /**
     * A prelude builtin reference. Transparent in unification and pretty
     * printing, but the tag survives generalization/instantiation so a
     * builtin bound to a user name (`by = sort`) keeps its special static
     * checks — referential transparency at the type level.
     */
    | { kind: 'builtin'; name: string; of: Type }
    /**
     * An overload set: one name bound to several definitions distinguished by
     * type (`abs : int -> int`, `abs : float -> float`, ...). It is transparent
     * to the value-level evaluator — `selectOverload` picks the alternative
     * whose arguments the actual ones unify with — but it is what makes
     * name overloading expressible WITHOUT type classes, so a base library can
     * declare `ceil` once per numeric type instead of relying on a `Num`
     * constraint the compiler owns.
     */
    | { kind: 'overload'; alternatives: readonly Type[] };

export type VarKind = 'type' | 'row';

/** A rollback point for a speculative unification run (overload trials). */
export interface UniverseSnapshot {
    bindings: Map<number, Type>;
    infos: Map<number, VarInfo>;
    nextId: number;
}

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
    /**
     * A numeric literal's category (`1`, `1.5`, `1.5d`), or null for every
     * other variable. A literal variable still resolves to a concrete numeric
     * primitive, but which one is decided by unification (or by the category
     * fallback), so `1` adapts to an int, float, or decimal context.
     */
    literal: LiteralCategory | null;
    absorbAsMaybe?: boolean;
}

export interface Scheme {
    /** Quantified variables, in order. */
    vars: { id: number; kind: VarKind; name: string | null }[];
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

const PRIM_NAMES: Record<PrimName, string> = {
    int: 'int', float: 'float', decimal: 'decimal', string: 'string', bool: 'bool',
    date: 'date', timestamp: 'timestamp',
};

export function prim(name: PrimName): Type {
    return { kind: 'prim', name };
}

/** Internal type accepted by SQL three-valued logic predicates. */


export function maybeOf(t: Type): Type {
    // Unlike the old `maybe T` design, Maybe is NOT transparent: `maybe T`
    // never unifies with `T`. Nesting is meaningful (Haskell-style).
    return { kind: 'maybe', of: t };
}

/** SQL null extension is idempotent even though explicit Maybe nesting is not. */
export function nullExtendedMaybeOf(t: Type): Type {
    return t.kind === 'maybe' ? t : { kind: 'maybe', of: t, flattenNullExtension: true };
}

/** The field-wise null extension of a row: `nullRow r` (see the `Type` union). */
export function nullRowOf(t: Type, tail: Type | null = null): Type {
    // An idempotent wrapper never stacks (same rule as nullExtendedMaybeOf).
    if (t.kind === 'nullRow') return t;
    return { kind: 'nullRow', of: t, tail };
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

/**
 * Build an overload set from a name's several definitions. A single-element
 * set collapses to that alternative, so ordinary bindings are unaffected.
 */
export function overloadOf(alternatives: readonly Type[]): Type {
    return alternatives.length === 1
        ? alternatives[0]!
        : { kind: 'overload', alternatives };
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
    ): Type {
        const id = this.nextId++;
        this.infos = new Map(this.infos).set(id, {
            kind,
            rigid: false,
            name,
            hole: false,
            literal: null,
            absorbAsMaybe: false,
        });
        return { kind: 'var', id };
    }

    /** A variable standing for a numeric literal (`1`, `1.5`, `1.5d`). */
    freshLiteral(category: LiteralCategory): Type {
        const id = this.nextId++;
        this.infos = new Map(this.infos).set(id, {
            kind: 'type',
            rigid: false,
            name: null,
            hole: false,
            literal: category,
            absorbAsMaybe: false,
        });
        return { kind: 'var', id };
    }

    /** Whether `t` (resolved) is an unresolved numeric literal. */
    isLiteral(t: Type): boolean {
        const r = this.resolve(t);
        return r.kind === 'var' && this.varInfo(r.id).literal !== null;
    }

    /** Create a hole (`?name`): flexible, named, and never generalized. */
    freshHole(kind: 'flex' | 'type' | 'row' = 'flex', name: string): Type {
        const id = this.nextId++;
        this.infos = new Map(this.infos).set(id, {
            kind,
            rigid: false,
            name,
            hole: true,
            literal: null,
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
    /** `t` must not need a type class: the language no longer has any. */
    constrain(_t: Type, _constraint: string): void {
        // Type classes were removed from the language; every call site that
        // used to constrain now relies on plain unification. Kept as a no-op
        // so external callers (and older plugins) do not crash.
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
        // A null extension whose row is now known expands into an all-maybe
        // row, so every structural consumer (field access, unification,
        // printing) sees it as an ordinary row.
        if (r.kind === 'nullRow') r = this.reduceNullRow(r);
        return r;
    }

    /**
     * Expand `nullRow r` into the concrete row `r` with every field
     * null-extended (idempotently). Returns the `nullRow` unchanged while its
     * inner row is still an unbound variable — the extension stays symbolic
     * until the row's fields are known, which is what lets an outer-join
     * merger be typed before (or independently of) the joined schema.
     */
    private reduceNullRow(r: Extract<Type, { kind: 'nullRow' }>): Type {
        const inner = this.peel(r.of);
        if (inner.kind !== 'row') return r;
        const resolved = this.resolveRow(inner);
        const fields = new Map<string, Type>();
        for (const [label, type] of resolved.fields) fields.set(label, this.nullExtend(type));
        return { kind: 'row', fields, tail: resolved.tail ?? r.tail };
    }

    /** Add SQL nullability without nesting an existing Maybe (field-wise). */
    nullExtend(t: Type): Type {
        return this.peel(t).kind === 'maybe' ? t : nullExtendedMaybeOf(t);
    }

    /** Public form of `reduceNullRow` for callers outside the universe. */
    reduceNullRowType(t: Type): Type {
        const r = this.resolve(t);
        return r.kind === 'nullRow' ? this.reduceNullRow(r) : r;
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
                case 'nullRow':
                    visit(r.of);
                    if (r.tail) visit(r.tail);
                    break;
                case 'query': visit(r.row); break;
                case 'builtin': visit(r.of); break;
                case 'overload': for (const alt of r.alternatives) visit(alt); break;
                case 'prim': break;
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
                literal: info.literal ?? other.literal,
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
            // A numeric literal only resolves to a primitive its category
            // admits: `1.5` can meet a float/decimal column but never an int
            // one, while `1` fits all three.
            if (info.literal !== null && r.kind === 'prim'
                && !LITERAL_CATEGORIES[info.literal].candidates.includes(r.name)) {
                throw new UnifyError({ kind: 'var', id: varId }, t);
            }
        }
        if (thisKind !== info.kind) {
            this.infos = new Map(this.infos).set(varId, { ...info, kind: thisKind });
        }
        this.bindings = new Map(this.bindings).set(varId, t);
    }

    /**
     * A rigid (skolemized) numeric literal may still be pinned to a concrete
     * numeric primitive its category admits. This lets an annotation
     * specialize a literal — `adult: { age: int | r } -> bool = u => u.age >=
     * 18` compares `age` against the literal `18` — while every other rigid
     * binding stays forbidden, so an annotation can never be satisfied by
     * silently narrowing a genuine type variable.
     */
    private canSpecializeRigidNumeric(info: VarInfo, t: Type): boolean {
        if (info.literal === null) return false;
        const r = this.resolve(t);
        if (r.kind !== 'prim') return false;
        return LITERAL_CATEGORIES[info.literal].candidates.includes(r.name);
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

    /**
     * O(1) transaction markers: maps are copy-on-write, so old states stay
     * valid. Public because overload resolution runs speculative trials that
     * must be rolled back — see `Inferencer.resolveOverload`.
     */
    snapshotForTrial(): UniverseSnapshot {
        return { bindings: this.bindings, infos: this.infos, nextId: this.nextId };
    }

    restoreTrial(snapshot: UniverseSnapshot): void {
        this.bindings = snapshot.bindings;
        this.infos = snapshot.infos;
        this.nextId = snapshot.nextId;
    }

    private snapshot(): UniverseSnapshot {
        return this.snapshotForTrial();
    }

    private restore(snapshot: UniverseSnapshot): void {
        this.restoreTrial(snapshot);
    }

    /** Unify two types structurally (no implicit Maybe conversion). Throws UnifyError. */
    private unifyInternal(a: Type, b: Type): Type {
        a = this.peelNullExtension(a);
        b = this.peelNullExtension(b);
        // A field-wise null-extended row unifies as the all-maybe row it
        // denotes, so an outer-join merger's parameter can meet either a
        // `nullRow s` from the scheme or a hand-written `{ a: (maybe τ) }`
        // annotation. Symbolic `nullRow` (inner row still variable) stays as
        // is and unifies only with another null row or a row variable.
        a = this.reduceNullRowType(a);
        b = this.reduceNullRowType(b);
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
            case 'nullRow':
                // Only reachable for a SYMBOLIC extension (a known inner row
                // was already reduced above): unify the rows being extended, so
                // the fields materialize on both sides when the schema arrives.
                if (b.kind === 'nullRow') {
                    this.unifyRow(this.resolve(a.of), this.resolve(b.of));
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
        // Keep the reduction consistent with `peel`: a null extension over a
        // known row is the all-maybe row, not a wrapper.
        if (r.kind === 'nullRow') r = this.reduceNullRow(r);
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
            // Ambiguous numeric *literals* default to a concrete type: when
            // the whole type IS a single literal variable (`x = 1`,
            // `x = 1.5`), it is pinned to `int` / `float` rather than left
            // polymorphic, so a constant reads as a number. Literal variables
            // inside a function/row/list (`add = x => y => x + y`) are NOT
            // defaulted — they generalize like any other variable, and the
            // repository's default numeric type is `int`.
            if (whole.kind === 'var' && whole.id === id && info.literal !== null) {
                this.bindings = new Map(this.bindings).set(id, prim(LITERAL_CATEGORIES[info.literal].fallback));
                continue;
            }
            vars.push({
                id,
                kind: info.kind === 'row' ? 'row' : 'type',
                name: info.name,
            });
        }
        return { vars, type: t };
    }

    /** Instantiate a scheme: fresh flexible variables for quantified ones. */
    instantiate(s: Scheme): Type {
        if (s.vars.length === 0) return s.type;
        const subst = new Map<number, Type>();
        for (const v of s.vars) {
            // A quantified literal variable is re-created with its category so
            // a polymorphic numeric definition keeps its adaptivity.
            const info = this.infos.get(v.id);
            const fresh = info?.literal != null
                ? this.freshLiteral(info.literal)
                : this.fresh(v.kind === 'row' ? 'row' : 'flex', v.name);
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
            case 'nullRow': {
                // Substituting the inner row can make the extension reducible.
                const of = this.substitute(subst, r.of);
                const tail = r.tail ? this.substitute(subst, r.tail) : null;
                return this.reduceNullRowType(nullRowOf(of, tail));
            }
            case 'builtin': return builtinOf(r.name, this.substitute(subst, r.of));
            case 'overload': return overloadOf(r.alternatives.map(a => this.substitute(subst, a)));
            case 'prim': return r;
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
                case 'nullRow':
                    // A symbolic extension prints as the null extension of the
                    // row it wraps; a reducible one already peeled to a row.
                    return `${p(this.resolve(r.of), true)}?`;
                case 'query': return `query ${p(r.row, false)}`;
                case 'builtin': return p(r.of, paren);
                case 'overload': return r.alternatives.map(a => p(a, true)).join(' | ');
                case 'fun': {
                    const s = `${p(r.from, true)} -> ${p(r.to, false)}`;
                    return paren ? `(${s})` : s;
                }
            }
        };
        // Type classes no longer exist, so a type never renders constraints.
        return p(t, false);
    }

    /** Pretty-print a row for "available: ..." lists: `id, name, age`. */
    rowLabels(t: Type): string[] {
        const r = this.resolve(t);
        if (r.kind !== 'row') return [];
        return [...this.resolveRow(r).fields.keys()].sort();
    }
}
