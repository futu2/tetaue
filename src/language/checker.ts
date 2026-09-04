/******************************************************************************
 * tetaue checker — the single typed-IR/checking pass.
 *
 * `checkProject` runs ONE project traversal (imports first, root last).
 * Each binding is advanced through the value evaluator and the type
 * inferencer TOGETHER, sharing one lexical scope (`Inferencer.beginModule`),
 * so runtime IR construction (the SQL `Value` / `Query` IR) and static typing
 * (the Hindley-Milner row-polymorphic pass) stay in lockstep. The result is
 * a checked project:
 *
 *   - `value`: the root module's final IR value (exactly what `analyzeProject`
 *     produced) — the renderer consumes this directly;
 *   - `diagnostics`: interpreter + inference diagnostics merged with exact
 *     (node, message) dedupe, so each error is reported once;
 *   - `nodeTypes` / `typeOf` / `fieldsOf`: the static types recorded for
 *     hover and completion.
 *
 * `analyzeProject` / `inferProject` remain as compatibility wrappers for
 * callers that only need one side, but production paths (`compile.ts`, the
 * validator, hover/completion, and `tetaue types`) all use this pass.
 ******************************************************************************/
import type { AstNode } from 'langium';
import {
    ERROR, createPreludeEnv, describe, parseStringLiteral, recursiveBindingMessage, topoOrderBindings, type Diagnostic, type Value,
} from './interpreter.js';
import { Inferencer, mergeDiagnostics } from './inference.js';
import type { Scheme, Type } from './types.js';
import { resolveImportScope } from './project-scope.js';
import type { ProjectModule, ResolvedExportEdge, ResolvedImportEdge } from './imports.js';

export interface CheckProjectResult {
    /** The root module's final evaluated value; its `query` is the SQL IR. */
    value: Value;
    /** Interpreter + inference diagnostics, exact-deduped. */
    diagnostics: Diagnostic[];
    /** Static type of each expression / binding node, keyed by node identity. */
    nodeTypes: Map<AstNode, Type>;
    /** Runtime IR Value produced for each expression node (best effort). */
    nodeValues: Map<AstNode, Value>;
    /** Rendered (resolved) type text of a node, or undefined. */
    typeOf(node: AstNode): string | undefined;
    /** Row fields of a node's type (unwrapping `?`), with rendered types, or undefined. */
    fieldsOf(node: AstNode): { name: string; type: string }[] | undefined;
}

export interface CheckProjectOptions {
    /** Require the root module's last binding to be a query (default true). */
    requireQuery?: boolean;
    /**
     * Strict `main` entry: the module's query is its `main` binding. When set,
     * a module without `main` is a library (no SQL); `entryBinding` (--binding)
     * overrides it to render a specific named binding. Default false keeps the
     * last-binding fallback for tooling/tests.
     */
    requireMain?: boolean;
    /** Resolved import edges from `collectModuleTree` (pure tree). */
    importsByModule?: ReadonlyMap<ProjectModule, readonly ResolvedImportEdge[]>;
    /** Resolved re-export (`export ... from`) edges from `collectModuleTree`. */
    reexportsByModule?: ReadonlyMap<ProjectModule, readonly ResolvedExportEdge[]>;
    /** Render this root-module binding instead of the last one. */
    entryBinding?: string;
    /**
     * Optional standard-library module. Its exported bindings are evaluated
     * once from the core and injected into every user module. Keeping this
     * explicit makes the core/prelude boundary testable and avoids a hidden
     * second evaluator.
     */
    prelude?: ProjectModule;
    /**
     * The dialect the prelude's `sql_dialect` value describes. When omitted,
     * the prelude sees a sqlite-shaped view (matching the CLI default).
     */
    dialect?: import('./interpreter.js').DialectView;
}

/**
 * Check a whole project in one traversal: IR evaluation + type inference are
 * advanced per module and per binding, so a project is never run twice.
 */
