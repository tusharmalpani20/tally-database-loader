import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { XMLValidator } from 'fast-xml-parser';
import { diagnoseVoucher, diagnosticRequest, inspectDiagnosticResponse, DIAGNOSTIC_CASES, DIAGNOSTIC_TIMEOUT_MS } from '../dist/voucher-diagnostics.mjs';
import { HttpTallyTransport } from '../dist/tally-transport.mjs';
import { logger } from '../dist/logger.mjs';

const table = yaml.load(fs.readFileSync('tally-export-config-focused-incremental.yaml', 'utf8')).transaction[0];
const config = { company: 'Fixture & Co', server: '127.0.0.1', port: 9000 };
const options = { guid: 'fixture-guid', from: '2024-04-01', to: '2027-03-31', case: 'all', masterId: '42', companyGuid: '11111111-2222-3333-4444-555555555555' };

test('all probes produce export-only XML with the same explicit company/period', () => {
    assert.equal(DIAGNOSTIC_TIMEOUT_MS, 3600000);
    for (const name of DIAGNOSTIC_CASES) {
        const xml = diagnosticRequest(config, table, options, name);
        assert.equal(XMLValidator.validate(xml), true, name);
        assert.match(xml, /<TALLYREQUEST>Export<\/TALLYREQUEST>/);
        assert.match(xml, /<SVCURRENTCOMPANY>Fixture &amp; Co<\/SVCURRENTCOMPANY>/);
        assert.match(xml, /<SVFROMDATE>20240401<\/SVFROMDATE>/);
        assert.doesNotMatch(xml, /<TALLYREQUEST>Import/);
    }
});

test('probes isolate filter cost and collection count; direct lookup uses MasterID without a voucher collection walk', () => {
    const guid = diagnosticRequest(config, table, options, 'guid');
    const filters = diagnosticRequest(config, table, options, 'filters');
    assert.doesNotMatch(guid, /IsInventoryVch/);
    assert.match(filters, /IsInventoryVch/);
    const orders = diagnosticRequest(config, table, options, 'orders');
    const count = diagnosticRequest(config, table, options, 'count');
    assert.equal(orders.replace('"DIAGNOSTIC_COUNT_DISABLED"', () => '$$NumItems:MyCollection'), count);
    const direct = diagnosticRequest(config, table, options, 'direct');
    assert.match(direct, /<OBJECT>Voucher : "ID:42"<\/OBJECT>/);
    assert.doesNotMatch(direct, /<REPEAT>|<COLLECTION/);
    assert.throws(() => diagnosticRequest(config, table, { ...options, masterId: undefined }, 'direct'));
    assert.throws(() => diagnosticRequest(config, table, { ...options, guid: 'bad"guid' }, 'guid'));
    assert.throws(() => diagnosticRequest(config, table, { ...options, from: '2026-02-30' }, 'guid'));
    assert.throws(() => diagnosticRequest(config, table, { ...options, from: '0000-01-01' }, 'guid'));
    assert.throws(() => diagnosticRequest(config, table, { ...options, masterId: 'invalid' }, 'company'), /master-id/);
});

test('diagnostics verify returned identity before accepting timing results or discovering a MasterID', () => {
    assert.deepEqual(inspectDiagnosticResponse('<ENVELOPE><F01>fixture-guid</F01><F02>123</F02><F03>42</F03></ENVELOPE>', 'guid', 'fixture-guid', config.company), { masterId: '42' });
    assert.throws(() => inspectDiagnosticResponse('<ENVELOPE><F01>wrong</F01></ENVELOPE>', 'guid', 'fixture-guid', config.company));
    assert.throws(() => inspectDiagnosticResponse('<ENVELOPE><LINEERROR>Error</LINEERROR></ENVELOPE>', 'guid', 'fixture-guid', config.company));
    assert.throws(() => inspectDiagnosticResponse('<ENVELOPE><F01>other</F01><KEVOUCHER><F01>fixture-guid</F01></KEVOUCHER></ENVELOPE>', 'guid', 'fixture-guid', config.company), /Ambiguous/);
});

test('minimal order and metadata probes isolate the unverified production hierarchy', () => {
    const xml = diagnosticRequest(config, table, options, 'direct-orders');
    assert.equal(XMLValidator.validate(xml), true);
    assert.match(xml, /<OBJECT>Voucher : "ID:42"<\/OBJECT>/);
    assert.match(xml, /\$\$NumItems:InvoiceOrderList/);
    assert.match(xml, /\$BasicPurchaseOrderNo/);
    assert.doesNotMatch(xml, /OBJECTEX|TOPPARTS|TOPLINES|KEMetadata|<COLLECTION/);
    const metadata = diagnosticRequest(config, table, options, 'company-metadata');
    assert.equal(XMLValidator.validate(metadata), true);
    assert.match(metadata, /<PARTS>MyPart<\/PARTS>/);
    assert.match(metadata, /<TYPE>Company<\/TYPE>/);
    assert.ok(metadata.includes('If $$IsEmpty:$Guid:Voucher:"ID:42" Then "0" Else "1"'));
    assert.doesNotMatch(metadata, /<EXPLODE>|<TYPE>Voucher<\/TYPE>/);
    for (const name of ['direct-orders', 'company-metadata']) {
        assert.throws(() => diagnosticRequest(config, table, { ...options, masterId: undefined }, name), /master-id/);
    }
});

