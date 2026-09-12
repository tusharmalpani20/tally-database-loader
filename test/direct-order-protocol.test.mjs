import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import yaml from 'js-yaml';
import { XMLValidator } from 'fast-xml-parser';
import { directOrderRequest, parseDirectOrderResponse, directOrderStageRequest, inspectDirectOrderStage } from '../dist/direct-order-protocol.mjs';
import { batchOrderProbe, inspectBatchOrderProbe } from '../dist/batch-order-probe.mjs';
import { BackfillDiagnostics, fetchBackfillVouchers } from '../dist/backfill-diagnostics.mjs';

const table = yaml.load(fs.readFileSync('tally-export-config-focused-incremental.yaml', 'utf8')).transaction[0];
const scope = { company: 'Fixture', companyGuid: '11111111-2222-3333-4444-555555555555', guid: 'fixture-guid', masterId: '42', from: '2024-04-01', to: '2027-03-31' };
const fixture = (orders = '<ORDER><NUMBER>SO-1</NUMBER><DATE>20260902</DATE></ORDER>', count = 1) => `<ENVELOPE><PROTOCOL>KE_DIRECT_ORDERS_V1</PROTOCOL><COMPANY>Fixture</COMPANY><COMPANYGUID>${scope.companyGuid}</COMPANYGUID><GUID>fixture-guid</GUID><MASTERID>42</MASTERID><ALTERID>123</ALTERID><VOUCHERTYPE>Delivery Challan</VOUCHERTYPE><DATE>20260902</DATE><CANCELLED>0</CANCELLED><OPTIONAL>0</OPTIONAL><ELIGIBLE>1</ELIGIBLE><ORDERCOUNT>${count}</ORDERCOUNT>${orders}</ENVELOPE>`;

test('direct report definitions are unique under Tally case and space insensitive naming', () => {
    const xml = directOrderRequest(scope, table);
    const definitions = [...xml.matchAll(/<(REPORT|FORM|PART|LINE|FIELD|COLLECTION) NAME="([^"]+)"/g)]
        .map(([, type, name]) => `${type}:${name.replace(/\s/g, '').toLowerCase()}`);
    assert.equal(new Set(definitions).size, definitions.length, 'TDL definition names collide');
    assert.match(xml, /<FIELD NAME="KEDODATE"><SET>[^<]*\$Date/);
    assert.match(xml, /<FIELDS>KEDONumber,KEDOOrderDate<\/FIELDS>/);
    assert.match(xml, /<FIELD NAME="KEDOOrderDate"><SET>[^<]*\$BasicOrderDate/);
});

