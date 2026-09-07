import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from 'pg';
import { ORDER_SCHEMA_SQL, applyOrderBackfill, checkOrderSchema, findRemovedOrderHeaders, publishVoucherHeaders, withOrderImportLock } from '../dist/order-store.mjs';

const socket = process.env.KUNAL_ORDER_TEST_PG_SOCKET;
test('isolated PostgreSQL migration, publication, rollback, backfill and lock', { skip: !socket }, async () => {
    // Only an explicitly selected temporary Unix socket and a fixed test database are allowed.
    assert.match(socket, /^\/tmp\/ke-order-pg\.[a-zA-Z0-9]+$/);
    const options = { host: socket, port: 55439, database: 'ke_order_test', user: process.env.USER };
    const client = new Client(options);
    await client.connect();
    try {
        await client.query('create table public.config(name text,value text); create table public.trn_voucher(guid text primary key,alterid integer not null,quantity numeric not null)');
        await client.query("insert into public.config values ('Company Name','Fixture Co'),('Last AlterID Transaction','10'); insert into public.trn_voucher values ('fixture',10,4)");
        await client.query(ORDER_SCHEMA_SQL);
        await client.query(ORDER_SCHEMA_SQL);
        const details = [{ order_number: 'SO-1', order_date: '2026-09-02' }];
        const row = { guid: 'fixture', alterid: 10, order_details: details, order_number: 'SO-1' };
        assert.deepEqual(await applyOrderBackfill(client, [row], 'Fixture Co'), { updated: 1, skipped: [] });
        assert.deepEqual(await applyOrderBackfill(client, [{ ...row, alterid: 9 }], 'Fixture Co'), { updated: 0, skipped: ['fixture'] });
        await assert.rejects(applyOrderBackfill(client, [{ ...row, order_number: 'inconsistent' }], 'Fixture Co'), /Invalid backfill/);
        await assert.rejects(applyOrderBackfill(client, [row, row], 'Fixture Co'), /Invalid backfill/);
        await assert.rejects(applyOrderBackfill(client, [row], 'Wrong Co'), /company/);
        let stored = (await client.query('select * from public.trn_voucher')).rows[0];
        assert.equal(stored.quantity, '4');
        assert.equal(stored.order_number, 'SO-1');
        assert.deepEqual(stored.order_details, details);
        await client.query("delete from public.config where name='Company Name'");
        await assert.rejects(checkOrderSchema(client, 'Fixture Co'), /metadata is missing/);
        await client.query("insert into public.config values ('Company Name','Fixture Co')");
        const table = { name: 'trn_voucher', fields: ['guid', 'alterid', 'quantity', 'order_details', 'order_number'].map(name => ({ name, type: 'text' })) };
        const header = table.fields.map(field => field.name).join('\t');
        // Failed insert must restore both a staged deletion and the old accepted header.
        await assert.rejects(publishVoucherHeaders(client, table, `${header}\nfixture\t11\tbad-number\t[]\t`, [{ guid: 'fixture', alterid: 10 }]));
        stored = (await client.query('select * from public.trn_voucher')).rows[0];
        assert.equal(stored.alterid, 10);
        assert.equal(stored.order_number, 'SO-1');
        await assert.rejects(publishVoucherHeaders(client, table, `${header}\nfixture\t9\t2\t[]\t`), /older/);
        await assert.rejects(publishVoucherHeaders(client, table, `${header}\nfixture\t9\t2\t[]\t`, [{ guid: 'fixture', alterid: 10 }]), /older/);
        await assert.rejects(publishVoucherHeaders(client, table, `${header}\nfixture\t11\t2\tnull\t`), /extracted list/);
        await assert.rejects(publishVoucherHeaders(client, table, `${header}\nfixture\t11\t2\t[]\twrong`), /Inconsistent/);
        await assert.rejects(publishVoucherHeaders(client, table, `${header}\nfixture\t11\t2\t[]\t\nfixture\t12\t3\t[]\t`), /duplicate/);
        await assert.rejects(publishVoucherHeaders(client, table, `${header}\nfixture\t12\t2\t[]\t`, [], { after: 10, through: 11 }), /AlterID window/);
        await assert.rejects(publishVoucherHeaders(client, table, `${header}\nfixture\t10\t2\t[]\t`, [], { after: 10, through: 11 }), /AlterID window/);
        await publishVoucherHeaders(client, table, `${header}\nfixture\t11\t6\t[]\t`);
        stored = (await client.query('select * from public.trn_voucher')).rows[0];
        assert.equal(stored.quantity, '6');
        assert.deepEqual(stored.order_details, []);
        assert.equal(stored.order_number, null);
        await client.query('create temporary table _diff(guid text,alterid integer)');
        await client.query("insert into _diff values ('fixture',12)");
        assert.deepEqual(await findRemovedOrderHeaders(client, 11), []);
        assert.deepEqual(await findRemovedOrderHeaders(client, 12), [{ guid: 'fixture', alterid: 11 }]);
        await client.query('update _diff set alterid=10');
        await assert.rejects(findRemovedOrderHeaders(client, 12), /backwards/);
        await client.query("update _diff set alterid=12; insert into _diff values ('fixture',12)");
        await assert.rejects(findRemovedOrderHeaders(client, 12), /duplicate/);
        await client.query('truncate _diff');
        assert.deepEqual(await findRemovedOrderHeaders(client, 12), [{ guid: 'fixture', alterid: 11 }]);
        await publishVoucherHeaders(client, table, header, [{ guid: 'fixture', alterid: 11 }]);
        assert.equal((await client.query('select * from public.trn_voucher')).rowCount, 0);
        assert.equal((await client.query("select value from public.config where name='Last AlterID Transaction'")).rows[0].value, '10');
        const config = { technology: 'postgres', server: socket, port: 55439, schema: 'ke_order_test', username: options.user, ssl: false };
        await withOrderImportLock(config, () => assert.rejects(withOrderImportLock(config, async () => {}), /Another loader/));
        await withOrderImportLock(config, async () => {});
        await assert.rejects(withOrderImportLock(config, async () => {
            const lock = await client.query("select pid from pg_stat_activity where datname='ke_order_test' and application_name='tally-order-import-lock'");
            assert.equal(lock.rowCount, 1);
            await client.query('select pg_terminate_backend($1)', [lock.rows[0].pid]);
            await new Promise(resolve => setTimeout(resolve, 50));
            await assert.rejects(publishVoucherHeaders(client, table, header), /lock connection was lost/);
        }), /lock connection was lost/);
        await withOrderImportLock(config, async () => {});
    } finally {
        await client.query('drop table if exists public.trn_voucher; drop table if exists public.config');
        await client.end();
    }
});
