import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { BackfillDiagnostics, fetchBackfillVouchers } from '../dist/backfill-diagnostics.mjs';

const table = yaml.load(fs.readFileSync('tally-export-config-focused-incremental.yaml', 'utf8')).transaction[0];

test('missing completeness count logs stage and structure without private response values', async () => {
    const lines = [];
    const diagnostics = new BackfillDiagnostics({ write: line => lines.push(line), secrets: ['secret-password'] });
    diagnostics.log('redact secret-password');
    await assert.rejects(fetchBackfillVouchers({ post: async () => '<ENVELOPE><PRIVATE>customer-data</PRIVATE></ENVELOPE>' },
        '<REQUEST/>', table, 'Company', diagnostics), /Missing voucher export completeness count/);
    const output = lines.join('\n');
    assert.match(output, /KEEXPORTCOUNT=false/);
    assert.match(output, /ENVELOPE, PRIVATE/);
    assert.match(output, /before any order-data update/);
    assert.match(output, /--debug-xml/);
    assert.doesNotMatch(output, /customer-data|secret-password/);
});

test('XML capture preserves unexpected response before parser failure in separate run folders', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'backfill-diagnostics-test-'));
    try {
        for (let i = 0; i < 2; i++) {
            const diagnostics = new BackfillDiagnostics({ debugXml: true, debugRoot: root, write: () => {}, secrets: ['secret'] });
            await assert.rejects(fetchBackfillVouchers({ post: async () => '<ENVELOPE><LINEERROR>secret</LINEERROR></ENVELOPE>' },
                '<REQUEST/>', table, 'Company', diagnostics));
        }
        const folders = fs.readdirSync(root);
        assert.equal(folders.length, 2);
        for (const folder of folders) {
            assert.equal(fs.readFileSync(path.join(root, folder, 'request.xml'), 'utf8'), '<REQUEST/>');
            assert.match(fs.readFileSync(path.join(root, folder, 'response.xml'), 'utf8'), /\[REDACTED\]/);
        }
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('valid empty response logs validation; transport errors remain errors', async () => {
    const lines = [];
    const diagnostics = new BackfillDiagnostics({ write: line => lines.push(line) });
    const result = await fetchBackfillVouchers({ post: async () => '<ENVELOPE><KEEXPORTCOUNT>0</KEEXPORTCOUNT><KECOMPANY>Company</KECOMPANY></ENVELOPE>' },
        '<REQUEST/>', table, 'Company', diagnostics);
    assert.deepEqual(result, []);
    assert.match(lines.join('\n'), /Response validated: 0 voucher/);
    await assert.rejects(fetchBackfillVouchers({ post: async () => { throw new Error('timeout'); } },
        '<REQUEST/>', table, 'Company', diagnostics), /timeout/);
});
