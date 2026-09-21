/** Operators that have dedicated infix syntax in the core grammar. */
export const BINARY_OPERATORS = [
    '>>>', '<<<', '<$>', '<$', '<*', '*>', '<*>', '<|>', '>>=', '>>',
    '*', '/', '+', '-', '<>',
    '==', '!=', '<', '<=', '>', '>=',
    '&&', '||', '?', '&', '$',
] as const;

export type BinaryOperator = (typeof BINARY_OPERATORS)[number];

/**
 * SQL-aware primitive behind each public prelude operator binding. These names
 * are deliberately distinct from the public ones, so a module can shadow `+`
 * without touching the intrinsic: the checked `prelude.tetaue` module binds
 * `_+_` and friends to them. They are spelled WITHOUT a `@` prefix so they
 * lex as ordinary identifiers (an `@` would be a lexer error), and the
 * public `_*_` section name never collides with them.
 * Operators expressible as ordinary lambdas (`>>>`, `<<<`, `&`, `$`) have no
 * core intrinsic.
 */
export const OPERATOR_INTRINSICS = {
    '*': 'op_multiply',
    '/': 'op_divide',
    '+': 'op_add',
    '-': 'op_subtract',
    '<>': 'op_merge',
    '==': 'op_equal',
    '!=': 'op_not_equal',
    '<': 'op_less_than',
    '<=': 'op_less_than_or_equal',
    '>': 'op_greater_than',
    '>=': 'op_greater_than_or_equal',
    '&&': 'op_and',
    '||': 'op_or',
} as const satisfies Partial<Record<BinaryOperator, string>>;

export type IntrinsicOperator = keyof typeof OPERATOR_INTRINSICS;

export const INTRINSIC_OPERATORS = Object.keys(OPERATOR_INTRINSICS) as IntrinsicOperator[];

const OPERATOR_INTRINSIC_NAMES: ReadonlySet<string> = new Set(Object.values(OPERATOR_INTRINSICS));

const BINARY_OPERATOR_SET: ReadonlySet<string> = new Set(BINARY_OPERATORS);

export function isBinaryOperator(value: string): value is BinaryOperator {
    return BINARY_OPERATOR_SET.has(value);
}

export function isIntrinsicOperator(operator: BinaryOperator): operator is IntrinsicOperator {
    return operator in OPERATOR_INTRINSICS;
}

export function operatorIntrinsicName(operator: IntrinsicOperator): string {
    return OPERATOR_INTRINSICS[operator];
}

export function isOperatorIntrinsicName(value: string): boolean {
    return OPERATOR_INTRINSIC_NAMES.has(value);
}

/** `_+_` -> `+`, `_>>>_` -> `>>>`, `_name_` -> `name`. */
export function sectionName(value: string): string {
    return value.slice(1, -1);
}

export function sectionSpelling(name: string): string {
    return `_${name}_`;
}
