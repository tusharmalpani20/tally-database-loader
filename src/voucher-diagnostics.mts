import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import type { tallyConfig, tableConfigYAML } from './definition.mjs';
import { HttpTallyTransport } from './tally-transport.mjs';
import { generateXMLfromYAML, substituteTDLParameters } from './yaml-report-exporter.mjs';
import { parseOrderVouchers, validateOrderDetails } from './order-details.mjs';

export const DIAGNOSTIC_TIMEOUT_MS = 3600000;
export const DIAGNOSTIC_CASES = ['company', 'guid', 'direct', 'filters', 'fields', 'orders', 'count', 'direct-orders', 'company-metadata'] as const;
type Case = typeof DIAGNOSTIC_CASES[number];
interface Options { guid: string; from: string; to: string; case: string; masterId?: string }

function replaceOnce(xml: string, anchor: string, replacement: string): string {
    if (xml.split(anchor).length !== 2) throw new Error(`Diagnostic template requires exactly one ${anchor}`);
    return xml.replace(anchor, () => replacement);
}

function date(value: string): string {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000-') || !Number.isFinite(Date.parse(value))
        || new Date(value).toISOString().slice(0, 10) !== value) throw new Error('Dates must be valid YYYY-MM-DD dates');
    return value.replaceAll('-', '');
}

export function diagnosticRequest(config: tallyConfig, table: tableConfigYAML, options: Options, selected: Case): string {
    if (!config.company || !/^[a-zA-Z0-9-]{1,64}$/.test(options.guid)) throw new Error('Explicit company and one valid GUID are required');
    if (options.masterId !== undefined && !/^[1-9]\d{0,9}$/.test(options.masterId)) throw new Error('Invalid --master-id; use the Tally MasterID, not AlterID');
    const from = date(options.from), to = date(options.to);
    if (from > to) throw new Error('Export period is reversed');
    const guidFilter = `$Guid = "${options.guid}"`;
    const identity = ['Guid', 'AlterId', 'MasterID'].map((field, index) => ({ name: ['guid', 'alterid', 'master_id'][index], field, type: index ? 'number' : 'text' }));
    let definition: tableConfigYAML = { ...table, order_details: false, voucher_identities: false, fetch: ['Guid,AlterId,MasterID'], fields: identity, filters: [guidFilter] };
    if (selected === 'company' || selected === 'company-metadata') definition = { name: 'company', nature: 'Primary', collection: 'Company', fetch: ['Name'],
        fields: [{ name: 'company', field: 'Name', type: 'text' }], filters: ['$$IsEqual:$Name:##SVCurrentCompany'] };
    if (['direct-orders', 'company-metadata'].includes(selected) && !options.masterId) throw new Error(`${selected} requires --master-id (not AlterID)`);
    if (selected === 'company-metadata') definition.fields.push({ name: 'voucher_exists', type: 'text',
        field: `If $$IsEmpty:$Guid:Voucher:"ID:${options.masterId}" Then "0" Else "1"` });
    if (selected === 'filters') definition.filters = [...(table.filters || []), guidFilter];
    if (['fields', 'orders', 'count'].includes(selected)) definition = { ...table, filters: [...(table.filters || []), guidFilter], order_details: selected !== 'fields' };
    let xml = generateXMLfromYAML(definition);
    if (selected === 'orders') {
        // Diagnostic-only: retain identical layout/order extraction, remove only total collection counting.
        xml = xml.replace('$$NumItems:MyCollection', () => '"DIAGNOSTIC_COUNT_DISABLED"');
    }
    if (selected === 'direct' || selected === 'direct-orders') {
        if (!/^[1-9]\d{0,9}$/.test(options.masterId || '')) throw new Error('Direct lookup requires --master-id from the guid test (not AlterID)');
        xml = replaceOnce(xml, '<FORMS>MyForm</FORMS>', `<OBJECT>Voucher : "ID:${options.masterId}"</OBJECT><FORMS>MyForm</FORMS>`);
        xml = replaceOnce(xml, '<REPEAT>MyLine : MyCollection</REPEAT>', '');
        const collection = xml.match(/<COLLECTION NAME="MyCollection">[\s\S]*?<\/COLLECTION>/)?.[0];
        if (!collection) throw new Error('Missing diagnostic voucher collection');
        xml = replaceOnce(xml, collection, '');
    }
    if (selected === 'direct-orders') {
        // Start with the report-level direct lookup already verified on remote Tally.
        // Deliberately omit the production metadata hierarchy and ObjectEx binding.
        xml = replaceOnce(xml, '<LINE NAME="MyLine"><FIELDS>', '<LINE NAME="MyLine"><EXPLODE>KEProbeOrders : Yes</EXPLODE><FIELDS>KEProbeCount,');
        xml = replaceOnce(xml, '</TDLMESSAGE>', `
<FIELD NAME="KEProbeCount"><SET>$$NumItems:InvoiceOrderList</SET><XMLTAG>KEORDERCOUNT</XMLTAG></FIELD>
<PART NAME="KEProbeOrders"><LINES>KEProbeOrder</LINES><REPEAT>KEProbeOrder : InvoiceOrderList</REPEAT></PART>
<LINE NAME="KEProbeOrder"><XMLTAG>KEORDER</XMLTAG><FIELDS>KEProbeNumber,KEProbeDate</FIELDS></LINE>
<FIELD NAME="KEProbeNumber"><SET>$BasicPurchaseOrderNo</SET><XMLTAG>KEORDERNUMBER</XMLTAG></FIELD>
<FIELD NAME="KEProbeDate"><SET>If $$IsEmpty:$BasicOrderDate Then "" Else (($$YearOfDate:$BasicOrderDate)*10000)+(($$MonthOfDate:$BasicOrderDate)*100)+$$DayOfDate:$BasicOrderDate</SET><XMLTAG>KEORDERDATE</XMLTAG></FIELD>
</TDLMESSAGE>`);
    }
    return substituteTDLParameters(xml, new Map([['targetCompany', config.company], ['fromDate', from], ['toDate', to]]));
}

