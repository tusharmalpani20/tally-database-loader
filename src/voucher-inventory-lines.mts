import { database } from './database.mjs';
import { logger } from './logger.mjs';
import { tallyConfig } from './definition.mjs';
import { HttpTallyTransport } from './tally-transport.mjs';
import { assertOrderImportLock } from './order-store.mjs';

export interface voucherInventoryImportOptions {
    fromAlterId?: number;
    toAlterId?: number;
    updateMarker?: boolean;
}

export interface voucherInventoryUpdateMarkerOptions {
    updateMarker?: boolean;
    noUpdateMarker?: boolean;
}

export interface voucherInventoryRow {
    guid: string;
    alterId: number;
    item: string;
    itemGuid: string;
    quantity: string | null;
    rate: string | null;
    amount: string | null;
    additionalAmount: string | null;
    discountAmount: string | null;
    godown: string;
    godownGuid: string;
    trackingNumber: string;
    orderNumber: string;
    orderDueDate: string | null;
}

const markerName = 'Last Voucher Inventory AlterID';

function escapeXml(value: string): string {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

function decodeXml(value: string): string {
    return String(value ?? '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'");
}

function textBetween(block: string, tag: string): string {
    const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i').exec(block);
    return match ? decodeXml(match[1].trim()) : '';
}

function parseNumeric(value: string): string | null {
    if (!value) return null;
    const normalized = String(value).replace(/,/g, '').trim();
    return /^-?\d+(\.\d+)?$/.test(normalized) ? normalized : null;
}

function parseTallyDate(value: string): string | null {
    const normalized = String(value || '').trim();
    const ymd = /^(\d{4})(\d{2})(\d{2})$/.exec(normalized);
    if (ymd) {
        return `${ymd[1]}-${ymd[2]}-${ymd[3]}`;
    }
    return null;
}

function ident(value: string): string {
    return `"${String(value).replace(/"/g, '""')}"`;
}

export function buildVoucherInventoryLinesRequest(config: tallyConfig, options: voucherInventoryImportOptions = {}): string {
    const companyXml = config.company
        ? `<SVCURRENTCOMPANY>${escapeXml(config.company)}</SVCURRENTCOMPANY>`
        : '';
    const fromAlterId = Math.max(0, Math.trunc(options.fromAlterId ?? 0));
    const toAlterId = Math.max(0, Math.trunc(options.toAlterId ?? 0));

    return `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Data</TYPE>
    <ID>DB Voucher Inventory Lines</ID>
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES>
        <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
        ${companyXml}
        <DBVILFROMALTERID>${fromAlterId}</DBVILFROMALTERID>
        <DBVILTOALTERID>${toAlterId}</DBVILTOALTERID>
      </STATICVARIABLES>
    </DESC>
  </BODY>
</ENVELOPE>`;
}

export function parseVoucherInventoryRows(xml: string): voucherInventoryRow[] {
    const blocks = [...xml.matchAll(/<rowType>[\s\S]*?(?=<rowType>|<\/ENVELOPE>)/gi)]
        .map(match => match[0]);
    const rows: voucherInventoryRow[] = [];

    for (const block of blocks) {
        if (textBetween(block, 'rowType') != 'INVENTORY') {
            continue;
        }

        const guid = textBetween(block, 'guid');
        const item = textBetween(block, 'item');
        const alterId = Number(textBetween(block, 'alterid') || 0);
        if (!guid || !item || !Number.isFinite(alterId)) {
            continue;
        }

        rows.push({
            guid,
            alterId,
            item,
            itemGuid: textBetween(block, 'itemGuid'),
            quantity: parseNumeric(textBetween(block, 'quantity')),
            rate: parseNumeric(textBetween(block, 'rate')),
            amount: parseNumeric(textBetween(block, 'amount')),
            additionalAmount: parseNumeric(textBetween(block, 'additionalAmount')),
            discountAmount: parseNumeric(textBetween(block, 'discountAmount')),
            godown: textBetween(block, 'godown'),
            godownGuid: textBetween(block, 'godownGuid'),
            trackingNumber: textBetween(block, 'trackingNumber'),
            orderNumber: textBetween(block, 'orderNumber'),
            orderDueDate: parseTallyDate(textBetween(block, 'orderDueDate'))
        });
    }

    return rows;
}

export function resolveVoucherInventoryMarkerAlterId(rows: Pick<voucherInventoryRow, 'alterId'>[], toAlterId = 0): number | null {
    const boundedToAlterId = Math.max(0, Math.trunc(toAlterId || 0));
    if (boundedToAlterId > 0) {
        return boundedToAlterId;
    }

    const alterIds = rows.map(row => row.alterId).filter(Number.isFinite);
    return alterIds.length ? Math.max(...alterIds) : null;
}

export function resolveVoucherInventoryUpdateMarker(options: voucherInventoryUpdateMarkerOptions): boolean {
    if (options.updateMarker !== undefined) {
        return options.updateMarker;
    }
    return !options.noUpdateMarker;
}

export function buildVoucherInventoryIncrementalOptions(fromAlterId: number, toAlterId: number): voucherInventoryImportOptions {
    const from = Math.max(0, Math.trunc(Number.isFinite(fromAlterId) ? fromAlterId : 0));
    const to = Math.max(from, Math.max(0, Math.trunc(Number.isFinite(toAlterId) ? toAlterId : 0)));
    return { fromAlterId: from, toAlterId: to };
}

async function readConfigAlterId(names: string[]): Promise<number> {
    await database.openConnectionPool();
    const client = await database.connectionPoolPostgres.connect();
    try {
        const result = await client.query<{ value: string }>(
            `select value
            from public.config
            where name = any($1::text[])
            order by array_position($1::text[], name)
            limit 1`,
            [names]
        );
        return Number(result.rows[0]?.value || 0) || 0;
    } finally {
        client.release();
        await database.closeConnectionPool();
    }
}

export async function readVoucherInventoryStartAlterId(): Promise<number> {
    if (database.config.technology != 'postgres') {
        return 0;
    }

    try {
        return await readConfigAlterId([markerName, 'Last AlterID Transaction']);
    } catch (err: any) {
        if (err?.code == '42P01' || String(err?.message || err).includes('does not exist')) {
            return 0;
        }
        throw err;
    }
}

export async function readLastTransactionAlterId(): Promise<number> {
    if (database.config.technology != 'postgres') {
        return 0;
    }

    try {
        return await readConfigAlterId(['Last AlterID Transaction']);
    } catch (err: any) {
        if (err?.code == '42P01' || String(err?.message || err).includes('does not exist')) {
            return 0;
        }
        throw err;
    }
}

export async function replaceVoucherInventoryRows(rows: voucherInventoryRow[], updateMarker = true, markerAlterId: number | null = null): Promise<number> {
    const targetTable = `${ident('public')}.${ident('trn_inventory')}`;
    const nextMarkerAlterId = markerAlterId ?? resolveVoucherInventoryMarkerAlterId(rows);

    await database.openConnectionPool();
    const client = await database.connectionPoolPostgres.connect();
    try {
        await client.query('begin');
        await client.query(`create table if not exists ${targetTable} (
            guid varchar(64),
            item varchar(1024),
            _item varchar(64),
            quantity numeric(15,4),
            rate numeric(15,4),
            amount numeric(17,2),
            additional_amount numeric(17,2),
            discount_amount numeric(17,2),
            godown varchar(1024),
            _godown varchar(64),
            tracking_number varchar(1024),
            order_number varchar(1024),
            order_duedate date
        )`);
        await client.query(`create temp table _trn_inventory_stage (
            guid text,
            item text,
            _item text,
            quantity numeric,
            rate numeric,
            amount numeric,
            additional_amount numeric,
            discount_amount numeric,
            godown text,
            _godown text,
            tracking_number text,
            order_number text,
            order_duedate date,
            alterid integer
        ) on commit drop`);

        const batchSize = 500;
        for (let index = 0; index < rows.length; index += batchSize) {
            const batch = rows.slice(index, index + batchSize);
            const params: (string | number | null)[] = [];
            const values = batch.map((row, rowIndex) => {
                const offset = rowIndex * 14;
                params.push(
                    row.guid,
                    row.item,
                    row.itemGuid,
                    row.quantity,
                    row.rate,
                    row.amount,
                    row.additionalAmount,
                    row.discountAmount,
                    row.godown,
                    row.godownGuid,
                    row.trackingNumber,
                    row.orderNumber,
                    row.orderDueDate,
                    row.alterId
                );
                return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9}, $${offset + 10}, $${offset + 11}, $${offset + 12}, $${offset + 13}, $${offset + 14})`;
            }).join(',');
            await client.query(
                `insert into _trn_inventory_stage (
                    guid, item, _item, quantity, rate, amount, additional_amount, discount_amount,
                    godown, _godown, tracking_number, order_number, order_duedate, alterid
                ) values ${values}`,
                params
            );
        }

        await client.query(`delete from ${targetTable} where guid in (select distinct guid from _trn_inventory_stage)`);
        await client.query(`insert into ${targetTable} (
            guid, item, _item, quantity, rate, amount, additional_amount, discount_amount,
            godown, _godown, tracking_number, order_number, order_duedate
        )
        select guid, item, _item, quantity, rate, amount, additional_amount, discount_amount,
            godown, _godown, tracking_number, order_number, order_duedate
        from _trn_inventory_stage`);

        if (updateMarker && nextMarkerAlterId != null) {
            await client.query(
                `insert into public.config(name, value) values($1, $2)
                on conflict (name) do update set value = excluded.value`,
                [markerName, String(nextMarkerAlterId)]
            );
        }

        assertOrderImportLock();
        await client.query('commit');
        return rows.length;
    } catch (err) {
        await client.query('rollback');
        throw err;
    } finally {
        client.release();
        await database.closeConnectionPool();
    }
}

export async function refreshVoucherInventoryLines(config: tallyConfig, options: voucherInventoryImportOptions = {}): Promise<number> {
    if (database.config.technology != 'postgres') {
        logger.logMessage('Skipping voucher inventory refresh for %s database', database.config.technology);
        return 0;
    }

    const fromAlterId = options.fromAlterId ?? await readVoucherInventoryStartAlterId();
    const requestOptions = { ...options, fromAlterId };
    logger.logMessage('Refreshing voucher inventory lines from AlterID %d [%s]', fromAlterId, new Date().toLocaleString());

    const transport = new HttpTallyTransport(config);
    const xml = await transport.post(buildVoucherInventoryLinesRequest(config, requestOptions));
    const rows = parseVoucherInventoryRows(xml);
    const markerAlterId = resolveVoucherInventoryMarkerAlterId(rows, requestOptions.toAlterId);
    const rowCount = await replaceVoucherInventoryRows(rows, options.updateMarker !== false, markerAlterId);
    logger.logMessage('  trn_inventory: imported %d rows', rowCount);
    return rowCount;
}
