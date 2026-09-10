import http from 'http';
import process from 'process';
import { createHash } from 'crypto';
import { tallyConfig } from './definition.mjs';
import { logger } from './logger.mjs';
import { MetricsSink } from './metrics.mjs';
import { withTallyLock } from './tally-lock.mjs';

//Tally holds the socket silent while it builds the report, so this is a build-time budget.
//
//Measured against the production company: a voucher collection walks the whole company on every
//request regardless of period or filters, and completes in 168s warm / 399s cold for ~300 MB. The
//previous 600000 sat close enough to that range that a cold cache, a richer fetch list or another
//user's load tipped runs over it - which is what the "Tally request exceeded 600000ms" failures
//were. They were never a crash or a hang: our own stopwatch was destroying a socket that would
//have delivered. One hour gives normal scheduled exports the same conservative budget as the
//diagnostic path while retaining a finite ceiling for genuinely wedged requests.
export function tallyRequestTimeoutMs(): number {
    const configured = parseInt(process.env['TALLY_REQUEST_TIMEOUT_MS'] || '', 10);
    return Number.isFinite(configured) && configured > 0 ? configured : 3600000;
}

//req.setTimeout is an inactivity timeout, so on its own nothing bounds a request's wall-clock
//time. An unbounded request outlives the lock's staleness window and ends up running beside the
//next one, which is the confirmed way to kill Tally. This is the hard ceiling.
export function tallyRequestMaxMs(): number {
    const configured = parseInt(process.env['TALLY_REQUEST_MAX_MS'] || '', 10);
    return Number.isFinite(configured) && configured > 0 ? configured : tallyRequestTimeoutMs();
}

export interface TallyTransport {
    post(xml: string): Promise<string>;
}

export interface TransportDiagnostics {
    timeoutMs?: number;
    progress?: (event: { phase: string; elapsedMs: number; bytes?: number; status?: number }) => void;
    partialResponse?: (body: string) => void;
}

export class HttpTallyTransport implements TallyTransport {
    constructor(private readonly config: tallyConfig, private readonly metrics?: MetricsSink,
        private readonly diagnostics: TransportDiagnostics = {}) {
        if (diagnostics.timeoutMs !== undefined && (!Number.isSafeInteger(diagnostics.timeoutMs) || diagnostics.timeoutMs <= 0 || diagnostics.timeoutMs > 2147483647)) throw new Error('Invalid request timeout');
    }

    private reportDiagnostic(action: () => void): void {
        // Logging/disk failures must not escape socket callbacks and leave a request unsettled.
        try { action(); } catch { console.error('Unable to write Tally transport diagnostic output.'); }
    }

    /**
     * Emits one `tally_request` metric per call with lock wait, time-to-first-byte and request
     * time kept apart. The caller's own timer around post() cannot tell them apart, so a request
     * queued behind another one used to be indistinguishable from a slow Tally report.
     */
    async post(msg: string): Promise<string> {
        const startedAt = Date.now();
        let lockWaitMs = 0;
        this.reportDiagnostic(() => this.diagnostics.progress?.({ phase: 'lock_wait', elapsedMs: 0 }));
        const queueTimer = this.diagnostics.progress ? setInterval(() => this.reportDiagnostic(() =>
            this.diagnostics.progress?.({ phase: 'lock_wait', elapsedMs: Date.now() - startedAt })), 15000) : undefined;
        queueTimer?.unref();
        try {
            const response = await withTallyLock(
                this.config.server,
                this.config.port,
                'tally export',
                () => this.postUnlocked(msg),
                waitMs => { if (queueTimer) clearInterval(queueTimer); lockWaitMs = waitMs; this.reportDiagnostic(() => this.diagnostics.progress?.({ phase: 'lock_acquired', elapsedMs: waitMs })); }
            );
            this.recordRequest(msg, startedAt, lockWaitMs, true, undefined, response);
            return response;
        } catch (err) {
            this.recordRequest(msg, startedAt, lockWaitMs, false, err);
            throw err;
        } finally {
            if (queueTimer) clearInterval(queueTimer);
        }
    }

    private recordRequest(msg: string, startedAt: number, lockWaitMs: number, success: boolean, error?: unknown, response?: string): void {
        if (!this.metrics) {
            return;
        }
        const elapsedMs = Date.now() - startedAt;
        this.metrics.record({
            phase: 'tally_request',
            elapsedMs,
            success,
            error: error instanceof Error ? error.message : error ? String(error) : undefined,
            calls: 1,
            lockWaitMs,
            ttfbMs: this.lastTtfbMs,
            xmlSha256: createHash('sha256').update(msg, 'utf8').digest('hex'),
            xmlBytes: Buffer.byteLength(msg, 'utf16le'),
            responseBytes: response == undefined ? undefined : Buffer.byteLength(response, 'utf16le')
        });
    }

