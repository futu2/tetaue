# SQL function catalog — design and support matrix

The general SQL function set follows teta's
[LANGUAGE_SPEC](https://github.com/futu2/teta/blob/master/doc/LANGUAGE_SPEC.md):
one tetaue name per operation and a **per-dialect lowering** chosen at render
time (direct, mapped, or fallback). The interpreter validates arguments; the
inference pass types them; `render.ts` owns the SQL.

Status legend (matching teta's): **Direct** = emitted as-is, **Mapped** =
renamed, **Fallback** = rewritten to an equivalent expression, **error** =
the dialect lacks the function, so rendering throws a capability error (a
compile diagnostic, exactly like teta's "throws an explicit error" behavior
for unsupported features).

## Optional and many-argument functions: one list argument

`concat` / `greatest` / `least` take any number of arguments; `round`
(1–2), `substring` (2–3), `lpad`/`rpad` (2–3), `regex_extract` (2–3) and
`lag`/`lead` (1–3) have optional arguments. These builtins take a **single
list argument** — `concat [a, b]`, `round [u.x, 2]`, `lag [u.salary, 1, 0]` —
so they are ordinary curried functions: they compose with `<<<`/`>>>`, bind
as values (`f = greatest`), and partial-apply like everything else (there is
no variadic special case in the evaluator). `LIST_BUILTINS` in the
interpreter validates the element kinds and arity (min/max) at runtime; the
inference pass checks every element's static kind and the arity
(`checkListBuiltin` in `inference.ts`), with matching messages so the merged
diagnostics dedupe. The element type is the list's first element; a
heterogeneous list is tolerated at the list itself and checked per element.

A bare reference (`f = greatest`) is the function value, not a call.

## Records

`merge l r` (also written infix `l <> r`) combines two records into one;
the right record wins on overlapping fields (JS/Nix object-spread style).
It is an evaluation-time record operation — the merged record becomes the
projection's field list — so it is used inside `map`/join-merger projections:

    users & map (u => u <> { active = u.age >= 18 })

Semantics and typing:

- **Union, right-wins.** The result's fields are the left row's fields plus
  the right record's fields; a label on both sides keeps the right value
  (and type), exactly like object spread. No render-time lowering: the
  merged record is the projection.
- **A monoid.** Merge is associative and the empty record `{}` is its
  identity, so the infix spelling is `<>` (Haskell/PureScript monoid
  operator, same precedence as `+`/`-`); the prefix `merge l r` is a
  synonym.
- **Row polymorphism.** The result row is typed as the union of both rows
  (left's non-overlapping fields + right's fields, with the open tails
  linked), so a merged row keeps all columns downstream:
  `merge u { active }` : `forall r. { | r } -> { active: bool | r }`, and
  the `map` result type shows the full union.
- **Both sides must be records.** Row-shaped records (lambda parameters)
  materialize their schema columns; merging a row with an *unknown* schema
  (an un-annotated table) is an error — annotate the table
  (`t: query { id: int } = table "t"`).
- **Not for aggregation.** `merge` inside `fold` produces non-grouped,
  non-aggregated entries, which `fold` rejects like any plain column.

## Date & time

Constants `current_date` → `CURRENT_DATE` and `current_timestamp` →
`CURRENT_TIMESTAMP` are accepted verbatim by every dialect (sqlite included).

| tetaue | Trino | PostgreSQL | MySQL | SQLite | Hive |
|---|---|---|---|---|---|
| `year/month/day`<br>`day_of_week`<br>`hour/minute/second` | `EXTRACT(FIELD FROM x)` | `EXTRACT(FIELD FROM x)` | `EXTRACT(FIELD FROM x)`,<br>`DAYOFWEEK(x)` | `CAST(STRFTIME('%Y', x) AS INTEGER)` | `YEAR(x)` … `DAYOFWEEK(x)` |
| `extract x "field"` | `EXTRACT(FIELD FROM x)` | same | same | `STRFTIME` | same as parts |
| `date_add x "unit" n` | `DATE_ADD('unit', n, x)` | `x + (n) * INTERVAL '1 unit'` | `DATE_ADD(x, INTERVAL n UNIT)` | `DATETIME(x, '+n units')` | `x + INTERVAL 'n' UNIT` |
| `date_diff x "unit" y` | `DATE_DIFF('unit', x, y)` | `EXTRACT(unit FROM (y - x))` | `TIMESTAMPDIFF(UNIT, x, y)` | `JULIANDAY(y) - JULIANDAY(x)` | `DATEDIFF(y, x)` (day only) |
| `date_trunc x "unit"` | `DATE_TRUNC('unit', x)` | `DATE_TRUNC('unit', x)` | **error** | `DATE(x)` / `STRFTIME` (day/month/year) | `TRUNC(x, 'DD')` (year/month/week/day) |
| `date_format x "fmt"` | `DATE_FORMAT(x, 'fmt')` | `TO_CHAR(x, 'fmt')` | `DATE_FORMAT(x, 'fmt')` | `STRFTIME('fmt', x)` | `DATE_FORMAT(x, 'fmt')` |
| `date_parse x "fmt"` | `DATE_PARSE(x, 'fmt')` | `TO_TIMESTAMP(x, 'fmt')` | `STR_TO_DATE(x, 'fmt')` | `DATETIME(x)` (fmt ignored) | **error** |
| `to_unixtime x` | `TO_UNIXTIME(x)` | `EXTRACT(EPOCH FROM x)` | `UNIX_TIMESTAMP(x)` | `CAST(STRFTIME('%s', x) AS INTEGER)` | `UNIX_TIMESTAMP(x)` |
| `from_unixtime x` | `FROM_UNIXTIME(x)` | `TO_TIMESTAMP(x)` | `FROM_UNIXTIME(x)` | `DATETIME(x, 'unixepoch')` | `FROM_UNIXTIME(x)` |

Units for `date_add`/`date_diff`/`date_trunc` (string literal): `year`,
`month`, `week`, `day`, `hour`, `minute`, `second`. Fallback dialects reject
units they cannot express (sqlite `date_diff` only day/hour/minute/second, …)
with an explicit render-time error. Date parts: `year`, `month`, `day`,
`day_of_week`, `hour`, `minute`, `second` — `day_of_week` follows each
dialect's convention (PG `DOW` 0=Sunday, Trino `DAY_OF_WEEK` 1=Monday, SQLite
`%w` 0=Sunday, MySQL/Hive `DAYOFWEEK` 1=Sunday). `date_format`/`date_parse`
format strings are dialect-native (`%Y-%m-%d` Trino/MySQL/SQLite, `YYYY-MM-DD`
PostgreSQL, `yyyy-MM-dd` Hive).

## Math

`+ - * / %` are operators; the rest are functions. Result types: `pow` is
`float`; `mod` and the unaries keep the operand's type.

| tetaue | Trino | PostgreSQL | MySQL | SQLite | Hive |
|---|---|---|---|---|---|
| `ceil x` | `CEIL(x)` | `CEIL(x)` | `CEIL(x)` | **Mapped** `CEILING(x)` | `CEIL(x)` |
| `floor x` / `sqrt x` | Direct (`FLOOR`/`SQRT`) | Direct | Direct | Direct | Direct |
| `pow x y` | `POW(x, y)` | Direct | Direct | Direct | Direct |
| `mod x y` | `MOD(x, y)` | Direct | Direct | Direct | Direct |
| `round [x]` / `round [x, n]` | `ROUND(x[, n])` | Direct | Direct | Direct | Direct |
| `greatest x y ...` / `least ...` | `GREATEST(...)` / `LEAST(...)` | Direct | Direct | Direct (MAX/MIN aliases) | Direct |

`greatest`/`least` require all arguments to share a comparable type (strict
numerics: int and float do not mix, like everywhere else in the language).

## Strings

| tetaue | Trino | PostgreSQL | MySQL | SQLite | Hive |
|---|---|---|---|---|---|
| `concat [a, b, ...]` | `CONCAT(a, b, ...)` | Direct | Direct | **Fallback** `a \|\| b` | Direct |
| `trim x` | `TRIM(x)` | Direct | Direct | Direct | Direct |
| `substring [x, s, l?]` | `SUBSTRING(x, s[, l])` | Direct | Direct | **Mapped** `SUBSTR(x, s[, l])` | Direct |
| `position x n` | `POSITION(n IN x)` | Direct | **Mapped** `LOCATE(n, x)` | **Mapped** `INSTR(x, n)` | `INSTR(x, n)` |
| `replace x s r` | `REPLACE(x, s, r)` | Direct | Direct | Direct | Direct |
| `reverse x` | `REVERSE(x)` | Direct | Direct | **error** | Direct |
| `left_substring x n` | `LEFT(x, n)` | Direct | Direct | **Fallback** `SUBSTR(x, 1, n)` | Direct |
| `right_substring x n` | `RIGHT(x, n)` | Direct | Direct | **Fallback** `SUBSTR(x, -n)` | Direct |
| `lpad [x, n, p?]` / `rpad` | `LPAD(x, n[, p])` | Direct | Direct | **error** | Direct |
| `regex_like x p` | `REGEXP_LIKE(x, p)` | **Fallback** `REGEXP_MATCH(x, p) IS NOT NULL` | `REGEXP_LIKE(x, p)` | **error** | `x RLIKE p` |
| `regex_replace x p r` | `REGEXP_REPLACE(x, p, r)` | Direct | Direct | **error** | Direct |
| `regex_extract [x, p, g?]` | `REGEXP_EXTRACT(x, p[, g])` | **Mapped** `REGEXP_SUBSTR(x, p)`; group arg **error** | **error** | **error** | `REGEXP_EXTRACT(x, p)`; group arg **error** |

## Logical / null handling / casts

| tetaue | SQL |
|---|---|
| `like x "a%"` | `x LIKE 'a%'` (binary operator) |
| `null_if x y` | `NULLIF(x, y)` |
| `is_null x` / `is_not_null x` | `x IS NULL` / `x IS NOT NULL` |
| `cast x "int"` … | `CAST(x AS TYPE)` — target as a string literal |
| `try_cast x "int"` | `TRY_CAST(...)` — **Trino only**, error elsewhere |

`cast` target types: `int` (INTEGER / SIGNED mysql / INT hive), `float`
(DOUBLE / DOUBLE PRECISION pg / REAL sqlite), `string` (VARCHAR / CHAR mysql /
TEXT sqlite / STRING hive), `bool` (BOOLEAN; **error** on sqlite), `date`
(DATE), `timestamp` (TIMESTAMP). The result type is the target type, so
`cast u.x "int" == 5` type-checks.

## `case` / CASE WHEN expressions

`case { cond1 => value1, cond2 => value2, ..., _ => value }` is tetaue's SQL
`CASE WHEN`, written as a first-class expression: each branch maps a boolean
condition to a value, and the final branch's condition is the `_` wildcard
(a reserved keyword) which becomes the ELSE value. A `case` without a `_`
branch renders without ELSE (a non-matching row yields NULL). `case` and `_`
are reserved words. CASE is standard SQL, so the rendering is identical
across dialects:

| tetaue | SQL |
|---|---|
| `case { u.active => u.name, _ => "inactive" }` | `CASE WHEN active THEN name ELSE 'inactive' END` |
| `case { u.age < 18 => "minor", u.age >= 65 => "senior", _ => "adult" }` | `CASE WHEN age < 18 THEN 'minor' WHEN age >= 65 THEN 'senior' ELSE 'adult' END` |
| `case { u.balance > 100 => u.name }` | `CASE WHEN balance > 100 THEN name END` |

**Simple case** puts a subject before the braces (SQL's `CASE subject WHEN
value THEN ...`): every branch condition becomes a `==` comparison with the
subject, so code→label tables don't repeat the subject — `case u.code
{ "101" => "one", "102" => "two", _ => u.code }` renders `CASE WHEN code =
'101' THEN 'one' WHEN code = '102' THEN 'two' ELSE code END`. Branch
conditions are any expression (compared with `==`); a `null` condition
renders as `IS NULL` (`case u.code { null => "missing", _ => "present" }`).
See `examples/lpbirthday.tetaue` for a 20-arm mapping table.

Conditions must be boolean expressions (or match the subject type in the
simple form); values must share a comparable type (a `null` literal absorbs
like `coalesce`, so `case { u.active => u.name, _ => null }` is `string`).
The `_` fallback branch must be last (at most one). Aggregates cannot be
wrapped (`case` inside `fold` is rejected like `coalesce`). The result type
is the unified branch value type. Without a `_` fallback it is nullable
(because an unmatched CASE yields NULL); with a `_` fallback it keeps the
unified value type.

## Window functions

`over fn { partition = [...], order = [...] }` wraps a window function with a
spec record (both fields optional; `{}` renders `OVER ()`). `partition` takes
a list of column expressions (or one), `order` takes asc/desc items like
`sort`. **Zero-argument functions (`row_number`, `rank`, `dense_rank`,
`percent_rank`) can be written bare** — `over row_number {...}`; functions
with arguments need parens (`over (ntile 4) {...}`, `over (lag [u.salary, 1, 0])
{...}`, `over (sum u.salary) {...}`), because a bare `lag [u.salary, 1, 0]` would
flatten into separate application arguments (an error message explains this).
The syntax and rendering are identical across dialects (PostgreSQL, MySQL 8+,
SQLite 3.25+, Trino, Hive all support the standard `FN(...) OVER (...)` form):

| tetaue | SQL |
|---|---|
| `over row_number { ... }` | `ROW_NUMBER() OVER (PARTITION BY ... ORDER BY ...)` |
| `rank`, `dense_rank`, `percent_rank` | `RANK()` / `DENSE_RANK()` / `PERCENT_RANK()` |
| `over (ntile 4) { ... }` | `NTILE(4) OVER (...)`, `ntile` takes a numeric bucket count |
| `over (lag [u.x, 1, 0]) { ... }` | `LAG(x, 1, 0) OVER (...)`, `lead` — value, optional offset, optional default |
| `over (sum u.x) { ... }` | `SUM(x) OVER (...)`, windowed `avg`/`count`/`min`/`max`/`list` too |

The wrapped expression must be an aggregate (`sum`/`avg`/`count`/`min`/`max`/`list`)
or a window-only function (`row_number`, `rank`, `dense_rank`,
`percent_rank`, `ntile`, `lag`, `lead`) — anything else is rejected. The
window-only functions are also rejected **outside** `over` (a bare
`row_number` in a projection is an error, since `ROW_NUMBER()` without
`OVER` is invalid SQL), as are window functions inside `filter` predicates,
join conditions, and window specs' own `partition`/`order`. Window results are
referenced in later steps by their projection alias (`WHERE rn = 1`), because
inlining the `OVER` expression would be invalid SQL.

## Not implemented (needs type-system / query machinery)

- **Array functions** (§6) — `list` (aggregate into a list) and `[T]` column
  annotations exist, but there are no array literals, indexing, or
  element-wise array functions yet.
- **Query features** — lateral joins, recursive CTEs, subqueries in `filter`
  (`WHERE x IN (SELECT ...)`).
- `case` inside `fold` wrapping aggregates (`CASE WHEN ... THEN SUM(x) ...`) —
  aggregate nodes are rejected inside `case`, and `fold` entries must be
  wrapped in an aggregate or group directly.

## Implementation

- `interpreter.ts` — `BUILTINS` entries with argument validation
  (`dateLikeError`, `exprArgs`, kind checks, aggregate forbidding);
  list-argument builtins (`concat [a, b]`, `round [x, 2]`, `lag [x, 1, 0]`,
  …) via `listBuiltin` + the `LIST_BUILTINS` table — ordinary curried
  functions over one list argument (0-argument Applications are bare function
  values).
- `render.ts` — `renderCall` dispatch (`SPECIAL_CALLS` + `DATE_FUNCTIONS`)
  returns the per-dialect SQL or `null` to fall through to plain `NAME(args)`;
  `sqlTypeName` maps cast targets per dialect; `dialect.functions` handles
  simple renames (sqlite `ceil` → `CEILING`).
- `inference.ts` — the prelude is built from the builtin catalog
  (`catalog.ts`, the single source of truth for every scheme);
  `LIST_BUILTINS` applications get per-element kind and arity checks in
  `checkListBuiltin`; `pow`/`mod` use independent type variables so operands
  never unify with each other; the query DSL's modes (`join kind`, `agg`,
  `group`, `order`) are types enforced by the fold/map/sort checks.
- `compile.ts` — render-time capability errors surface as compile
  diagnostics.
