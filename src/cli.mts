#!/usr/bin/env node

import process from 'node:process';
import child_process from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { confirm, input, password, select } from '@inquirer/prompts';
import chalk from 'chalk';
import { appConfig, cloneConfig, configExists, defaultConfig, loadConfig, maskConfig, saveConfig, validateConfig } from './config.mjs';
import { describeSyncStatus, readSyncStatus } from './status.mjs';
import { resolveVoucherInventoryUpdateMarker } from './voucher-inventory-lines.mjs';

type syncOptions = {
    once?: boolean;
    frequency?: string;
    from?: string;
    to?: string;
    company?: string;
    schema?: string;
    dbServer?: string;
    dbPort?: string;
    syncMode?: string;
    master?: string;
    transaction?: string;
    truncate?: string;
};

type voucherInventoryOptions = {
    fromAlterId?: string;
    toAlterId?: string;
    updateMarker?: boolean;
    noUpdateMarker?: boolean;
};

const program = new Command();
const SERVICE_TASK_NAME = 'TallyDBConnectorSync';

function printTitle(title = 'Tally DB Connector'): void {
    console.log(chalk.bold.cyan(title));
}

function printOk(message: string): void {
    console.log(`${chalk.green('OK')}  ${message}`);
}

function printFail(message: string): void {
    console.log(`${chalk.red('FAIL')}  ${message}`);
}

function printInfo(label: string, value: string): void {
    console.log(`${chalk.dim(label.padEnd(8))}${value}`);
}

function parseInteger(value: string, fallback: number): number {
    const parsed = parseInt(value, 10);
    return Number.isNaN(parsed) ? fallback : parsed;
}

function requireConfig(): appConfig {
    const config = loadConfig();
    const errors = validateConfig(config);
    if (errors.length) {
        throw new Error(`Config validation failed:\n${errors.map(p => `- ${p}`).join('\n')}`);
    }
    return config;
}

function friendlyOverrides(options: syncOptions): Map<string, string> {
    const overrides = new Map<string, string>();
    if (options.from) overrides.set('tally-fromdate', options.from);
    if (options.to) overrides.set('tally-todate', options.to);
    if (options.company !== undefined) overrides.set('tally-company', options.company);
    if (options.schema) overrides.set('database-schema', options.schema);
    if (options.dbServer) overrides.set('database-server', options.dbServer);
    if (options.dbPort) overrides.set('database-port', options.dbPort);
    if (options.syncMode) overrides.set('tally-sync', options.syncMode);
    if (options.master !== undefined) overrides.set('tally-master', options.master);
    if (options.transaction !== undefined) overrides.set('tally-transaction', options.transaction);
    if (options.truncate !== undefined) overrides.set('tally-truncate', options.truncate);
    return overrides;
}

function legacyOverrides(argv: string[]): Map<string, string> {
    const overrides = new Map<string, string>();
    for (let i = 0; i < argv.length - 1; i++) {
        const name = argv[i];
        const value = argv[i + 1];
        if (/^--\w+-\w+$/.test(name) && !value.startsWith('--')) {
            overrides.set(name.substring(2), value);
            i++;
        }
    }
    return overrides;
}

function mergeMaps(...maps: Map<string, string>[]): Map<string, string> {
    const result = new Map<string, string>();
    for (const map of maps) {
        for (const [key, value] of map.entries()) {
            result.set(key, value);
        }
    }
    return result;
}

function validateDateInput(value: string): true | string {
    return value === 'auto' || /^\d{4}-\d{2}-\d{2}$/.test(value) ? true : 'Use "auto" or YYYY-MM-DD.';
}

function validateIntegerInput(value: string): true | string {
    return /^\d+$/.test(value) ? true : 'Enter a non-negative integer.';
}

function summarizeConfig(config: appConfig, mode?: string): void {
    printInfo('Config', 'config.json');
    if (mode) printInfo('Mode', mode);
    printInfo('Tally', `${config.tally.server}:${config.tally.port}`);
    printInfo('Company', config.tally.company || 'Current active company');
    printInfo('DB', `${config.database.technology.toUpperCase()} ${config.database.server}:${config.database.port || 'default'}/${config.database.schema}`);
}

