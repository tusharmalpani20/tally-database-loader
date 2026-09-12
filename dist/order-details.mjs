import { XMLParser, XMLValidator } from 'fast-xml-parser';
// Normalize only at the Tally ingestion boundary. Publication still validates
// staged values strictly so corrupt or manually edited data cannot bypass checks.
export function normalizeOrderNumber(value, guid, entryIndex, context = {}) {
    const controls = value.match(/[\u0000-\u001f\u007f-\u009f]/g)?.length || 0;
    const cleaned = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim();
    const characters = [...cleaned];
    const normalized = characters.slice(0, 140).join('').trimEnd();
    if (normalized !== value) {
        console.warn(`[voucher-orders] Normalized order number ${JSON.stringify({
            ...context, guid, entry: entryIndex + 1, originalOrderNumber: value,
            normalizedOrderNumber: normalized, originalCharacters: [...value].length,
            normalizedCharacters: [...normalized].length, controlCharactersReplaced: controls,
            truncatedCharacters: Math.max(0, characters.length - 140)
        })}`);
    }
    return normalized;
}
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
            || [...entry.order_number].length > 140 || /[\u0000-\u001f\u007f-\u009f]/.test(entry.order_number)) {
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
function scalar(object, name, trim = true) {
    if (!(name in object) || typeof object[name] !== 'string') {
        throw new Error(`Missing or non-scalar order export field ${name}`);
    }
    return trim ? object[name].trim() : object[name];
}
function assertStructure(value, allowed, context) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).some(key => key !== '#text' && !allowed.includes(key))) {
        throw new Error(`Unexpected ${context} structure`);
    }
    const text = value['#text'];
    if (text !== undefined && (typeof text !== 'string' || text.trim()))
        throw new Error(`Unexpected ${context} text`);
}
function insertOnce(xml, anchor, replacement) {
    const position = xml.indexOf(anchor);
    if (position < 0 || xml.indexOf(anchor, position + anchor.length) >= 0) {
        throw new Error(`Voucher report template must contain exactly one ${anchor}`);
    }
    // A callback is essential: replacement strings consume $$, $&, $` and $'.
    return xml.replace(anchor, () => replacement);
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
    if (!envelope || typeof envelope !== 'object') {
        throw new Error('Missing voucher export completeness count');
    }
    // Accept both the company-root flat layout and the earlier nested layout.
    // Accept the earlier flat layout too, but never accept absent/ambiguous metadata.
    const metadata = envelope.KEMETADATA ?? envelope;
    if (Array.isArray(metadata))
        throw new Error('Ambiguous voucher export metadata');
    if (typeof metadata !== 'object' || !('KEEXPORTCOUNT' in metadata))
        throw new Error('Missing voucher export completeness count');
    assertStructure(envelope, ['KEMETADATA', 'KEEXPORTCOUNT', 'KECOMPANY', 'KEVOUCHER'], 'voucher envelope');
    if (metadata !== envelope)
        assertStructure(metadata, ['KEEXPORTCOUNT', 'KECOMPANY'], 'voucher metadata');
    if (envelope.KEMETADATA && ('KEEXPORTCOUNT' in envelope || 'KECOMPANY' in envelope)) {
        throw new Error('Ambiguous voucher export metadata');
    }
    const count = scalar(metadata, 'KEEXPORTCOUNT');
    if (expectedCompany !== undefined && (!expectedCompany || scalar(metadata, 'KECOMPANY') !== expectedCompany)) {
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
        assertStructure(row, ['F01', 'F02', 'FLDBLANK'], 'voucher identity');
        const guid = scalar(row, 'F01');
        const alterid = scalar(row, 'F02');
        if (!guid || seen.has(guid) || /[\t\r\n]/.test(guid) || !/^\d+$/.test(alterid)
            || !Number.isSafeInteger(Number(alterid)))
            throw new Error('Invalid voucher diff identity');
        seen.add(guid);
        return [guid, alterid];
    });
}
export function parseOrderVouchers(xml, table, expectedCompany, direct = false) {
    const rows = countedVoucherRows(xml, expectedCompany);
    const seen = new Set();
    return rows.map((row) => {
        assertStructure(row, ['KEORDERCOUNT', 'KEORDER', 'FLDBLANK', ...(direct ? ['KEDIRECTELIGIBLE'] : []),
            ...table.fields.map((_, index) => `F${String(index + 1).padStart(2, '0')}`)], 'voucher row');
        if (direct && scalar(row, 'KEDIRECTELIGIBLE') !== '1')
            throw new Error('Direct voucher is outside the eligible filters or export period');
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
        const details = orders.map((entry, index) => {
            try {
                assertStructure(entry, ['KEORDERNUMBER', 'KEORDERDATE'], 'voucher order');
                const order_date = orderDate(scalar(entry, 'KEORDERDATE'));
                const context = Object.fromEntries(table.fields.map((field, i) => [field.name, values[i]])
                    .filter(([name]) => ['alterid', 'voucher_number', 'voucher_type', 'date', 'party_name'].includes(name)));
                return { order_number: normalizeOrderNumber(scalar(entry, 'KEORDERNUMBER', false), guid, index, { ...context, company: expectedCompany, orderDate: order_date }), order_date };
            }
            catch (error) {
                throw new Error(`Voucher ${JSON.stringify(guid)} order entry ${index + 1}: ${error instanceof Error ? error.message : 'invalid order data'}`);
            }
        });
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
    xml = addCountedVoucherReport(xml);
    xml = insertOnce(xml, '<LINE NAME="MyLine"><XMLTAG>KEVOUCHER</XMLTAG><FIELDS>', '<LINE NAME="MyLine"><XMLTAG>KEVOUCHER</XMLTAG><EXPLODE>KEOrders : Yes</EXPLODE><FIELDS>KEOrderCount,');
    return insertOnce(xml, '</TDLMESSAGE>', `
<FIELD NAME="KEOrderCount"><SET>$$NumItems:InvoiceOrderList</SET><XMLTAG>KEORDERCOUNT</XMLTAG></FIELD>
<PART NAME="KEOrders"><LINES>KEOrderLine</LINES><REPEAT>KEOrderLine : InvoiceOrderList</REPEAT></PART>
<LINE NAME="KEOrderLine"><XMLTAG>KEORDER</XMLTAG><FIELDS>KEOrderNumber,KEOrderDate</FIELDS></LINE>
<FIELD NAME="KEOrderNumber"><SET>$BasicPurchaseOrderNo</SET><XMLTAG>KEORDERNUMBER</XMLTAG></FIELD>
<FIELD NAME="KEOrderDate"><SET>If $$IsEmpty:$BasicOrderDate Then "" Else (($$YearOfDate:$BasicOrderDate)*10000)+(($$MonthOfDate:$BasicOrderDate)*100)+$$DayOfDate:$BasicOrderDate</SET><XMLTAG>KEORDERDATE</XMLTAG></FIELD>
</TDLMESSAGE>`);
}
function addCountedVoucherReport(xml) {
    xml = insertOnce(xml, '<REPORT NAME="TallyDatabaseLoaderReport">', '<REPORT NAME="TallyDatabaseLoaderReport"><EXPORTEMPTYFIELDS>Yes</EXPORTEMPTYFIELDS>');
    // Metadata must be the root of the exported hierarchy, not a sibling part
    // which Tally can omit from XML. Explode vouchers beneath the company line.
    // Give this outer repeated part vertical scrolling too, matching the working
    // export layout; scrolling only MyPart leaves its parent without that layout.
    xml = insertOnce(xml, '<PARTS>MyPart</PARTS>', '<TOPPARTS>KEMetadataPart</TOPPARTS>');
    xml = insertOnce(xml, '<LINE NAME="MyLine"><FIELDS>', '<LINE NAME="MyLine"><XMLTAG>KEVOUCHER</XMLTAG><FIELDS>');
    return insertOnce(xml, '</TDLMESSAGE>', `
<PART NAME="KEMetadataPart"><TOPLINES>KEExportCount</TOPLINES><REPEAT>KEExportCount : KEMetadataCompany</REPEAT><SCROLLED>Vertical</SCROLLED></PART>
<LINE NAME="KEExportCount"><FIELDS>KEExportCountField,KECompany</FIELDS><EXPLODE>MyPart : Yes</EXPLODE></LINE>
<COLLECTION NAME="KEMetadataCompany"><TYPE>Company</TYPE><FETCH>Name</FETCH><FILTER>KEMetadataCurrentCompany</FILTER></COLLECTION>
<SYSTEM TYPE="Formulae" NAME="KEMetadataCurrentCompany">$$IsEqual:$Name:##SVCurrentCompany</SYSTEM>
<FIELD NAME="KECompany"><SET>$Name</SET><XMLTAG>KECOMPANY</XMLTAG></FIELD>
<FIELD NAME="KEExportCountField"><SET>$$NumItems:MyCollection</SET><XMLTAG>KEEXPORTCOUNT</XMLTAG></FIELD>
</TDLMESSAGE>`);
}
// Bind only the voucher part to a primary object. The company-root metadata
// remains independently evaluated; no synthetic client-side count is injected.
export function directOrderReport(xml, masterId) {
    if (!/^[1-9]\d{0,9}$/.test(masterId))
        throw new Error('Invalid Tally MasterID (not AlterID)');
    const collections = xml.match(/<COLLECTION NAME="MyCollection">[\s\S]*?<\/COLLECTION>/g);
    if (collections?.length !== 1)
        throw new Error('Direct backfill requires exactly one voucher collection');
    // Preserve the filters actually attached to the removed collection, not
    // unrelated formula definitions which may be present elsewhere in the TDL.
    const filterTags = [...collections[0].matchAll(/<FILTER>([^<]*)<\/FILTER>/g)];
    if (filterTags.length !== 1)
        throw new Error('Direct backfill requires voucher eligibility filters');
    const filterNames = filterTags[0][1].split(',').map(name => name.trim());
    if (!filterNames.length || new Set(filterNames).size !== filterNames.length
        || filterNames.some(name => !/^Fltr\d+$/.test(name)
            || xml.split(`<SYSTEM TYPE="Formulae" NAME="${name}">`).length !== 2)) {
        throw new Error('Direct backfill has missing or ambiguous eligibility formulas');
    }
    const filters = filterNames.map(name => `@@${name}`);
    xml = insertOnce(xml, '<PART NAME="MyPart">', `<PART NAME="MyPart"><OBJECTEX>(Voucher,"ID:${masterId}")</OBJECTEX>`);
    xml = insertOnce(xml, '<REPEAT>MyLine : MyCollection</REPEAT>', '');
    xml = insertOnce(xml, collections[0], '');
    xml = insertOnce(xml, '<FIELDS>KEOrderCount,', '<FIELDS>KEDirectEligible,KEOrderCount,');
    xml = insertOnce(xml, '</TDLMESSAGE>', `<FIELD NAME="KEDirectEligible"><SET>If (${filters.join(' AND ')} AND $Date &gt;= ##SVFromDate AND $Date &lt;= ##SVToDate) Then 1 Else 0</SET><XMLTAG>KEDIRECTELIGIBLE</XMLTAG></FIELD></TDLMESSAGE>`);
    return insertOnce(xml, '$$NumItems:MyCollection', `If $$IsEmpty:$Guid:Voucher:"ID:${masterId}" Then 0 Else 1`);
}
//# sourceMappingURL=order-details.mjs.map