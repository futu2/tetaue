/******************************************************************************
 * tetaue — a pure functional SQL query language.
 *
 * Syntax is inspired by moria (https://codeberg.org/mikitori/moria):
 *   - `#` line comments, files are modules ending in an expression
 *   - `{ field = value, ... }` maps (table schemas, projections, join specs)
 *   - `a => a` lambdas, `(l, r) => ...` multi-param lambdas
 *   - `@`-prefixed builtins (@table, @filter, @map, ...)
 * Semantics follow teta (https://github.com/futu2/teta): immutable queries,
 * curried query steps, composed with the `|>` pipe operator, rendered to SQL.
 ******************************************************************************/

grammar Tetaue

entry Model:
    (bindings+=Binding)*
    query=Expression;

// Top-level bindings are comma-terminated (moria map style) so that the
// expression parser knows where one binding ends and the next begins —
// juxtaposition application would otherwise swallow the next binding's name.
Binding:
    name=ID '=' value=Expression ',';

Expression:
    BinaryExpression;

// Operator precedence, tightest first:
//   * / %   (multiplicative)
//   + -     (additive)
//   == != < <= > >=  (comparison, non-chained)
//   &&      (and)
//   ||      (or)
//   |>      (pipe — loosest)
infix BinaryExpression on UnaryExpression:
    '*' | '/' | '%'
    > '+' | '-'
    > '==' | '!=' | '<' | '<=' | '>' | '>='
    > '&&'
    > '||'
    > '|>';

UnaryExpression:
    {infer UnaryMinus} '-' operand=UnaryExpression
    | AccessExpression;

AccessExpression infers Expr:
    Application ({infer AccessExpression.receiver=current} '.' property=ID)*;

// Juxtaposition application: `@filter (u => u.age >= 18)` is @filter applied
// to a lambda; `@table "users" { ... }` is @table applied to two arguments.
// Arguments are postfix chains (atom + field access) — NOT applications — so
// `f a b` stays a flat, curried application instead of nesting `a (b)`.
Application infers Expr:
    {infer Application} func=Atom (arguments+=Argument)*;

Argument infers Expr:
    Atom ({infer AccessExpression.receiver=current} '.' property=ID)*;

Atom infers Expr:
    {infer NumberLiteral} value=NUMBER
    | {infer StringLiteral} value=STRING
    | {infer BooleanLiteral} value=('true' | 'false')
    | {infer NullLiteral} '@null'
    | {infer ListLiteral} '[' (elements+=Expression (',' elements+=Expression)* ','?)? ']'
    | {infer MapLiteral} '{' (entries+=MapEntry (',' entries+=MapEntry)* ','?)? '}'
    // single-param lambda: `u => ...`; multi-param requires parens: `(l, r) => ...`
    | {infer Lambda} param=ID '=>' body=Expression
    | {infer Lambda} '(' params+=ID (',' params+=ID)+ ')' '=>' body=Expression
    | {infer BuiltinCall} '@' name=ID
    | {infer Identifier} name=ID
    | '(' Expression ')';

MapEntry:
    key=ID '=' value=Expression;

hidden terminal WS: /\s+/;
hidden terminal COMMENT: /#[^\r\n]*/;

terminal ID: /[_a-zA-Z][\w_]*/;
terminal NUMBER returns number: /[0-9]+(\.[0-9]*)?/;
terminal STRING: /"(\\.|[^"\\])*"/;
