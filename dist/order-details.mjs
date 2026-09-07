import { XMLParser, XMLValidator } from 'fast-xml-parser';
export function resolveOrderNumber(details) {
    const numbers = [...new Set(details.map(row => row.order_number.trim()).filter(Boolean))];
    return numbers.length === 1 ? numbers[0] : null;
}
// Validate again at the publication boundary; staged files and backfill callers are
// not trusted merely because the normal XML path also validates its output.
export function validateOrderDetails(value) {
    if (!Array.isArray(value))
        throw new Error('Order details must be an extracted list');
    for (const entry of value) {
        if (!entry || typeof entry !== 'object' || typeof entry.order_number !== 'string'
            || entry.order_number !== entry.order_number.trim()
            || [...entry.order_number].length > 140 || /[\u0000-\u001f\u007f]/.test(entry.order_number)) {
            throw new Error('Invalid voucher order number');
        }
        if (entry.order_date !== null && (typeof entry.order_date !== 'string'
            || !/^\d{4}-\d{2}-\d{2}$/.test(entry.order_date)
            || orderDate(entry.order_date) !== entry.order_date))
            throw new Error('Invalid voucher order date');
    }
}
function orderDate(value) {
    if (!value)
        return null;
    const date = /^\d{8}$/.test(value)
        ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6)}` : value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date.startsWith('0000-') || !Number.isFinite(Date.parse(date))
        || new Date(date).toISOString().slice(0, 10) !== date) {
        throw new Error('Invalid voucher order date');
    }
    return date;
}
function scalar(object, name) {
    if (!(name in object) || typeof object[name] !== 'string') {
        throw new Error(`Missing or non-scalar order export field ${name}`);
    }
    return object[name].trim();
}
// A counted collection distinguishes a genuinely empty list from missing extraction.
// Keep this separate from the legacy tag-stripping scalar exporter.
function countedVoucherRows(xml, expectedCompany) {
    if (/<!DOCTYPE|<!ENTITY|<(?:LINEERROR|ERROR|EXCEPTIONS)(?:\s|>)/i.test(xml)
        || XMLValidator.validate(xml) !== true) {
        throw new Error('Invalid or incomplete voucher order XML');
    }
    const parsed = new XMLParser({ parseTagValue: false, trimValues: false,
        ignoreAttributes: true, isArray: name => ['KEVOUCHER', 'KEORDER'].includes(name.toUpperCase()),
        transformTagName: name => name.toUpperCase() }).parse(xml);
    const envelope = parsed.ENVELOPE;
    if (!envelope || typeof envelope !== 'object' || !('KEEXPORTCOUNT' in envelope)) {
        throw new Error('Missing voucher export completeness count');
    }
    const count = scalar(envelope, 'KEEXPORTCOUNT');
    if (expectedCompany !== undefined && (!expectedCompany || scalar(envelope, 'KECOMPANY') !== expectedCompany)) {
        throw new Error('Voucher export company does not match the requested company');
    }
    if (!/^\d+$/.test(count))
        throw new Error('Invalid voucher export count');
    const rows = envelope.KEVOUCHER || [];
    if (!Array.isArray(rows) || rows.length !== Number(count))
        throw new Error('Voucher export count mismatch');
    return rows;
}
export function parseVoucherIdentities(xml, expectedCompany) {
    const seen = new Set();
    return countedVoucherRows(xml, expectedCompany).map(row => {
        const guid = scalar(row, 'F01');
        const alterid = scalar(row, 'F02');
        if (!guid || seen.has(guid) || /[\t\r\n]/.test(guid) || !/^\d+$/.test(alterid)
            || !Number.isSafeInteger(Number(alterid)))
            throw new Error('Invalid voucher diff identity');
        seen.add(guid);
        return [guid, alterid];
    });
}
export function parseOrderVouchers(xml, table, expectedCompany) {
    const rows = countedVoucherRows(xml, expectedCompany);
    const seen = new Set();
    return rows.map((row) => {
        const values = table.fields.map((_, index) => scalar(row, `F${String(index + 1).padStart(2, '0')}`));
        const guid = values[table.fields.findIndex(field => field.name === 'guid')];
        const revision = values[table.fields.findIndex(field => field.name === 'alterid')];
        if (!guid || seen.has(guid) || !/^\d+$/.test(revision) || !Number.isSafeInteger(Number(revision))) {
            throw new Error('Missing, duplicate, or invalid voucher identity');
        }
        seen.add(guid);
        const orders = row.KEORDER || [];
        const orderCount = scalar(row, 'KEORDERCOUNT');
        if (!/^\d+$/.test(orderCount) || !Array.isArray(orders) || orders.length !== Number(orderCount)) {
            throw new Error('Voucher order collection count mismatch');
        }
        const details = orders.map(entry => ({
            order_number: scalar(entry, 'KEORDERNUMBER'),
            order_date: orderDate(scalar(entry, 'KEORDERDATE'))
        }));
        validateOrderDetails(details);
        const number = resolveOrderNumber(details);
        values[table.fields.findIndex(field => field.name === 'order_details')] = JSON.stringify(details);
        // The PostgreSQL writer maps the empty scalar to NULL for this one column.
        values[table.fields.findIndex(field => field.name === 'order_number')] = number || '';
        return { guid, alterid: Number(revision), order_details: details, order_number: number, values };
    });
}
export function addOrderDetailReport(xml, table) {
    if (table.voucher_identities) {
        if (table.fields.map(field => field.name).join(',') !== 'guid,alterid')
            throw new Error('Invalid voucher diff definition');
        return addCountedVoucherReport(xml);
    }
    if (table.name !== 'trn_voucher' || !['guid', 'alterid', 'order_details', 'order_number']
        .every(name => table.fields.some(field => field.name === name))) {
        throw new Error('Order details require a trn_voucher definition with identity and destination fields');
    }
    return addCountedVoucherReport(xml)
        .replace('<LINE NAME="MyLine"><XMLTAG>KEVOUCHER</XMLTAG><FIELDS>', '<LINE NAME="MyLine"><XMLTAG>KEVOUCHER</XMLTAG><EXPLODE>KEOrders : Yes</EXPLODE><FIELDS>KEOrderCount,')
        .replace('</TDLMESSAGE>', `
