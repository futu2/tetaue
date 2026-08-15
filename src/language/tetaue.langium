/******************************************************************************
 * tetaue — a pure functional SQL query language.
 *
 * Syntax is inspired by moria (https://codeberg.org/mikitori/moria):
 *   - `#` line comments, multi-file modules via `import "path.tetaue"`
 *   - `{ field = value, ... }` maps (table schemas, projections)
 *   - `a => a` lambdas; all functions are curried — a two-argument function
 *     is `l => r => ...` (there is no `(l, r) => ...` form)
 *   - `case { cond => value, ..., _ => value }` — SQL CASE WHEN as a
 *     first-class expression (`_` is the fallback branch; `case`/`_` reserved)
 *   - `let x = e in body` — pure local bindings (`let`/`in` reserved)
 *   - implicit lambdas: a parenthesized expression using $n parameters,
 *     `($1 + 3)` ≡ `u => u + 3`, `($1 + $2)` ≡ `$1 => $2 => $1 + $2`
 *   - builtins live in a prelude of plain identifiers (table, filter, ...)
 * Operators: `&` is the pipeline (`a & f` ⇔ `f a`), `$` is right-associative
 * application (`f $ a` ⇔ `f a`), and `<<<`/`>>>` compose functions point-free.
 * Semantics follow teta (https://github.com/futu2/teta): immutable queries,
 * curried query steps, composed with `&`, rendered to SQL.
 *
 * A module is a list of bindings; the LAST binding is the module's query.
 * Bindings need no terminator. Bare identifiers ARE allowed as application
 * arguments (`filter adult`) — the ARG_ID terminal lexes an identifier only
 * when it is NOT followed by `:` or `=` (with only whitespace between), so an
 * application can never swallow the next binding's name: `filter adult` then
 * `x = 5` or `x: T = ...` always ends the application at `adult`.
 ******************************************************************************/

grammar Tetaue

entry Model:
    (imports+=Import)*
    (bindings+=Binding)*;

// `import "path.tetaue"` brings the module's exported bindings into the
// current scope; `import "path.tetaue" as t` binds only the namespace `t`,
// accessed qualified as `t.users`. A name list `(users, orders)` restricts
// either form to exactly those exports — unlisted names stay invisible.
// (`as` is a reserved word, as is `export`.)
Import:
    'import' path=STRING ('as' alias=(ID | ARG_ID))? ('(' names+=(ID | ARG_ID) (',' names+=(ID | ARG_ID))* ')')?;

// `export` marks a binding as part of the module's public surface: only
// exported bindings are visible to importers (flat or qualified). Within a
// module, exported and private bindings see each other equally.
Binding:
    (export?='export')? name=(ID | ARG_ID) (':' type=Type)? '=' value=Expression;

Expression:
    Ascription | LetExpression | BinaryExpression;

// `let x = e in body` — a pure local binding (no recursion). The value and
// body are ordinary expressions; inside a lambda the dedicated
// LambdaLetExpression keeps `&`/`$` out of the lambda body unless
// parenthesized.
LetExpression:
    {infer LetExpression} 'let' name=(ID | ARG_ID) (':' type=Type)? '=' value=Expression 'in' body=Expression;

// `e : T` — a type annotation on any expression, lowest precedence
// (`a & f : T` is `(a & f) : T`). Annotations are erased at evaluation time.
// NOTE: no `infers Expr` here — a multi-alternative abstract rule whose
// alternatives infer Expr makes Langium emit a mutual `Expr <-> Expression`
// subtype cycle in the reflection.
Ascription:
    {infer Ascription} operand=BinaryExpression ':' type=Type;

// ---------------------------------------------------------------------------
// Type annotations — `name: T = ...`, `(u: T) => ...`, and `e : T`.
//   `t?` is the Maybe-style nullable type. Lowercase variables in record-tail
//   position are ROW variables; everywhere else they are TYPE variables
//   (kind by position, PureScript-style). `->` is right-associative.
//   Unknown names in type position are errors reported by inference.
// ---------------------------------------------------------------------------
Type:
    {infer FunType} left=NullType '->' right=Type
    | NullType;