async function runSyncCommand(options: syncOptions, rawArgs: string[]): Promise<void> {
    if (options.once && options.frequency !== undefined) {
        throw new Error('Use either --once or --frequency, not both.');
    }

    const config = requireConfig();
    const overrides = mergeMaps(legacyOverrides(rawArgs), friendlyOverrides(options));
    const legacyFrequency = overrides.has('tally-frequency') ? parseInteger(overrides.get('tally-frequency') || '', -1) : undefined;
    const runtimeFrequency = options.once ? 0 : options.frequency !== undefined ? parseInteger(options.frequency, -1) : legacyFrequency ?? config.tally.frequency;
    if (runtimeFrequency < 0) throw new Error('--frequency must be a non-negative integer.');

    printTitle();
    summarizeConfig(config, runtimeFrequency > 0 ? `continuous sync every ${runtimeFrequency} minute(s)` : 'one-time sync');
    console.log('');

    const { runSync } = await import('./sync.mjs');
    await runSync({
        config,
        overrides,
        once: options.once,
        frequency: options.frequency !== undefined ? runtimeFrequency : undefined
    });
}

async function runTestCommand(): Promise<void> {
    printTitle('Connection Test');
    const config = requireConfig();
    const { testDatabaseConnection, testTallyConnection, listTallyCompanies } = await import('./sync.mjs');

    printOk('Config valid');

    try {
        await testTallyConnection(config);
        printOk(`Tally reachable at ${config.tally.server}:${config.tally.port}`);
    } catch (err: any) {
        printFail(`Tally unreachable: ${err?.message || err}`);
    }

    try {
        const companies = await listTallyCompanies(config);
        printOk(`${companies.length} open compan${companies.length == 1 ? 'y' : 'ies'} found`);
    } catch {
        printFail('Could not list open Tally companies');
    }

    try {
        await testDatabaseConnection(config);
        printOk(`Database reachable: ${config.database.technology.toUpperCase()} ${config.database.server}/${config.database.schema}`);
    } catch (err: any) {
        printFail(`Database unreachable: ${err?.message || err}`);
    }
}

async function runCompaniesCommand(configOverride?: appConfig): Promise<void> {
    printTitle('Open Tally Companies');
    const config = configOverride || requireConfig();
    const { listTallyCompanies } = await import('./sync.mjs');
    const companies = await listTallyCompanies(config);
    if (!companies.length) {
        console.log('No open companies found.');
        return;
    }

    for (const company of companies) {
        const marker = company.iscompanyactive ? chalk.green('active') : chalk.dim('open');
        console.log(`${marker.padEnd(12)} ${company.name}`);
    }
}

async function runConfigInit(force = false): Promise<void> {
    printTitle('Config Init');
    if (configExists() && !force) {
        const action = await select({
            message: 'config.json already exists.',
            choices: [
                { name: 'Keep existing file', value: 'keep' },
                { name: 'Overwrite with starter config', value: 'overwrite' },
                { name: 'Show current config', value: 'show' }
            ]
        });
        if (action == 'keep') {
            printOk('Kept existing config.json');
            return;
        }
        if (action == 'show') {
            console.log(JSON.stringify(maskConfig(loadConfig()), null, 4));
            return;
        }
    }
    saveConfig(cloneConfig(defaultConfig));
    printOk('Created config.json');
}

function runConfigShow(): void {
    printTitle('Config');
    console.log(JSON.stringify(maskConfig(loadConfig()), null, 4));
}

function runConfigValidate(): void {
    printTitle('Config Validate');
    const config = loadConfig();
    const errors = validateConfig(config);
    if (!errors.length) {
        printOk('Config valid');
        return;
    }
    for (const error of errors) {
        printFail(error);
    }
    process.exitCode = 1;
}

function runStatusCommand(): void {
    printTitle('Sync Status');
    for (const line of describeSyncStatus(readSyncStatus())) {
        console.log(line);
    }
}

