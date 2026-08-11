# tetaue

A pure functional SQL query language, built with [Langium](https://github.com/eclipse-langium/langium)
on bun + TypeScript.

**Syntax** is inspired by [moria](https://codeberg.org/mikitori/moria) (maps `{ k = v }`,
`a => a` lambdas, bare builtin names from a small prelude, `#` comments, multi-file
modules via `import`).
**Semantics** follow [teta](https://github.com/futu2/teta): queries are immutable values
composed from curried functions with the `&` operator, and rendered to SQL per dialect
at render time.
**Abstraction** is a lens/optics core in the style of Haskell's `lens` with
PureScript-style composition: records are first-class values, every field is a
lens (`u ^. age`), and a query pipeline is optic composition (`filtered`,
`mapped`, `%~`, `.~`, `<<<`). See
[docs/design/optics.md](docs/design/optics.md).

```
# examples/adults.tetaue
users = table "users" {
    id = int,
    name = string,
    age = int,
    active = bool,
}

adults = users
    & filtered (u => u.active && u ^. age >= 18)
    & mapped <<< name %~ upper             # transform a column across rows
    & sort (u => [asc u.name])
    & take 10
```

```console
$ tetaue render examples/adults.tetaue --dialect postgresql
SELECT "id", UPPER("name") AS "name", "age", "active"
FROM "users"
WHERE ("active" AND "age" >= 18)
ORDER BY UPPER("name") ASC
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
    & join { right = orders, on = (u, o) => u.id == o.user_id, kind = "inner" }
    & fold (r => { user_id = group r.user_id, order_count = count r.id })
```

- `import "path.tetaue"` brings every binding of that module into scope (imports must
  come before the first binding).
- Paths resolve relative to the importing file; nested imports work; cycles and
  missing files are reported as errors.

## Language at a glance

### Values

```
42            # int
3.14          # float
"moria"       # string   (escapes: \" \\ \n \t \r)
true  false   # bool
null          # SQL NULL
[1, 2, 3]     # list (IN lists, sort items)
{ a = 1 }     # record (schemas, projections, join specs)
```

### Optics (the core abstraction)

The language is built on Haskell lens/optics. A record field is a lens; `view`,
`over` and `set` are the three fundamental operations, and `&` is the pipeline
(`a & f` ⇔ `f a`, same as lens' `&`).

```
u ^. age              # view the `age` lens   ⇔ u.age
u & name %~ upper     # over: transform a field (record -> record)
u & age .~ 18         # set:  replace a field
```

- **Every record field is an indexed lens** — the index is the field name,
  like lens over a `Map`. `at "key"` is the fundamental **total** lens: the
  focus is the value or `none` (absence, distinct from SQL `null`), so it can
  add, remove and rename keys:
  ```
  users & at "name" .~ "anon"                      # set a column
  users & at "name" .~ none                        # remove it (exclude)
  users & mapped %~ (u => u & at "user_name" .~ u ^. at "name" & at "name" .~ none)   # rename
  ```
  `ix "key"` (alias `field "key"`) is the partial traversal over a present
  value; `nick = ix "name"` binds a lens and composes: `mapped <<< nick %~ upper`.
- Optics compose **explicitly** with the PureScript operators — `.` stays purely
  field access on records: `l1 <<< l2` (left optic is outer, like Haskell `.`)
  and its flip `l1 >>> l2`. `mapped <<< name` reads "the name field inside the
  rows traversal". The same operators compose **functions** point-free
  (`f <<< g` = `x => f (g x)`).
- Applying a field-lens update to a *query* lifts it to the rows
  (`users & name %~ upper` ⇔ `users & mapped <<< name %~ upper`).
- `map`/`filter` are sugar: `map f` ≡ `mapped %~ f`, `filter p` ≡ `filtered p`.
- `<<<`/`>>>` also compose **functions** point-free (`f <<< g` = `x => f (g x)`),
  so bound predicates are reusable: `adult = u => u ^. age >= 18` then
  `filtered (adult)`.

See [docs/design/optics.md](docs/design/optics.md) for the full design.

### Types

`int`, `float`, `string`, `bool`, `date`, `timestamp` — used in table schemas
and checked statically against every operation.

### Query roots and steps

| Builtin | Meaning | Renders to |
|---|---|---|
| `table "name" { col = type, ... }` | query root | `FROM "name"` |
| `filtered (u => boolExpr)` | selection optic (alias: `filter`) | `WHERE (...)` / `HAVING (...)` |
| `mapped %~ (u => { a = expr, ... })` | over the rows traversal (alias: `map`) | `SELECT ...` |
| `mapped <<< col %~ f` / `mapped <<< col .~ v` | transform / set one column | `SELECT ..., f(col) AS col, ...` |
| `sort (u => [asc u.a, desc u.b])` | ORDER BY | `ORDER BY ... ASC, ... DESC` |
| `take n` | LIMIT | `LIMIT n` |
| `distinct` | dedupe rows | `SELECT DISTINCT ...` |
| `fold (o => { k = group o.k, s = sum o.v })` | aggregation | `SELECT ... GROUP BY ...` |
| `join { right = table, on = (l, r) => ..., kind = "inner" }` | join | `... JOIN ... ON ...` |

Everything is curried: `filtered (u => ...)` is a *step* value; applying it to a query
(`users & filtered (u => ...)`) builds a new query. Steps are first-class values, so you
can bind them and reuse them. `join` composes the same way: its `right` entry is a
first-class query value (any binding or pipeline — stepped right sides render as
subqueries), never a table name.

```
paid_orders = orders & filtered (o => o.status == "paid")
q = users & join { right = paid_orders, on = (u, o) => u.id == o.user_id }
```

```
by_age = sort (u => [desc u.age])
q = users & by_age & take 5
```

### Expressions

```
u ^. age >= 18 && u.active     # view the age lens; comparisons, && (AND), || (OR)
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

Operator precedence (tightest first): `>>> <<<` (composition, PureScript-style) →
`^. %~ .~` (lens) → `* / %` → `+ -` → `== != < <= > >=` → `&&` → `||` → `&`
(pipeline: `a & f` ⇔ `f a`) → `$` (application: `f $ a` ⇔ `f a`, right-assoc).
Application binds tightest: `upper u.name` is `upper (u.name)`.

### Lambdas

- one parameter: `u => u.age >= 18` (parens optional when used as an application arg:
  `filter u => u.active` also works)
- two parameters (joins): `(l, r) => l.id == r.user_id` — parens required, at least two
  params

### Column references

Columns are only accessible through a lambda's row parameter (a first-class record),
and the schema follows the pipeline: after `mapped %~ (u => { id = u.id, name = u.name })`
the row only has `id` and `name`. `u.id` and `u ^. id` are the same view. After a
`join`, both tables' columns are in scope and rendered qualified
(`"users"."id"`, `"orders"."user_id"`). Overlapping column names on a join are an error —
rename one side first with `mapped %~`.

## Dialects

Built-in renderers: `sqlite`, `postgresql`, `mysql`. Rendering is capability-driven:
identifier quoting, boolean literals, and string-literal escaping resolve at render time,
so one query can target any dialect.

## Project layout

```
src/language/
  tetaue.langium        # grammar
  generated/            # generated by `bun run langium:generate` (langium-cli)
  interpreter.ts        # symbolic evaluator: optics core, curried builtins, diagnostics
  imports.ts            # multi-file module resolution (cycles, missing files)
  render.ts             # SQL renderer + dialect specs
  tetaue-module.ts      # Langium dependency injection
  tetaue-validator.ts   # maps interpreter diagnostics to Langium validation
  index.ts              # public API
src/cli.ts              # render / check / parse commands
bin/tetaue.ts           # `tetaue` executable (bun shebang)
test/                   # bun test suite (incl. test/optics.test.ts)
examples/               # runnable example modules (incl. optics.tetaue, multi-file report.tetaue)
docs/design/optics.md   # the optics architecture
```

The interpreter powers both the validator and the renderer: the same analysis pass
produces typed Query values and diagnostics, so `check` and `render` never disagree.

## Roadmap

- optics: `each`/`both` traversals over lists, a `lens get set` builder,
  `makeLenses`-style record types (`type User = { id = int, ... }`), prisms
  for nullables — see [docs/design/optics.md](docs/design/optics.md)
- `values(...)` inline row literals, `union` / `unionAll` set operations
- `prepare`-style parameters, `union` / `unionAll`, more of teta's catalog
- more of teta's catalog: `when`/CASE, date functions, window functions
- `langium/lsp` language server (hover, go-to-definition, completion) for VS Code
