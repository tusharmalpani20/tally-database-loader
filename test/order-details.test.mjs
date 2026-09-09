import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import yaml from 'js-yaml';
import { XMLValidator } from 'fast-xml-parser';
import { addOrderDetailReport, directOrderReport, parseOrderVouchers, parseVoucherIdentities, resolveOrderNumber, validateOrderDetails } from '../dist/order-details.mjs';
import { generateXMLfromYAML, substituteTDLParameters, withAdditionalFilters } from '../dist/yaml-report-exporter.mjs';
import { backfillDefinition, backfillPeriod } from '../dist/order-backfill.mjs';
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

test('final backfill request preserves every TDL function and literal company substitution', () => {
    const company = 'Fixture $$ & $& Co';
    const request = substituteTDLParameters(generateXMLfromYAML(backfillDefinition(table, ['fixture-guid'])),
        new Map([['targetCompany', company], ['fromDate', '20240401'], ['toDate', '20270331']]));
    assert.equal(XMLValidator.validate(request), true);
    for (const expression of ['$$NumItems:MyCollection', '$$NumItems:InvoiceOrderList',
        '$$IsEmpty:$BasicOrderDate', '$$YearOfDate:$BasicOrderDate',
        '$$MonthOfDate:$BasicOrderDate', '$$DayOfDate:$BasicOrderDate', '$$IsEqual:$Name:##SVCurrentCompany']) {
        assert.ok(request.includes(expression), `TDL expression was corrupted: ${expression}`);
    }
    assert.doesNotMatch(request, /(?<!\$)\$(?:NumItems|IsEmpty|YearOfDate|MonthOfDate|DayOfDate|IsEqual):/);
    assert.ok(request.includes('<SVCURRENTCOMPANY>Fixture $$ &amp; $&amp; Co</SVCURRENTCOMPANY>'));
    assert.match(request, /<TOPPARTS>KEMetadataPart<\/TOPPARTS>/);
    assert.match(request, /<REPEAT>KEExportCount : KEMetadataCompany<\/REPEAT>/);
    assert.match(request, /<PART NAME="KEMetadataPart"><TOPLINES>KEExportCount<\/TOPLINES><REPEAT>KEExportCount : KEMetadataCompany<\/REPEAT><SCROLLED>Vertical<\/SCROLLED><\/PART>/);
    assert.match(request, /<LINE NAME="KEExportCount"><FIELDS>KEExportCountField,KECompany<\/FIELDS><EXPLODE>MyPart : Yes<\/EXPLODE>/);
    assert.match(request, /<FIELD NAME="KECompany"><SET>\$Name<\/SET>/);
    assert.doesNotMatch(request, /<LINES>KEExportCount,MyLine<\/LINES>/);
});

test('nested company metadata validates zero, one and multiple vouchers without weakening count checks', () => {
    const metadata = '<KEMETADATA><KEEXPORTCOUNT>1</KEEXPORTCOUNT><KECOMPANY>Fixture</KECOMPANY></KEMETADATA>';
    const xml = response().replace('<KEEXPORTCOUNT>1</KEEXPORTCOUNT>', metadata);
    assert.equal(parseOrderVouchers(xml, table, 'Fixture')[0].order_number, 'KE-SO-00018-26-27');
    assert.deepEqual(parseVoucherIdentities(`<ENVELOPE>${metadata.replace('COUNT>1', 'COUNT>0')}</ENVELOPE>`, 'Fixture'), []);
    const rows = '<KEVOUCHER><F01>one</F01><F02>1</F02></KEVOUCHER><KEVOUCHER><F01>two</F01><F02>2</F02></KEVOUCHER>';
    assert.equal(parseVoucherIdentities(`<ENVELOPE>${metadata.replace('COUNT>1', 'COUNT>2')}${rows}</ENVELOPE>`, 'Fixture').length, 2);
    for (const bad of [xml.replace('COUNT>1', 'COUNT>0'), xml.replace('Fixture', 'Wrong'),
        xml.replace(metadata, metadata + metadata), xml.replace(metadata, metadata + '<KECOMPANY>Fixture</KECOMPANY>'),
        xml.replace(metadata, ''), xml.replace('<KEORDERCOUNT>1</KEORDERCOUNT>', '<KEORDERCOUNT/>')]) {
        assert.throws(() => parseOrderVouchers(bad, table, 'Fixture'));
    }
});

test('unexpected wrappers cannot hide vouchers behind a zero count', () => {
    const metadata = '<KEEXPORTCOUNT>0</KEEXPORTCOUNT><KECOMPANY>Fixture</KECOMPANY>';
    const row = '<KEVOUCHER><F01>one</F01><F02>1</F02></KEVOUCHER>';
    for (const xml of [
        `<ENVELOPE><KEMETADATA>${metadata}${row}</KEMETADATA></ENVELOPE>`,
        `<ENVELOPE>${metadata}<UNEXPECTED>${row}</UNEXPECTED></ENVELOPE>`,
        `<ENVELOPE>${metadata}unexplained text</ENVELOPE>`
    ]) assert.throws(() => parseVoucherIdentities(xml, 'Fixture'), /Unexpected/);
});

test('unexpected order wrappers cannot be interpreted as an empty order list', () => {
    const hiddenOrder = '<WRAPPER><KEORDER><KEORDERNUMBER>SO-1</KEORDERNUMBER><KEORDERDATE/></KEORDER></WRAPPER>';
    assert.throws(() => parseOrderVouchers(response([]).replace('</KEVOUCHER>', hiddenOrder + '</KEVOUCHER>'), table), /Unexpected/);
    assert.throws(() => parseOrderVouchers(response().replace('</KEORDER>', '<UNKNOWN>data</UNKNOWN></KEORDER>'), table), /Unexpected/);
});

