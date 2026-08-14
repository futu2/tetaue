/******************************************************************************
 * tetaue semantic token provider — grammar-aware syntax highlighting.
 *
 * The static TextMate grammar (extension/syntaxes/tetaue.tmLanguage.json)
 * only knows regular expressions, so it cannot tell `filter` the prelude
 * builtin from `filter` a user binding, `u` a lambda parameter from `u` a
 * module-qualified receiver, or a type name from an expression. This provider
 * runs on the parsed AST and classifies every token precisely:
 *
 *   keyword    import / export / as / query, true, false, null
 *   type       type-variable names in annotations (`int`, `string`, `r`)
 *   function   prelude builtins (defaultLibrary modifier), lambda bindings,
 *              and references to them
 *   variable   data bindings, ordinary references, namespace aliases
 *   parameter  lambda parameters (declaration modifier) and `$n` implicit
 *              parameters
 *   property   record field access (`u.age`) and record/map keys
 *   number     numeric literals
 *   string     string literals
 *   operator   infix/prefix operators, `=>`, `:`, `=`, `.`, `?`, `->`
 ******************************************************************************/
import type { AstNode } from 'langium';
import { GrammarUtils } from 'langium';
import { AbstractSemanticTokenProvider, type SemanticTokenAcceptor } from 'langium/lsp';
import { BUILTINS } from '../interpreter.js';
import type { TetaueServices } from '../tetaue-module.js';
import {
    isAccessExpression, isApplication, isAscription, isBinaryExpression, isBinding, isBooleanLiteral,
    isCaseBranch, isCaseExpression, isDollarParam, isFunType, isIdentifier, isImport, isLambda, isLambdaBinaryExpression,
    isLambdaParam, isMapEntry, isNullLiteral, isNullType, isNumberLiteral, isQueryType,
    isRecordField, isStringLiteral, isTypeVar, isUnaryMinus,
} from '../generated/ast.js';
import type { Model } from '../generated/ast.js';

const BUILTIN_NAMES = new Set(Object.keys(BUILTINS));

export class TetaueSemanticTokenProvider extends AbstractSemanticTokenProvider {
    constructor(services: TetaueServices) {
        super(services);
    }

    protected highlightElement(node: AstNode, acceptor: SemanticTokenAcceptor): void {
        // --- module structure -------------------------------------------------
        if (isImport(node)) {
            acceptor({ node, keyword: 'import', type: 'keyword' });
            acceptor({ node, keyword: 'as', type: 'keyword' });
            if (node.alias) {
                // `import "x.tetaue" as t` — `t` is a namespace.
                acceptor({ node, property: 'alias', type: 'namespace' });
            }
            return;
        }
        if (isBinding(node)) {
            acceptor({ node, keyword: 'export', type: 'keyword' });
            acceptor({ node, keyword: ':', type: 'operator' });
            acceptor({ node, keyword: '=', type: 'operator' });
            const type = isLambdaValue(node.value) ? 'function' : 'variable';
            acceptor({ node, property: 'name', type, modifier: 'declaration' });
            return;
        }

        // --- types ------------------------------------------------------------
        if (isTypeVar(node)) {
            acceptor({ node, property: 'name', type: 'type' });
            return;
        }
        if (isRecordField(node)) {
            acceptor({ node, keyword: ':', type: 'operator' });
            acceptor({ node, property: 'key', type: 'property' });
            return;
        }
        if (isQueryType(node)) {
            acceptor({ node, keyword: 'query', type: 'keyword' });
            return;
        }
        if (isFunType(node)) {
            acceptor({ node, keyword: '->', type: 'operator' });
            return;
        }
        if (isNullType(node)) {
            acceptor({ node, keyword: '?', type: 'operator' });
            return;
        }

        // --- literals ---------------------------------------------------------
        if (isNumberLiteral(node)) {
            acceptor({ node, property: 'value', type: 'number' });
            return;
        }
        if (isStringLiteral(node)) {
            acceptor({ node, property: 'value', type: 'string' });
            return;
        }
        if (isBooleanLiteral(node)) {
            acceptor({ node, keyword: node.value, type: 'keyword' });
            return;
        }
        if (isNullLiteral(node)) {
            acceptor({ node, keyword: 'null', type: 'keyword' });
            return;
        }
        if (isDollarParam(node)) {
            acceptor({ node, property: 'value', type: 'parameter' });
            return;
        }

        // --- lambdas ----------------------------------------------------------
        if (isLambda(node)) {
            acceptor({ node, keyword: '=>', type: 'operator' });
            return;
        }
        if (isLambdaParam(node)) {
            acceptor({ node, keyword: ':', type: 'operator' });
            acceptor({ node, property: 'name', type: 'parameter', modifier: 'declaration' });
            return;
        }

        // --- expressions ------------------------------------------------------
        if (isAscription(node)) {
            acceptor({ node, keyword: ':', type: 'operator' });
            return;
        }
        if (isUnaryMinus(node)) {
            acceptor({ node, keyword: '-', type: 'operator' });
            return;
        }
        if (isBinaryExpression(node) || isLambdaBinaryExpression(node)) {
            // Infix rules store their operator keywords under the CST
            // assignment feature `operators`, not the AST property
            // `operator` (the generic acceptor only knows typed properties).
            for (const cst of GrammarUtils.findNodesForProperty(node.$cstNode, 'operators')) {
                acceptor({ cst, type: 'operator' });
            }
            return;
        }
        if (isAccessExpression(node)) {
            acceptor({ node, keyword: '.', type: 'operator' });
            acceptor({ node, property: 'property', type: 'property' });
            return;
        }
        if (isMapEntry(node)) {
            acceptor({ node, keyword: '=', type: 'operator' });
            acceptor({ node, property: 'key', type: 'property' });
            return;
        }
        if (isCaseExpression(node)) {
            acceptor({ node, keyword: 'case', type: 'keyword' });
            return;
        }
        if (isCaseBranch(node)) {
            if (node.fallback) acceptor({ node, keyword: '_', type: 'keyword' });
            acceptor({ node, keyword: '=>', type: 'operator' });
            return;
        }

        // --- references -------------------------------------------------------
        if (isIdentifier(node)) {
            const { type, modifier } = this.referenceType(node, node.name);
            if (modifier) {
                acceptor({ node, property: 'name', type, modifier });
            } else {
                acceptor({ node, property: 'name', type });
            }
        }
    }

