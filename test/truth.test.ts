import { describe, expect, test } from 'bun:test';
import { allErrors, render, typeErrors } from './helpers.ts';

describe('SQL three-valued logic helpers', () => {
    test('isTrue/isFalse/isUnknown accept bool and nullable bool', () => {
        const src = `
            t: query { flag: (maybe bool), active: bool } = table "t"
            q = t & map (u => {
                yes = isTrue u.flag,
                no = isFalse u.flag,
                unknown = isUnknown u.flag,
                active = isTrue u.active,
            })
        `;
        expect(typeErrors(src)).toEqual([]);
        const sql = render(src, 'postgresql', 'compact');
        expect(sql).toContain('flag IS TRUE AS yes');
        expect(sql).toContain('flag IS FALSE AS no');
        expect(sql).toContain('flag IS NULL AS unknown');
        expect(sql).toContain('active IS TRUE AS active');
    });

    test('truth helpers reject non-boolean values', () => {
        const src = `
            t: query { id: int } = table "t"
            q = t & filter (u => isUnknown u.id)
        `;
        // `isUnknown` requires a bool / maybe bool argument, so the int column
        // is rejected where the mistake is: at the predicate itself, naming the
        // argument's actual type. (This used to surface indirectly as
        // `cannot apply`, because the argument was constrained to an internal
        // `truth` marker that leaked `bool?` into the enclosing row type.)
        //
        // Asserted through `allErrors` (the merged inference + interpreter path
        // that `check`/LSP render) rather than `typeErrors`: the interpreter's
        // evaluation knows the column's concrete type, so the diagnostic is
        // produced there, and `typeErrors` alone never sees a resolved row field.
        expect(allErrors(src).join('\n')).toContain('isUnknown expects a boolean or nullable boolean expression, got type int');
    });

    test('lowering is portable across the supported SQL dialects', () => {
        const src = `
            t: query { flag: (maybe bool) } = table "t"
            q = t & filter (u => isFalse u.flag || isUnknown u.flag)
        `;
        for (const dialect of ['sqlite', 'postgresql', 'mysql', 'trino', 'hive']) {
            const sql = render(src, dialect, 'compact');
            expect(sql).toContain('flag IS FALSE');
            expect(sql).toContain('flag IS NULL');
        }
    });
});