NullType:
    base=BaseType (nullable?='?')?;

BaseType infers Type:
    RecordType
    | QueryType
    | {infer ListType} '[' type=Type ']'
    | {infer TypeVar} name=(ID | ARG_ID)
    | {infer TypeParen} '(' type=Type ')';

RecordType:
    {infer RecordType} '{' (fields+=RecordField (',' fields+=RecordField)* ','?)? ('|' tail=(ID | ARG_ID))? '}';

QueryType:
    {infer QueryType} 'query' '{' (fields+=RecordField (',' fields+=RecordField)* ','?)? ('|' tail=(ID | ARG_ID))? '}';

RecordField:
    key=(ID | ARG_ID) ':' type=Type;

// Operator precedence, tightest first:
//   >>> <<<  (function composition, PureScript-style, right-assoc)
//   * / %   (multiplicative)
//   + - <>  (additive; `<>` is the record merge monoid, Haskell-style)
//   == != < <= > >=  (comparison, non-chained)
//   &&      (and)
//   ||      (or)
//   &       (pipeline: `a & f` ⇔ `f a`, left-assoc — Haskell-style)
//   $       (application: `f $ a` ⇔ `f a`, right-assoc — Haskell-style)
//
// Composition follows PureScript (`Control.Semigroupoid`): `<<<` is compose
// (right-to-left, like Haskell `.` — `f <<< g` = `x => f (g x)`) and `>>>`
// is its flip. `.` is reserved for record field access (`u.age`).
infix BinaryExpression on UnaryExpression:
    right assoc '>>>' | '<<<'
    > '*' | '/' | '%'
    > '+' | '-' | '<>'
    > '==' | '!=' | '<' | '<=' | '>' | '>='
    > '&&'
    > '||'
    > '&'
    > right assoc '$';

// A lambda body is the same operator chain WITHOUT the `&` (pipeline) and `$`
// (application) levels, which bind loosest: `(l => r => { ... }) & take 3` ends
// the lambda at the record instead of swallowing the next pipeline step. To
// use `&`/`$` inside a lambda body, parenthesize: `u => (u.a & take 1)`.
LambdaBody:
    Ascription | LambdaLetExpression | LambdaBinaryExpression;

LambdaLetExpression:
    {infer LambdaLetExpression} 'let' name=(ID | ARG_ID) (':' type=Type)? '=' value=LambdaBody 'in' body=LambdaBody;

infix LambdaBinaryExpression on UnaryExpression:
    right assoc '>>>' | '<<<'
    > '*' | '/' | '%'
    > '+' | '-' | '<>'
    > '==' | '!=' | '<' | '<=' | '>' | '>='
    > '&&'
    > '||';

UnaryExpression:
    {infer UnaryMinus} '-' operand=UnaryExpression
    | AccessExpression;

AccessExpression infers Expr:
    Application ({infer AccessExpression.receiver=current} '.' property=(ID | ARG_ID))*;

// Juxtaposition application: `filter (u => u.age >= 18)` is filter applied
// to a lambda; `table "users"` is table applied to the table name.
// Arguments are postfix chains (atom + field access) — NOT applications — so
// `f a b` stays a flat, curried application instead of nesting `a (b)`.
// Arguments may be bare identifiers (`filter adult`) because ARG_ID lexes an
// identifier only when it is not followed by `:` or `=`, so an application can
// never swallow the next binding's name.
Application infers Expr:
    {infer Application} func=Atom
    (arguments+=Argument)*;