    /**
     * Classify a bare identifier use. Resolution is document-local, innermost
     * scope first: an enclosing lambda parameter, then a same-module binding,
     * then an import alias, then the prelude. Prelude builtins are `function`
     * with the `defaultLibrary` modifier; bindings whose value is a lambda are
     * `function`, everything else `variable`.
     */
    private referenceType(node: AstNode, name: string): { type: string; modifier?: string } {
        if (this.enclosingLambdaParam(node, name)) {
            return { type: 'parameter' };
        }
        const root = this.currentDocument?.parseResult.value as Model | undefined;
        if (root) {
            // Later bindings shadow earlier ones (the runtime's rule); a name
            // names the LAST binding that declares it.
            for (let i = root.bindings.length - 1; i >= 0; i--) {
                const binding = root.bindings[i]!;
                if (binding.name === name) {
                    return isLambdaValue(binding.value) ? { type: 'function' } : { type: 'variable' };
                }
            }
            if (root.imports.some(imp => imp.alias === name)) {
                return { type: 'namespace' };
            }
        }
        if (BUILTIN_NAMES.has(name)) {
            return { type: 'function', modifier: 'defaultLibrary' };
        }
        return { type: 'variable' };
    }

    /**
     * Walk up from an identifier use to the nearest lambda that declares
     * `name` as a parameter (shadowing outer bindings like the runtime), or
     * undefined when no enclosing lambda has it.
     */
    private enclosingLambdaParam(node: AstNode, name: string): boolean {
        let cur: AstNode | undefined = node;
        while (cur && !isModel(cur)) {
            if (isLambda(cur)) {
                if (cur.param && cur.param.name === name) return true;
            }
            cur = cur.$container;
        }
        return false;
    }
}

function isModel(node: AstNode): node is Model {
    return node.$type === 'Model';
}

/**
 * A binding is a function when its value is a lambda. A bare lambda value
 * parses as `Application(Lambda, [])` (the grammar's `Application` accepts
 * zero arguments), so unwrap that one case.
 */
function isLambdaValue(expr: AstNode): boolean {
    return isLambda(expr) || (isApplication(expr) && expr.arguments.length === 0 && isLambda(expr.func));
}
