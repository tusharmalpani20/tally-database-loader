import { appConfig, cloneConfig } from './config.mjs';
import { database } from './database.mjs';
import { assertOrderImportLock, withOrderImportLock } from './order-store.mjs';
import { logger } from './logger.mjs';
import { createSyncStatus, syncStatus, updateSyncStatus, writeSyncStatus } from './status.mjs';
import { tally } from './tally.mjs';
import { godownStockRefreshResult, refreshGodownStockSummary } from './godown-stock-summary.mjs';
import { isSkipEnabled } from './diagnostic-flags.mjs';
import { tallyConfig } from './definition.mjs';
import { buildNoChangeSyncRunPing, recordSyncRunPing } from './sync-run-ping.mjs';
import {
    buildVoucherInventoryIncrementalOptions,
    readLastTransactionAlterId,
    readVoucherInventoryStartAlterId,
    refreshVoucherInventoryLines,
    voucherInventoryImportOptions
} from './voucher-inventory-lines.mjs';

export interface syncRunOptions {
    config: appConfig;
    overrides?: Map<string, string>;
    once?: boolean;
    frequency?: number;
}

export interface changeInspection {
    tallyMasterAlterId: number;
    tallyTransactionAlterId: number;
    databaseMasterAlterId?: number;
    databaseTransactionAlterId?: number;
    masterChanged?: boolean;
    transactionChanged?: boolean;
    missingIncrementalColumns?: string[];
    databaseError?: string;
}

let isSyncRunning = false;
let lastMasterAlterId = 0;
let lastTransactionAlterId = 0;
let activeStatus: syncStatus | undefined;

export function applyRuntimeConfig(config: appConfig, overrides = new Map<string, string>()): appConfig {
    const runtimeConfig = cloneConfig(config);
    database.config = runtimeConfig.database;
    tally.config = runtimeConfig.tally;

    database.updateCommandlineConfig(overrides);
    tally.updateCommandlineConfig(overrides);

    return {
        database: database.config,
        tally: tally.config
    };
}

export function getSyncModeLabel(frequency: number): string {
    return frequency > 0 ? `continuous sync every ${frequency} minute(s)` : 'one-time sync';
}

export async function inspectChangeState(config: appConfig): Promise<changeInspection> {
    logger.setConsoleEnabled(false);
    try {
        applyRuntimeConfig(config);
        await tally.updateLastAlterId();

        const result: changeInspection = {
            tallyMasterAlterId: tally.lastAlterIdMaster,
            tallyTransactionAlterId: tally.lastAlterIdTransaction
        };

        try {
            await database.openConnectionPool();
            const integerType = database.config.technology == 'mysql' ? 'unsigned int' : 'int';
            result.databaseMasterAlterId = await database.executeScalar<number>(`select coalesce(max(cast(value as ${integerType})),0) x from config where name = 'Last AlterID Master'`);
            result.databaseTransactionAlterId = await database.executeScalar<number>(`select coalesce(max(cast(value as ${integerType})),0) x from config where name = 'Last AlterID Transaction'`);
            result.masterChanged = result.tallyMasterAlterId != result.databaseMasterAlterId;
            result.transactionChanged = result.tallyTransactionAlterId != result.databaseTransactionAlterId;
            if (config.tally.sync == 'incremental') {
                const yamlDefinition = await import('js-yaml');
                const fs = await import('fs');
                const rawDefinition = yamlDefinition.load(fs.readFileSync(config.tally.definition, 'utf8')) as any;
                const primaryTables = [
                    ...(rawDefinition?.master || []),
                    ...(rawDefinition?.transaction || [])
                ].filter((table: any) => table?.nature == 'Primary');
                const definitionMissingAlterId = primaryTables
                    .filter((table: any) => !table.fields?.some((field: any) => String(field.name).toLowerCase() == 'alterid'))
                    .map((table: any) => table.name);
                if (definitionMissingAlterId.length) {
                    result.databaseError = `Incremental sync requires tally.definition to use an incremental export definition. Missing "alterid" in definition for: ${definitionMissingAlterId.join(', ')}. Set tally.definition to "tally-export-config-incremental.yaml".`;
                    return result;
                }
                const missingColumns: string[] = [];
                for (const tableName of primaryTables.map((table: any) => table.name)) {
                    const columns = (await database.listDatabaseTableColumns(tableName)).map(p => p.toLowerCase());
                    if (columns.length && !columns.includes('alterid')) {
                        missingColumns.push(tableName);
                    }
                }
                result.missingIncrementalColumns = missingColumns;
            }
        } catch (err: any) {
            result.databaseError = err?.message || String(err);
        } finally {
            await database.closeConnectionPool();
        }

        return result;
    } finally {
        logger.setConsoleEnabled(true);
    }
}

