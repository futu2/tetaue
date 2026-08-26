/******************************************************************************
 * document-analysis — the LSP's shared, memoized analysis of an open document.
 *
 * Every LSP feature that needs types (the validator on each keystroke, hover,
 * completion) used to build the import tree AND run the full typed check
 * (`checkProject`) over the whole dependency graph on every request. For a
 * document importing a large schema library that is exactly "hover is not
 * lazy": each hover re-type-checks every imported binding.
 *
 * This module keeps ONE analysis per document:
 *
 *   - the tree is built on demand from disk through a single shared loader
 *     (mtime-keyed text, hash-keyed AST, per-module size budget, byte-bounded
 *     caches, CST dropped for large imported modules);
 *   - the expensive `checkProject` result is memoized per document state: the
 *     signature is the root text hash plus each imported module's content
 *     hash. Hover/completion/validation over an unchanged document then reuse
 *     the same inference result instead of re-analyzing the whole graph, and
 *     editing the root or any imported file (mtime change) invalidates it.
 *
 * The cached result's `nodeTypes`/`nodeValues` are keyed by AST node identity,
 * which stays stable because the loader returns the same model objects for
 * unchanged files and the document's parse result is unchanged between
 * keystroke-free requests.
 ******************************************************************************/
import { createHash } from 'node:crypto';
import type { LangiumDocument } from 'langium';
import { checkProject } from '../checker.js';
import type { CheckProjectResult } from '../checker.js';
import type { ProjectTree } from '../compile.js';
import { collectModuleTree } from '../imports.js';
import type { ProjectModule } from '../imports.js';
import { CST_DROP_BYTES, createModuleLoader } from '../module-cache.js';
import { standardPrelude } from '../prelude.js';
import { createImportResolver } from '../resolve.js';
import type { TetaueServices } from '../tetaue-module.js';
import type { Model } from '../generated/ast.js';

/** The shared LSP loader: memoized, budgeted, CST-dropping for large imports. */
export const lspModuleLoader = createModuleLoader({ cstDropBytes: CST_DROP_BYTES });

interface CacheEntry {
    signature: string;
    checked: CheckProjectResult;
}

const cache = new Map<string, CacheEntry>();
/** ANALYSIS_CACHE_MAX keeps closed/edited documents from accumulating entries. */
const ANALYSIS_CACHE_MAX = 64;

/** Debug counters for the analysis cache (used by tests). */
export const analysisCacheStats = {
    hits: 0,
    misses: 0,
};

function sha1(text: string): string {
    return createHash('sha1').update(text).digest('hex');
}

function buildTree(root: ProjectModule, services: TetaueServices): ProjectTree {
    const tree = collectModuleTree(root, {
        resolve: createImportResolver(),
        read: lspModuleLoader.read,
        parse: (text, uri) => lspModuleLoader.parse(text, uri, services),
    });
    return {
        modules: tree.modules,
        importsByModule: tree.importsByModule,
        exportsByModule: tree.exportsByModule,
        diagnostics: tree.diagnostics,
    };
}

/**
 * The document state that determines whether the analysis is still valid:
 * the root's live text plus the content hash of every imported module. All
 * pieces come from caches — no re-reading, no re-hashing — so computing the
 * signature is O(imports) Map lookups.
 */
function signatureFor(rootText: string, tree: ProjectTree): string {
    const parts = [sha1(rootText)];
    for (const module of tree.modules) {
        const version = module.uri !== undefined ? lspModuleLoader.versionOf(module.uri) : undefined;
        parts.push(`${module.uri ?? ''}=${version ?? ''}`);
    }
    return parts.join('|');
}

function evictOldest(): void {
    if (cache.size <= ANALYSIS_CACHE_MAX) return;
    const oldest = cache.keys().next().value as string;
    cache.delete(oldest);
}

/**
 * Build the document's import tree with the shared loader. Cheap per request
 * (statSync + memoized reads/parses) — validation still needs it every
 * keystroke for cycle/missing-file diagnostics.
 */
export function treeFor(model: Model, rootUri: string, services: TetaueServices): ProjectTree {
    return buildTree({ model, uri: rootUri, imports: [] }, services);
}

/**
 * Build the import tree and run the typed check once per document state.
 * Consecutive requests over an unchanged document (and unchanged imports)
 * reuse the memoized `checkProject` result — hover/validation/completion
 * become cache hits instead of re-analyzing the whole dependency graph.
 *
 * `rootText` must be the exact text that produced `model` (the live document
 * text, or completion's synthetic text).
 */
export function checkedProjectFor(
    model: Model,
    rootUri: string,
    rootText: string,
    services: TetaueServices,
): { tree: ProjectTree; checked: CheckProjectResult } {
    const tree = buildTree({ model, uri: rootUri, imports: [] }, services);
    const signature = signatureFor(rootText, tree);
    const cached = cache.get(rootUri);
    if (cached && cached.signature === signature) {
        analysisCacheStats.hits++;
        return { tree, checked: cached.checked };
    }

    analysisCacheStats.misses++;
    const checked = checkProject(tree.modules, {
        requireQuery: false,
        importsByModule: tree.importsByModule,
        reexportsByModule: tree.exportsByModule,
        prelude: standardPrelude(services),
    });
    cache.set(rootUri, { signature, checked });
    evictOldest();
    return { tree, checked };
}

/** Convenience: the analysis of an open Langium document (live text). */
export function checkedProjectForDocument(
    document: LangiumDocument,
    services: TetaueServices,
): { tree: ProjectTree; checked: CheckProjectResult } {
    return checkedProjectFor(
        document.parseResult.value as Model,
        document.uri.toString(),
        document.textDocument.getText(),
        services,
    );
}