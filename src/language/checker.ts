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
    ERROR, createPreludeEnv, describe, type Diagnostic, type Value,
} from './interpreter.js';
import { Inferencer, mergeDiagnostics } from './inference.js';
import type { Scheme, Type } from './types.js';
import { resolveImportScope } from './project-scope.js';
import type { ProjectModule, ResolvedImportEdge } from './imports.js';

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
    const nodeValues = new Map<AstNode, Value>();

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

        // Prepare BOTH sides once for this module. The type inferencer owns
        // the shared lexical scope; the value evaluator owns the runtime
        // environment. Both are advanced together per binding below.
        const typedScope = inferencer.beginModule(
            module,
            moduleImports,
            schemeExportsByModule,
            typeExportsByModule,
        ).scope;
        const scope = new Map(typedScope);

        let env = createPreludeEnv();
        const moduleBindings: Set<string> = new Set(module.model.bindings.map(b => b.name));
        const moduleDiagnostics: Diagnostic[] = [];

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

        const exports = new Map<string, Value>();
        const exportedSchemes = new Map<string, Scheme>();
        let seen = new Set<string>();
        for (const binding of module.model.bindings) {
            const result = inferencer.typedBinding(
                binding, exportedSchemes, scope, env, moduleBindings, seen, nodeValues,
            );
            moduleDiagnostics.push(...result.diagnostics);
            env = result.env;
            seen = result.seen;
            value = result.value;
            if (binding.export) {
                exports.set(binding.name, value);
            }
        }

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
        nodeValues,
        typeOf: node => inferencer.typeOf(node),
        fieldsOf: node => inferencer.fieldsOf(node),
    };
}
