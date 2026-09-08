import fs from 'node:fs';
import path from 'node:path';
import { parseOrderVouchers } from './order-details.mjs';
export class BackfillDiagnostics {
    options;
    started = Date.now();
    directory;
    constructor(options = {}) {
        this.options = options;
    }
    redact(message) {
        for (const secret of this.options.secrets || []) {
            if (secret)
                message = message.split(secret).join('[REDACTED]');
        }
        return message;
    }
    log(message) {
        const line = `[voucher-orders ${new Date().toISOString()} +${((Date.now() - this.started) / 1000).toFixed(1)}s] ${this.redact(message)}`;
        (this.options.write || (value => console.error(value)))(line);
    }
    xml(kind, content) {
        if (!this.options.debugXml)
            return;
        if (!this.directory) {
            const root = path.resolve(this.options.debugRoot || 'backfill-debug');
            fs.mkdirSync(root, { recursive: true, mode: 0o700 });
            this.directory = fs.mkdtempSync(path.join(root, 'voucher-orders-'));
            this.log('XML capture enabled: these files may contain private company/customer/order data. Review before sharing.');
        }
        const file = path.join(this.directory, `${kind}.xml`);
        fs.writeFileSync(file, this.redact(content), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        this.log(`${kind} XML saved: ${file}`);
    }
}
export async function fetchBackfillVouchers(transport, request, table, company, diagnostics, direct = false) {
    diagnostics.xml('request', request);
    diagnostics.log(`Sending Tally export (${Buffer.byteLength(request, 'utf8')} UTF-8 bytes). Waiting for the request lock or Tally response...`);
    const heartbeat = setInterval(() => diagnostics.log('Still waiting for the request lock or Tally response; no order-data updates have started.'), 15000);
    heartbeat.unref();
    let response;
    try {
        response = await transport.post(request);
    }
    finally {
        clearInterval(heartbeat);
    }
    const names = new Set();
    let count = false, companyTag = false, errorTag = false, vouchers = 0;
    for (const match of response.matchAll(/<([A-Za-z_][\w.:-]*)(?=[\s/>])/g)) {
        const name = match[1].toUpperCase();
        if (names.size < 40)
            names.add(name);
        if (name === 'KEEXPORTCOUNT')
            count = true;
        if (name === 'KECOMPANY')
            companyTag = true;
        if (name === 'KEVOUCHER')
            vouchers++;
        if (['LINEERROR', 'ERROR', 'EXCEPTIONS'].includes(name))
            errorTag = true;
    }
    diagnostics.log(`Received ${Buffer.byteLength(response, 'utf8')} UTF-8 bytes. XML tag names (up to 40): ${[...names].join(', ') || '(none)'}`);
    diagnostics.log(`Expected markers: KEEXPORTCOUNT=${count}, KECOMPANY=${companyTag}; voucher tags=${vouchers}; Tally error tag=${errorTag}`);
    // Capture before validation so an unexpected/error response is available for diagnosis.
    diagnostics.xml('response', response);
    diagnostics.log('Validating response structure, company, voucher identities and order lists...');
    try {
        const rows = parseOrderVouchers(response, table, company, direct);
        diagnostics.log(`Response validated: ${rows.length} voucher(s).`);
        return rows;
    }
    catch (error) {
        diagnostics.log('Response validation failed before any order-data update. Use --debug-xml to capture the exact request/response if not already enabled.');
        throw error;
    }
}
//# sourceMappingURL=backfill-diagnostics.mjs.map