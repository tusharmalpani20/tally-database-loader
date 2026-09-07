import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import yaml from 'js-yaml';
import { XMLValidator } from 'fast-xml-parser';
import { parseOrderVouchers, parseVoucherIdentities, resolveOrderNumber, validateOrderDetails } from '../dist/order-details.mjs';
import { generateXMLfromYAML, withAdditionalFilters } from '../dist/yaml-report-exporter.mjs';
import { backfillDefinition } from '../dist/order-backfill.mjs';
import { csvColumns, copyStatement } from '../dist/postgres-columns.mjs';

const table = yaml.load(fs.readFileSync('tally-export-config-focused-incremental.yaml', 'utf8')).transaction[0];
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

export function response(orders = [{ order_number: 'KE-SO-00018-26-27', order_date: '20260902' }], revision = 5) {
    const values = { guid: 'fixture-guid', alterid: String(revision), voucher_number: 'KP/8535/26-27',
        date: '20260902', order_details: 'KE_COMPUTED', order_number: 'KE_COMPUTED' };
    return `<ENVELOPE><KEEXPORTCOUNT>1</KEEXPORTCOUNT><KEVOUCHER><KEORDERCOUNT>${orders.length}</KEORDERCOUNT>`
        + table.fields.map((field, index) => `<F${String(index + 1).padStart(2, '0')}>${escape(values[field.name] || '')}</F${String(index + 1).padStart(2, '0')}>`).join('')
        + orders.map(row => `<KEORDER><KEORDERNUMBER>${escape(row.order_number)}</KEORDERNUMBER><KEORDERDATE>${row.order_date || ''}</KEORDERDATE></KEORDER>`).join('')
        + '</KEVOUCHER></ENVELOPE>';
}

test('structured report fetches voucher order list without modifying installed inventory TDL', () => {
    const xml = generateXMLfromYAML(withAdditionalFilters(table, ['$AlterID <= 10']));
    assert.equal(XMLValidator.validate(xml), true);
    assert.match(xml, /InvoiceOrderList\.\*/);
    assert.match(xml, /\$BasicPurchaseOrderNo/);
    assert.match(xml, /KEORDERCOUNT/);
    assert.match(xml, /KEEXPORTCOUNT/);
    assert.match(xml, /&lt;= 10/);
    assert.doesNotMatch(xml, /<ID>DB Voucher Inventory Lines/);
});

test('known challan extracts the voucher-level order number and date', () => {
    const [row] = parseOrderVouchers(response(), table);
    assert.equal(row.guid, 'fixture-guid');
    assert.equal(row.order_number, 'KE-SO-00018-26-27');
    assert.deepEqual(row.order_details, [{ order_number: 'KE-SO-00018-26-27', order_date: '2026-09-02' }]);
});

test('production parsing verifies the returned company', () => {
    assert.throws(() => parseOrderVouchers(response(), table, 'Fixture Co'));
    const xml = response().replace('<ENVELOPE>', '<ENVELOPE><KECOMPANY>Fixture Co</KECOMPANY>');
    assert.equal(parseOrderVouchers(xml, table, 'Fixture Co').length, 1);
    assert.throws(() => parseOrderVouchers(xml, table, 'Other Co'));
});

test('voucher deletion scan is counted and company-checked without exporting order lists', () => {
    const identityTable = { ...table, order_details: false, voucher_identities: true, fields: table.fields.slice(0, 2) };
    const request = generateXMLfromYAML(identityTable);
    assert.equal(XMLValidator.validate(request), true);
    assert.match(request, /KEEXPORTCOUNT/);
    assert.doesNotMatch(request, /<EXPLODE>/);
    const row = '<KEVOUCHER><F01>fixture</F01><F02>10</F02></KEVOUCHER>';
    const xml = `<ENVELOPE><KECOMPANY>Fixture</KECOMPANY><KEEXPORTCOUNT>1</KEEXPORTCOUNT>${row}</ENVELOPE>`;
    assert.deepEqual(parseVoucherIdentities(xml, 'Fixture'), [['fixture', '10']]);
    assert.throws(() => parseVoucherIdentities(xml.replace(row, ''), 'Fixture'));
    assert.throws(() => parseVoucherIdentities(xml, 'Other'));
    assert.throws(() => parseVoucherIdentities(xml.replace('<F02>10', '<F02>bad'), 'Fixture'));
    assert.throws(() => parseVoucherIdentities(xml.replace(row, row + row).replace('COUNT>1', 'COUNT>2'), 'Fixture'));
});

