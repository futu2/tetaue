/******************************************************************************
 * The standard library, written in tetaue.
 *
 * These definitions deliberately contain no SQL-specific implementation. The
 * TypeScript runtime only supplies the small primitive core; everything here
 * is parsed, inferred, and evaluated through the normal module pipeline.
 ******************************************************************************/
import type { TetaueServices } from './tetaue-module.js';
import type { Model } from './generated/ast.js';
import type { ProjectModule } from './imports.js';

/** Source for the built-in standard library module. */
export const STANDARD_PRELUDE_SOURCE = [
'# The standard library is intentionally ordinary tetaue code. SQL',
'# primitives and scalar types are native builtin names; only reusable',
'# functional definitions live here.',
'',
`
export _>>>_ = f => g => x => g (f x)
export _<<<_ = f => g => x => f (g x)
export _*_ = op_multiply
export _/_ = op_divide
export _+_ = op_add
export _-_ = op_subtract
export _<>_ = op_merge
export _==_ = op_equal
export _!=_ = op_not_equal
export _<_ = op_less_than
export _<=_ = op_less_than_or_equal
export _>_ = op_greater_than
export _>=_ = op_greater_than_or_equal
export _&&_ = op_and
export _||_ = op_or
export _?_ = x => d => from_maybe d x
export _&_ = x => f => f x
export _$_ = f => x => f x
export _<$>_ = fmap
export _<$_ = replaceWith
export _<*>_ = ap
export _<*_ = applyLeft
export _*>_ = applyRight
export _<|>_ = orElse
export _>>=_ = bind
export _>>_ = then

export id = x => x
export const = x => y => x
export compose = f => g => x => f (g x)
export flip = f => x => y => f y x
export pipe = f => g => x => g (f x)

# Derived Maybe helpers belong here rather than in the SQL core.
export is_nothing = is_null
export is_just = x => not (is_null x)
export is_not_null = is_just

# Scalar SQL functions with no per-dialect variance are ordinary prelude
# definitions over the sql_func primitive, not core builtins. The precise
# annotation keeps their type exact (length is int, not a fresh variable).
# The public spellings are Haskell-flavored (toUpper/toLower); the SQL-named
# exports remain as aliases for compatibility.
export toUpper: string -> string = x => (sql_func) "UPPER" [x]
export toLower: string -> string = x => (sql_func) "LOWER" [x]
export length: string -> int = x => (sql_func) "LENGTH" [x]
export trim: string -> string = x => (sql_func) "TRIM" [x]

# SQL-named aliases, kept for compatibility with existing code.
export upper = toUpper
export lower = toLower

# position varies per dialect in BOTH the function name and the argument
# order, so its lowering branches on the hidden sql_dialect value. The
# argument-reordered form (POSITION(needle IN value)) is expressed with the
# sql_infix primitive.
export position: string -> string -> int = x => n => case sql_dialect.name {
    "postgresql" => (sql_func) "POSITION" [(sql_infix) "IN" n x],
    "trino"      => (sql_func) "POSITION" [(sql_infix) "IN" n x],
    "mysql"      => (sql_func) "LOCATE" [n, x],
    _            => (sql_func) "INSTR" [x, n],
}
`.trimStart(),
].join('\n');

// A service container owns the parser/value-converter configuration used to
// construct AST nodes. Cache only within that container so callers can safely
// create independent language instances in tests, embedded tools, or workers.
const preludeCache = new WeakMap<object, ProjectModule>();

/** Parse the embedded standard library using the caller's language services. */
export function standardPrelude(services: TetaueServices): ProjectModule {
    const cached = preludeCache.get(services);
    if (cached) return cached;

    const result = services.parser.LangiumParser.parse(STANDARD_PRELUDE_SOURCE);
    const parseErrors = [
        ...result.lexerErrors.map(e => e.message),
        ...result.parserErrors.map(e => e.message),
    ];
    if (!result.value || parseErrors.length > 0) {
        throw new Error(`invalid embedded prelude: ${parseErrors.join('; ') || 'no parse result'}`);
    }
    const prelude = {
        model: result.value as Model,
        uri: 'tetaue:prelude',
        imports: [],
    };
    preludeCache.set(services, prelude);
    return prelude;
}

/** Public names supplied by the source prelude rather than the primitive core. */
export function standardPreludeNames(services: TetaueServices): readonly string[] {
    return standardPrelude(services).model.bindings
        .filter(binding => binding.export)
        .map(binding => binding.name);
}
