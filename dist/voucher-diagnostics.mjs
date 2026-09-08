import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { HttpTallyTransport } from './tally-transport.mjs';
import { generateXMLfromYAML, substituteTDLParameters } from './yaml-report-exporter.mjs';
import { parseOrderVouchers } from './order-details.mjs';
export const DIAGNOSTIC_TIMEOUT_MS = 3600000;
export const DIAGNOSTIC_CASES = ['company', 'guid', 'direct', 'filters', 'fields', 'orders', 'count'];
function date(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000-') || !Number.isFinite(Date.parse(value))
        || new Date(value).toISOString().slice(0, 10) !== value)
        throw new Error('Dates must be valid YYYY-MM-DD dates');
    return value.replaceAll('-', '');
}
export function diagnosticRequest(config, table, options, selected) {
    if (!config.company || !/^[a-zA-Z0-9-]{1,64}$/.test(options.guid))
        throw new Error('Explicit company and one valid GUID are required');
    if (options.masterId !== undefined && !/^[1-9]\d{0,9}$/.test(options.masterId))
        throw new Error('Invalid --master-id; use the Tally MasterID, not AlterID');
    const from = date(options.from), to = date(options.to);
    if (from > to)
        throw new Error('Export period is reversed');
    const guidFilter = `$Guid = "${options.guid}"`;
    const identity = ['Guid', 'AlterId', 'MasterID'].map((field, index) => ({ name: ['guid', 'alterid', 'master_id'][index], field, type: index ? 'number' : 'text' }));
    let definition = { ...table, order_details: false, voucher_identities: false, fetch: ['Guid,AlterId,MasterID'], fields: identity, filters: [guidFilter] };
    if (selected === 'company')
        definition = { name: 'company', nature: 'Primary', collection: 'Company', fetch: ['Name'],
            fields: [{ name: 'company', field: 'Name', type: 'text' }], filters: ['$$IsEqual:$Name:##SVCurrentCompany'] };
    if (selected === 'filters')
        definition.filters = [...(table.filters || []), guidFilter];
    if (['fields', 'orders', 'count'].includes(selected))
        definition = { ...table, filters: [...(table.filters || []), guidFilter], order_details: selected !== 'fields' };
    let xml = generateXMLfromYAML(definition);
    if (selected === 'orders') {
        // Diagnostic-only: retain identical layout/order extraction, remove only total collection counting.
        xml = xml.replace('$$NumItems:MyCollection', () => '"DIAGNOSTIC_COUNT_DISABLED"');
    }
    if (selected === 'direct') {
        if (!/^[1-9]\d{0,9}$/.test(options.masterId || ''))
            throw new Error('Direct lookup requires --master-id from the guid test (not AlterID)');
        xml = xml.replace('<FORMS>MyForm</FORMS>', () => `<OBJECT>Voucher : "ID:${options.masterId}"</OBJECT><FORMS>MyForm</FORMS>`)
            .replace('<REPEAT>MyLine : MyCollection</REPEAT>', '')
            .replace(/<COLLECTION NAME="MyCollection">[\s\S]*?<\/COLLECTION>/, '');
    }
    return substituteTDLParameters(xml, new Map([['targetCompany', config.company], ['fromDate', from], ['toDate', to]]));
}
export function inspectDiagnosticResponse(body, selected, guid, company) {
    if (XMLValidator.validate(body) !== true || /<!DOCTYPE|<!ENTITY|<(?:LINEERROR|ERROR|EXCEPTIONS)(?:\s|>)/i.test(body))
        throw new Error('Invalid XML or Tally error response; inspect the saved XML');
    const root = new XMLParser({ parseTagValue: false, trimValues: true }).parse(body).ENVELOPE;
    if (!root || typeof root !== 'object' || Array.isArray(root))
        throw new Error('Missing/ambiguous response envelope');
    if (selected === 'company') {
        if (root.F01 !== company)
            throw new Error('Company probe did not return the configured company');
        return {};
    }
    if (root.KEVOUCHER !== undefined && root.F01 !== undefined)
        throw new Error('Ambiguous mixed voucher response');
    const row = root.KEVOUCHER ?? root;
    if (Array.isArray(row) || row.F01 !== guid)
        throw new Error('Response did not contain exactly the requested voucher GUID');
    const masterId = ['guid', 'direct', 'filters'].includes(selected) && /^[1-9]\d{0,9}$/.test(row.F03 || '') ? row.F03 : undefined;
    return { masterId };
}
export async function diagnoseVoucher(config, options) {
    if (options.case !== 'all' && !DIAGNOSTIC_CASES.includes(options.case))
        throw new Error(`--case must be all or ${DIAGNOSTIC_CASES.join(', ')}`);
    if (!config.server || !Number.isInteger(config.port) || config.port <= 0 || config.port > 65535)
        throw new Error('Configure a valid Tally server/port');
    const profile = yaml.load(fs.readFileSync(config.definition, 'utf8'));
    const table = Array.isArray(profile?.transaction) ? profile.transaction.find(row => row?.name === 'trn_voucher' && row.order_details) : undefined;
    if (!table)
        throw new Error('Select the order-detail voucher profile in config.json');
    // Validate all non-network inputs before creating artifacts or sending the company probe.
    diagnosticRequest(config, table, options, 'guid');
    if (options.case === 'direct')
        diagnosticRequest(config, table, options, 'direct');
    const root = path.resolve('backfill-debug');
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const directory = fs.mkdtempSync(path.join(root, 'diagnose-'));
    const log = (message) => {
        const line = `[${new Date().toISOString()}] ${message}`;
        fs.appendFileSync(path.join(directory, 'progress.log'), line + '\n', { mode: 0o600 });
        console.error(line);
    };
    const save = (name, data) => fs.writeFileSync(path.join(directory, name), data, { mode: 0o600 });
    log(`READ-ONLY diagnostics; no PostgreSQL/Frappe access. One-hour HTTP limit PER TEST. Artifacts: ${directory}`);
    log('XML contains private business data. Stop scheduled exports first; tests run sequentially and stop on first failure.');
    const results = [];
    const selected = options.case === 'all' ? [...DIAGNOSTIC_CASES] : [options.case];
    for (const name of selected) {
        if (name === 'direct' && !options.masterId) {
            log('SKIP direct: no MasterID was returned by guid probe.');
            results.push({ case: name, status: 'skipped' });
            save('summary.json', JSON.stringify(results, null, 2));
            continue;
        }
        const started = Date.now();
        const events = [];
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
            const details = inspectDiagnosticResponse(body, name, options.guid, config.company);
            if (name === 'count')
                parseOrderVouchers(body, table, config.company);
            if (name === 'guid' && details.masterId)
                options = { ...options, masterId: details.masterId };
            results.push({ case: name, status: 'completed', elapsedMs: Date.now() - started, ...details, events });
            log(`COMPLETE ${name}; ${Date.now() - started}ms. This is a timing probe, not authorization to import its output.`);
        }
        catch (error) {
            results.push({ case: name, status: 'failed', elapsedMs: Date.now() - started, error: error instanceof Error ? error.message : String(error), events });
            save('summary.json', JSON.stringify(results, null, 2));
            log(`STOP ${name}: ${error instanceof Error ? error.message : error}. Do not immediately retry: Tally may still be processing the cancelled request.`);
            throw error;
        }
        save('summary.json', JSON.stringify(results, null, 2));
    }
    log('Finished. Compare adjacent tests; repeat selected cases to account for Tally caching/load. Timings alone are not proof of a single cause.');
    return { directory, results };
}
//# sourceMappingURL=voucher-diagnostics.mjs.map