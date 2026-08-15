/******************************************************************************
 * tetaue builtin catalog — compatibility facade.
 *
 * The real catalog lives in builtin.ts: names, aliases, docs, categories and
 * static type schemes are declared there once. Interpreter and renderer type
 * their builtin tables against the same `BuiltinName` union, so a builtin
 * cannot drift between semantic, type and render layers.
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
