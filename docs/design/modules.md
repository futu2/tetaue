# tetaue modules: from flat inclusion to namespaced modules

Status: **implemented** — grammar (`export`, `import ... as`, re-exports
`export ... from`), module-tree edges (`ProjectModule.imports`/`exports`),
per-module scoping in interpreter + inference, qualified access (`t.users`),
collision diagnostics. There is **no package layer**: imports resolve
relative to the importing file only. The README carries the user-facing
summary; this document is the review and the specification.

## 1. Review of the previous module system

The previous design (pre-redesign):

```
Model  ::= Import* Binding*                     -- imports first, bindings after
Import ::= 'import' STRING
Binding::= ID (':' Type)? '=' Expression
```

Semantics: `collectModuleTree` resolved imports relative to the importer,
deduplicated by URI, detected cycles, and produced a depth-first post-order
list (imports before root). `analyzeProject` then evaluated **every binding of
every module into one shared flat environment** (prelude + all bindings), and
the **root module's last binding** was the query.

Strengths that were worth keeping:

- Relative, nested resolution with cycle detection and missing-file errors.
- URI deduplication (a diamond import evaluates a module once).
- Diagnostics in imported modules folded onto the `import` statement that
  leads to them.
- "Bindings need no terminator" — the comma-free, newline-agnostic module
  shape that the ARG_ID lookahead enables.

Weaknesses found by review (`src/language/interpreter.ts:1245-1316`,
`src/language/inference.ts:141-146,185`, `src/language/imports.ts:44-76`,
`src/language/tetaue-validator.ts:69-83`):

