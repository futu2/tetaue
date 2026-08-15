# tetaue type system: row polymorphism for records, HM-style static typing

Status: **implemented (phase 1)** — `src/language/types.ts` (type engine),
`src/language/inference.ts` (inference pass), the grammar (`Type` annotations,
`e: T` ascription), and the validator/CLI wiring (merged, deduplicated
diagnostics). The README carries the user-facing summary; this document is the
specification.

Design decisions (v2): Maybe-style nullability `t?`
(instead of `null` as bottom), strict `int`/`float` separation (no promotion),
and expression-level type annotations `e: T` (ascription).

Design decisions (v3): `table` is an ordinary function
(`table: forall r. string -> query r`) — just the table name. Its row type
`r` comes from a **binding type annotation** (`users: query { id: int, ... }
= table "users"`) or is inferred from use when un-annotated; column types are
types, never values (the types-as-values encoding is removed).

## 1. Goals

tetaue's type system should give records *row polymorphism* and give the whole
language *strong static typing in the Hindley–Milner tradition* (like Haskell /
PureScript / ML):

1. **Row polymorphism for records.** A row lambda like `u => u.age >= 18` is
   typed *once*, generically, and then usable on *any* row that has an `age`
   column — not re-checked against one concrete schema at each use site. This is
   what makes steps first-class and reusable:
   ```
   adult = u => u.age >= 18              # : forall r. { age: int? | r } -> bool
   users & filter (adult)                # users has { id, name, age, active }
   kids  & filter (adult)                # kids  has { id, age, guardian }
   ```
2. **Strong static typing.** Every expression has a static type, checked before
   any SQL is produced; `check` and `render` reject the same programs. Type
   errors are reported once, at the offending node, with the same quality of
   messages the interpreter produces today.
3. **Maybe-style nullability.** SQL NULL is modeled as an option type: `t?` is
   "a `t` or NULL" (conceptually `maybe t`), `null` is `Nothing`. Columns are
   nullable by default; operators are null-tolerant via a single absorption
   rule (§7).
4. **Strict numerics.** `int` and `float` are unrelated types; no implicit
   promotion (§7).
5. **HM inference + annotations.** Types are inferred everywhere; users may
   annotate *any expression* (`e: T`), bindings (`name: T = ...`), and lambda
   parameters (`(u: T) => ...`); annotations are checked against inferred
   types.

Everything is *inferred* in the style of Damas–Milner (Algorithm W with rows):
no runtime type information, subtyping limited to nullability absorption
(§7), no explicit `forall` syntax (free variables in a signature are
implicitly quantified).

## 2. What exists today

`src/language/interpreter.ts` already does *use-site* checking:

- `SqlType = 'int' | 'float' | 'string' | 'bool' | 'date' | 'timestamp'`, plus
  `TypeOrNull = SqlType | 'null'` (`interpreter.ts:22-23`).
- A row is `Schema = Map<string, SqlColumn>` (`interpreter.ts:36`) — a *concrete*
  map of column name → type/table/expr. There is no row variable and no record
  type as a value.
- Lambdas are checked by applying them to `rowRecord(querySchema(q))`
  (`interpreter.ts:417, 777`) — i.e. each lambda is re-checked against the one
  schema in front of it at that use site. `u => u.age >= 18` therefore *behaves*
  row-polymorphically today, but only by re-running the check; there is no
  general type for the lambda itself, so it cannot be reasoned about (or
  annotated, or reused) before it is applied.
- Builtins have no signatures; each one hard-codes its checks (`evalBinary`,
  `filterBuiltin`, `aggBuiltin`, …).

This design adds a *type layer* on top of the existing evaluator: an inference
pass computes a type for every expression, and the evaluator's checks become
backstops that never contradict it (§12).

## 3. Type language (annotation syntax)

New grammar nonterminal `Type`, used in annotation positions (§10):

