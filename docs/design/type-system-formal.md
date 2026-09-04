# tetaue type system — formal core

Status: **implemented (v5)** — `src/language/types.ts`, `src/language/inference.ts`,
`src/language/builtin.ts`, and the `Type` grammar.

This document is the **formal** treatment of the type system: the language of
types, the unification and generalization judgments the implementation
actually executes, the laws those judgments obey, and the warts that remain
(the delta between the theory and the code). The user-facing description is
[`type-system.md`](type-system.md). Every rule below is grounded in a
file:line anchor in the current source.

The whole system is intentionally small. Its vocabulary is:

```
type   — the types themselves (monotypes + schemes)
mode   — one type constructor with three tags: agg, group, window
row    — open records with a tail variable
maybe  — a distinct constructor (no implicit conversion)
hole   — a named, never-generalized metavariable
```

## 1. Types

```text
Prim    ::= int | float | decimal | string | bool | date | timestamp
τ       ::= α                       -- type/row variable (kind-flexible)
          | b                       -- b ∈ Prim
          | maybe τ                 -- SQL NULL, explicit (types.ts:151)
          | τ1 → τ2                 -- functions (types.ts:162)
          | [τ]                     -- lists (types.ts:166)
          | { ℓ: τ, …, | ρ }        -- open record row (types.ts:189)
          | query τ                 -- tables / pipelines (types.ts:170)
          | order                   -- asc/desc items (builtin.ts:151-152)
          | mode m τ                -- m ∈ {agg, group, window} (types.ts:180)
          | truth                   -- bool ∨ maybe bool (types.ts:147)
          | builtin name τ          -- tagged builtin, transparent (types.ts:175)
ρ       ::= α | { ℓ: τ, …, | ρ }    -- a row type (tail position)
m       ::= agg | group | window    -- pipeline modes (types.ts:24)
```

Two positions are distinguishable syntactically: a lowercase variable in a
record-tail position is a **row** variable; elsewhere it is a **type**
variable (kinds by position, PureScript-style — grammar `tetaue.langium:101`).
Holes `?name` are variables with `hole: true` (types.ts:93, 223): flexible,
named, and excluded from generalization.

## 2. Scheme and the variable store

A scheme is a quantified monotype plus its constraints (types.ts:110):

```text
σ ::= ∀α̅. C ⇒ τ            C ::= Num t | Frac t | Eq t | Ord t | DateTime t
                          | Semigroup t | Monoid t
                          | Functor f | Applicative f | Alternative f | Monad f
```

The `TypeUniverse` (types.ts:199) is a mutable store with **copy-on-write
maps** (`bindings`, `infos`, and a monotonic id counter). This gives:

- **O(1) transactions**: `unify`, `unifyConstrained`, and `constrain` snapshot
  before and restore on failure, so a failed unification leaves **no**
  bindings behind (types.ts:434, 445, 257).
- **Kinds**: a fresh variable is `flex`; the first bind to a row pins it
  `row`, anything else pins it `type` (types.ts:351, 400-406). A row-pinned
  variable may never bind a non-row and vice versa.
- **Rigidity**: `skolemize` marks free variables rigid for the duration of an
  annotation check; a rigid variable may not be bound — except a *numeric
  literal* variable carrying `Num`/`Frac`, which may be pinned to a concrete
  primitive that satisfies all its classes (types.ts:415 `canSpecializeRigidNumeric`).
- **Holes**: never generalized, so every use of a binding shares one
  metavariable until unification fills it (types.ts:723 `generalize` skips
  `hole` variables).

## 3. Unification

`unify τ₁ τ₂ = τ` is **structural, transactional, and acyclic** (types.ts:469
`unifyInternal`). It is not the *most general* unifier of logic programming —
it is a deterministic, ordered rewrite that may commit bindings the caller
must be willing to keep (see §6 for the consequences). The rules, in the
order the code applies them:

```text
[null-ext]  peel (maybe∙ τ)    -- flattenNullExtension wrappers idempotent
            (types.ts:558)
[refl]      τ ~ τ
[builtin]   builtin x τ ~ τ'   when τ ~ τ'            -- transparent (types.ts:473-476)
[var]       α ~ τ              when α unbound, kind-compatible,
                               τ does not mention α (occurs check, types.ts:360)
[varvar]    α ~ β              propagate row-kind and constraint intersection
                               (types.ts:372-394)
[maybe]     maybe τ1 ~ maybe τ2 when τ1 ~ τ2          -- never with plain τ
[mode]      mode m τ1 ~ mode m τ2 when τ1 ~ τ2        -- same m only (types.ts:501)
[mode-type] mode m τ ~ τ'      when τ ~ τ'            -- re-wrap as mode m
[truth]     truth ~ bool | truth ~ maybe bool
[struct]    primitive/arrow/list/query/row/order      -- by kind (types.ts:527-553)
```