<FIELD NAME="KEOrderCount"><SET>$$NumItems:InvoiceOrderList</SET><XMLTAG>KEORDERCOUNT</XMLTAG></FIELD>
<PART NAME="KEOrders"><LINES>KEOrderLine</LINES><REPEAT>KEOrderLine : InvoiceOrderList</REPEAT></PART>
<LINE NAME="KEOrderLine"><XMLTAG>KEORDER</XMLTAG><FIELDS>KEOrderNumber,KEOrderDate</FIELDS></LINE>
<FIELD NAME="KEOrderNumber"><SET>$BasicPurchaseOrderNo</SET><XMLTAG>KEORDERNUMBER</XMLTAG></FIELD>
<FIELD NAME="KEOrderDate"><SET>If $$IsEmpty:$BasicOrderDate Then "" Else (($$YearOfDate:$BasicOrderDate)*10000)+(($$MonthOfDate:$BasicOrderDate)*100)+$$DayOfDate:$BasicOrderDate</SET><XMLTAG>KEORDERDATE</XMLTAG></FIELD>
</TDLMESSAGE>`);
}
function addCountedVoucherReport(xml) {
    return xml
        .replace('<REPORT NAME="TallyDatabaseLoaderReport">', '<REPORT NAME="TallyDatabaseLoaderReport"><EXPORTEMPTYFIELDS>Yes</EXPORTEMPTYFIELDS>')
        .replace('<LINES>MyLine</LINES>', '<LINES>KEExportCount,MyLine</LINES>')
        .replace('<LINE NAME="MyLine"><FIELDS>', '<LINE NAME="MyLine"><XMLTAG>KEVOUCHER</XMLTAG><FIELDS>')
        .replace('</TDLMESSAGE>', `
<LINE NAME="KEExportCount"><FIELDS>KEExportCountField,KECompany</FIELDS></LINE>
<FIELD NAME="KECompany"><SET>##SVCURRENTCOMPANY</SET><XMLTAG>KECOMPANY</XMLTAG></FIELD>
<FIELD NAME="KEExportCountField"><SET>$$NumItems:MyCollection</SET><XMLTAG>KEEXPORTCOUNT</XMLTAG></FIELD>
</TDLMESSAGE>`);
}
//# sourceMappingURL=order-details.mjs.map