test('publication contract rejects invalid dates, controls and unnormalized identifiers', () => {
    for (const entry of [null, {}, { order_number: 'X' }, { order_number: ' X ', order_date: null },
        { order_number: 'X\tY', order_date: null }, { order_number: 'X', order_date: '0000-01-01' },
        { order_number: 'X', order_date: '2026-02-30' }]) {
        assert.throws(() => validateOrderDetails([entry]));
    }
    validateOrderDetails([{ order_number: '😀'.repeat(140), order_date: null }]);
    assert.throws(() => validateOrderDetails([{ order_number: '😀'.repeat(141), order_date: null }]));
});

test('valid empty and repeated order entries remain distinguishable from missing extraction', () => {
    assert.deepEqual(parseOrderVouchers('<ENVELOPE><KEEXPORTCOUNT>0</KEEXPORTCOUNT></ENVELOPE>', table), []);
    assert.deepEqual(parseOrderVouchers(response([]), table)[0].order_details, []);
    assert.equal(parseOrderVouchers(response([]), table)[0].order_number, null);
    assert.equal(resolveOrderNumber([{ order_number: ' A ' }, { order_number: 'A' }]), 'A');
    assert.equal(resolveOrderNumber([{ order_number: 'A' }, { order_number: 'B' }]), null);
});

test('preserves all distinct order entries and escaped Unicode content', () => {
    const [row] = parseOrderVouchers(response([{ order_number: ' ग्राहक & <A> "one" ' }, { order_number: 'B' }]), table);
    assert.equal(row.order_number, null);
    assert.equal(row.order_details[0].order_number, 'ग्राहक & <A> "one"');
    assert.equal(row.order_details.length, 2);
});

test('rejects malformed, missing, duplicate and inconsistent export data before loading', () => {
    for (const xml of [response().slice(0, -10), '<ENVELOPE/>',
        '<ENVELOPE><LINEERROR>Error</LINEERROR></ENVELOPE>',
        response().replace('<KEORDERCOUNT>1', '<KEORDERCOUNT>2'),
        response().replace('<KEEXPORTCOUNT>1', '<KEEXPORTCOUNT>0'),
        response().replace('20260902</KEORDERDATE>', '20260230</KEORDERDATE>'),
        response().replace('<F01>fixture-guid</F01>', '<F01>fixture-guid</F01><F01>duplicate</F01>')]) {
        assert.throws(() => parseOrderVouchers(xml, table));
    }
});

test('backfill has explicit bounded GUIDs and no incremental lower bound', () => {
    const request = backfillDefinition(table, ['fixture-guid']);
    assert.match(request.filters.at(-1), /\$Guid = "fixture-guid"/);
    assert.ok(!request.filters.some(value => value.includes('$AlterID')));
    assert.throws(() => backfillDefinition(table, []));
    assert.throws(() => backfillDefinition(table, ['bad"guid']));
    assert.throws(() => backfillDefinition(table, ['same', 'same']));
});

test('COPY names columns explicitly for old profiles and JSON-generated CSV headers', () => {
    assert.equal(copyStatement('trn_voucher', csvColumns('\uFEFF"guid","alterid"')),
        'copy "trn_voucher" ("guid","alterid") from stdin csv header;');
    assert.deepEqual(csvColumns('guid,alterid'), ['guid', 'alterid']);
    assert.throws(() => csvColumns('guid,guid'));
    assert.throws(() => csvColumns('guid;drop table x'));
});
