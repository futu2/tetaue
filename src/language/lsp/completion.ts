/******************************************************************************
 * tetaue completion provider.
 *
 * Extends Langium's grammar-driven completion with ONE semantic feature:
 * after a `.` on a record-typed expression, suggest the row's fields (with
 * their types). Everything else falls through to the default provider.
 *
 *   users & map (u => u.|        → id, name, age, ...
 *   users & map (u => u.ag|      → age, active  (replaces the partial text)
 *
 * Mid-typing the document is necessarily incomplete (`u.` doesn't parse), and
 * Langium's error recovery turns the receiver into stray bindings. So the
 * receiver's type is computed on a *synthetic* parse: insert a dummy property
 * after the dot, balance the open `( [ {`, parse that text, and let the real
 * inference pass resolve the receiver's row through unification with the
 * surrounding query (`map (u => u._dummy)` unifies `u` with the users row).
 ******************************************************************************/
import { CstUtils, type AstNode, type LangiumDocument } from 'langium';
import { DefaultCompletionProvider, type CompletionProviderOptions } from 'langium/lsp';
import {
    CompletionItem, CompletionItemKind, CompletionList, CompletionParams, Range, TextEdit,
} from 'vscode-languageserver';
import type { TetaueServices } from '../tetaue-module.js';
import { checkProject } from '../checker.js';
import { projectTreeFor } from '../compile.js';
import { isAccessExpression, isApplication, isIdentifier } from '../generated/ast.js';
import type { Model } from '../generated/ast.js';
import type { ProjectModule } from '../imports.js';
import { standardPrelude, standardPreludeNames } from '../prelude.js';

/** Synthetic property inserted after the dot so the access parses. */
const DUMMY = '_tetaue_field';

const STEP_NAMES = new Set(['filter', 'map', 'sort', 'take', 'distinct', 'fold', 'group_by', 'joinInner', 'joinLeft', 'joinRight', 'joinFull', 'join_lateral', 'select']);
const AGG_NAMES = new Set(['count', 'sum', 'avg', 'min', 'max', 'list', 'group']);

function builtinDetail(name: string): string | undefined {
    if (STEP_NAMES.has(name)) return 'query step';
    if (AGG_NAMES.has(name)) return 'aggregate';
    return 'function';
}

export class TetaueCompletionProvider extends DefaultCompletionProvider {
    override readonly completionOptions: CompletionProviderOptions = { triggerCharacters: ['.'] };

    private readonly services: TetaueServices;
    private readonly standardNames: readonly string[];

    constructor(services: TetaueServices) {
        super(services);
        this.services = services;
        this.standardNames = [...new Set(standardPreludeNames(services))];
    }

    override async getCompletion(
        document: LangiumDocument,
        params: CompletionParams,
        cancelToken?: Parameters<DefaultCompletionProvider['getCompletion']>[2],
    ): Promise<CompletionList | undefined> {
        const fields = this.fieldAccessCompletion(document, params);
        if (fields) return fields;
        const builtins = this.builtinCompletion(document, params);
        const defaults = await super.getCompletion(document, params, cancelToken);
        if (!builtins) return defaults;
        if (!defaults) return CompletionList.create(builtins, false);
        return CompletionList.create([...defaults.items, ...builtins], false);
    }

    /**
     * Standard-library completion in expression positions: primitive and
     * source-prelude functions are invisible to Langium's grammar-driven
     * default provider, so combine both sets explicitly.
     * Text-only heuristics: skip inside strings/comments and after a `.`
     * (field access owns those positions).
     */
    private builtinCompletion(document: LangiumDocument, params: CompletionParams): CompletionItem[] | undefined {
        const text = document.textDocument.getText();
        const offset = document.textDocument.offsetAt(params.position);

        // The identifier being typed (possibly empty at the cursor).
        let start = offset;
        while (start > 0 && /[A-Za-z0-9_$]/.test(text[start - 1]!)) start--;
        const prefix = text.slice(start, offset);
        if (!/^[A-Za-z_$]*$/.test(prefix)) return undefined;

        // Not inside a string literal or `#` comment.
        if (insideStringOrComment(text.slice(0, start))) return undefined;
        // Not after a `.` — `u.|` wants fields, not builtins.
        const before = text.slice(0, start).replace(/\s+$/, '');
        if (before.endsWith('.')) return undefined;

        const replaceStart = document.textDocument.positionAt(start);
        const items = this.standardNames
            .filter(name => name.startsWith(prefix))
            .sort()
            .map(name => ({
                label: name,
                kind: CompletionItemKind.Function,
                detail: builtinDetail(name),
                textEdit: TextEdit.replace(Range.create(replaceStart, params.position), name),
            }));
        return items.length > 0 ? items : undefined;
    }