test('minimal probes validate identity, counted order lists and company-context results', () => {
    const xml = '<ENVELOPE><F01>fixture-guid</F01><F02>1855152</F02><F03>42</F03><KEORDERCOUNT>1</KEORDERCOUNT><KEORDER><KEORDERNUMBER>KE-SO-00018-26-27</KEORDERNUMBER><KEORDERDATE>20260902</KEORDERDATE></KEORDER></ENVELOPE>';
    const inspect = body => inspectDiagnosticResponse(body, 'direct-orders', options.guid, config.company, '42');
    assert.deepEqual(inspect(xml), { masterId: '42', order_details: [{ order_number: 'KE-SO-00018-26-27', order_date: '2026-09-02' }] });
    for (const bad of [xml.replace('F03>42', 'F03>43'), xml.replace('fixture-guid', 'wrong'),
        xml.replace('COUNT>1', 'COUNT>0'), xml.replace('20260902', '20260230'),
        xml.replace('<KEORDERCOUNT>1</KEORDERCOUNT>', ''), '<ENVELOPE></ENVELOPE>']) assert.throws(() => inspect(bad));
    const company = '<ENVELOPE><F01>Fixture &amp; Co</F01><F02>1</F02></ENVELOPE>';
    assert.deepEqual(inspectDiagnosticResponse(company, 'company-metadata', options.guid, config.company), {});
    assert.throws(() => inspectDiagnosticResponse(company.replace('F02>1', 'F02>0'), 'company-metadata', options.guid, config.company));
});

test('diagnostic configuration rejects invalid ports before reading a profile or making requests', async () => {
    await assert.rejects(diagnoseVoucher({ ...config, port: 65536 }, options), /server\/port/);
    assert.throws(() => new HttpTallyTransport(config, undefined, { timeoutMs: 2147483648 }), /timeout/);
});

test('runner saves responses and failure summary and stops before further probes', async t => {
    t.mock.method(console, 'error', () => {});
    const previous = process.cwd();
    const definition = path.resolve('tally-export-config-focused-incremental.yaml');
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'voucher-diagnostic-test-'));
    let calls = 0;
    const server = http.createServer((req, res) => {
        req.resume();
        req.on('end', () => {
            calls++;
            res.end(Buffer.from(calls === 1 ? '<ENVELOPE><F01>Fixture &amp; Co</F01></ENVELOPE>'
                : '<ENVELOPE><F01>wrong-guid</F01></ENVELOPE>', 'utf16le'));
        });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
        process.chdir(temporary);
        await assert.rejects(diagnoseVoucher({ ...config, port: server.address().port, definition }, options), /requested voucher GUID/);
        assert.equal(calls, 2);
        const directory = path.join('backfill-debug', fs.readdirSync('backfill-debug')[0]);
        const summary = JSON.parse(fs.readFileSync(path.join(directory, 'summary.json'), 'utf8'));
        assert.deepEqual(summary.map(row => [row.case, row.status]), [['company', 'completed'], ['guid', 'failed']]);
        assert.match(fs.readFileSync(path.join(directory, 'guid-response.xml'), 'utf8'), /wrong-guid/);
        assert.equal(fs.existsSync(path.join(directory, 'direct-request.xml')), false);
    } finally {
        process.chdir(previous);
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
        fs.rmSync(temporary, { recursive: true, force: true });
    }
});

test('HTTP diagnostics distinguish connection/first byte/completion and save a partial timeout response', async t => {
    t.mock.method(logger, 'logMessage', () => {});
    t.mock.method(logger, 'logError', () => {});
    let hang = false;
    const server = http.createServer((req, res) => {
        req.resume();
        req.on('end', () => {
            res.writeHead(200, { 'Content-Type': 'text/xml;charset=utf-16' });
            res.write(Buffer.from('<ENVELOPE>', 'utf16le'));
            if (!hang) res.end(Buffer.from('</ENVELOPE>', 'utf16le'));
        });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
        const events = [];
        const transport = new HttpTallyTransport({ ...config, port: server.address().port }, undefined,
            { timeoutMs: 300, progress: event => events.push(event) });
        assert.equal(await transport.post('<REQUEST/>'), '<ENVELOPE></ENVELOPE>');
        for (const phase of ['lock_wait', 'lock_acquired', 'tcp_connected', 'request_sent_waiting_for_response', 'response_headers', 'first_body_chunk', 'response_complete']) {
            assert.ok(events.some(event => event.phase === phase), phase);
        }
        assert.ok(events.find(event => event.phase === 'first_body_chunk').bytes > 0);
        hang = true;
        let partial;
        const timed = new HttpTallyTransport({ ...config, port: server.address().port }, undefined,
            { timeoutMs: 300, partialResponse: body => { partial = body; } });
        await assert.rejects(timed.post('<REQUEST/>'), /exceeded|timed out/);
        assert.equal(partial, '<ENVELOPE>');
    } finally {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    }
});
