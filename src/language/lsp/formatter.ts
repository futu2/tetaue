/******************************************************************************
 * tetaue formatter — a token-based, layout-preserving source formatter.
 *
 * Strategy: re-emit the lexer's token stream with canonical spacing and
 * bracket-depth indentation, but PRESERVE the user's line breaks (no joining
 * or splitting of lines, blank lines kept) and every token's text verbatim
 * (strings, comments and escapes are untouched). This makes the formatter
 * safe on partially-written code and idempotent.
 *
 * One deliberate exception: whitespace adjacent to `-` is preserved. Negative
 * numbers are written with parens in application position (`abs (-1)`);
 * `abs -1` and `abs - 1` both parse as subtraction, but preserving the
 * user's spacing keeps the formatter reversible on partial edits and never
 * invents or removes a space next to `-`.
 ******************************************************************************/
import { type LangiumDocument } from 'langium';
import type { Formatter } from 'langium/lsp';
import {
    type CancellationToken, type DocumentFormattingParams, type DocumentOnTypeFormattingParams,
    type DocumentRangeFormattingParams, type Position, type TextEdit,
} from 'vscode-languageserver';
import type { TetaueServices } from '../tetaue-module.js';

/** Minimal structural token type (chevrotain IToken). */
interface Tok {
    image: string;
    startOffset: number;
    endOffset?: number;
    tokenType?: { name?: string };
}

/** Continuation operators that indent a line one level when they start it. */
const CONTINUATION = new Set(['&', '$', '|', '==', '!=', '<', '<=', '>', '>=', '&&', '||', '>>>', '<<<', '*', '/', '%', '+', '-']);

/** Word-like tokens that get a space between them and their neighbors. */
const WORD_TOKEN_NAMES = new Set(['ID', 'ARG_ID', 'NUMBER', 'STRING', 'LAMBDA_PARAM']);
const WORD_KEYWORDS = new Set(['query', 'true', 'false', 'null', 'let', 'in']);

function isComment(t: Tok): boolean {
    return t.tokenType?.name === 'COMMENT';
}

function isWord(t: Tok): boolean {
    return WORD_TOKEN_NAMES.has(t.tokenType?.name ?? '') || WORD_KEYWORDS.has(t.image);
}

/** Canonical spacing between two same-line tokens; `hadSpace` is the original whitespace before `cur`. */
function spaceBetween(prev: Tok, cur: Tok, hadSpace: boolean): string {
    // `-` adjacency is preserved: a space is kept only if the user wrote one.
    if (prev.image === '-' || cur.image === '-') return hadSpace ? ' ' : '';
    if (cur.image === ',' || cur.image === '.' || cur.image === ')' || cur.image === ']' || cur.image === '?') return '';
    if (cur.image === '}') return prev.image === '{' ? '' : ' ';
    if (cur.image === '(' || cur.image === '[' || cur.image === '{') {
        return prev.image === '(' || prev.image === '[' || prev.image === '{' || prev.image === '.' ? '' : ' ';
    }
    if (cur.image === ':') return prev.image === ')' || prev.image === ']' || prev.image === '}' ? ' ' : '';
    if (isComment(cur)) return ' ';
    if (isWord(cur)) {
        return prev.image === '(' || prev.image === '[' || prev.image === '.' || prev.image === '?' ? '' : ' ';
    }
    return ' '; // operators: = & $ | => -> == != < <= > >= && || >>> <<< * / % +
}

function isName(t: Tok): boolean {
    return t.tokenType?.name === 'ID' || t.tokenType?.name === 'ARG_ID';
}

/**
 * A line that starts a new top-level statement: `import "..."` or a binding
 * `name = ...` / `name: T = ...`. Everything else — `(l => r => ...)` arguments,
 * bare names, openers — merely continues the current expression.
 */
function startsNewStatement(tokens: Tok[]): boolean {
    const first = tokens[0];
    if (!first) return false;
    if (first.image === 'import') return true;
    if (!isName(first)) return false;
    return tokens.slice(1).some(t => t.image === '=' || t.image === ':');
}

/**
 * Whether the line ends the pipeline (continuation) context. A comment line
 * only does so when the next content line starts a new statement — a comment
 * between two continuation lines stays inside the expression.
 */
function endsPipelineContext(tokens: Tok[], lines: { tokens: Tok[] }[], li: number): boolean {
    const first = tokens[0]!;
    if (!isComment(first)) return startsNewStatement(tokens);
    // A comment line ends the context only if the next CONTENT line (skipping
    // blanks and consecutive comments) starts a new statement — a comment
    // between two continuation lines stays inside the expression.
    for (let j = li + 1; j < lines.length; j++) {
        const nextLine = lines[j]!;
        const next = nextLine.tokens[0];
        if (!next || isComment(next)) continue;
        return startsNewStatement(nextLine.tokens);
    }
    return true; // comment at EOF — nothing follows, snap closed
}

/**
 * Format `text`. Returns the formatted text, or undefined when the input
 * cannot be lexed (unterminated string etc.). Line count is preserved.
 */