```
Type      ::= FunType
FunType   ::= NullType '->' FunType | NullType      -- right-associative
NullType  ::= BaseType '?'?                          -- 't?' = nullable (Maybe-style)
BaseType  ::= PrimType | TypeVar | RowType | ListType | QueryType | '(' Type ')'
PrimType  ::= 'int' | 'float' | 'string' | 'bool' | 'date' | 'timestamp'
TypeVar   ::= lowercase identifier                   -- 'a', 'b', 'r', ...
RowType   ::= '{' (Field (',' Field)*)? ('|' TypeVar)? '}'
Field     ::= ID ':' Type
ListType  ::= '[' Type ']'
QueryType ::= 'query' RowType
```

Notes:

- `{ a: int, b: string }` is a *closed* record type; `{ a: int | r }` is an
  *open* record type — at least `a`, plus the row variable `r`.
- **Kind by position.** A lowercase variable in the *tail* position of a record
  type (`{ ... | r }`) is a **row variable**; everywhere else it is a **type
  variable**. There is no separate namespace (PureScript convention).
- `?` binds tightest: `int? -> bool` parses as `(int?) -> bool`,
  `{ a: int? | r }` is a record with a nullable `a`. `?` is idempotent
  (`t?? = t?`) and may wrap any base type, including records
  (`{ a: int }?` via parens).
- `null` is **not** a user-writable type; it is the polymorphic literal
  `null : ∀a. a?` (§7).
- Unknown identifiers in type position (uppercase or unknown prims) are errors:
  `unknown type 'Foo'`.
- Kinds: `Type` (inhabited by prims, `t`, `t1 -> t2`, `[t]`, `t?`), `Row`
  (inhabited by record types), `Query` (inhabited by `query {…}`). A fresh
  metavariable is *kind-flexible*: the first row constraint it meets (a record
  access, a `query` argument, a record unification) pins it to `Row`.

## 4. Judgments and environment

Inference mirrors the evaluator's structure (`analyzeProject`,
`interpreter.ts:1161`): modules are analyzed in import order, bindings in
order, and the environment maps names to **type schemes**:

```
Γ ⊢ e: τ          -- expression e has type τ under Γ
Γ ⊢ b : ∀α. τ      -- binding b generalizes to a scheme (§8)
```

`Γ` starts as the prelude (§9), is extended by each binding (user bindings may
shadow builtins, as today), and imported modules contribute their generalized
binding schemes. Bindings must be defined before use (as today); there is no
recursion, so generalization is always safe.

## 5. Typing rules

Rules for the core expression forms. Row unification is §6, nullability and
numeric strictness §7.

| Expression | Type | Notes |
|---|---|---|
| `42`, `3.14` | `int`, `float` | integer → `int`, decimal → `float`; strict, no promotion (§7) |
| `"s"`, `true`, `false` | `string`, `bool` | |
| `null` | `∀a. a?` | the `Nothing` constant; instantiates to any nullable type at use |
| `int`, `float`, `string`, `bool`, `date`, `timestamp` | internal `Type` | only meaningful inside a `table` schema (§9) |
| `x` (identifier) | `instantiate(Γ(x))` | fresh type/row variables per use |
| `$n` (implicit param) | fresh var | same as `x`, bound by the enclosing implicit lambda (§9) |
| `[e1, …, en]` | `[t]` | all `ei: t` unify; `[] : ∀a. [a]` |
| `{ k1 = e1, …, kn = en }` | closed row `{ k1: t1, …, kn: tn }` | `ti = decode(ei)`; see schema rule below |
| `e.l` (access) | `t` where `l: t ∈ row(e)` | extends a row variable if `e`'s row is open; **error** if `e`'s row is closed without `l` |
| `e1 op e2` | §7, §9 | binary operators |
| `-e` | `int?` / `float?` | numeric only |
| `f a` (application) | instantiate `Γ(f)` and unify | `f a b c` = `((f a) b) c`, curried |
| `a & f` | `∀a b. a -> (a -> b) -> b` | pipeline: apply `f` to `a` |
| `f $ a` | `∀a b. (a -> b) -> a -> b` | application, right-assoc |
| `f <<< g` | `∀a b c. (b -> c) -> (a -> b) -> a -> c` | compose right-to-left |
| `f >>> g` | `∀a b c. (a -> b) -> (b -> c) -> a -> c` | compose left-to-right |
| `u => e` | `τu -> τe` | `u` is a fresh kind-flexible var; body checked with `u: τu` |
| `u => v => e` | `τu -> τv -> τe` | curried (no `(u, v) =>` form) |
| `e: T` (ascription) | `τ` where `unify(τ, instantiate(T))` | annotation on any expression; constrains/asserts, §10 |
| `let x = e in body` | `τbody` | pure local binding; `x` is let-polymorphic inside `body`; value is inlined at render time |
| `x: T = e` (binding annotation) | annotation check, §10 | |

