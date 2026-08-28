# tetaue

A pure functional SQL query language, built with [Langium](https://github.com/eclipse-langium/langium)
on bun + TypeScript.

**Syntax** is inspired by [moria](https://codeberg.org/mikitori/moria) (maps `{ k = v }`,
`a => a` lambdas, public names from a source prelude, `#` comments, multi-file
modules via `import`).
**Semantics** follow [teta](https://github.com/futu2/teta): queries are immutable values
composed from curried functions with the `&` operator, and rendered to SQL per dialect
at render time. Records are first-class values accessed with plain field syntax
(`u.age`), and every pipeline step is a function over row lambdas (`filter`, `map`,
`sort`, `fold`, `joinInner`, ...).

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
             [--json] [--binding <name>]
tetaue check <file.tetaue>
tetaue types <file.tetaue>
tetaue parse <file.tetaue>
tetaue format <file.tetaue...> [--check] [--tabs] [--tab-width <n>]   (alias: fmt)
tetaue format --stdin [--check]
tetaue build [dir] [--dialect <name>] [--format pretty|compact] [--out <dir>]
             [--pre-hook <cmd>] [--post-hook <cmd>] [--no-hooks]
tetaue watch <file.tetaue|dir> [--dialect <name>] [--format pretty|compact]
tetaue lsp [--stdio | --node-ipc | --socket=<port> | --pipe=<name>]
```

- `render` validates the module (and its imports) and prints the rendered SQL.
  Every named intermediate query renders as a `WITH name AS (...)` CTE, so
  the body references subqueries by name instead of duplicating them
  (lateral join rights stay inline — they are correlated with the left row).
  `--json` prints `{ sql, parameters }`; `--binding <name>` renders a named
  root binding instead of the last one.
- `check` prints diagnostics (or `OK`). `types` prints the inferred type
  of every binding. `parse` dumps the AST as JSON.
- `format` (alias `fmt`) runs the same token-stream formatter the editor uses:
  files are rewritten in place (default 4-space indent; `--tabs` / `--tab-width
  <n>` to change it). `--check` only reports files that would change and exits
  1 if any; `--stdin` formats stdin to stdout.
- `build` checks every `.tetaue` file under `dir` (default `.`; `node_modules`,
  `.git`, `out`, `dist` are skipped) and writes the rendered SQL of every module
  whose query compiles, mirroring the tree under `--out` (default `dist/sql`).
  Library modules — clean modules with no `main` query — are
  checked but not written, and a module with diagnostics fails the build
  (exit 1). `--pre-hook`/`--post-hook` run shell commands around the build.
- `watch` re-renders a file — or every `.tetaue` file under a directory — on
  change (debounced). Ctrl+C quits.
- `lsp` starts the language server on stdio (or `--socket`/`--pipe`/`--node-ipc`).

All commands resolve `import` statements relative to the importing file; there
is **no config file and no package layer** — everything a module needs is a
file on disk reachable from it.

### Build options

`tetaue build` takes every option from the command line:

```sh
tetaue build . --out sql --dialect postgresql --format compact \
               --pre-hook "bun run gen-schema" --post-hook "echo done"
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

## Set operations and record update

Queries compose with the pure set combinators `union`, `union_all`,
`intersect`, and `except` exactly like any other pipeline step:

    active_or_archived = active_users & union_all archived_users

Both operands are complete relational expressions; a later `sort`/`take`
runs on the combined result. Record update is merge sugar: `{ u | active =
u.age >= 18 }` is `merge u { active = u.age >= 18 }`, so projections can
extend a row without repeating every column.

## Modules

A module is a list of bindings; **the module's query is its `main` binding**. A
module without a `main` binding is a *library* — it is type-checked but does
not compile to SQL (`build` writes nothing for it). Bindings need **no
terminator** — `users: query { id: int } = table "users"` is a
binding with a type annotation, and the next binding starts right after it.
`table` is an ordinary function — `table : string -> query r` — and the query
type annotation IS the table's schema.

Bindings are **order-independent** (Haskell-style): a definition may reference
any other binding in the module, whether it appears earlier or later, so

    main = x
    x = table "ktable"

is exactly as valid as the reverse order. Recursive top-level bindings
(`a = b`, `b = a`) are not supported — use `let` for a local recursion or the
`recursive` query step for SQL recursion.

### Core and standard prelude

The language is checked and evaluated by one shared pass (`checkProject`). Its
TypeScript core is limited to SQL-aware primitives, all reserved under `@`
(`@filter`, `@table`, `@int`, ...). Reusable functional helpers and public
aliases (`filter = @filter`, `type int = @int`) live in
[`prelude.tetaue`](prelude.tetaue) and are processed by the
same parser, inference engine, and interpreter as application code. The
standard helpers include the `_op_` bindings, `id`, `const`, `compose`, `flip`,
`pipe`, and the derived Maybe predicates; local bindings and imports may shadow
them normally. Infix parsing
and precedence stay in the grammar, while an expression such as `1 + 2`
resolves the scoped `_+_` function defined by the prelude. See
[`docs/design/core.md`](docs/design/core.md) for the boundary and extension
rules.

Numeric literals are polymorphic, Haskell-`fromIntegral`-style: `1 : Num t => t`
(int | float | decimal) and `1.5 : Frac t => t` (float | decimal), so a plain
`1` adapts to its context — `o.total + 1` works when `total: decimal`, and
`u.balance / 2` works when `balance: float`. An unconstrained literal defaults
to a concrete type (`x = 1 : int`, `x = 1.5 : float`). Nullable and
aggregate/window values must still be unwrapped before arithmetic.

The `?` operator is relude-style unwrap-with-default: `u.email ? "n/a"` is
`from_maybe "n/a" u.email` and lowers to `COALESCE(email, 'n/a')`.

```
users: query { id: int, name: string, active: bool } = table "users"
main = users & filter (u => u.active) & take 5
```

(That module's query is `main`.) Application arguments may be literals,
maps, lists, lambdas, parenthesized expressions, `u.field` access chains, or
**bare identifiers** — `filter adult`, `joinInner orders (l => r => ...)`. Bindings
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
    & map { uid = this.id, name = this.name }
    & joinInner orders (l => r => l.uid == r.user_id) (l => r => { user_id = r.user_id, name = l.name, order_id = r.id })
    & fold (r => { user_id = group r.user_id, name = group r.name, order_count = count r.order_id })
    & take 20
```

- `import "path.tetaue"` brings the module's **exported** bindings into the
  current module's scope. Nothing else is visible: a binding is public only
  when marked `export`.
- `import "path.tetaue" as t` binds one name — the namespace `t` — and
  bindings are reached qualified: `t.users`, `t.orders`. Nothing leaks into
  the flat scope.
- **Selective imports**: `import "tables.tetaue" (users, orders)` (or
  `import "tables.tetaue" as t (users)`) brings exactly those exports —
  unlisted names stay invisible, and a listed name that is not exported is
  an error. Rename while importing with `a as b`:
  `import "tables.tetaue" (users as people)` /
  `import "tables.tetaue" as t (users as people)` expose `people` /
  `t.people`.
- **Re-exports**: `export * from "tables.tetaue"` re-exports every binding
  the target module exports; `export { users as people } from "tables.tetaue"`
  re-exports exactly the listed names (renamed as shown). Re-exports add to
  the module's public surface without binding local names, so an **index
  module** can aggregate a package: `export * from "./users"` +
  `export * from "./orders"` in an `index.tetaue` makes
  `import "package"` (resolved to `package/index.tetaue`) expose both.
- Each module is its own scope: the prelude, its own imports, its own
  bindings — no module can see a sibling module's bindings or imports.
  Imports, re-exports, `type` aliases and bindings may appear in any order
  in a module.
- Paths resolve **relative to the importing file**; nested imports work;
  cycles, missing files, and name collisions are reported as errors.
  Collisions are never silent: two flat imports exporting the same name, an
  alias clashing with an import, a local binding shadowing an imported name,
  or two re-exports colliding are all errors.

### Libraries and packages

There is no manifest and no package layer: a library is just a module (or a
folder of modules) you reach with a relative path.

```tetaue
# main.tetaue
import "./vendor/acme/tables"     # → ./vendor/acme/tables.tetaue (extension inferred)
import "./vendor/acme"            # → ./vendor/acme/index.tetaue (a package folder)
```

- `import "spec"` resolves relative to the importing file. For every
  location three forms are tried: `spec`, `spec.tetaue`, and
  `spec/index.tetaue` — so a folder of modules works as a package with an
  `index.tetaue` entry that aggregates its modules with re-exports.
- Everything is **local and per project**: no global lib directory, no
  environment variables, no install command. Getting a library is an
  ordinary file operation — copy, symlink, or `git clone <url> vendor/lib` —
  and deleting it removes every dependency. Nested imports resolve relative
  to the importing file, so a vendored lib travels with its own sub-imports.
- Clear errors on miss: `cannot resolve import 'acme/tables' — searched: …`
  is reported on the `import` statement.
- **Editor integration**: `t.` completes the namespace's exports (through
  index re-exports too), Ctrl+click jumps from `import "…"`/`t.users` to the
  lib file and through re-export chains to the underlying binding, hover
  shows the lib's doc comments, and editing a lib file revalidates the open
  query files that import it.

A complete runnable project is in `examples/lib-project/` — a vendored
`acme` library with an `index.tetaue` aggregating its per-concern modules and
a `main.tetaue` using flat, namespaced, and selective imports
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
this, that    # implicit lambda parameters: (this.id + 3) ≡ u => u.id + 3
param "id"    # query parameter placeholder (SQL bind parameter)
date "2024-01-01" / timestamp "2024-01-01 12:00:00"  # ISO literals
```

### Query parameters

`param "name"` is an ordinary scalar expression: annotate it to fix its
static type, and the renderer emits a dialect-native bind placeholder.

```
id = (param "user_id") : int
q = users & filter (u => u.id == id)
# PostgreSQL → WHERE id = $1
# SQLite/MySQL/Trino/Hive → WHERE id = ?
```

The same parameter name is rendered as one PostgreSQL `$n` placeholder no
matter how many times it appears.

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
  Inside a row lambda, `{ id, name }` is field punning sugar for
  `{ id = u.id, name = u.name }`. An un-annotated table is dynamic — its row
  type is inferred from use.
- Steps apply in source order: when `take`, `distinct` or a window
  projection is followed by another step, the renderer wraps the earlier
  query as a derived table so `q & take 2 & sort ...` really limits first
  and sorts second. Repeated `take` steps fold to the smaller limit, and a
  new `sort` replaces the previous one.
- `filter` keeps the rows whose predicate is true. After a `fold` it becomes
  `HAVING`.
- A `fold` ends the flat `FROM` scope: `map`, joins, and further `fold`s
  after a `fold` run on the grouped/aggregated result, which is wrapped as a derived
  table (teta-style) — so you can project the aggregate
  (`fold ... & map (r => { t = r.total })`), aggregate it again
  (`map (r => { g = sum r.total })` or another `fold`), or join it:
  ```
  totals = orders & fold (o => { user_id = group o.user_id, total = sum o.total })
  enriched = totals & joinLeft users (t => u => t.user_id == u.id) (t => u => { uid = t.user_id, name = u.name })
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
- `merge l r` combines two records — extend a row with computed fields
  (`map (u => u <> { active = u.age >= 18 })`), or layer two projections.
  The right record wins on overlapping fields (JS/Nix object-spread style);
  the result keeps the left row's other fields, and row polymorphism sees the
  full union (`query { id, name, active | r }`). The `<>` operator also
  concatenates strings and lists as closed Semigroup/Monoid instances; string
  concatenation uses the dialect-aware `concat` lowering. Merging a row with
  an unknown schema (an un-annotated table) is an error — annotate the table.
- `<<<`/`>>>` compose **functions** point-free (`f <<< g` = `x => f (g x)`),
  so bound predicates are reusable: `adult = u => u.age >= 18` then
  `filter (adult)`. Query steps compose too:
  `filter (adult) >>> take 10` is one reusable `query -> query` function,
  and the inferred composition type is `a -> c`, never the result type.
- Every binary operator has an Agda-style curried function form: `_+_ 1 2`
  is `1 + 2`, `_>>>_ f g` is `f >>> g`, and `_&_ query step` is
  `query & step`. Sections are first-class and partially applicable:
  `increment = _+_ 1`. These `_op_` functions are ordinary prelude bindings,
  so a local or imported `_+_` changes infix `+` as well. A named section
  resolves an exact `_name_` binding first and then an ordinary function, so
  `_div_ 5 2` calls `div`, and `_combine_ x y` can call a user-defined curried
  function named `_combine_` or `combine`.
- The closed container classes use their familiar operators. Functor supplies
  `<$` and `<$>`; Applicative supplies `<*>`, `<*`, and `*>`; Alternative
  supplies `<|>`; Monad supplies `>>=` and `>>`. Maybe values and lists support
  the Applicative/Alternative/Monad family. Lists use Cartesian-product
  sequencing and `>>=` is flat-map. Queries intentionally support only
  Functor mapping; relational composition stays explicit through query steps
  and fixed join functions.

### Types

`int`, `float`, `decimal`, `string`, `bool`, `date`, `timestamp` — used in table schemas
and checked statically against every operation. `(maybe T)` is Haskell-style
Maybe ("a `T` or SQL NULL") — write `email: (maybe string)` for a nullable
column. There is **no implicit `T` -> `(maybe T)` conversion**: `null` has
type `forall a. (maybe a)`, `is_null`/`is_not_null` test a maybe value,
and `from_maybe default x` unwraps it (`COALESCE`). `just x` lifts a
non-null value into maybe, `nothing` is the maybe constant, and
`fmap f x` lifts a function over a maybe, list, or query (`fmap upper email`,
`fmap (x => x + 1) [1, 2]`, or `fmap (u => { id = u.id }) users`). The same
closed operations have named forms: `replaceWith`, `ap`, `applyLeft`,
`applyRight`, `orElse`, `bind`, and `then`. Their infix forms are normally more
compact: `0 <$ xs`, `f <$> xs`, `fs <*> xs`, `a <|> b`, and `xs >>= f`.
`int` and `float` are distinct — no implicit promotion: `u.age >= 18` is fine, but
`u.age >= 18.0` (int column vs float literal) is a type error; write
`18.0` against a `float` column. Haskell-base numerics: `/` is fractional
division (`float -> float -> float`), `div`/`mod` are integral. `+`, `-`, and
`*` use constrained polymorphism: `Num t => t -> t -> t`, with `int`, `float`,
and `decimal` as the current `Num` instances; unary `-` has type
`Num t => t`. Equality uses the closed `Eq` scalar instances, ordering uses
`Ord`, and `<>` uses closed string/list Semigroup instances in addition to
structural record merge. Consequently
`add = x => y => x + y` stays numeric when generalized and cannot later be
applied to strings.

SQL three-valued predicates are explicit: `is_true x` and `is_false x` test
the TRUE/FALSE branches, while `is_unknown x` tests SQL `NULL`. They accept
both `bool` and `(maybe bool)` and always return a non-null `bool`.

Type aliases are declarations before bindings; prefix with `export` to
share them with importing modules (flat imports and selective renaming):

```
type UserRow = query { id: int, name: string }
type AdultRow = { age: int | r }
users: UserRow = table "users"
adult: AdultRow -> bool = u => u.age >= 18
```

Aliases are expanded in annotations and schemas; recursive aliases are
compile errors. `import "schema.tetaue" (UserRow as Row)` imports an
exported alias under a local name. Namespaced imports expose qualified
types as `t.UserRow`.

### Types and annotations

Every expression is checked by a Hindley–Milner inference pass with **row
polymorphism**: a row lambda is typed once against row variables and reused on
any schema that has the fields it touches.

```
adult = u => u.age >= 18          # : forall r. { age: int | r } -> bool
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
adult: { age: int } -> bool     = u => u.age >= 18   # closed row — narrows: applying it to a wider row is a static error
q = users & filter (u: { age: int | r }) => u.age >= 18
q = users & map (u => { a = u.age: int })
q: query { id: int } = table "users" : query { id: int }    # ascribe a query type
```

Annotations are erased at evaluation time; `check` and `render` both reject
type errors, so they never disagree.

### Query modes are types

The type system encodes the SQL phases a query step lives in, so mode mistakes
are static errors, not runtime surprises:

- **Aggregates** (`count`, `count_distinct`, `sum`, `avg`, `min`, `max`, `list`) have aggregate
  mode (`sum o.total : agg float`) and `group` has group mode
  (`group o.user_id : group int`). Every `fold` entry must use one of those
  modes, and the projection may contain groups, aggregates, or both. A plain
  column is a type error — no more "must be wrapped in an aggregate" surprises:
  ```
  fold (o => { x = o.age })            # ✗ type error: plain column
  fold (o => { x = sum o.age })        # ✓ aggregate mode
  fold (o => { x = group o.age })       # ✓ grouping without aggregates
  ```
  The modes are transparent in unification, so comparing or computing on
  aggregate results works, and a fold's result row is plain — downstream
  `filter` becomes `HAVING` and `sort`/`map` see normal columns.
- **`asc`/`desc`** return the `order` type, so `sort (u => u.name)` (a plain
  column) is a type error; `sort (u => asc u.name)` and
  `sort (u => [asc u.name, desc u.age])` are fine.

### Query roots and steps

| Builtin | Meaning | Renders to |
|---|---|---|
| `table "name"` | query root; schema from the binding annotation (`t: query { col: type } = table "name"`) or inferred | `FROM name` |
| `filter (u => boolExpr)` | keep rows matching a predicate | `WHERE ...` / `HAVING ...` |
| `map (u => { a = expr, ... })` | project one record per row | `SELECT ...` |
| `select ["id", "name"]` | project only the listed columns | `SELECT id, name` |
| `sort (u => [asc u.a, desc u.b])` | ORDER BY | `ORDER BY ... ASC, ... DESC` |
| `take n` | LIMIT | `LIMIT n` |
| `drop n` | OFFSET | `LIMIT n OFFSET n` / dialect-specific |
| `distinct` | dedupe rows | `SELECT DISTINCT ...` |
| `fold (o => { k = group o.k, s = sum o.v })` | grouping and/or aggregation | `SELECT ... GROUP BY ...` |
| `joinInner table (this.id == that.user_id) { uid = this.id }` | inner join; `joinLeft`, `joinRight`, and `joinFull` select the outer variants | `... JOIN ... ON ...` |
| `join_lateral (l => right) (l => r => on) (l => r => row)` | lateral join | `INNER JOIN LATERAL (...) ON ...` (PG/MySQL) |
| `recursive (self => termQuery)` | fixed point | `WITH RECURSIVE ... UNION ALL ...` |

Everything is curried: `filter (u => ...)` is a *step* value; applying it to a query
(`users & filter (u => ...)`) builds a new query. Steps are first-class values, so you
can bind them and reuse them. The four join steps are `joinInner`, `joinLeft`,
`joinRight`, and `joinFull`. Each takes three positional arguments: the right-hand
query and the two-argument (curried) `on` and `merger` functions. The merger projects
the result row (like `map`, with both rows in scope) and may
also be a plain two-argument function — `merge` itself works, giving the full union
of both rows (right wins on overlap):

```
paid_orders = orders & filter (o => o.status == "paid")
q = users & joinInner paid_orders (this.id == that.user_id) merge
```

The right side is a first-class query VALUE (any binding or pipeline — stepped right
sides render as subqueries). Because the merger picks the output columns explicitly,
overlapping column names are not an error — rename them in the merger instead.
For outer joins, only the side that can be absent is nullable inside the merger:
the right side of `joinLeft`, the left side of `joinRight`, and both sides of
`joinFull`. Columns projected from the guaranteed side and literal values keep
their original non-null types.

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
exists (orders & filter ...)   # correlated EXISTS subquery
scalar (orders & ... & take 1) # scalar subquery, one nullable column
in_query u.id (orders & map ...) # IN (SELECT ...)
fmap upper u.email             # lift a function over (maybe T)
0 <$ [1, 2]                    # [0, 0]
(x => x + 1) <$> [1, 2]        # [2, 3]
[1, 2] <|> [3]                 # Alternative choice / list concatenation
[1, 2] >>= (x => [x, x + 10])  # Monad bind / list flat-map
param "user_id"                # SQL bind parameter
upper u.name  lower u.name     # UPPER / LOWER
length u.name                  # LENGTH
coalesce u.nickname u.email    # COALESCE
coalesce [u.nickname, u.email, just "?"]  # variadic list form
abs u.balance                  # ABS
count o.id  sum o.total  avg o.total  min o.x  max o.x   # aggregates (in fold)
sum_where cond o.total  count_where cond o.id              # filtered aggregates
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
round u.balance 0                     # scale is required (0 = no rounding)
greatest [u.a, u.b]  least [u.a, u.b]  # any number of arguments, one list
concat [u.first, u.last]             # sqlite renders || — joins
merge u { active = true }              # record union — right record wins on overlap
u <> { active = true }                 # infix form of merge (a monoid: {} is the identity)
trim u.name  reverse u.name  replace u.name "x" "y"
substring u.name 1 (just 3)          # optional length (nothing omits); sqlite renders SUBSTR
position u.name "a"                    # POSITION / LOCATE / INSTR, per dialect
left_substring u.name 3  right_substring u.name 2
lpad u.code 8 "0"  rpad u.code 8 " "  # pad is required (SQL defaults to a space)
like u.name "a%"                       # x LIKE pattern
null_if u.name ""  is_null u.name  is_not_null u.name
is_true u.flag  is_false u.flag  is_unknown u.flag
case { u.active => u.name, _ => "inactive" }    # CASE WHEN active THEN name ELSE 'inactive' END
case { u.age < 18 => "minor", u.age >= 65 => "senior", _ => "adult" }   # multi-branch; `_` is the fallback
case u.code { "101" => "one", "102" => "two", _ => u.code }   # simple case: branches compare with the subject
cast u.id "string"
over row_number { partition = [u.dept], order = [desc u.salary] }   # window functions — parens optional for zero-arg fns
over rank { partition = [u.dept] }          # rank / dense_rank / percent_rank
over (ntile 4) { partition = [u.dept] }     # multi-arg fns keep parens
over (lag u.salary 1 nothing) { order = [asc u.joined] }   # lag / lead — offset required; default optional (nothing omits)
over (sum u.salary) { partition = [u.dept] }        # windowed aggregates
```

Operator precedence (tightest first): `>>> <<<` (function composition,
PureScript-style) → `* /` → `+ - <>` (`<>` is the record-merge monoid) →
`== != < <= > >=` → `&&` → `||` → `&`
(pipeline: `a & f` ⇔ `f a`) → `$` (application: `f $ a` ⇔ `f a`, right-assoc).
Application binds tightest: `upper u.name` is `upper (u.name)`.

### Local bindings

`let x = e in body` is a pure lexical binding — no mutation, no recursion.
It can appear wherever an expression can appear, including inside lambda
bodies and projections:

```
users & map (u => let double = u.age * 2 in { double = double, next = double + 1 })
# SELECT age * 2 AS double, age * 2 + 1 AS next FROM users
```

The value is substituted/inlined when SQL is generated, so references to a
let-bound name are referentially transparent.

### Lambdas

Lambdas abstract over a row. Two ways to write them:

- **Implicit (`this`/`that`)** — a parenthesized expression using `this` (first
  row) and `that` (second row) is a lambda whose parameters are the row
  bindings: `(this.age + 3)` ≡ `u => u.age + 3` and
  `(this.id == that.user_id)` ≡ `(u, v) => u.id == v.user_id`. These two are the
  ONLY implicit parameters — there is no `$1`-style positional sugar. They stay
  ordinary identifiers when a binding of the same name is in scope:
  ```
  filter (this.active && this.age >= 18)      # ≡ filter (u => u.active && u.age >= 18)
  map { id = this.id, name = this.name }      # braces delimit the lambda — no extra parens
  joinInner orders (this.id == that.user_id) { uid = this.id }   # this left row, that right row
  ```
  Parens inside an argument are pure grouping: `map { a = (this.id + 1) }` means
  exactly the same as `map { a = this.id + 1 }`. A FUNCTION-position argument of a
  nested call — a position whose callee takes a lambda, like `filter`'s predicate
  or a join's ON/merger — opens its own implicit-lambda scope: in
  `filter (P1) $ filter (P2) s03` the `this` inside `P2` is the inner `filter`'s
  predicate parameter, and `joinInner orders (this.id == that.user_id) { ... }`
  scopes `this`/`that` to the join's ON lambda. So `this`/`that` bind to the
  nearest enclosing lambda-taking argument — never through a lambda-taking
  position, and never directly inside an explicit lambda body.
- **Explicit** — `u => u.age >= 18`. Lambdas are curried: a two-argument function
  is `l => r => l.id == r.user_id` (there is no `(l, r) => ...` form). `this`/
  `that` are not available directly inside an explicit body — they must sit in
  their own nested lambda-taking argument, e.g.
  `filter (u => exists (filter (cast this.x "int" >= 0) t))`.

A lambda body is the same operator chain as an ordinary expression — `&` (pipeline)
and `$` (application) are part of it, so a body extends until its chain ends
naturally. The chain ends at a closing `)` / `]` / `}` or at the end of the
expression; a NEWLINE is not a delimiter, so a lambda whose body is a pipeline
continues on the next lines without extra parentheses:
```
account_final = process_date =>
  s03_corp_chrem_acct
  & filter (u => cast u.pt_dt "date" == process_date)
  & filter (this.chrem_acct_bal_year_accum > 0)
```
Delimiting parens are still how you make a lambda an ARGUMENT
(`joinInner orders (l => r => l.id == r.user_id) (l => r => { id = l.id }) & take 3`
ends each lambda at its record and pipelines `take 3` to the join), and how you
stop a lambda body from absorbing a following `&`/`$` step:
`u => (u.a & take 1) & rest`. To use `&`/`$` inside a lambda that must itself
fit in an argument position, keep it parenthesized: `u => (u.a & take 1)`.

Either form binds a step the same way: `adults = filter (this.active)` is a step
value, so `users & adults` works.

### Column references

Columns are only accessible through a lambda's row parameter (a first-class record),
and the schema follows the pipeline: after `map (u => { id = u.id, name = u.name })`
the row only has `id` and `name`. After a
a join, both tables' columns are in scope inside the `on` and `merger` lambdas and
rendered qualified (`users.id`, `orders.user_id`). The result row is exactly
what the merger projects — overlapping column names are fine, just pick them apart
in the merger (e.g. `{ left_id = l.id, right_id = r.id }`).

## Dialects

Built-in renderers: `sqlite`, `postgresql`, `mysql`, `trino`, `hive`. Rendering is
dialect-aware: identifier quoting, boolean literals, string escaping, and every
scalar/date builtin resolve at render time, so the same query source can target
any dialect. Functions use native names where available and compositional
fallbacks elsewhere (for example SQLite `greatest`/`least` use `MAX`/`MIN`,
`lpad`/`rpad` use `printf`/`substr`, and `reverse` uses a scalar recursive CTE).
Backend-specific functions without a semantics-preserving lowering, including
regular-expression helpers and `try_cast`, are not part of the common prelude.
Capability diagnostics are reserved for query-shape features that a backend
cannot express natively, such as Hive recursive CTEs or a dialect's missing
lateral join form; they are reported before SQL text is emitted.

## VS Code extension

The repo ships a VS Code extension (`extension/`) that serves the language over
LSP and compiles modules to SQL in real time.

- **Live diagnostics** — the validator (interpreter + type inference) runs on
every keystroke: errors underline in the editor and land in the Problems panel.
- **Lazy workspace** — the server never indexes the whole opened folder. Only
  open documents are parsed (on didOpen); imported modules are loaded on
  demand from disk through a memoized, budgeted loader (text cached by mtime,
  AST by content hash, per-module size budget, byte-bounded cache), so a huge
  vendored schema library cannot OOM the process and its closure is not
  re-parsed on every keystroke. The expensive typed check is memoized per
  document and shared by validation, hover and completion — hovering an
  imported value reuses the analysis instead of re-type-checking the whole
  dependency graph on every request.
- **Hover** — shows the static type of the expression under the cursor
(`u.age : int`, `adult : { active: bool, age: int | r } -> bool`), plus the
`#` doc-comment block of the binding it refers to.
- **Semantic highlighting** — the language server colors tokens from the
grammar, not regexes: prelude builtins (`table`, `filter`, …) as
`function` + `defaultLibrary`, lambda bindings and parameters (`this`/`that` implicit)
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
stay verbatim, and whitespace around `-` is preserved. Negative arguments use
parens: `abs (-1)`; `abs -1` and `abs - 1` both parse as subtraction.
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
- `src/language/compile.ts` — the shared parse → check → render pipeline used
by both the CLI and `tetaue/render`, so they never disagree.
- `src/language/lsp/hover.ts` — hover: static types from the checker's
`nodeTypes` map plus `#` doc-comment blocks.
- `src/language/lsp/completion.ts` — `.`-field completion on a synthetic
parse (inserts a dummy property, balances delimiters) so the real checker
resolves the receiver's row even mid-typing.
- `src/language/lsp/document-analysis.ts` — the LSP's shared per-document
analysis: one memoized typed check per document state, reused by
validation / hover / completion.
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
  builtin.ts            # single source of truth: builtin names, schemes, aliases
  catalog.ts            # compatibility re-export of builtin.ts
  checker.ts            # single typed-IR/checker pass (IR construction + type inference)
  interpreter.ts        # symbolic evaluator: curried builtins, query steps, diagnostics
  optimize.ts           # pure, dialect-independent query normalization/rewrites
  capabilities.ts       # pure dialect capability preflight for normalized queries
  types.ts              # type engine: HM unification, rows, `(maybe T)`, `?hole`s
  inference.ts          # type inference engine: prelude schemes, annotations, diagnostics
  imports.ts            # multi-file module resolution (cycles, missing files)
  resolve.ts            # relative-path import resolution (no package layer)
  module-cache.ts       # memoized, budgeted loader for imported modules (size limits, CST dropping)
  render.ts             # SQL renderer + dialect specs
  compile.ts            # shared compile pipeline (CLI + language server)
  tetaue-module.ts      # Langium dependency injection (core + LSP services, lazy workspace manager)
  tetaue-validator.ts   # maps checker + tree diagnostics to Langium validation
  index.ts              # public API
src/language-server.ts  # LSP entry: startTetaueServer() + tetaue/render request
src/cli.ts              # render / check / types / parse / format / build / watch / lsp commands
bin/tetaue.ts           # `tetaue` executable (bun shebang)
extension/              # VS Code extension (client, manifest, grammar, packaging)
test/                   # bun test suite (incl. an end-to-end LSP test)
examples/               # runnable example modules (incl. multi-file report.tetaue, joins.tetaue, case.tetaue)
```

The interpreter builds the symbolic query IR, the pure optimizer normalizes it,
and the capability preflight validates the selected dialect before SQL text is
emitted. The inference engine adds the static type layer (row polymorphism,
annotations, strict numerics). They are exposed as one `checkProject` pass that
builds the typed SQL IR and returns exact-deduped diagnostics — so `check` and
`render` never disagree.

## Roadmap

- external schema/catalog declarations and a strict-schema project mode
- user-declared type classes and instances (the compiler currently owns closed
  `Num`, `Eq`, `Ord`, `Semigroup`, `Monoid`, `Functor`, `Applicative`,
  `Alternative`, and `Monad` instances)
- query cardinality types for scalar and singleton subqueries
- more pure optimizer rewrites: projection pruning and safe predicate
  pushdown (named intermediates already render as `WITH` CTEs, so subqueries
  are defined once and referenced by name)
- LSP polish: completion for `this`/`that` implicit lambdas and richer cross-module
  documentation (go-to-definition, qualified completion, builtin completion,
  and importer revalidation are already implemented)