    //set by the in-flight request so recordRequest can report it without threading a return value
    private lastTtfbMs?: number;

    private postUnlocked(msg: string): Promise<string> {
        return new Promise<string>((resolve, reject) => {
            const requestStartedAt = Date.now();
            this.lastTtfbMs = undefined;
            let settled = false;
            let hardCap: NodeJS.Timeout | undefined;
            let progressTimer: NodeJS.Timeout | undefined;
            let data = '';
            let bytes = 0;
            let phase = 'connecting';
            const emit = (next: string, status?: number) => {
                phase = next;
                this.reportDiagnostic(() => this.diagnostics.progress?.({ phase, elapsedMs: Date.now() - requestStartedAt, bytes, status }));
            };
            const settle = (fn: () => void) => {
                if (settled) {
                    return; //a destroyed request emits both a timeout and an error
                }
                settled = true;
                if (hardCap) {
                    clearTimeout(hardCap);
                }
                if (progressTimer) clearInterval(progressTimer);
                fn();
            };

            try {
                const req = http.request({
                    hostname: this.config.server,
                    port: this.config.port,
                    path: '',
                    method: 'POST',
                    headers: {
                        'Content-Length': Buffer.byteLength(msg, 'utf16le'),
                        'Content-Type': 'text/xml;charset=utf-16'
                    }
                },
                    (res) => {
                        emit('response_headers', res.statusCode);
                        res
                            .setEncoding('utf16le')
                            .on('data', (chunk) => {
                                bytes += Buffer.byteLength(chunk, 'utf16le');
                                data += chunk.toString() || '';
                                if (this.lastTtfbMs == undefined) {
                                    this.lastTtfbMs = Date.now() - requestStartedAt;
                                    emit('first_body_chunk');
                                }
                                phase = 'receiving_body';
                            })
                            .on('end', () => {
                                settle(() => {
                                    emit('response_complete');
                                    if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
                                        this.reportDiagnostic(() => this.diagnostics.partialResponse?.(data));
                                        reject(new Error(`Tally HTTP status ${res.statusCode}`));
                                    } else resolve(data);
                                });
                            })
                            .on('error', (httpErr) => {
                                settle(() => {
                                    this.reportDiagnostic(() => this.diagnostics.partialResponse?.(data));
                                    emit('response_error');
                                    logger.logMessage('Tally response failed before completion.');
                                    logger.logError('tally.postTallyXML()', httpErr['message'] || '');
                                    reject(httpErr);
                                });
                            });
                    });
                req.on('error', (reqError) => {
                    settle(() => {
                        this.reportDiagnostic(() => this.diagnostics.partialResponse?.(data));
                        emit('request_error');
                        logger.logMessage('Tally HTTP request failed; see the specific error below.');
                        logger.logError('tally.postTallyXML()', reqError['message'] || '');
                        reject(reqError);
                    });
                });
                req.on('socket', socket => {
                    socket.once('lookup', error => emit(error ? 'dns_error' : 'dns_resolved'));
                    socket.once('connect', () => emit('tcp_connected'));
                });
                req.once('finish', () => emit('request_sent_waiting_for_response'));
                emit('connecting');
                if (this.diagnostics.progress) {
                    progressTimer = setInterval(() => emit(phase), 15000);
                    progressTimer.unref();
                }
                req.setTimeout(this.diagnostics.timeoutMs ?? tallyRequestTimeoutMs(), () => {
                    req.destroy(new Error('Tally request timed out'));
                });
                hardCap = setTimeout(() => {
                    req.destroy(new Error(`Tally request exceeded ${this.diagnostics.timeoutMs ?? tallyRequestMaxMs()}ms`));
                }, this.diagnostics.timeoutMs ?? tallyRequestMaxMs());
                hardCap.unref();
                req.write(msg, 'utf16le');
                req.end();
            } catch (err) {
                settle(() => {
                    logger.logError('tally.postTallyXML()', err);
                    reject(err);
                });
            }
        });
    }
}

export class FakeTallyTransport implements TallyTransport {
    calls: string[] = [];

    constructor(private readonly response: string | ((xml: string) => string | Promise<string>)) { }

    async post(xml: string): Promise<string> {
        this.calls.push(xml);
        if (typeof this.response === 'function') {
            return await this.response(xml);
        }
        return this.response;
    }
}