**Field access extends rows.** If `e: ρ` (a fresh row var) then `e.l: t`
binds `ρ := { l: t | ρ' }` for fresh `ρ'`. If `e : { l: t | r }` then `e.l: t`
leaves `r` untouched. If `e : { a: int, b: string }` (closed) then `e.c` is a
type error: `unknown field 'c' — available: a, b`. This single rule is the
engine of row polymorphism: a lambda body only records the fields it actually
touches, so the lambda's row is open exactly where the user left it open.

**A record literal is a closed row** — `{ id = u.id, name = u.name } : { id: int?, name: string? }`.
There is no way to write an open row at the value level; open rows exist only
in types (and therefore in the types of lambdas).

**Schema rule (binding annotation).** `table` is an ordinary function with
the signature `table: forall r. string -> query r` — it takes only the table
name. A query-type **binding annotation** is the table's schema:

```
users: query { id: int, name: string } = table "users"   # query { id: int, name: string }
users: query { id: int, name: string? } = table "users"  # nullable column written explicitly
```

The annotation constrains the free row variable of the bare table (it
*defines* the row, so it is not checked against it like an ordinary
signature), and the interpreter decodes it into the runtime schema; a column
whose type is not a scalar (`int -> int`, a record, …) or an open schema
(`{ id: int | r }`) is an error there.

**Un-annotated tables are dynamic.** `users = table "users"` has the fully
polymorphic type `forall r. query r`; each use instantiates the row from
whatever the pipeline references. The interpreter marks the query's schema
`known: false`: column reads synthesize `users.<name>` lazily and the
type-check backstops relax (an `unknown` type is comparable to anything), so
`users & filter (u => u.age >= 18)` renders `WHERE age >= 18` with no
static complaint — the schema is simply not declared.

## 6. Row unification

Rows are unordered sets of `(label, Type)` pairs plus an optional *tail*
variable:

```
Row ::= { (label: Type)* | tail? }
```

`unifyRow(R1, R2)`:

1. **Tail binding.** If either row is a bare variable, bind it to the other row
   (occurs-check: the tail must not occur free inside the other row's field
   types).
2. **Shared labels.** For every label present in both rows, `unify` its two
   field types (with `?` absorption, §7).
3. **Labels in exactly one row** must be absorbed by the *other* row's tail:
   they are moved into a fresh binding of that tail. If the other row has no
   tail (it is closed) and the label is missing there, **fail**.
4. **Closedness.** After steps 2–3 both rows must have consumed each other's
   labels; any leftover label on either side means the rows are incompatible
   (`expected record with fields …, got …`).

Examples:

```
unify({ age: int | ρ }, { id: int, age: int, name: string })   -- ok, ρ := { id: int, name: string }
unify({ age: int },      { id: int, age: int })                -- fail: closed row lacks 'id'
unify({ id: int | ρ },   { id: int | σ })                      -- ok, ρ := σ (or σ := ρ)
unify({ id: int },       { id: int })                          -- ok
```

Unification of the *whole* type is structural: `unify(t1 -> t2, t3 -> t4)` =
`unify(t1, t3)` ∧ `unify(t2, t4)`, `unify([a], [b])` = `unify(a, b)`,
`unify(query R1, query R2)` = `unifyRow(R1, R2)`, prims unify only with
themselves (no int/float promotion). The occurs check applies to both type and
row variables, and treats `?` transparently (`unify(α, α?)` succeeds: the
occurs check strips `?` from the other side).

