# tetaue

A pure functional SQL query language, built with [Langium](https://github.com/eclipse-langium/langium)
on bun + TypeScript.

**Syntax** is inspired by [moria](https://codeberg.org/mikitori/moria) (maps `{ k = v }`,
`a => a` lambdas, bare builtin names from a small prelude, `#` comments, multi-file
modules via `import`).
**Semantics** follow [teta](https://github.com/futu2/teta): queries are immutable values
composed from curried functions with the `&` operator, and rendered to SQL per dialect
at render time. Records are first-class values accessed with plain field syntax
(`u.age`), and every pipeline step is a function over row lambdas (`filter`, `map`,
`sort`, `fold`, `join`, ...).

```
# examples/adults.tetaue
users: query {
    id: int,
    name: string,
    age: int,
    active: bool,
} = table "users"

# adult: forall r. { active: bool, age: int | r } -> bool
adult: { active: bool, age: int | r } -> bool = u => u.active && u.age >= 18

adults = users
    & filter (adult)
    & map (u => { id = u.id, name = upper u.name, age = u.age, active = u.active })
    & sort (u => [asc u.name])
    & take 10
```

```console
$ tetaue render examples/adults.tetaue --dialect postgresql
SELECT
    id,
    UPPER(name) AS name,
    age,
    active
FROM users
WHERE
    active
    AND age >= 18
ORDER BY UPPER(name) ASC
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
tetaue render <file.tetaue> [--dialect sqlite|postgresql|mysql|trino|hive] [--format pretty|compact]
tetaue check <file.tetaue>
tetaue parse <file.tetaue>
tetaue format <file.tetaue...> [--check] [--tabs] [--tab-width <n>]   (alias: fmt)
tetaue format --stdin [--check]
tetaue build [dir] [--dialect <name>] [--format pretty|compact] [--out <dir>]
             [--pre-hook <cmd>] [--post-hook <cmd>] [--no-hooks]
tetaue watch <file.tetaue|dir> [--dialect <name>] [--format pretty|compact]
tetaue lsp [--stdio | --node-ipc | --socket=<port> | --pipe=<name>]
```

- `render` validates the module (and its imports) and prints the rendered SQL.
- `check` prints diagnostics (or `OK`). `parse` dumps the AST as JSON.
- `format` (alias `fmt`) runs the same token-stream formatter the editor uses:
  files are rewritten in place (default 4-space indent; `--tabs` / `--tab-width
  <n>` to change it). `--check` only reports files that would change and exits
  1 if any; `--stdin` formats stdin to stdout.
- `build` checks every `.tetaue` file under `dir` (default `.`; `node_modules`,
  `.git`, `out`, `dist` are skipped) and writes the rendered SQL of every module
  whose query compiles, mirroring the tree under `--out` (default `dist/sql`).
  Library modules — clean modules whose last binding is not a query — are
  checked but not written, and a module with diagnostics fails the build
  (exit 1). `--pre-hook`/`--post-hook` run shell commands around the build.
- `watch` re-renders a file — or every `.tetaue` file under a directory — on
  change (debounced); editing `tetaue.toml` re-checks everything. Ctrl+C quits.
- `lsp` starts the language server on stdio (or `--socket`/`--pipe`/`--node-ipc`).

All commands resolve `import` statements relative to the importing file, and
`build`/`watch` honor `[dependencies]` from the nearest `tetaue.toml`.

### Build configuration and hooks

`tetaue build` reads defaults from the nearest `tetaue.toml`'s `[build]` table;
command-line flags override them:

```toml
[build]
out     = "sql"          # output directory for rendered SQL (default dist/sql)
dialect = "postgresql"   # default render dialect (default sqlite)
format  = "compact"      # pretty | compact (default pretty)
pre     = "bun run gen-schema"  # shell command run before the build
post    = "echo done"           # shell command run after the build
```

`--no-hooks` disables both hooks; `--pre-hook`/`--post-hook` replace them for
one invocation. A failing `pre` hook aborts the build; a failing `post` hook
makes the build exit 1.

### Standalone executables

The whole CLI — `render`, `check`, `parse`, `format`, `build`, `watch`, and
`lsp` — compiles into a single portable executable that embeds the bun
runtime, so it runs on machines with neither bun nor node installed:

```sh
bun run build:standalone            # one binary for THIS platform → dist/tetaue
bun run build:standalone:all        # all five platforms (Linux can build for all)
bun run build:standalone:windows    # or: linux, linux-arm, macos, macos-arm
```

Output in `dist/` (git-ignored):

| Platform        | File                        |
|-----------------|-----------------------------|
| Linux x64/arm64 | `tetaue-linux-x64` / `tetaue-linux-arm64` |
| macOS x64/arm64 | `tetaue-darwin-x64` / `tetaue-darwin-arm64` |
| Windows x64     | `tetaue-windows-x64.exe`    |

The first cross-compile for a platform downloads that platform's bun runtime
once (cached afterwards); on the current platform the build is offline. Zip
`dist/` and attach the binaries to a release — they need no dependencies
beyond the OS itself. (The VS Code extension's `lsp` command and the
standalone binary serve the same language server; each editor keeps working
with the extension's own bundled server.)

### Nix (flake)

The repo ships a [flake](https://nixos.wiki/wiki/Flakes) that builds the CLI as
a self-contained executable (like the standalone builds above, but hermetically
— dependencies are fetched from the pinned `bun.lock` instead of a network
`bun install`):

```sh
nix build                   # → result/bin/tetaue (self-contained CLI)
nix run . -- render examples/adults.tetaue --dialect postgresql
nix build .#vsix            # → result = tetaue-vscode-0.1.0.vsix (VS Code extension)
nix develop                   # dev shell: bun, node, langium-cli, bun2nix
nix flake check               # builds the package and runs the test suite
nix fmt                       # format flake.nix with nixpkgs-fmt
```

The VS Code extension is built two ways:

- `nix build .#vsix` produces the raw `.vsix` file — install it with
  `code --install-extension result` (or the Extensions view → Install from VSIX).
- `nix build .#extension` produces a nixpkgs-style extension derivation, for
  NixOS + home-manager:

  ```nix
  programs.vscode.extensions = [ tetaue.packages.${system}.extension ];
  ```

  Its language server bundle (`extension/server/server.mjs`) is built from this
  repo's TypeScript, and the extension's npm dependencies come from
  `extension/package-lock.json` (fetched via `fetchNpmDeps`).

- `bun.nix` is generated from `bun.lock` by
  [bun2nix](https://github.com/nix-community/bun2nix) and must be kept in sync:
  after changing dependencies run `bun2nix -o bun.nix` (available in the dev
  shell) and commit both files.
- The flake pins its own `nixpkgs-unstable` input, so the host NixOS channel
  does not matter.

## Modules

A module is a list of bindings; **the last binding is the module's query**. Bindings
need **no terminator** — `users: query { id: int } = table "users"` is a
binding with a type annotation, and the next binding starts right after it.
`table` is an ordinary function — `table : string -> query r` — and the query
type annotation IS the table's schema.

```
users: query { id: int, name: string, active: bool } = table "users"
adults = users & filter (u => u.active) & take 5
```

(That module's query is `adults`.) Application arguments may be literals,
maps, lists, lambdas, parenthesized expressions, `u.field` access chains, or
**bare identifiers** — `filter adult`, `join inner orders (l => r => ...)`. Bindings
still need no terminator because an identifier lexes as an *argument* only when
it is not followed by `:` or `=` (ignoring whitespace) — so the next binding's
name (`x = ...`, `x: T = ...`) can never be swallowed as an argument.

### Multi-file modules

```
# tables.tetaue — shared schema definitions (exports make them visible)
export users: query { id: int, name: string, age: int, active: bool } = table "users"
export orders: query { id: int, user_id: int, total: float, status: string } = table "orders"
```

```
# report.tetaue
import "tables.tetaue"

adults = users & filter (u => u.active && u.age >= 18)

report: query {
    user_id: int,
    name: string,
    order_count: int,
} = adults
    & map { uid = $1.id, name = $1.name }
    & join inner orders (l => r => l.uid == r.user_id) (l => r => { user_id = r.user_id, name = l.name, order_id = r.id })
    & fold (r => { user_id = group r.user_id, name = group r.name, order_count = count r.order_id })
    & take 20
```

- `import "path.tetaue"` brings the module's **exported** bindings into the
  current module's scope (imports must come before the first binding).
  Nothing else is visible: a binding is public only when marked `export`.
- `import "path.tetaue" as t` binds one name — the namespace `t` — and
  bindings are reached qualified: `t.users`, `t.orders`. Nothing leaks into
  the flat scope. Re-exporting is explicit (`export adult = p.adult`).
- **Selective imports**: `import "tables.tetaue" (users, orders)` (or
  `import "tables.tetaue" as t (users)`) brings exactly those exports —
  unlisted names stay invisible, and a listed name that is not exported is
  an error.
- Each module is its own scope: the prelude, its own imports, its own
  bindings — no module can see a sibling module's bindings or imports.
- Paths resolve relative to the importing file; nested imports work; cycles,
  missing files, and name collisions are reported as errors. Collisions are
  never silent: two flat imports exporting the same name, an alias clashing
  with an import, or a local binding shadowing an imported name are all
  errors.

### Libraries and tetaue.toml

Shared modules are **libraries**. A project declares its libraries in a
`tetaue.toml` manifest at the project root — a path dependency each:

```toml
# tetaue.toml
[dependencies]
acme = { path = "vendor/acme" }
```

```tetaue
# main.tetaue
import "acme/tables"          # → vendor/acme/tables.tetaue (extension inferred)
import "acme"                 # → vendor/acme/index.tetaue (a package folder)
```

- `import "spec"` resolves **relative to the importing file first** (as
  always), then against the file's dependencies — found in the **nearest
  ancestor `tetaue.toml`**. A library may carry its own `tetaue.toml`, so
  its dependencies travel with the folder (a lib can pin its own versions).
- Everything is **local and per project**: no global lib directory, no
  environment variables, no install command. Getting a library is an
  ordinary file operation — copy, symlink, or
  `git clone <url> vendor/acme` — and deleting it removes every
  dependency.
- Clear errors on miss: `dependency 'acme' is not declared in tetaue.toml —
  declared: …`, `no file 'tables' in dependency 'acme'`, broken paths and
  malformed manifests are reported on the `import` statement.
- **Warnings** (non-fatal, shown by `check` and the editor): a local file
  shadowing a declared dependency, and a lib without its own `tetaue.toml`
  whose imports fall through to the outer project's manifest (make the lib
  self-contained).
- **Editor integration**: `t.` completes the lib's exported bindings,
  Ctrl+click jumps from `import "…"`/`t.users` to the lib file, hover shows
  the lib's doc comments, and editing a lib file or `tetaue.toml`
  revalidates the open query files that import it.

A complete runnable project is in `examples/lib-project/` — a `tetaue.toml`,
a vendored `acme` library that depends on `shared` through its own manifest,
and a `main.tetaue` using flat, namespaced, and selective imports
(`examples/selective.tetaue` shows selective imports against the flat
examples folder).

## Language at a glance

### Values

```
42            # int
3.14          # float
"moria"       # string   (escapes: \" \\ \n \t \r)
true  false   # bool
null          # SQL NULL
[1, 2, 3]     # list (IN lists, sort items)
{ a = 1 }     # record (projections)
$1, $2        # implicit lambda parameters: ($1 + 3) ≡ u => u + 3
```

### Queries and records

A query is a table plus a pipeline of steps, threaded with `&` (the pipeline:
`a & f` ⇔ `f a`). Steps are functions over **row lambdas** — a row is a
first-class record, and columns are read with plain field access (`u.age`):

```
u.age                 # view a field on a record / row
u & filter ...        # pipeline: apply the step to the query
```

- A **record** is `{ k = v, ... }` (a projection); a table schema is a query
  TYPE annotation: `users: query { id: int, name: string } = table "users"`.
  An un-annotated table is dynamic — its row type is inferred from use.
- `filter` keeps the rows whose predicate is true (`filter p` ≡ `filtered p`
  — both names work). After a `fold` it becomes `HAVING`.
- A `fold` ends the flat `FROM` scope: `map`, `join`, and further `fold`s
  after a `fold` run on the aggregated result, which is wrapped as a derived
  table (teta-style) — so you can project the aggregate
  (`fold ... & map (r => { t = r.total })`), aggregate it again
  (`map (r => { g = sum r.total })` or another `fold`), or join it:
  ```
  totals = orders & fold (o => { user_id = group o.user_id, total = sum o.total })
  enriched = totals & join left users (t => u => t.user_id == u.id) (t => u => { uid = t.user_id, name = u.name })
  # SELECT
  #     totals.user_id, totals.total, users.id, users.name
  # FROM (SELECT user_id, SUM(total) AS total FROM orders
  #       GROUP BY user_id) AS totals
  # LEFT JOIN users ON totals.user_id = users.id
  ```
- `map` projects one record per row — the `SELECT`. Transforming a single
  column is just a projection that reuses the name:
  ```
  users & map (u => { id = u.id, name = upper u.name, age = u.age, active = u.active })
  ```
- `merge l r` (also written infix `l <> r`) combines two records — extend a
  row with computed fields (`map (u => u <> { active = u.age >= 18 })`), or
  layer two projections. The right record wins on overlapping fields
  (JS/Nix object-spread style); the result keeps the left row's other
  fields, and row polymorphism sees the full union
  (`query { id, name, active | r }`). With the empty record as identity it
  is a monoid, hence the `<>` spelling (Haskell/PureScript). Merging a row
  with an unknown schema (an un-annotated table) is an error — annotate the
  table.
- `<<<`/`>>>` compose **functions** point-free (`f <<< g` = `x => f (g x)`),
  so bound predicates are reusable: `adult = u => u.age >= 18` then
  `filter (adult)`.

### Types

`int`, `float`, `string`, `bool`, `date`, `timestamp` — used in table schemas
and checked statically against every operation. `t?` is the Maybe-style
nullable type ("a `t` or NULL") — write `email: string?` for a column that
may be NULL. `null` has type `forall a. a?`, so `u.email == null`,
`coalesce u.nickname u.email`, and arithmetic on nullable columns all just
work. `int` and `float` are distinct — no implicit promotion:
`u.age >= 18` is fine, but `u.age >= 18.0` (int column vs float literal) is a
type error; write `18.0` against a `float` column.

### Types and annotations

Every expression is checked by a Hindley–Milner inference pass with **row
polymorphism**: a row lambda is typed once against row variables and reused on
any schema that has the fields it touches.

```
adult = u => u.age >= 18          # : forall r. { age: int? | r } -> bool
users & filter (adult)            # users has { id, name, age, active }
kids  & filter (adult)            # kids  has { id, age, guardian }
```

Type annotations can be written on **any expression** (`e: T`, lowest
precedence), on bindings (`name: T = ...`), and on lambda parameters
(`(u: T) => ...`). A lowercase variable in a record's tail position is a *row*
variable; elsewhere it's a *type* variable; free variables in a signature are
implicitly `forall`-quantified.

```
adult: { age: int | r } -> bool = u => u.age >= 18   # open row — reusable
adult: { age: int } -> bool     = u => u.age >= 18   # closed row — narrows
q = users & filter (u: { age: int | r }) => u.age >= 18
q = users & map (u => { a = u.age: int })
q: query { id: int } = table "users" : query { id: int }    # ascribe a query type
```

Annotations are erased at evaluation time; `check` and `render` both reject
type errors, so they never disagree.

### Query roots and steps

| Builtin | Meaning | Renders to |
|---|---|---|
| `table "name"` | query root; schema from the binding annotation (`t: query { col: type } = table "name"`) or inferred | `FROM name` |
| `filter (u => boolExpr)` | keep rows matching a predicate (alias: `filtered`) | `WHERE ...` / `HAVING ...` |
| `map (u => { a = expr, ... })` | project one record per row | `SELECT ...` |
| `sort (u => [asc u.a, desc u.b])` | ORDER BY | `ORDER BY ... ASC, ... DESC` |
| `take n` | LIMIT | `LIMIT n` |
| `distinct` | dedupe rows | `SELECT DISTINCT ...` |
| `fold (o => { k = group o.k, s = sum o.v })` | aggregation | `SELECT ... GROUP BY ...` |
| `join inner table ($1.id == $2.user_id) { uid = $1.id }` | join | `... JOIN ... ON ...` |

Everything is curried: `filter (u => ...)` is a *step* value; applying it to a query
(`users & filter (u => ...)`) builds a new query. Steps are first-class values, so you
can bind them and reuse them. `join` composes the same way. It takes FOUR positional
arguments — the join kind (`inner`, `left`, `right` or `full`, a bare identifier), the
right-hand query, and the two-argument (curried) `on` and `merger` functions
that projects the result row (like `map`, with both rows in scope). The merger may
also be a plain two-argument function — `merge` itself works, giving the full union
of both rows (right wins on overlap):

```
paid_orders = orders & filter (o => o.status == "paid")
q = users & join inner paid_orders ($1.id == $2.user_id) merge
```

The right side is a first-class query VALUE (any binding or pipeline — stepped right
sides render as subqueries). Because the merger picks the output columns explicitly,
overlapping column names are not an error — rename them in the merger instead.

```
by_age = sort (u => [desc u.age])
q = users & by_age & take 5
```

### Expressions

```
u.age >= 18 && u.active       # comparisons, && (AND), || (OR)
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
list o.tag                      # collect values into a list: ARRAY_AGG (trino/pg), COLLECT_LIST (hive), JSON_ARRAYAGG (mysql), JSON_GROUP_ARRAY (sqlite)
current_date  current_timestamp   # CURRENT_DATE / CURRENT_TIMESTAMP (bare keywords)
year u.created_at  month u.created_at  day u.created_at  day_of_week u.created_at
hour u.created_at  minute u.created_at  second u.created_at
extract u.created_at "month"   # generic date part (string literal)
date_add u.created_at "day" (-7)         # DATE_ADD / INTERVAL, per dialect
date_diff u.created_at "day" current_date
date_trunc u.created_at "month"
date_format u.created_at "%Y-%m-%d"      # dialect-native format string
date_parse u.note "%Y-%m-%d"             # dialect-native format string
to_unixtime u.created_at  from_unixtime u.id
ceil u.balance  floor u.balance  sqrt u.balance  pow u.balance 2  mod u.id 3
round u.balance 2                      # optional scale
greatest u.a u.b  least u.a u.b        # variadic — all arguments at once
concat u.first u.last                  # variadic; sqlite renders || — joins
merge u { active = true }              # record union — right record wins on overlap
u <> { active = true }                 # infix form of merge (a monoid: {} is the identity)
trim u.name  reverse u.name  replace u.name "x" "y"
substring u.name 1 3                   # optional length; sqlite renders SUBSTR
position u.name "a"                    # POSITION / LOCATE / INSTR, per dialect
left_substring u.name 3  right_substring u.name 2
lpad u.code 8 "0"  rpad u.code 8 "0"   # sqlite has no LPAD/RPAD (render error)
regex_like u.name "^[A-Z]"  regex_replace u.name "[0-9]" "#"
regex_extract u.name "([0-9]+)" 1
like u.name "a%"                       # x LIKE pattern
null_if u.name ""  is_null u.name  is_not_null u.name
case { u.active => u.name, _ => "inactive" }    # CASE WHEN active THEN name ELSE 'inactive' END
case { u.age < 18 => "minor", u.age >= 65 => "senior", _ => "adult" }   # multi-branch; `_` is the fallback
case u.code { "101" => "one", "102" => "two", _ => u.code }   # simple case: branches compare with the subject
cast u.id "string"  try_cast u.name "int"   # TRY_CAST is Trino-only
over row_number { partition = [u.dept], order = [desc u.salary] }   # window functions — parens optional for zero-arg fns
over rank { partition = [u.dept] }          # rank / dense_rank / percent_rank
over (ntile 4) { partition = [u.dept] }     # multi-arg fns keep parens
over (lag u.salary 1 0) { order = [asc u.joined] }   # lag / lead (offset, default optional)
over (sum u.salary) { partition = [u.dept] }        # windowed aggregates
```

Operator precedence (tightest first): `>>> <<<` (function composition,
PureScript-style) → `* / %` → `+ - <>` (`<>` is the record-merge monoid) →
`== != < <= > >=` → `&&` → `||` → `&`
(pipeline: `a & f` ⇔ `f a`) → `$` (application: `f $ a` ⇔ `f a`, right-assoc).
Application binds tightest: `upper u.name` is `upper (u.name)`.

### Lambdas

Lambdas abstract over a row. Two ways to write them:

- **Implicit (`$n`)** — a parenthesized expression using `$1`, `$2`, ... is a lambda
  whose parameters are the row bindings in order: `($1 + 3)` ≡ `u => u + 3`,
  `($1 + $2)` ≡ `$1 => $2 => $1 + $2`. The highest `$n` used sets the arity:
  ```
  filter ($1.active && $1.age >= 18)          # ≡ filter (u => u.active && u.age >= 18)
  map { id = $1.id, name = $1.name }          # braces delimit the lambda — no extra parens
  join inner orders ($1.id == $2.user_id) { uid = $1.id, oid = $2.id }   # $1 left row, $2 right row; the merger projects the result row
  ```
  Parens inside are pure grouping: `map { a = ($1.id + 1) }` means exactly the same
  as `map { a = $1.id + 1 }` — `$n` binds to the enclosing argument (the outermost
  lambda), never to an inner pair of parens.
- **Explicit** — `u => u.age >= 18`. Lambdas are curried: a two-argument function
  is `l => r => l.id == r.user_id` (there is no `(l, r) => ...` form). `$n` is not
  available inside an explicit body.

A lambda body extends until the next `&` (pipeline) or `$` (application) at the same
level — `join inner orders (l => r => l.id == r.user_id) (l => r => { id = l.id }) & take 3`
ends the merger at the record and pipelines `take 3` to the join. To use `&`/`$`
inside a lambda body, parenthesize it: `u => (u.a & take 1)`.

Either form binds a step the same way: `adults = filter ($1.active)` is a step
value, so `users & adults` works.

### Column references

Columns are only accessible through a lambda's row parameter (a first-class record),
and the schema follows the pipeline: after `map (u => { id = u.id, name = u.name })`
the row only has `id` and `name`. After a
`join`, both tables' columns are in scope inside the `on` and `merger` lambdas and
rendered qualified (`users.id`, `orders.user_id`). The result row is exactly
what the merger projects — overlapping column names are fine, just pick them apart
in the merger (e.g. `{ left_id = l.id, right_id = r.id }`).

## Dialects

Built-in renderers: `sqlite`, `postgresql`, `mysql`, `trino`, `hive`. Rendering is capability-driven:
identifier quoting, boolean literals, and string-literal escaping resolve at render time,
so one query can target any dialect.

## VS Code extension

The repo ships a VS Code extension (`extension/`) that serves the language over
LSP and compiles modules to SQL in real time.

- **Live diagnostics** — the validator (interpreter + type inference) runs on
every keystroke: errors underline in the editor and land in the Problems panel.
- **Hover** — shows the static type of the expression under the cursor
(`u.age : int`, `adult : { active: bool, age: int | r } -> bool`), plus the
`#` doc-comment block of the binding it refers to.
- **Semantic highlighting** — the language server colors tokens from the
grammar, not regexes: prelude builtins (`table`, `filter`, …) as
`function` + `defaultLibrary`, lambda bindings and parameters (including `$n`)
as `function`/`parameter`, type names as `type`, record fields and map keys as
`property`, operators as `operator`. The bundled TextMate grammar stays as the
offline fallback.
- **Completion** — after a `.` on a record-typed expression the row's fields
are suggested with their types (`users & map (u => u.` → `id`, `name`, ...).
Works mid-typing via a synthetic parse + the real inference pass.
- **Outline, folding, keyword completion** — grammar-driven document symbols
and completion from Langium's default LSP providers.
- **Formatting** — *Format Document / Format Selection* (Shift+Alt+F) normalize
spacing, indentation (4-space, or your editor settings) and trailing
whitespace. Line breaks and blank lines are preserved, strings/comments/escapes
stay verbatim, and whitespace around `-` is untouched (it is semantically
meaningful: `abs -1` ≠ `abs - 1`).
- **Realtime compile** — saving a `.tetaue` file renders the module's query to
SQL in the *Tetaue* output panel (toggle: `tetaue.renderOnSave`, default on).
`Tetaue: Render to SQL` (command palette) renders the active file on demand.
- **Dialect** — `tetaue.dialect` (`sqlite` | `postgresql` | `mysql` | `trino` | `hive`, default
`sqlite`) selects the renderer for both the output panel and the CLI.
- **Copy to clipboard** — `tetaue.copyToClipboardOnRender` (default off): when
on, every successful render (the command *and* render-on-save) also copies
the SQL to the clipboard, with a brief status-bar confirmation.

The language server is bundled to plain JavaScript and runs on the Node that
ships with VS Code — users need no bun, no TypeScript toolchain.

```sh
bun install                 # language deps (root)
cd extension && npm install # extension deps (vscode-languageclient, vsce)
bun run build:extension     # bundle server → extension/server/server.mjs + compile client
```

Run it: open this repo in VS Code and press F5 (launch config *Run Extension
(Tetaue)*), or package and install a `.vsix`:

```sh
bun run package:extension   # → extension/tetaue-vscode-0.1.0.vsix
code --install-extension extension/tetaue-vscode-0.1.0.vsix
```

Architecture:

- `src/language-server.ts` — LSP entry: `startLanguageServer` plus the custom
`tetaue/render` request that powers the realtime compile.
- `src/language/tetaue-module.ts` — Langium wiring, upgraded to the full
`langium/lsp` service set.
- `src/language/compile.ts` — the shared parse → analyze → infer → render
pipeline used by both the CLI and `tetaue/render`, so they never disagree.
- `src/language/lsp/hover.ts` — hover: static types from the inference pass
(`nodeTypes` map) plus `#` doc-comment blocks.
- `src/language/lsp/completion.ts` — `.`-field completion on a synthetic
parse (inserts a dummy property, balances delimiters) so the real inference
resolves the receiver's row even mid-typing.
- `src/language/lsp/formatter.ts` — token-stream formatter: canonical spacing
and depth-aware indentation, layout-preserving (keeps line breaks), `-`-safe.
- `src/language/lsp/semantic-tokens.ts` — grammar-aware highlighting: builtins,
lambda parameters, types, record fields, and operators as LSP semantic tokens.
- `extension/src/extension.ts` — the VS Code client (`vscode-languageclient`):
spawns the server, wires Render-on-Save and the render command.

## Project layout

```
src/language/
  tetaue.langium        # grammar
  generated/            # generated by `bun run langium:generate` (langium-cli)
  interpreter.ts        # symbolic evaluator: curried builtins, query steps, diagnostics
  types.ts              # type engine: HM unification with rows and `t?` nullability
  inference.ts          # type inference pass: prelude schemes, annotations, diagnostics
  imports.ts            # multi-file module resolution (cycles, missing files)
  render.ts             # SQL renderer + dialect specs
  compile.ts            # shared compile pipeline (CLI + language server)
  tetaue-module.ts      # Langium dependency injection (core + LSP services)
  tetaue-validator.ts   # maps interpreter + inference diagnostics to Langium validation
  index.ts              # public API
src/language-server.ts  # LSP entry: startTetaueServer() + tetaue/render request
src/cli.ts              # render / check / parse / format / build / watch / lsp commands
bin/tetaue.ts           # `tetaue` executable (bun shebang)
extension/              # VS Code extension (client, manifest, grammar, packaging)
test/                   # bun test suite (incl. an end-to-end LSP test)
examples/               # runnable example modules (incl. multi-file report.tetaue, joins.tetaue, case.tetaue)
```

The interpreter powers rendering and the structural checks; the inference pass
adds the static type layer (row polymorphism, annotations, strict numerics).
Both run in `check`/`render`, and their diagnostics are merged with exact
dedupe — so `check` and `render` never disagree.

## Roadmap

- `values(...)` inline row literals, `union` / `unionAll` set operations
- `prepare`-style parameters, more of teta's catalog
- more of teta's catalog: `case` inside `fold` with aggregates, more array
  functions (indexing, element-wise — `list` aggregation and `[T]` column
  annotations landed), lateral joins / recursive CTEs
- LSP polish: completion for `$n` implicit lambdas, hover types for qualified
  access across libs. (Go-to-definition across imports, `t.` completion, lib
  doc hover, builtin-name completion, and importer revalidation on
  lib/manifest changes are done.)
