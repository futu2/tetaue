# `sql_dialect` — a first-class per-dialect dictionary

Status: **implemented** — the dialect is seeded as a first-class value, the
prelude branches on it at analysis time, and `upper`/`lower`/`length`/`trim`/
`position` have migrated out of the TS core into `prelude.tetaue`.

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
- **`sql_bare` primitive.** `sql_bare "YEAR"` emits a **bare, unquoted SQL
  word** (a distinct `bare` IR node rendered without `quoteIdentifier`), for
  syntaxes that need a keyword-like field name: `EXTRACT(YEAR FROM x)` requires
  `YEAR`, not `'YEAR'` or `"YEAR"`. Verified end-to-end (see the test in
  `test/dialect.test.ts`).
- **Analysis-time branching.** Literal `==`/`!=` comparisons constant-fold in
  `evalBinary`, and `case` short-circuits on a literal condition — so
  `case sql_dialect.name { "mysql" => sql_func "LOCATE" [n, x], ... }` picks
  the branch during evaluation instead of emitting a runtime SQL `CASE`.
- **Tests** (`test/dialect.test.ts`): seeding, typing, per-dialect lowering,
  the short-circuit behavior, and `sql_bare` (unquoted word, never `'YEAR'`).

## What has migrated

- `upper`, `lower`, `length`, `trim` — no per-dialect variance, plain
  `sql_func "UPPER"/"LOWER"/"LENGTH"/"TRIM"` wrappers with precise
  annotations.
- `replace`, `mod` — no per-dialect variance; `like` is a binary operator
  (`sql_infix "LIKE"`).
- `div`, `left_substring`/`right_substring` — vary by dialect and
  branch on `sql_dialect.name`.
- `abs`, `ceil`, `floor`, `sqrt` — **polymorphic** math unaries, now expressible
  because binding annotations accept a Haskell-style typeclass context:
  `abs: Num t => t -> t = x => (sql_func) "ABS" [x]`. The `Num` bound keeps
  `abs u.name` a static error (verified).
- `position` — varies per dialect in BOTH the function name and the argument
  order. The prelude branches on `sql_dialect.name` and composes the
  argument-reordered `POSITION(needle IN value)` form with the `sql_infix`
  primitive:
  ```
  export position: string -> string -> int = x => n => case sql_dialect.name {
      "postgresql" => (sql_func) "POSITION" [(sql_infix) "IN" n x],
      "trino"      => (sql_func) "POSITION" [(sql_infix) "IN" n x],
      "mysql"      => (sql_func) "LOCATE" [n, x],
      _            => (sql_func) "INSTR" [x, n],
  }
  ```
  The renderer's `SPECIAL_CALLS` entry and `case 'position'` are gone.

- `reverse` stays a core builtin: sqlite lowers it to a **scalar recursive
  CTE**, which is query-shape, not a scalar call — `sql_func`/`sql_infix`
  cannot express it.

## The implemented flow

The dialect is threaded into analysis, so the prelude sees it during
evaluation:

```
cli --dialect sqlite
  └─ compileModuleText(..., { dialect })
       └─ checkProject(..., { dialect: DIALECTS['sqlite'] })   # seeds sql_dialect
       └─ renderQuery(query, DIALECTS['sqlite'])               # renderer still lowers
```

`analyzeProject` / `checkProject` seed a first-class `sql_dialect` record into
every module's prelude environment, so `prelude.tetaue` can branch on
`sql_dialect.name` at analysis time. The renderer keeps the query-shape
lowering (`renderCall`, `DATE_FUNCTIONS`, joins, windows, `case`); scalar
function-name and argument-order choices have moved into the prelude.

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
primitives the SQL prelude composes (implemented):

```
sql_func name [args]        # emit FUNC(args) — the generic call node
sql_infix op left right     # emit `left op right` (e.g. POSITION(n IN x))
sql_cast value "target"     # emit CAST(value AS target) via the cast renderer
sql_bare word               # emit an unquoted SQL word (EXTRACT(YEAR FROM x))
sql_dialect                 # the record above (branch on sql_dialect.name)
```

`sql_bare` is a separate `bare` IR node (not a `col`): `col` nodes go through
`quoteIdentifier`, which would quote the reserved word and break `EXTRACT`.
`bare` renders the word as-is.

