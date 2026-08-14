/******************************************************************************
 * Module-qualified access helpers, shared by definition / hover / completion.
 *
 * `t.users` parses as an AccessExpression whose receiver is an Application of
 * a bare identifier with no arguments (`t` alone). These helpers unwrap that
 * shape and resolve the access against the project tree's import edges, so
 * the LSP features all agree on what `t.users` refers to.
 ******************************************************************************/
import { isApplication, isIdentifier } from '../generated/ast.js';
import type { AccessExpression, Binding } from '../generated/ast.js';
import type { ProjectModule } from '../imports.js';

/** The namespace alias the access receiver names, or undefined. */
export function moduleQualifiedReceiver(e: AccessExpression): string | undefined {
    const recv = e.receiver;
    if (isApplication(recv) && recv.arguments.length === 0 && isIdentifier(recv.func)) {
        return recv.func.name;
    }
    return undefined;
}

/** The exported binding `e.property` resolves to in the root module's tree, or undefined. */
export function moduleQualifiedBinding(e: AccessExpression, modules: ProjectModule[]): Binding | undefined {
    const alias = moduleQualifiedReceiver(e);
    if (!alias) return undefined;
    const root = modules[modules.length - 1];
    const edge = root?.imports.find(imp => imp.alias === alias);
    if (!edge) return undefined;
    return edge.target.model.bindings.find(b => b.name === e.property);
}
