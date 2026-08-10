# tetaue

A pure functional SQL query language, built with [Langium](https://github.com/eclipse-langium/langium)
on bun + TypeScript.

**Syntax** is inspired by [moria](https://codeberg.org/mikitori/moria) (maps `{ k = v }`,
`a => a` lambdas, bare builtin names from a small prelude, `#` comments, multi-file
modules via `import`).
**Semantics** follow [teta](https://github.com/futu2/teta): queries are immutable values
composed from curried functions with the `&` operator, and rendered to SQL per dialect
at render time.

```
# examples/adults.tetaue
users = table "users" {
    id = int,
    name = string,
    age = int,
    active = bool,
}

adults = users
    & filter (u => u.active && u.age >= 18)
    & map (u => { id = u.id, name = u.name })
    & sort (u => [asc u.name])
    & take 10
```

```console
$ tetaue render examples/adults.tetaue --dialect postgresql
SELECT "id", "name"
FROM "users"
WHERE ("active" AND "age" >= 18)
ORDER BY "name" ASC
LIMIT 10
```

## Quick start

```sh
bun install
bun run langium:generate   # regenerate the Langium parser from the grammar
bun test                   # run the test suite
bun run src/cli.ts render examples/report.tetaue --dialect sqlite
```

## CLI

```
tetaue render <file.tetaue> [--dialect sqlite|postgresql|mysql] [--format pretty|compact]
tetaue check <file.tetaue>
tetaue parse <file.tetaue>
```

`render` validates the module (and its imports) and prints the rendered SQL. `check`
prints diagnostics (or `OK`). `parse` dumps the AST as JSON. All commands resolve
`import` statements relative to the importing file.

## Modules

A module is a list of bindings; **the last binding is the module's query**. Bindings
need **no terminator** — a `table "users" { ... }` is `table` applied to two arguments,
and the next binding starts right after the closing brace.

```
users = table "users" { id = int, name = string }
adults = users & filter (u => u.active) & take 5
```

(That module's query is `adults`.) The one rule that makes this unambiguous: an
application argument may be a literal, a map, a list, a lambda, a parenthesized
expression, or a `u.field` access chain — but **not a bare identifier**; wrap bare
values in parentheses: `f (g)`.

### Multi-file modules

```
# tables.tetaue — shared schema definitions
users = table "users" { id = int, name = string, age = int, active = bool }
orders = table "orders" { id = int, user_id = int, total = float, status = string }
```

```
# report.tetaue
import "tables.tetaue"

adults = users & filter (u => u.active && u.age >= 18)

report = adults
    & join "orders" { on = (u, o) => u.id == o.user_id, kind = "inner" }
    & fold (r => { user_id = group r.user_id, order_count = count r.id })
```

- `import "path.tetaue"` brings every binding of that module into scope (imports must
  come before the first binding).
- Paths resolve relative to the importing file; nested imports work; cycles and
  missing files are reported as errors.
- Imported bindings are evaluated in order, so `join "orders"` resolves the table by
  name from the bindings defined before the join.

## Language at a glance

### Values

```
42            # int
3.14          # float
"moria"       # string   (escapes: \" \\ \n \t \r)
true  false   # bool
null          # SQL NULL
[1, 2, 3]     # list (IN lists, sort items)
{ a = 1 }     # map  (schemas, projections, join specs)
```

### Types

`int`, `float`, `string`, `bool`, `date`, `timestamp` — used in table schemas
and checked statically against every operation.

### Query roots and steps

| Builtin | Meaning | Renders to |
|---|---|---|
| `table "name" { col = type, ... }` | query root | `FROM "name"` |
| `filter (u => boolExpr)` | WHERE (after `fold`: HAVING) | `WHERE (...)` / `HAVING (...)` |
| `map (u => { a = expr, ... })` | projection | `SELECT ...` |
| `sort (u => [asc u.a, desc u.b])` | ORDER BY | `ORDER BY ... ASC, ... DESC` |
| `take n` | LIMIT | `LIMIT n` |
| `distinct` | dedupe rows | `SELECT DISTINCT ...` |
| `fold (o => { k = group o.k, s = sum o.v })` | aggregation | `SELECT ... GROUP BY ...` |
| `join "table" { on = (l, r) => ..., kind = "inner" }` | join | `... JOIN ... ON ...` |

Everything is curried: `filter (u => ...)` is a *step* value; applying it to a query
(`users & filter (u => ...)`) builds a new query. Steps are first-class values, so you
can bind them and reuse them:

```
by_age = sort (u => [desc u.age])
q = users & by_age & take 5
```

### Expressions

```
u.age >= 18 && u.active        # comparisons, && (AND), || (OR)
u.name == null                 # → "name" IS NULL
u.name != null                 # → "name" IS NOT NULL
not u.active                   # NOT
is_in u.id [1, 2, 3]           # IN
is_not_in u.id [4, 5]          # NOT IN
upper u.name  lower u.name     # UPPER / LOWER
length u.name                  # LENGTH
coalesce u.nickname u.email    # COALESCE
abs u.balance                  # ABS
count o.id  sum o.total  avg o.total  min o.x  max o.x   # aggregates (in fold)
```

Operator precedence (tightest first): `* / %` → `+ -` → `== != < <= > >=` → `&&` → `||`
→ `&` (pipeline: `a & f` ⇔ `f a`) → `$` (application: `f $ a` ⇔ `f a`, right-assoc).
Application binds tightest: `upper u.name` is `upper (u.name)`.

### Lambdas

- one parameter: `u => u.age >= 18` (parens optional when used as an application arg:
  `filter u => u.active` also works)
- two parameters (joins): `(l, r) => l.id == r.user_id` — parens required, at least two
  params

### Column references

Columns are only accessible through a lambda's row parameter, and the schema follows the
pipeline: after `map (u => { id = u.id, name = u.name })` the row only has `id` and
`name`. After a `join`, both tables' columns are in scope and rendered qualified
(`"users"."id"`, `"orders"."user_id"`). Overlapping column names on a join are an error —
rename one side first with `map`.

## Dialects

Built-in renderers: `sqlite`, `postgresql`, `mysql`. Rendering is capability-driven:
identifier quoting, boolean literals, and string-literal escaping resolve at render time,
so one query can target any dialect.

## Project layout

```
src/language/
  tetaue.langium        # grammar
  generated/            # generated by `bun run langium:generate` (langium-cli)
  interpreter.ts        # symbolic evaluator: curried builtins, types, diagnostics
  imports.ts            # multi-file module resolution (cycles, missing files)
  render.ts             # SQL renderer + dialect specs
  tetaue-module.ts      # Langium dependency injection
  tetaue-validator.ts   # maps interpreter diagnostics to Langium validation
  index.ts              # public API
src/cli.ts              # render / check / parse commands
bin/tetaue.ts           # `tetaue` executable (bun shebang)
test/                   # bun test suite
examples/               # runnable example modules (incl. multi-file report.tetaue)
```

The interpreter powers both the validator and the renderer: the same analysis pass
produces typed Query values and diagnostics, so `check` and `render` never disagree.

## Roadmap

- `values(...)` inline row literals, `union` / `unionAll` set operations
- joins with stepped right-hand sides (subqueries), `prepare`-style parameters
- more of teta's catalog: `when`/CASE, date functions, window functions
- `langium/lsp` language server (hover, go-to-definition, completion) for VS Code