**Join's merger.** `join`'s result row is *not* the union of the left and right
rows — the user supplies a **merger** function `l => r => { ... }` that projects
the result row explicitly (the same machinery as `map`, with both rows in
scope). Overlapping column names are therefore not an error: the merger picks
them apart (e.g. `{ left_id = l.id, right_id = r.id }`). Type-wise the merger's
record type *is* the join's result row — `query t` in the scheme below — checked
when the join step is applied to a query.

## 7. Nullability (Maybe-style) and strict numerics

**Nullability.** `t?` is the Maybe type: "a `t` or NULL". The only inhabitant
of a bare `?` is `null`, typed `null : ∀a. a?` — a polymorphic constant like
`Nothing`. Two rules make this usable in SQL without null-check ceremony:

1. **Absorption (subsumption `t <: t?`).** `unify(t?, u)` and `unify(t, u?)`
   both reduce to `unify(t, u)`; the *result* type carries `?` iff either side
   did. Effectively `?` is transparent during matching and only ever *loosens*.
   This is the single, documented subtyping rule — it cannot make a wrong type
   check, only accept nullable where non-null was written.
2. **Nullability is written explicitly in schemas.** `users: query { age: int } = table "users"`
   types the column `age: int`; write `age: int?` for a column that may be
   NULL. Absorption (`t <: t?`) keeps every check permissive either way —
   `u.age == null` works for `int` columns too, since `null: forall a. a?`.

Consequences: `u.age >= 18` with `age: int?` unifies to `int?` and is fine
(comparison is `∀t. t? -> t? -> bool`); `u.name == null` unifies `string?` with
`a?` and renders `IS NULL`; `coalesce u.nickname u.email` is fine. Strict
contexts still reject wrong types: `&&` on `u.age` fails (`int?` vs `bool`),
`filter (u => u.age)` fails. `null == null` type-checks (both `a?`, `b?`) but
stays a semantic error in the evaluator ("cannot compare null with null",
`interpreter.ts:452`), exactly as today.

**Strict numerics.** `int` and `float` are unrelated types; there is no
promotion in either direction.

```
1 + 2.5        # error: '+' requires numeric operands of the same type, got int and float
u.age >= 18    # error when age: float (write 18.0); ok when age: int
(5: float)    # error — ascription is strict; write 5.0
5 / 2: int    # division result type follows the operands (dialect decides
5.0 / 2.0: float   #  integer vs real division at render time)
```

Aggregate results are strict too: `sum`/`min`/`max` preserve the operand's
numeric type, `avg : ∀t. t? -> float?` (AVG of a column is a float), `count :
∀t. t? -> int`.

**Audit of existing programs:** no test or example currently mixes `int` with
`float` (float columns appear only as aggregate arguments and projections; the
only mixed literal, `take 3.5`, is already an error). Strict separation
therefore changes no existing test.

## 8. Generalization (let-polymorphism)

The generalization points are **module bindings** (including imported ones) and **local `let` bindings**:

```
gen(Γ, τ) = ∀α. τ      -- α = free type/row variables of τ not free in Γ
```

Bindings and let-locals are generalized unconditionally — the language is pure,
there is no mutable state, so no value restriction is needed (unlike ML). Lambda parameters
and lambda bodies are *monomorphic*: a lambda's type is generalized only when
the lambda is bound to a name. Scheme instantiation (`instantiate`) replaces
quantified variables with fresh flexible metavariables at each use. `null`'s
polymorphism flows the same way: `x = null` binds `x : ∀a. a?`.

## 9. The prelude (builtin type schemes)

`filter`/`map`/… are *polymorphic over rows* — this is the visible payoff of
row polymorphism: one signature, instantiated at every use.

