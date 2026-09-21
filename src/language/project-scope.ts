/******************************************************************************
 * project-scope — the single scoping/import-resolution pass shared by the
 * interpreter and the type inference pass.
 *
 * Both passes used to duplicate import selection, namespace handling, and
 * collision diagnostics. They now call `resolveImportScope`, which computes:
 *
 *   - the flat bindings brought into a module's environment
 *   - the namespace aliases (`import "x" as t`)
 *   - diagnostics with the exact wording both passes agree on
 *
 * The function is generic in the exported value type: the interpreter passes
 * runtime `Value`s, inference passes `Scheme`s.
 ******************************************************************************/
import type { ProjectModule, ResolvedImportEdge } from './imports.js';
import type { Diagnostic } from './interpreter.js';
import { parseStringLiteral } from './strings.js';

export interface ImportScope<T> {
    /** Flat bindings in source order (later imports do not silently shadow). */
    flat: ReadonlyMap<string, T>;
    /** Namespace alias -> exported bindings of the target module. */
    namespaces: ReadonlyMap<string, ReadonlyMap<string, T>>;
    /** Every name bound by imports/aliases, for local-binding collision checks. */
    scope: ReadonlyMap<string, string>;
    diagnostics: Diagnostic[];
}

function conflictMessage(name: string, existing: string, newcomer: string): string {
    return `name '${name}' (${newcomer}) conflicts with ${existing}`;
}

/**
 * Resolve one module's imports against already-evaluated exports. Modules are
 * processed in import order, so \`exportsByModule\` contains every target that
 * was reached earlier.
 */
export function resolveImportScope<T>(
    module: ProjectModule,
    imports: readonly ResolvedImportEdge[],
    exportsByModule: ReadonlyMap<ProjectModule, ReadonlyMap<string, T>>,
): ImportScope<T> {
    const flat = new Map<string, T>();
    const namespaces = new Map<string, ReadonlyMap<string, T>>();
    const diagnostics: Diagnostic[] = [];
    // `scope` tracks every name this module has bound (imports, aliases, then
    // local bindings) so collisions are errors, never silent shadowing.
    const scope = new Map<string, string>();

    for (const { alias, target, importNode } of imports) {
        const targetExports = exportsByModule.get(target);
        if (!targetExports) continue; // cyclic/missing target — already diagnosed
        const spec = parseStringLiteral(importNode.path);

        // A selective name list `(users, orders as sales)` restricts what is
        // visible to exactly those exports; every listed name must be
        // exported. `a as b` brings `a` into scope under local name `b`.
        let selected: ReadonlyMap<string, T> = targetExports;
        if (importNode.names && importNode.names.length > 0) {
            for (const item of importNode.names) {
                if (!targetExports.has(item.name)) {
                    const keys = [...targetExports.keys()];
                    diagnostics.push({
                        node: importNode,
                        message: `'${item.name}' is not exported by '${spec}' — exported: ${keys.length > 0 ? keys.join(', ') : '(none)'}`,
                    });
                }
            }
            selected = new Map(
                importNode.names
                    .filter(item => targetExports.has(item.name))
                    .map(item => [item.renamed ?? item.name, targetExports.get(item.name)!]),
            );
        }

        if (alias !== undefined) {
            if (scope.has(alias)) {
                diagnostics.push({ node: importNode, message: conflictMessage(alias, scope.get(alias)!, 'import alias') });
                continue;
            }
            scope.set(alias, `import alias '${alias}'`);
            namespaces.set(alias, selected);
        } else {
            for (const [name, value] of selected) {
                if (scope.has(name)) {
                    diagnostics.push({
                        node: importNode,
                        message: conflictMessage(name, scope.get(name)!, `imported from '${spec}'`),
                    });
                    continue;
                }
                scope.set(name, `'${name}' imported from '${spec}'`);
                flat.set(name, value);
            }
        }
    }

    return { flat, namespaces, scope, diagnostics };
}
