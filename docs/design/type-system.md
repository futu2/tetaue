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
- **Outer joins** (`left`/`right`/`full`) mark every field of the merger's
  result row as maybe. This is deliberately conservative: the current
  provenance analysis does not yet narrow the nullability to only the
  null-extended side.
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

- `+`, `-`, `*`: same numeric type in and out (`int` with `int`,
  `float` with `float`); `int` and `float` never mix.
- `/`: fractional division — `float -> float -> float`.
- `div`, `mod`: integral — `int -> int -> int` (the old `%` operator is gone).
- `ceil`, `floor`, `sqrt`, `abs`, `round` preserve their input numeric type.
- `pow : float -> float -> float`.

## 7. Builtin type schemes (selected)

```
table       : string -> query ?table       -- special-cased; hole per application
filter      : forall r. (r -> bool) -> query r -> query r
map         : forall r s. (r -> {s}) -> query r -> query {s}
fold        : forall r s. (r -> {s}) -> query r -> query {s}
sort        : forall r t. (r -> t) -> query r -> query r   -- t = order | [order]
take        : int -> query r -> query r
drop        : int -> query r -> query r
join        : forall r s t. jkind -> query s -> (r -> s -> bool)
                -> (r -> s -> {t}) -> query r -> query {t}
union       : forall r. query r -> query r -> query r

fmap        : forall a b. (a -> b) -> (maybe a) -> (maybe b)
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

== != < <= > >= : forall a. a -> a -> bool       -- non-maybe; null via == null
&& ||      : bool -> bool -> bool
not        : bool -> bool
+ - *      : numeric t => t -> t -> t
/          : float -> float -> float
div, mod   : int -> int -> int
```

## 8. Generalization

Generalization happens at module bindings and `let` bindings. Variables free
in the environment and all holes are excluded from the quantifier list, so
holes remain shared and rigid annotation checking is unchanged.
