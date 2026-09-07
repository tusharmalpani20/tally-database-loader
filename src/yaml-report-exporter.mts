import fs from 'fs';
import path from 'path';
import process from 'process';
import { tableConfigYAML } from './definition.mjs';
import { utility } from './utility.mjs';
import { MetricsSink, PhaseTimer } from './metrics.mjs';
import { TallyTransport } from './tally-transport.mjs';
import { addOrderDetailReport, parseOrderVouchers, parseVoucherIdentities } from './order-details.mjs';

export interface ExportContext {
    syncMode?: string;
    dbTechnology?: string;
    loadMethod?: string;
}

export interface ExportResult {
    table: string;
    filePath: string;
    rows: number;
    bytes: number;
    elapsedMs: number;
}

export class YamlReportExporter {
    constructor(
        private readonly transport: TallyTransport,
        private readonly metrics: MetricsSink,
        private readonly context: ExportContext = {}
    ) { }

    async exportTable(targetTable: string, tableConfig: tableConfigYAML, substitutions?: Map<string, any>): Promise<ExportResult> {
        const timer = new PhaseTimer(this.metrics, this.metricBase('table_export', targetTable, tableConfig.collection));
        const filePath = path.join(process.cwd(), 'csv', `${targetTable}.data`);
        try {
            let xml = generateXMLfromYAML(tableConfig);
            if (substitutions && substitutions.size) {
                xml = substituteTDLParameters(xml, substitutions);
            }
            xml = dropUnresolvedStaticVariables(xml);

            const httpTimer = new PhaseTimer(this.metrics, this.metricBase('tally_http', targetTable, tableConfig.collection));
            let output: string;
            try {
                output = await this.transport.post(xml);
                httpTimer.end(true, undefined, { calls: 1 });
            } catch (err) {
                httpTimer.end(false, err, { calls: 1 });
                throw err;
            }

            const transformTimer = new PhaseTimer(this.metrics, this.metricBase('tdl_transform', targetTable, tableConfig.collection));
            const transformed = tableConfig.voucher_identities
                ? parseVoucherIdentities(output, String(substitutions?.get('targetCompany') || '')).map(row => row.join('\t')).join('\r\n')
                : tableConfig.order_details
                ? parseOrderVouchers(output, tableConfig, String(substitutions?.get('targetCompany') || '')).map(row => row.values.map(value => value.replace(/[\t\r\n]/g, ' ')).join('\t')).join('\r\n')
                : processTdlOutputManipulation(output);
            const rows = countRows(transformed);
            transformTimer.end(true, undefined, { rows });

            const writeTimer = new PhaseTimer(this.metrics, this.metricBase('file_write', targetTable, tableConfig.collection));
            const columnHeaders = tableConfig.fields.map(p => p.name).join('\t');
            const bytes = await writeDataFile(filePath, columnHeaders, transformed);
            writeTimer.end(true, undefined, { rows, bytes });

            const elapsedMs = timer.end(true, undefined, { rows, bytes });
            return { table: targetTable, filePath, rows, bytes, elapsedMs };
        } catch (err) {
            timer.end(false, err);
            throw err;
        }
    }

    private metricBase(phase: string, table?: string, collection?: string) {
        return {
            phase,
            table,
            collection,
            syncMode: this.context.syncMode,
            dbTechnology: this.context.dbTechnology,
            loadMethod: this.context.loadMethod
        };
    }
}

/**
 * The methods a set of TDL filter expressions reads off each object, e.g. `NOT $IsCancelled` reads
 * `IsCancelled`. `$$Function:...` calls are skipped - the doubled `$` is a function call, not a
 * method on the object being filtered - but their `$Method` arguments still count.
 */
export function methodsReferencedInFilters(filters: string[]): string[] {
    const found = new Set<string>();
    for (const expression of filters) {
        for (const match of expression.matchAll(/(?<!\$)\$([A-Za-z][A-Za-z0-9_]*)/g)) {
            found.add(match[1]);
        }
    }
    return [...found];
}

/**
 * A collection that filters on a method it has not fetched makes Tally load the complete object to
 * read that one method - for a Voucher that means every ledger entry, inventory entry and
 * allocation, per voucher, to evaluate a boolean. Fetching what the filters read keeps the scan on
 * the fetched methods instead. Guid and AlterId are always included: the diff report selects them.
 */
export function diffFetchList(filters?: string[]): string[] {
    return [...new Set(['Guid', 'AlterId', ...methodsReferencedInFilters(filters || [])])];
}

