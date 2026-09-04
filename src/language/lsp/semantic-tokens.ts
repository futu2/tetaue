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
 *   parameter  lambda parameters (declaration modifier) and `this`/`that`
 *              implicit parameters
 *   property   record field access (`u.age`) and record/map keys
 *   number     numeric literals
 *   string     string literals
 *   operator   infix/prefix operators, `=>`, `:`, `=`, `.`, `?`, `->`
 ******************************************************************************/
import type { AstNode } from 'langium';
import { GrammarUtils } from 'langium';
import { AbstractSemanticTokenProvider, type SemanticTokenAcceptor } from 'langium/lsp';
import { BUILTIN_NAMES } from '../builtin.js';
import { standardPreludeNames } from '../prelude.js';
import type { TetaueServices } from '../tetaue-module.js';
import {
    isAccessExpression, isApplication, isAscription, isBinaryExpression, isBinding, isBooleanLiteral,
    isCaseBranch, isCaseExpression, isFunType, isIdentifier, isImport, isLambda,
    isLambdaParam, isMapEntry, isNullLiteral, isNumberLiteral, isOperatorSection, isQueryType,
    isRecordField, isStringLiteral, isTypeAtom, isTypeHole, isTypeVar, isUnaryMinus,
} from '../generated/ast.js';
import type { Model } from '../generated/ast.js';
import { implicitParamName } from '../strings.js';

export class TetaueSemanticTokenProvider extends AbstractSemanticTokenProvider {
    private readonly standardNames: ReadonlySet<string>;

    constructor(services: TetaueServices) {
        super(services);
        this.standardNames = new Set([...BUILTIN_NAMES, ...standardPreludeNames(services)]);
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
            const type = node.value && isLambdaValue(node.value) ? 'function' : 'variable';
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
        if (isTypeAtom(node) && node.maybeType) {
            acceptor({ node, keyword: 'maybe', type: 'keyword' });
            return;
        }
        if (isTypeHole(node)) {
            acceptor({ node, property: 'name', type: 'type', modifier: 'declaration' });
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
        if (isOperatorSection(node)) {
            acceptor({ node, property: 'value', type: 'operator' });
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
        if (isBinaryExpression(node)) {
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
            const { type, modifier, resolved } = this.referenceType(node, node.name);
            // `this`/`that` sugar: an unresolvable occurrence is an implicit
            // lambda parameter (the first/second row binding).
            const final = !resolved && implicitParamName(node.name) ? 'parameter' : type;
            if (modifier) {
                acceptor({ node, property: 'name', type: final, modifier });
            } else {
                acceptor({ node, property: 'name', type: final });
            }
        }
    }

    /**
     * Classify a bare identifier use. Resolution is document-local, innermost
     * scope first: an enclosing lambda parameter, then a same-module binding,
     * then an import alias, then the prelude. Prelude builtins are `function`
     * with the `defaultLibrary` modifier; bindings whose value is a lambda are
     * `function`, everything else `variable`. `resolved` is false only for the
     * unresolvable fallback (unknown names and `this`/`that` sugar).
     */
    private referenceType(node: AstNode, name: string): { type: string; modifier?: string; resolved: boolean } {
        if (this.enclosingLambdaParam(node, name)) {
            return { type: 'parameter', resolved: true };
        }
        const root = this.currentDocument?.parseResult.value as Model | undefined;
        if (root) {
            // Later bindings shadow earlier ones (the runtime's rule); a name
            // names the LAST binding that declares it.
            for (let i = root.bindings.length - 1; i >= 0; i--) {
                const binding = root.bindings[i]!;
                if (binding.name === name) {
                    return binding.value && isLambdaValue(binding.value) ? { type: 'function', resolved: true } : { type: 'variable', resolved: true };
                }
            }
            if (root.imports.some(imp => imp.alias === name)) {
                return { type: 'namespace', resolved: true };
            }
        }
        if (this.standardNames.has(name)) {
            return { type: 'function', modifier: 'defaultLibrary', resolved: true };
        }
        return { type: 'variable', resolved: false };
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