```
table     : string -> query r                            -- schema via binding annotation or inference (§5)
filter    : forall r. (r -> bool) -> query r -> query r  -- alias: filtered
map       : forall r s. (r -> {s}) -> query r -> query {s}
sort      : forall r. (r -> t) -> query r -> query r     -- t checked to be order or [order] (see below)
take      : int -> query r -> query r                    -- forall r
distinct  : forall r. query r -> query r
fold      : forall r s. (r -> {s}) -> query r -> query {s}
join      : forall r s t. join kind -> query s -> (r -> s -> bool) -> (r -> s -> {t})
                -> query r -> query {t}              -- kind: inner|left|right|full; the merger projects the result row

asc, desc: forall t. t? -> order                        -- internal type 'order' for sort items
inner, left, right, full: join kind                     -- a dedicated type, not string
group     : forall t. t? -> group t                     -- GROUP BY key — group mode
count     : forall t. t? -> agg int                     -- aggregate mode
sum       : forall t. t? -> agg t                       -- t numeric (int or float)
avg       : forall t. t? -> agg float                   -- t numeric
min, max  : forall t. t? -> agg t                       -- comparable t
list      : forall t. t? -> agg [t?]                    -- collect values into a list
not       : bool -> bool
abs       : t? -> t?                     -- t numeric
upper, lower: string? -> string?
length    : string? -> int?
is_in, is_not_in: forall t. t? -> [t?] -> bool
coalesce  : forall t. t? -> t? -> t?
concat    : [string?] -> string?          -- one list argument
greatest, least: forall t. [t?] -> t?    -- one list argument
round     : forall t. [t?] -> t?          -- one list argument ([x] or [x, scale])
substring, lpad, rpad, regex_extract: [string?] -> string?   -- one list argument
lag, lead : forall t. [t?] -> t?          -- one list argument ([x] or [x, offset, default])
==  !=  <  <=  >  >=  : forall t. t? -> t? -> bool       -- strict numerics: int vs float fails
&&  ||              : bool -> bool -> bool               -- absorption accepts bool? operands
+  -  *  /  %       : t? -> t? -> t?                     -- t numeric; both sides same type; result nullable
- (unary)           : t? -> t?                           -- t numeric
&   $   <<<  >>>    : §5 table
int  float  string  bool  date  timestamp: Type         -- internal; only valid in table schemas
```

**Query modes are types.** `agg t` / `group t` / `order` /
`join kind` / `window t` are distinct static modes. `agg` and `group`
are transparent in unification (like `?`), so comparing or computing on
aggregate results works; the other modes are enforced by *mode checks* in
inference that inspect the raw (pre-unification) field types. `window t`
marks window-only functions (`row_number`, `ntile`, `lag`, ...); it is
not transparent, so `row_number + 1` is a static type error and `over`
must unwrap it.

- **`fold`** — every field of the projection row must be `agg t` or `group t`
  with at least one aggregate; the result row strips the modes, so downstream
  steps see plain columns (`query { user_id: int, total: float }`).
- **`map`** — projection fields must not be `group` or `order` (SQL cannot
  select a GROUP BY key or an ORDER BY item as a value); aggregate fields are
  allowed because after a fold the map runs on the aggregated result (nested
  aggregation), which the evaluator validates positionally.
- **`sort`** — the lambda's return type is checked to be `order` or `[order]`
  (skolemized, so an unconstrained column like `u => u.name` is rejected).
- **`over`** — the wrapped expression must be `agg t` or `window t`; the result
  is the payload `t`. A bare window-mode value in a projection is an error
  (it must be wrapped in `over`).

The **list-argument builtins** take one list argument (`concat [a, b]`) instead
of variadic application — they are ordinary curried functions, and inference
checks each element's kind and the arity (`checkListBuiltin`).

Special cases the inferencer implements directly (they are not expressible as
plain schemes):

- **`table`'s schema argument.** The second argument is a record type
  literal whose type IS the row (§5) — `table`'s scheme applies it like any
  other argument; there is no special casing.