async function runCheckChangesCommand(): Promise<void> {
    printTitle('Change Check');
    const config = requireConfig();
    const { inspectChangeState } = await import('./sync.mjs');
    const state = await inspectChangeState(config);

    printInfo('Tally', `${config.tally.server}:${config.tally.port}`);
    printInfo('Company', config.tally.company || 'Current active company');
    printInfo('Mode', config.tally.sync);
    printInfo('Tally M', String(state.tallyMasterAlterId));
    printInfo('Tally V', String(state.tallyTransactionAlterId));

    if (state.databaseError) {
        printFail(`Could not read database sync markers: ${state.databaseError}`);
        return;
    }

    printInfo('DB M', String(state.databaseMasterAlterId ?? 0));
    printInfo('DB V', String(state.databaseTransactionAlterId ?? 0));

    if (state.missingIncrementalColumns?.length) {
        printFail(`Incremental schema is incomplete. Missing "alterid" column in: ${state.missingIncrementalColumns.join(', ')}`);
    }

    if (state.masterChanged || state.transactionChanged) {
        printOk(`Change detected: master=${state.masterChanged ? 'yes' : 'no'}, transaction=${state.transactionChanged ? 'yes' : 'no'}`);
    }
    else {
        printFail('No AlterID change detected by Tally.');
    }
}

async function runStockGodownCommand(): Promise<void> {
    printTitle('Stock Godown Import');
    const config = requireConfig();
    summarizeConfig(config, 'stock godown custom TDL only');
    console.log('');

    const { runStockGodownImport } = await import('./sync.mjs');
    const rows = await runStockGodownImport(config);
    printOk(`stock_godown_summary imported ${rows} rows`);
}

async function runVoucherInventoryCommand(options: voucherInventoryOptions): Promise<void> {
    printTitle('Voucher Inventory Import');
    const config = requireConfig();
    summarizeConfig(config, 'voucher inventory custom TDL only');
    console.log('');

    const fromAlterId = options.fromAlterId !== undefined ? parseInteger(options.fromAlterId, -1) : undefined;
    const toAlterId = options.toAlterId !== undefined ? parseInteger(options.toAlterId, -1) : undefined;
    if (fromAlterId !== undefined && fromAlterId < 0) throw new Error('--from-alter-id must be a non-negative integer.');
    if (toAlterId !== undefined && toAlterId < 0) throw new Error('--to-alter-id must be a non-negative integer.');

    const { runVoucherInventoryImport } = await import('./sync.mjs');
    const rows = await runVoucherInventoryImport(config, {
        fromAlterId,
        toAlterId,
        updateMarker: resolveVoucherInventoryUpdateMarker(options)
    });
    printOk(`trn_inventory imported ${rows} rows`);
}



function getServiceBatchPath(): string {
    return path.join(process.cwd(), 'tallydb-service.bat');
}

function ensureServiceBatch(): string {
    const batchPath = getServiceBatchPath();
    const exePath = process.execPath.endsWith('node.exe') || process.execPath.endsWith('bun.exe')
        ? path.join(process.cwd(), 'dist', 'cli.mjs')
        : process.execPath;
    const command = exePath.endsWith('.mjs')
        ? `node "${exePath}" service-run`
        : `"${exePath}" service-run`;

    fs.writeFileSync(batchPath, `@echo off\r\ncd /d "%~dp0"\r\n${command}\r\n`, { encoding: 'ascii' });
    return batchPath;
}

function runSchtasks(args: string[]): string {
    return child_process.execFileSync('schtasks.exe', args, { encoding: 'utf8' });
}

function runServiceInstall(startup: string): void {
    printTitle('Install Background Sync');
    requireConfig();

    const batchPath = ensureServiceBatch();
    const schedule = startup == 'logon' ? 'ONLOGON' : 'ONSTART';
    const args = [
        '/Create',
        '/TN', SERVICE_TASK_NAME,
        '/TR', `"${batchPath}"`,
        '/SC', schedule,
        '/F'
    ];

    if (schedule == 'ONSTART') {
        args.push('/RU', 'SYSTEM');
    }

    runSchtasks(args);
    printOk(`Installed scheduled task "${SERVICE_TASK_NAME}" (${startup == 'logon' ? 'at user logon' : 'at computer startup'}).`);
    printInfo('Runner', batchPath);
    printInfo('Status', 'Use "tallydb status" or "tallydb service status".');
}

function runServiceStart(): void {
    printTitle('Start Background Sync');
    runSchtasks(['/Run', '/TN', SERVICE_TASK_NAME]);
    printOk(`Started scheduled task "${SERVICE_TASK_NAME}".`);
}

function runServiceStop(): void {
    printTitle('Stop Background Sync');
    runSchtasks(['/End', '/TN', SERVICE_TASK_NAME]);
    printOk(`Stopped scheduled task "${SERVICE_TASK_NAME}".`);
}