**Mode unification** is the single rule that replaced three ad-hoc cases:

```text
mode m a  ~  mode m b     ⟹  mode m (a ~ b)      (types.ts:501)
mode m a  ~  b            ⟹  mode m (a ~ b)      (types.ts:504)
a         ~  mode m b     ⟹  mode m (a ~ b)      (types.ts:506)
mode m a  ~  mode m' b, m ≠ m'  ⟹  ⊥            (mixed modes never unify)
```

So an aggregate is not a group key, and a group key is not an aggregate — but
an aggregate unifies with a plain type through its payload, and `modeOf` is
idempotent within a mode (types.ts:180). The *discipline* (which rows may
carry which modes) is **not** in unification; it lives in the fold/map/over
mode checks (§8).

**Rows** are the only non-trivial case. A row is an unordered map plus an
optional tail variable. `unifyRow` (types.ts:617):

1. Resolve both sides through their tail chains (`resolveRow`, types.ts:569).
2. Shared labels unify recursively.
3. A label present on only one side is **absorbed into the other side's open
   tail** (`absorbExtra`, types.ts:597), materializing the tail into a
   single-field row with a fresh tail. Absorption is exactly the pure row
   unification of Rémy — with one twist: the tail's `absorbAsMaybe` flag makes
   absorbed fields null-extended (§7).
4. The remaining tails are sealed against an empty row unless rigid
   (types.ts:671-686).

The occurs check (types.ts:360) prevents `α ~ maybe α` — Maybe is strict, so
`T` and `maybe T` never unify (verified in `test/types.test.ts`
"maybe is a distinct type constructor").

**Field access** is an operation, not a unification: `fieldOf` (types.ts:689)
reads a field when present and *intentionally extends* an open/unconstrained
row with the field, returning the stored (fresh) type so later constraints
propagate into the row. This is what lets dynamic tables accumulate one schema
from all their uses (§10).

## 4. Generalization and instantiation

```text
generalize(env, τ) = ∀α̅. C ⇒ τ     α̅ = free(τ) \ (free(env) ∪ holes)
instantiate(σ)    = fresh α̅        -- one fresh flexible var per quantified var
```

(types.ts:723 `generalize`, types.ts:765 `instantiate`.) Generalization happens
at module bindings and `let` bindings (`inference.ts:558`, `inference.ts:674`),
never at lambda parameters — ML-style. Constraints travel with quantified
variables and are recreated on instantiation, so `add = x => y => x + y`
infers `Num t => t -> t -> t`, not the unsound `t -> t -> t`
(`test/types.test.ts` "arithmetic lambdas retain a Num constraint").

**Numeric-literal defaulting** lives inside generalization: when the whole
type is a single numeric-literal variable, it is pinned to `int` (`Num`) or
`float` (`Frac`) instead of being quantified (types.ts:733-751). So `x = 1 :
int` and `x = 1.5 : float`, while `add` and `[1]` stay polymorphic. This is
the one place generalization *mutates* bindings.

**Annotations are checked signatures, not unification targets.** A binding
annotation is translated, the inferred type is skolemized (all its free
variables made rigid), and the annotation is unified against the *rigid*
inferred type (inference.ts:482, 540-555). The skolemization is what rejects
`id : int -> int = x => x`: the inferred `t -> t` cannot specialize to
`int -> int`. Two deliberate exceptions *define* rather than check:
- a bare `table "t"` annotation **defines the row schema**
  (inference.ts:509-520, 652-660);
- a bare `mempty` annotation defines the monoid instance
  (inference.ts:521-534).
A numeric *literal* in a rigid position is allowed to specialize through
`canSpecializeRigidNumeric` (types.ts:415) — `adult : { age: int | r } -> bool
= u => u.age >= 18` where inference proposes `age : Num t, Ord t`.

## 5. Type classes (closed, compiler-owned)

`TYPE_CLASS_INSTANCES` (types.ts:29) and the container table (types.ts:45-53)
are closed and not user-extensible:

