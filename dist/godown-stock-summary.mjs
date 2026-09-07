import { randomUUID } from 'node:crypto';
import { database } from './database.mjs';
import { logger } from './logger.mjs';
import { HttpTallyTransport } from './tally-transport.mjs';
import { assertOrderImportLock } from './order-store.mjs';
export function populateGodownGuids(rows, godowns) {
    const guidByName = new Map();
    const ambiguousNames = new Set();
    for (const godown of godowns) {
        const name = godown.name?.trim();
        const guid = godown.guid?.trim();
        if (!name || !guid) {
            continue;
        }
        const existingGuid = guidByName.get(name);
        if (existingGuid && existingGuid !== guid) {
            ambiguousNames.add(name);
            continue;
        }
        guidByName.set(name, guid);
    }
    const rejections = [];
    const populatedRows = rows.map((row, index) => {
        const godownName = row.godown.trim();
        if (ambiguousNames.has(godownName)) {
            rejections.push(`row ${index + 1}: multiple PostgreSQL GUIDs for godown=${JSON.stringify(godownName)}`);
            return row;
        }
        const godownGuid = guidByName.get(godownName);
        if (!godownGuid) {
            rejections.push(`row ${index + 1}: no PostgreSQL GUID for godown=${JSON.stringify(godownName)}`);
            return row;
        }
        return { ...row, godownGuid };
    });
    if (rejections.length) {
        throw new GodownStockSnapshotValidationError(rejections);
    }
    return populatedRows;
}
export class GodownStockSnapshotValidationError extends Error {
    rejections;
    constructor(rejections) {
        const examples = rejections.slice(0, 5).join('; ');
        super(`Rejected ${rejections.length} godown stock row(s). ${examples}`);
        this.name = 'GodownStockSnapshotValidationError';
        this.rejections = rejections;
    }
}
function escapeXml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}
function decodeXml(value) {
    return String(value ?? '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'");
}
function textBetween(block, tag) {
    const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i').exec(block);
    return match ? decodeXml(match[1].trim()) : '';
}
function hasXmlTag(block, tag) {
    return new RegExp(`<${tag}(?:\\s[^>]*)?\\s*/>|<${tag}(?:\\s[^>]*)?>[\\s\\S]*?</${tag}>`, 'i').test(block);
}
function parseSignedQuantity(value) {
    let normalized = String(value || '').replace(/,/g, '').trim();
    if (!normalized) {
        return { qty: null, uom: '' };
    }
    let negative = false;
    if (normalized.includes('(-)')) {
        negative = true;
        normalized = normalized.replace(/\(-\)/g, '').trim();
    }
    if (/^-\s*/.test(normalized)) {
        negative = true;
        normalized = normalized.replace(/^-\s*/, '');
    }
    if (/-\s*$/.test(normalized)) {
        negative = true;
        normalized = normalized.replace(/-\s*$/, '').trim();
    }
    normalized = normalized.replace(/^\+\s*/, '');
    const bracketed = /^\(\s*(\d+(?:\.\d+)?)\s*\)\s*(.*)$/.exec(normalized);
    if (bracketed) {
        negative = true;
        normalized = `${bracketed[1]} ${bracketed[2]}`.trim();
    }
    const match = /^(\d+(?:\.\d+)?)\s*(.*)$/.exec(normalized);
    if (!match) {
        return { qty: null, uom: '' };
    }
    const qty = negative && Number(match[1]) !== 0 ? `-${match[1]}` : match[1];
    return { qty, uom: match[2].trim() };
}
function parseNumeric(value) {
    const parsed = parseSignedQuantity(value);
    return parsed.qty && !parsed.uom ? parsed.qty : null;
}
function parseTallyDate(value) {
    // Number Field values exported by Tally can contain display separators.
    // Accept those without weakening the calendar/date-range validation below.
    const normalized = String(value || '').replace(/,/g, '').replace(/\s+/g, '').trim();
    const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(normalized);
    const iso = compact ? `${compact[1]}-${compact[2]}-${compact[3]}` : normalized;
    const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
    if (!parts) {
        return null;
    }
    const year = Number(parts[1]);
    const month = Number(parts[2]);
    const day = Number(parts[3]);
    const parsed = new Date(Date.UTC(year, month - 1, day));
    if (year < 1901
        || year > 2098
        || parsed.getUTCFullYear() !== year
        || parsed.getUTCMonth() !== month - 1
        || parsed.getUTCDate() !== day) {
        return null;
    }
    return iso;
}
function compactDate(value) {
    const normalized = String(value || '').trim();
    const parsed = parseTallyDate(normalized);
    return parsed ? parsed.replace(/-/g, '') : null;
}
function localCompactDate(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}${month}${day}`;
}
function resolveRequestPeriod(config, today = new Date()) {
    const toDate = compactDate(config.todate) || localCompactDate(today);
    const toYear = Number(toDate.slice(0, 4));
    const toMonth = Number(toDate.slice(4, 6));
    const financialYearStart = `${toMonth >= 4 ? toYear : toYear - 1}0401`;
    return {
        fromDate: compactDate(config.fromdate) || financialYearStart,
        toDate
    };
}
function ident(value) {
    return `"${String(value).replace(/"/g, '""')}"`;
}
export function buildStockSummaryRequest(config) {
    const companyXml = config.company
        ? `<SVCURRENTCOMPANY>${escapeXml(config.company)}</SVCURRENTCOMPANY>`
        : '';
    return `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Data</TYPE>
    <ID>Stock Summary</ID>
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES>
        <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
        <EXPLODEFLAG>Yes</EXPLODEFLAG>
        <ISITEMWISE>Yes</ISITEMWISE>
        ${companyXml}
      </STATICVARIABLES>
    </DESC>
  </BODY>
</ENVELOPE>`;
}
export function buildGodownSummaryRequest(config) {
    const companyXml = config.company
        ? `<SVCURRENTCOMPANY>${escapeXml(config.company)}</SVCURRENTCOMPANY>`
        : '';
    return `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Data</TYPE>
    <ID>Godown Summary</ID>
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES>
        <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
        <EXPLODEFLAG>Yes</EXPLODEFLAG>
        ${companyXml}
      </STATICVARIABLES>
    </DESC>
  </BODY>
</ENVELOPE>`;
}
export function buildGodownStockSnapshotRequest(config, today = new Date()) {
    const companyXml = config.company
        ? `<SVCURRENTCOMPANY>${escapeXml(config.company)}</SVCURRENTCOMPANY>`
        : '';
    const period = resolveRequestPeriod(config, today);
    return `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Data</TYPE>
    <ID>DB Godown Stock Snapshot</ID>
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES>
        <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
        <EXPLODEFLAG>Yes</EXPLODEFLAG>
        <SVFROMDATE>${period.fromDate}</SVFROMDATE>
        <SVTODATE>${period.toDate}</SVTODATE>
        ${companyXml}
      </STATICVARIABLES>
    </DESC>
  </BODY>
</ENVELOPE>`;
}
function readStockInfoRow(item, godown, stockInfo) {
    const { qty, uom } = parseSignedQuantity(textBetween(stockInfo, 'DSPCLQTY'));
    return {
        item,
        godown,
        closingQty: qty,
        uom,
        closingRate: parseNumeric(textBetween(stockInfo, 'DSPCLRATE')),
        closingValue: parseNumeric(textBetween(stockInfo, 'DSPCLAMTA'))
    };
}
export function parseStockSummaryRows(xml) {
    const tokens = [...xml.matchAll(/<DSPACCNAME>[\s\S]*?<\/DSPACCNAME>|<SSBATCHNAME>[\s\S]*?<\/SSBATCHNAME>|<DSPSTKINFO>[\s\S]*?<\/DSPSTKINFO>/gi)]
        .map(match => match[0]);
    const rows = [];
    let currentItem = '';
    let pendingGodown = '';
    for (const token of tokens) {
        if (/^<DSPACCNAME>/i.test(token)) {
            currentItem = textBetween(token, 'DSPDISPNAME');
            pendingGodown = '';
            continue;
        }
        if (/^<SSBATCHNAME>/i.test(token)) {
            pendingGodown = textBetween(token, 'SSGODOWN');
            for (const stockInfo of token.matchAll(/<DSPSTKINFO>[\s\S]*?<\/DSPSTKINFO>/gi)) {
                if (currentItem && pendingGodown) {
                    rows.push(readStockInfoRow(currentItem, pendingGodown, stockInfo[0]));
                }
            }
            if (/<DSPSTKINFO>/i.test(token)) {
                pendingGodown = '';
            }
            continue;
        }
        if (!/^<DSPSTKINFO>/i.test(token) || !currentItem || !pendingGodown) {
            continue;
        }
        rows.push(readStockInfoRow(currentItem, pendingGodown, token));
        pendingGodown = '';
    }
    return rows;
}
export function parseGodownSummaryRows(xml, godownNames) {
    const knownGodowns = new Set(godownNames.map(name => name.trim()).filter(Boolean));
    const blocks = [...xml.matchAll(/<DSPACCNAME>[\s\S]*?<\/DSPSTKINFO>/gi)]
        .map(match => match[0]);
    const rows = [];
    let currentGodown = '';
    for (const block of blocks) {
        const name = textBetween(block, 'DSPDISPNAME');
        if (knownGodowns.has(name)) {
            currentGodown = name;
            continue;
        }
        if (!currentGodown || !name) {
            continue;
        }
        rows.push(readStockInfoRow(name, currentGodown, block));
    }
    return rows;
}
export function parseGodownStockSnapshot(xml) {
    const blocks = [...xml.matchAll(/<rowType>[\s\S]*?(?=<rowType>|<\/ENVELOPE>)/gi)]
        .map(match => match[0])
        .filter(block => textBetween(block, 'rowType').toUpperCase() == 'GODOWN');
    const rows = [];
    const rejections = [];
    const sourceCompany = textBetween(xml, 'sourceCompany');
    const asOnDate = parseTallyDate(textBetween(xml, 'asOnDate')) || '';
    if (!/<ENVELOPE(?:\s[^>]*)?>[\s\S]*<\/ENVELOPE>\s*$/i.test(xml.trim())) {
        rejections.push('snapshot: incomplete or invalid XML envelope');
    }
    const tallyError = textBetween(xml, 'LINEERROR');
    if (tallyError) {
        rejections.push(`snapshot: Tally error ${JSON.stringify(tallyError)}`);
    }
    if (!sourceCompany) {
        rejections.push('snapshot: missing sourceCompany');
    }
    if (!asOnDate) {
        rejections.push('snapshot: missing or invalid asOnDate');
    }
    if (!blocks.length) {
        rejections.push('snapshot: no GODOWN rows returned');
    }
    for (const [index, block] of blocks.entries()) {
        const item = textBetween(block, 'stockItem');
        const itemGuid = textBetween(block, 'itemGuid');
        const godown = textBetween(block, 'godown');
        const godownGuid = textBetween(block, 'godownGuid');
        const rowSourceCompany = textBetween(block, 'sourceCompany');
        const rowAsOnDate = parseTallyDate(textBetween(block, 'asOnDate')) || '';
        const rawQuantity = textBetween(block, 'closingQty');
        // Tally exports a present but empty quantity field for explicit zero allocations.
        const { qty, uom } = !rawQuantity && hasXmlTag(block, 'closingQty')
            ? { qty: '0', uom: '' }
            : parseSignedQuantity(rawQuantity);
        const missing = [
            !item && 'stockItem',
            !itemGuid && 'itemGuid',
            !godown && 'godown',
            !rowSourceCompany && 'sourceCompany',
            !rowAsOnDate && 'asOnDate'
        ].filter(Boolean);
        if (missing.length
            || qty === null
            || rowSourceCompany !== sourceCompany
            || rowAsOnDate !== asOnDate) {
            const reason = missing.length
                ? `missing ${missing.join(', ')}`
                : qty === null
                    ? `invalid closingQty=${JSON.stringify(rawQuantity)}`
                    : 'row metadata does not match snapshot metadata';
            rejections.push(`row ${index + 1}: ${reason}`);
            continue;
        }
        rows.push({
            rowType: 'GODOWN',
            stockGroup: textBetween(block, 'stockGroup'),
            item,
            itemGuid,
            batchName: textBetween(block, 'batchName'),
            godown,
            godownGuid,
            closingQty: qty,
            uom: textBetween(block, 'uom') || uom,
            closingRate: parseNumeric(textBetween(block, 'closingRate')),
            closingValue: parseNumeric(textBetween(block, 'closingValue')),
            asOnDate,
            sourceCompany
        });
    }
    if (rejections.length) {
        throw new GodownStockSnapshotValidationError(rejections);
    }
    const quantities = rows.map(row => Number(row.closingQty));
    return {
        rows,
        sourceCompany,
        asOnDate,
        metrics: {
            rawRows: blocks.length,
            acceptedRows: rows.length,
            positiveRows: quantities.filter(quantity => quantity > 0).length,
            negativeRows: quantities.filter(quantity => quantity < 0).length,
            zeroRows: quantities.filter(quantity => quantity == 0).length,
            rejectedRows: 0
        }
    };
}
function validateSnapshotForReplacement(rows, sourceCompany, asOnDate, metrics) {
    const rejections = [];
    if (!sourceCompany.trim()) {
        rejections.push('snapshot: missing sourceCompany');
    }
    if (!asOnDate || parseTallyDate(asOnDate) !== asOnDate) {
        rejections.push('snapshot: missing or invalid asOnDate');
    }
    if (!rows.length) {
        rejections.push('snapshot: no GODOWN rows supplied for replacement');
    }
    for (const fieldname of [
        'rawRows',
        'acceptedRows',
        'positiveRows',
        'negativeRows',
        'zeroRows',
        'rejectedRows'
    ]) {
        if (!Number.isInteger(metrics[fieldname]) || metrics[fieldname] < 0) {
            rejections.push(`snapshot: ${fieldname} must be a non-negative integer`);
        }
    }
    if (metrics.rejectedRows !== 0) {
        rejections.push('snapshot: rejectedRows must be zero before replacement');
    }
    if (metrics.acceptedRows !== rows.length) {
        rejections.push('snapshot: acceptedRows does not match replacement row count');
    }
    if (metrics.rawRows !== metrics.acceptedRows + metrics.rejectedRows) {
        rejections.push('snapshot: rawRows does not match acceptedRows + rejectedRows');
    }
    const quantities = [];
    for (const [index, row] of rows.entries()) {
        const rawQuantity = row.closingQty;
        const quantity = Number(rawQuantity);
        const missing = [
            !row.item?.trim() && 'stockItem',
            !row.itemGuid?.trim() && 'itemGuid',
            !row.godown?.trim() && 'godown',
            !row.godownGuid?.trim() && 'godownGuid'
        ].filter(Boolean);
        if (missing.length) {
            rejections.push(`row ${index + 1}: missing ${missing.join(', ')}`);
        }
        if (row.rowType !== 'GODOWN') {
            rejections.push(`row ${index + 1}: invalid rowType=${JSON.stringify(row.rowType)}`);
        }
        if (rawQuantity === null || !String(rawQuantity).trim() || !Number.isFinite(quantity)) {
            rejections.push(`row ${index + 1}: invalid closingQty=${JSON.stringify(rawQuantity)}`);
        }
        else {
            quantities.push(quantity);
        }
        if (!row.sourceCompany?.trim() || row.sourceCompany !== sourceCompany || row.asOnDate !== asOnDate) {
            rejections.push(`row ${index + 1}: metadata does not match replacement snapshot`);
        }
    }
    const signMetrics = {
        positiveRows: quantities.filter(quantity => quantity > 0).length,
        negativeRows: quantities.filter(quantity => quantity < 0).length,
        zeroRows: quantities.filter(quantity => quantity === 0).length
    };
    for (const fieldname of ['positiveRows', 'negativeRows', 'zeroRows']) {
        if (metrics[fieldname] !== signMetrics[fieldname]) {
            rejections.push(`snapshot: ${fieldname} does not match replacement rows`);
        }
    }
    if (rejections.length) {
        throw new GodownStockSnapshotValidationError(rejections);
    }
}
export function parseGodownStockSnapshotRows(xml) {
    return parseGodownStockSnapshot(xml).rows;
}
export async function acquireGodownStockRefreshLock(client) {
    const result = await client.query(`select pg_try_advisory_lock(
            hashtext(current_database()),
            hashtext('tally-database-loader:stock-godown-summary')
        ) as acquired`);
    if (!Boolean(result.rows[0]?.acquired)) {
        throw new Error('Godown stock refresh is already running in another process.');
    }
}
export async function releaseGodownStockRefreshLock(client) {
    await client.query(`select pg_advisory_unlock(
            hashtext(current_database()),
            hashtext('tally-database-loader:stock-godown-summary')
        )`);
}
async function populateGodownGuidsFromPostgres(client, rows) {
    const result = await client.query(`
        select name, guid
        from public.mst_godown
        where coalesce(btrim(name), '') <> ''
          and coalesce(btrim(guid), '') <> ''
    `);
    return populateGodownGuids(rows, result.rows);
}
const STOCK_SUMMARY_COLUMNS = [
    'item', 'item_guid', 'godown', 'godown_guid', 'closing_qty', 'uom',
    'closing_rate', 'closing_value', 'stock_group', 'batch_name', 'row_type',
    'as_on_date', 'source_company', 'source_snapshot_id', 'imported_at'
];
const STOCK_STATE_COLUMNS = [
    'singleton', 'snapshot_id', 'source_company', 'as_on_date', 'refreshed_at',
    'raw_rows', 'accepted_rows', 'positive_rows', 'negative_rows', 'zero_rows',
    'rejected_rows', 'snapshot_complete'
];
export async function ensureGodownStockSnapshotSchema(client) {
    const readiness = await client.query(`select
            to_regclass('public.stock_godown_summary') is not null
            and to_regclass('public.stock_godown_summary_state') is not null
            and (
                select count(*) from information_schema.columns
                where table_schema = 'public'
                  and table_name = 'stock_godown_summary'
                  and column_name = any($1::text[])
            ) = $2
            and (
                select count(*) from information_schema.columns
                where table_schema = 'public'
                  and table_name = 'stock_godown_summary_state'
                  and column_name = any($3::text[])
            ) = $4 as ready`, [STOCK_SUMMARY_COLUMNS, STOCK_SUMMARY_COLUMNS.length, STOCK_STATE_COLUMNS, STOCK_STATE_COLUMNS.length]);
    if (Boolean(readiness.rows[0]?.ready)) {
        return;
    }
    await client.query('begin');
    try {
        await client.query(`select pg_advisory_xact_lock(
                hashtext(current_database()),
                hashtext('tally-database-loader:stock-godown-summary')
            )`);
        await client.query(`create table if not exists public.stock_godown_summary_state (
            singleton boolean primary key default true check (singleton),
            snapshot_id text not null,
            source_company text not null,
            as_on_date date not null,
            refreshed_at timestamptz not null,
            raw_rows integer not null,
            accepted_rows integer not null,
            positive_rows integer not null,
            negative_rows integer not null,
            zero_rows integer not null,
            rejected_rows integer not null,
            snapshot_complete boolean not null
        )`);
        await client.query('lock table public.stock_godown_summary_state in access exclusive mode');
        await client.query(`create table if not exists public.stock_godown_summary (
            item text not null,
            item_guid text not null,
            godown text not null,
            godown_guid text not null,
            closing_qty numeric not null,
            uom text null,
            closing_rate numeric null,
            closing_value numeric null,
            stock_group text null,
            batch_name text null,
            row_type text not null default 'GODOWN',
            as_on_date date not null,
            source_company text not null,
            source_snapshot_id text not null,
            imported_at timestamptz not null default now()
        )`);
        await client.query('alter table public.stock_godown_summary add column if not exists item_guid text null');
        await client.query('alter table public.stock_godown_summary add column if not exists godown_guid text null');
        await client.query('alter table public.stock_godown_summary add column if not exists stock_group text null');
        await client.query('alter table public.stock_godown_summary add column if not exists batch_name text null');
        await client.query("alter table public.stock_godown_summary add column if not exists row_type text not null default 'GODOWN'");
        await client.query('alter table public.stock_godown_summary add column if not exists as_on_date date null');
        await client.query('alter table public.stock_godown_summary add column if not exists source_company text null');
        await client.query('alter table public.stock_godown_summary add column if not exists source_snapshot_id text null');
        assertOrderImportLock();
        await client.query('commit');
    }
    catch (err) {
        await client.query('rollback');
        throw err;
    }
}
export async function publishGodownStockSnapshot(client, rows, publication) {
    const qualifiedTable = `${ident('public')}.${ident('stock_godown_summary')}`;
    const stateTable = `${ident('public')}.${ident('stock_godown_summary_state')}`;
    await client.query('begin');
    try {
        await client.query(`select pg_advisory_xact_lock(
                hashtext(current_database()),
                hashtext('tally-database-loader:stock-godown-summary')
            )`);
        await client.query(`delete from ${qualifiedTable}`);
        const batchSize = 500;
        for (let index = 0; index < rows.length; index += batchSize) {
            const batch = rows.slice(index, index + batchSize);
            const params = [];
            const values = batch.map((row, rowIndex) => {
                const offset = rowIndex * 14;
                params.push(row.item, row.itemGuid, row.godown, row.godownGuid, row.closingQty, row.uom, row.closingRate, row.closingValue, row.stockGroup, row.batchName, row.rowType, row.asOnDate, row.sourceCompany, publication.snapshotId);
                return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9}, $${offset + 10}, $${offset + 11}, $${offset + 12}, $${offset + 13}, $${offset + 14})`;
            }).join(',');
            await client.query(`insert into ${qualifiedTable} (item, item_guid, godown, godown_guid, closing_qty, uom, closing_rate, closing_value, stock_group, batch_name, row_type, as_on_date, source_company, source_snapshot_id) values ${values}`, params);
        }
        await client.query(`insert into ${stateTable} (
                singleton, snapshot_id, source_company, as_on_date, refreshed_at,
                raw_rows, accepted_rows, positive_rows, negative_rows, zero_rows,
                rejected_rows, snapshot_complete
            ) values (true, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, true)
            on conflict (singleton) do update set
                snapshot_id = excluded.snapshot_id,
                source_company = excluded.source_company,
                as_on_date = excluded.as_on_date,
                refreshed_at = excluded.refreshed_at,
                raw_rows = excluded.raw_rows,
                accepted_rows = excluded.accepted_rows,
                positive_rows = excluded.positive_rows,
                negative_rows = excluded.negative_rows,
                zero_rows = excluded.zero_rows,
                rejected_rows = excluded.rejected_rows,
                snapshot_complete = excluded.snapshot_complete`, [
            publication.snapshotId,
            publication.sourceCompany,
            publication.asOnDate,
            publication.refreshedAt,
            publication.metrics.rawRows,
            publication.metrics.acceptedRows,
            publication.metrics.positiveRows,
            publication.metrics.negativeRows,
            publication.metrics.zeroRows,
            publication.metrics.rejectedRows
        ]);
        assertOrderImportLock();
        await client.query('commit');
    }
    catch (err) {
        await client.query('rollback');
        throw err;
    }
}
export async function replaceGodownStockSummaryRows(rows, options = {}) {
    const snapshotId = options.snapshotId?.trim() || randomUUID();
    const sourceCompany = options.sourceCompany || rows[0]?.sourceCompany || '';
    const asOnDate = options.asOnDate || rows[0]?.asOnDate || null;
    const refreshedAt = options.refreshedAt || new Date();
    const metrics = options.metrics || {
        rawRows: rows.length,
        acceptedRows: rows.length,
        positiveRows: rows.filter(row => Number(row.closingQty) > 0).length,
        negativeRows: rows.filter(row => Number(row.closingQty) < 0).length,
        zeroRows: rows.filter(row => Number(row.closingQty) == 0).length,
        rejectedRows: 0
    };
    validateSnapshotForReplacement(rows, sourceCompany, asOnDate, metrics);
    await database.openConnectionPool();
    let client;
    try {
        client = await database.connectionPoolPostgres.connect();
        await ensureGodownStockSnapshotSchema(client);
        await publishGodownStockSnapshot(client, rows, {
            snapshotId,
            sourceCompany,
            asOnDate: asOnDate,
            refreshedAt,
            metrics
        });
        return rows.length;
    }
    finally {
        client?.release();
        await database.closeConnectionPool();
    }
}
export async function refreshGodownStockSummary(config) {
    if (database.config.technology != 'postgres') {
        logger.logMessage('Skipping godown stock summary refresh for %s database', database.config.technology);
        return {
            rowCount: 0,
            snapshotId: '',
            sourceCompany: config.company,
            asOnDate: '',
            rawRows: 0,
            acceptedRows: 0,
            positiveRows: 0,
            negativeRows: 0,
            zeroRows: 0,
            rejectedRows: 0
        };
    }
    logger.logMessage('Refreshing godown stock summary [%s]', new Date().toLocaleString());
    await database.openConnectionPool();
    let client;
    let lockAcquired = false;
    try {
        client = await database.connectionPoolPostgres.connect();
        await acquireGodownStockRefreshLock(client);
        lockAcquired = true;
        const transport = new HttpTallyTransport(config);
        const xml = await transport.post(buildGodownStockSnapshotRequest(config));
        const parsed = parseGodownStockSnapshot(xml);
        const rows = await populateGodownGuidsFromPostgres(client, parsed.rows);
        const snapshotId = randomUUID();
        validateSnapshotForReplacement(rows, parsed.sourceCompany, parsed.asOnDate, parsed.metrics);
        await ensureGodownStockSnapshotSchema(client);
        await publishGodownStockSnapshot(client, rows, {
            snapshotId,
            sourceCompany: parsed.sourceCompany,
            asOnDate: parsed.asOnDate,
            refreshedAt: new Date(),
            metrics: parsed.metrics
        });
        logger.logMessage('  stock_godown_summary: imported %d rows (positive=%d, negative=%d, zero=%d, rejected=%d)', rows.length, parsed.metrics.positiveRows, parsed.metrics.negativeRows, parsed.metrics.zeroRows, parsed.metrics.rejectedRows);
        return {
            rowCount: rows.length,
            snapshotId,
            sourceCompany: parsed.sourceCompany,
            asOnDate: parsed.asOnDate,
            ...parsed.metrics
        };
    }
    finally {
        if (client && lockAcquired) {
            try {
                await releaseGodownStockRefreshLock(client);
            }
            catch (err) {
                logger.logError('releaseGodownStockRefreshLock()', err);
            }
        }
        client?.release();
        await database.closeConnectionPool();
    }
}
//# sourceMappingURL=godown-stock-summary.mjs.map