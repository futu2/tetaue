# Core and standard prelude

Tetaue has two layers:

1. The TypeScript core contains only operations that need SQL knowledge:
   table roots, query steps, SQL expressions, dialect capabilities, and the
   primitive type schemes in `src/language/builtin.ts`.
2. The standard prelude is ordinary tetaue code in [`prelude.tetaue`](../../prelude.tetaue).
   It defines the public `_op_` bindings plus reusable functions such as
   `id`, `compose`, `is_nothing`, and `is_just`.

The prelude is not a second implementation of the language. The checker parses
it, runs the same interpreter and Hindley-Milner inferencer used for user code,
and injects its exported values and schemes into each module. Imports and local
bindings retain precedence, so a prelude helper can be shadowed normally.

Infix parsing and precedence belong to the grammar, but operator meaning is
lexical. The core injects hidden SQL-aware intrinsics such as `__op_add`; the
source prelude exports ordinary definitions such as `_+_ = __op_add`. Both
`1 + 2` and `_+_ 1 2` resolve `_+_` from the current scope, so a local or
imported operator definition can override the default without changing the
interpreter or inferencer.

`checkProject` is the canonical pipeline: each binding is inferred and
evaluated once, in lockstep, and the resulting SQL IR is what the renderer
consumes. `analyze` and `infer` remain compatibility APIs for tooling that only
needs one side; new integrations should use `checkProject` and pass the parsed
standard prelude (`standardPrelude(services)`).

This boundary is intentionally small. Adding a SQL primitive requires a core
builtin specification and runtime implementation. Adding a reusable functional
abstraction should be a `.tetaue` prelude definition instead.

Aliases and compositions follow the same rule. For example, `is_nothing =
is_null` and `is_just x = not (is_null x)` are source prelude definitions;
only `is_null` and `not` need core implementations.
