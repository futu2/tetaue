# tetaue type system: rows, explicit Maybe, and holes

Status: **implemented (v4)** — `src/language/types.ts`, `src/language/inference.ts`,
`src/language/builtin.ts`, and the `Type` grammar.

This document is the current specification. The previous `t?` / absorption
design has been removed.

## 1. Core ideas

1. **Hindley–Milner inference with row polymorphism.** A lambda such as
   `u => u.age >= 18` is typed once and reused on any row that has an
   `age: int` column.
2. **Maybe is explicit, like Haskell.** `(maybe T)` is a distinct type
   constructor. There is **no implicit conversion** between `T` and
   `(maybe T)` and no absorption during unification.
3. **Holes are named unsolved metavariables.** `?name` is never generalized,
   so every use of a binding with a hole shares one metavariable until
   unification fills it. A bare `table "users"` gets a fresh row hole
   (`query ?table`) instead of `forall r. query r`.
4. **SQL NULL is explicit.** `null : forall a. (maybe a)`, `just : a -> (maybe a)`,
   `nothing : forall a. (maybe a)`, `from_maybe : a -> (maybe a) -> a`,
   `is_null` / `is_not_null : (maybe a) -> bool`. `coalesce` remains as the
   SQL-native choice between two maybe values.
5. **Numeric polymorphism is constrained.** `Num t` is retained on inferred
   variables through generalization and instantiation. Its closed instances
   are currently `int`, `float`, and `decimal`.
6. **Other classes are closed compiler-owned constraints.** `Eq` and `Ord`
   cover the scalar primitives listed below; `Semigroup`/`Monoid` cover
   strings and lists for `<>`; `Functor` has executable instances for
   `maybe`, lists, and queries; and `Applicative`, `Alternative`, and `Monad`
   have executable instances for `maybe` and lists. These constraints are not
   user-declarable.

## 2. Type aliases

A module may declare aliases before its bindings:

```
type UserRow = query { id: int, name: string }
type AdultRow = { age: int | r }
```

Aliases expand in any annotation or schema and may not be recursive.
`export type UserRow = ...` publishes an alias; importers bring it into
scope with flat imports, selective renaming, or a namespace:

```
import "schema.tetaue" as s
users: s.UserRow = table "users"
```

## 3. Type syntax

```
Type       ::= FunType | TypeAtom
FunType    ::= TypeAtom '->' Type            -- right-associative
TypeAtom   ::= '(maybe' Type ')' | BaseType
BaseType   ::= int | float | decimal | string | bool | date | timestamp
             | '{' (Field (',' Field)* ','?)? ('|' tail)? '}'
             | 'query' '{' (Field (',' Field)* ','?)? ('|' tail)? '}'
             | '[' Type ']'
             | '?hole_name'
             | lowercase-type-variable
             | '(' Type ')'
Field      ::= name ':' Type
tail       ::= lowercase-row-variable | '?hole_name'
```

- `{ a: int | r }` is an open record with row variable `r`.
- `{ a: int | ?rest }` is an open record with a row hole.
- `(maybe T)` is the nullable type. Nesting is allowed by the type engine,
  but SQL schemas accept at most one layer of maybe.
- Lowercase variables in tail position are row variables; elsewhere they are
  type variables.
- Holes are flexible and named; they are excluded from generalization.

## 4. Nullability rules

- `maybeOf(T)` never flattens and never unifies with `T`.
- `null` (also `nothing`) has type `forall a. (maybe a)`.
- `just x : (maybe T)` when `x : T`.
- `from_maybe default x : T` requires `default : T` and `x : (maybe T)`.
- `is_null x` / `is_not_null x` require `x : (maybe T)` and return `bool`.
- Comparison `==`/`!=` with `null` is only well-typed when the other operand
  is already maybe; it lowers to `IS [NOT] NULL`.
- Ordinary comparison and arithmetic require non-maybe operands. Use
  `from_maybe` (or `coalesce`) to unwrap first.
- Scalar SQL functions (`upper`, `length`, `trim`, date functions, ...) take
  and return non-maybe values; SQL NULL propagation is achieved explicitly
  with `from_maybe`/`coalesce`, not by implicit lifting.
- **Outer joins** expose the null-extended input as a maybe row to the merger:
  `joinLeft` makes the right row maybe, `joinRight` makes the left row maybe,
  and `joinFull` makes both maybe. Field access through a maybe row produces a
  maybe field (without adding a second layer to an already-maybe field), so
  fields from a guaranteed side and constant projections remain non-null.
- **Aggregates** that SQL can make NULL on empty/all-null input
  (`sum`, `avg`, `min`, `max`) produce maybe results:
  `sum : numeric -> agg (maybe numeric)`. `count : a -> agg int` and
  `list : a -> agg [a]` are non-null.

## 5. Holes and dynamic tables

- A hole is created with `TypeUniverse.freshHole(kind, name)`.
- `generalize` skips hole variables. A scheme may therefore contain an
  unquantified hole; `instantiate` leaves it untouched, so all uses share it.
- Direct application `table "users"` returns `query ?table` (a fresh row hole
  per table expression).
- Field access extends a row hole just like a row variable. Different uses of
  the same table therefore accumulate one inferred schema, and conflicting
  uses are rejected:
  ```
  t = table "t"
  q1 = t & map (u => { a = u.id + 1 })   # requires id: int
  q2 = t & map (u => { b = u.id == "x" }) # requires id: string → error
  ```
- User annotations may contain holes (`f: ?a -> ?a = x => x`).
- An unconstrained table alone still renders `SELECT *`; set operations on
  dynamic tables are rejected by the renderer unless a `map` projection has
  made the schema known.

## 6. Numeric rules (Haskell base)