- **`map`/`fold` projections.** The lambda's return type must be a row type
  (an unconstrained variable is bound to the open result row, so mid-typing
  completion keeps working); the *structural* rules (projection non-empty,
  one `fold` per pipeline, `fold` after `map`, …) remain in the evaluator.
- **Implicit `$n` lambdas.** `filter ($1.active && $1.age >= 18)` is typed as
  the lambda `($1, …, $n) => …` with arity = highest `$n` not bound and not
  inside an explicit lambda body — mirroring `dollarArity` /
  `dollarLambda` (`interpreter.ts:517-551`). Each `$n` parameter is a fresh
  kind-flexible variable, exactly like an explicit parameter.

## 10. Type annotations

Three positions, all using `:`:

```
Binding      : name=ID (':' type=Type)? '=' value=Expression;
LambdaParam  : name=ID (':' type=Type)?;
Ascription   : operand=Expression ':' type=Type;        -- lowest precedence: a & f: T = (a & f) : T
```

Grammar notes: ascription wraps a whole expression and binds loosest (below
`&`/`$`); in argument position it needs parens (`coalesce u.a (u.b: int?)`),
an application *ending* in a bare identifier needs parens too
(`(filter adult) : bool` — the bare argument lexes as ID before `:`),
while lambda bodies and binding values take it directly
(`map (u => u.id: int)`, `x = 5: int`). The lambda rules are tried before
the parenthesized-expression rule in `Argument`/`Atom`, so `(u: T) => ...`
parses as an annotated lambda, not as ascription plus `=>`.

Checking rules:

- **Expression ascription `e: T`** — the strictest form: infer `τ` of `e`,
  then `unify(τ, instantiate(T))` (free variables of `T` are fresh flexible).
  It *constrains*: `(5: float)` fails under strict numerics and `(u.age: int)`
  succeeds for `u.age: int?` (absorption). Ascription is erased at evaluation
  time.
- **Binding annotation `x: S = e`**: infer `e: τ`, generalize to `∀β. τ'`,
  then `unify(instantiate(S), skolemize(τ'))` where the free variables of `S`
  are *flexible* and those of `τ'` are *rigid* (skolemized). This is the
  standard "the signature must be at least as general as the inferred type"
  check, enforced by direction: only `S`'s variables may be instantiated. A
  too-specific or wrong annotation is an error:
  ```
  adult: { age: int | r } -> bool = u => u.age >= 18    # ok
  adult: { age: int } -> bool     = u => u.age >= 18    # ok — becomes the binding type, so wider rows are rejected at application
  adult: { a: int | r } -> bool   = u => u.age >= 18    # error — body needs 'age', annotation lacks it
  ```
  (The third fails because the skolemized `{ age: int? | ρ0 }` cannot be
  unified with `{ a: int | r' }` — `age` cannot be absorbed into the rigid tail
  `ρ0`.) Once the check passes, the binding is generalized with the declared
  type `S`, not the inferred type, so a closed annotation really narrows
  downstream applications.
- **Lambda-parameter annotation `(u: T) => e`**: `u` is bound to the annotation
  with its free variables treated as *rigid* inside the body (the user names
  them; the body must work for any such row). The resulting lambda type is
  generalized when bound. A *closed* parameter annotation narrows the lambda:
  `filter (u: { age: int }) => u.age >= 18` will only unify with a row that is
  *exactly* `{ age: int }` — write `{ age: int | r }` to be reusable. This is
  the main teaching point of row polymorphism and is called out in the README.

## 11. Error model

Type errors are diagnostics with `{ node, message }`, exactly like today's
(`interpreter.ts:81-84`), and flow through the same validator folding for
imports (`tetaue-validator.ts:64-78`). Messages reuse the interpreter's wording
where the check is shared — including *stripping `?`* from printed types so the
two passes produce byte-identical messages and dedupe cleanly (the `?` layer is
invisible in diagnostics until phase 2, §12):

