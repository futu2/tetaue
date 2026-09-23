/******************************************************************************
 * tetaue HIR — the pure expression language.
 *
 * A small, typed intermediate representation between the Langium AST and the
 * evaluator. It exists so that the EVALUATOR never walks generated AST nodes:
 * `lower()` (hir/lower.ts) is the only module that knows the grammar's node
 * types for expressions, and everything downstream consumes these shapes.
 *
 * The variants mirror exactly what the evaluator must dispatch on — no more,
 * no less — so lowering is a mechanical translation rather than a design
 * decision:
 *
 *   Let      `let x = e in body`
 *   Ascribe  `e : T`
 *   Negate   unary `-`
 *   Binary   `l OP r` (the operator is kept as its source spelling)
 *   Access   `recv.field`
 *   Apply    `f a b ...` (curried; arguments are postfix chains)
 *   Literals number / string / bool / null
 *   Case     `case [subject] { cond => value, ..., _ => fallback }`
 *   List     `[a, b, c]`
 *   Record   `{ k = v, ... }` and update sugar `{ recv | k = v }`
 *   Lambda   `p => body` with an optional parameter annotation
 *   Section  an Agda-style `_op_` operator section
 *   Ref      a bare identifier
 *
 * Two deliberate omissions, both because the evaluator resolves them later:
 *
 *  - TYPE annotations are NOT lowered. `Ascribe` and `Lambda.paramType` keep
 *    the raw AST `Type` node, because types are erased at evaluation time
 *    except for two type-DIRECTED cases (a query schema on a bare table, and
 *    `mempty`'s monoid instance) which need the original node.
 *  - `at` carries the source AST node for diagnostics, so an error can still
 *    point at the user's code.
 *
 * See docs/design/architecture.md stage 4.
 ******************************************************************************/
import type { AstNode } from 'langium';
import type { Type } from '../language/generated/ast.js';

/** A source span for diagnostics: the AST node the HIR node came from. */
export interface HirBase {
    readonly at: AstNode;
}

/** A record field or case branch label: a plain, already-decoded key. */
export interface HirEntry extends HirBase {
    readonly key: string;
    /**
     * The entry's value expression. Undefined for a PUNNED field (`{ id }`),
     * whose meaning depends on the enclosing lambda parameter. Lowering cannot
     * resolve that (it has no environment), so it stays the evaluator's job —
     * and `at` is the MapEntry node, which is what lets the evaluator walk
     * `$container` to find that parameter.
     */
    readonly value: Hir | undefined;
}

export interface HirBranch extends HirBase {
    /** The branch condition; undefined for the `_` fallback branch. */
    readonly cond: Hir | undefined;
    readonly value: Hir;
}

export type Hir =
    | HirLet
    | HirAscribe
    | HirNegate
    | HirBinary
    | HirAccess
    | HirApply
    | HirNumber
    | HirString
    | HirBool
    | HirNull
    | HirCase
    | HirList
    | HirRecord
    | HirLambda
    | HirSection
    | HirRef;

export interface HirLet extends HirBase {
    readonly kind: 'let';
    readonly name: string;
    /** The `let x: T` annotation, when present (type-directed cases only). */
    readonly type: Type | undefined;
    readonly value: Hir;
    readonly body: Hir;
}

export interface HirAscribe extends HirBase {
    readonly kind: 'ascribe';
    readonly operand: Hir;
    /** The annotation. Erased at evaluation except for query schemas. */
    readonly type: Type;
}

export interface HirNegate extends HirBase {
    readonly kind: 'negate';
    readonly operand: Hir;
}

export interface HirBinary extends HirBase {
    readonly kind: 'binary';
    /** The operator as written (`+`, `&`, `>>>`, ...). */
    readonly op: string;
    readonly left: Hir;
    readonly right: Hir;
}

export interface HirAccess extends HirBase {
    readonly kind: 'access';
    readonly receiver: Hir;
    readonly property: string;
}

export interface HirApply extends HirBase {
    readonly kind: 'apply';
    readonly func: Hir;
    readonly args: readonly Hir[];
}

export interface HirNumber extends HirBase {
    readonly kind: 'number';
    readonly value: number;
}

export interface HirString extends HirBase {
    readonly kind: 'string';
    readonly value: string;
}

export interface HirBool extends HirBase {
    readonly kind: 'bool';
    readonly value: boolean;
}

export interface HirNull extends HirBase {
    readonly kind: 'null';
}

export interface HirCase extends HirBase {
    readonly kind: 'case';
    /** The simple-form subject (`case x { ... }`), when present. */
    readonly subject: Hir | undefined;
    readonly branches: readonly HirBranch[];
}

export interface HirList extends HirBase {
    readonly kind: 'list';
    readonly elements: readonly Hir[];
}

export interface HirRecord extends HirBase {
    readonly kind: 'record';
    readonly entries: readonly HirEntry[];
}

export interface HirLambda extends HirBase {
    readonly kind: 'lambda';
    readonly params: readonly string[];
    /** Per-parameter annotations, aligned with `params` (undefined when absent). */
    readonly paramTypes: readonly (Type | undefined)[];
    readonly body: Hir;
}

export interface HirSection extends HirBase {
    readonly kind: 'section';
    /** The `_op_` spelling as written. */
    readonly value: string;
}

export interface HirRef extends HirBase {
    readonly kind: 'ref';
    readonly name: string;
}