export function withAdditionalFilters(tableConfig: tableConfigYAML, filters: string[]): tableConfigYAML {
    return {
        ...tableConfig,
        fields: tableConfig.fields.map(field => ({ ...field })),
        fetch: tableConfig.fetch ? [...tableConfig.fetch] : undefined,
        filters: [...(tableConfig.filters || []), ...filters],
        subcollections: tableConfig.subcollections ? tableConfig.subcollections.map(sub => withAdditionalFilters(sub, [])) : undefined,
        cascade_update: tableConfig.cascade_update ? tableConfig.cascade_update.map(item => ({ ...item })) : undefined,
        cascade_delete: tableConfig.cascade_delete ? tableConfig.cascade_delete.map(item => ({ ...item })) : undefined
    };
}

export function processTdlOutputManipulation(txt: string): string {
    let retval = txt;
    retval = retval.replace('<ENVELOPE>', '');
    retval = retval.replace('</ENVELOPE>', '');
    retval = retval.replace(/\<FLDBLANK\>\<\/FLDBLANK\>/g, '');
    retval = retval.replace(/\s+\r\n/g, '');
    retval = retval.replace(/\r\n/g, '');
    retval = retval.replace(/\t/g, ' ');
    retval = retval.replace(/\s+\<F/g, '<F');
    retval = retval.replace(/\<\/F\d+\>/g, '');
    retval = retval.replace(/\<F01\>/g, '\r\n');
    retval = retval.replace(/\<F\d+\>/g, '\t');
    retval = retval.replace(/&amp;/g, '&');
    retval = retval.replace(/&lt;/g, '<');
    retval = retval.replace(/&gt;/g, '>');
    retval = retval.replace(/&quot;/g, '"');
    retval = retval.replace(/&apos;/g, "'");
    retval = retval.replace(/&tab;/g, '');
    retval = retval.replace(/&#\d+;/g, "");
    return retval;
}

export function generateXMLfromYAML(tblConfig: tableConfigYAML): string {
    let retval = `<?xml version="1.0" encoding="utf-8"?><ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Data</TYPE><ID>TallyDatabaseLoaderReport</ID></HEADER><BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>XML</SVEXPORTFORMAT><SVFROMDATE>{fromDate}</SVFROMDATE><SVTODATE>{toDate}</SVTODATE><SVCURRENTCOMPANY>{targetCompany}</SVCURRENTCOMPANY></STATICVARIABLES><TDL><TDLMESSAGE><REPORT NAME="TallyDatabaseLoaderReport"><FORMS>MyForm</FORMS></REPORT><FORM NAME="MyForm"><PARTS>MyPart</PARTS></FORM><PART NAME="MyPart"><LINES>MyLine</LINES><REPEAT>MyLine : MyCollection</REPEAT><SCROLLED>Vertical</SCROLLED></PART><LINE NAME="MyLine"><FIELDS>`;
    for (let i = 0; i < tblConfig.fields.length; i++) {
        retval += `Fld${utility.Number.format(i + 1, '00')},`;
    }
    retval += `FldBlank</FIELDS></LINE>`;

    for (let i = 0; i < tblConfig.fields.length; i++) {
        const iField = tblConfig.fields[i];
        let fieldXML = `<FIELD NAME="Fld${utility.Number.format(i + 1, '00')}">`;
        if (/^[a-zA-Z0-9_]+$/g.test(iField.field)) {
            if (iField.type == 'date')
                fieldXML += `<SET>if $$IsEmpty:$${iField.field} then $$StrByCharCode:241 else (($$YearOfDate:$${iField.field})*10000)+(($$MonthOfDate:$${iField.field})*100)+(($$DayOfDate:$${iField.field})*1)</SET>`;
            else if (iField.type == 'text')
                fieldXML += `<SET>$${iField.field}</SET>`;
            else if (iField.type == 'logical')
                fieldXML += `<SET>if $${iField.field} then 1 else 0</SET>`;
            else if (iField.type == 'number')
                fieldXML += `<SET>if $$IsEmpty:$${iField.field} then "0" else $$StringFindAndReplace:($$String:$${iField.field}):"(-)":"-"</SET>`;
            else if (iField.type == 'amount')
                fieldXML += `<SET>$$StringFindAndReplace:(if $$IsDebit:$${iField.field} then -$$NumValue:$${iField.field} else $$NumValue:$${iField.field}):"(-)":"-"</SET>`;
            else if (iField.type == 'quantity')
                fieldXML += `<SET>$$StringFindAndReplace:(if $$IsInwards:$${iField.field} then $$Number:$$String:$${iField.field}:"TailUnits" else -$$Number:$$String:$${iField.field}:"TailUnits"):"(-)":"-"</SET>`;
            else if (iField.type == 'rate')
                fieldXML += `<SET>if $$IsEmpty:$${iField.field} then 0 else $$Number:$${iField.field}</SET>`;
            else
                fieldXML += `<SET>${iField.field}</SET>`;
        }
        else
            fieldXML += `<SET>${iField.field}</SET>`;

        fieldXML += `<XMLTAG>${utility.Number.format(i + 1, 'F00')}</XMLTAG>`;
        fieldXML += `</FIELD>`;
        retval += fieldXML;
    }

    retval += `<FIELD NAME="FldBlank"><SET>""</SET></FIELD>`;
    retval += `<COLLECTION NAME="MyCollection"><TYPE>${tblConfig.collection}</TYPE>`;
    if (tblConfig.fetch && tblConfig.fetch.length)
        retval += `<FETCH>${tblConfig.fetch.join(',')}</FETCH>`;
    if (tblConfig.filters && tblConfig.filters.length) {
        retval += `<FILTER>`;
        for (let j = 0; j < tblConfig.filters.length; j++)
            retval += utility.Number.format(j + 1, 'Fltr00') + ',';
        retval = utility.String.strip(retval);
        retval += `</FILTER>`;
    }
    retval += `</COLLECTION>`;
    if (tblConfig.filters && tblConfig.filters.length)
        for (let j = 0; j < tblConfig.filters.length; j++)
            retval += `<SYSTEM TYPE="Formulae" NAME="${utility.Number.format(j + 1, 'Fltr00')}">${utility.String.escapeHTML(tblConfig.filters[j])}</SYSTEM>`;
    retval += `</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
    return tblConfig.order_details || tblConfig.voucher_identities ? addOrderDetailReport(retval, tblConfig) : retval;
}

export function substituteTDLParameters(msg: string, substitutions: Map<string, any>): string {
    let retval = msg;
    substitutions.forEach((v, k) => {
        const regPtrn = new RegExp(`\\{${k}\\}`);
        if (typeof v === 'string')
            retval = retval.replace(regPtrn, utility.String.escapeHTML(v));
        else if (typeof v === 'number')
            retval = retval.replace(regPtrn, v.toString());
        else if (v instanceof Date)
            retval = retval.replace(regPtrn, utility.Date.format(v, 'd-MMM-yyyy'));
        else if (typeof v === 'boolean')
            retval = retval.replace(regPtrn, v ? 'Yes' : 'No');
    });
    return retval;
}

/**
 * Static variables pin the request to a period and company so it does not inherit whatever the
 * Tally UI happens to have open. Any that were not supplied are removed rather than sent with an
 * unsubstituted placeholder, which restores the previous "let Tally decide" behaviour for that
 * one variable instead of asking Tally to parse "{fromDate}".
 */
export function dropUnresolvedStaticVariables(xml: string): string {
    return xml
        .replace(/<SV[A-Z]+>\{\w+\}<\/SV[A-Z]+>/g, '')
        .replace(/<SVCURRENTCOMPANY>##SVCurrentCompany<\/SVCURRENTCOMPANY>/g, '');
}

function countRows(transformed: string): number {
    if (!transformed.trim()) {
        return 0;
    }
    return transformed.split(/\r\n/g).filter(row => row.length > 0).length;
}

async function writeDataFile(filePath: string, columnHeaders: string, transformed: string): Promise<number> {
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    const writeStream = fs.createWriteStream(filePath, { encoding: 'utf8' });
    let bytes = 0;
    const write = (chunk: string) => new Promise<void>((resolve, reject) => {
        bytes += Buffer.byteLength(chunk);
        const cleanup = () => {
            writeStream.off('drain', onDrain);
            writeStream.off('error', onError);
        };
        const onDrain = () => {
            cleanup();
            resolve();
        };
        const onError = (err: Error) => {
            cleanup();
            reject(err);
        };

        writeStream.once('error', onError);
        if (writeStream.write(chunk)) {
            cleanup();
            resolve();
        } else {
            writeStream.once('drain', onDrain);
        }
    });
    await write(columnHeaders);
    for (const row of transformed.split(/\r\n/g)) {
        if (row.length) {
            await write(`\r\n${row}`);
        }
    }
    await new Promise<void>((resolve, reject) => {
        writeStream.end(resolve);
        writeStream.once('error', reject);
    });
    return bytes;
}
