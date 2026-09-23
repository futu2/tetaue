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
import { ERROR, checkBinding, createPreludeEnv, describe, namespaceEnv, type Value } from './interpreter.js';
import { parseStringLiteral } from './strings.js';
import { baseClosureFor } from './prelude.js';
import { recursiveBindingMessage, topoOrderBindings, type Diagnostic } from './binding-analysis.js';
import { Inferencer, mergeDiagnostics } from './inference.js';
import type { Scheme, Type } from './types.js';
import { resolveImportScope } from './project-scope.js';
import type { ProjectModule, ResolvedExportEdge, ResolvedImportEdge } from './imports.js';
import type { DialectView } from './binding-analysis.js';

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
     * The whole base library, in dependency order, including `prelude`. Base
     * modules are evaluated with the primitive core seeded and are the ONLY
     * modules that see it; every other module starts from the Prelude's
     * exports. Defaults to `[prelude]` so a caller that only cares about the
     * auto-imported surface keeps working.
     */
    baseModules?: readonly ProjectModule[];
    /**
     * The base library's OWN import/re-export edges (`base/prelude.tetaue`
     * imports `./sql.tetaue`). The user's `importsByModule` never contains
     * them, so the library's internal wiring is passed separately.
     */
    baseImportsByModule?: ReadonlyMap<ProjectModule, readonly ResolvedImportEdge[]>;
    baseExportsByModule?: ReadonlyMap<ProjectModule, readonly ResolvedExportEdge[]>;
    /**
     * The dialect the prelude's `sql_dialect` value describes. When omitted,
     * the prelude sees a sqlite-shaped view (matching the CLI default).
     */
    dialect?: DialectView;
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
    const baseImportsByModule = options.baseImportsByModule ?? new Map<ProjectModule, readonly ResolvedImportEdge[]>();
    const baseExportsByModule = options.baseExportsByModule ?? new Map<ProjectModule, readonly ResolvedExportEdge[]>();

    const inferencer = new Inferencer();
    inferencer.prelude(dialect);
    const nodeValues = new Map<AstNode, Value>();

    // Export maps are filled as each module is processed (diamond imports
    // reference the SAME target module object, so this stays deduplicated).
    const valueExportsByModule = new Map<ProjectModule, Map<string, Value>>();
    const schemeExportsByModule = new Map<ProjectModule, Map<string, Scheme>>();

    const interpreterDiagnostics: Diagnostic[] = [];
    // The base library is a set of REAL modules that form their own module
    // tree: the Prelude re-exports `./data/function`, `./Sql`, ... so the
    // standard surface is built exactly the way a user's index module is.
    // They are processed first, in dependency order, and recorded in the
    // export maps like any other module — which is what lets the Prelude's
    // re-exports resolve.
    //
    // `baseModules` is also the diagnostic-anchor universe: an error inside a
    // library lambda (`_&_ = x => f => f x`) must carry the BASE module's uri,
    // not the importing file's. With no explicit wiring, the tree is expanded
    // from the Prelude itself, because every base module carries its own edges
    // (see prelude.ts) — so a caller holding only `standardPrelude(services)`
    // still gets the whole library.
    const baseModules = options.baseModules ?? (prelude ? baseClosureFor(prelude) : []);
    const baseSet: ReadonlySet<ProjectModule> = new Set(baseModules);
    // A caller may pass the library AND a user tree that reached a base
    // module through an explicit `import "base/..."`. Those modules are
    // already in `baseModules` (with the primitive environment), so drop the
    // duplicates: checking one twice would both lose its primitives and
    // report every diagnostic twice.
    const userModules = modules.filter(m => !baseSet.has(m));
    const allModules = [...baseModules, ...userModules];
    const root = userModules[userModules.length - 1];
    inferencer.isBaseModule = module => baseSet.has(module);
    let rootEnv: Map<string, Value> | undefined;
    let value: Value = ERROR;

    for (const module of allModules) {
        const isBase = baseSet.has(module);
        const moduleImports: readonly ResolvedImportEdge[] = isBase
            ? baseImportsByModule.get(module) ?? module.imports ?? []
            : importsByModule.get(module) ?? module.imports ?? [];

        // Prepare BOTH sides once for this module. The type inferencer owns
        // the shared lexical scope; the value evaluator owns the runtime
        // environment. Both are advanced together per binding below.
        const typedScope = inferencer.beginModule(
            module,
            moduleImports,
            schemeExportsByModule,
        ).scope;
        const scope = new Map(typedScope);

        // A BASE module is the only kind that starts from the primitive core
        // (BUILTINS + the operator intrinsics + `sql_dialect`); a user module
        // starts from the auto-imported Prelude instead. That single rule is
        // what makes `table`/`filter` ambient for users while `sql_func` and
        // `op_add` stay library-internal.
        // A base module starts from the whole primitive core; a user module
        // starts from the built-in namespaces (`list.*`, `Maybe.*`) and then
        // receives the Prelude's exports below. The namespaces are core
        // vocabulary rather than Prelude exports, so they are always in scope.
        let env = isBase ? createPreludeEnv(dialect) : namespaceEnv();
        const moduleBindings: Set<string> = new Set(module.model.bindings.map(b => b.name));
        const moduleDiagnostics: Diagnostic[] = [
            ...inferencer.takeDiagnostics(),
        ];

        const imported = resolveImportScope(module, moduleImports, valueExportsByModule);
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

        // The Prelude is auto-imported into every non-base module that does
        // not opt out with `# no prelude`. Its names have LOWER precedence
        // than explicit imports and local bindings, matching ordinary lexical
        // shadowing (and Haskell, where a local definition wins over the
        // Prelude's).
        //
        // `noPrelude` is set by `compile.ts` from the first-line pragma:
        // comments are hidden terminals, so the flag — not the model — is
        // where the directive lives for a caller-built `ProjectModule`.
        if (!isBase && module.noPrelude !== true && prelude) {
            for (const [name, scheme] of schemeExportsByModule.get(prelude) ?? []) {
                if (!inferencer.env.has(name)) inferencer.env.set(name, scheme);
            }
            for (const [name, v] of valueExportsByModule.get(prelude) ?? []) {
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
            // ONE loop, TWO passes: the binding is typed and then evaluated,
            // so a project is never traversed twice. They are separate calls
            // (rather than one fused method) so the inferencer never has to
            // import the evaluator — see stage 3 of the architecture doc.
            moduleDiagnostics.push(
                ...inferencer.checkBindingTypes(binding, exportedSchemes, scope, cycleNames),
            );
            const result = checkBinding(binding, env, moduleBindings, seen, {
                ...(nodeValues ? { nodeValues } : {}),
            });
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
        const moduleReexports = isBase
            ? baseExportsByModule.get(module) ?? module.exports ?? []
            : reexportsByModule.get(module) ?? module.exports ?? [];
        for (const { target, exportNode } of moduleReexports) {
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

        if (module === root) rootEnv = env;
        if (module === prelude || isBase) {
            // The base library's exported names are the Prelude for every
            // following module. Keep their scheme identity so builtin-specific
            // inference checks still recognize `filter`, `fold`, etc. while
            // allowing local shadowing. `preludeNames` records the same set by
            // NAME, so a rule may also apply to a library-defined wrapper
            // (`abs`, `ceil`, `pow`) that has no core builtin behind it —
            // while a user's own `abs` is still exempt, because its scheme
            // identity differs.
            inferencer.preludeNames = new Set([...inferencer.preludeNames, ...exportedSchemes.keys()]);
            inferencer.preludeEnv = new Map([...inferencer.preludeEnv, ...exportedSchemes]);
        }
        interpreterDiagnostics.push(...moduleDiagnostics);
    }

    // Any check still pending after the last module has no owner module left;
    // flushing here keeps the "no deferred work is lost" invariant explicit.
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