export function formatTetaue(text: string, indentUnit: string, services: TetaueServices): string | undefined {
    const { tokens, hidden, errors } = services.parser.Lexer.tokenize(text);
    if (errors.length > 0) return undefined;

    // Real + hidden (comment) tokens sorted by offset. Langium's lexer skips
    // whitespace, so the whitespace between two items lives in the source gap
    // between their offsets (token endOffset is inclusive).
    const all: Tok[] = [...tokens, ...hidden].sort((a, b) => a.startOffset - b.startOffset);

    // Group into lines of significant tokens (comments count as significant).
    // A gap may contain several newlines — that yields blank lines.
    const lines: { tokens: Tok[]; hadSpace: boolean[] }[] = [];
    let current: { tokens: Tok[]; hadSpace: boolean[] } = { tokens: [], hadSpace: [] };
    let prevEnd = -1;
    for (const tok of all) {
        const gap = text.slice(prevEnd + 1, tok.startOffset);
        const newlines = (gap.match(/\n/g) ?? []).length;
        if (newlines > 0) {
            lines.push(current);
            for (let k = 1; k < newlines; k++) lines.push({ tokens: [], hadSpace: [] });
            current = { tokens: [], hadSpace: [] };
        }
        current.tokens.push(tok);
        current.hadSpace.push(/\s/.test(gap));
        prevEnd = tok.endOffset ?? tok.startOffset;
    }
    lines.push(current);

    // Indentation: real bracket depth (`{ [`) plus a one-level "pipeline"
    // context that `&`-continuation lines open. The context snaps closed as
    // soon as a non-continuation line appears, so `& take 5` followed by a
    // comment/binding drops back to depth 0. `( )` never count: lambda parens
    // do not indent their bodies in tetaue's style.
    const openers = new Set(['{', '[']);
    const closers = new Set(['}', ']']);
    let depth = 0;
    let cont = false;
    const out: string[] = [];
    for (let li = 0; li < lines.length; li++) {
        const line = lines[li]!;
        const first = line.tokens[0];
        // Pipeline context: `&`-continuation lines open it; a new top-level
        // statement at depth 0 closes it. Lines that merely continue the
        // current expression — `(l => r => ...)` arguments, bare names — keep
        // it open, so multi-line `join` arguments stay indented.
        if (first) {
            if (CONTINUATION.has(first.image)) cont = true;
            else if (depth === 0 && endsPipelineContext(line.tokens, lines, li)) cont = false;
        }
        let units = depth + (cont ? 1 : 0);
        if (first) {
            if (closers.has(first.image)) units = Math.max(0, units - 1);
            else if (CONTINUATION.has(first.image)) units = Math.max(1, depth);
        }
        const indent = indentUnit.repeat(units);
        let lineText = first ? indent : ''; // blank lines stay empty
        if (first) {
            lineText += first.image;
            for (let i = 1; i < line.tokens.length; i++) {
                const prev = line.tokens[i - 1]!;
                const cur = line.tokens[i]!;
                lineText += spaceBetween(prev, cur, line.hadSpace[i]!) + cur.image;
            }
        }
        out.push(lineText);
        for (const tok of line.tokens) {
            if (openers.has(tok.image)) depth++;
            else if (closers.has(tok.image)) depth = Math.max(0, depth - 1);
        }
    }
    return out.join('\n') + (out.length > 0 ? '\n' : '');
}

export class TetaueFormatter implements Formatter {
    private readonly services: TetaueServices;

    constructor(services: TetaueServices) {
        this.services = services;
    }

    get formatOnTypeOptions(): undefined {
        return undefined;
    }

    formatDocument(document: LangiumDocument, params: DocumentFormattingParams, _cancelToken?: CancellationToken): TextEdit[] {
        return this.formatLines(document, params.options.tabSize, params.options.insertSpaces, undefined);
    }

    formatDocumentRange(document: LangiumDocument, params: DocumentRangeFormattingParams, _cancelToken?: CancellationToken): TextEdit[] {
        return this.formatLines(document, params.options.tabSize, params.options.insertSpaces, params.range);
    }

    formatDocumentOnType(document: LangiumDocument, params: DocumentOnTypeFormattingParams, _cancelToken?: CancellationToken): TextEdit[] {
        const range = { start: { line: params.position.line, character: 0 }, end: { line: params.position.line, character: Number.MAX_SAFE_INTEGER } };
        return this.formatLines(document, params.options.tabSize, params.options.insertSpaces, range);
    }

    /** Format the document and return per-line edits, optionally restricted to a range. */
    private formatLines(
        document: LangiumDocument,
        tabSize: number,
        insertSpaces: boolean,
        range: { start: Position; end: Position } | undefined,
    ): TextEdit[] {
        const text = document.textDocument.getText();
        const indentUnit = insertSpaces ? ' '.repeat(Math.max(1, tabSize)) : '\t';
        const formatted = formatTetaue(text, indentUnit, this.services);
        if (formatted === undefined) return [];

        const originalLines = text.split('\n');
        const formattedLines = formatted.split('\n');
        const edits: TextEdit[] = [];
        for (let i = 0; i < originalLines.length; i++) {
            if (range && (i < range.start.line || i > range.end.line)) continue;
            const original = originalLines[i] ?? '';
            const replacement = formattedLines[i] ?? '';
            if (original === replacement) continue;
            const lineStart = this.lineStartOffset(text, i);
            const lineEnd = lineStart + original.length;
            edits.push({
                range: {
                    start: document.textDocument.positionAt(lineStart),
                    end: document.textDocument.positionAt(lineEnd),
                },
                newText: replacement,
            });
        }
        return edits;
    }

    private lineStartOffset(text: string, line: number): number {
        let offset = 0;
        for (let i = 0; i < line; i++) {
            const nl = text.indexOf('\n', offset);
            if (nl === -1) return text.length;
            offset = nl + 1;
        }
        return offset;
    }
}
