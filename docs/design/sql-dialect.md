# `sql_dialect` — a first-class per-dialect dictionary

Status: **implemented** — the dialect is seeded as a first-class value, the
prelude branches on it at analysis time, and the scalar family (`toUpper`/`toLower`/
`length`/`trim`/`replace`/`mod`/`like`/`div`/`leftSubstring`/`rightSubstring`/
`abs`/`ceil`/`floor`/`sqrt`/`pow`/`position`) has migrated out of the TS core
into `base/sql.tetaue`.

Goal: make per-dialect SQL lowering a property of a **first-class `sql_dialect`
value** that `base/sql.tetaue` can read, instead of a large bespoke dispatch
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

- `toUpper`, `toLower`, `length`, `trim` — no per-dialect variance, plain
  `sql_func "UPPER"/"LOWER"/"LENGTH"/"TRIM"` wrappers with precise
  annotations.
- `replace`, `mod` — no per-dialect variance; `like` is a binary operator
  (`sql_infix "LIKE"`).
- `div`, `leftSubstring`/`rightSubstring` — vary by dialect and
  branch on `sql_dialect.name`.
- `abs`, `ceil`, `floor`, `sqrt` — **polymorphic** math unaries, now expressible
  because binding annotations accept a Haskell-style typeclass context:
  `abs: Num t => t -> t = x => sql_func "ABS" [x]`. The `Num` bound keeps
  `abs u.name` a static error (verified).
- `position` — varies per dialect in BOTH the function name and the argument
  order. The prelude branches on `sql_dialect.name` and composes the
  argument-reordered `POSITION(needle IN value)` form with the `sql_infix`
  primitive:
  ```
  export position: string -> string -> int = x => n => case sql_dialect.name {
      "postgresql" => sql_func "POSITION" [sql_infix "IN" n x],
      "trino"      => sql_func "POSITION" [sql_infix "IN" n x],
      "mysql"      => sql_func "LOCATE" [n, x],
      _            => sql_func "INSTR" [x, n],
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
every module's prelude environment, so `base/sql.tetaue` can branch on
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
  functions = { coalesce = "COALESCE", count = "COUNT", array = "JSON_GROUP_ARRAY", ... },
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
sql_fragment tpl [args]     # emit `tpl` with each `{}` replaced by an argument
                            # (`{:}` inserts a STRING BARE — a SQL keyword);
                            # `{{`/`}}` are literal braces. This is what
                            # expresses the shapes the two above cannot:
                            # `INTERVAL 7 DAY`, `INTERVAL '-7' DAY`, `(-7)`
sql_literal x               # the SQL text of a literal argument, or "" when it
                            # is computed — the only INTROSPECTION in the set,
                            # and what lets a lowering pick the literal form
                            # (`INTERVAL 7 DAY`) over the computed one
                            # (`INTERVAL (n) DAY`)
sql_literal_amount x scale  # the same, signed (`+`/`-`) and multiplied by
                            # `scale` — sqlite's DATETIME modifier needs
                            # `'-7 days'`, and a tetaue string cannot be
                            # assembled from parts
sql_error "message"         # REJECT a definition: the fallback arm of a
                            # dispatch on a compile-time name (`extract x
                            # "quarter"`, `dateAdd x "night" 1`) reports the
                            # bad name instead of lowering it to wrong SQL