**Grammar gotcha (learned while wiring `sql_bare`).** A parenthesized
expression is an *atom*, so a nested application argument does not group on its
own: `(sql_infix) "FROM" (sql_bare) "YEAR" x` passes `(sql_bare)`, `"YEAR"`,
and `x` as three separate arguments of `sql_infix`. Nested applications need
double parens — `((sql_infix) "FROM") ((sql_bare) "YEAR") x` — or identifier
operands, which is why the migrated `position`/`div` definitions pass plain
lambda parameters into `sql_infix`.

`sql_cast` reuses the existing per-dialect CAST lowering, so a prelude
definition can compose it (e.g. SQLite's `CAST(STRFTIME('%Y', x) AS INTEGER)`
for `year`).

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

## Still in the TS core: the remaining scalar family

The migrated set is the surface whose lowering a prelude `case sql_dialect.name
{ ... }` over `sql_func`/`sql_infix`/`sql_bare` expresses faithfully. The rest
of `BUILTIN_SPECS`/`renderCall` stays in TS because each member needs prelude
vocabulary the language does not have yet:

- **Date parts** (`year`, `month`, `day`, `day_of_week`, `hour`, `minute`,
  `second`) and `extract`. `sql_bare` removed the EXTRACT blocker, but their
  per-dialect lowering still exceeds the current primitives: SQLite needs
  `CAST(STRFTIME('%Y', x) AS INTEGER)` (a `sql_func` + `sql_cast` chain),
  MySQL/Trino disagree on `day_of_week` (`DAYOFWEEK(x)` vs
  `EXTRACT(DAY_OF_WEEK FROM x)`), Hive uses a direct `YEAR(x)` call, and the
  EXTRACT forms need the double-paren `((sql_infix) "FROM") ((sql_bare)
  "YEAR") x` grouping. The renderer's `renderDatePart` table handles all five
  dialects and `test/dates.test.ts` is the acceptance harness.
- **Variadic-list** (`concat`, `greatest`, `least`). `greatest`/`least` rely
  on bespoke inference diagnostics (`greatest requires matching types, got
  float and string` — asserted in `test/functions.test.ts`) that a prelude
  `[t] -> t` annotation cannot reproduce, plus sqlite's scalar
  `MAX(a, b, ...)`/`MIN(a, b, ...)` lowering. `concat` needs sqlite's
  per-element `COALESCE(x, '')` fold — a list-to-binary-operator mapping the
  prelude has no primitive for.
- **Heterogeneous / optional-argument** (`round x n`, `substring x s (just l)`,
  `lpad`/`rpad`). These are curried position by position with `maybe`-typed
  optional positions; the prelude has no `maybe`-branching lowering for the
  SQLite `SUBSTR`/`PRINTF` compositions.
- **Type-directed** (`cast`, `from_maybe`). These resolve at type level, not
  name level, and stay core.
- `reverse` (sqlite scalar recursive CTE) is query-shape, already documented
  above.

Migration resumes when the prelude gains new lowering vocabulary — e.g. a
`sql_call` form that covers SQLite format strings, a list-fold over SQL
arguments (for `concat`), or annotation-carried diagnostics (for
`greatest`/`least`). Those are deliberate language additions, not mechanical
moves.

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

## Naming direction (resolved)

The user's direction is "use haskell base lib name rather than sql things,
sql things should not leak." The migrated scalars now carry Haskell-flavored
public names:

- `toUpper`/`toLower` are the canonical definitions; `upper`/`lower` remain
  as compatibility aliases.
- `length`/`trim` already match base spellings.
- `position` keeps its SQL name (its argument-reordered lowering has no
  faithful base counterpart — `elemIndex` returns `Maybe Int`, SQL returns
  `Int`).

## Success criteria

- `position` across `trino`, `postgresql`, `mysql`, `sqlite`, `hive` renders
  correctly with its logic living in `prelude-sql.tetaue` and no `position`
  entry in `render.ts` special cases.
- `renderCall`/`DATE_FUNCTIONS`/`SPECIAL_CALLS` shrink to the irreducible
  query-shape set.
- Existing per-dialect render tests pass unchanged (they are the acceptance
  harness).
