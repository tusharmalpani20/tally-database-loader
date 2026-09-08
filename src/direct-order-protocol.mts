import { XMLParser, XMLValidator } from 'fast-xml-parser';
import type { tableConfigYAML } from './definition.mjs';
import { resolveOrderNumber, validateOrderDetails, type OrderVoucher } from './order-details.mjs';

export interface DirectOrderScope {
    company: string;
    companyGuid: string;
    guid: string;
    masterId: string;
    from: string;
    to: string;
}
const VERSION = 'KE_DIRECT_ORDERS_V1';
const escape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

function calendarDate(value: string): string {
    const date = /^\d{8}$/.test(value) ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6)}` : value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date.startsWith('0000-') || !Number.isFinite(Date.parse(date))
        || new Date(date).toISOString().slice(0, 10) !== date) throw new Error('Invalid direct-order date');
    return date;
}

export function validateDirectOrderIdentity(scope: Pick<DirectOrderScope, 'company' | 'companyGuid' | 'guid' | 'masterId'>): void {
    if (!scope.company?.trim() || scope.company !== scope.company.trim() || /[\u0000-\u001f\u007f]/.test(scope.company)
        || !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(scope.companyGuid)
        || !/^[a-zA-Z0-9-]{1,64}$/.test(scope.guid) || !/^[1-9]\d{0,9}$/.test(scope.masterId)) {
        throw new Error('Direct orders require explicit company, --company-guid, one voucher GUID and MasterID');
    }
}

export function validateDirectOrderScope(scope: DirectOrderScope): void {
    validateDirectOrderIdentity(scope);
    if (calendarDate(scope.from) !== scope.from || calendarDate(scope.to) !== scope.to || scope.from > scope.to) throw new Error('Invalid direct-order period');
}

// Candidate protocol: preserves the remotely proven report-level direct binding.
// Company-object reads are exported in the SAME response and must be verified live.
export function directOrderRequest(scope: DirectOrderScope, table: tableConfigYAML): string {
    validateDirectOrderScope(scope);
    if (!table.order_details || table.name !== 'trn_voucher' || !table.filters?.length) throw new Error('Select the order-detail voucher profile with eligibility filters');
    const filters = table.filters.map(filter => `(${filter})`).join(' AND ');
    const fields: [string, string][] = [
        ['PROTOCOL', `"${VERSION}"`], ['COMPANY', '$Name:Company:##SVCurrentCompany'],
        ['COMPANYGUID', '$GUID:Company:##SVCurrentCompany'], ['GUID', '$Guid'],
        ['MASTERID', '$$String:$MasterID'], ['ALTERID', '$$String:$AlterID'], ['VOUCHERTYPE', '$VoucherTypeName'],
        ['DATE', '(($$YearOfDate:$Date)*10000)+(($$MonthOfDate:$Date)*100)+$$DayOfDate:$Date'],
        ['CANCELLED', 'If $IsCancelled Then "1" Else "0"'], ['OPTIONAL', 'If $IsOptional Then "1" Else "0"'],
        ['ELIGIBLE', `If ${filters} Then "1" Else "0"`], ['ORDERCOUNT', '$$NumItems:InvoiceOrderList']
    ];
    return `<?xml version="1.0" encoding="utf-8"?><ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Data</TYPE><ID>KEDirectOrdersV1</ID></HEADER><BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>XML</SVEXPORTFORMAT><SVCURRENTCOMPANY>${escape(scope.company)}</SVCURRENTCOMPANY><SVFROMDATE>${scope.from.replaceAll('-', '')}</SVFROMDATE><SVTODATE>${scope.to.replaceAll('-', '')}</SVTODATE></STATICVARIABLES><TDL><TDLMESSAGE>
