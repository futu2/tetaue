/******************************************************************************
 * Shared string helpers used by the parser-facing passes. Kept dependency-free
 * so both the interpreter and inference/scope layers can use them without an
 * import cycle.
 ******************************************************************************/

/** Unescape a STRING terminal value, including the surrounding quotes. */
export function parseStringLiteral(raw: string): string {
    const inner = raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
    let out = '';
    for (let i = 0; i < inner.length; i++) {
        const ch = inner[i]!;
        if (ch === '\\' && i + 1 < inner.length) {
            const next = inner[i + 1]!;
            i++;
            switch (next) {
                case 'n': out += '\n'; break;
                case 't': out += '\t'; break;
                case 'r': out += '\r'; break;
                case '"': out += '"'; break;
                case '\\': out += '\\'; break;
                default: out += '\\' + next; // unknown escapes are preserved verbatim
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
