# Order protocol implementation — first release gate

The direct backfill now uses a dedicated report-level MasterID protocol instead
of the failing company-root/ObjectEx hierarchy. The same protocol is available
as the read-only `direct-safe` probe. Company name/GUID, voucher identity, status,
period, eligibility, revision and order-list completeness are strictly checked.
`--company-guid` is an explicit per-invocation source pin, not an automatic database
binding migration. If a stored Company GUID exists, direct backfill checks it too.

**Status:** the remote baseline `direct-orders` succeeds, but `direct-safe` returned
an empty envelope even after the date-name collision was fixed. Both the direct
report root and the normal-sync metadata root now include vertical scrolling,
matching the working report layout. This is a compatibility correction, not proof
that scrolling was the sole cause. Company reads and the complete normal-sync
report still require remote verification. Do not apply or resume the scheduler
on the strength of local tests alone.

## Current verification sequence

Stop overlapping exports. Set the shared arguments in the same PowerShell window:

```powershell
$probeArgs = @('--guid', 'aac3341a-ee89-4145-9f7a-3edec7de877b-000f577f', '--master-id', '1005439', '--company-guid', 'aac3341a-ee89-4145-9f7a-3edec7de877b', '--from', '2024-04-01', '--to', '2027-03-31')
```

The company GUID comes from the supplied Alt+E export. Confirm it is still the
intended company. Run these individually, stopping on failure:

```powershell
node dist/cli.mjs voucher-diagnose @probeArgs --case direct-isolate 2>&1 | Tee-Object -FilePath backfill-output-direct-isolate.txt
node dist/cli.mjs voucher-diagnose @probeArgs --case normal-empty 2>&1 | Tee-Object -FilePath backfill-output-normal-empty.txt
node dist/cli.mjs voucher-diagnose @probeArgs --case normal-one 2>&1 | Tee-Object -FilePath backfill-output-normal-one.txt
```

`direct-isolate` runs three sequential stages: layout/identity/orders, then actual
company name/GUID, then full eligibility/date/status validation. It stops on the
first failed stage and saves each request and response. Reduced-stage output is
diagnostic-only and cannot pass the full backfill validator.

`normal-empty` and `normal-one` use the actual normal-sync order exporter and
parser, including company metadata, total count, and nested order counts. These
are preferable to the older experimental batch-attribute probes below for this
fix. An empty envelope never counts as a successful zero-row export. The one-row
probe is GUID-filtered and can still scan a large collection; it is not a speed
fix. Neither probe accesses PostgreSQL or changes checkpoints.

Even passing zero/one cases does not establish full incremental/deletion or
concurrent-edit correctness. Those checks remain part of the release gates.

No permanent installed TDL update or live migration has been performed. The
batch attribute reports are separate opt-in probes and are never used for writes.
They are intentionally excluded from `--case all`.

## Optional individual and older experimental probes

These are not additional required steps in the sequence above. `direct-safe` can
be rerun on its own; it is already the last stage of `direct-isolate`.

```powershell
node dist/cli.mjs voucher-diagnose @probeArgs --case direct-safe 2>&1 | Tee-Object -FilePath backfill-output-direct-safe.txt
```

The older attribute-layout experiments remain available if specifically needed.
Run them sequentially. `batch-empty` must return explicit zero-count metadata;
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
