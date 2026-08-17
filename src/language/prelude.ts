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
import { BUILTIN_NAMES, CORE_TYPE_NAMES } from './builtin.js';

/** Source for the built-in standard library module. */
export const STANDARD_PRELUDE_SOURCE = [
'# The public language surface is ordinary source; only @ names are core.',
'# Scalar types are aliases for the reserved core type namespace.',
...CORE_TYPE_NAMES.map(name => `export type ${name} = @${name}`),
'',
'# Public SQL functions are ordinary aliases of the reserved core namespace.',
...BUILTIN_NAMES.map(name => `export ${name} = @${name}`),
'',
`
# The standard library is intentionally ordinary tetaue code. Keep SQL
# implementation primitives in the TypeScript core and put reusable
# functional definitions here.
export _>>>_ = f => g => x => g (f x)
export _<<<_ = f => g => x => f (g x)
export _*_ = @op_multiply
export _/_ = @op_divide
export _+_ = @op_add
export _-_ = @op_subtract
export _<>_ = @op_merge
export _==_ = @op_equal
export _!=_ = @op_not_equal
export _<_ = @op_less_than
export _<=_ = @op_less_than_or_equal
export _>_ = @op_greater_than
export _>=_ = @op_greater_than_or_equal
export _&&_ = @op_and
export _||_ = @op_or
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
`.trimStart(),
].join('\n');

/** Parse the embedded standard library using the caller's language services. */
export function standardPrelude(services: TetaueServices): ProjectModule {
    const result = services.parser.LangiumParser.parse(STANDARD_PRELUDE_SOURCE);
    const parseErrors = [
        ...result.lexerErrors.map(e => e.message),
        ...result.parserErrors.map(e => e.message),
    ];
    if (!result.value || parseErrors.length > 0) {
        throw new Error(`invalid embedded prelude: ${parseErrors.join('; ') || 'no parse result'}`);
    }
    return {
        model: result.value as Model,
        uri: 'tetaue:prelude',
        imports: [],
    };
}

/** Public names supplied by the source prelude rather than the primitive core. */
export function standardPreludeNames(services: TetaueServices): readonly string[] {
    return standardPrelude(services).model.bindings
        .filter(binding => binding.export)
        .map(binding => binding.name);
}

/** Public type names supplied by the source prelude. */
export function standardPreludeTypeNames(services: TetaueServices): readonly string[] {
    return standardPrelude(services).model.types
        .filter(alias => alias.export)
        .map(alias => alias.name);
}
