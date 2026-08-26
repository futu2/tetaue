/******************************************************************************
 * tetaue hover provider.
 *
 * Shows the static type of the expression under the cursor (from the same
 * inference pass that powers `check`), plus the `#` doc-comment block of the
 * binding the node belongs to — or of the binding a bare identifier refers to
 * (`filter (adult)` hovers the doc written above `adult = ...`).
 ******************************************************************************/
import { CstUtils, URI, type AstNode, type LangiumDocument } from 'langium';
import { readFileSync } from 'node:fs';
import type { HoverProvider } from 'langium/lsp';
import { Hover, HoverParams, MarkupKind } from 'vscode-languageserver';
import type { TetaueServices } from '../tetaue-module.js';
import { checkedProjectForDocument } from './document-analysis.js';
import { moduleOf } from '../imports.js';
import type { ProjectModule } from '../imports.js';
import { isAccessExpression, isBinding, isIdentifier } from '../generated/ast.js';
import type { Binding, Model } from '../generated/ast.js';
import { moduleQualifiedBinding } from './module-access.js';
import { labelName } from '../strings.js';

export class TetaueHoverProvider implements HoverProvider {
    constructor(private readonly services: TetaueServices) {}

    getHoverContent(document: LangiumDocument, params: HoverParams): Hover | undefined {
        const model = document.parseResult.value as Model | undefined;
        if (!model?.$cstNode) return undefined;
        const offset = document.textDocument.offsetAt(params.position);
        const leaf = CstUtils.findLeafNodeAtOffset(model.$cstNode, offset);
        const node = leaf?.astNode;
        if (!node) return undefined;

        // The per-document analysis is memoized: hover reuses the typed check
        // (and the import tree) from the last validation unless the document
        // or an imported file changed — no re-analysis of the dependency
        // graph per hover, which is what made hovering imported values slow.
        const { tree, checked } = checkedProjectForDocument(document, this.services);
        const { modules, importsByModule, exportsByModule } = tree;

        // Walk up to the nearest node with a recorded type (leaf terminals
        // belong to their owning AST node, which is already recorded).
        let typed: AstNode | undefined = node;
        while (typed && !checked.nodeTypes.has(typed)) typed = typed.$container;
        if (!typed) return undefined;
        const typeText = checked.typeOf(typed);
        if (typeText === undefined) return undefined;

        const parts: string[] = [];
        const doc = this.documentation(document, modules, importsByModule, exportsByModule, node, typed);
        if (doc) parts.push(doc);
        parts.push(this.codeBlock(labelFor(document, typed, typeText)));
        return { contents: { kind: MarkupKind.Markdown, value: parts.join('\n\n') } };
    }

    /** Doc comment for the hovered node: its own binding, or the binding a bare identifier names. */
    private documentation(
        document: LangiumDocument,
        modules: readonly ProjectModule[],
        importsByModule: ReadonlyMap<ProjectModule, readonly import('../imports.js').ResolvedImportEdge[]>,
        exportsByModule: ReadonlyMap<ProjectModule, readonly import('../imports.js').ResolvedExportEdge[]>,
        node: AstNode,
        typed: AstNode,
    ): string | undefined {
        let binding: Binding | undefined;
        if (isBinding(typed)) {
            binding = typed;
        } else if (isIdentifier(node)) {
            const name = node.name;
            // Resolve within the node's OWN module: later bindings shadow
            // earlier ones, but no module sees a sibling's scope.
            const owner = moduleOf(node, modules);
            if (owner) {
                for (const b of owner.model.bindings) {
                    if (b.name === name) binding = b;
                }
            }
        } else if (isAccessExpression(node)) {
            // `t.binding` — the doc comment lives in the lib file.
            binding = moduleQualifiedBinding(node, modules, importsByModule, { exportsByModule });
        }        if (!binding?.$cstNode) return undefined;
        // The offset indexes the binding's OWN source text. For the hovered
        // document that IS that text; for an imported binding, read the
        // module's file (the offset indexes it) instead of the hovered file.
        let root: AstNode | undefined = binding;
        while (root.$container) root = root.$container;
        if (root === document.parseResult.value) {
            return docComment(document.textDocument.getText(), binding.$cstNode.offset);
        }
        const owner = moduleOf(binding, modules);
        const uri = owner?.uri;
        if (!uri) return undefined;
        try {
            const text = readFileSync(URI.parse(uri).fsPath, 'utf8');
            return docComment(text, binding.$cstNode.offset);
        } catch {
            return undefined;
        }
    }

    private codeBlock(text: string): string {
        return '```tetaue\n' + text + '\n```';
    }
}

/** `u.age : int`-style label for the hovered node. */
function labelFor(document: LangiumDocument, node: AstNode, typeText: string): string {
    if (isAccessExpression(node)) {
        const receiver = node.receiver?.$cstNode?.text ?? '?';
        return `${receiver}.${labelName(node.property)} : ${typeText}`;
    }
    if (isIdentifier(node) || isBinding(node)) {
        return `${node.name} : ${typeText}`;
    }
    const text = node.$cstNode?.text;
    return text ? `${text} : ${typeText}` : `${node.$type} : ${typeText}`;
}

/** Collect the contiguous `#` comment block directly above `offset` in `text`. */
export function docComment(text: string, offset: number): string | undefined {
    // Move to the start of the line containing `offset`.
    let lineStart = offset;
    while (lineStart > 0 && text[lineStart - 1] !== '\n') lineStart--;
    const lines: string[] = [];
    let start = lineStart;
    for (;;) {
        if (start === 0) break;
        const prevEnd = start - 1; // the '\n'
        let prevStart = prevEnd;
        while (prevStart > 0 && text[prevStart - 1] !== '\n') prevStart--;
        const line = text.slice(prevStart, prevEnd);
        const match = /^\s*#\s?(.*)$/.exec(line);
        if (!match) break;
        lines.unshift(match[1] ?? '');
        start = prevStart;
    }
    return lines.length > 0 ? lines.join('\n') : undefined;
}
