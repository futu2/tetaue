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
export const STANDARD_PRELUDE_SOURCE = `
# The standard library is intentionally ordinary tetaue code. Keep SQL
# implementation primitives in the TypeScript core and put reusable
# functional definitions here.
export _>>>_ = __op_compose_forward
export _<<<_ = __op_compose_backward
export _*_ = __op_multiply
export _/_ = __op_divide
export _+_ = __op_add
export _-_ = __op_subtract
export _<>_ = __op_merge
export _==_ = __op_equal
export _!=_ = __op_not_equal
export _<_ = __op_less_than
export _<=_ = __op_less_than_or_equal
export _>_ = __op_greater_than
export _>=_ = __op_greater_than_or_equal
export _&&_ = __op_and
export _||_ = __op_or
export _&_ = __op_pipeline
export _$_ = __op_apply

export id = x => x
export const = x => y => x
export compose = f => g => x => f (g x)
export flip = f => x => y => f y x
export pipe = f => g => x => g (f x)

# Derived Maybe helpers belong here rather than in the SQL core.
export is_nothing = is_null
export is_just = x => not (is_null x)
export is_not_null = is_just
`;

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