// Application arguments are literals, containers, lambdas, parenthesized
// expressions, or `u.field` access chains. Lambdas are curried: a
// two-argument function is `(l => r => ...)` — there is no `(l, r) => ...`
// form (use `$1`/`$2` for implicit parameters instead).
Argument infers Expr:
    {infer Lambda} '(' param=LambdaParam ')' '=>' body=LambdaBody
    | Atom ({infer AccessExpression.receiver=current} '.' property=(ID | ARG_ID))+
    | {infer Identifier} name=ARG_ID
    | {infer NumberLiteral} value=NUMBER
    | {infer StringLiteral} value=STRING
    | {infer BooleanLiteral} value=('true' | 'false')
    | {infer NullLiteral} 'null'
    | {infer ListLiteral} '[' (elements+=Expression (',' elements+=Expression)* ','?)? ']'
    | {infer MapLiteral} '{' (entries+=MapEntry (',' entries+=MapEntry)* ','?)? '}'
    | {infer Lambda} param=LambdaParam '=>' body=LambdaBody
    | {infer CaseExpression} 'case' (subject=Expression)? '{' (branches+=CaseBranch (',' branches+=CaseBranch)* ','?)? '}'
    | '(' Expression ')';

Atom infers Expr:
    {infer NumberLiteral} value=NUMBER
    | {infer StringLiteral} value=STRING
    | {infer BooleanLiteral} value=('true' | 'false')
    | {infer NullLiteral} 'null'
    | {infer ListLiteral} '[' (elements+=Expression (',' elements+=Expression)* ','?)? ']'
    | {infer MapLiteral} '{' (entries+=MapEntry (',' entries+=MapEntry)* ','?)? '}'
    | {infer Lambda} param=LambdaParam '=>' body=LambdaBody
    | {infer Lambda} '(' param=LambdaParam ')' '=>' body=LambdaBody
    | {infer CaseExpression} 'case' (subject=Expression)? '{' (branches+=CaseBranch (',' branches+=CaseBranch)* ','?)? '}'
    | Identifier
    | {infer DollarParam} value=LAMBDA_PARAM
    | '(' Expression ')';

Identifier infers Expr:
    {infer Identifier} name=(ID | ARG_ID);

// `case { cond => value, ..., _ => value }` — SQL CASE WHEN as a first-class
// expression. Each branch maps a boolean condition to a value; the final
// branch's condition is the `_` wildcard (a reserved keyword), which becomes
// the ELSE value. The SIMPLE form has a subject before the braces and
// sugar-expands every branch condition into `subject == cond` (SQL
// `CASE subject WHEN value THEN ...`):
//   case u.code { "101" => "one", _ => u.code }
// `case` and `_` are reserved words. (CaseExpression itself is auto-declared
// from the `{infer CaseExpression}` Actions in Atom/Argument, like MapLiteral;
// only CaseBranch is declared here.)
CaseBranch:
    {infer CaseBranch} (fallback?='_' | cond=Expression) '=>' value=Expression;

// A lambda parameter, optionally annotated: `u`, `u: { age: int | r }`,
// `(u: T, v: S) => ...`. (Annotated params are erased at evaluation time.)
LambdaParam:
    name=(ID | ARG_ID) (':' type=Type)?;

MapEntry:
    key=(ID | ARG_ID) '=' value=Expression;

hidden terminal WS: /\s+/;
hidden terminal COMMENT: /#[^\r\n]*/;

// A bare identifier usable as an application argument: any identifier NOT
// followed by `=`. The lookahead keeps bindings comma-free — `filter adult`
// followed by the next binding `x = 5` parses as an application ending at
// `adult` (the next name lexes as plain ID because ` =` follows).
terminal ARG_ID: /(?=([_a-zA-Z][\w_]*))\1(?![ \t\r\n]*[:=])/;
terminal ID: /[_a-zA-Z][\w_]*/;
terminal NUMBER returns number: /[0-9]+(\.[0-9]*)?/;
terminal STRING: /"(\\.|[^"\\])*"/;
// Implicit lambda parameters: `$1` is the first parameter, `$2` the second, ...
// (longest match keeps `$` as the application operator and `$1` as a parameter).
terminal LAMBDA_PARAM: /\$[0-9]+/;