| Error | Example |
|---|---|
| `unknown field 'c' — available: a, b` | `u.c` where `u : { a: int, b: string }` closed |
| `cannot compare string with int` | `u.name == u.age` |
| `'&&' requires boolean operands, got int and bool` | `u.age && u.active` |
| `'+' requires numeric operands, got string and int` | `u.name + 1` |
| `'+' requires numeric operands of the same type, got int and float` | `1 + 2.5` (strict numerics) |
| `is_in list items must match type int, got string` | `is_in u.id [1, "x"]` |
| `table takes a single argument (the table name), e.g. table "users"` | `table "t" { a = 42 }` (an extra argument) |
| `schema entry 'id' must be a scalar type (int, string, bool, float, date, timestamp)` | `t: query { id: int -> int } = table "t"` |
| `annotation type { a: int | r } -> bool does not match inferred type { age: int } -> bool` | annotation mismatch (§10) |
| `record { a: int } has no field 'b'` | access on a closed literal record |
| `unknown type 'Foo'` | annotation with an unknown type name |

`null == null`, aggregate placement, alias
collisions, duplicate keys, and arity/shape errors remain **evaluator**
(semantic) errors; inference is silent about them.

## 12. Integration plan

Files:

```
src/language/types.ts      NEW  — Type AST, kinds, substitution, unify(+rows, +`?` absorption),
                                 generalize/instantiate/skolemize, pretty-printer
src/language/inference.ts  NEW  — inferProject / inferExpr, prelude scheme table,
                                 annotation checking (ascription/binding/param), $n, imports
src/language/tetaue.langium     — Binding ':' Type, LambdaParam ':' Type, Ascription rule,
                                 Type rule (incl. `?`), regenerated via bun run langium:generate
src/language/generated/*        — regenerated
src/language/tetaue-validator.ts — run inference over the collected module tree,
                                 merge + dedupe diagnostics
src/language/interpreter.ts — unchanged in this phase (backstops stay)
src/cli.ts                  — surface inference diagnostics in check/render
test/types.test.ts          NEW  — type-system tests
README.md                   — "Types & annotations" section
docs/design/type-system.md  — this document
```

**Phase 1 (this implementation).** Inference runs as a second pass in the
validator alongside the interpreter. Both emit diagnostics; the aggregation
layer **dedupes by (node, message)** — and since inference reuses the
interpreter's message strings for shared checks (stripping `?`), every type
error is reported exactly once. The interpreter's checks stay as safety
backstops, so no existing behavior or test changes. `render`/`check` keep their
current failure behavior: any diagnostic (from either pass) blocks rendering.

**Phase 2 (follow-up, optional).** Delete the interpreter checks now owned by
inference (comparison/arity/operand type checks in `evalBinary`, `evalUnary`,
`readField`, `stringFnBuiltin`, `aggBuiltin`, `inBuiltin`, `coalesce`), making
inference the single source of type truth; the evaluator keeps only structural
checks, and `?` may surface in diagnostics. Not part of this change.

**Testing.** New `test/types.test.ts`:
- *positive*: row-polymorphic reuse (`adult` used on two different schemas);
  `map` projection; `fold`; `join` with a merger row; strict numerics
  (`u.age >= 18` with `age: int`); nullability (`u.age == null`,
  `coalesce u.x null`, nullable column in arithmetic); empty list `[]`;
  composition `<<<`; ascription (`(u.age: int)`, query-type ascription on
  `table`); binding and lambda-param annotations (open row, closed narrowing);
  `$n` implicit lambdas; imported-module polymorphism.
- *negative*: field on a closed record; wrong operand type; non-boolean `&&`;
  heterogeneous list; **int/float mixing** (`1 + 2.5`, `(5: float)`); annotation
  mismatch (too specific / missing field); `table` schema not a
  type or a non-scalar column type.
- the full existing suite stays green.

## 13. Out of scope (future work)

Type classes / type-class constraints (`Num a => …`), user-defined types and
type synonyms, explicit `forall` syntax, higher-rank polymorphism, kind
annotations, subtyping beyond nullability absorption `t <: t?` (and the strict
`int`/`float` split this implies), recursive types (the language has no
recursion), and any runtime type representation.
