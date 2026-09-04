/******************************************************************************
 * The built-in `list.*` namespace — the Haskell base List vocabulary, kept
 * out of the unqualified (relational/SQL) namespace so the two never collide.
 *
 * Pure list operations are ordinary core builtins (`list_map`, `list_fold`,
 * ...) whose public spelling is namespaced: `list.map`, `list.fold`,
 * `list.sum`. This module is the single source of truth for that mapping —
 * both the interpreter (which seeds a `list` module VALUE in every module's
 * environment) and the inferencer (which seeds a `list` namespace of SCHEMES)
 * derive their tables from here, so they can never drift.
 ******************************************************************************/

/**
 * public `list.*` name -> backend builtin name.
 * Every public name is the Haskell base List spelling; the backend keeps an
 * opaque `list_` prefix so it can never collide with a user or query name.
 */
export const LIST_NAMESPACE: Readonly<Record<string, string>> = {
    map: 'list_map',
    filter: 'list_filter',
    fold: 'list_fold',
    foldr: 'list_foldr',
    sum: 'list_sum',
    product: 'list_product',
    length: 'list_length',
    reverse: 'list_reverse',
    concat: 'list_concat',
    append: 'list_append',
    take: 'list_take',
    drop: 'list_drop',
    head: 'list_head',
    last: 'list_last',
    isEmpty: 'list_null',
    elem: 'list_elem',
};