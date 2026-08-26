/******************************************************************************
 * tetaue definition provider — go-to-definition for the module system.
 *
 *   `import "acme/tables"`      → the resolved file
 *   `t.users` (qualified access)→ the exported binding in the lib
 *   `users` (bare identifier)   → the binding in the same module
 *
 * The grammar has no Langium cross-references (imports are strings), so this
 * resolves manually against the same module tree the validator uses, keeping
 * the editor in agreement with `tetaue check`/`render`.
 ******************************************************************************/
import { CstUtils, type AstNode, type LangiumDocument } from 'langium';
import type { DefinitionProvider } from 'langium/lsp';
import { type LocationLink, type DefinitionParams, type Range } from 'vscode-languageserver';
import {
    isAccessExpression, isIdentifier, isImport,
} from '../generated/ast.js';
import type { Import, Model } from '../generated/ast.js';
import { treeFor } from './document-analysis.js';
import { parseStringLiteral } from '../interpreter.js';
import { resolveImport } from '../resolve.js';
import { moduleOf } from '../imports.js';
import type { TetaueServices } from '../tetaue-module.js';
import { moduleQualifiedBinding } from './module-access.js';

export class TetaueDefinitionProvider implements DefinitionProvider {
    constructor(private readonly services: TetaueServices) {}

    getDefinition(document: LangiumDocument, params: DefinitionParams): LocationLink[] | undefined {
        const model = document.parseResult.value as Model | undefined;
        if (!model?.$cstNode) return undefined;
        const offset = document.textDocument.offsetAt(params.position);
        const leaf = CstUtils.findLeafNodeAtOffset(model.$cstNode, offset);
        const node = leaf?.astNode;
        if (!node) return undefined;

        const { modules, importsByModule, exportsByModule } = treeFor(model, document.uri.toString(), this.services);

        // 1. `import "path"` (clicked on the keyword or the string).
        const imp = importOf(node);
        if (imp) {
            const resolved = resolveImport(document.uri.toString(), parseStringLiteral(imp.path));
            return resolved.uri ? [link(resolved.uri, RangeZero)] : undefined;
        }

        // 2. `t.binding` — the export in the lib.
        if (isAccessExpression(node)) {
            const binding = moduleQualifiedBinding(node, modules, importsByModule, { exportsByModule });
            if (binding) return [linkOf(binding, moduleOf(binding, modules)?.uri)!];
            return undefined;
        }

        // 3. A bare identifier naming a namespace alias — the lib's entry file.
        if (isIdentifier(node)) {
            const alias = node.name;
            const root = modules[modules.length - 1];
            const edge = (root ? importsByModule.get(root) ?? root.imports ?? [] : []).find(imp => imp.alias === alias);
            if (edge?.target.uri) return [link(edge.target.uri, RangeZero)];

            // 4. Otherwise the binding in the same module.
            const binding = model.bindings.find(b => b.name === alias);
            if (binding) return [linkOf(binding, document.uri.toString())!];
            return undefined;
        }
        return undefined;
    }
}

function importOf(node: AstNode): Import | undefined {
    if (isImport(node)) return node;
    // The STRING terminal's astNode is the Import, but be safe for
    // intermediate nodes.
    let cur: AstNode | undefined = node;
    while (cur) {
        if (isImport(cur)) return cur;
        cur = cur.$container;
    }
    return undefined;
}

function link(uri: string, range: Range): LocationLink {
    return { targetUri: uri, targetRange: range, targetSelectionRange: range };
}

function linkOf(binding: { $cstNode?: { range: Range } } | undefined, uri: string | undefined): LocationLink | undefined {
    if (!binding?.$cstNode || !uri) return undefined;
    return link(uri, binding.$cstNode.range);
}

const RangeZero: Range = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
