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
