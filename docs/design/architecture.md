# tetaue architecture — the macroscope, and the case for splitting elaboration from typing

Status: **proposal**. Nothing in this document is implemented yet. It is the
review that motivates a redesign, the target structure, and a staged plan.

Scope decision (the user's, recorded here so the plan can be judged against it):
**separate elaboration/typechecking from IR building.** The only invariant
carried over is *stay pure functional and concise* — there is no promise that
the current grammar, the public API in `src/language/index.ts`, the lockstep
traversal, or the existing file layout survive. Everything below is written
under that freedom.

## 1. The system as it stands

16,368 lines of TypeScript, one Langium grammar, 648 tests (646 pass, 2 fail —
pre-existing, see §6).

| Layer | Files | Lines | Role |
|---|---|---|---|
| Front end | `tetaue.langium` → `generated/{ast,grammar,module}.ts` | 1,257 | Parser, AST, Langium services |
| **Core** | `interpreter.ts` **4,530**, `inference.ts` **3,563**, `types.ts` 996, `builtin.ts` 361 | **9,450** | Evaluator (AST → SQL IR) *and* type checker, interleaved in one pass |
| Back ends | `render.ts` 1,193, `optimize.ts` 253, `capabilities.ts` 130 | 1,576 | SQL IR → dialect text |
| Project/scope | `checker.ts` 315, `imports.ts` 299, `module-cache.ts` 194, `prelude.ts` 172, `project-scope.ts` 99, `resolve.ts` 74 | 1,153 | Module tree, imports/re-exports, per-module scoping, prelude injection |
| Tooling | `lsp/*` 1,030, `cli.ts` 775, `compile.ts`, `tetaue-validator.ts`, `language-server.ts` | ~2,300 | Completion, hover, definition, semantic tokens, formatter, CLI, LSP |

The dataflow is a single traversal, and that is the design's real asset:

```
.tetaue ──Langium──▶ AST ──checkProject──▶ (Value/Query IR ‖ Types) ──▶ optimize
                              ▲                    │                    +capabilities
                       base/*.tetaue               └──────────▶ render ──▶ SQL text
```

`checkProject` (`checker.ts:126-238`) walks modules imports-first, root last.
Per module it prepares **both** sides once — `inferencer.beginModule(...)` for
the lexical scope, `createPreludeEnv(dialect)` for the runtime environment —
then per binding calls the fused entry point
`Inferencer.typedBinding(binding, …, valueEnv, …)`
(`inference.ts:831`), which *first* runs `inferBinding` and *then*
`checkBinding` (`interpreter.ts:4446`), returning `{ env, seen, value,
diagnostics }`. Each binding is inferred once and evaluated once, in lockstep,
sharing one scope.

Because the two passes were built as one, the SQL surface and the type surface
have grown into each other. Three facts carry the rest of this document.

### Fact A — the core is one 117-entry dispatch table

`interpreter.ts:1954` declares `BUILTINS: Readonly<Record<BuiltinName, () =>
Value>>`: every primitive is a closure capturing `ctx`, the AST node, and the
evaluation environment. Its own section comments name the domains it spans:
query roots, query steps, joins, records, record transformers, `case`,
expression evaluation, `this`/`that`, then builtins split into
date / scalar / many-argument / curried-heterogeneous / window, then entry
points. `interpreter.ts` alone contains 154 `ctx.diagnostics.push` sites, 80
mentions of `schema`, 73 of `step`, and 69 of `SQL`.

Adding one SQL function today means editing **four parallel tables**:

1. `builtin.ts` — the static scheme (`BUILTIN_SPECS`);
2. `interpreter.ts` — the runtime implementation (`BUILTINS`);
3. `render.ts` — the lowering (`DIALECTS.*.functions` + the render switch);
4. `inference.ts` — *often*, a name-keyed special case.

`test/catalog.test.ts` exists purely to pin (1) and (2) to each other: "a
builtin can never exist on one side without the other, so the inference pass
and the interpreter cannot drift apart." A test enforcing parity between two
tables is the codebase telling us it wants one table.

The name-keyed special-case pattern in `inference.ts` is the same symptom:
~35 sites dispatch on `name === '…'` (`'table'`, `'merge'`, `'take'`,
`'sort'`, `'drop'`, `'mempty'`, `'abs'`, `'sqrt'`, `'pow'`, `'mod'`, `'ceil'`,
`'floor'`, `'round'`, `'avg'`, `'sum'`, `'dateAdd'`, `'dateDiff'`, `'cast'`,
`'string'`, `'int'`, `'float'`, `'decimal'`, …), alongside dedicated methods
`inferFmap`, `inferApTypes`, `inferSequenceTypes`, `inferBindTypes`,
`inferOrElseTypes`, `inferJoin`, `inferFold`, `inferMap`, `inferSelect`,
`inferRecordPicker`, `inferCast`, `inferOver`, `inferMempty`,
`inferScalar`, `inferTruthPredicate`, `inferInQuery`.

### Fact B — query-plan concepts live in the type language

`types.ts` carries, as first-class members of `Type`:

- `mode`/`agg`/`group`/`window` — plus `aggOf`, `groupOf`, `windowOf`,
  `isModeOf`, `modeOf`, `modePayload` (`types.ts:205-240`), and
  `ModeName = 'agg' | 'group' | 'window'` (`types.ts:219`);
- `order` — the type of `asc`/`desc` items;
- `truth` — "bool ∨ maybe bool", a *SQL three-valued logic* type;
- `nullRow τ` — the field-wise SQL null extension of a row;
- `builtin name τ` — a tag so builtin identity survives being bound to a name.

`agg`/`group`/`window` are not type theory: they are **pipeline phase** tags.
They exist so `fold` can reject a bare column and `map` can distinguish a
projection from an aggregation. `inference.ts` reads them in exactly nine
places — `modePayload` at 1342/1361/2495/2498/2585/2588, `isModeOf` at 2137
(`'agg','window'`), 2474 (`'group'`), 2483 and 2574 (all three) — and every one
of those sites is inside `inferFold`, `inferMap`, or a binary-operand
rejection. The tags are transparent in unification (so arithmetic on an
aggregate works), which means they are *invisible to the actual type checker*
and exist solely to carry planning information from one application node to the
next. That is the clearest evidence that a distinction is missing from the
architecture: the type checker is being used as a side channel for the
elaborator.

### Fact C — the SQL boundary is mid-migration

`docs/design/sql-dialect.md` records a deliberate move: per-dialect lowering
from a bespoke table inside `render.ts` to a first-class `sql_dialect` value
that `base/sql.tetaue` branches on at analysis time, over the primitives
`sql_func` / `sql_bare` / `sql_infix` / `sql_cast`. Fifteen scalar functions
have migrated (`upper`, `lower`, `length`, `trim`, `replace`, `mod`, `like`,
`div`, `leftSubstring`, `rightSubstring`, `abs`, `ceil`, `floor`, `sqrt`,
`pow`, `position`).

`render.ts` still owns the rest:

- `CASE WHEN` folds for filtered aggregates and filtered arguments (lines
  411, 422) and `case` lowering (451);
- `concat`'s NULL semantics — SQLite `||` propagates NULL, so each part is
  wrapped in `COALESCE(…, '')` (519-521);
- `substring` / `lpad` rewrites with `CASE WHEN LENGTH(...)` (560-570);
- `CAST` target type names per dialect (590-597);
- the `LIMIT`/`OFFSET` matrix — `standard`, `mysql`'s
  `LIMIT 18446744073709551615`, `sqlite`'s `LIMIT -1`, Hive's refusal
  (1053-1076).

So the *same kind of decision* (which SQL text represents this operation in this
dialect) lives in two places, and which place you touch depends on whether the
operation happens to need a wrapper. The direction in `sql-dialect.md` is
right; the unfinished part is what makes "core or prelude?" ambiguous for every
new function.

## 2. What is actually wrong (and what is not)

Not wrong: the single-traversal pipeline, the prelude-as-real-module idea
(`prelude.ts` parses `base/sql.tetaue` and runs it through the same parser,
inferencer, and interpreter), the closed builtin-only type vocabulary, the
symbolic `Query`/`SqlNode` IR (a clean, small algebra worth keeping), and the
decision to make dialect lowering data rather than code.

Wrong, in order of how much they cost:

1. **Two languages are fused into one pass.** tetaue is a pure functional
   *value* language glued to a relational *query* language. The glue is real
   (`filter (u => u.age >= 18)` — an expression whose type depends on the
   enclosing query's row schema; `u.email` is `maybe string` only if `u` came
   from the nullable side of an outer join) and it will never disappear. But
   today there is no artifact that represents "the query plan" separately from
   "the types" and separately from "the AST", so the plan is rebuilt implicitly
   on every traversal and stored inside `Type` tags.

2. **The type checker's inputs are the AST plus a pile of mutable state.**
   `Inferencer` (`inference.ts:150`) fields `env`, `preludeEnv`,
   `preludeNamespaces`, `preludeNames`, `overloads`, `moduleOwnNames`,
   `deferredOverloads`, `modules`, `diagnostics` are reset and re-filled per
   module. `deferredOverloads` + `flushDeferred` + `takeDiagnosticsFrom` exist
   because overload selection inside a row lambda must wait for the row to
   settle — a real constraint, expressed as a mutable pending list rather than
   as a constraint to solve.

3. **Four tables for one function** (Fact A), and a test whose job is to keep
   them in sync.

4. **Inference special-cases builtins by name string** — ~35 sites + 16
   dedicated `infer*` methods. Behaviour that belongs next to a builtin's
   definition instead lives in the type checker.

5. **Plan concepts in the type language** (Fact B).

The through-line: *there is no plan IR*. The interpreter builds `Query` / `Value`
directly while walking the AST, and the inferencer types the AST while emitting
side-channel tags that the interpreter's builders read back. Both facts A and B
are consequences.

## 3. Target architecture

One new intermediate representation between AST and SQL IR, and one pass that
owns it.

```
                ┌─────────────── elaborate ───────────────┐
.tetaue ─▶ AST ─┤ expressions ─▶ HIR (typed) ─▶ Plan      ├─▶ SQL IR ─▶ render ─▶ SQL
                └────────────────────────────────────────┘
                        (one traversal, two IRs, no mode tags in types)
```

### 3.1 Three artifacts instead of two

- **HIR — the pure expression language.** `Expr` nodes with the *value*
  semantics only: literals, records, lists, lambdas, application, `let`,
  `case`, `merge`, the closed container operations, operator sections. HIR
  knows nothing about queries, SQL, or dialects. This is what a pure functional
  core should be able to check and normalize on its own.
- **Plan — the relational layer.** Roots, steps, joins, group-by scope, mode
  transitions, set operations, recursive terms, projected rows. The `Query` /
  `QueryStep` algebra in `interpreter.ts:88-143` is already 80% of this; the
  work is making it a *declared input* to typing rather than an output of the
  same loop, so `fold`-mode legality and outer-join nullability become
  properties of a plan node instead of `agg`/`group`/`nullRow` tags smuggled
  through `Type`.
- **Type.** Unchanged in kind — rows, explicit `maybe`, holes, row
  polymorphism, `Num`-style literal categories — minus `agg`/`group`/`window`
  (moved to Plan), minus `order` (moved to Plan: an ORDER BY item list is plan
  data), and with `nullRow` re-expressed as plan-level nullability that the
  *row schema* records, since only the elaborator ever knows which join side is
  nullable. `truth` stays in the type language (it is genuinely about SQL
  three-valued logic at the expression level) but is renamed to say so.

### 3.2 One traversal, two IRs

The essential property to keep: a binding is read, checked, and lowered **once**,
and the value environment and the type environment advance together, so the
language never has a "checked but not yet meaningful" phase. Concretely, the
lockstep loop in `checker.ts:126-238` stays, but each binding becomes:

```
bind(binding):
  expr   = lower(binding.expr)            # AST → HIR, reporting elaboration errors
  type   = check(expr, typeEnv)           # HIR → Type, recording node types
  plan   = elaborate(expr, type, planEnv) # HIR + Type → Plan
  value  = eval(plan, valueEnv)           # Plan → SQL IR Value
```

Every step is a pure function over values that are passed in and returned.
`check` never sees an AST node it can mutate a map for; `elaborate` never sees
the AST; `eval` never sees types. The four steps stay in one loop — the
traversal is still single-pass — but each one is separately testable, which
today none of them are.

`elaborate` is where the fused knowledge finally has a home: it is the only
component that knows both `u.email : (maybe string)` and "this row came from
the nullable side of a `joinLeft`", because it is the component that has both
the plan and the types in hand.

### 3.3 Declarative builtins: one row per function

Replace the four parallel tables with a single registry whose entries are data:

```ts
// src/core/registry/scalar.ts
export const SCALAR = [
  fn('toUpper', 'string -> string',
     ({ x }) => sql`UPPER(${x})`),
  fn('position', '(maybe string) -> string -> int',
     ({ needle, hay }, d) => d.functions.position(needle, hay)),
  fn('lpad', 'string -> int -> string -> string',
     ({ s, w, pad }, d) => d.name === 'sqlite'
        ? sql`CASE WHEN LENGTH(${s}) >= ${w} THEN SUBSTR(${s},1,${w})
                   ELSE SUBSTR(${pad} || ${s}, -${w}) END`
        : sql`LPAD(${s}, ${w}, ${pad})`),
];
```

One entry supplies the name, the scheme (from the type string), the HIR
lowering, and the per-dialect SQL. Consumers stop being parallel tables and
become derivations: the inference environment is `registry.map(scheme)`, the
evaluator is `registry.map(eval)`, the renderer is
`registry.map(render)`. `test/catalog.test.ts` becomes unnecessary rather than
maintained.

Two rules make this worth the churn:

- **A lowering is data, not a code path.** Every remaining `render.ts` special
  case (§1 Fact C) becomes a registry entry — including the query-shape ones,
  which take the step/plan node instead of scalar args. `CASE WHEN`, `COALESCE`
  NULL semantics for `concat`, `substring`/`lpad` rewrites, `CAST` type names,
  and the `LIMIT`/`OFFSET` matrix all become entries, so there is exactly one
  place to look for "how does this become SQL".
- **An extension is a package, not a patch.** `docs/design/core.md` currently
  says "adding a SQL primitive requires a core [change]". With a registry the
  goal becomes: a SQL function is one entry, in one file, in the category
  folder that matches its category. Nothing else moves.

### 3.4 Target module layout

```
src/
  front/            grammar + generated AST (unchanged)
  hir/              the pure expression language: Expr, lowering from AST, pretty-printer
  types/            Type, TypeUniverse, unification, generalization  (no plan concepts)
  plan/             Plan/Root/Step/Join/GroupBy, elaborate(HIR, Type) -> Plan
  core/
    registry/       scalar.ts date.ts string.ts window.ts aggregate.ts query.ts primitive.ts
    eval/           plan -> SQL IR: expression reduction, records, transformers
    ir.ts           SQL IR (SqlNode / QueryStep) — moved out of interpreter.ts
  sql/
    dialect.ts      DialectSpec, capability matrix
    render.ts       Plan/SQL IR -> text (generic walkers only)
    optimize.ts
  project/          imports, scope resolution, module cache, prelude
  lsp/              completion, hover, definition, tokens, formatter
  cli.ts  language-server.ts
```

`interpreter.ts` and `inference.ts` as names disappear: their responsibilities
land in `hir/`, `plan/`, `core/eval/`, and `types/`. Domain sizes stop being
2,000-line files — the registry is one file per SQL category, which is how the
117 builtins should have been organised all along.

## 4. Staged plan

Each stage ends green (tests pass) and is revertable on its own. A golden net
comes first because a redesign at this scale is unverifiable without it.

**Stage 0 — golden net (no production change).**

> **REMOVED ON REQUEST, mid-Stage-5.** The net was built and used through
> stages 1-4 (it caught one real regression), then deleted by user request along
> with `scripts/golden.ts`, `test/golden.test.ts` and the 19 fixtures, because
> the SQL output it pinned was not the thing that kept breaking. That judgement
> was borne out: see the note on verification below.

Original intent: a script recording, for every `examples/*.tetaue` (and the
`examples/lib-project` tree) and every dialect, the current output of `render`
and `types`, committed under `test/golden/`, so each later stage could prove
equivalence instead of arguing it.

**What actually caught regressions, through Stage 5.** Not the SQL net. Across
the five `Type`-tag removals, golden output was byte-identical throughout — SQL
rendering was unaffected. Every regression was caught by the ~580
diagnostic-message assertions in the test suite, and specifically by the
NEGATIVE tests (`types.test.ts`, `pipeline-order.test.ts`, `windows.test.ts`,
`truth.test.ts`). Three examples:

  - dropping the `sort` diagnostic when the return type was still a variable;
  - `over (rowNumber)` breaking because a nullary builtin unwraps to a bare
    `Identifier`;
  - the `lag` arity check disappearing when the mode tag stopped pinning the
    type.

`bun run check:examples` also earned its keep — it alone caught the
`sum $ 1.0 + r.total` operator-spine case in `examples/report.tetaue` that the
647 tests missed. **Keep `check:examples` green; that is the cheap end-to-end
net now.**

**Stage 1 — extract the SQL IR; make the registry data.**
Move `SqlNode` / `Query` / `QueryStep` / `Schema` / `Value` out of
`interpreter.ts` into `core/ir.ts` (mechanical, no semantic change). Introduce
the registry *beside* the existing tables, then move the scalar, date, string,
math, and window families into it one category at a time, deleting the
corresponding `BUILTINS` entries and `inference.ts` name-special-cases as each
moves. Exit criteria: `builtin.ts` and `interpreter.ts`'s builtin half shrink;
`catalog.test.ts` is deleted because there is nothing left to keep in sync;
golden output unchanged.

**Stage 1a — DONE.** `src/core/ir.ts` (121 lines) now holds the SQL IR:
`SqlType`, `TypeOrNull`, `SqlColumn`, `Schema`, `SqlNodeBase`, `SqlNode`,
`RowNode`, `JoinKind`, `SetOp`, `QueryStep`, `Query` — moved verbatim. It
imports only Langium's `AstNode` and nothing from `src/language/`, so there is
no cycle. All five consumers (`interpreter.ts`, `render.ts`, `optimize.ts`,
`capabilities.ts`, `index.ts`) import it directly; `interpreter.ts` re-exports
the names so no existing import site changed. `interpreter.ts` 4,530 → 4,434
lines; `tsc` clean; 650/650 tests pass; golden fixtures unchanged — the
extraction is provably behaviour-preserving.

*Scope note:* `Value`, `Ctx`, `Diagnostic` and `EvalResult` deliberately stayed
in `interpreter.ts`. They are evaluator state rather than IR, and the plan puts
them in `core/eval/` during Stages 3 and 6. Only the SQL IR moved here.

**Stage 1b — DONE (schemes + lowerings).** Per-dialect lowering is now registry
data. `BuiltinSpec` gained an optional `lower: (ctx: LowerCtx) => string | null`,
and **25 entries** declare one: the 10 scalar wrappers (`concat`, `greatest`,
`substring`, `reverse`, `lpad`, `fromMaybe`, `isTrue`, `isFalse`,
`isUnknown`, `cast`) and the 15 date/time functions. `LowerCtx` hands a
lowering the call's *already-rendered* argument texts plus the dialect, a
string-literal quoter, a cast-type namer, and literal/number readers — so a
lowering is a pure string function that cannot reach back into the plan.

Two hand-kept dispatch sets were deleted from `render.ts`: `SPECIAL_CALLS` (a
membership list that had to agree with the switch by hand) and
`DATE_FUNCTIONS`. `renderCall` went from ~85 lines of bespoke switch to 22
lines that look the lowering up in a map derived from the registry. The eight
date helpers moved to the leaf module `src/core/date-lowering.ts` (235 lines),
imported by the registry — it must not live in `render.ts`, which imports the
registry, so the extraction is what avoids a cycle. `render.ts` 1,193 → 923
lines. `tsc` clean, 650/650 tests pass, golden fixtures unchanged.

*Two findings worth recording, both discovered by the golden net failing:*
1. **An alias keeps its own spelling in the IR.** The evaluator resolves
   aliases for argument-index purposes but stores the written name in the call
   node — `rpad` stays `rpad`, it is not rewritten to `lpad`. A lowering that
   differs between a name and its alias must therefore read `ctx.name`, not
   assume it was called on the canonical entry. This bit twice
   (`lpad`/`rpad` direction, `greatest`/`least` → `MAX`/`MIN`); the second was
   caught by an SQLite *execution* test, not by the golden net.
2. **`as const` on `BUILTIN_SPECS` hides an optional field.** The array is
   `as const` so `BuiltinName` stays a precise union (a plain annotation widens
   it to `string` and breaks `DialectSpec.functions`). The cost is that entries
   omitting `lower` do not expose the property, so the lookup widens to
   `BuiltinSpec[]` for that one read.

*Not done in 1b:* the 121 runtime impls still live in `interpreter.ts` and are
matched to specs by name, policed by `test/catalog.test.ts`. Moving them would
mean relocating closures that depend on ~60 module-private helpers (`fn`,
`step`, `stringValue`, `ERROR`, `ctx.diagnostics`, ...) — a rewrite with high
regression risk and no reader-visible benefit, since the naming parity is
already structurally exact (121 impls ↔ 116 specs + 5 aliases). The registry is
the join point for scheme + category + doc + lowering; that is the half that
removes duplication. Revisit only if the evaluator is restructured anyway
(Stages 3/6).

**Stage 2 — DONE (verified, mostly by Stage 1b).** The exit criterion is met:
`grep -E 'UPPER|LOWER|LPAD|RPAD|SUBSTR|REVERSE\(|CONCAT\('` over `render.ts`
returns only the name `LOWERINGS` — no scalar-function SQL survives in the
renderer. Every one of the 25 registry lowerings lives in `builtin.ts`; the 8
date helper functions live in the leaf module `src/core/date-lowering.ts`.

*What deliberately did NOT move, and why the original criterion was too broad.*
`render.ts` still names `SELECT`/`FROM`/`WHERE`/`JOIN`/`LIMIT`/`OFFSET`/`WITH`
and `COUNT`/`SUM`/`AVG`/`COALESCE`, and still wraps filtered aggregates in
`CASE WHEN` / `FILTER (WHERE ...)` (lines 411-430). Those are not function
lowerings:

- `COUNT`/`SUM`/`AVG`/`COALESCE` are already DATA — the per-dialect `functions`
  map at lines 109-164.
- `SELECT`/`FROM`/`WHERE`/`LIMIT`/`OFFSET` are the renderer's structural job.
- The filtered-aggregate `CASE WHEN` / `FILTER` choice dispatches on the IR's
  `agg` node, handles `_where` name suffixes and `countDistinct`, and picks a
  form per dialect. That is plan-shape rendering, and `LowerCtx` — which takes
  already-rendered SCALAR args — is the wrong shape for it. Forcing it into the
  registry would mean handing lowerings live IR nodes, which is exactly the
  coupling `LowerCtx` exists to prevent.

So the honest statement of Stage 2 is: **per-dialect SCALAR/TEMPORAL lowering
is data; plan-shape lowering stays in the renderer.** The remaining `switch` in
`render.ts` dispatches on IR node kind (`col`, `lit`, `bin`, `agg`, `window`,
`case`, `in`, `exists`, `scalar`, ...) — the renderer's core responsibility.

*Coverage gap closed first.* `examples/dialect-surface.tetaue` gained 7
query-shape bindings (`set_union`, `set_union_all`, `set_intersect`,
`set_except`, `windowed`, `closure`, `lateral`), each rendered per dialect by
`scripts/golden.ts` via a new `SHAPE_BINDINGS` table. This closed 7 of the 8
previously-unguarded lowering families — before it, the golden net could not
see a set-operation, window, recursive, or lateral regression at all (verified
by injecting `INTERSECT -> UNION`, which now correctly reports `DRIFT`). One
family remains unguarded (MySQL's `toUnixtime`/`dateParse` spellings).

`scripts/validate-dialects.ts` and `validate-sqlite.ts` were not re-run in this
session; the equivalent coverage comes from the 650-test suite plus the golden
net's 19 fixtures x 5 dialects.

**Stage 3 — DONE.** `inference.ts` has **zero references** to `interpreter.ts` —
no code, no types — so the dependency is one-way. The fused
`Inferencer.typedBinding` is now `Inferencer.checkBindingTypes(binding, exported,
scope, cycleNames)`, which returns ONLY the type-side diagnostics and installs
the binding scheme in `scope`. The evaluator call moved to the caller:
`checker.ts` runs `checkBindingTypes` then `checkBinding` per binding, in the
same loop.

That keeps the single-traversal property — a project is still read, typed and
evaluated once, per binding, in one pass — while removing the fusion. The loop
now literally reads as the four-step shape §3.2 proposed, minus HIR.

Three shared pieces moved to a new evaluator-free module,
`src/language/binding-analysis.ts` (181 lines), so BOTH passes can use them:

- `topoOrderBindings` + its private `freeModuleRefs` walker and
  `TYPE_NODE_TYPES` set — pure AST analysis; the reference graph and stable
  topological order that drive top-down binding resolution.
- `missingBindingExpressionMessage` / `recursiveBindingMessage` — the wording
  the two passes must share so `mergeDiagnostics` dedupes by (node, message).
- `Diagnostic` and `DialectView` types. `DialectView` had a comment explaining
  it lived in `interpreter.ts` to avoid importing `render.ts`; that same
  reasoning is what makes the evaluator-free module its proper home.

`interpreter.ts` re-exports all of them, so no external import site changed.
`inference.ts` 3,563 → 3,566 lines, `interpreter.ts` 4,434 → 4,303. `tsc` clean,
650/650 tests pass, golden fixtures unchanged.

**Stage 4 — DONE (evaluator side).** `src/hir/hir.ts` (179 lines) defines the
pure expression IR — 16 variants mirroring exactly what the evaluator must
dispatch on, no more: `let`, `ascribe`, `negate`, `binary`, `access`, `apply`,
`number`, `string`, `bool`, `null`, `case`, `list`, `record`, `lambda`,
`section`, `ref`. `src/hir/lower.ts` (162 lines) is the ONLY module that
inspects the grammar's expression node types; the evaluator's
`evalExprWithInner` (a chain of ~15 AST guards) became `evalHirInner`, a
`switch` on `h.kind`. `Value.lambda.body` now holds a `Hir` node, so the two
representations never mix, and the dead `evalUnary`/`evalUnaryInner` pair was
deleted (23 lines) since `negate` is a first-class variant.

Two design decisions worth recording:

1. **HIR holds VALUES, not lexemes.** `StringLiteral.value` is the raw token
   (`"users"`, escapes included), so lowering calls `parseStringLiteral`. I
   initially stored the raw token and the golden net caught it immediately:
   `table "users"` rendered as `FROM """users"""` and `UPPER` was quoted as an
   identifier. Decoding at lowering also keeps the unknown-escape warning in
   the one place that sees raw text.
2. **Punned record fields (`{ id }`) stay unresolved.** Their meaning comes
   from the enclosing lambda parameter, which lowering cannot see (it has no
   environment), so `HirEntry.value` is `undefined` and `at` keeps the
   MapEntry node so the evaluator can walk `$container`. `case` branches
   likewise model "no condition" as `cond: undefined` rather than a flag.

*Verification.* Zero golden drift across 19 fixtures x 5 dialects. Note the net
covers SQL TEXT only, so it caught the string bug but NOT three lost
diagnostics — the 650-test suite caught those: `this`/`that` inside an explicit
lambda lost its dedicated `unknown lambda parameter 'this'` hint, the
`unknown identifier` listing began including builtins, and `{ 1 | x = 2 }`
emitted the generic merge error instead of `record update expects a record
before '|'`. All three were faithful-porting slips, restored from the original
source. **This is the concrete argument for not trusting the golden net alone
in stages 5/6.**

*Remaining AST use in the evaluator is deliberate:* the `$`-arity scan
(`dollarArity`), function-argument-index analysis, and the enclosing-lambda
walk all inspect raw SYNTAX to decide argument semantics — a syntax-level task
HIR intentionally does not model.

**Stage 5 — move plan concepts out of `Type`.**
Delete `agg`/`group`/`window`/`order`/`nullRow`/`builtin` tags from `Type`
(`types.ts:205-240` and the `builtinOf` tag), replacing each with a Plan-level
property: modes become step/plan validation in `plan/`; `order` becomes plan
data; nullability becomes a row-schema attribute the elaborator computes; the
builtin tag is replaced by registry identity. This is the largest behavioural
risk and the reason stages 0-4 exist. Exit criteria: `types.ts` no longer
mentions `agg`, `group`, `window`, `order`, or `nullRow`; every
`isModeOf`/`modePayload` call site in the old `inference.ts` is gone; golden
output unchanged.

**Stage 5 — DONE for `agg`/`group`/`window`/`order`/`truth`; the premise was wrong for `nullRow` and `builtin`.**

`order` is removed from `Type`. `asc`/`desc` are now TRANSPARENT
(`asc u.name : string`) and "is this an ORDER BY item?" is decided from the
EXPRESSION at the two sites that care: `postCheckArg`'s `sort` branch (via
`sortBodyExpr` + `producesOrderItems`) and `inferMap`'s entry check. Both walk
the syntax for a head `asc`/`desc` identifier. The `types.ts` `order` variant,
its unification/pretty-print/occurs cases, and the tag's transparency special
case are all gone. 650/650 tests pass, golden net zero drift.

Three findings from doing it that change the rest of the stage:

1. **The tag was load-bearing for BOTH a positive and a negative rule.** The
   `sort` check had to catch not only a concrete non-order type but also a
   still-UNCONSTRAINED return type (`u => u.name` leaves the column's type open
   at the definition site). The original did this by skolemizing the variable
   and attempting unification with `order`. Porting it as "skip the check when
   the type is a variable" silently dropped the diagnostic — caught by
   `test/types.test.ts` and `test/pipeline-order.test.ts`, not by the golden
   net. The syntactic form must be judged regardless of the type.
2. **`builtinOf` is what keeps first-class bindings working.**
   `inferApplication` derives `funcName` as
   `directBuiltinName(e.func) ?? (rawF.kind === 'builtin' ? rawF.name : null)`,
   so `by = sort` then `by (u => u.name)` still resolves to `sort`'s rules. That
   tag is NOT a plan concept — it is name identity surviving a first-class
   binding, i.e. exactly what §3.3's registry is meant to provide. Removing it
   requires the registry to supply identity instead, which is a real design
   task, not a deletion.
3. **`agg`/`group`/`window` cannot move to a Plan, because no Plan exists at
   the moment they are needed.** They are produced WHILE typing `fold`'s
   projection lambda and consumed IMMEDIATELY after, by the same application's
   post-check, which reads the resulting row's field types. The tag is how
   phase information rides along inside an ordinary row type. `inferMap` reads
   them the same way. (Confirmed by the user decision to replace the idiom with
   direct entry checks.)

So the honest restatement of Stage 5: `order` was a pure marker and came out
cleanly. The remaining tags each carry information that is genuinely
type-shaped and consumed within a single application's typing, so removing them
means rewriting `inferFold`/`inferMap`/`inferApplication`'s post-checks to walk
the projection's ENTRIES directly — the same transformation `order` just
received, repeated three times with payloads. That is mechanical but
substantial, and it is where the remaining risk sits.

**`truth` is also removed from `Type`.** The tag existed so `isTrue`/`isFalse`/
`isUnknown` accept `bool` **or** `maybe bool` while still rejecting every other
scalar. It is now a direct acceptance predicate on the argument
(`isTruthAccepting`: `bool`, `maybe bool`, or unresolved) plus a check at the
call site; `truthType()` and its three-way unification special case are gone,
and the three schemes take an ordinary type variable. 647/647 pass.

Three more findings:

4. **The tag was doing DEFERRAL, and that had to be reproduced deliberately.**
   `isUnknown u.id` sees `u.id` as a row-field variable. The old marker
   unified itself INTO that variable, so the enclosing lambda's row became
   `{ id: bool? | r }` and the failure surfaced at the application site as
   `cannot apply`. Dropping the marker silently lost the error on the
   inference-only path (`typeErrors`). The fix was to leave the variable alone
   when it is unresolved — but that is only correct because of finding 5.
5. **A static check was already duplicated at runtime.** `interpreter.ts`'s
   `truthPredicateBuiltin` independently validates the argument's concrete
   `node.type` and reports the same requirement. A first attempt added a
   *deferred* static check to compensate for finding 4 and produced the
   diagnostic TWICE (the merged list dedupes on `(node, message)`, and the two
   nodes differ). The resolution: let the interpreter own it, and have the
   static pass only handle already-known types. **The user-facing message is
   now better** — `isUnknown expects a boolean or nullable boolean expression,
   got type int`, naming the builtin and the real type, instead of
   `cannot apply a function of type (query { id: int } -> t506) -> t506 to an
   argument of type query { id: bool? | r500 } -> ...`. Verified through the
   CLI and `checkProject`; `test/truth.test.ts` was updated to assert it via
   `allErrors` (the merged path `check`/LSP render) rather than `typeErrors`.
6. **`truth` marks an acceptance RANGE, not a payload.** `bool ⊔ maybe bool`
   is a union, and the codebase's `overloadOf` is NOT a substitute: it models a
   repeated same-name binding resolved per call site, with different diagnostics.
   The direct predicate is the right replacement; there is no tag to preserve.

Net for Stage 5: `agg`, `group`, `window`, `order` and `truth` are ALL removed
from `Type`. `Type` is down to 11 variants (`var`, `prim`, `maybe`, `fun`,
`list`, `row`, `nullRow`, `query`, `builtin`, `overload`), and the SQL mode of a
builtin lives in `BUILTIN_MODES` (builtin.ts), derived from `category` so the
two cannot drift.

**`agg`/`group`/`window` DONE.** The mode is now a lookup on the entry's head
builtin (`entryModeOf` + `builtinModeOf`), read from the SYNTAX at the three
call sites that care — `inferFold`, `inferMap`, `inferOver` — instead of from a
wrapper around each field type. The `modeOf`/`isModeOf`/`modePayload`/
`aggOf`/`groupOf`/`windowOf` helpers, the mode-absorption case in
`unifyInternal`, the `substitute`/occurs/pretty-print cases, and the 19
`modeOf(...)` wrappers in the schemes are all deleted. 647/647 pass.

Four more findings, all from tests that are NOT about modes:

7. **A whole category of type-level check was resting on the tag.** `lag`'s
   arity was enforced incidentally: the window tag made the third application
   non-functional, so a fourth argument failed to unify and `argError` produced
   `lag takes exactly three arguments`. With transparent schemes the surplus
   argument unifies with the still-open value type and is silently absorbed.
   Fixed by checking `index >= 3` in `postCheckArg`, which sees every curried
   argument regardless of whether the type has resolved. Note both
   `lag u.salary ...` (open) and `lag 1.5 ...` (concrete) must be caught — the
   concrete case alone passes by accident.
8. **`over (rowNumber)` broke**, because `entryModeOf` unwrapped a nullary
   builtin to a bare `Identifier` and then required an `Application`. A nullary
   builtin (`rowNumber`) and an applied one (`sum u.x`) reach the head
   differently; both must be handled.
9. **`case`-wrapped aggregates stopped being recognized.** `case { c => sum x,
   _ => sum y }` has `case` as its head, so the mode had to be looked up in the
   BRANCH values. Without this, a valid CASE aggregate was reported as "must be
   wrapped in an aggregate".
10. **The interpreter already owned most of these checks.** Its `forbid()`
    guards against the IR node kinds (`agg`/`group`/`order`/`window` — a
    DIFFERENT namespace, the SQL node types) and reports matching messages. This
    is why several mode diagnostics survived the tag removal untouched, and why
    the type-level guards only needed to cover what the interpreter cannot see:
    an unresolved type at type-check time.

**`nullRow` and `builtin` are NOT removable, and the reason is principled.**

- `nullRow` is a lazy type-level FUNCTION, not a marker: it maps a row to its
  field-wise maybe row and deliberately stays symbolic while `of` is an unbound
  row variable, so outer-join typing can proceed before the merged schema is
  known (`reduceNullRow`, applied by `peel`). Every use consumes `of`. It also
  encodes a real distinction: `nullRow s` (row present, fields nullable) vs
  `maybe s` (whole row absent). Moving it out of `Type` would mean inventing
  general type-level functions.
- `builtin` is name identity surviving a first-class binding (finding 2), which
  is the registry's job (§3.3) — a design task, not a deletion. **Verified by
  experiment, not assumed.** The tag is applied to each prelude scheme in
  `prelude()` and is what makes `by = sort` keep `sort`'s static rules. Gating
  the tag off and re-running shows a one-hop binding (`by = sort`) and even a
  two-hop one (`srt = sort` / `by = srt`) lose the check entirely, silently.
  A `Scheme`-level name could NOT replace it: by the second hop the value is an
  already-instantiated `Type`, so only a type-level tag reaches the consumer.
  Measured coverage: of the 13 builtins with special argument checks (`filter`,
  `map`, `fold`, `sort`, `take`, `over`, `not`, `upper`, `length`, `abs`,
  `round`, `joinInner`, `table`), **no check is lost through a binding** — every
  one that fires on a direct use fires on the bound use too. (An earlier note
  here claimed a gap for `greatest`; that came from probing `infer()` alone with
  a malformed input. Through `checkProject` — what `check`/LSP/CLI run —
  `greatest` is caught in both forms.)
- `overload` is unrelated to any of this: it models one name bound to several
  definitions, resolved per call site.

So Stage 5's exit criterion ("`types.ts` no longer mentions agg/group/window/
order/nullRow") is met for four of the six names. `nullRow` should be struck
from the criterion — it is type algebra, not a plan concept, and the stage's
premise about it was wrong in the same way as for `agg`/`group`/`window`.

**Stage 6 — `plan/elaborate`. BLOCKED: `interpreter.ts` is the evaluator, not a
planner, so it cannot be deleted and `elaborate` cannot replace it.**

Measured, not assumed. `interpreter.ts` is 4,315 lines and splits at line 1,874,
where `const BUILTINS` begins:

  - **lines 1,874-4,315 (2,441 lines) — the RUNTIME BUILTIN IMPLS.** Stage 1b
    deliberately left these in place: they pull in **648 references** to
    module-private helpers (`ERROR` x227, `fn` x132, `describe` x85, `mkExpr`
    x67, `exprNode` x65, `forbid` x42, `lit` x26, `step` x19, `stringValue`
    x13, ...). They ARE the evaluator; there is no evaluator to delete them in
    favour of.
  - **lines 1-1,873 — the EVALUATOR CORE** (`evalHir`, `evalBinary`, `access`,
    the `fn`/`step`/`joinBuiltin` constructors, `nullableGuard`,
    `applyBinaryOperator`). This is NOT a separable "planner": `fn` and `step`
    **build IR nodes while evaluating**, so planning and evaluation are
    interleaved by construction rather than layered.

So `elaborate(HIR, Type, PlanEnv) -> Plan` has no honest extraction point. The
premise was already refuted by Stage 1b's finding, which was recorded but not
propagated back to this stage.

What IS true and worth doing instead:

  - The **consumer** side is already clean: only 7 modules import
    `interpreter.ts`, and almost entirely for leaf items — `Diagnostic` (a
    type), `parseStringLiteral`, `querySchema`. Those are exactly the kind of
    leaf extraction done in `binding-analysis.ts` and `date-lowering.ts`. Moving
    `Diagnostic`/`Value` shapes and `parseStringLiteral` into leaf modules would
    let `render.ts`, `compile.ts`, `imports.ts`, `project-scope.ts` and
    `tetaue-validator.ts` stop depending on the 4,315-line evaluator.
  - `querySchema`/`rowNodeSchema` are pure IR→schema functions and could move to
    `core/` beside `ir.ts`.

Recommended restatement of Stage 6: **extract the leaf types and pure helpers
out of `interpreter.ts`** so it exports only the evaluator, then stop. Do not
attempt `elaborate`.

**Stage 6 — DONE as restated (leaf extraction).**

Inspection showed the leaf extraction was already largely done: `Diagnostic` lives in
`binding-analysis.ts` and `parseStringLiteral` in `strings.ts`; `interpreter.ts`
merely RE-EXPORTED them, and five modules were routing through the 4,315-line
evaluator to reach a two-line helper. What actually moved:

  - `rowNodeSchema`, `querySchema` and `nodeTable` → `core/ir.ts`, beside the IR
    they operate on. They are pure `IR -> Schema` functions and were the
    renderer's ONLY reason to import the evaluator.
  - `render.ts`, `compile.ts`, `imports.ts`, `project-scope.ts`,
    `tetaue-validator.ts` and `checker.ts` now import from `core/ir.js`,
    `strings.js` and `binding-analysis.js` directly.

`interpreter.ts` importers: **7 -> 2** (`index.ts`, its deliberate public API
surface, and `checker.ts`, which really does orchestrate evaluation). Seven
language modules — `render`, `compile`, `imports`, `project-scope`,
`tetaue-validator`, `optimize`, `capabilities` — are now INDEPENDENT of the
evaluator. 647/647 tests pass, `tsc` clean, 14/14 examples valid.

The two remaining re-exports in `interpreter.ts` (`parseStringLiteral`,
`Diagnostic`/`DialectView`) are kept solely because `index.ts` re-exports them as
public API; nothing internal needs them.

Stages 1-2 are independent of 3-6 and can be done in either order. Stage 5 must
follow Stage 4 (it needs HIR to have somewhere sane to put the removed tags).

## 5. What must stay pure and concise

The user's only invariant, made concrete — these are the properties the
redesign must *strengthen*, not merely preserve:

- **No mutable state threaded through a pass.** Every stage turns a mutable
  field back into an argument and a return value. `Inferencer`'s field bag
  (§2.2) is the target: by Stage 6, a pass receives an environment and returns
  a new one.
- **One place per decision.** Adding a SQL function touches one entry in one
  file (§3.3). No parallel tables, no name-keyed special cases in the type
  checker.
- **Enumeration over dispatch.** Category files, registry entries, and IR node
  kinds rather than long `if (name === …)` chains.
- **Symbolic IR stays symbolic.** The `Query`/`SqlNode` algebra is the reason
  dialect lowering can be data; it must survive the redesign intact.
- **One traversal.** Elaboration stays single-pass over a project. Splitting
  inference from evaluation must not become "check the project, then run it".

## 6. Open items and known blockers

- **Two pre-existing test failures** (`bun test`: 646 pass / 2 fail) —
  `selective imports > qualified type aliases work through a namespace import`
  and `tetaue language server (LSP over stdio) > semantic tokens classify
  keywords, types, functions, and variables`. They are unrelated to this
  proposal but must be resolved or recorded as expected in Stage 0, otherwise
  the golden net starts dirty.
- **`type-system-formal.md` says "the current source"** and anchors rules at
  file:line. Stages 4-6 invalidate those anchors wholesale; the document needs
  revisiting as part of Stage 6, not as an afterthought.
- **`docs/design/modules.md`** describes per-module scoping that Stage 3/6 must
  keep byte-identical in observable behaviour (collision diagnostics, prelude
  precedence, re-export merging). It is the specification to test against.
- **Open naming decision** already recorded in `sql-dialect.md`: whether the
  Haskell-flavored spellings (`toUpper`) or the SQL-named ones (`upper`) are
  canonical. The registry (§3.3) makes this a one-line question per entry —
  worth resolving *during* Stage 1 rather than after.
- **Not decided here:** whether the prelude should gain the ability to
  *declare* registry entries (i.e. whether dialect lowerings live in
  `base/sql.tetaue` for user-extensible dialects, or in TypeScript
  registries for speed). `sql-dialect.md` pushes lowering toward the source
  prelude; §3.3 pushes it toward data. A future stage could reconcile them by
  making the registry serializable — but that is a separate decision and is
  deliberately left open.

## 7. Status, and why stages 5-6 stop here

Implemented and verified, in order: **stage 0** (test fixes + golden net),
**1a** (`core/ir.ts`), **1b** (registry lowerings), **2** (dialect migration
verified + fixtures extended), **3** (`inference.ts` decoupled from the
evaluator), **4** (HIR for the evaluator).

Stages **5** (`agg`/`group`/`window`/`order`/`nullRow`/`builtin` out of `Type`)
and **6** (explicit `plan/elaborate`, retiring `interpreter.ts`) are
deliberately NOT started. The reason is the cost/benefit measured while doing
stage 4:

- Every stage so far had a *mechanical* success criterion the existing
  instruments could check: golden SQL drift (stages 1-2, 4) and imports
  (stage 3). Stages 5-6 do not. They change what the type checker *means*.
- Stage 5 is the load-bearing change: `agg`/`group`/`window` are consumed at
  **nine** sites in `inference.ts` (`modePayload` x6, `isModeOf` x3), all
  inside `inferFold`, `inferMap`, or a binary-operand check. Moving them to a
  Plan requires that Plan to exist first — i.e. stage 6's elaborator — so the
  two stages are really one rewrite of the 3,566-line inference pass.
- The benefit is real but concentrated: removing inference's 37 AST
  inspections and 36 dedicated `infer*` methods. Stage 4 proved HIR's shape for
  the EVALUATOR; it says nothing yet about whether HIR is the right input for
  type inference, where the rules need static types, not values.
- The instrument gap is now measured, not assumed. The golden net covers SQL
  text only. In stage 4 it caught one bug (raw vs. decoded string literals) and
  **missed three** (all diagnostic regressions), which the 650 tests caught.
  For stages 5-6, where behaviour is diagnostics-heavy and SQL-neutral, that
  ratio inverts and the net becomes close to useless on its own.

The honest recommendation: treat stages 5-6 as a single, separately-scoped
project, and start it by building the missing instrument — a diagnostic-level
snapshot (every example x dialect, recording the full diagnostic list, not just
SQL) — so the rewrite has a net that actually guards what it changes.