function runServiceUninstall(): void {
    printTitle('Uninstall Background Sync');
    runSchtasks(['/Delete', '/TN', SERVICE_TASK_NAME, '/F']);
    printOk(`Removed scheduled task "${SERVICE_TASK_NAME}".`);
}

function runServiceStatus(): void {
    printTitle('Background Sync Task');
    try {
        console.log(runSchtasks(['/Query', '/TN', SERVICE_TASK_NAME, '/V', '/FO', 'LIST']));
    } catch {
        printFail(`Scheduled task "${SERVICE_TASK_NAME}" is not installed.`);
    }
    console.log('');
    runStatusCommand();
}

async function runFrequencyCommand(): Promise<void> {
    printTitle('Sync Frequency');
    const config = requireConfig();
    printOk('Config valid');
    printInfo('Current', config.tally.frequency > 0 ? `${config.tally.frequency} minute(s)` : 'one-time sync');

    const frequency = parseInteger(await input({
        message: 'Frequency in minutes (0 for one-time sync)',
        default: String(config.tally.frequency),
        validate: validateIntegerInput
    }), config.tally.frequency);

    config.tally.frequency = frequency;
    const errors = validateConfig(config);
    if (errors.length) {
        for (const error of errors) printFail(error);
        throw new Error('Frequency update produced an invalid config.');
    }

    saveConfig(config);
    printOk(`Saved frequency: ${frequency > 0 ? `every ${frequency} minute(s)` : 'one-time sync'}`);
}

async function promptForConfig(): Promise<appConfig> {
    const existing = configExists() ? loadConfig() : cloneConfig(defaultConfig);
    const config = cloneConfig(existing);

    printTitle('Setup');
    console.log(chalk.dim('Press Enter to keep the shown default.'));
    console.log('');

    config.tally.server = await input({ message: 'Tally server', default: config.tally.server, required: true });
    config.tally.port = parseInteger(await input({ message: 'Tally port', default: String(config.tally.port), validate: validateIntegerInput }), config.tally.port);

    try {
        const { listTallyCompanies } = await import('./sync.mjs');
        const companies = await listTallyCompanies(config);
        if (companies.length) {
            const selectedCompany = await select({
                message: 'Tally company',
                choices: [
                    ...companies.map(p => ({ name: `${p.name}${p.iscompanyactive ? ' (active)' : ''}`, value: p.name })),
                    { name: 'Use currently active company', value: '' },
                    { name: 'Enter company name manually', value: '__manual__' }
                ]
            });
            config.tally.company = selectedCompany == '__manual__'
                ? await input({ message: 'Company name', default: config.tally.company })
                : selectedCompany;
        }
        else {
            config.tally.company = await input({ message: 'Company name (blank uses active company)', default: config.tally.company });
        }
    } catch {
        printFail('Could not list open Tally companies. You can still enter the company manually.');
        config.tally.company = await input({ message: 'Company name (blank uses active company)', default: config.tally.company });
    }

    config.tally.fromdate = await input({ message: 'From date', default: config.tally.fromdate, validate: validateDateInput });
    config.tally.todate = await input({ message: 'To date', default: config.tally.todate, validate: validateDateInput });
    config.tally.sync = await select({
        message: 'Sync mode',
        default: config.tally.sync,
        choices: [
            { name: 'Full', value: 'full' },
            { name: 'Incremental', value: 'incremental' }
        ]
    });
    if (config.tally.sync == 'incremental' && config.tally.definition == 'tally-export-config.yaml') {
        config.tally.definition = 'tally-export-config-incremental.yaml';
    }
    else if (config.tally.sync == 'full' && config.tally.definition == 'tally-export-config-incremental.yaml') {
        config.tally.definition = 'tally-export-config.yaml';
    }

    config.database.technology = await select({
        message: 'Database technology',
        default: config.database.technology,
        choices: [
            { name: 'Microsoft SQL Server', value: 'mssql' },
            { name: 'MySQL', value: 'mysql' },
            { name: 'PostgreSQL', value: 'postgres' },
            { name: 'Google BigQuery', value: 'bigquery' }
        ]
    });
    config.database.server = await input({ message: 'Database server', default: config.database.server, required: true });
    config.database.port = parseInteger(await input({ message: 'Database port (0 uses default)', default: String(config.database.port), validate: validateIntegerInput }), config.database.port);
    config.database.schema = await input({ message: 'Database/schema', default: config.database.schema, required: true });
    config.database.username = await input({ message: 'Database username', default: config.database.username });
    const newPassword = await password({ message: 'Database password (leave blank to keep existing)', mask: '*' });
    if (newPassword) config.database.password = newPassword;
    config.database.ssl = await confirm({ message: 'Use SSL?', default: config.database.ssl });
    config.database.loadmethod = await select({
        message: 'Load method',
        default: config.database.loadmethod,
        choices: [
            { name: 'File', value: 'file' },
            { name: 'Insert', value: 'insert' }
        ]
    });

    const advanced = await confirm({ message: 'Configure advanced options?', default: false });
    if (advanced) {
        config.tally.definition = await input({ message: 'Definition file', default: config.tally.definition, required: true });
        config.tally.batchsize = parseInteger(await input({ message: 'Batch size', default: String(config.tally.batchsize), validate: validateIntegerInput }), config.tally.batchsize);
        config.tally.frequency = parseInteger(await input({ message: 'Frequency in minutes (0 for one-time sync)', default: String(config.tally.frequency), validate: validateIntegerInput }), config.tally.frequency);
    }

    return config;
}

