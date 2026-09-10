import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { XMLValidator } from 'fast-xml-parser';
import { diagnoseVoucher, diagnosticRequest, inspectDiagnosticResponse, DIAGNOSTIC_CASES, DIAGNOSTIC_TIMEOUT_MS } from '../dist/voucher-diagnostics.mjs';
import { HttpTallyTransport, tallyRequestMaxMs, tallyRequestTimeoutMs } from '../dist/tally-transport.mjs';
import { logger } from '../dist/logger.mjs';

const table = yaml.load(fs.readFileSync('tally-export-config-focused-incremental.yaml', 'utf8')).transaction[0];
const config = { company: 'Fixture & Co', server: '127.0.0.1', port: 9000 };
const options = { guid: 'fixture-guid', from: '2024-04-01', to: '2027-03-31', case: 'all', masterId: '42', companyGuid: '11111111-2222-3333-4444-555555555555' };

test('normal Tally requests default to a one-hour inactivity and wall-clock limit', () => {
    const previousTimeout = process.env.TALLY_REQUEST_TIMEOUT_MS;
    const previousMax = process.env.TALLY_REQUEST_MAX_MS;
    try {
        delete process.env.TALLY_REQUEST_TIMEOUT_MS;
        delete process.env.TALLY_REQUEST_MAX_MS;
        assert.equal(tallyRequestTimeoutMs(), 3600000);
        assert.equal(tallyRequestMaxMs(), 3600000);
    } finally {
        if (previousTimeout === undefined) delete process.env.TALLY_REQUEST_TIMEOUT_MS;
        else process.env.TALLY_REQUEST_TIMEOUT_MS = previousTimeout;
        if (previousMax === undefined) delete process.env.TALLY_REQUEST_MAX_MS;
        else process.env.TALLY_REQUEST_MAX_MS = previousMax;
    }
});

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

test('normal compatibility probes exercise production counted order reports', () => {
    const empty = diagnosticRequest(config, table, options, 'normal-empty');
    const one = diagnosticRequest(config, table, options, 'normal-one');
    for (const xml of [empty, one]) {
        assert.match(xml, /<SCROLLED>Vertical<\/SCROLLED>/);
        assert.match(xml, /<XMLTAG>KEEXPORTCOUNT<\/XMLTAG>/);
        assert.match(xml, /<XMLTAG>KECOMPANY<\/XMLTAG>/);
        assert.match(xml, /<XMLTAG>KEORDERNUMBER<\/XMLTAG>/);
        assert.doesNotMatch(xml, /KE_BATCH_PROBE|<XMLATTR>/);
    }
    assert.match(empty, />No<\/SYSTEM>/);
    assert.doesNotMatch(one, />No<\/SYSTEM>/);
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

test('diagnostics reject ambiguous voucher profiles before contacting Tally', async t => {
    const read = fs.readFileSync;
    t.mock.method(fs, 'readFileSync', (file, ...args) => file === 'ambiguous-profile.yaml'
        ? yaml.dump({ transaction: [table, table] }) : read(file, ...args));
    let requests = 0;
    t.mock.method(HttpTallyTransport.prototype, 'post', async () => { requests++; return '<ENVELOPE/>'; });
    await assert.rejects(diagnoseVoucher({ ...config, definition: 'ambiguous-profile.yaml' },
        { ...options, case: 'normal-one' }), /exactly one/);
    assert.equal(requests, 0);
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

test('staged and normal probes validate replies and stop safely without database access', async t => {
    t.mock.method(console, 'error', () => {});
    const previous = process.cwd();
    const definition = path.resolve('tally-export-config-focused-incremental.yaml');
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'voucher-stages-test-'));
    let body = '<ENVELOPE/>';
    let requests = 0;
    const layout = '<ENVELOPE><PROTOCOL>KE_DIRECT_ORDERS_V1</PROTOCOL><GUID>fixture-guid</GUID><MASTERID>42</MASTERID><ALTERID>123</ALTERID><ORDERCOUNT>0</ORDERCOUNT></ENVELOPE>';
    t.mock.method(HttpTallyTransport.prototype, 'post', async () => { requests++; return body; });
    try {
        process.chdir(temporary);
        const run = name => diagnoseVoucher({ ...config, definition }, { ...options, case: name });
        body = layout;
        await assert.rejects(run('direct-isolate'), /COMPANY/);
        assert.equal(requests, 2, 'must stop after source stage fails');
        const directory = path.join('backfill-debug', fs.readdirSync('backfill-debug')[0]);
        const summary = JSON.parse(fs.readFileSync(path.join(directory, 'summary.json'), 'utf8'));
        assert.deepEqual(summary.map(row => [row.case, row.status]), [['direct-layout', 'completed'], ['direct-source', 'failed']]);
        body = '<ENVELOPE><KECOMPANY>Fixture &amp; Co</KECOMPANY><KEEXPORTCOUNT>0</KEEXPORTCOUNT></ENVELOPE>';
        assert.equal((await run('normal-empty')).results[0].status, 'completed');
        await assert.rejects(run('normal-one'), /unexpected voucher count/);
        const fields = table.fields.map((field, i) => {
            const tag = `F${String(i + 1).padStart(2, '0')}`;
            const value = field.name === 'guid' ? options.guid : field.name === 'alterid' ? '123' : '';
            return `<${tag}>${value}</${tag}>`;
        }).join('');
        body = `<ENVELOPE><KECOMPANY>Fixture &amp; Co</KECOMPANY><KEEXPORTCOUNT>1</KEEXPORTCOUNT><KEVOUCHER><KEORDERCOUNT>0</KEORDERCOUNT>${fields}</KEVOUCHER></ENVELOPE>`;
        assert.equal((await run('normal-one')).results[0].status, 'completed');
        await assert.rejects(run('normal-empty'), /unexpected voucher count/);
        body = '<ENVELOPE/>';
        await assert.rejects(run('normal-empty'), /completeness count/);
    } finally {
        process.chdir(previous);
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
