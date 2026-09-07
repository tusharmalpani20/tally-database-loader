import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';

test('CLI exposes stock-only godown import command', () => {
    const help = childProcess.execFileSync(process.execPath, ['dist/cli.mjs', '--help'], { encoding: 'utf8' }).replace(/\s+/g, ' ');

    assert.match(help, /stock-godown/);
    assert.match(help, /custom TDL godown stock data/);
    assert.match(help, /voucher-inventory/);
    assert.match(help, /voucher-orders/);
    assert.match(help, /custom TDL voucher inventory lines/);
});