async function runSetupCommand(): Promise<void> {
    const config = await promptForConfig();
    const errors = validateConfig(config);
    if (errors.length) {
        for (const error of errors) printFail(error);
        throw new Error('Setup produced an invalid config.');
    }

    console.log('');
    printTitle('Summary');
    summarizeConfig(config, config.tally.frequency > 0 ? `continuous sync every ${config.tally.frequency} minute(s)` : 'one-time sync');
    console.log('');

    const { testDatabaseConnection, testTallyConnection } = await import('./sync.mjs');
    let checksPassed = true;
    try {
        await testTallyConnection(config);
        printOk('Tally reachable');
    } catch (err: any) {
        checksPassed = false;
        printFail(`Tally unreachable: ${err?.message || err}`);
    }
    try {
        await testDatabaseConnection(config);
        printOk('Database reachable');
    } catch (err: any) {
        checksPassed = false;
        printFail(`Database unreachable: ${err?.message || err}`);
    }

    if (!checksPassed) {
        const saveAnyway = await confirm({ message: 'Save this config anyway?', default: true });
        if (!saveAnyway) {
            console.log('Config not saved.');
            return;
        }
    }

    saveConfig(config);
    printOk('Saved config.json');

    const syncNow = await confirm({ message: 'Run first sync now?', default: false });
    if (syncNow) {
        await runSyncCommand({}, []);
    }
}

async function runMainMenu(): Promise<void> {
    while (true) {
        printTitle();
        const action = await select({
            message: 'What do you want to do?',
            choices: [
                { name: 'Run sync', value: 'sync' },
                { name: 'Setup / update config', value: 'setup' },
                { name: 'Set sync frequency', value: 'frequency' },
                { name: 'Test connections', value: 'test' },
                { name: 'Show sync status', value: 'status' },
                { name: 'Check Tally changes', value: 'changes' },
                { name: 'List open Tally companies', value: 'companies' },
                { name: 'Show config', value: 'show' },
                { name: 'Exit', value: 'exit' }
            ]
        });

        if (action == 'exit') return;

        try {
            if (action == 'sync') await runSyncCommand({}, []);
            else if (action == 'setup') await runSetupCommand();
            else if (action == 'frequency') await runFrequencyCommand();
            else if (action == 'test') await runTestCommand();
            else if (action == 'status') runStatusCommand();
            else if (action == 'changes') await runCheckChangesCommand();
            else if (action == 'companies') await runCompaniesCommand();
            else if (action == 'show') runConfigShow();
        } catch (err: any) {
            printFail(err?.message || String(err));
        }

        console.log('');
    }
}

program
    .name('tallydb')
    .description('Tally DB Connector CLI')
    .version('1.0.0')
    .action(runMainMenu);