export function inspectDiagnosticResponse(body: string, selected: Case, guid: string, company: string, expectedMasterId?: string) {
    if (XMLValidator.validate(body) !== true || /<!DOCTYPE|<!ENTITY|<(?:LINEERROR|ERROR|EXCEPTIONS)(?:\s|>)/i.test(body)) throw new Error('Invalid XML or Tally error response; inspect the saved XML');
    const root = new XMLParser({ parseTagValue: false, trimValues: true }).parse(body).ENVELOPE;
    if (!root || typeof root !== 'object' || Array.isArray(root)) throw new Error('Missing/ambiguous response envelope');
    if (selected === 'company' || selected === 'company-metadata') {
        if (root.F01 !== company) throw new Error('Company probe did not return the configured company');
        if (selected === 'company-metadata' && root.F02 !== '1') throw new Error('Company-context voucher existence expression did not return 1');
        return {};
    }
    if (root.KEVOUCHER !== undefined && root.F01 !== undefined) throw new Error('Ambiguous mixed voucher response');
    const row = root.KEVOUCHER ?? root;
    if (Array.isArray(row) || row.F01 !== guid) throw new Error('Response did not contain exactly the requested voucher GUID');
    if (selected === 'direct-orders') {
        if (!expectedMasterId || row.F03 !== expectedMasterId || typeof row.F02 !== 'string'
            || !/^\d+$/.test(row.F02) || !Number.isSafeInteger(Number(row.F02))) throw new Error('Invalid direct order probe identity');
        if (Object.keys(root).some(key => !['F01', 'F02', 'F03', 'FLDBLANK', 'KEORDERCOUNT', 'KEORDER'].includes(key))) throw new Error('Unexpected direct order probe structure');
        const entries = row.KEORDER === undefined ? [] : Array.isArray(row.KEORDER) ? row.KEORDER : [row.KEORDER];
        if (typeof row.KEORDERCOUNT !== 'string' || !/^\d+$/.test(row.KEORDERCOUNT) || Number(row.KEORDERCOUNT) !== entries.length) throw new Error('Direct order probe count mismatch');
        const order_details = entries.map((entry: Record<string, unknown>) => {
            if (!entry || typeof entry !== 'object' || Object.keys(entry).some(key => !['KEORDERNUMBER', 'KEORDERDATE'].includes(key))
                || typeof entry.KEORDERNUMBER !== 'string' || typeof entry.KEORDERDATE !== 'string') throw new Error('Invalid direct order probe entry');
            const raw = entry.KEORDERDATE;
            return { order_number: entry.KEORDERNUMBER, order_date: raw === '' ? null : /^\d{8}$/.test(raw)
                ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6)}` : raw };
        });
        validateOrderDetails(order_details);
        return { masterId: row.F03 as string, order_details };
    }
    const masterId = ['guid', 'direct', 'filters'].includes(selected) && /^[1-9]\d{0,9}$/.test(row.F03 || '') ? row.F03 : undefined;
    return { masterId };
}

export async function diagnoseVoucher(config: tallyConfig, options: Options) {
    if (options.case !== 'all' && !(DIAGNOSTIC_CASES as readonly string[]).includes(options.case)) throw new Error(`--case must be all or ${DIAGNOSTIC_CASES.join(', ')}`);
    if (!config.server || !Number.isInteger(config.port) || config.port <= 0 || config.port > 65535) throw new Error('Configure a valid Tally server/port');
    const profile = yaml.load(fs.readFileSync(config.definition, 'utf8')) as { transaction: tableConfigYAML[] };
    const table = Array.isArray(profile?.transaction) ? profile.transaction.find(row => row?.name === 'trn_voucher' && row.order_details) : undefined;
    if (!table) throw new Error('Select the order-detail voucher profile in config.json');
    // Validate all non-network inputs before creating artifacts or sending the company probe.
    diagnosticRequest(config, table, options, 'guid');
    if (options.case !== 'all') diagnosticRequest(config, table, options, options.case as Case);
    const root = path.resolve('backfill-debug');
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const directory = fs.mkdtempSync(path.join(root, 'diagnose-'));
    const log = (message: string) => {
        const line = `[${new Date().toISOString()}] ${message}`;
        fs.appendFileSync(path.join(directory, 'progress.log'), line + '\n', { mode: 0o600 });
        console.error(line);
    };
    const save = (name: string, data: string) => fs.writeFileSync(path.join(directory, name), data, { mode: 0o600 });
    log(`READ-ONLY diagnostics; no PostgreSQL/Frappe access. One-hour HTTP limit PER TEST. Artifacts: ${directory}`);
    log('XML contains private business data. Stop scheduled exports first; tests run sequentially and stop on first failure.');
    const results: object[] = [];
    const selected = options.case === 'all' ? [...DIAGNOSTIC_CASES] : [options.case as Case];
    for (const name of selected) {
        if (['direct', 'direct-orders', 'company-metadata'].includes(name) && !options.masterId) {
            log(`SKIP ${name}: no MasterID was returned by guid probe.`);
            results.push({ case: name, status: 'skipped' });
            save('summary.json', JSON.stringify(results, null, 2));
            continue;
        }
        const started = Date.now();
        const events: object[] = [];
        log(`START ${name}`);
        try {
            const request = diagnosticRequest(config, table, options, name);
            save(`${name}-request.xml`, request);
            const transport = new HttpTallyTransport(config, undefined, {
                timeoutMs: DIAGNOSTIC_TIMEOUT_MS,
                progress: event => { events.push(event); log(`${name}: ${JSON.stringify(event)}`); },
                partialResponse: body => { save(`${name}-partial.xml`, body); log(`${name}: saved incomplete response (${body.length} characters); not a valid export`); }
            });
            const body = await transport.post(request);
            save(`${name}-response.xml`, body);
            const details = inspectDiagnosticResponse(body, name, options.guid, config.company, options.masterId);
            if (name === 'count') parseOrderVouchers(body, table, config.company);
            if (name === 'guid' && details.masterId) options = { ...options, masterId: details.masterId };
            results.push({ case: name, status: 'completed', elapsedMs: Date.now() - started, ...details, events });
            log(`COMPLETE ${name}; ${Date.now() - started}ms. This is a timing probe, not authorization to import its output.`);
        } catch (error) {
            results.push({ case: name, status: 'failed', elapsedMs: Date.now() - started, error: error instanceof Error ? error.message : String(error), events });
            save('summary.json', JSON.stringify(results, null, 2));
            log(`STOP ${name}: ${error instanceof Error ? error.message : error}. If the HTTP request failed before completion, check Tally is responsive before retrying.`);
            throw error;
        }
        save('summary.json', JSON.stringify(results, null, 2));
    }
    log('Finished. Compare adjacent tests; repeat selected cases to account for Tally caching/load. Timings alone are not proof of a single cause.');
    return { directory, results };
}
