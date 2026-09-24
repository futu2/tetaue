import {
    BUILTIN_ALIASES, BUILTIN_SPECS,
    type BuiltinName, type BuiltinSpec, type Lowering,
} from '../builtin.js';
import type { DialectSpec } from './dialects.js';

/** Special SQL lowerings keyed by the name stored in the IR. */
const LOWERINGS: ReadonlyMap<string, Lowering> = (() => {
    const map = new Map<string, Lowering>();
    const specs: readonly BuiltinSpec[] = BUILTIN_SPECS;
    for (const spec of specs) {
        if (spec.lower) map.set(spec.name, spec.lower);
    }
    for (const [alias, target] of Object.entries(BUILTIN_ALIASES)) {
        const lower = map.get(target);
        if (lower) map.set(alias, lower);
    }
    return map;
})();

/** SQL names for builtins whose spelling is not their upper-cased SQL name. */
const SQL_NAMES: ReadonlyMap<string, string> = (() => {
    const map = new Map<string, string>();
    const specs: readonly BuiltinSpec[] = BUILTIN_SPECS;
    for (const spec of specs) {
        if (spec.sqlName) map.set(spec.name, spec.sqlName);
    }
    for (const [alias, target] of Object.entries(BUILTIN_ALIASES)) {
        const sqlName = map.get(target);
        if (sqlName) map.set(alias, sqlName);
    }
    return map;
})();

export function loweringFor(name: string): Lowering | undefined {
    return LOWERINGS.get(name);
}

export function defaultSqlName(name: string, dialect: DialectSpec): string {
    return dialect.functions[name as BuiltinName] ?? SQL_NAMES.get(name) ?? name.toUpperCase();
}
