/******************************************************************************
 * tetaue checker — the single typed-IR/checking pass.
 *
 * `checkProject` runs ONE project traversal (imports first, root last). For
 * each module it resolves imports once for the value evaluator and once for
 * the type inferencer (project-scope.ts is shared and deterministic), then
 * checks each binding for BOTH runtime IR construction (the SQL `Value` /
 * `Query` IR used by the renderer) and static typing (the Hindley–Milner
 * row-polymorphic pass). The result is a checked project:
 *
 *   - `value`: the root module's final IR value (exactly what `analyzeProject`
 *     produced) — the renderer consumes this directly;
 *   - `diagnostics`: interpreter + inference diagnostics merged with exact
 *     (node, message) dedupe, so each error is reported once;
 *   - `nodeTypes` / `typeOf` / `fieldsOf`: the static types recorded for
 *     hover and completion.
 *
 * This replaces the old architecture where `compile.ts` and the validator ran
 * `analyzeProject` + `inferProject` as two separate whole-project passes and
 * merged them afterwards. The old functions still exist as compatibility
 * wrappers for tests and the CLI `types` command.
 ******************************************************************************/
import type { AstNode } from 'langium';
import {
    ERROR, checkBinding, createPreludeEnv, describe, type Diagnostic, type Value,
} from './interpreter.js';
import { Inferencer, mergeDiagnostics } from './inference.js';
import type { Scheme, Type } from './types.js';
import { resolveImportScope, resolveTypeImportScope } from './project-scope.js';
import type { ProjectModule, ResolvedImportEdge } from './imports.js';

export interface CheckProjectResult {
    /** The root module's final evaluated value; its `query` is the SQL IR. */
    value: Value;
    /** Interpreter + inference diagnostics, exact-deduped. */
    diagnostics: Diagnostic[];
    /** Static type of each expression / binding node, keyed by node identity. */
    nodeTypes: Map<AstNode, Type>;
    /** Rendered (resolved) type text of a node, or undefined. */
    typeOf(node: AstNode): string | undefined;
    /** Row fields of a node's type (unwrapping `?`), with rendered types, or undefined. */
    fieldsOf(node: AstNode): { name: string; type: string }[] | undefined;
}

export interface CheckProjectOptions {
    /** Require the root module's last binding to be a query (default true). */
    requireQuery?: boolean;
    /** Resolved import edges from `collectModuleTree` (pure tree). */
    importsByModule?: ReadonlyMap<ProjectModule, readonly ResolvedImportEdge[]>;
    /** Render this root-module binding instead of the last one. */
    entryBinding?: string;
}

/**
 * Check a whole project in one traversal: IR evaluation + type inference are
 * advanced per module and per binding, so a project is never run twice.
 */
export function checkProject(
    modules: readonly ProjectModule[],
    options: CheckProjectOptions = {},
): CheckProjectResult {
    const { requireQuery = true, importsByModule = new Map(), entryBinding } = options;

    const inferencer = new Inferencer();
    inferencer.prelude();

    // Export maps are filled as each module is processed (diamond imports
    // reference the SAME target module object, so this stays deduplicated).
    const valueExportsByModule = new Map<ProjectModule, Map<string, Value>>();
    const schemeExportsByModule = new Map<ProjectModule, Map<string, Scheme>>();
    const typeExportsByModule = new Map<ProjectModule, Map<string, import('./generated/ast.js').Type>>();

    const interpreterDiagnostics: Diagnostic[] = [];
    const root = modules[modules.length - 1];
    let rootEnv: Map<string, Value> | undefined;
    let value: Value = ERROR;

    for (const module of modules) {
        const moduleImports: readonly ResolvedImportEdge[] =
            importsByModule.get(module) ?? module.imports ?? [];

        // --- value/IR side (identical semantics to analyzeProject) ---------
        let env = createPreludeEnv();
        const moduleBindings: Set<string> = new Set(module.model.bindings.map(b => b.name));
        const moduleDiagnostics: Diagnostic[] = [];

        const imported = resolveImportScope(module, moduleImports, valueExportsByModule, typeExportsByModule);
        const importedTypes = resolveTypeImportScope(module, moduleImports, typeExportsByModule);
        moduleDiagnostics.push(...imported.diagnostics, ...importedTypes.diagnostics);
        for (const [name, v] of imported.flat) env.set(name, v);
        for (const [alias, selected] of imported.namespaces) {
            env.set(alias, {
                kind: 'module',
                name: alias,
                exports: new Map(selected),
                ast: module.model.imports.find(imp => imp.alias === alias),
            });
        }
        const scope = new Map(imported.scope);

        const typeAliases = new Map(importedTypes.flat);
        for (const alias of module.model.types) {
            if (typeAliases.has(alias.name)) {
                moduleDiagnostics.push({
                    node: alias,
                    message: `type alias '${alias.name}' conflicts with an imported type alias`,
                });
                continue;
            }
            typeAliases.set(alias.name, alias.type);
        }

        const exports = new Map<string, Value>();
        let seen = new Set<string>();
        for (const binding of module.model.bindings) {
            if (scope.has(binding.name)) {
                moduleDiagnostics.push({
                    node: binding,
                    message: `name '${binding.name}' (a local binding) conflicts with ${scope.get(binding.name)!}`,
                });
            }
            scope.set(binding.name, `local binding '${binding.name}'`);
            const result = checkBinding(binding, env, moduleBindings, seen);
            moduleDiagnostics.push(...result.diagnostics);
            env = result.env;
            seen = result.seen;
            value = result.value;
            if (binding.export) exports.set(binding.name, value);
        }

        // --- static-type side (identical semantics to inferProject) --------
        // `inferModule` reads the SAME import edges and previous export maps.
        const exportedSchemes = inferencer.inferModule(
            module,
            moduleImports,
            schemeExportsByModule,
            typeExportsByModule,
        );

        valueExportsByModule.set(module, exports);
        schemeExportsByModule.set(module, exportedSchemes);
        typeExportsByModule.set(module, new Map(
            module.model.types.filter(a => a.export).map(a => [a.name, a.type]),
        ));

        if (module === root) rootEnv = env;
        interpreterDiagnostics.push(...moduleDiagnostics);
    }

    inferencer.flushDeferred();

    // Query requirement. Default: the last binding, as before. With
    // `entryBinding`, render/check target any named root-module binding.
    const selectedBinding = entryBinding
        ? root?.model.bindings.find(b => b.name === entryBinding)
        : root?.model.bindings[root.model.bindings.length - 1];
    if (entryBinding && rootEnv) {
        value = rootEnv.get(entryBinding) ?? ERROR;
    }
    if (requireQuery && root) {
        if (!selectedBinding) {
            value = ERROR;
            interpreterDiagnostics.push({
                node: root.model,
                message: entryBinding
                    ? `module has no binding named '${entryBinding}'`
                    : `a module must have at least one binding — its last binding is the module's query`,
            });
        } else if (!(value.kind === 'error') && value.kind !== 'query') {
            interpreterDiagnostics.push({
                node: selectedBinding,
                message: entryBinding
                    ? `binding '${entryBinding}' must be a query (a table or a pipeline), got ${describe(value)}`
                    : `a module's last binding must be a query (a table or a pipeline), got ${describe(value)}`,
            });
        }
    }

    const diagnostics = mergeDiagnostics(modules, interpreterDiagnostics, inferencer.diagnostics);
    return {
        value,
        diagnostics,
        nodeTypes: inferencer.nodeTypes,
        typeOf: node => inferencer.typeOf(node),
        fieldsOf: node => inferencer.fieldsOf(node),
    };
}
