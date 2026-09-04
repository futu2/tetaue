/******************************************************************************
 * Built-in prelude namespaces — Haskell base vocabulary for the pure,
 * in-memory operations that are NOT the hot relational path, kept out of the
 * unqualified (relational/SQL) namespace so the two never collide.
 *
 * Pure operations are ordinary core builtins (`list_map`, `list_fold`,
 * `maybe_isJust`, ...) whose public spelling is namespaced: `list.map`,
 * `list.fold`, `maybe.isJust`. This module is the single source of truth for
 * that mapping — both the interpreter (which seeds a namespace module VALUE
 * in every module's environment) and the inferencer (which seeds a namespace
 * of SCHEMES) derive their tables from here, so they can never drift.
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

/**
 * public `Maybe.*` name -> backend builtin name.
 * The Haskell Data.Maybe vocabulary over nullable SQL expressions. The alias
 * is capitalized `Maybe` (as in Haskell) because lowercase `maybe` is the
 * reserved type keyword and cannot follow a namespace dot. Most members are
 * the existing maybe builtins (`just`, `nothing`, `from_maybe`, `is_null`);
 * `isJust` is a dedicated builtin (`maybe_isJust`) because it is
 * `not (is_null x)` — a composition that needs no new SQL primitive.
 */
export const MAYBE_NAMESPACE: Readonly<Record<string, string>> = {
    just: 'just',
    nothing: 'nothing',
    isJust: 'maybe_isJust',
    isNothing: 'is_null',
    fromMaybe: 'from_maybe',
};

/**
 * The full built-in namespace catalog: alias -> public-name -> backend
 * builtin. Both the interpreter (module values) and the inferencer (schemes)
 * seed every namespace in this table, so adding a namespace here and to the
 * builtin tables makes it available everywhere.
 */
export const PRELUDE_NAMESPACES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
    list: LIST_NAMESPACE,
    Maybe: MAYBE_NAMESPACE,
};
