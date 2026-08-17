/******************************************************************************
 * tetaue primitive builtin catalog — compatibility facade.
 *
 * The core catalog lives in builtin.ts: primitive names, aliases, docs,
 * categories and static type schemes are declared there once. Source-prelude
 * definitions intentionally sit outside this facade.
 ******************************************************************************/
export {
    type BuiltinAliasName,
    type BuiltinCategory,
    type BuiltinName,
    type BuiltinSpec,
    type BuiltinSpecName,
    BUILTIN_ALIASES,
    BUILTIN_NAMES,
    BUILTIN_SPECS,
} from './builtin.js';