//stands in for a skipped godown snapshot so the run ping still reports a well-formed zero result
function emptyGodownStockRefreshResult(config: tallyConfig): godownStockRefreshResult {
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

async function invokeImport(): Promise<void> {
    return withOrderImportLock(database.config, invokeImportUnlocked);
}

async function invokeImportUnlocked(): Promise<void> {
    const runStartedAt = new Date();
    try {
        isSyncRunning = true;
        const voucherInventoryStartAlterId = await readVoucherInventoryStartAlterId();
        if (activeStatus) {
            activeStatus = updateSyncStatus(activeStatus, {
                state: 'importing',
                lastImportStartedAt: new Date().toISOString(),
                message: 'Import is running.'
            });
        }
        await tally.importData();

        let voucherRows = 0;
        if (isSkipEnabled('skipVoucherInventory')) {
            logger.logMessage('Skipping voucher inventory refresh: TALLY_SKIP_VOUCHER_INVENTORY is set');
        }
        else {
            const voucherInventoryEndAlterId = await readLastTransactionAlterId();
            voucherRows = await refreshVoucherInventoryLines(
                tally.config,
                buildVoucherInventoryIncrementalOptions(voucherInventoryStartAlterId, voucherInventoryEndAlterId)
            );
        }

        const stock = isSkipEnabled('skipGodownStock')
            ? emptyGodownStockRefreshResult(tally.config)
            : await refreshGodownStockSummary(tally.config);
        if (isSkipEnabled('skipGodownStock')) {
            logger.logMessage('Skipping godown stock summary refresh: TALLY_SKIP_GODOWN_STOCK is set');
        }

        const customRows = stock.rowCount + voucherRows;
        assertOrderImportLock();
        await recordSyncRunPing({
            operation: 'sync',
            status: 'success',
            startedAt: runStartedAt,
            finishedAt: new Date(),
            rowsImported: customRows,
            message: `Import completed successfully. stock_godown_summary=${stock.rowCount}, positive=${stock.positiveRows}, negative=${stock.negativeRows}, zero=${stock.zeroRows}, rejected=${stock.rejectedRows}, as_on_date=${stock.asOnDate}, snapshot_id=${stock.snapshotId}, trn_inventory=${voucherRows}.`
        });
        logger.logMessage('Import completed successfully [%s]', new Date().toLocaleString());
        if (activeStatus) {
            activeStatus = updateSyncStatus(activeStatus, {
                state: 'idle',
                lastImportFinishedAt: new Date().toISOString(),
                message: 'Import completed successfully.'
            });
        }
    }
    catch (err) {
        await recordSyncRunPing({
            operation: 'sync',
            status: 'failure',
            startedAt: runStartedAt,
            finishedAt: new Date(),
            message: 'Import failed.',
            errorMessage: err instanceof Error ? err.message : String(err)
        });
        logger.logMessage('Error in importing data\r\nPlease check error-log.txt file for detailed errors [%s]', new Date().toLocaleString());
        if (activeStatus) {
            activeStatus = updateSyncStatus(activeStatus, {
                state: 'error',
                lastErrorAt: new Date().toISOString(),
                message: err instanceof Error ? err.message : String(err)
            });
        }
        throw err;
    }
    finally {
        isSyncRunning = false;
    }
}

export async function runSync(options: syncRunOptions): Promise<void> {
    logger.startRun();
    const runtimeConfig = applyRuntimeConfig(options.config, options.overrides);

    if (options.once && options.frequency !== undefined) {
        throw new Error('Use either --once or --frequency, not both.');
    }
    if (options.once) {
        tally.config.frequency = 0;
    }
    if (options.frequency !== undefined) {
        if (!Number.isInteger(options.frequency) || options.frequency < 0) {
            throw new Error('--frequency must be a non-negative integer.');
        }
        tally.config.frequency = options.frequency;
    }

    runtimeConfig.tally.frequency = tally.config.frequency;
    activeStatus = createSyncStatus(tally.config.frequency);
    writeSyncStatus(activeStatus);

    const heartbeat = setInterval(() => {
        if (activeStatus) {
            activeStatus = updateSyncStatus(activeStatus, {
                message: activeStatus.message
            });
        }
    }, 15000);

    const markStopped = () => {
        if (activeStatus) {
            activeStatus = updateSyncStatus(activeStatus, {
                state: 'stopped',
                message: 'Sync process stopped.'
            });
        }
    };

    process.once('SIGINT', () => {
        markStopped();
        process.exit(0);
    });
    process.once('SIGTERM', () => {
        markStopped();
        process.exit(0);
    });

    if (tally.config.frequency <= 0) {
        try {
            await invokeImport();
        } finally {
            clearInterval(heartbeat);
            markStopped();
            logger.closeStreams();
        }
        return;
    }

    let isCheckingForChanges = false;
    const triggerImport = async () => {
        if (isCheckingForChanges) {
            return;
        }
        isCheckingForChanges = true;
        try {
            if (!isSyncRunning) {
                if (activeStatus) {
                    activeStatus = updateSyncStatus(activeStatus, {
                        state: 'checking',
                        lastCheckAt: new Date().toISOString(),
                        message: 'Checking Tally for changes.'
                    });
                }
                await tally.updateLastAlterId();

                const isDataChanged = !(lastMasterAlterId == tally.lastAlterIdMaster && lastTransactionAlterId == tally.lastAlterIdTransaction);
                if (isDataChanged) {
                    const master = tally.lastAlterIdMaster;
                    const transaction = tally.lastAlterIdTransaction;
                    await invokeImport();
                    lastMasterAlterId = master;
                    lastTransactionAlterId = transaction;
                }
                else {
                    const checkedAt = new Date();
                    logger.logMessage('No change in Tally data found [%s]', new Date().toLocaleString());
                    await recordSyncRunPing(buildNoChangeSyncRunPing(checkedAt, new Date()));
                    if (activeStatus) {
                        activeStatus = updateSyncStatus(activeStatus, {
                            state: 'idle',
                            message: 'No change in Tally data found.'
                        });
                    }
                }
            }
        } catch (err) {
            if (typeof err == 'string' && err.endsWith('is closed in Tally')) {
                logger.logMessage(err + ' [%s]', new Date().toLocaleString());
                if (activeStatus) {
                    activeStatus = updateSyncStatus(activeStatus, {
                        state: 'idle',
                        message: err
                    });
                }
            }
            else {
                logger.logMessage('Background sync check failed: %s [%s]', err instanceof Error ? err.message : String(err), new Date().toLocaleString());
                if (activeStatus) {
                    activeStatus = updateSyncStatus(activeStatus, {
                        state: 'error',
                        lastErrorAt: new Date().toISOString(),
                        message: err instanceof Error ? err.message : String(err)
                    });
                }
            }
        } finally {
            isCheckingForChanges = false;
        }
    };

    if (!tally.config.company) {
        logger.logMessage('Continuous sync requires Tally company name to be specified in config.json');
        if (activeStatus) {
            activeStatus = updateSyncStatus(activeStatus, {
                state: 'error',
                message: 'Continuous sync requires Tally company name to be specified in config.json.'
            });
        }
    }
    else {
        setInterval(async () => await triggerImport(), tally.config.frequency * 60000);
        await triggerImport();
    }
}

export async function runStockGodownImport(config: appConfig, overrides = new Map<string, string>()): Promise<number> {
    const startedAt = new Date();
    applyRuntimeConfig(config, overrides);

    try {
        const result = await refreshGodownStockSummary(tally.config);
        await recordSyncRunPing({
            operation: 'stock_godown_summary_custom_tdl',
            status: 'success',
            startedAt,
            finishedAt: new Date(),
            rowsImported: result.rowCount,
            message: `Imported stock_godown_summary from DB Godown Stock Snapshot custom TDL. positive=${result.positiveRows}, negative=${result.negativeRows}, zero=${result.zeroRows}, rejected=${result.rejectedRows}, as_on_date=${result.asOnDate}, snapshot_id=${result.snapshotId}.`
        });
        return result.rowCount;
    } catch (err) {
        await recordSyncRunPing({
            operation: 'stock_godown_summary_custom_tdl',
            status: 'failure',
            startedAt,
            finishedAt: new Date(),
            message: 'Custom TDL stock import failed.',
            errorMessage: err instanceof Error ? err.message : String(err)
        });
        throw err;
    }
}

export async function runVoucherInventoryImport(config: appConfig, options: voucherInventoryImportOptions = {}, overrides = new Map<string, string>()): Promise<number> {
    const startedAt = new Date();
    applyRuntimeConfig(config, overrides);

    try {
        const rows = await refreshVoucherInventoryLines(tally.config, options);
        await recordSyncRunPing({
            operation: 'voucher_inventory_custom_tdl',
            status: 'success',
            startedAt,
            finishedAt: new Date(),
            rowsImported: rows,
            message: 'Imported trn_inventory from DB Voucher Inventory Lines custom TDL.'
        });
        return rows;
    } catch (err) {
        await recordSyncRunPing({
            operation: 'voucher_inventory_custom_tdl',
            status: 'failure',
            startedAt,
            finishedAt: new Date(),
            message: 'Custom TDL voucher inventory import failed.',
            errorMessage: err instanceof Error ? err.message : String(err)
        });
        throw err;
    }
}

export async function testDatabaseConnection(config: appConfig): Promise<void> {
    logger.setConsoleEnabled(false);
    try {
        applyRuntimeConfig(config);
        await database.openConnectionPool();
        await database.closeConnectionPool();
    } finally {
        logger.setConsoleEnabled(true);
    }
}

export async function listTallyCompanies(config: appConfig) {
    logger.setConsoleEnabled(false);
    try {
        applyRuntimeConfig(config);
        return await tally.listCompanies();
    } finally {
        logger.setConsoleEnabled(true);
    }
}

export async function testTallyConnection(config: appConfig): Promise<void> {
    logger.setConsoleEnabled(false);
    try {
        applyRuntimeConfig(config);
        await tally.testConnection();
    } finally {
        logger.setConsoleEnabled(true);
    }
}
