import { XMLParser, XMLValidator } from 'fast-xml-parser';
import type { tableConfigYAML } from './definition.mjs';
import { generateXMLfromYAML, substituteTDLParameters } from './yaml-report-exporter.mjs';
import { validateDirectOrderScope, type DirectOrderScope } from './direct-order-protocol.mjs';

// Read-only compatibility probe. Never used by scheduled publication until the
// zero/one-row envelope has been verified on the target Tally runtime.
export function batchOrderProbe(scope: DirectOrderScope, source: tableConfigYAML, empty: boolean): string {
    validateDirectOrderScope(scope);
    if (!source.order_details || source.name !== 'trn_voucher' || !source.filters?.length) throw new Error('Batch probes require the order-detail voucher profile with eligibility filters');
    const table = { ...source, order_details: false, voucher_identities: false,
        fields: [{ name: 'guid', field: 'Guid', type: 'text' }, { name: 'alterid', field: 'AlterID', type: 'number' }],
        fetch: ['Guid,AlterID'], filters: [...(source.filters || []), `$Guid = "${scope.guid}"`, ...(empty ? ['No'] : [])] };
    let xml = generateXMLfromYAML(table);
    const replace = (anchor: string, value: string) => {
        if (xml.split(anchor).length !== 2) throw new Error('Batch probe template is ambiguous');
        xml = xml.replace(anchor, () => value);
    };
    replace('<FORM NAME="MyForm">', `<FORM NAME="MyForm"><XMLTAG>KEBATCH</XMLTAG>
<XMLATTR>"PROTOCOL" : "KE_BATCH_PROBE_V1"</XMLATTR>
<XMLATTR>"COMPANY" : $Name:Company:##SVCurrentCompany</XMLATTR>
<XMLATTR>"COMPANYGUID" : $GUID:Company:##SVCurrentCompany</XMLATTR>
<XMLATTR>"COUNT" : $$NumItems:MyCollection</XMLATTR>`);
    replace('<LINE NAME="MyLine">', '<LINE NAME="MyLine"><XMLTAG>KEVOUCHER</XMLTAG>');
    return substituteTDLParameters(xml, new Map([['targetCompany', scope.company], ['fromDate', scope.from.replaceAll('-', '')], ['toDate', scope.to.replaceAll('-', '')]]));
}

export function inspectBatchOrderProbe(xml: string, scope: DirectOrderScope, empty: boolean): void {
    validateDirectOrderScope(scope);
    if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) throw new Error('Invalid batch probe XML');
    const parsed = new XMLParser({ ignoreAttributes: false, ignoreDeclaration: true, parseTagValue: false,
        parseAttributeValue: false, trimValues: true, isArray: name => name === 'KEVOUCHER' }).parse(xml);
    const shape = (value: any, names: string[]) => {
        if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !names.includes(key))) throw new Error('Unexpected batch probe structure');
    };
    shape(parsed, ['ENVELOPE']); shape(parsed.ENVELOPE, ['KEBATCH']);
    const batch = parsed.ENVELOPE.KEBATCH;
    shape(batch, ['@_PROTOCOL', '@_COMPANY', '@_COMPANYGUID', '@_COUNT', 'KEVOUCHER']);
    if (batch['@_PROTOCOL'] !== 'KE_BATCH_PROBE_V1' || batch['@_COMPANY'] !== scope.company
        || typeof batch['@_COMPANYGUID'] !== 'string' || batch['@_COMPANYGUID'].toLowerCase() !== scope.companyGuid.toLowerCase()
        || batch['@_COUNT'] !== (empty ? '0' : '1')) throw new Error('Missing or incorrect batch probe metadata');
    const rows = batch.KEVOUCHER ?? [];
    if (!Array.isArray(rows) || rows.length !== (empty ? 0 : 1)) throw new Error('Batch probe count mismatch');
    for (const row of rows) {
        shape(row, ['F01', 'F02', 'FLDBLANK']);
        if (row.F01 !== scope.guid || typeof row.F02 !== 'string' || !/^\d+$/.test(row.F02)
            || !Number.isSafeInteger(Number(row.F02))) throw new Error('Invalid batch probe identity');
    }
}
