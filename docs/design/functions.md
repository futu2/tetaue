# SQL function catalog — design and support matrix

The general SQL function set follows teta's
[LANGUAGE_SPEC](https://github.com/futu2/teta/blob/master/doc/LANGUAGE_SPEC.md):
one tetaue name per operation and a **per-dialect lowering** chosen at render
time (direct, mapped, or fallback). The interpreter validates arguments; the
inference pass types them; `render.ts` owns the SQL.

Status legend (matching teta's): **Direct** = emitted as-is, **Mapped** =
renamed, **Fallback** = rewritten to an equivalent expression. Every scalar
and date entry has one of these lowerings in each built-in dialect; capability
errors are reserved for query-shape features such as unsupported join forms
or recursive CTEs.

## Many-argument functions: one list or curried positions

`concat` / `greatest` / `least` take any number of arguments of ONE type, so
they take a **single list argument** — `concat [a, b]`, `greatest [u.a, u.b]`
— which types exactly what they consume (a homogeneous list). `round`,
`substring`, `lpad`/`rpad` and `lag`/`lead` have **heterogeneous arguments**
(a list cannot type `[string, int, ...]` soundly), so they are ordinary
**curried functions** typed position by position. An argument is `maybe`-typed
only when omitting it changes the meaning (`substring u.name 1 nothing` means
to the end; `lag u.salary 1 nothing`'s default is NULL); an argument that SQL
merely gives a DEFAULT VALUE is required instead, with the default written
explicitly: `round u.x 2` (scale 0 for no rounding), `lpad u.code 8 "0"` (pad
defaults to ' '), `lag u.salary 2 nothing` (offset defaults to 1).

All of these are ordinary curried functions: they compose with `<<<`/`>>>`,
bind as values (`f = greatest`, `f = lpad u.code 8`), and partial-apply like
everything else (there is no variadic special case in the evaluator). The
interpreter validates the argument kinds at runtime; the inference pass types
every position and checks the arity (`argError` / `postCheckArg` in
`inference.ts`), with messages matching the interpreter's so the merged
diagnostics dedupe.

A bare reference (`f = greatest`) is the function value, not a call.

## Agda-style operator sections

Every infix symbol has an ordinary curried binding whose name surrounds the
symbol with underscores:

```
_+_ 1 2       # 1 + 2
_>>>_ f g     # f >>> g
_&_ query step
increment = _+_ 1
```

The standard meanings are defined in `prelude.tetaue`. SQL-aware operators use
hidden intrinsics from the small core; pure operators are ordinary lambdas:

```
export _+_ = op_add
export _>>>_ = f => g => x => g (f x)
export _<<<_ = f => g => x => f (g x)
export _&_ = x => f => f x
export _$_ = f => x => f x
export _<$>_ = fmap
export _<$_ = replaceWith
export _<*>_ = ap
export _<*_ = applyLeft
export _*>_ = applyRight
export _<|>_ = orElse
export _>>=_ = bind
export _>>_ = then
```

Infix syntax resolves that lexical binding and applies it twice, so `_+_ 1 2`
and `1 + 2` are the same operation. A local or imported `_+_` binding changes
both forms. The grammar still owns the finite symbol set, precedence, and
associativity; adding an entirely new infix symbol requires a grammar change.

A word between the underscores first resolves an exact `_word_` binding, then
falls back to the ordinary `word` function. Thus `_div_ 5 2` calls the `div`
builtin, while `_combine_ x y` calls a user binding named either `_combine_`
or `combine`. The referenced function remains normally curried and
type-checked; the underscores do not introduce separate SQL lowering.

## Records

`merge l r` combines two records into one; the right record wins on overlapping
fields (JS/Nix object-spread style). The `<>` operator also has closed
Semigroup behavior for strings and lists, so it can concatenate scalar values
and list values in ordinary expressions. Record merge remains an
evaluation-time operation — the merged record becomes the projection's field
list — so it is used inside `map`/join-merger projections:

    users & map (u => u <> { active = u.age >= 18 })

Semantics and typing:

- **Union, right-wins.** The result's fields are the left row's fields plus
  the right record's fields; a label on both sides keeps the right value
  (and type), exactly like object spread. No render-time lowering: the
  merged record is the projection.
- **Closed Semigroup/Monoid instances.** Strings concatenate through the
  dialect-aware `concat` lowering, and lists concatenate their items. Record
  merge is associative with `{}` as its identity, so the same infix spelling
  serves the structural record operation (the prefix `merge l r` remains a
  record-specific synonym).
- **Row polymorphism.** The result row is typed as the union of both rows
  (left's non-overlapping fields + right's fields, with the open tails
  linked), so a merged row keeps all columns downstream:
  `merge u { active }` : `forall r. { | r } -> { active: bool | r }`, and
  the `map` result type shows the full union.
- **Record operands must be records.** Row-shaped records (lambda parameters)
  materialize their schema columns; merging a row with an *unknown* schema
  (an un-annotated table) is an error — annotate the table
  (`t: query { id: int } = table "t"`).
- **Not for aggregation.** `merge` inside `fold` produces non-grouped,
  non-aggregated entries, which `fold` rejects like any plain column.

## The pure `list.*` namespace

The Haskell `base` List vocabulary lives in a **built-in `list` namespace**,
kept strictly separate from the unqualified relational/SQL vocabulary so the
two never collide. Qualified access needs parens when applied (the same rule
as `filter (p.adult)`):

```
(list.map)    (x => x * 2) [1, 2, 3]      # [2, 4, 6]
(list.fold)   (acc => x => acc + x) 0 [1, 2, 3]   # 6
(list.length) [1, 2, 3]                   # 3
(list.elem)   2 [1, 2, 3]                 # true
(list.isEmpty) []                         # true
```

Members: `map`, `filter`, `fold`, `foldr`, `sum`, `product`, `length`,
`reverse`, `concat`, `append`, `take`, `drop`, `head`, `last`, `isEmpty`,
`elem`. (`isEmpty` is used instead of `null` because `null` is a reserved
keyword and cannot follow the namespace dot.)

These operate on **in-memory `[...]` list values only** — they never touch
SQL. `map`, `filter`, `take`, `drop`, `fold`, `sum`, `length`, `reverse`,
`concat` keep their unqualified relational/scalar meanings.

## Date & time

Constants `current_date` → `CURRENT_DATE` and `current_timestamp` →
`CURRENT_TIMESTAMP` are accepted verbatim by every dialect (sqlite included).

| tetaue | Trino | PostgreSQL | MySQL | SQLite | Hive |
|---|---|---|---|---|---|
| `year/month/day`<br>`day_of_week`<br>`hour/minute/second` | `EXTRACT(FIELD FROM x)` | `EXTRACT(FIELD FROM x)` | `EXTRACT(FIELD FROM x)`,<br>`DAYOFWEEK(x)` | `CAST(STRFTIME('%Y', x) AS INTEGER)` | `YEAR(x)` … `DAYOFWEEK(x)` |
| `extract x "field"` | `EXTRACT(FIELD FROM x)` | same | same | `STRFTIME` | same as parts |
| `date_add x "unit" n` | `DATE_ADD('unit', n, x)` | `x + (n) * INTERVAL '1 unit'` | `DATE_ADD(x, INTERVAL n UNIT)` | `DATETIME` with literal or `PRINTF` modifier | `x + INTERVAL 'n' UNIT` |
| `date_diff x "unit" y` | `DATE_DIFF('unit', x, y)` | `EXTRACT(unit FROM (y - x))` | `TIMESTAMPDIFF(UNIT, x, y)` | scaled `JULIANDAY(y) - JULIANDAY(x)` | `DATEDIFF` / scaled unix-second delta |
| `date_trunc x "unit"` | `DATE_TRUNC('unit', x)` | `DATE_TRUNC('unit', x)` | `STR_TO_DATE` / `DATE_FORMAT` composition | `DATE` / `STRFTIME` (all units) | `TRUNC` / unix-second composition |
| `date_format x "fmt"` | `DATE_FORMAT(x, 'fmt')` | `TO_CHAR(x, 'fmt')` | `DATE_FORMAT(x, 'fmt')` | `STRFTIME('fmt', x)` | `DATE_FORMAT(x, 'fmt')` |
| `date_parse x "fmt"` | `DATE_PARSE(x, 'fmt')` | `TO_TIMESTAMP(x, 'fmt')` | `STR_TO_DATE(x, 'fmt')` | `DATETIME(x)` (fmt ignored) | `FROM_UNIXTIME(UNIX_TIMESTAMP(x, 'fmt'))` |
| `to_unixtime x` | `TO_UNIXTIME(x)` | `EXTRACT(EPOCH FROM x)` | `UNIX_TIMESTAMP(x)` | `CAST(STRFTIME('%s', x) AS INTEGER)` | `UNIX_TIMESTAMP(x)` |
| `from_unixtime x` | `FROM_UNIXTIME(x)` | `TO_TIMESTAMP(x)` | `FROM_UNIXTIME(x)` | `DATETIME(x, 'unixepoch')` | `FROM_UNIXTIME(x)` |

Units for `date_add`/`date_diff`/`date_trunc` (string literal): `year`,
`month`, `week`, `day`, `hour`, `minute`, `second`. Dialects that lack a
calendar primitive use elapsed-time or formatting fallbacks, so all validated
units remain renderable. The date family carries a `DateTime` typeclass constraint
(`date`/`timestamp` only) on its calendar-valued inputs and outputs, so the
static schemes match the runtime checks — see `docs/design/type-system.md`
§7. `date_trunc` preserves its input's date-ness
(`date` truncates to `date`, `timestamp` to `timestamp`), like `date_add`, so
a truncated date compares with `current_date`. Date parts: `year`, `month`, `day`,
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
| `round x n` (scale required; 0 = no rounding) | `ROUND(x, n)` | Direct | Direct | Direct | Direct |
| `greatest x y ...` / `least ...` | `GREATEST(...)` / `LEAST(...)` | Direct | Direct | Direct (MAX/MIN aliases) | Direct |

`greatest`/`least` require all arguments to share a comparable type (strict
numerics: int and float do not mix, like everywhere else in the language).

## Strings

| tetaue | Trino | PostgreSQL | MySQL | SQLite | Hive |
|---|---|---|---|---|---|
| `concat [a, b, ...]` | `CONCAT(a, b, ...)` | Direct | Direct | **Fallback** `a \|\| b` | Direct |
| `trim x` | `TRIM(x)` | Direct | Direct | Direct | Direct |
| `substring x s (just l)` (nothing = to the end) | `SUBSTRING(x, s[, l])` | Direct | Direct | **Mapped** `SUBSTR(x, s[, l])` | Direct |
| `position x n` | `POSITION(n IN x)` | Direct | **Mapped** `LOCATE(n, x)` | **Mapped** `INSTR(x, n)` | `INSTR(x, n)` |
| `replace x s r` | `REPLACE(x, s, r)` | Direct | Direct | Direct | Direct |
| `reverse x` | `REVERSE(x)` | Direct | Direct | correlated recursive-CTE fallback | Direct |
| `left_substring x n` | `LEFT(x, n)` | Direct | Direct | **Fallback** `SUBSTR(x, 1, n)` | Direct |
| `right_substring x n` | `RIGHT(x, n)` | Direct | Direct | **Fallback** `SUBSTR(x, -n)` | Direct |
| `lpad x n p` / `rpad x n p` (pad required) | `LPAD(x, n, p)` | Direct | Direct | `PRINTF`/`REPLACE`/`SUBSTR` composition | Direct |

Regex helpers are deliberately absent from the common prelude: stock SQLite
has no regex engine, so exposing them would either require a deployment-specific
extension or reintroduce a dialect-only render failure.

## Logical / null handling / casts

| tetaue | SQL |
|---|---|
| `like x "a%"` | `x LIKE 'a%'` (binary operator) |
| `null_if x y` | `NULLIF(x, y)` |
| `is_null x` / `is_not_null x` | `x IS NULL` / `x IS NOT NULL` |
| `exists q` | `EXISTS (subquery)` — correlated queries allowed |
| `scalar q` | `(subquery)` — exactly one output column; result is `(maybe T)` |
| `in_query x q` / `not_in_query x q` | `x [NOT] IN (subquery)` |
| `fmap f x` | closed Functor lift over maybe values, lists, and query rows; SQL NULL propagates |
| `replaceWith x fa` / `x <$ fa` | replace every value in a maybe, list, or query Functor |
| `ap ff fa` / `ff <*> fa` | closed maybe/list Applicative application |
| `applyLeft a b` / `a <* b` | sequence matching maybe/list values and keep the left result |
| `applyRight a b` / `a *> b` | sequence matching maybe/list values and keep the right result |
| `orElse a b` / `a <|> b` | first present maybe value, or list concatenation |
| `bind ma f` / `ma >>= f` | maybe short-circuit or list flat-map |
| `then ma mb` / `ma >> mb` | Monad sequencing; equivalent to `*>` for the closed instances |
| `param "name"` | dialect bind placeholder (`?`, or `$n` in PostgreSQL) |
| `cast x "int"` … | `CAST(x AS TYPE)` — target as a string literal |

`try_cast` is also omitted because substituting ordinary `CAST` changes its
failure semantics on PostgreSQL, MySQL, SQLite, and Hive.

The compiler owns a closed set of Haskell-inspired classes. `Eq` and `Ord`
apply to the supported scalar primitives; `Semigroup`/`Monoid` apply to
strings and lists; `Functor` is executable for maybe values, lists, and
queries; and `Applicative`, `Alternative`, and `Monad` are executable for
maybe values and lists. List application/sequencing uses Cartesian-product
order, while list bind concatenates the function's result lists. Queries are
not generic Monad instances: relational composition remains explicit through
query steps, fixed joins, and `join_lateral`. Higher-kinded user declarations
and generic dictionaries are not yet representable, so there is no
polymorphic `mempty` or `pure` surface.

`cast` target types: `int` (INTEGER / SIGNED mysql / INT hive), `float`
(DOUBLE / DOUBLE PRECISION pg / REAL sqlite), `decimal` (NUMERIC pg /
DECIMAL elsewhere), `string` (VARCHAR / CHAR mysql / TEXT sqlite / STRING hive),
`bool` (BOOLEAN, or INTEGER 0/1 on sqlite), `date` (DATE), `timestamp` (TIMESTAMP).
The result type is the target type, so
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
simple form); values must share exactly one type. Maybe is explicit: use
`just` for branches that may be `null`
(`case { u.active => just u.name, _ => null } : (maybe string)`), and lift a
simple-case subject with `just` when a `null` branch should be well-typed
(`case (just o.total) { null => "unknown", _ => "known" }`).
The `_` fallback branch must be last (at most one). Aggregates cannot be
wrapped (`case` inside `fold` is rejected). Without a `_` fallback the
result is `(maybe T)` (an unmatched CASE yields NULL); with a fallback it is
the unified branch value type.

## Aggregation extras

| tetaue | SQL |
|---|---|
| `count_distinct x` | `COUNT(DISTINCT x)` |
| `drop n` | `OFFSET n` (dialect-specific without LIMIT; Hive errors) |

`drop` composes with `take` in source order: `drop 10 & take 5` is
`LIMIT 5 OFFSET 10`; `take 5 & drop 2` wraps the limited result as a
derived table and applies `OFFSET 2` to it.

## Lateral joins

`join_lateral` takes a left-row → right-query function instead of a static
right query, so the right side can be correlated:

```
q = users & join_lateral
    (l => (orders & filter (o => o.user_id == l.id) & sort (o => desc o.total) & take 1))
    (l => r => true)
    (l => r => { id = l.id, name = l.name, total = r.total })
```

Renders as `INNER JOIN LATERAL (subquery) AS alias ON ...`. PostgreSQL and
MySQL are supported; SQLite, Trino, and Hive are capability errors.

## Projection shorthand

`select ["id", "name"]` is a query step that narrows the row to exactly the
listed columns:

```
q = users & select ["id", "name"] & filter (u => u.id > 0)
```

Column names are string literals; duplicates and empty lists are errors. The
inferred result row contains only the selected fields.

## Filtered aggregates

`count_where`, `sum_where`, `avg_where`, `min_where`, and
`max_where` take a boolean condition followed by the value:

```
fold (o => {
    paid_total = sum_where (o.status == "paid") o.total,
    n         = count_where (o.status == "paid") o.total,
})
```

PostgreSQL, Trino, and SQLite render the standard
`SUM(total) FILTER (WHERE ...)`; MySQL and Hive lower the filter to
`SUM(CASE WHEN ... THEN total END)`.

## Recursive CTEs

`recursive f` is a query step whose argument is a function
`query r -> query r`. The step is `base & recursive (self => term)` and
renders as:

```
WITH RECURSIVE <name> AS (base UNION ALL term)
SELECT ... FROM <name>
```

The `self` parameter is the recursive CTE name, so a term can join it:

```
reachable = edges
  & recursive (self =>
      (edges & joinInner self
          (l => r => l.dst == r.src)
          (l => r => { src = l.src, dst = r.dst })))
```

Hive is reported as a capability error (no `WITH RECURSIVE`). The base
query must have a known (annotated) schema.

## Window functions

`over fn { partition = [...], order = [...], rows = [n] }` wraps a window
function with a spec record (fields optional; `{}` renders `OVER ()`).
`rows = [n]` renders `ROWS BETWEEN n PRECEDING AND CURRENT ROW`;
`rows = [n, m]` renders `ROWS BETWEEN n PRECEDING AND m FOLLOWING`.
`partition` takes
a list of column expressions (or one), `order` takes asc/desc items like
`sort`. **Zero-argument functions (`row_number`, `rank`, `dense_rank`,
`percent_rank`) can be written bare** — `over row_number {...}`; functions
with arguments need parens (`over (ntile 4) {...}`, `over (lag u.salary 1 (just 0))
{...}`, `over (sum u.salary) {...}`), because a bare `lag u.salary 1 (just 0)` would
flatten into separate application arguments (an error message explains this).
The syntax and rendering are identical across dialects (PostgreSQL, MySQL 8+,
SQLite 3.25+, Trino, Hive all support the standard `FN(...) OVER (...)` form):

| tetaue | SQL |
|---|---|
| `over row_number { ... }` | `ROW_NUMBER() OVER (PARTITION BY ... ORDER BY ...)` |
| `rank`, `dense_rank`, `percent_rank` | `RANK()` / `DENSE_RANK()` / `PERCENT_RANK()` |
| `over (ntile 4) { ... }` | `NTILE(4) OVER (...)`, `ntile` takes a numeric bucket count |
| `over (lag u.x 1 (just 0)) { ... }` | `LAG(x, 1, 0) OVER (...)`, `lead` — value, offset required, optional default |
| `over (sum u.x) { ... }` | `SUM(x) OVER (...)`, windowed `avg`/`count`/`min`/`max`/`array` too |

The wrapped expression must be an aggregate (`sum`/`avg`/`count`/`min`/`max`/`array`)
or a window-only function (`row_number`, `rank`, `dense_rank`,
`percent_rank`, `ntile`, `lag`, `lead`) — anything else is rejected. The
window-only functions are also rejected **outside** `over` (a bare
`row_number` in a projection is an error, since `ROW_NUMBER()` without
`OVER` is invalid SQL), as are window functions inside `filter` predicates,
join conditions, and window specs' own `partition`/`order`. Window results are
referenced in later steps by their projection alias (`WHERE rn = 1`), because
inlining the `OVER` expression would be invalid SQL.

## Not implemented (needs type-system / query machinery)

- **Array functions** (§6) — `array` (aggregate into a list) and `[T]` column
  annotations exist, but there are no array literals, indexing, or
  element-wise array functions yet.
- **Query features** — none of the original gaps remain for the supported
  dialects: correlated `exists`, `scalar`, `in_query`, `join_lateral`,
  and recursive CTEs are implemented.
- `case` inside `fold` is supported when branch values wrap aggregates and
  the CASE conditions are constants or grouped columns:
  `fold (o => { k = group o.k, x = case { cond => sum o.a, _ => sum o.b } })`.

## Implementation

- `interpreter.ts` — `BUILTINS` entries with argument validation
  (`dateLikeError`, `exprArgs`, kind checks, aggregate forbidding);
  list-argument builtins (`concat [a, b]`, `greatest [a, b]`, …) via
  `listBuiltin` + the `LIST_BUILTINS` table; the heterogeneous builtins
  (`round x n`, `substring x s (just l)`, `lpad x n p`, `lag x n (just d)`)
  are ordinary curried entries with `maybe`-typed optional positions
  (0-argument Applications are bare function values).
- `render.ts` — `renderCall` dispatch (`SPECIAL_CALLS` + `DATE_FUNCTIONS`)
  returns the per-dialect SQL or `null` to fall through to plain `NAME(args)`;
  `sqlTypeName` maps cast targets per dialect; `dialect.functions` handles
  simple renames (sqlite `ceil` → `CEILING`).
- `inference.ts` — the prelude is built from the builtin catalog
  (`catalog.ts`, the single source of truth for every scheme);
  `LIST_BUILTINS` applications get per-element kind and arity checks in
  `checkListBuiltin`; `pow`/`mod` use independent type variables so operands
  never unify with each other; the query DSL's modes (`agg`, `group`,
  `window`) are one `mode` type constructor (`types.ts`), enforced by the
  fold/map/over checks — `order` is a separate atom consumed by `sort`.
  See `docs/design/type-system-formal.md` for the formal core.
- `compile.ts` — render-time capability errors surface as compile
  diagnostics.
