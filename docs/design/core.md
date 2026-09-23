# Core, `base`, and the Prelude

Tetaue's library is organised the way Haskell's `base` is: a directory of
ordinary tetaue modules, with a `Prelude` that every program gets
automatically.

```
base/
  prelude.tetaue        the auto-imported surface — a thin aggregator
  sql.tetaue            the SQL surface + the scalar layer
  data/function.tetaue  id, const, flip, compose, composeBack, apply
  data/maybe.tetaue     isNothing, isJust, isNotNull
```

### Naming

Two rules, and they are why the library reads consistently:

- **Module paths are lowercase** — directories and file names alike
  (`data/function.tetaue`, never `Data/Function.tetaue`). A module path is
  part of the public import specifier (`import "base/data/maybe"`), so two
  spellings of one module would be two modules. `scripts/embed-base.ts` fails
  the build on a mixed-case path rather than silently embedding both.
- **Identifiers are camelCase** — `rowNumber`, `dateAdd`, `isJust`,
  `unionAll`, `asIntOrNull`. The one exception is a name that must be written
  exactly as SQL is (the `sql_func "UPPER" [...]` escape hatch), where the
  string is the SQL word and not a tetaue binding.

Because identifiers are camelCase, the SQL word a call renders to can no
longer be derived by upper-casing the tetaue name (`rowNumber` -> `ROWNUMBER`
is not a function any dialect has). Each such builtin therefore declares its
`sqlName` in `builtin.ts` next to its scheme, and `render.ts` reads it:
`rowNumber` -> `ROW_NUMBER`, `currentDate` -> `CURRENT_DATE`, `isNull` ->
`IS NULL`. `test/catalog.test.ts` pins the two.

## The three layers

1. **The primitive core** is TypeScript: `src/language/builtin.ts` holds the
   static schemes, `interpreter.ts` the runtime, `render.ts` the query-shape
   lowering. Its names are the ones the *library* is written in — `table`,
   `filter`, `sql_func`, `sql_infix`, `sql_cast`, `sql_bare`, `sql_fragment`,
   `sql_literal`, `sql_literal_amount`, `sql_error`, `sql_dialect`, the `op_*`
   operator intrinsics, and the `list_*`/`maybe_*` combinators.
2. **The base library** is the files under `base/`. They are parsed, inferred,
   and evaluated by the same pass as user code.
3. **The Prelude** is `base/prelude.tetaue`. It is auto-imported into every
   module that does not opt out with `# no prelude`.

## Who can see the primitive core

Exactly one kind of module: a **base module**. That is the rule that makes the
boundary real rather than documentary.

```
                   primitive core        Prelude's exports
base/…  ..........      yes       ..........    (it defines them)
user modules  ....      no        ..........      yes (auto-import)
```

A base module is evaluated against `createPreludeEnv(dialect)` — the builtins,
the operator intrinsics, `sql_dialect`, and the built-in namespaces. A user
module is evaluated against the Prelude's *exports* (plus the always-available
`list.*` / `Maybe.*` namespaces). So `sql_func` cannot be named from a user
module, while `table` can — because `table` is an exported binding of
`base/sql.tetaue`, not a name the checker sprinkles into every scope.

## The `core` namespace

`sql.tetaue` publishes the primitive names under their public spellings:

```tetaue
export table = core.table
export filter = core.filter
```

`core` is a reserved namespace holding every primitive, seeded into **base
modules only**. It exists for one reason: `export table = table` would resolve
the right-hand `table` to the binding being defined and be reported as a
recursive cycle. Going through `core.` makes the alias an ordinary reference.

## Adding to the library

- **A new SQL primitive** (a new query shape, a new lowering vocabulary):
  add a `BuiltinSpec` in `builtin.ts` and its runtime in `interpreter.ts`.
  Then publish it from `base/sql.tetaue` with `export <public> = core.<name>`.
- **A reusable functional abstraction**: write it in the appropriate
  `base/` module. It needs no TypeScript at all.
- **A new spelling for an existing operation**: add an alias export.

Run `bun run base:generate` after editing anything under `base/`. It rewrites
`src/language/base-sources.ts`, the embedded copy the CLI, the LSP
server, and the standalone executables carry — the bundled tools have no asset
directory beside them, so "the library is a real file on disk" and "the
library ships inside the binary" are both true only because the sources are
embedded from the same files.

## How the library is wired

`base/prelude.tetaue` is an aggregator — it re-exports the other modules:

```tetaue
import "./sql.tetaue" as sql
import "./data/function.tetaue" as fn

export * from "./data/function.tetaue"
export * from "./data/maybe.tetaue"
export * from "./sql.tetaue"
```

A re-export adds names to a module's *public surface* without binding them
locally, which is why the operator definitions below the re-exports need the
`as sql` / `as fn` imports as well.

`checkProject` evaluates the library modules first, in dependency order, then
each user module. `analyzeProject` / `inferProject` (the one-sided APIs used
by tooling) do the same: they expand the full library closure from the Prelude
module they are handed, because every base module carries its own
import/re-export edges.

## Importing the library explicitly

The Prelude is implicit, but every base module is importable by name:

```tetaue
import "base/sql.tetaue" (length)
import "base/data/maybe.tetaue" as M

users: query { name: string } = table "users"
main = users & map (u => { n = length u.name })
```

`base/...` specifiers resolve against the embedded library, not the filesystem,
so they work identically in the CLI, the language server, and a standalone
binary. A user module that imports a base module gets that module's exports
like any other import; it still cannot reach the primitives, because only base
modules see the primitive environment.

## Operators

Infix parsing and precedence belong to the grammar; operator *meaning* is
lexical. `1 + 2` and `_+_ 1 2` both resolve `_+_` from the current scope, so a
local or imported definition can override the default without touching the
grammar or the evaluator. The Prelude's operator bindings are ordinary
definitions over library values:

```tetaue
export _+_ = sql.sql_add
export _>>>_ = fn.compose
export _&_ = x => f => f x
```

Operations that need no SQL implementation never touch the core at all —
composition, pipeline, and application are plain lambdas.

## Closed container operations

The container is chosen at the **use site** (maybe values, lists, or queries),
so these stay closed operations rather than type-class methods. The core
exposes the implementations; the library owns the names:

```tetaue
export _<$>_ = fmap
export _<|>_ = orElse
export _>>=_ = bind
```
