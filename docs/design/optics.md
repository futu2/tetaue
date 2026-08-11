# The optics core — Haskell lens/optics as the base architecture

> Status: implemented. This document explains *why* and *how* tetaue's core
> abstraction is a lens/optics system in the style of
> [lens](https://hackage.haskell.org/package/lens) / `optics`.

## 1. Why: the old abstraction wasn't functional

Before this change, tetaue's abstraction layer had four structural problems:

1. **Field access was grammar-baked, not a value.** `u.name` was a syntax chain
   that only worked on a hidden `row` value inside lambdas. There was no way to
   talk about "the `name` field" as a thing — to bind it, pass it around, or
   compose it. Haskell lenses give you exactly that for free
   (`makeLenses` ⇒ `name :: Lens' User String`).
2. **Projection was a lambda, not a composable optic.** `map (u => {...})` and
   `filter (u => ...)` were anonymous, closed-over, not reusable.
3. **Rows weren't first-class record values.** `map`/`fold`/`sort`/`join` each
   hand-built a `{ kind: 'row' }` environment; `{ ... }` literals carried no
   schema or type discipline.
4. **Query steps were a closed, hard-coded set.** `filter | map | sort | take
   | fold | join` — even though a pipeline `q & filter ... & map ...` *is*
   already lens-style composition (`s & l₁ . l₂ . l₃`), the architecture didn't
   recognize it.

## 2. The core idea

> **A query pipeline is optic composition. A step is an optic over rows.**

- **Records are first-class values.** `{ id = 1, name = "ada" }` is a typed
  record value; a row inside a lambda is a record whose schema comes from the
  pipeline.
- **Every record field is an indexed lens.** The index is the field name —
  `u ^. age` ⇔ `u.age` ⇔ `view (ix "age") u`. `at "key"` is the total map lens
  (value or `none`), `ix "key"` the partial one — like lens's `at`/`ix` over a
  `Map`.
- **Optics are first-class values.** `ix "name"` / `field "name"` is a lens
  value; `mapped`
  is a traversal over a query's rows; optics compose explicitly with the
  PureScript operators `<<<` / `>>>` (`mapped <<< name`, `r ^. addr <<< city`),
  so `.` stays purely field access on records.
- **`over` is the primitive.** Like the van Laarhoven encoding, `view` and
  `set` derive from it. The interpreter stores an optic as `{ read, over }`.

## 3. The three fundamental operations

| Operation | tetaue | Haskell lens | Meaning |
|---|---|---|---|
| view | `s ^. l` · `view l s` | `s ^. l` · `view l s` | read the focus |
| over | `s & l %~ f` · `over l f s` | `s & l %~ f` · `over l f s` | transform the focus |
| set | `s & l .~ v` · `set l v s` | `s & l .~ v` · `set l v s` | replace the focus |

`&` is the pipeline (`a & f` ⇔ `f a`) — the same operator lens uses for
`flip ($)`. `%.~`/`.~` build a **setter**, a first-class function `s → t`:

```
loud = name %~ upper          # a setter: record -> record
q = users & mapped %~ (u => u & loud)
```

### Field lenses (indexed lenses)

A field lens is an **indexed lens**: the index is the field name string,
exactly like lens over a `Map`. Two flavors:

- **`at "key"`** — the fundamental **total** map lens (lens's `at`): the focus
  is the value or `none` (absence — distinct from SQL `null`), never an error.
  Because it is total, `at` can *add* (`at "k" .~ v`), *remove*
  (`at "k" .~ none`) and *rename* keys:
  ```
  u ^. at "name"                 # the value, or `none` if absent
  users & at "name" .~ "anon"    # set a column across rows
  users & at "name" .~ none      # remove it — SELECT without "name"
  users & mapped %~ (u => u & at "user_name" .~ u ^. at "name" & at "name" .~ none)  # rename
  ```
- **`ix "key"`** (alias `field "key"`) — the **partial** traversal over a
  present value, like lens's `ix`.

A bare name in lens-operator position (`u ^. age`, `age %~ f`) is a field
selector generated at the use site, like `makeLenses`. A name bound to an
**optic** in scope wins — so `nick = ix "name"` behaves like a named lens —
while any other binding (including the prelude: `u ^. upper` views the `upper`
column) is ignored, exactly like `u.upper`:

```
nick = ix "name"
u ^. nick                      # ≡ u ^. name
users & mapped <<< nick %~ upper   # compose the bound lens under the traversal
```

### Composition

Composition is **explicit**, with the PureScript operators, so `.` stays
purely field access on records (no ambiguity):

- `l1 <<< l2` — compose: the **left** optic is the outer focus, like Haskell
  `l1 . l2` (`Control.Semigroupoid.compose`).
- `l1 >>> l2` — composeFlipped: the right optic is the outer focus
  (`Control.Semigroupoid.composeFlipped`). Both are right-associative and bind
  tightest.

```
mapped <<< name      # ≡ mapped . name            (traversal over the field)
r ^. addr <<< city   # ≡ r ^. (addr . city)        (nested record)
field "a" <<< city   # ≡ field "a" . field "b"     (first-class composition)
```

`mapped.name` is a compile error that suggests `mapped <<< name`.

The `<<<`/`>>>` operators also compose **functions** point-free (PureScript
`Semigroupoid`), so bound predicates are reusable:
`adult = u => u ^. age >= 18` then `filtered (adult)`.

### Traversals and selection

- `mapped` — focuses on **every row** of a query. `over`/`set` lower to a
  `map` step; `view` is a type error.
- `filtered p` — the selection optic (lens's `filtered`): keeps the rows
  that satisfy the predicate, where `p` is any predicate function
  (`filtered (u => u.active)` or a bound `adult`). Lowers to
  WHERE / HAVING.
- `map`/`filter` remain as sugar: `map f` ≡ `mapped %~ f`, `filter p` ≡
  `filtered p`.

### Auto-traversal

Applying a *field lens* update to a **query** lifts it to the rows — a lens
update over a collection applies to every element:

```
users & name %~ upper   ≡ users & mapped <<< name %~ upper
users & age .~ 5        ≡ users & mapped <<< age .~ 5
```

This is what makes `map`-less pipelines read naturally and keeps setters
reusable at both the record level and the query level.

## 4. Syntax

Lens operators bind tighter than arithmetic, like Haskell's `^.` = infixl 8:

```
infix BinaryExpression on UnaryExpression:
    '^.' | '%~' | '.~'      # tightest: view / over / set
    > '*' | '/' | '%'
    > '+' | '-'
    > '==' | '!=' | ...
    > '&&' > '||'
    > '&'                    # pipeline (flip $)
    > right assoc '$'
```

## 5. Interpreter representation

An optic is `{ kind: 'optic', name, traversal, read, over }`:

- `read :: s → a` — the view half.
- `over :: (a → b) → s → t` — the primitive; `set l b s = over l (const b) s`.
- `traversal: true` (e.g. `mapped`) disables `read`/`view`.

Composition is function composition of `read`/`over`:

```
read (l1 <<< l2) s = read l2 (read l1 s)
over (l1 <<< l2) f s = over l1 (h → over l2 f h) s
```

A record is `{ kind: 'record', schema, fields }`. A row parameter is a record
with `fields: []` — access synthesizes the column expression from the schema
(inlining derived columns as before). `over`/`set` on a row-shaped record
materialize **all** columns, so `mapped <<< name %~ upper` renders as
`SELECT "id", UPPER("name") AS "name", "age", "active"`.

## 6. Migration table

| Before | After |
|---|---|
| `filter (u => u.age >= 18)` | `filtered (u => u.age >= 18)` (or keep `filter`) |
| `map (u => { id = u.id, name = upper u.name })` | `mapped %~ (u => { id = u.id, name = upper u.name })` (record building keeps the lambda) |
| `map (u => u & name %~ upper)` | `users & name %~ upper` / `mapped <<< name %~ upper` |
| — | `users & mapped <<< name .~ "anon"` (set a column) |
| — | `users & at "name" .~ none` (remove a column) |
| — | `users & mapped %~ (u => u & at "user_name" .~ u ^. at "name" & at "name" .~ none)` (rename) |
| — | `nick = ix "name"` (first-class indexed lens) |
| — | `setter = name %~ upper` (first-class setter) |

## 7. Future work

- **More traversals**: `each`/`both`/`traversed` over lists (for `is_in`
  lists, sort keys, nested collections).
- **Custom optics**: a `lens get set` builder from lambdas (full van Laarhoven
  power), `to`/`getting` folds.
- **Record types**: `type User = { id = int, name = string }` with
  automatically-scoped field lenses (true `makeLenses`), removing the need for
  `ix "name"` in typed contexts.
- **Prisms**: `_Just`-style prisms for nullables (`u.email ?? "n/a"`).
- **Indexed optics**: `fold` as an indexed traversal with `sum`/`count`.