export function checkProject(
    modules: readonly ProjectModule[],
    options: CheckProjectOptions = {},
): CheckProjectResult {
    const { requireQuery = true, requireMain = false, importsByModule = new Map(), entryBinding, prelude, dialect } = options;
    const reexportsByModule = options.reexportsByModule ?? new Map<ProjectModule, readonly ResolvedExportEdge[]>();

    const inferencer = new Inferencer();
    inferencer.prelude(dialect);
    const nodeValues = new Map<AstNode, Value>();

    // Export maps are filled as each module is processed (diamond imports
    // reference the SAME target module object, so this stays deduplicated).
    const valueExportsByModule = new Map<ProjectModule, Map<string, Value>>();
    const schemeExportsByModule = new Map<ProjectModule, Map<string, Scheme>>();
    const typeExportsByModule = new Map<ProjectModule, Map<string, import('./generated/ast.js').Type>>();

    const interpreterDiagnostics: Diagnostic[] = [];
    const root = modules[modules.length - 1];
    // The prelude is a real module, but it is not part of the user's import
    // graph. Process it first and inject only its exports into user scopes.
    // `allModules` (prelude included) is also the diagnostic-anchor universe:
    // an error inside a prelude lambda (e.g. `_&_ = x => f => f x`) must carry
    // the PRELUDE's uri, not the importing file's.
    const allModules = prelude ? [prelude, ...modules] : [...modules];
    let standardValues = new Map<string, Value>();
    let standardSchemes = new Map<string, Scheme>();
    let standardTypes = new Map<string, import('./generated/ast.js').Type>();
    let rootEnv: Map<string, Value> | undefined;
    let value: Value = ERROR;

    for (const module of allModules) {
        const moduleImports: readonly ResolvedImportEdge[] =
            importsByModule.get(module) ?? module.imports ?? [];

        // Prepare BOTH sides once for this module. The type inferencer owns
        // the shared lexical scope; the value evaluator owns the runtime
        // environment. Both are advanced together per binding below.
        const typedScope = inferencer.beginModule(
            module,
            moduleImports,
            schemeExportsByModule,
            typeExportsByModule,
            standardTypes,
        ).scope;
        const scope = new Map(typedScope);

        let env = createPreludeEnv(dialect);
        const moduleBindings: Set<string> = new Set(module.model.bindings.map(b => b.name));
        const moduleDiagnostics: Diagnostic[] = [
            ...inferencer.takeDiagnostics(),
        ];

        const imported = resolveImportScope(module, moduleImports, valueExportsByModule, typeExportsByModule);
        moduleDiagnostics.push(...imported.diagnostics);
        for (const [name, v] of imported.flat) env.set(name, v);
        for (const [alias, selected] of imported.namespaces) {
            env.set(alias, {
                kind: 'module',
                name: alias,
                exports: new Map(selected),
                ast: module.model.imports.find(imp => imp.alias === alias),
            });
        }

        // Standard-library names have lower precedence than imports and local
        // bindings, matching ordinary lexical shadowing.
        if (module !== prelude) {
            for (const [name, scheme] of standardSchemes) {
                if (!inferencer.env.has(name)) inferencer.env.set(name, scheme);
            }
            for (const [name, v] of standardValues) {
                if (!env.has(name)) env.set(name, v);
            }
        }

        const exports = new Map<string, Value>();
        const exportedSchemes = new Map<string, Scheme>();
        let seen = new Set<string>();
        // Top-down resolution (Haskell-style): infer + evaluate each binding
        // in dependency order so a definition may reference any other binding
        // in the module, regardless of position. Cycle members are processed
        // last in source order; their recursion is diagnosed once.
        const { order, cycles } = topoOrderBindings(module.model.bindings);
        const cycleNames = new Set(cycles.map(b => b.name));
        // Pre-bind cycle members to ERROR so dependents report their own
        // errors instead of a misleading "unknown identifier".
        for (const binding of cycles) {
            env = new Map(env).set(binding.name, ERROR);
        }
        for (const binding of [...order, ...cycles]) {
            const result = inferencer.typedBinding(
                binding, exportedSchemes, scope, env, moduleBindings, seen, nodeValues, cycleNames,
            );
            moduleDiagnostics.push(...result.diagnostics);
            env = result.env;
            seen = result.seen;
            value = result.value;
            if (binding.export) {
                exports.set(binding.name, value);
            }
        }

        // --- re-exports: `export * from "x"` / `export { a as b } from "x"` ---
        // Re-exports add names to THIS module's public surface without binding
        // them locally, mirroring the interpreter's merge exactly (same
        // wording, so the merged diagnostics dedupe).
        for (const { target, exportNode } of reexportsByModule.get(module) ?? []) {
            const targetValues = valueExportsByModule.get(target);
            const targetSchemes = schemeExportsByModule.get(target);
            if (!targetValues || !targetSchemes) continue; // cyclic/missing target — already diagnosed
            const spec = parseStringLiteral(exportNode.path);
            const names: { name: string; renamed: string | undefined }[] = exportNode.names.length === 0
                ? [...targetValues.keys()].map(name => ({ name, renamed: undefined }))
                : exportNode.names.map(item => ({ name: item.name, renamed: item.renamed ?? undefined }));
            for (const { name, renamed } of names) {
                const v = targetValues.get(name);
                const s = targetSchemes.get(name);
                if (v === undefined || s === undefined) {
                    const keys = [...targetValues.keys()];
                    moduleDiagnostics.push({ node: exportNode, message: `'${name}' is not exported by '${spec}' — exported: ${keys.length > 0 ? keys.join(', ') : '(none)'}` });
                    continue;
                }
                const localName = renamed ?? name;
                if (exports.has(localName)) {
                    moduleDiagnostics.push({ node: exportNode, message: `re-exported name '${localName}' (from '${spec}') conflicts with an already exported name` });
                    continue;
                }
                exports.set(localName, v);
                exportedSchemes.set(localName, s);
            }
        }

        valueExportsByModule.set(module, exports);
        schemeExportsByModule.set(module, exportedSchemes);
        typeExportsByModule.set(module, new Map(
            module.model.types.filter(a => a.export).map(a => [a.name, a.type]),
        ));

        if (module === root) rootEnv = env;
        if (module === prelude) {
            standardValues = exports;
            standardSchemes = exportedSchemes;
            standardTypes = new Map(module.model.types.filter(a => a.export).map(a => [a.name, a.type]));
            // Public aliases are the prelude for every following module. Keep
            // their scheme identity so builtin-specific inference checks still
            // recognize `filter`, `fold`, etc. while allowing local shadowing.
            inferencer.preludeEnv = new Map([...inferencer.preludeEnv, ...standardSchemes]);
        }
        interpreterDiagnostics.push(...moduleDiagnostics);
    }

    inferencer.flushDeferred();
    interpreterDiagnostics.push(...inferencer.takeDiagnostics());

    // The module's query is its `main` binding. With `entryBinding`
    // (--binding) render/check target any named root-module binding instead.
    // By default (`requireMain: false`) a module without `main` falls back to
    // its last binding, which keeps the interpreter/tooling and tests working;
    // `requireMain` makes a missing `main` a library (no SQL) with an error.
    const mainBinding = root?.model.bindings.find(b => b.name === 'main');
    const selectedBinding = entryBinding
        ? root?.model.bindings.find(b => b.name === entryBinding)
        : mainBinding ?? root?.model.bindings[root.model.bindings.length - 1];
    let mainValue: Value | undefined;
    if (root && !entryBinding && mainBinding && rootEnv) {
        mainValue = rootEnv.get('main') ?? ERROR;
    }
    if (entryBinding && rootEnv) {
        value = rootEnv.get(entryBinding) ?? ERROR;
    } else if (mainValue !== undefined) {
        value = mainValue;
    } else if (root && rootEnv && selectedBinding) {
        // No `main` and no --binding: the query is the LAST binding in source
        // order (bindings evaluate in dependency order, so the trailing loop
        // value is not necessarily the entry).
        value = rootEnv.get(selectedBinding.name) ?? ERROR;
    }
    if (requireMain && !entryBinding && root) {
        if (!mainBinding) {
            value = ERROR;
            if (requireQuery) {
                // The no-main hint is only useful on an otherwise-clean
                // module: when the module has real diagnostics, the missing
                // `main` is noise (and a broken module is not a useful
                // library anyway). No entry-point hint has been pushed yet,
                // so any diagnostic here is a real problem.
                const noisy = interpreterDiagnostics.length > 0;
                if (!noisy) {
                    interpreterDiagnostics.push({
                        node: root.model,
                        message: "a module's query is its `main` binding — this module has none (it is a library and does not compile to SQL; add a `main` binding or pass --binding to render a specific one)",
                    });
                }
            }
        } else if (requireQuery && !(value.kind === 'error') && value.kind !== 'query') {
            interpreterDiagnostics.push({
                node: mainBinding,
                message: `binding 'main' must be a query (a table or a pipeline), got ${describe(value)}`,
            });
        }
    } else if (requireQuery && root) {
        if (!selectedBinding) {
            value = ERROR;
            interpreterDiagnostics.push({
                node: root.model,
                message: entryBinding
                    ? `module has no binding named '${entryBinding}'`
                    : `a module must have at least one binding — ${mainBinding ? 'its `main` binding is the query' : "its last binding is the module's query"}`,
            });
        } else if (value.kind === 'error') {
            // The binding already failed with its own diagnostics — a "must
            // be a query" line would only repeat the cascade.
            value = ERROR;
        } else if (value.kind !== 'query') {
            interpreterDiagnostics.push({
                node: selectedBinding,
                message: entryBinding
                    ? `binding '${entryBinding}' must be a query (a table or a pipeline), got ${describe(value)}`
                    : mainBinding
                        ? `binding 'main' must be a query (a table or a pipeline), got ${describe(value)}`
                        : `a module's last binding must be a query (a table or a pipeline), got ${describe(value)}`,
            });
        }
    }

    const diagnostics = mergeDiagnostics(allModules, interpreterDiagnostics);
    return {
        value,
        diagnostics,
        nodeTypes: inferencer.nodeTypes,
        nodeValues,
        typeOf: node => inferencer.typeOf(node),
        fieldsOf: node => inferencer.fieldsOf(node),
    };
}
