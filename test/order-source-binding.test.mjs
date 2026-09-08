import test from 'node:test';
import assert from 'node:assert/strict';
import { applyOrderBackfill, checkOrderCompanyGuid } from '../dist/order-store.mjs';

const guid = '11111111-2222-3333-4444-555555555555';

test('source binding rejects mismatches and duplicates without creating a binding', async () => {
    for (const rows of [[], [{ value: guid.toUpperCase() }]]) {
        await checkOrderCompanyGuid({ query: async () => ({ rows }) }, guid);
    }
    for (const rows of [[{ value: 'other' }], [{ value: guid }, { value: guid }]]) {
        await assert.rejects(checkOrderCompanyGuid({ query: async () => ({ rows }) }, guid), /source binding/);
    }
});

test('backfill rechecks source binding inside publication transaction before any update', async () => {
    const calls = [];
    const client = { query: async sql => {
        calls.push(sql);
        if (sql.includes("name='Company Name'")) return { rows: [{ value: 'Fixture' }] };
        if (sql.includes('information_schema.columns')) return { rows: [
            { column_name: 'order_details', data_type: 'jsonb' },
            { column_name: 'order_number', data_type: 'text' }
        ] };
        if (sql.includes("name='Company GUID'")) return { rows: [{ value: 'different-source' }] };
        return { rows: [] };
    } };
    await assert.rejects(applyOrderBackfill(client, [{ guid: 'voucher', alterid: 1,
        order_details: [], order_number: null, values: [] }], 'Fixture', guid), /source binding/);
    assert.equal(calls[0], 'begin');
    assert.equal(calls.at(-1), 'rollback');
    assert.ok(!calls.some(sql => /update public|commit/.test(sql)));
});