<REPORT NAME="KEDirectOrdersV1"><EXPORTEMPTYFIELDS>Yes</EXPORTEMPTYFIELDS><OBJECT>Voucher : "ID:${scope.masterId}"</OBJECT><FORMS>KEDOForm</FORMS></REPORT>
<FORM NAME="KEDOForm"><PARTS>KEDOPart</PARTS></FORM><PART NAME="KEDOPart"><LINES>KEDOLine</LINES></PART>
<LINE NAME="KEDOLine"><FIELDS>${fields.map(([tag]) => `KEDO${tag}`).join(',')}</FIELDS><EXPLODE>KEDOOrders : Yes</EXPLODE></LINE>
${fields.map(([tag, expression]) => `<FIELD NAME="KEDO${tag}"><SET>${escape(expression)}</SET><XMLTAG>${tag}</XMLTAG></FIELD>`).join('\n')}
<PART NAME="KEDOOrders"><LINES>KEDOOrder</LINES><REPEAT>KEDOOrder : InvoiceOrderList</REPEAT></PART>
<LINE NAME="KEDOOrder"><XMLTAG>ORDER</XMLTAG><FIELDS>KEDONumber,KEDOOrderDate</FIELDS></LINE>
<FIELD NAME="KEDONumber"><SET>$BasicPurchaseOrderNo</SET><XMLTAG>NUMBER</XMLTAG></FIELD>
<FIELD NAME="KEDOOrderDate"><SET>If $$IsEmpty:$BasicOrderDate Then "" Else (($$YearOfDate:$BasicOrderDate)*10000)+(($$MonthOfDate:$BasicOrderDate)*100)+$$DayOfDate:$BasicOrderDate</SET><XMLTAG>DATE</XMLTAG></FIELD>
</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
}

function structure(value: unknown, allowed: string[]): asserts value is Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => key !== '#text' && !allowed.includes(key))) throw new Error('Unexpected direct-order response structure');
    const text = (value as Record<string, unknown>)['#text'];
    if (text !== undefined && (typeof text !== 'string' || text.trim())) throw new Error('Unexpected direct-order response text');
}
function scalar(row: Record<string, unknown>, key: string): string {
    if (typeof row[key] !== 'string') throw new Error(`Missing or ambiguous direct-order ${key}`);
    return row[key].trim();
}
function integer(row: Record<string, unknown>, key: string): number {
    const value = scalar(row, key);
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error(`Invalid direct-order ${key}`);
    return Number(value);
}

export function parseDirectOrderResponse(xml: string, scope: DirectOrderScope): OrderVoucher {
    validateDirectOrderScope(scope);
    if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) throw new Error('Invalid direct-order XML');
    const document = new XMLParser({ ignoreAttributes: false, ignoreDeclaration: true, parseTagValue: false,
        trimValues: false, isArray: name => name === 'ORDER' }).parse(xml);
    structure(document, ['ENVELOPE']);
    const row = document.ENVELOPE;
    structure(row, ['PROTOCOL', 'COMPANY', 'COMPANYGUID', 'GUID', 'MASTERID', 'ALTERID', 'VOUCHERTYPE', 'DATE', 'CANCELLED', 'OPTIONAL', 'ELIGIBLE', 'ORDERCOUNT', 'ORDER']);
    if (scalar(row, 'PROTOCOL') !== VERSION || scalar(row, 'COMPANY') !== scope.company
        || scalar(row, 'COMPANYGUID').toLowerCase() !== scope.companyGuid.toLowerCase()
        || scalar(row, 'GUID') !== scope.guid || scalar(row, 'MASTERID') !== scope.masterId) throw new Error('Direct-order source or voucher identity mismatch');
    const date = calendarDate(scalar(row, 'DATE'));
    if (!scalar(row, 'VOUCHERTYPE') || date < scope.from || date > scope.to || scalar(row, 'CANCELLED') !== '0'
        || scalar(row, 'OPTIONAL') !== '0' || scalar(row, 'ELIGIBLE') !== '1') throw new Error('Direct-order voucher is not eligible');
    const orders = row.ORDER ?? [];
    if (!Array.isArray(orders) || orders.length !== integer(row, 'ORDERCOUNT')) throw new Error('Direct-order list count mismatch');
    const order_details = orders.map(entry => {
        structure(entry, ['NUMBER', 'DATE']);
        const rawDate = scalar(entry, 'DATE');
        return { order_number: scalar(entry, 'NUMBER'), order_date: rawDate ? calendarDate(rawDate) : null };
    });
    validateOrderDetails(order_details);
    return { guid: scope.guid, alterid: integer(row, 'ALTERID'), order_details,
        order_number: resolveOrderNumber(order_details), values: [] };
}