```text
Num, Frac, Eq, Ord, DateTime, Semigroup, Monoid   -- scalar classes (types.ts:29)
Functor:  maybe, [τ], query                       -- higher-kinded, closed
Applicative/Alternative/Monad:  maybe, [τ]        -- (types.ts:45-53)
```

`constrainInternal` (types.ts:267) adds a constraint to a flexible variable,
checks a closed instance on a concrete type, and recurses through
`builtin`/`maybe`/`mode` wrappers. Because the container classes are not
expressible by a scalar table, `Functor f` cannot be declared by users — the
"typeclasses" are a design fiction over a closed instance table, not an open
class system (see §11).

## 6. The transparency stack and what unification leaves open

Unification treats several constructors as *transparent* — they unify through
their payload — but the type-checking pass deliberately re-inspects the raw,
**pre-unification** field types for mode discipline (§8) and nullability
(§7). This split is the central design tension of the system:

- **`builtin` tags** are transparent to unification and pretty-printing but
  survive generalization/instantiation (types.ts:473, 855), so `by = sort`
  keeps its special static checks — referential transparency at the type
  level (`inference.ts:288`, `taggedOperator`/`taggedBuiltin` at
  inference.ts:331, 338).
- **`mode`** unifies per-mode (§3) but the *shape checks* (fold entries must
  be `agg`/`group`, map projections must not contain `group`/`order`/`window`,
  `over` needs `agg`/`window`) run on peeled field types in `inferFold`
  (inference.ts:2094), `inferMap` (inference.ts:2186), and `inferOver`
  (inference.ts:1781).
- **`maybe`** is *strict* in unification but *relaxed in one direction*:
  a nullable column meeting a polymorphic literal (`v.s + 1` on
  `v.s : (maybe int)`) is accepted and stays maybe, because inside an open
  lambda nullability flows in at row unification after the literal has
  adapted. Two columns (`v.s + v.g`) fail — not by a guard but because
  unifying both operands into one numeric variable forces `(maybe int) ~ int`,
  violating Maybe strictness. `rejectModeOperand` (inference.ts:982) only
  rejects when nullability/mode is *already known* (outer-join mergers,
  ascriptions).

## 7. SQL NULL and outer joins

`maybe` is the type of SQL NULL. `null : ∀a. maybe a`, `just : a -> maybe a`,
`from_maybe : a -> maybe a -> a`, `is_null : maybe a -> bool` (builtin.ts:243-248).
There is **no** implicit `T → maybe T`.

**Outer joins** expose the null-extended input as a maybe *row* to the merger
(`joinScheme`, builtin.ts:108): `joinLeft` makes the right row maybe,
`joinRight` the left, `joinFull` both. Field access through a maybe row
produces a maybe field without double-nesting: `nullExtend` (inference.ts:793)
is the idempotent null extension (`nullExtendedMaybeOf`, types.ts:158), and a
maybe row accessed twice stays `maybe τ` (verified: `main : query { cid: (maybe int), oid: int }`
for a joinLeft).

The implementation detail behind the idempotence is the **`flattenNullExtension`
flag** on the maybe constructor: null extension is a *partial* order — `maybe
(maybe τ)` is meaningful for explicit nesting but `nullExtend` collapses
repeated extensions. `peel`/`peelNullExtension` (types.ts:315, 558) strip the
flag, and `fieldOf`'s absorption through a null-extended tail marks the fresh
tail `absorbAsMaybe` so fields materialized later arrive already-maybe
(types.ts:597-610; set at inference.ts:2532 in `inferMerge`). This is the
single most subtle rule in the engine and the least "Haskell".

**Aggregates** that SQL can make NULL on empty/all-null input are maybe:
`sum : t -> mode agg (maybe t)`, `avg : t -> mode agg (maybe float)`,
`min`/`max : t -> mode agg (maybe t)`; `count : t -> mode agg int` and
`array : t -> mode agg [t]` are non-null (builtin.ts:161-167). A `fold`
strips the modes, so downstream sees plain (possibly maybe) columns.

**`case` without a fallback** is `maybe` — the `case` rule returns
`maybeOf(base)` when no `_` branch exists (inference.ts:2434-2440).

## 8. Modes

Modes are the static skeleton of SQL's GROUP/aggregate/window grammar. The
rules:

