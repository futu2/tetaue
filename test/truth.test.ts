import { describe, expect, test } from 'bun:test';
import { render, typeErrors } from './helpers.ts';

describe('SQL three-valued logic helpers', () => {
    test('is_true/is_false/is_unknown accept bool and nullable bool', () => {
        const src = `
            t: query { flag: (maybe bool), active: bool } = table "t"
            q = t & map (u => {
                yes = is_true u.flag,
                no = is_false u.flag,
                unknown = is_unknown u.flag,
                active = is_true u.active,
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
            q = t & filter (u => is_unknown u.id)
        `;
        // The row-polymorphic lambda is constrained to the internal `truth`
        // type, then rejected when it is applied to the annotated int row.
        expect(typeErrors(src).join('\n')).toContain('cannot apply');
    });

    test('lowering is portable across the supported SQL dialects', () => {
        const src = `
            t: query { flag: (maybe bool) } = table "t"
            q = t & filter (u => is_false u.flag || is_unknown u.flag)
        `;
        for (const dialect of ['sqlite', 'postgresql', 'mysql', 'trino', 'hive']) {
            const sql = render(src, dialect, 'compact');
            expect(sql).toContain('flag IS FALSE');
            expect(sql).toContain('flag IS NULL');
        }
    });
});