1. **Silent cross-module collisions.** `analyzeProject` checked duplicates
   only *within* a module (`seen` per module); across modules
   `ctx.env.set(name, v)` silently overwrote. Two imported modules each
   defining `users` → last-wins with zero diagnostics, and *which* wins is
   decided by the DFS order of the root's `import` statements.
   (Verified: `import "a.tetaue"` + `import "b.tetaue"`, both exporting
   `users`, renders `FROM` the second file's table silently.)
2. **Scope leakage across siblings.** Every module saw every binding evaluated
   before it — including the bindings (and *imports*) of modules it never
   imported. Program validity therefore depended on import order: a module
   could reference a name from an unrelated module, and it resolved only when
   DFS happened to order that module first. Reordering the root's imports
   flipped valid programs into misleading "bindings must be defined before
   use" errors.
3. **No encapsulation.** Every binding was visible to every importer. There
   was no way to mark a helper as implementation detail.
4. **No namespacing.** `tables.users` was impossible; the only way to
   disambiguate a name was not to import the conflicting module.
5. **No renaming.** `import "x.tetaue" as y` did not exist.
6. **Dedup key ignored the document.** `mergeDiagnostics` keyed on
   `cstNode.offset + message` with no URI component, so two identical errors
   at the same offset in *different* imported files collapsed into one
   (one real diagnostic silently dropped).

## 2. Goals

The redesign keeps the strengths and fixes the weaknesses:

1. **Explicit exports.** A binding is visible to importers only when marked
   `export`. Everything else is module-private (but fully visible inside the
   module).
2. **Namespaced imports.** `import "tables.tetaue" as t` binds one name `t`;
   bindings are reached by qualified access `t.users`. This gives collision
   freedom without renaming files.
3. **Flat imports still exist** (`import "tables.tetaue"`) and bring the
   module's *exported* bindings into scope — the convenience form, now
   hygiene-checked.
4. **Per-module scoping.** A module sees: the prelude, its own imports, its
   own bindings — nothing else. Sibling leakage and import-order dependence
   are gone. Lambdas capture their *defining* module's scope (lexical).
5. **Collisions are errors, never silent.** Import-vs-import, alias-vs-any,
   binding-vs-import conflicts all produce diagnostics.
6. **Qualified access preserves polymorphism.** `t.adult` instantiates the
   exported binding's *scheme* at each use, so row-polymorphic helpers stay
   polymorphic through a namespace.

## 3. Syntax

```
import "tables.tetaue"              # flat: exported bindings into current scope
import "tables.tetaue" as t         # namespaced: qualified access t.users
import "tables.tetaue" (users, orders)      # selective flat: exactly those exports
import "tables.tetaue" (users as people)    # rename while importing
import "tables.tetaue" as t (users)         # selective namespace: t.users only
import "tables.tetaue" as t (users as people) # exposes t.people

export users: query { id: int } = table "users"   # visible to importers
export * from "./tables"                           # re-export every export of ./tables
export { users as people, orders } from "./orders" # selective, renamed re-exports
helper = ...                                       # module-private
```

Grammar changes (`tetaue.langium`):

```
Import:
    'import' path=STRING ('as' alias=(ID | ARG_ID))? ('(' names+=(ID | ARG_ID) (',' names+=(ID | ARG_ID))* ')')?;

Binding:
    (export?='export')? name=(ID | ARG_ID) (':' type=Type)? '=' value=Expression;

Export:
    'export' ('*' | '{' names+=ImportName (',' names+=ImportName)* '}') 'from' path=STRING;

Model:
    (imports+=Import | exports+=Export | bindings+=Binding)*;
```

`export` and `as` become **reserved words** (Langium lexes keywords with
priority over identifiers everywhere — `u.export` as a field name is a parse
error). The `Model` is a single flat loop instead of
`Import* TypeAlias* Binding*`: `export` is shared by re-exports and bindings,
and only one loop lets the parser backtrack (`export *` /
`export { a }` → re-export, `export name` → binding). There is no `TypeAlias`
rule — types are builtin-only, so a module can only bind values.
A consequence is that imports/re-exports may appear anywhere among bindings;
the interpreter evaluates them in fixed order regardless (imports, then
bindings, then re-exports merged into the export map).

## 4. Semantics

### 4.1 Scope of a module

Each module is evaluated in its own environment:

```
scope(M) = prelude
         ∪ { alias -> module(target)   | import "spec" as alias in M }
         ∪ { name  -> export(target)   | import "spec"        in M }
         ∪ { name  -> binding value    | binding in M }
```

- Bindings are **order-independent**: the scope contains every binding of the
  module, so a definition may reference any other binding regardless of
  position. Bindings are evaluated in dependency order (topological sort,
  source order as a tiebreak); recursive top-level binding cycles are
  rejected.

- The prelude is shadowable by imports and local bindings, exactly as user
  bindings shadow builtins today.
- **Flat import** binds every *exported* name of the target module — or,
  with a selective list `import "spec" (a, b)`, exactly the listed names
  (a listed name that is not exported is an error; unlisted names stay
  invisible).
- **Namespaced import** binds exactly one name: the alias, whose value is a
  **module** — qualified access `t.users` reads the target's exported
  bindings. A selective list `import "spec" as t (users)` restricts the
  namespace to those exports.
- A module with no `export` bindings contributes nothing to importers.
- Imported modules are evaluated in DFS post-order (targets before
  importers), so a module's imports are always already evaluated when it is
  — the same order guarantee as before, now with no cross-module leakage.

### 4.2 Exports

`export` marks a binding as part of the module's public surface. Within the
module, exported and private bindings are equivalent (all bindings see all
bindings). A binding's value is exported *after* evaluation — exporting a
value from another module (`export x = t.users`, `export q = users & take 1`)
re-exports naturally.

**Re-exports** (`export * from "path"` / `export { a as b } from "path"`) add
names to a module's public surface **without binding them locally**. They are
the aggregation tool an index module needs:

```
# package/index.tetaue
export * from "./tables/users"
export * from "./tables/orders"
```

`import "package"` (resolved to `package/index.tetaue`) then exposes
`users` and `orders` as if the index exported them itself. `export * from`
re-exports every exported VALUE binding of the target (transitively following
the target's own re-exports); `export { a as b } from` re-exports only the
listed names, renaming as shown. Conflicts (a re-exported name colliding with
a local export or another re-export) are errors, never silent. Types are
builtin-only, so re-exports never carry type aliases.

### 4.3 Qualified access

`t.users` is the existing `AccessExpression` shape (`t` a bare identifier
receiver, `users` the property). Both passes special-case a receiver that
names a module in scope:

- **Interpreter:** the module is a value (`{ kind: 'module', exports, name }`);
  `access()` reads the export map, erroring on a missing export with the
  list of available ones. Values are already concrete at runtime, so no
  polymorphism machinery is needed.
- **Inference:** `t.users` instantiates the exported binding's **scheme**
  (like an identifier reference), so `t.adult` with
  `adult: forall r. { age: int | r } -> bool` stays row-polymorphic. A
  missing export is a diagnostic (mirroring the interpreter's wording so the
  merge dedupes).

A bare `t` (not followed by `.`) evaluates to a module value; using it where
a query/function/expression is expected produces the usual "cannot apply a
module" / "got a module" errors via `describe`.

### 4.4 Collisions (all errors — no silent shadowing)

| Case | Error (at the second name) |
|---|---|
| two flat imports export the same name | `name 'users' (imported from 'b.tetaue') conflicts with 'users' imported from 'a.tetaue'` |
| alias collides with another import's names or an alias | `name 't' (import alias) conflicts with import alias 't'` |
| local binding collides with an imported name / alias | `name 'users' (a local binding) conflicts with 'users' imported from 'tables.tetaue'` |
| duplicate binding in one module | existing `duplicate binding name 'x'` |
| `t.users` where `users` is not exported | `module 't' has no exported binding 'users' — exported: ...` |

The analyzer processes imports first (checked against each other), then local
bindings (checked against the imported names) — regardless of where they
appear in the source. Shadowing the *prelude* stays legal (as today).

### 4.5 The query rule

Unchanged: the **root** module's query is its `main` binding (the strict
entry enforced by the CLI `render`/`check`/`build`; `--binding` selects any
named binding instead). Imported modules have no query requirement (their last binding may be
anything). `export` on the root's bindings is legal and meaningless for a
program root.

## 5. Errors and diagnostics

- Import-resolution errors (missing file, cycle, parse error) stay in
  `collectModuleTree` with the same messages and folding.
- Scope/collision errors are emitted by **both** passes with identical
  (node, message); `mergeDiagnostics` dedupes (now keyed with the document
  URI, fixing the dropped-diagnostic bug).
- `tetaue-validator.ts` folding is unchanged: diagnostics living in imported
  modules fold onto the direct `import` statement of the open document.

## 6. Implementation notes

```
src/language/tetaue.langium        — Import alias, Binding export flag
src/language/generated/*           — regenerated
src/language/imports.ts            — ProjectModule.imports: { alias, target, importNode }[]
                                     (resolved edges, filled during the DFS;
                                     one object per URI so diamond dedup keeps
                                     identity for per-module export lookup)
src/language/interpreter.ts        — analyzeProject(ProjectModule[]): per-module
                                     env (prelude + imports + bindings), module
                                     value kind, access() module branch, export
                                     collection, collision diagnostics
src/language/inference.ts          — inferProject(ProjectModule[]): per-module
                                     scheme env + modules map (alias -> schemes),
                                     qualified access = scheme instantiation,
                                     mirrored scope/collision diagnostics,
                                     mergeDiagnostics keyed with document URI
src/language/tetaue-validator.ts   — pass ProjectModule[] (not Model[])
src/language/compile.ts            — same
src/language/resolve.ts            — import resolution: relative-path only
                                     (candidates spec, spec.tetaue,
                                     spec/index.tetaue); no manifests
src/language/module-cache.ts       — shared memoized loader for imported
                                     modules: mtime-keyed text, hash-keyed
                                     AST, per-module size budget, byte-bounded
                                     cache, optional CST dropping
src/language/lsp/{hover,completion}.ts — same
src/language/interpreter.ts:analyze()  — single-module wrapper (no imports)
src/language/inference.ts:infer()      — same
test/imports.test.ts               — new API + new coverage (see §7)
test/resolve.test.ts               — relative-path resolution, errors, CLI e2e
test/module-cache.test.ts          — budget, memoization, CST dropping
examples/*.tetaue                  — `export` on shared bindings; a namespaced
                                     example
examples/lib-project/              — a vendored package with an index module
                                     aggregating per-concern modules (re-exports)
README.md                          — Modules section
docs/design/modules.md             — this document
```

API change: `analyzeProject(modules: Model[], opts)` becomes
`analyzeProject(modules: ProjectModule[], opts)` (same for `inferProject`),
because per-module scoping needs the resolved import edges, which only the
tree carries. Single-module callers use `analyze(model)` / `infer(model)`.

## 7. Testing

- Flat import brings exported bindings (existing tests, plus `export`).
- Non-exported bindings are invisible to importers (error on use).
- Namespaced import: `t.users`, chained use in pipelines, missing export
  error, alias collisions.
- Qualified access preserves row polymorphism (`t.adult` used on two
  different schemas).
- Cross-module collision is an error (the silent-shadowing regression).
- Binding-vs-import collision is an error.
- No sibling leakage: a module cannot see a sibling module's binding, and
  cannot see a sibling's import; a sibling's name is reported as unknown,
  not as "defined later".
- Duplicate identical imports are a no-op; `export`/`as` are reserved words.
- Diamond dedup still evaluates once; exports resolve through both paths.
- Root last-binding-is-query unchanged; imported modules need no query.
- `export`/`as` are reserved but field names like `u.export` still parse.
- Full existing suite stays green (module tests updated to the new API).
- Resolution tests (`test/resolve.test.ts`): relative resolution, extension
  inference, index modules, `..` resolution, error cases, CLI e2e.
- Re-export tests: `export *` aggregation, chaining through index modules,
  selective renamed re-exports, non-exported names, conflicts, no local
  binding, interpreter/inference agreement.
- Module-loader tests (`test/module-cache.test.ts`): size budget, error
  wording, memoized AST identity, content-keyed re-parse, mtime text cache,
  CST dropping, byte-bounded eviction.

## 8. Libraries and packages (sharing modules)

There is **no manifest and no package layer**: `import "spec"` resolves
relative to the importing file, and `build`/`watch` take every option from
flags. What a manifest did for packages — aggregation and a public surface —
an **index module** does with re-exports:

```
# vendor/acme/index.tetaue — the package entry
export * from "./tables"
export * from "./predicates"
```

```tetaue
# main.tetaue
import "./vendor/acme"               # → ./vendor/acme/index.tetaue
import "./vendor/acme/predicates" as p
import "../shared/columns" (compact)
```

For every location, three candidate forms are tried: `spec`, `spec.tetaue`,
and `spec/index.tetaue` — `import "acme/tables"` finds `<importer>/acme/tables.tetaue`,
`import "acme"` finds `<importer>/acme/index.tetaue` (a package folder works
as a module). `..` and absolute specs are allowed — this is a local language
tool, not a sandbox.

**No globals, no environment variables, no install command.** Getting a
library is an ordinary file operation (`cp -r`, symlink, or
`git clone <url> <project>/vendor/acme`); nested imports resolve relative to
the importing file, so a vendored lib carries its own sub-imports with it.
Resolution is a pure function of the file path, so the CLI, the VS Code
extension, and any future editor implement the same rule. On miss the error
names the specifier and the directory searched: `cannot resolve import
'acme/tables' — searched: …`, anchored on the `import` statement.

### LSP integration — lazy loading

The server never indexes the whole workspace and never retains the whole
dependency graph:

- A custom `WorkspaceManager` skips Langium's startup traversal of the opened
  folder; only **open documents** are parsed (on `didOpen`), so a workspace
  with thousands of generated schema modules is not parsed at startup.
- Imported modules are loaded **on demand** through the shared memoized
  loader (`module-cache.ts`): text is read once per mtime, a module's AST is
  parsed once per content hash and cached under a byte budget (not per
  keystroke), modules over the per-module size budget degrade to
  "module too large to analyze" instead of crashing, and large imported
  modules lose their CST after parsing (diagnostics are folded onto the open
  document's `import` statement, so positions survive) — the server retains
  no unbounded AST/CST.
- The typed check is **memoized per document** (`lsp/document-analysis.ts`):
  the validator, hover and completion share ONE `checkProject` result per
  document state, invalidated only when the document text or any imported
  file's content changes. Hovering an imported value therefore does not
  re-type-check the whole dependency graph on every request; the import tree
  itself is rebuilt cheaply (statSync + memoized reads) per request for
  cycle/missing-file diagnostics.
- `t.` completion suggests the namespace's *effective* exports (through
  index re-exports). Go-to-definition: `import "…"` → the resolved file,
  `t.binding` → the export in the lib (following re-export chains to the
  underlying binding), a bare identifier → the binding in the same module.
- Editing a lib file revalidates open importing documents: the client
  watches `**/*.tetaue` and forwards `workspace/didChangeWatchedFiles`; the
  server subscribes to Langium's `DocumentUpdateHandler` change event
  (registering its own handler would overwrite Langium's) and re-runs
  validation on every open document.

## 9. Out of scope (future work)

- Selective exports lists are already covered by re-exports.
- Cyclic imports at the *semantic* level (detected + reported today, then
  modules are analyzed as far as possible).
- Package/registry sources (`{ git = "…" }`, npm-style resolution) — they
  need fetch + lockfile machinery, and would reintroduce a package layer by
  design.