program.command('voucher-orders')
    .description('Preview voucher order details; --apply backfills only order columns at the same source revision')
    .requiredOption('--guids <guids>', 'comma-separated list of 1–50 voucher GUIDs')
    .option('--apply', 'write revision-matched order details to PostgreSQL', false)
    .option('--debug-xml', 'save private request/response XML under backfill-debug for troubleshooting', false)
    .action(async (options: { guids: string; apply: boolean; debugXml: boolean }) => {
        const config = loadConfig();
        const errors = validateConfig(config);
        if (errors.length) throw new Error(errors.join('; '));
        const { backfillOrders } = await import('./order-backfill.mjs');
        console.log(JSON.stringify(await backfillOrders(config, options.guids.split(',').map(value => value.trim()), options.apply, { debugXml: options.debugXml }), null, 2));
    });

program.command('setup')
    .description('Create or update config.json with a guided wizard')
    .action(runSetupCommand);

program.command('sync')
    .description('Run one-time or continuous Tally sync')
    .allowUnknownOption(true)
    .option('--once', 'force one-time sync for this run')
    .option('--frequency <minutes>', 'run continuous sync for this run')
    .option('--from <date>', 'override tally.fromdate')
    .option('--to <date>', 'override tally.todate')
    .option('--company <name>', 'override tally.company')
    .option('--schema <name>', 'override database.schema')
    .option('--db-server <server>', 'override database.server')
    .option('--db-port <port>', 'override database.port')
    .option('--sync-mode <mode>', 'override tally.sync')
    .option('--master <true|false>', 'include master data for this run')
    .option('--transaction <true|false>', 'include transaction data for this run')
    .option('--truncate <true|false>', 'truncate before import for this run')
    .action(async (options: syncOptions, command: Command) => {
        await runSyncCommand(options, command.args);
    });

program.command('test')
    .description('Run read-only Tally and database connection checks')
    .action(runTestCommand);

program.command('companies')
    .description('List open companies from Tally')
    .action(async () => {
        await runCompaniesCommand();
    });

program.command('status')
    .description('Show background sync heartbeat and last activity')
    .action(runStatusCommand);

program.command('check-changes')
    .description('Compare current Tally AlterIDs with the last database sync markers')
    .action(runCheckChangesCommand);

program.command('stock-godown')
    .description('Import only custom TDL godown stock data into stock_godown_summary')
    .action(runStockGodownCommand);

program.command('voucher-inventory')
    .description('Import only custom TDL voucher inventory lines into trn_inventory')
    .option('--from-alter-id <number>', 'override starting voucher AlterID')
    .option('--to-alter-id <number>', 'optional ending voucher AlterID')
    .option('--no-update-marker', 'do not update Last Voucher Inventory AlterID marker')
    .action(runVoucherInventoryCommand);

program.command('service-run')
    .description('Run continuous sync for Windows background task')
    .option('--frequency <minutes>', 'background sync frequency in minutes', '1')
    .action(async (options: { frequency?: string }) => {
        await runSyncCommand({ frequency: options.frequency || '1' }, []);
    });

const serviceCommand = program.command('service')
    .description('Install and manage Windows background sync task');

serviceCommand.command('install')
    .description('Install background sync to run when Windows starts')
    .option('--startup <boot|logon>', 'start at computer boot or user logon', 'boot')
    .action((options: { startup?: string }) => {
        const startup = options.startup == 'logon' ? 'logon' : 'boot';
        runServiceInstall(startup);
    });

serviceCommand.command('start')
    .description('Start the background sync task now')
    .action(runServiceStart);

serviceCommand.command('stop')
    .description('Stop the background sync task')
    .action(runServiceStop);

serviceCommand.command('status')
    .description('Show Windows task status and sync heartbeat')
    .action(runServiceStatus);

serviceCommand.command('uninstall')
    .description('Remove the background sync task')
    .action(runServiceUninstall);

const configCommand = program.command('config')
    .description('Manage config.json');

configCommand.command('init')
    .description('Create starter config.json')
    .option('--force', 'overwrite existing config.json')
    .action(async (options: { force?: boolean }) => {
        await runConfigInit(!!options.force);
    });

configCommand.command('show')
    .description('Show config.json with secrets masked')
    .action(runConfigShow);

configCommand.command('validate')
    .description('Validate config.json shape')
    .action(runConfigValidate);

try {
    await program.parseAsync(process.argv);
} catch (err: any) {
    printFail(err?.message || String(err));
    process.exitCode = 1;
}
