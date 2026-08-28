/******************************************************************************
 * Shared string helpers used by the parser-facing passes. Kept free of
 * project imports (only langium utilities) so the interpreter and
 * inference/scope layers can use them without an import cycle.
 ******************************************************************************/
import { AstUtils, type AstNode } from 'langium';

/** The escape sequences a STRING literal understands. */
const KNOWN_ESCAPES = new Set(['n', 't', 'r', '"', '\\']);

/**
 * Unescape a STRING terminal value, including the surrounding quotes. An
 * unknown escape (`\p`, `\q`, `\{`, ...) is kept verbatim — the language has
 * no string interpolation — but reported as a warning through the shared
 * escape-warning collector so the CLI and LSP can surface it. The language's
 * own tooling (`\{u.name}`-style expectations, escaping helpers) never emits
 * unknown escapes, so a warning here is always a user typo or a
 * misremembered feature.
 */
const escapeWarnings: string[] = [];

/** Unknown-escape warnings collected by the most recent parse; drained by `takeStringEscapeWarnings`. */
export function takeStringEscapeWarnings(): string[] {
    const out = escapeWarnings.slice();
    escapeWarnings.length = 0;
    return out;
}

/**
 * Escape warnings anchored to the StringLiteral nodes of one module: walks the
 * AST, re-unescapes each literal against a drained collector, and reports each
 * warning on its own node. Shared by the CLI (attaching `severity: warning`
 * diagnostics to the compile result) and the LSP validator.
 */
export function stringEscapeWarningsFor(model: AstNode): { node: AstNode; message: string }[] {
    const out: { node: AstNode; message: string }[] = [];
    for (const node of AstUtils.streamAst(model)) {
        if ((node as { $type?: string }).$type !== 'StringLiteral') continue;
        takeStringEscapeWarnings();
        parseStringLiteral((node as unknown as { value: string }).value);
        for (const message of takeStringEscapeWarnings()) {
            out.push({ node, message });
        }
    }
    return out;
}

export function parseStringLiteral(raw: string): string {
    const inner = raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
    let out = '';
    for (let i = 0; i < inner.length; i++) {
        const ch = inner[i]!;
        if (ch === '\\' && i + 1 < inner.length) {
            const next = inner[i + 1]!;
            i++;
            if (KNOWN_ESCAPES.has(next)) {
                switch (next) {
                    case 'n': out += '\n'; break;
                    case 't': out += '\t'; break;
                    case 'r': out += '\r'; break;
                    case '"': out += '"'; break;
                    case '\\': out += '\\'; break;
                }
            } else {
                out += '\\' + next; // unknown escapes are preserved verbatim
                escapeWarnings.push(`unknown escape '\\${next}' in a string literal — supported: \\n \\t \\r \\" \\\\`);
            }
        } else {
            out += ch;
        }
    }
    return out;
}

/**
 * Decode a grammar label token that may be either a plain identifier or a
 * STRING literal (`"weird name"`). Plain identifiers pass through unchanged.
 */
export function labelName(raw: string): string {
    return raw.startsWith('"') ? parseStringLiteral(raw) : raw;
}

/**
 * `this` / `that` are the FIRST and SECOND implicit lambda parameters:
 * `filter (this.active)` means `u => u.active` and
 * `joinInner orders (this.id == that.user_id) { ... }` means
 * `(u, v) => u.id == v.user_id` (the only two implicit parameters — there is
 * no `$3`-style positional sugar). They resolve like any identifier when a
 * binding of the same name is in scope, so they stay usable as ordinary names
 * when shadowed. Internally the parameters are named `$1`/`$2`.
 */
export const IMPLICIT_PARAM_SUGAR: ReadonlyMap<string, string> = new Map([
    ['this', '$1'],
    ['that', '$2'],
]);

/** The internal param an identifier names via `this`/`that` sugar, if any. */
export function implicitParamName(name: string): string | undefined {
    return IMPLICIT_PARAM_SUGAR.get(name);
}