- `+`, `-`, `*`: `Num t => t -> t -> t`. Both operands and the result have
  the same type; `int` and `float` never mix.
- Unary `-`: `Num t => t -> t`.
- `/`: fractional division — `float -> float -> float`.
- `div`, `mod`: integral — `int -> int -> int` (the old `%` operator is gone).
- `ceil`, `floor`, `sqrt`, `abs`, `round` preserve their input numeric type.
- `pow : float -> float -> float`.

## 7. Closed typeclasses

The current runtime uses a deliberately closed instance table:

- `Num`: `int`, `float`, `decimal`.
- `Frac`: `float`, `decimal`.
- `Eq`: `int`, `float`, `decimal`, `string`, `bool`, `date`, `timestamp`.
- `Ord`: the same scalar set as `Eq`.
- `DateTime`: `date`, `timestamp` — the calendar-valued class of the date
  family (`year`…`second`, `extract`, `date_add`, `date_diff`, `date_trunc`,
  `date_format`, `to_unixtime`). Their schemes state the constraint — e.g.
  `year : DateTime t => t -> int` and `date_trunc : DateTime t => t -> string
  -> t` — so hovers show the real shape, and concrete non-date arguments are
  rejected by the ordinary constraint machinery (`year o.note` in a lambda,
  a bound `f = year` applied to a string). Numeric literals still need the
  post-check: they type as defaulted `Num` variables, so no constraint
  fails until after defaulting.
- `Semigroup` and `Monoid`: `string` and lists (list concatenation does not
  require a constraint on the element type).
- `Functor`: `(maybe a)`, `[a]`, and `query r` through `fmap`.
- `Applicative`: `(maybe a)` and `[a]` through `<*>`, `<*`, and `*>`.
- `Alternative`: `(maybe a)` and `[a]` through `<|>` / `orElse`.
- `Monad`: `(maybe a)` and `[a]` through `>>=` / `bind` and `>>` / `then`.

`<>` therefore has three layers of behavior: structural right-biased record
merge, string concatenation lowered through `concat`, and list concatenation.
`Monoid` does not expose a polymorphic `mempty` yet because evaluation has no
type-directed dictionary; no unsound generic empty value is provided.

These are concrete closed instances, not a Haskell-style open class system.
User-declared classes, instance declarations, and higher-kinded variables
(`Functor f`, user-defined `Applicative`/`Monad` instances, and similar)
require a future dictionary and higher-kinded-type design. Query remains only
a Functor: joins and correlated composition keep their explicit relational
operators.

## 8. Builtin type schemes (selected)

```
table       : string -> query ?table       -- special-cased; hole per application
filter      : forall r. (r -> bool) -> query r -> query r
map         : forall r s. (r -> {s}) -> query r -> query {s}
fold        : forall r s. (r -> {s}) -> query r -> query {s}
sort        : forall r t. (r -> t) -> query r -> query r   -- t = order | [order]
take        : int -> query r -> query r
drop        : int -> query r -> query r
joinInner   : forall r s t. query s -> (r -> s -> bool)
                -> (r -> s -> {t}) -> query r -> query {t}
joinLeft    : forall r s t. query s -> (r -> s -> bool)
                -> (r -> (maybe s) -> {t}) -> query r -> query {t}
joinRight   : forall r s t. query s -> (r -> s -> bool)
                -> ((maybe r) -> s -> {t}) -> query r -> query {t}
joinFull    : forall r s t. query s -> (r -> s -> bool)
                -> ((maybe r) -> (maybe s) -> {t}) -> query r -> query {t}
union       : forall r. query r -> query r -> query r

fmap        : closed dispatch for `(a -> b) -> (maybe a) -> (maybe b)`,
              `(a -> b) -> [a] -> [b]`, and `(r -> s) -> query r -> query s`
replaceWith : closed `<$` dispatch over maybe, list, and query
ap          : closed `<*>` dispatch over maybe and list
applyLeft   : closed `<*` dispatch over maybe and list
applyRight  : closed `*>` dispatch over maybe and list
orElse      : closed `<|>` dispatch over maybe and list
bind        : closed `>>=` dispatch over maybe and list
then        : closed `>>` dispatch over maybe and list
just        : forall a. a -> (maybe a)
nothing     : forall a. (maybe a)
from_maybe  : forall a. a -> (maybe a) -> a
coalesce    : forall a. (maybe a) -> (maybe a) -> (maybe a)
             | forall a. [(maybe a)] -> (maybe a)   -- list form: coalesce [x, y, z]
is_null     : forall a. (maybe a) -> bool
is_not_null : forall a. (maybe a) -> bool

count       : forall a. a -> agg int
count_distinct : forall a. a -> agg int
sum         : forall a. a -> agg (maybe a)       -- numeric a
avg         : forall a. a -> agg (maybe float)   -- numeric a
min, max    : forall a. a -> agg (maybe a)       -- comparable a
list        : forall a. a -> agg [a]
group       : forall a. a -> group a

== !=            : Eq a => a -> a -> bool       -- non-maybe; null via == null
< <= > >=        : Ord a => a -> a -> bool       -- non-maybe
&& ||      : bool -> bool -> bool
not        : bool -> bool
+ - *      : Num t => t -> t -> t
/          : float -> float -> float
div, mod   : int -> int -> int
```

Inference specializes the three outer join functions by making only the
null-extended merger argument(s) maybe. The merger's exact projected row is the
result type for every join kind.

## 9. Generalization

Generalization happens at module bindings and `let` bindings. Variables free
in the environment and all holes are excluded from the quantifier list, so
holes remain shared and rigid annotation checking is unchanged. Type-class
constraints are stored with quantified variables and recreated when a scheme
is instantiated, so `add = x => y => x + y` infers
`Num t => t -> t -> t` rather than the unsound `t -> t -> t`.
