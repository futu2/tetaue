/******************************************************************************
 * tetaue — a pure functional SQL query language.
 *
 * Syntax is inspired by moria (https://codeberg.org/mikitori/moria):
 *   - `#` line comments, multi-file modules via `import "path.tetaue"`
 *   - `{ field = value, ... }` maps (table schemas, projections, join specs)
 *   - `a => a` lambdas, `(l, r) => ...` multi-param lambdas
 *   - builtins live in a prelude of plain identifiers (table, filter, ...)
 * Operators follow Haskell: `&` is the pipeline (`a & f` ⇔ `f a`), `$` is
 * right-associative application (`f $ a` ⇔ `f a`).
 * Semantics follow teta (https://github.com/futu2/teta): immutable queries,
 * curried query steps, composed with `&`, rendered to SQL.
 *
 * A module is a list of bindings; the LAST binding is the module's query.
 * Bindings need no terminator: application arguments may not be bare
 * identifiers (use `u.field` access chains or parentheses), so the parser
 * always knows where one binding ends and the next begins.
 ******************************************************************************/

grammar Tetaue

entry Model:
    (imports+=Import)*
    (bindings+=Binding)*;

Import:
    'import' path=STRING;

Binding:
    name=ID '=' value=Expression;

Expression:
    BinaryExpression;

// Operator precedence, tightest first:
//   * / %   (multiplicative)
//   + -     (additive)
//   == != < <= > >=  (comparison, non-chained)
//   &&      (and)
//   ||      (or)
//   &       (pipeline: `a & f` ⇔ `f a`, left-assoc — Haskell-style)
//   $       (application: `f $ a` ⇔ `f a`, right-assoc — Haskell-style)
infix BinaryExpression on UnaryExpression:
    '*' | '/' | '%'
    > '+' | '-'
    > '==' | '!=' | '<' | '<=' | '>' | '>='
    > '&&'
    > '||'
    > '&'
    > right assoc '$';

UnaryExpression:
    {infer UnaryMinus} '-' operand=UnaryExpression
    | AccessExpression;

AccessExpression infers Expr:
    Application ({infer AccessExpression.receiver=current} '.' property=ID)*;

// Juxtaposition application: `filter (u => u.age >= 18)` is filter applied
// to a lambda; `table "users" { ... }` is table applied to two arguments.
// Arguments are postfix chains (atom + field access) — NOT applications — so
// `f a b` stays a flat, curried application instead of nesting `a (b)`.
Application infers Expr:
    {infer Application} func=Atom (arguments+=Argument)*;

// Application arguments may be literals, containers, lambdas, parenthesized
// expressions, or `u.field` access chains — but NOT bare identifiers.
// A bare identifier after an application would be ambiguous with the start of
// the next binding (bindings need no terminator), so bare values must be
// parenthesized: f (g).
Argument infers Expr:
    Atom ({infer AccessExpression.receiver=current} '.' property=ID)+
    | {infer NumberLiteral} value=NUMBER
    | {infer StringLiteral} value=STRING
    | {infer BooleanLiteral} value=('true' | 'false')
    | {infer NullLiteral} 'null'
    | {infer ListLiteral} '[' (elements+=Expression (',' elements+=Expression)* ','?)? ']'
    | {infer MapLiteral} '{' (entries+=MapEntry (',' entries+=MapEntry)* ','?)? '}'
    // single-param lambda: `u => ...`; multi-param requires parens: `(l, r) => ...`
    | {infer Lambda} param=ID '=>' body=Expression
    | {infer Lambda} '(' params+=ID (',' params+=ID)+ ')' '=>' body=Expression
    | '(' Expression ')';

Atom infers Expr:
    {infer NumberLiteral} value=NUMBER
    | {infer StringLiteral} value=STRING
    | {infer BooleanLiteral} value=('true' | 'false')
    | {infer NullLiteral} 'null'
    | {infer ListLiteral} '[' (elements+=Expression (',' elements+=Expression)* ','?)? ']'
    | {infer MapLiteral} '{' (entries+=MapEntry (',' entries+=MapEntry)* ','?)? '}'
    | {infer Lambda} param=ID '=>' body=Expression
    | {infer Lambda} '(' params+=ID (',' params+=ID)+ ')' '=>' body=Expression
    | {infer Identifier} name=ID
    | '(' Expression ')';

MapEntry:
    key=ID '=' value=Expression;

hidden terminal WS: /\s+/;
hidden terminal COMMENT: /#[^\r\n]*/;

terminal ID: /[_a-zA-Z][\w_]*/;
terminal NUMBER returns number: /[0-9]+(\.[0-9]*)?/;
terminal STRING: /"(\\.|[^"\\])*"/;
