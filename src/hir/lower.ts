/******************************************************************************
 * HIR lowering — AST expressions to the pure expression IR.
 *
 * This is the ONLY module that inspects the grammar's expression node types.
 * Everything downstream (the evaluator, and eventually the plan elabotor)
 * consumes `Hir`, so a grammar change is absorbed here rather than rippling
 * through the interpreter.
 *
 * Lowering is a mechanical, TOTAL translation: every `Expr` the grammar can
 * produce maps to exactly one `Hir` variant, with no evaluation, no
 * environment, and no diagnostics of its own. Errors that depend on context
 * (an unknown identifier, a duplicate key) stay in the evaluator, which has
 * the environment to judge them.
 *
 * Types are deliberately NOT lowered — an annotation keeps its raw AST `Type`
 * node — because types are erased at evaluation time except for two
 * type-DIRECTED cases (a query schema on a bare table, and `mempty`'s monoid
 * instance) that need the original node. See hir.ts.
 *
 * See docs/design/architecture.md stage 4.
 ******************************************************************************/
import type { AstNode } from 'langium';
import {
    isAccessExpression, isApplication, isAscription, isBinaryExpression, isBooleanLiteral,
    isCaseExpression, isIdentifier, isLambda, isLetExpression, isListLiteral, isMapLiteral,
    isNullLiteral, isNumberLiteral, isOperatorSection, isStringLiteral, isUnaryMinus,
    type Expr, type Lambda, type Type, type UnaryExpression,
} from '../language/generated/ast.js';
import { labelName, parseStringLiteral } from '../language/strings.js';
import type { Hir, HirBranch, HirEntry } from './hir.js';

/**
 * Lower one expression. `at` defaults to the node itself; callers pass an
 * explicit node only when they need a diagnostic anchored elsewhere.
 */
export function lower(e: Expr, at: AstNode = e as AstNode): Hir {
    // --- binders -----------------------------------------------------------
    if (isLetExpression(e)) {
        return {
            kind: 'let',
            at: e,
            name: e.name ?? '',
            type: e.type,
            value: lower(e.value as Expr),
            body: lower(e.body as Expr),
        };
    }
    if (isAscription(e)) {
        return { kind: 'ascribe', at: e, operand: lower(e.operand!), type: e.type! };
    }
    if (isLambda(e)) {
        const types: (Type | undefined)[] = [e.param?.type];
        return {
            kind: 'lambda',
            at: e,
            params: [e.param?.name ?? ''],
            paramTypes: types,
            body: lower(e.body as Expr),
        };
    }

    // --- operators ---------------------------------------------------------
    // `UnaryMinus` is a `UnaryExpression`, not an `Expr`, so narrow through
    // a local (the grammar places unary minus above the expression entry).
    const unary = e as UnaryExpression;
    if (isUnaryMinus(unary)) {
        return { kind: 'negate', at: e, operand: lower(unary.operand as unknown as Expr) };
    }
    if (isBinaryExpression(e)) {
        return {
            kind: 'binary',
            at: e,
            op: e.operator,
            left: lower(e.left as Expr),
            right: lower(e.right as Expr),
        };
    }

    // --- application, access, reference ------------------------------------
    if (isApplication(e)) {
        return {
            kind: 'apply',
            at: e,
            func: lower(e.func as unknown as Expr),
            args: (e.arguments as Expr[]).map(a => lower(a)),
        };
    }
    if (isAccessExpression(e)) {
        return {
            kind: 'access',
            at: e,
            receiver: lower(e.receiver as unknown as Expr),
            property: labelName(e.property),
        };
    }
    if (isIdentifier(e)) {
        return { kind: 'ref', at: e, name: e.name };
    }
    if (isOperatorSection(e)) {
        return { kind: 'section', at: e, value: e.value };
    }

    // --- literals ----------------------------------------------------------
    if (isNumberLiteral(e)) return { kind: 'number', at: e, value: e.value };
    // `StringLiteral.value` is the RAW token, quotes and escapes included
    // (`"users"`, `"a\nb"`). Decode it here so HIR holds the VALUE: the
    // evaluator never has to know the lexeme, and the unknown-escape warning
    // stays in one place that sees raw text.
    if (isStringLiteral(e)) return { kind: 'string', at: e, value: parseStringLiteral(e.value) };
    if (isBooleanLiteral(e)) return { kind: 'bool', at: e, value: e.value === 'true' };
    if (isNullLiteral(e)) return { kind: 'null', at: e };

    // --- containers --------------------------------------------------------
    if (isListLiteral(e)) {
        return { kind: 'list', at: e, elements: (e.elements as Expr[]).map(x => lower(x)) };
    }
    if (isMapLiteral(e)) {
        const entries: HirEntry[] = (e.entries as { key: string; value?: Expr; $cstNode?: unknown }[])
            .map(entry => ({
                // `at` stays the ENTRY node: the evaluator anchors duplicate-key
                // and field-punning diagnostics at the entry, not the whole map.
                at: entry as unknown as AstNode,
                key: labelName(entry.key),
                // A punned field (`{ id }`) has no value expression: its
                // meaning comes from the enclosing lambda parameter, which
                // lowering cannot see. Keep it undefined and let the evaluator
                // resolve it (it walks `at.$container` to find the lambda).
                value: entry.value ? lower(entry.value) : undefined,
            }));
        return { kind: 'record', at: e, entries };
    }
    if (isCaseExpression(e)) {
        const branches: HirBranch[] = (e.branches as {
            fallback?: boolean; cond?: Expr; value: Expr; $cstNode?: unknown;
        }[]).map(b => ({
            at: b as unknown as AstNode,
            cond: b.fallback || !b.cond ? undefined : lower(b.cond),
            value: lower(b.value),
        }));
        return {
            kind: 'case',
            at: e,
            subject: e.subject ? lower(e.subject as Expr) : undefined,
            branches,
        };
    }

    // A grammar `Expr` we do not model should be impossible: reachable only if
    // a new expression form is added to the grammar without extending HIR.
    // Fail loudly rather than silently producing a wrong value.
    throw new Error(`hir: unsupported expression node '${(e as AstNode).$type}'`);
}

/** Lower a lambda parameter list, keeping any annotations. */
export function lowerLambda(l: Lambda): Hir {
    return lower(l as unknown as Expr);
}