```text
fold (u => { ℓᵢ = eᵢ })     requires every eᵢ : mode agg tᵢ ∨ mode group tᵢ
                             (inference.ts:2130-2149)
fold result row             strips all modes  (inference.ts:2131, 2143, 2233)
map  (u => { ℓᵢ = eᵢ })     rejects group / order / window entries
                             (inference.ts:2220-2233)
over (e) { ... }            requires e : mode agg t ∨ mode window t
                             (inference.ts:1786)
window-only (row_number…)    must be wrapped by over  (inference.ts:1781-1790)
```

An un-aggregated plain column inside `fold` is a static error
(`fold entry 'x' must be wrapped in an aggregate ... or group`); a `group`
key in a `map` projection is a static error; a bare `row_number` outside
`over` is a static error (and the interpreter renders the same diagnostic so
the merged checker dedupes exactly — `inference.ts:2224-2229`).

## 9. Holes

A hole `?name` is a metavariable that unification may fill but generalization
never quantifies. Three independent uses of the same name:

- **Within one annotation** (type-position holes): all same-name holes in one
  annotation denote **one** metavariable (`typeHole`, inference.ts:2950,
  keyed `type-hole:<name>`). So `f : ?a -> ?a = x => x` is an identity and
  applying it to `int` and to `string` at different sites is fine, while
  `f3 : ?a -> ?a -> ?a = x => y => x` applied to `1 "s" 2` is rejected
  (verified). This was a v5 fix: previously every `?a` occurrence created a
  fresh hole, so the name was meaningless (the code's own comment claimed
  sharing; the fix makes the behavior match).
- **Row-tail holes** (`{ a: int | ?rest }`): same-name holes in one annotation
  share a metavariable (`typeTailVar`, inference.ts:2937, keyed
  `row-hole:<name>`). The **name** is what makes two tails the same tail; an
  `?a -> ?a` type-position annotation could not previously rely on that.
- **Table holes**: each `table "t"` application creates a fresh row hole
  named `table_<name>` (`inference.ts:1282-1291`). Because holes are never
  generalized, all uses of the same table expression share one row that
  accumulates fields (`fieldOf`), so conflicting uses are caught:
  `q1 = t & map (u => { a = u.id + 1 })` then
  `q2 = t & map (u => { b = u.id == "x" })` fails
  (test/types.test.ts "dynamic tables are shared holes").
- **Named query parameters**: `param "x"` shares one hole per name across the
  whole project (inference.ts:1262-1276), so the renderer's deduplication
  into one bind placeholder cannot split types.

## 10. Dynamic tables and the renderer boundary

An un-annotated `table "t"` has type `query ?table_t` — a fresh row hole, not
`∀r. query r` (verified: `typeOf` returns `query ?table_users`). The schema is
inferred from every use. The renderer is the *second* gate: a table alone
renders `SELECT *`; set operations on dynamic (still-open) tables are
rejected until a `map` projection has fixed the schema. A *user-annotated*
table schema must be a **closed** record (`table schema must be a closed
record`, interpreter.ts:3636) — the open tail is a type-system fiction that
SQL cannot execute.

## 11. What is not beautiful (the wart list)

The reflection that shapes v5 — each entry names the fix, what it costs, and
what it would take to eliminate:

1. **`absorbAsMaybe` on row tails** (types.ts:93, 597-610; inference.ts:2532).
   Outer-join nullability is threaded through *unification-time field
   absorption*, not through a type constructor. It is the least compositional
   rule: the "maybe row" of an outer join is not really a row type, and
   `maybe (maybe τ)` semantics had to be carved into `flattenNullExtension`.
   *To eliminate*: a genuine `maybe row` elimination rule
   (`maybe {ℓ: τ|ρ} ⟶ {ℓ: maybe τ | maybeρ}`) implemented as a structural
   pass, making outer-join nullability a pure typing rule instead of a
   hidden mutation.
2. **`builtin` tags** (types.ts:175, 473-476; inference.ts:288, 331-345).
   Referential transparency is achieved by carrying the builtin's identity
   *inside the type*, then stripping it for structural unification and
   re-checking it in special-cased application paths. This is a hack that
   leaks the catalog into the type engine. *To eliminate*: a real
   higher-kinded/overloaded application judgment (`app(σf, τ)` resolving the
   closed Functor/Applicative/Monad instances structurally), or a separate
   `TypedBuiltin` node in the IR.
3. **`truth`** (types.ts:147, 490-508). SQL three-valued logic is encoded as
   a *third* boolean that unifies with `bool` and `maybe bool`. It works but
   it is not compositional — there is no `truth → τ` arrow type, and
   `is_true`/`is_false`/`is_unknown` (inference.ts:1952) are special-cased.
   *To eliminate*: an overloading `Pred` constraint (`Pred bool`, `Pred (maybe
   bool)`) resolved like the other classes.
