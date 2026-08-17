/** Operators that have dedicated infix syntax in the core grammar. */
export const BINARY_OPERATORS = [
    '>>>', '<<<', '*', '/', '+', '-', '<>',
    '==', '!=', '<', '<=', '>', '>=',
    '&&', '||', '&', '$',
] as const;

export type BinaryOperator = (typeof BINARY_OPERATORS)[number];

/**
 * SQL-aware primitive behind each public prelude operator binding. These names
 * are deliberately absent from the builtin catalog: they exist only so the
 * checked `prelude.tetaue` module can define `_+_`, `_>>>_`, and friends.
 */
export const OPERATOR_INTRINSICS: Readonly<Record<BinaryOperator, string>> = {
    '>>>': '__op_compose_forward',
    '<<<': '__op_compose_backward',
    '*': '__op_multiply',
    '/': '__op_divide',
    '+': '__op_add',
    '-': '__op_subtract',
    '<>': '__op_merge',
    '==': '__op_equal',
    '!=': '__op_not_equal',
    '<': '__op_less_than',
    '<=': '__op_less_than_or_equal',
    '>': '__op_greater_than',
    '>=': '__op_greater_than_or_equal',
    '&&': '__op_and',
    '||': '__op_or',
    '&': '__op_pipeline',
    '$': '__op_apply',
};

const OPERATOR_INTRINSIC_NAMES: ReadonlySet<string> = new Set(Object.values(OPERATOR_INTRINSICS));

const BINARY_OPERATOR_SET: ReadonlySet<string> = new Set(BINARY_OPERATORS);

export function isBinaryOperator(value: string): value is BinaryOperator {
    return BINARY_OPERATOR_SET.has(value);
}

export function operatorIntrinsicName(operator: BinaryOperator): string {
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
