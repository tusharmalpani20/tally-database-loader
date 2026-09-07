import fs from 'node:fs';
import yaml from 'js-yaml';
import { Client } from 'pg';
import { HttpTallyTransport } from './tally-transport.mjs';
import { applyOrderBackfill, checkOrderSchema, withOrderImportLock } from './order-store.mjs';
import { parseOrderVouchers } from './order-details.mjs';
import { generateXMLfromYAML, substituteTDLParameters, dropUnresolvedStaticVariables, withAdditionalFilters } from './yaml-report-exporter.mjs';
export function backfillDefinition(table, guids) {
    if (!table.order_details || table.name !== 'trn_voucher')
        throw new Error('Select the order-detail voucher profile');
    if (!guids.length || guids.length > 50 || new Set(guids).size !== guids.length
        || guids.some(guid => !/^[a-zA-Z0-9-]{1,64}$/.test(guid))) {
        throw new Error('Provide 1–50 distinct voucher GUIDs (letters, digits, hyphens)');
    }
    return withAdditionalFilters(table, [`(${guids.map(guid => `$Guid = "${guid}"`).join(' OR ')})`]);
}
export async function backfillOrders(config, guids, apply = false) {
    if (config.database.technology !== 'postgres' || !config.tally.company) {
        throw new Error('Order backfill requires PostgreSQL and an explicit company');
    }
    const definition = yaml.load(fs.readFileSync(config.tally.definition, 'utf8'));
    const sourceTable = definition.transaction.find(table => table.name === 'trn_voucher');
    if (!sourceTable)
        throw new Error('No voucher definition');
    const table = backfillDefinition(sourceTable, guids);
    return withOrderImportLock(config.database, async () => {
        const client = new Client({ host: config.database.server, port: config.database.port || 5432,
            database: config.database.schema, user: config.database.username, password: config.database.password,
            ssl: config.database.ssl ? { rejectUnauthorized: false } : false, connectionTimeoutMillis: 10000 });
        await client.connect();
        try {
            await checkOrderSchema(client, config.tally.company);
            const metadata = await client.query("select name,value from public.config where name in ('Company Name','Period From','Period To')");
            const values = Object.fromEntries(metadata.rows.map(row => [row.name, row.value]));
            if (values['Company Name'] !== config.tally.company
                || !/^\d{4}-\d{2}-\d{2}$/.test(values['Period From'] || '')
                || !/^\d{4}-\d{2}-\d{2}$/.test(values['Period To'] || '')) {
                throw new Error('Backfill requires existing matching company and period metadata');
            }
            const request = dropUnresolvedStaticVariables(substituteTDLParameters(generateXMLfromYAML(table), new Map([['targetCompany', config.tally.company],
                ['fromDate', values['Period From'].replaceAll('-', '')],
                ['toDate', values['Period To'].replaceAll('-', '')]])));
            const response = await new HttpTallyTransport(config.tally).post(request);
            const rows = parseOrderVouchers(response, table, config.tally.company);
            if (rows.some(row => !guids.includes(row.guid)))
                throw new Error('Backfill returned an unrequested voucher');
            const missing = guids.filter(guid => !rows.some(row => row.guid === guid));
            if (!apply) {
                const stored = await client.query('select guid,alterid from public.trn_voucher where guid=any($1::text[])', [guids]);
                return { mode: 'preview', missing, vouchers: rows.map(row => ({ guid: row.guid,
                        alterid: row.alterid, order_details: row.order_details, order_number: row.order_number,
                        revision_matches: stored.rows.filter(value => value.guid === row.guid && value.alterid === row.alterid).length === 1 })) };
            }
            return { mode: 'apply', missing, ...await applyOrderBackfill(client, rows, config.tally.company) };
        }
        finally {
            await client.end();
        }
    });
}
//# sourceMappingURL=order-backfill.mjs.map