test('direct contract retains proven object binding, embedded company reads and profile eligibility', () => {
    const xml = directOrderRequest(scope, table);
    assert.equal(XMLValidator.validate(xml), true);
    assert.match(xml, /<EXPORTEMPTYFIELDS>Yes<\/EXPORTEMPTYFIELDS>/);
    assert.match(xml, /<PART NAME="KEDOPart"><LINES>KEDOLine<\/LINES><SCROLLED>Vertical<\/SCROLLED>/);
    assert.match(xml, /<OBJECT>Voucher : "ID:42"<\/OBJECT>/);
    assert.match(xml, /\$GUID:Company:##SVCurrentCompany/);
    assert.match(xml, /IsCancelled/);
    assert.match(xml, /IsOptional/);
    assert.match(xml, /IsInventoryVch/);
    assert.doesNotMatch(xml, /OBJECTEX|TOPPARTS|TOPLINES|<COLLECTION|MyCollection|\$Guid:Voucher:/);
    assert.throws(() => directOrderRequest({ ...scope, companyGuid: '' }, table), /company-guid/);
    assert.throws(() => directOrderRequest({ ...scope, masterId: '42"' }, table));
    assert.throws(() => directOrderRequest({ ...scope, from: '2026-02-30' }, table));
    assert.throws(() => directOrderRequest({ ...scope, company: ' Fixture' }, table));
    assert.throws(() => directOrderRequest({ ...scope, company: 'Fixture\nCompany' }, table));
    assert.throws(() => batchOrderProbe(scope, { ...table, filters: [] }, true));
    assert.throws(() => batchOrderProbe(scope, { ...table, name: 'trn_inventory' }, false));
});

test('diagnostic stages isolate fields but cannot pass full publication validation', () => {
    assert.throws(() => directOrderStageRequest(scope, table, 'typo'), /diagnostic stage/);
    assert.throws(() => inspectDirectOrderStage(fixture(), scope, 'typo'), /diagnostic stage/);
    assert.equal(directOrderStageRequest(scope, table, 'full'), directOrderRequest(scope, table));
    let source = fixture();
    for (const tag of ['VOUCHERTYPE', 'DATE', 'CANCELLED', 'OPTIONAL', 'ELIGIBLE']) {
        // Remove only the header's first occurrence, preserving the nested order date.
        source = source.replace(new RegExp(`<${tag}>[^<]*</${tag}>`), '');
    }
    const layout = source.replace(/<(COMPANY|COMPANYGUID)>[^<]*<\/\1>/g, '');
    for (const [stage, response] of [['layout', layout], ['source', source]]) {
        const request = directOrderStageRequest(scope, table, stage);
        assert.equal(XMLValidator.validate(request), true);
        assert.doesNotMatch(request, /\$IsCancelled|\$VoucherTypeName/);
        if (stage === 'layout') assert.doesNotMatch(request, /\$Name:Company|\$GUID:Company/);
        else assert.match(request, /\$GUID:Company/);
        assert.equal(inspectDirectOrderStage(response, scope, stage).order_number, 'SO-1');
        assert.throws(() => parseDirectOrderResponse(response, scope));
        assert.throws(() => inspectDirectOrderStage('<ENVELOPE/>', scope, stage));
        assert.throws(() => inspectDirectOrderStage(response.replace('<MASTERID>42', '<MASTERID>43'), scope, stage));
    }
});

test('direct backfill normalizes order numbers with the same ingestion policy', t => {
    const warnings = [];
    t.mock.method(console, 'warn', message => warnings.push(message));
    const row = parseDirectOrderResponse(fixture(`<ORDER><NUMBER>A\t${'B'.repeat(150)}</NUMBER><DATE/></ORDER>`), scope);
    assert.equal(row.order_number, 'A ' + 'B'.repeat(138));
    assert.equal(row.order_details[0].order_number, row.order_number);
    assert.match(warnings[0], /fixture-guid/);
    assert.throws(() => parseDirectOrderResponse(fixture('<ORDER><NUMBER>valid</NUMBER><DATE>20260230</DATE></ORDER>'), scope), /fixture-guid.*order entry 1.*date/);
});

test('direct response preserves zero, multiple and dated order entries', () => {
    assert.equal(parseDirectOrderResponse(fixture(), scope).order_number, 'SO-1');
    assert.equal(parseDirectOrderResponse(fixture().replaceAll('><', '>\r\n <'), scope).order_number, 'SO-1');
    assert.deepEqual(parseDirectOrderResponse(fixture('', 0), scope).order_details, []);
    const multi = parseDirectOrderResponse(fixture('<ORDER><NUMBER>SO-1</NUMBER><DATE/></ORDER><ORDER><NUMBER>SO-2</NUMBER><DATE>20260902</DATE></ORDER>', 2), scope);
    assert.equal(multi.order_number, null);
    assert.equal(multi.order_details[0].order_date, null);
});

test('direct response rejects wrong or absent source, identity, scope and completeness', () => {
    const valid = fixture();
    for (const bad of ['<ENVELOPE/>', valid.replace('<COMPANY>Fixture', '<COMPANY>Other'),
        valid.replace(scope.companyGuid, '00000000-2222-3333-4444-555555555555'),
        valid.replace('<GUID>fixture-guid', '<GUID>wrong'), valid.replace('<MASTERID>42', '<MASTERID>43'),
        valid.replace('<ALTERID>123', '<ALTERID>-1'), valid.replace('<DATE>20260902', '<DATE>20260230'),
        valid.replace('<DATE>20260902', '<DATE>20280301'), valid.replace('<CANCELLED>0', '<CANCELLED>1'),
        valid.replace('<OPTIONAL>0', '<OPTIONAL>1'), valid.replace('<ELIGIBLE>1', '<ELIGIBLE>0'),
        valid.replace('<ORDERCOUNT>1</ORDERCOUNT>', ''), valid.replace('<ORDERCOUNT>1', '<ORDERCOUNT>0'),
        valid.replace('<GUID>fixture-guid</GUID>', '<GUID>fixture-guid</GUID><GUID>fixture-guid</GUID>'),
        valid.replace('<ENVELOPE>', '<ENVELOPE extra="ignored">'), valid.replace('<NUMBER>SO-1</NUMBER>', ''),
        valid.replace('<ENVELOPE>', '<ENVELOPE>unexpected text'),
        valid.replace('</ORDER>', '<UNKNOWN>data</UNKNOWN></ORDER>')]) {
        assert.throws(() => parseDirectOrderResponse(bad, scope), bad);
    }
});

test('dedicated fetch parser cannot return incomplete direct data to publication', async () => {
    const log = new BackfillDiagnostics({ write: () => {} });
    const run = xml => fetchBackfillVouchers({ post: async () => xml }, '<REQUEST/>', table, scope.company, log, false,
        body => [parseDirectOrderResponse(body, scope)]);
    assert.equal((await run(fixture()))[0].alterid, 123);
    await assert.rejects(run('<ENVELOPE/>'));
});

test('batch candidate distinguishes explicit zero from empty or incorrect reports', () => {
    const metadata = `PROTOCOL="KE_BATCH_PROBE_V1" COMPANY="Fixture" COMPANYGUID="${scope.companyGuid}"`;
    const empty = `<ENVELOPE><KEBATCH ${metadata} COUNT="0"/></ENVELOPE>`;
    const one = `<ENVELOPE><KEBATCH ${metadata} COUNT="1"><KEVOUCHER><F01>fixture-guid</F01><F02>123</F02></KEVOUCHER></KEBATCH></ENVELOPE>`;
    inspectBatchOrderProbe(empty, scope, true);
    inspectBatchOrderProbe(one, scope, false);
    for (const xml of ['<ENVELOPE/>', empty.replace('COUNT="0"', ''), empty.replace('Fixture', 'Other'), one]) {
        assert.throws(() => inspectBatchOrderProbe(xml, scope, true));
    }
    for (const isEmpty of [false, true]) {
        const request = batchOrderProbe(scope, table, isEmpty);
        assert.equal(XMLValidator.validate(request), true);
        assert.match(request, /<XMLATTR>/);
        assert.doesNotMatch(request, /KEMetadataPart|TOPPARTS/);
    }
});
