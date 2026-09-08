import fs from 'node:fs';
import yaml from 'js-yaml';
import { Client } from 'pg';
import { directOrderRequest, parseDirectOrderResponse, validateDirectOrderIdentity } from './direct-order-protocol.mjs';
import { HttpTallyTransport } from './tally-transport.mjs';
import { applyOrderBackfill, checkOrderSchema, withOrderImportLock } from './order-store.mjs';
import { BackfillDiagnostics, fetchBackfillVouchers } from './backfill-diagnostics.mjs';
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
export function backfillPeriod(rows, company) {
    const value = (name) => {
        const matches = rows.filter(row => row.name === name);
        if (matches.length !== 1 || typeof matches[0].value !== 'string')
            throw new Error(`Missing or ambiguous backfill metadata: ${name}`);
        return matches[0].value;
    };
    if (!company || value('Company Name') !== company)
        throw new Error('Backfill company metadata does not match');
    const from = value('Period From'), to = value('Period To');
    for (const date of [from, to]) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date.startsWith('0000-') || !Number.isFinite(Date.parse(date))
            || new Date(date).toISOString().slice(0, 10) !== date)
            throw new Error('Invalid backfill export period');
    }
    if (from > to)
        throw new Error('Backfill export period is reversed');
    return { from, to };
}
export async function backfillOrders(config, guids, apply = false, options = {}) {
    const diagnostics = new BackfillDiagnostics({ ...options, secrets: [...(options.secrets || []), config.database.password || ''] });
    diagnostics.log(`Starting ${apply ? 'APPLY' : 'PREVIEW'} for ${guids.length} requested voucher(s).`);
    try {
        if (config.database.technology !== 'postgres' || !config.tally.company) {
            throw new Error('Order backfill requires PostgreSQL and an explicit company');
        }
        const definition = yaml.load(fs.readFileSync(config.tally.definition, 'utf8'));
        const candidates = Array.isArray(definition?.transaction) ? definition.transaction.filter(table => table?.name === 'trn_voucher') : [];
        if (candidates.length !== 1)
            throw new Error('Select exactly one voucher definition');
        const sourceTable = candidates[0];
        const table = backfillDefinition(sourceTable, guids);
        if (options.masterId !== undefined && (guids.length !== 1 || !/^[1-9]\d{0,9}$/.test(options.masterId))) {
            throw new Error('--master-id requires exactly one GUID and a valid Tally MasterID (not AlterID)');
        }
        if (options.masterId !== undefined)
            validateDirectOrderIdentity({ company: config.tally.company, companyGuid: options.companyGuid || '',
                guid: guids[0], masterId: options.masterId });
        else if (options.companyGuid !== undefined)
            throw new Error('--company-guid requires --master-id');
        diagnostics.log('Export definition validated. Acquiring PostgreSQL import lock...');
        return await withOrderImportLock(config.database, async () => {
            diagnostics.log('Import lock acquired. Connecting to PostgreSQL...');
            const client = new Client({ host: config.database.server, port: config.database.port || 5432,
                database: config.database.schema, user: config.database.username, password: config.database.password,
                ssl: config.database.ssl ? { rejectUnauthorized: false } : false, connectionTimeoutMillis: 10000 });
            try {
                await client.connect();
                diagnostics.log('Connected. Checking order columns and company metadata...');
                await checkOrderSchema(client, config.tally.company);
                const metadata = await client.query("select name,value from public.config where name in ('Company Name','Company GUID','Period From','Period To')");
                const period = backfillPeriod(metadata.rows, config.tally.company);
                const bindings = metadata.rows.filter(row => row.name === 'Company GUID');
                if (options.masterId !== undefined && (bindings.length > 1 || (bindings.length === 1
                    && String(bindings[0].value).toLowerCase() !== options.companyGuid.toLowerCase()))) {
                    throw new Error('Direct backfill company GUID does not match stored source binding');
                }
                const scope = options.masterId === undefined ? undefined : { company: config.tally.company,
                    companyGuid: options.companyGuid, guid: guids[0], masterId: options.masterId, ...period };
                diagnostics.log(`Schema/company checks passed. Export period: ${period.from} to ${period.to}. Lookup: ${options.masterId === undefined ? 'GUID-filtered collection' : 'direct MasterID ' + options.masterId}.`);
                const request = scope ? directOrderRequest(scope, sourceTable) : dropUnresolvedStaticVariables(substituteTDLParameters(generateXMLfromYAML(table), new Map([['targetCompany', config.tally.company],
                    ['fromDate', period.from.replaceAll('-', '')],
                    ['toDate', period.to.replaceAll('-', '')]])));
                const transport = new HttpTallyTransport(config.tally, undefined, {
                    progress: event => diagnostics.log(`HTTP ${JSON.stringify(event)}`),
                    partialResponse: body => diagnostics.xml('response-partial', body)
                });
                const rows = await fetchBackfillVouchers(transport, request, table, config.tally.company, diagnostics, false, scope ? body => [parseDirectOrderResponse(body, scope)] : undefined);
                if (rows.some(row => !guids.includes(row.guid)))
                    throw new Error('Backfill returned an unrequested voucher');
                const missing = guids.filter(guid => !rows.some(row => row.guid === guid));
                if (options.masterId !== undefined && missing.length)
                    throw new Error('Direct lookup did not return the requested voucher; no updates applied');
                diagnostics.log(`Requested=${guids.length}; returned=${rows.length}; missing=${missing.length}.`);
                if (!apply) {
                    diagnostics.log('Checking stored revisions for preview; no order data will be written.');
                    const stored = await client.query('select guid,alterid,order_details,order_number from public.trn_voucher where guid=any($1::text[])', [guids]);
                    return { mode: 'preview', missing, vouchers: rows.map(row => ({ guid: row.guid,
                            alterid: row.alterid, order_details: row.order_details, order_number: row.order_number,
                            stored: stored.rows.filter(value => value.guid === row.guid),
                            revision_matches: stored.rows.filter(value => value.guid === row.guid && value.alterid === row.alterid).length === 1 })) };
                }
                diagnostics.log('Applying only order columns where GUID and AlterID match, in one transaction...');
                const result = await applyOrderBackfill(client, rows, config.tally.company, scope?.companyGuid);
                if (scope && result.updated !== 1)
                    throw new Error('Direct backfill did not update exactly one revision-matched voucher; target is missing or has a different AlterID');
                diagnostics.log(`Committed: updated=${result.updated}; skipped=${result.skipped.length}; missing=${missing.length}. No Frappe import or reconciliation was triggered.`);
                return { mode: 'apply', missing, ...result };
            }
            finally {
                await client.end();
            }
        });
    }
    catch (error) {
        const message = diagnostics.redact(error instanceof Error ? error.message : String(error));
        diagnostics.log(`FAILED: ${message}`);
        throw new Error(message);
    }
    finally {
        diagnostics.log('Command finished; acquired connections/locks have been released.');
    }
}
//# sourceMappingURL=order-backfill.mjs.map