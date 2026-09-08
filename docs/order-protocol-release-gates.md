# Order protocol implementation — first release gate

The direct backfill now uses a dedicated report-level MasterID protocol instead
of the failing company-root/ObjectEx hierarchy. The same protocol is available
as the read-only `direct-safe` probe. Company name/GUID, voucher identity, status,
period, eligibility, revision and order-list completeness are strictly checked.
`--company-guid` is an explicit per-invocation source pin, not an automatic database
binding migration. If a stored Company GUID exists, direct backfill checks it too.

**Status:** local implementation and regression tests only. The new company reads
in voucher context have not been verified on remote Tally. Do not apply until the
probe and preview succeed. Normal scheduler protocol/publication changes remain
blocked on the live compatibility gates; the scheduler is not fixed by this build.

No permanent installed TDL update or live migration has been performed. The
batch attribute reports are separate opt-in probes and are never used for writes.
They are intentionally excluded from `--case all`.

## Commands after deploying this build

Stop overlapping exports. In PowerShell, set the arguments once; the company GUID
below is the source company identity present in the supplied Alt+E export, not a
value inferred from the voucher GUID. Confirm it is still the intended company.

```powershell
$probeArgs = @('--guid', 'aac3341a-ee89-4145-9f7a-3edec7de877b-000f577f', '--master-id', '1005439', '--company-guid', 'aac3341a-ee89-4145-9f7a-3edec7de877b', '--from', '2024-04-01', '--to', '2027-03-31')
node dist/cli.mjs voucher-diagnose @probeArgs --case direct-safe 2>&1 | Tee-Object -FilePath backfill-output-direct-safe.txt
```

Only after it completes successfully, run the independent batch compatibility
tests sequentially. `batch-empty` must return explicit zero-count metadata;
`batch-one` must return one matching identity. The latter still uses a collection
and can be slow. Each diagnostic request has a one-hour HTTP limit.

```powershell
node dist/cli.mjs voucher-diagnose @probeArgs --case batch-empty 2>&1 | Tee-Object -FilePath backfill-output-batch-empty.txt
node dist/cli.mjs voucher-diagnose @probeArgs --case batch-one 2>&1 | Tee-Object -FilePath backfill-output-batch-one.txt
```

If direct-safe succeeds, the direct preview command is:

```powershell
node dist/cli.mjs voucher-orders --guids aac3341a-ee89-4145-9f7a-3edec7de877b-000f577f --master-id 1005439 --company-guid aac3341a-ee89-4145-9f7a-3edec7de877b --debug-xml 2>&1 | Tee-Object -FilePath backfill-output-preview.txt
```

The preview connects to PostgreSQL for metadata and revision checks but does not
update order data. It now also shows stored order values. Apply re-exports and
checks again; a zero-row revision-matched update returns failure, not success.
No request here triggers Frappe or modifies sync checkpoints.

## Frappe verification

Read-only source inspection confirms the active scheduler uses
integrations/tally_postgres.py -> voucher_snapshot.py -> voucher_mirror.py, not
the legacy cron/tally_sync.py voucher routine. It reads all headers and compares
order payloads, so an order-only change with the same AlterID can be detected.
However voucher_contract.py requires a successful complete loader publication,
inventory caught up to the transaction marker, and no later unrecovered failure.
A successful backfill does not clear an earlier failed loader run. Do not alter
sync_run_ping or checkpoints to bypass those checks.

## Remaining gated work

- Remote direct protocol validation; one-entry preview/apply only after approval.
- Empty/one/many batch envelope and full order-list validation on remote Tally.
- Durable source binding, deletion/concurrent-edit semantics, staging and atomic
  publication/checkpoint work before promoting a new normal scheduler protocol.
- Performance profiling, then any separately approved scheduling changes.

No safe claim about fixed normal-sync runtime can be made from local tests.