4. **`order` as an atomic type** (builtin.ts:151-152, inference.ts:2620).
   `sort`'s lambda must return `order` or `[order]`, checked by a skolemized
   post-check. It is not a mode (it never appears in a row), so it lives
   outside the `mode` unification — but it *is* one of the three
   "pipeline-only" atoms. *To eliminate*: fold `order` into the `mode`
   family with its own mode-rule, so `sort`'s check becomes uniform with
   fold/map/over.
5. **Numeric defaulting inside `generalize`** (types.ts:733-751). The only
   place generalization mutates bindings; it is a Haskell-ism bolted onto the
   store. *To eliminate*: defaulting as a separate post-pass over the
   solved substitution (standard HM defaulting), leaving `generalize` pure.
6. **`mono` scheme for `mempty`** (builtin.ts:284) with a deferred instance
   check (`flushDeferred`/`checkMemptyResolved`, inference.ts:216, 233). The
   type is a bare flexible variable whose kind adapts at the use site — a
   type-directed dictionary is deliberately absent (see the `Monoid` note in
   type-system.md §7). *To eliminate*: a real instance-resolving
   `mempty : Monoid a => a` with a kind-aware Monoid, which is exactly the
   dictionary machinery the project has postponed.

Two items are *accepted* rather than deferred, because they are the point:

- **Explicit `maybe`** (no absorption, no implicit lifting). This is the
  design's spine and is not a wart.
- **Closed instance table** (no user-declarable classes, no higher-kinded
  variables). The compiler owns the classes so the schemes stay closed and
  the runtime needs no dictionary.

## 12. Laws

The engine obeys these invariants (each is exercised by the test suite):

1. **Idempotence**: `modeOf m (modeOf m τ) = modeOf m τ` (types.ts:180);
   `nullExtend (maybe τ) = maybe τ` (types.ts:158).
2. **Commutativity of row unification**: `unifyRow(a, b)` and
   `unifyRow(b, a)` reach the same solved store (both orders run in
   `test/types.test.ts`).
3. **No occurs check violations**: `α ~ maybe α` and `α ~ {…|α}` throw
   `UnifyError` (types.ts:360).
4. **Transactional failure**: a failed `unify`/`constrain` leaves the store
   unchanged (types.ts:434, 445, 257; `test/types.test.ts`).
5. **Generalization excludes environment and holes** (types.ts:723);
   **instantiation is capture-free** (types.ts:765).
6. **Mode discipline is preserved by folding**: `fold`'s output row has no
   modes; `map` after `fold` sees plain (maybe) columns
   (inference.ts:2094-2149; verified end-to-end).
7. **Maybe strictness**: `maybe τ` never unifies with `τ` (types.ts:542-547;
   `test/types.test.ts` "maybe is a distinct type constructor").
8. **The checker and interpreter agree**: `checkProject` runs inference and
   evaluation in lockstep and merges diagnostics with exact `(node, message)`
   dedupe (`inference.ts:3139` `mergeDiagnostics`, `checker.ts` header), so a
   type error and its SQL-IR echo collapse into one report.

## 13. Implementation map (post-v5)

| Rule | Implementation |
| --- | --- |
| Type constructors | `types.ts:24, 54-88` |
| Variable store, kinds, holes, classes | `types.ts:199-266` |
| Unification (incl. modes) | `types.ts:434-556` |
| Row unification / absorption | `types.ts:617-687` |
| Field access (dynamic rows) | `types.ts:689-721` |
| Generalize / instantiate / skolemize | `types.ts:723-790` |
| Constraint resolution | `types.ts:29-53, 267-303` |
| Pretty-printing | `types.ts:831-878` |
| Prelude schemes (catalog) | `builtin.ts:84-118` (`poly`/`mono`), `builtin.ts:118-290` |
| Expression inference | `inference.ts:625-770` |
| Lambda / annotation / ascription | `inference.ts:774-808, 482-570, 626-643` |
| Application (incl. builtin dispatch) | `inference.ts:1221-1450` |
| Mode checks (fold/map/over) | `inference.ts:1781-1790, 2094-2250` |
| Joins & merge | `inference.ts:1854-1945, 2450-2540` |
| Holes & `this`/`that` | `inference.ts:1262-1292, 2808-2990` |
| Numeric literals & defaulting | `inference.ts:115-118, types.ts:733-751` |