    /**
     * Field completion after `.` on a record-typed receiver. Returns
     * undefined when the cursor is not after a field-access dot, or the
     * receiver's type has no known fields (then the default provider runs).
     */
    private fieldAccessCompletion(document: LangiumDocument, params: CompletionParams): CompletionList | undefined {
        const text = document.textDocument.getText();
        const offset = document.textDocument.offsetAt(params.position);

        const before = text.slice(0, offset);
        const dotPos = before.lastIndexOf('.');
        if (dotPos < 0) return undefined;
        // The part between the dot and the cursor must be a (possibly empty)
        // identifier prefix — this also rejects dots inside comments, strings
        // or on earlier lines.
        const partial = before.slice(dotPos + 1);
        if (partial !== '' && !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(partial)) return undefined;
        // A float literal's dot is not field access (`3.14`).
        if (/[0-9]/.test(text[dotPos - 1] ?? '') && /[0-9]/.test(text[dotPos + 1] ?? '')) return undefined;

        // Synthetic document: replace the partial property with the dummy and
        // close any still-open delimiters so the whole file parses.
        const head = text.slice(0, dotPos + 1) + DUMMY + text.slice(offset);
        const modified = head + closingDelimiters(head);
        const parsed = this.services.parser.LangiumParser.parse(modified);
        const model = parsed.value as Model | undefined;
        if (!model?.$cstNode) return undefined;

        // The dummy property starts at dotPos+1 in the modified text — locate
        // its AccessExpression node.
        const dummyLeaf = CstUtils.findLeafNodeAtOffset(model.$cstNode, dotPos + 1 + Math.floor(DUMMY.length / 2));
        const accessNode = dummyLeaf?.astNode;
        if (!isAccessExpression(accessNode)) return undefined;
        const receiver = accessNode.receiver;
        if (!receiver) return undefined;

        const { modules, importsByModule } = projectTreeFor({ model, uri: document.uri.toString(), imports: [] }, this.services);

        // Module-qualified access `t.` — the receiver is a bare identifier
        // naming an imported namespace; suggest its EXPORTED bindings.
        const moduleExports = moduleAliasExports(receiver, modules, importsByModule);
        if (moduleExports) {
            const replaceStart = document.textDocument.positionAt(dotPos + 1);
            const items = moduleExports
                .filter(name => name !== DUMMY)
                .map(name => ({
                    label: name,
                    kind: CompletionItemKind.Variable,
                    textEdit: TextEdit.replace(Range.create(replaceStart, params.position), name),
                }));
            return CompletionList.create(items, false);
        }

        const inferred = checkProject(modules, {
            requireQuery: false,
            importsByModule,
            prelude: standardPrelude(this.services),
        });
        let typed: AstNode | undefined = receiver;
        while (typed && !inferred.nodeTypes.has(typed)) typed = typed.$container;
        if (!typed) return undefined;
        const fields = inferred.fieldsOf(typed);
        if (!fields || fields.length === 0) return undefined;

        const replaceStart = document.textDocument.positionAt(dotPos + 1);
        const items = fields
            .filter(field => field.name !== DUMMY)
            .map(field => ({
                label: field.name,
                kind: CompletionItemKind.Field,
                detail: field.type,
                textEdit: TextEdit.replace(Range.create(replaceStart, params.position), field.name),
            }));
        return CompletionList.create(items, false);
    }
}

/**
 * Exported binding names of the namespace the receiver names — the receiver
 * of `t.` parses as an Application of a bare identifier. Undefined when the
 * receiver is not a module alias (then normal field completion applies).
 */
function moduleAliasExports(receiver: AstNode | undefined, modules: readonly ProjectModule[], importsByModule: ReadonlyMap<ProjectModule, readonly import('../imports.js').ResolvedImportEdge[]> = new Map()): string[] | undefined {
    if (!isApplication(receiver) || receiver.arguments.length > 0 || !isIdentifier(receiver.func)) return undefined;
    const alias = receiver.func.name;
    const root = modules[modules.length - 1];
    const edge = (root ? importsByModule.get(root) ?? root.imports ?? [] : []).find(e => e.alias === alias);
    if (!edge) return undefined;
    if (edge.importNode.names.length > 0) {
        return edge.importNode.names.map(item => item.renamed ?? item.name);
    }
    return edge.target.model.bindings.filter(b => b.export).map(b => b.name);
}

/**
 * True when the scanner ends inside a `"..."` string literal or a `#`
 * comment (handles `\` escapes inside strings).
 */
function insideStringOrComment(text: string): boolean {
    let inString = false;
    let inComment = false;
    let i = 0;
    while (i < text.length) {
        const ch = text[i];
        if (inComment) {
            if (ch === '\n') inComment = false;
            i++;
            continue;
        }
        if (inString) {
            if (ch === '\\') i += 2;
            else {
                if (ch === '"') inString = false;
                i++;
            }
            continue;
        }
        if (ch === '#') inComment = true;
        else if (ch === '"') inString = true;
        i++;
    }
    return inString || inComment;
}

/**
 * Balance the `( [ {` delimiters of `text` (skipping strings and `#`
 * comments), returning the missing closing characters in nesting order.
 */
export function closingDelimiters(text: string): string {
    const stack: string[] = [];
    let inString = false;
    let inComment = false;
    let i = 0;
    while (i < text.length) {
        const ch = text[i];
        if (inComment) {
            if (ch === '\n') inComment = false;
            i++;
            continue;
        }
        if (inString) {
            if (ch === '\\') i += 2;
            else {
                if (ch === '"') inString = false;
                i++;
            }
            continue;
        }
        if (ch === '#') {
            inComment = true;
            i++;
            continue;
        }
        if (ch === '"') {
            inString = true;
            i++;
            continue;
        }
        if (ch === '(') stack.push(')');
        else if (ch === '[') stack.push(']');
        else if (ch === '{') stack.push('}');
        else if (ch === ')' || ch === ']' || ch === '}') {
            if (stack[stack.length - 1] === ch) stack.pop();
        }
        i++;
    }
    return stack.reverse().join('');
}
