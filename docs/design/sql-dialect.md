# `sql_dialect` — a first-class per-dialect dictionary

Status: **implemented (mechanism)** — the dialect is seeded as a first-class
value and the prelude can branch on it at analysis time. Full scalar-function
migration is the follow-up; `position` in particular needs one more step (see
below).

Goal: make per-dialect SQL lowering a property of a **first-class `sql_dialect`
value** that `prelude-sql.tetaue` can read, instead of a large bespoke dispatch
table inside the TypeScript renderer. This is the piece that lets the language
keep a small pure core and build the SQL surface on top of it (the "SQL should
not leak" direction), while dialect differences stay a *library* concern.

## What is implemented

- **`sql_dialect` value.** `analyzeProject`/`checkProject`/`compileModuleText`
  accept a `dialect` option; the resolved `DialectView` (name + the
  canonical->SQL function map) is seeded into every module's prelude
  environment as a record `{ name = "sqlite", functions = {...} }`, typed as a
  record scheme by the inferencer.
- **`sql_func` primitive.** `sql_func "NAME" [args]` emits an uninterpreted SQL
  call node, the building block the prelude composes.
- **Analysis-time branching.** Literal `==`/`!=` comparisons constant-fold in
  `evalBinary`, and `case` short-circuits on a literal condition — so
  `case sql_dialect.name { "mysql" => sql_func "LOCATE" [n, x], ... }` picks
  the branch during evaluation instead of emitting a runtime SQL `CASE`.
- **Tests** (`test/dialect.test.ts`): seeding, typing, per-dialect lowering,
  and the short-circuit behavior.

## The `position` follow-up (why it is not migrated yet)

`position` lowers to `POSITION(needle IN value)` on postgresql/trino — an
argument-reordered **infix** form, not `NAME(args)`. `sql_func` cannot express
that shape, so the renderer's `SPECIAL_CALLS` entry for `position` must stay
until `sql_func` grows an infix/binary form (e.g. a `sql_infix` or an explicit
operator-name argument). This is the natural next increment; it also needs the
function's type scheme preserved at the prelude binding (`position : string ->
string -> int`).

## The current flow (what changed)

Today the dialect reaches the renderer only:

```
cli --dialect sqlite
  └─ compileModuleText(..., { dialect })
       └─ analyzeProject(...)        # evaluation: dialect NOT available
       └─ renderQuery(query, DIALECTS['sqlite'])   # dialect used here
```

`analyzeProject` / `checkProject` evaluate the prelude and user code with no
knowledge of the dialect, so nothing in `prelude.tetaue` can branch on it. All
dialect logic lives in `render.ts` (`DialectSpec.functions`, `renderCall`,
`DATE_FUNCTIONS`, `SPECIAL_CALLS`) and `capabilities.ts`.

## Design

**Thread the dialect into analysis.** `analyzeProject`, `checkProject`,
`compileModuleText`, and the LSP analysis entry point gain an option
`dialect?: string` (default `'sqlite'`, matching the CLI default). The
`DialectSpec` for that dialect is resolved up front and passed down.

**Seed a `sql_dialect` value in the prelude environment.** `createPreludeEnv`
(interpreter) and `inference.prelude()` (inferencer) seed a `sql_dialect`
binding whose value is a **record** mirroring `DialectSpec`:

```
sql_dialect = {
  name = "sqlite",
  quoteIdentifier = ...,
  boolLiteral = ...,
  functions = { upper = "UPPER", ceil = "CEILING", ... },
  ...
}
```

Like the `op_*` operator intrinsics, `sql_dialect` is a **hidden intrinsic**
(name reserved so user code cannot shadow it; not part of `BUILTIN_SPECS`).
The interpreter builds the record from the resolved `DialectSpec`; the
inferencer types it as a concrete record scheme. Because evaluation happens
once per project (not per dialect), a program rendered for two dialects is
analyzed once per dialect — the same cost as today's render-only variance.

**Hidden SQL intrinsics for lowering.** The core exposes a small set of
primitives the SQL prelude composes:

```
sql_func name args...        # emit FUNC(args) — the generic call node
sql_cast x "target"          # CAST(x AS target)
sql_dialect                  # the record above (branch on sql_dialect.name,
                             # read sql_dialect.functions.foo for the mapped name)
```

`render.ts`'s `call` case already falls through to `NAME(args)` via
`ctx.dialect.functions`, so `sql_func` produces the existing IR node and
rendering stays unchanged. The point is that the *name chosen* can now be a
prelude computation.

**Migration (start with one function, prove it end to end).** Pick a function
whose per-dialect lowering is currently bespoke — `position` is ideal
(`POSITION(x IN n)` PG/Trino, `LOCATE(n, x)` MySQL, `INSTR(x, n)` SQLite/Hive):

```
# prelude-sql.tetaue
export position = x => n => case sql_dialect.name {
    "mysql"  => sql_func "LOCATE" n x,
    "sqlite" => sql_func "INSTR" x n,
    "hive"   => sql_func "INSTR" x n,
    _        => sql_func "POSITION" x n,
}
```

`render.ts` drops `position` from its special cases; the prelude owns it. The
existing `renderCall` tests for `position` across the five dialects become the
acceptance check.

**Then, in dependency order:**
1. `lpad`/`rpad` (sqlite `PRINTF`/`REPLACE`/`SUBSTR` composition) — needs
   `sql_dialect` branching plus small expression building; keep the composition
   in prelude via nested `sql_func`.
2. `substring` (optional length, sqlite `SUBSTR` mapping) — the maybe-length
   position already exists in the IR.
3. Date functions (`date_add`, `date_diff`, `date_trunc`, `date_format`,
   `date_parse`, `to_unixtime`, `from_unixtime`) — the largest `DATE_FUNCTIONS`
   table, all expressible as `sql_func` + dialect branches.
4. Finally, retire `SPECIAL_CALLS`/`DATE_FUNCTIONS` from `render.ts`, leaving
   only the genuinely query-shaped lowering (joins, sets, windows, `case`,
   recursive CTEs) in TS.

## What stays in the TS core (the irreducible relational machinery)

The query *shape* operations are not "functions" and cannot be prelude code:
`table`, `filter`, `map`, `fold`, joins, set ops, `case`, window framing,
`recursive`, and the mode/row type machinery. These keep their TS
implementations. The `sql_dialect` mechanism only moves the *scalar
function-name* surface.

## Tradeoffs / risks

- **Typed dictionary.** `sql_dialect.functions.foo` must type-check against a
  concrete record scheme; the inferencer needs a fixed scheme for it (it is
  closed, so a mono record scheme is fine).
- **Re-analysis per dialect.** `render` for two dialects runs two analyses
  instead of one analysis + two renders. Negligible for CLI; the LSP analyzes
  per document anyway (single dialect).
- **Shadowing.** `sql_dialect` must be a reserved hidden intrinsic so a user
  binding cannot override it (same mechanism as `op_add`).
- **No user-facing `sql_dialect` in the base prelude.** It lives in
  `prelude-sql.tetaue`; the base prelude never mentions a dialect, preserving
  the "no SQL leak" property.

## Success criteria

- `position` across `trino`, `postgresql`, `mysql`, `sqlite`, `hive` renders
  correctly with its logic living in `prelude-sql.tetaue` and no `position`
  entry in `render.ts` special cases.
- `renderCall`/`DATE_FUNCTIONS`/`SPECIAL_CALLS` shrink to the irreducible
  query-shape set.
- Existing per-dialect render tests pass unchanged (they are the acceptance
  harness).