sql_dialect                 # the record above (branch on sql_dialect.name)
```

`sql_literal`/`sql_literal_amount` are the ONE exception to "a primitive may not
inspect an argument": a library definition receives VALUES, not syntax, so
without them it could not tell `dateAdd x "day" 7` from `dateAdd x "day" u.n` —
and the two need different SQL. Both return plain tetaue STRINGS, so they widen
what a definition can DECIDE without widening what it can EMIT.

`sql_bare` is a separate `bare` IR node (not a `col`): `col` nodes go through
`quoteIdentifier`, which would quote the reserved word and break `EXTRACT`.
`bare` renders the word as-is.

**Grammar gotcha (learned while wiring `sql_bare`).** Function-position parens
around a bare name are pure style — `sql_func "UPPER" [x]` and
`(sql_func) "UPPER" [x]` parse and lower identically, so the prelude writes the
Haskell form. Parens are only load-bearing in *argument* position: an argument
is an atom, so a parenthesized atom (`(sql_bare)`) is one argument but a
nested application does not group on its own —
`sql_infix "FROM" (sql_bare) "YEAR" x` passes `(sql_bare)`, `"YEAR"`, and `x`
as three separate arguments of `sql_infix`. A nested application argument must
be wrapped whole: `sql_func "EXTRACT" [((sql_infix) "FROM") ((sql_bare)
"YEAR") x]`.

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
# base/sql.tetaue
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
3. Date functions (`dateAdd`, `dateDiff`, `dateTrunc`, `dateFormat`,
   `dateParse`, `toUnixtime`, `fromUnixtime`) — the largest `DATE_FUNCTIONS`
   table, all expressible as `sql_func` + dialect branches.
4. Finally, retire `SPECIAL_CALLS`/`DATE_FUNCTIONS` from `render.ts`, leaving
   only the genuinely query-shaped lowering (joins, sets, windows, `case`,
   recursive CTEs) in TS.

## Migrated: the date/time family

`base/sql/time.tetaue` holds the whole date layer — both the per-dialect
lowering and the accepted part/unit names. It was the largest `DATE_FUNCTIONS`
table, and it is now ordinary tetaue:

- **Date parts** (`year`, `month`, `day`, `dayOfWeek`, `hour`, `minute`,
  `second`) and `extract` dispatch on the part NAME and then on the dialect.
  sqlite's `STRFTIME` + `CAST`, mysql/trino/postgresql's `EXTRACT` (with
  `DAYOFWEEK`/`DAY_OF_WEEK`/`DOW` for the day of the week) and hive's bare
  `YEAR(x)` calls are all `sql_fragment`/`sql_func` expressions.
- **`dateAdd`/`dateDiff`/`dateTrunc`/`dateFormat`/`dateParse`/`toUnixtime`/
  `fromUnixtime`** likewise. `dateAdd`'s literal-vs-computed amount is the case
  that motivated `sql_literal`/`sql_literal_amount` (see the vocabulary above);
  postgresql's `x + (n) * INTERVAL '1 day'` and hive's `x + INTERVAL '-7' DAY`
  are the shapes that motivated `sql_fragment`.
- **An unknown name is a static error**, reported by the library itself: the
  valid parts/units are the dispatch arms and anything else falls through to
  `sql_error`. This is why no `DATE_PARTS`/`DATE_UNITS` list is needed in TS.
- **The calendar type is an ordinary type variable.** `year : a -> int` and
  `dateTrunc : a -> string -> a` accept any value; what they buy is THREADING,
  so `dateTrunc o.created_at "month"` is a timestamp while
  `dateTrunc o.order_date "month"` is a date, and comparing the former with
  `CURRENT_DATE` is a type error. (The primitive spec used to carry the same
  shape as `t -> int`; the library keeps it.)

`src/core/date-lowering.ts` is deleted, and the date family is out of
`BUILTIN_SPECS` entirely — only the four constants (`date`, `timestamp`,
`currentDate`, `currentTimestamp`) stay, because they map to their own IR nodes.

The `renderCall` switch is gone with it: `LOWERINGS`/`SQL_NAMES` are now derived
from the specs alone, and `render.ts` keeps only the query-shaped lowering.

## Still in the TS core: the remaining scalar family

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
- **Type-directed** (`cast`, `fromMaybe`). These resolve at type level, not
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
  `base/sql.tetaue`; the base prelude never mentions a dialect, preserving
  the "no SQL leak" property.

## Naming direction (resolved)

The user's direction is "use haskell base lib name rather than sql things,
sql things should not leak." The migrated scalars now carry Haskell-flavored
public names:

- `toUpper`/`toLower` are the only spellings; the SQL-named `upper`/`lower`
  aliases were removed (the language has no installed base to keep them for,
  and a second spelling is the enemy of concision).
- `length`/`trim` already match base spellings.
- `position` keeps its SQL name (its argument-reordered lowering has no
  faithful base counterpart — `elemIndex` returns `Maybe Int`, SQL returns
  `Int`).

## Success criteria

- `position` across `trino`, `postgresql`, `mysql`, `sqlite`, `hive` renders
  correctly with its logic living in `base/sql.tetaue` and no `position`
  entry in `render.ts` special cases.
- `renderCall`/`DATE_FUNCTIONS`/`SPECIAL_CALLS` shrink to the irreducible
  query-shape set.
- Existing per-dialect render tests pass unchanged (they are the acceptance
  harness).