test('missing or duplicate insertion anchors fail before an incomplete TDL request can be sent', () => {
    const base = generateXMLfromYAML({ ...table, order_details: false });
    for (const anchor of ['<REPORT NAME="TallyDatabaseLoaderReport">', '<PARTS>MyPart</PARTS>',
        '<LINE NAME="MyLine"><FIELDS>', '</TDLMESSAGE>']) {
        assert.throws(() => addOrderDetailReport(base.replace(anchor, ''), table), /exactly one/);
        assert.throws(() => addOrderDetailReport(base.replace(anchor, anchor + anchor), table), /exactly one/);
    }
});

test('known challan extracts the voucher-level order number and date', () => {
    const [row] = parseOrderVouchers(response(), table);
    assert.equal(row.guid, 'fixture-guid');
    assert.equal(row.order_number, 'KE-SO-00018-26-27');
    assert.deepEqual(row.order_details, [{ order_number: 'KE-SO-00018-26-27', order_date: '2026-09-02' }]);
});

test('direct order report avoids voucher collection scans and preserves server-side safety checks', () => {
    const base = generateXMLfromYAML(backfillDefinition(table, ['fixture-guid']));
    const xml = directOrderReport(base, '1005439');
    assert.equal(XMLValidator.validate(xml), true);
    assert.match(xml, /<OBJECTEX>\(Voucher,"ID:1005439"\)<\/OBJECTEX>/);
    assert.doesNotMatch(xml, /<COLLECTION NAME="MyCollection">|MyLine : MyCollection|\$\$NumItems:MyCollection/);
    assert.ok(xml.includes('If $$IsEmpty:$Guid:Voucher:"ID:1005439" Then 0 Else 1'));
    assert.ok(xml.includes('@@Fltr01 AND @@Fltr02 AND @@Fltr03 AND @@Fltr04'));
    assert.match(xml, /\$Date &gt;= ##SVFromDate AND \$Date &lt;= ##SVToDate/);
    assert.match(xml, /<SET>\$Name<\/SET><XMLTAG>KECOMPANY/);
    assert.match(xml, /\$\$NumItems:InvoiceOrderList/);
    for (const id of ['', '0', '42"', '-1']) assert.throws(() => directOrderReport(base, id), /MasterID/);
    for (const anchor of ['<PART NAME="MyPart">', '<REPEAT>MyLine : MyCollection</REPEAT>', '$$NumItems:MyCollection']) {
        assert.throws(() => directOrderReport(base.replace(anchor, ''), '1005439'));
        assert.throws(() => directOrderReport(base.replace(anchor, () => anchor + anchor), '1005439'));
    }
    assert.throws(() => directOrderReport(base.replace('<FILTER>Fltr01,Fltr02,Fltr03,Fltr04</FILTER>', '<FILTER>Fltr99</FILTER>'), '1005439'), /eligibility/);
    assert.throws(() => directOrderReport(base.replace('NAME="Fltr01"', 'NAME="Missing"'), '1005439'), /eligibility/);
    const extra = base.replace('</TDLMESSAGE>', '<SYSTEM TYPE="Formulae" NAME="Fltr99">No</SYSTEM></TDLMESSAGE>');
    assert.doesNotMatch(directOrderReport(extra, '1005439'), /@@Fltr99/);
});

test('backfill period rejects invalid, reversed, missing and ambiguous database metadata', () => {
    const rows = [{ name: 'Company Name', value: 'Fixture' }, { name: 'Period From', value: '2024-04-01' }, { name: 'Period To', value: '2027-03-31' }];
    assert.deepEqual(backfillPeriod(rows, 'Fixture'), { from: '2024-04-01', to: '2027-03-31' });
    for (const from of ['2026-02-30', '0000-01-01', '2028-01-01', '', 'invalid']) {
        assert.throws(() => backfillPeriod(rows.map(row => row.name === 'Period From' ? { ...row, value: from } : row), 'Fixture'), /period/);
    }
    assert.throws(() => backfillPeriod(rows, 'Wrong'), /company/);
    assert.throws(() => backfillPeriod(rows.slice(1), 'Fixture'), /metadata/);
    assert.throws(() => backfillPeriod([...rows, rows[1]], 'Fixture'), /metadata/);
});

test('direct parsing requires explicit eligibility as well as company, count and order validation', () => {
    const xml = response().replace('<ENVELOPE>', '<ENVELOPE><KECOMPANY>Fixture</KECOMPANY>')
        .replace('<KEVOUCHER>', '<KEVOUCHER><KEDIRECTELIGIBLE>1</KEDIRECTELIGIBLE>');
    assert.equal(parseOrderVouchers(xml, table, 'Fixture', true)[0].order_number, 'KE-SO-00018-26-27');
    for (const invalid of [xml.replace('ELIGIBLE>1', 'ELIGIBLE>0'),
        xml.replace('<KEDIRECTELIGIBLE>1</KEDIRECTELIGIBLE>', ''),
        xml.replace('COUNT>1', 'COUNT>0'), xml.replace('Fixture', 'Wrong'),
        xml.replace('<KEEXPORTCOUNT>1</KEEXPORTCOUNT>', '')]) {
        assert.throws(() => parseOrderVouchers(invalid, table, 'Fixture', true));
    }
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
    assert.ok(request.includes('$$NumItems:MyCollection'));
    assert.match(request, /<TOPPARTS>KEMetadataPart<\/TOPPARTS>/);
    assert.match(request, /<PART NAME="KEMetadataPart"><TOPLINES>KEExportCount<\/TOPLINES><REPEAT>KEExportCount : KEMetadataCompany<\/REPEAT><SCROLLED>Vertical<\/SCROLLED><\/PART>/);
    assert.doesNotMatch(request, /<EXPLODE>KEOrders/);
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
