import { Client } from 'pg';
import { AsyncLocalStorage } from 'node:async_hooks';
import { quoteIdentifier } from './postgres-columns.mjs';
import { resolveOrderNumber, validateOrderDetails } from './order-details.mjs';
export const ORDER_SCHEMA_SQL = `alter table public.trn_voucher add column if not exists order_details jsonb;
alter table public.trn_voucher add column if not exists order_number text;`;
const importLockState = new AsyncLocalStorage();
export function assertOrderImportLock() {
    const error = importLockState.getStore()?.error;
    if (error)
        throw new Error('PostgreSQL import lock connection was lost; refusing publication', { cause: error });
}
export async function withOrderImportLock(config, action) {
    if (config.technology !== 'postgres')
        return action();
    const client = new Client({ host: config.server, port: config.port || 5432, database: config.schema,
        user: config.username, password: config.password, ssl: config.ssl ? { rejectUnauthorized: false } : false,
        keepAlive: true, keepAliveInitialDelayMillis: 10000,
        connectionTimeoutMillis: 10000, query_timeout: 10000, application_name: 'tally-order-import-lock' });
    const state = {};
    client.on('error', error => { state.error = error; });
    let heartbeat;
    try {
        await client.connect();
        const result = await client.query("select pg_try_advisory_lock(hashtext('tally:order-import')) as acquired");
        if (!result.rows[0].acquired)
            throw new Error('Another loader or order backfill is running');
        let checking = false;
        heartbeat = setInterval(async () => {
            if (checking || state.error)
                return;
            checking = true;
            try {
                await client.query('select 1');
            }
            catch (error) {
                state.error = error instanceof Error ? error : new Error(String(error));
            }
            finally {
                checking = false;
            }
        }, 15000);
        heartbeat.unref();
        return await importLockState.run(state, async () => {
            const result = await action();
            assertOrderImportLock();
            return result;
        });
    }
    finally {
        if (heartbeat)
            clearInterval(heartbeat);
        await client.end(); // Session lock is released even on failure.
    }
}
export async function checkOrderSchema(client, company) {
    if (!company)
        throw new Error('Order import requires an explicit Tally company');
    const source = await client.query("select value from public.config where name='Company Name'");
    if (source.rows.length > 1 || (source.rows.length && source.rows[0].value !== company))
        throw new Error('Tally company does not match PostgreSQL');
    if (!source.rows.length) {
        const existing = await client.query('select exists(select 1 from public.trn_voucher) as populated');
        if (existing.rows[0].populated)
            throw new Error('Company metadata is missing from a populated voucher mirror');
    }
    const columns = await client.query("select column_name,data_type from information_schema.columns where table_schema='public' and table_name='trn_voucher' and column_name in ('order_details','order_number')");
    const types = Object.fromEntries(columns.rows.map(row => [row.column_name, row.data_type]));
    if (types.order_details !== 'jsonb' || types.order_number !== 'text') {
        throw new Error('Apply migrations/postgres-voucher-order-details.sql before importing order details');
    }
}
export async function findRemovedOrderHeaders(client, checkpoint) {
    if (!Number.isSafeInteger(checkpoint) || checkpoint < 0)
        throw new Error('Invalid voucher diff checkpoint');
    const invalid = await client.query(`select 1 from _diff where guid is null or guid='' or alterid is null or alterid<0
        union all select 1 from _diff group by guid having count(*)>1
        union all select 1 from _diff d join public.trn_voucher v on v.guid=d.guid where d.alterid<v.alterid limit 1`);
    if (invalid.rowCount)
        throw new Error('Invalid, duplicate, or backwards voucher diff identity');
    const result = await client.query(`select v.guid,v.alterid from public.trn_voucher v
        where not exists (select 1 from _diff d where d.guid=v.guid)
        or exists (select 1 from _diff d where d.guid=v.guid and d.alterid>v.alterid and d.alterid<=$1)`, [checkpoint]);
    return result.rows;
}
export async function publishVoucherHeaders(client, table, data, removed = [], bounds) {
    if (bounds && (!Number.isSafeInteger(bounds.after) || !Number.isSafeInteger(bounds.through)
        || bounds.after < 0 || bounds.through < bounds.after))
        throw new Error('Invalid voucher AlterID window');
    const names = table.fields.map(field => field.name);
    if (table.name !== 'trn_voucher' || new Set(names).size !== names.length
        || !['guid', 'alterid', 'order_details', 'order_number'].every(name => names.includes(name))) {
        throw new Error('Invalid voucher publication definition');
    }
    const seen = new Set();
    const [header, ...lines] = data.replace(/^\uFEFF/, '').split(/\r?\n/);
    if (header !== table.fields.map(field => field.name).join('\t'))
        throw new Error('Voucher data columns differ from definition');
    const rows = lines.filter(Boolean).map(line => {
        const values = line.split('\t');
        if (values.length !== table.fields.length)
            throw new Error('Voucher data column count mismatch');
        const guid = values[names.indexOf('guid')];
        const revision = values[names.indexOf('alterid')];
        if (!guid || seen.has(guid) || !/^\d+$/.test(revision) || !Number.isSafeInteger(Number(revision))) {
            throw new Error('Missing, duplicate, or invalid voucher identity');
        }
        seen.add(guid);
        if (bounds && (Number(revision) <= bounds.after || Number(revision) > bounds.through)) {
            throw new Error('Voucher revision is outside the requested AlterID window');
        }
        const details = JSON.parse(values[names.indexOf('order_details')]);
        validateOrderDetails(details);
        const number = resolveOrderNumber(details);
        if (values[names.indexOf('order_number')] !== (number || ''))
            throw new Error('Inconsistent voucher order number');
        values[names.indexOf('order_number')] = number;
        return values.map((value, index) => table.fields[index].type === 'date' && value === 'ñ' ? null : value);
    });
    const columns = table.fields.map(field => quoteIdentifier(field.name));
    assertOrderImportLock();
    await client.query('begin');
    try {
        // A transaction protects headers and their order collection together. Generic diff deletion
        // is deferred until after the complete structured response has been validated.
        for (const row of removed) {
            assertOrderImportLock();
            // Replacement identities must remain present for the revision check below.
            if (seen.has(row.guid))
                continue;
            await client.query('delete from public.trn_voucher where guid=$1 and alterid=$2', [row.guid, row.alterid]);
        }
        for (const values of rows) {
            assertOrderImportLock();
            const guid = values[table.fields.findIndex(field => field.name === 'guid')];
            const revision = Number(values[table.fields.findIndex(field => field.name === 'alterid')]);
            const previous = await client.query('select alterid from public.trn_voucher where guid=$1 for update', [guid]);
            if (previous.rows.some(row => row.alterid > revision))
                throw new Error('Refusing an older voucher header');
            await client.query('delete from public.trn_voucher where guid=$1', [guid]);
            await client.query(`insert into public.trn_voucher (${columns.join(',')}) values (${values.map((_, index) => `$${index + 1}`).join(',')})`, values);
        }
        assertOrderImportLock();
        await client.query('commit');
    }
    catch (error) {
        await client.query('rollback');
        throw error;
    }
}
export async function applyOrderBackfill(client, rows, company) {
    assertOrderImportLock();
    const seen = new Set();
    for (const row of rows) {
        validateOrderDetails(row.order_details);
        if (!row.guid || seen.has(row.guid) || !Number.isSafeInteger(row.alterid) || row.alterid < 0
            || resolveOrderNumber(row.order_details) !== row.order_number)
            throw new Error('Invalid backfill voucher');
        seen.add(row.guid);
    }
    let updated = 0;
    const skipped = [];
    await client.query('begin');
    try {
        await checkOrderSchema(client, company);
        for (const row of rows) {
            assertOrderImportLock();
            const result = await client.query(`update public.trn_voucher
                set order_details=$1::jsonb,order_number=$2 where guid=$3 and alterid=$4`, [JSON.stringify(row.order_details), row.order_number, row.guid, row.alterid]);
            if (result.rowCount === 1)
                updated++;
            else if (result.rowCount === 0)
                skipped.push(row.guid);
            else
                throw new Error('Duplicate voucher GUID during backfill');
        }
        assertOrderImportLock();
        await client.query('commit');
        return { updated, skipped };
    }
    catch (error) {
        await client.query('rollback');
        throw error;
    }
}
//# sourceMappingURL=order-store.mjs.map