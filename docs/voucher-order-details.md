# Voucher order details: deployment and verification

## Data contract

The focused incremental PostgreSQL profile exports the voucher's `InvoiceOrderList`:
`BasicPurchaseOrderNo` becomes `order_number`; `BasicOrderDate` becomes an ISO date.
This is not the voucher Reference Number or inventory/batch `OrderNo`.

`public.trn_voucher` gains two nullable columns:

| Column | Meaning |
| --- | --- |
| `order_details jsonb` | `null`: not extracted; `[]`: extracted and empty; otherwise all `{order_number, order_date}` entries |
| `order_number text` | The sole distinct trimmed nonblank number, or SQL `NULL` when there are zero or multiple numbers |

Repeated occurrences of the same number still resolve to one number. Dates are nullable.
Malformed XML, missing collection counts, duplicate voucher identities, invalid dates,
wrong company and overlong numbers fail the export before voucher publication.

The generated voucher report contains inline TDL for this collection. The installed
`tdl/db-voucher-inventory-lines.tdl` is **unchanged** and still populates `trn_inventory`.
Frappe matches orders with `trn_voucher.order_number`, but gets quantities/items/godowns
from `trn_inventory`, joined by voucher GUID. No Reference Number fallback is used.
Unknown extraction or multiple distinct numbers holds affected orders for review,
preserving accepted quantities rather than allocating the entire challan to each order.
Existing Frappe historical references are retained only to protect old contributions.

The inline-request mechanism is described in [Tally's XML integration documentation](https://help.tallysolutions.com/understanding-tally-xml-tags/).
That confirms the mechanism, not this report's runtime output; test-company acceptance remains required.

## Deployment sequence (operator action; not run by implementation)

1. Pause all loader instances and Frappe voucher import/reconciliation jobs. Back up
   both databases and retain the currently deployed executable/configuration.
2. Apply `migrations/postgres-voucher-order-details.sql` with an explicitly authorized
   PostgreSQL writer. It is additive and repeatable; it does not fill historical rows.
3. Build/deploy this fork (`npm ci`, `npm run build`, or the Windows packaging script).
   Select `tally-export-config-focused-incremental.yaml`, PostgreSQL and incremental
   sync, with an explicit company. Do not switch to a full rebuild for this change.
4. Before normal sync, verify the new inline TDL on a test Tally company using a
   GUID-bounded preview. Confirm actual response layout and empty-list/date output.
   Generated XML and synthetic responses are tested; actual Tally execution still
   requires this acceptance check. Existing installed inventory TDL need not be reloaded.
5. Run targeted historical backfills in batches of at most 50 GUIDs, preview first:

   ```sh
   node dist/cli.mjs voucher-orders --guids <voucher-guid>
   node dist/cli.mjs voucher-orders --guids <voucher-guid> --apply
   ```

   Preview does not write PostgreSQL data (it does take the shared loader lock).
   Apply updates **only** the two new columns and **only** where the stored GUID and
   AlterID still equal the exported revision. Review `missing` and `skipped`; a skipped
   revision needs a normal incremental sync before another preview/backfill.
   The command does not advance sync markers or refresh inventory. It requires an
   already initialized database with matching company and period metadata.
6. Deploy the companion Frappe app changes and run the site's normal `bench --site
   <site> migrate`. The post-schema patch does not copy old references into Order
   Number; it marks historical observations for verification, retaining hold links.
7. Complete a normal loader sync (including inventory), then a Frappe voucher import
   and reconciliation. Inspect order numbers and fulfilled quantities before resuming
   schedules. Rows not backfilled and unchanged in Tally remain unknown/held.

For the inspected `KP/8535/26-27` XML, the expected order is `KE-SO-00018-26-27`
dated `2026-09-02`. Verify its exact GUID in Tally; it is not the separately mentioned
`KP/8533/26-27` voucher. The private XML is not included as a repository fixture.

Read-only verification query (use bound parameters):

```sql
SELECT guid, alterid, voucher_number, order_number, order_details
FROM public.trn_voucher WHERE guid = $1;
```

## Updates, failures and rollback

Normal incremental header extraction uses a pinned upper AlterID. Header replacement,
its order collection and deferred header deletions commit together; failures roll back
that header transaction. Inventory and the rest of the existing loader are separate
phases, not one global transaction. Frappe's existing successful-run and inventory
checkpoint checks remain required. Tally itself is not a transactional snapshot.

The voucher deletion scan now uses counted, company-checked XML as well. Duplicate,
invalid and backwards diff revisions abort the run. Modified headers that leave the
narrower export filter are removed only after replacement validation, so an old
eligible header cannot survive indefinitely. Frappe treats their absence as unverified
and preserves accepted quantities for review; it does not infer cancellation.
Returned header revisions must be within the requested `(previous marker, pinned upper]`
range. A backwards Tally checkpoint or any diagnostic skip flag blocks the order profile.

Normal sync and order backfill share a PostgreSQL advisory lock. Old executables and
other writers do not honor that lock, so stop them during deployment. The loader's
PostgreSQL COPY now names columns explicitly, allowing profiles that omit new columns
to remain structurally compatible. Such profiles do not refresh order details and
must not feed the new Frappe matching flow.

The lock connection is kept alive and monitored; detected loss prevents subsequent
guarded publication/commits and successful-run reporting. Already committed phases
are not undone: after a connection failure, inspect the failed run and rerun normally.
Lock/backfill SSL settings follow the existing loader connection behavior.
Because the lock session and writer sessions are separate, the ownership check and
commit are not atomic. A disconnect immediately between those operations remains a
small race window; this is not a distributed fencing protocol.

Database publication revalidates order lists, dates, scalar consistency and duplicate
voucher identities independently of XML parsing. The Frappe cutover patch can be
replayed without reviving old reference holds on a verified empty order list.

For rollback, pause both schedules; keep the additive columns. Do not restore a legacy
positional-COPY executable against the expanded schema. Use a column-explicit compatible
build and keep Frappe imports disabled until loader/app contracts agree. Do not reset
AlterID checkpoints or drop columns as a shortcut to historical backfill.

## Manual-command diagnostics on Windows

`voucher-orders` prints timestamped progress to stderr and its final JSON result to
stdout. Progress includes schema checks, lock acquisition, the request/response sizes,
elapsed time, response tag names and expected markers, validation and write results.
While waiting for Tally/the request lock, a progress message appears every 15 seconds.
Passwords and the configuration object are not printed by these diagnostics.

To investigate `Missing voucher export completeness count`, use **preview** first.
From the updated loader directory, in Windows Command Prompt:

```bat
node dist/cli.mjs voucher-orders --guids aac3341a-ee89-4145-9f7a-3edec7de877b-000f577f --debug-xml > backfill-output.txt 2>&1
```

This saves both console streams to `backfill-output.txt` (overwriting that output
file). Add `--apply` only when you intend to perform the backfill. To see progress
on screen and save it simultaneously, use PowerShell:

```powershell
node dist/cli.mjs voucher-orders --guids aac3341a-ee89-4145-9f7a-3edec7de877b-000f577f --debug-xml 2>&1 | Tee-Object -FilePath backfill-output.txt
```

`--debug-xml` additionally saves `request.xml` and `response.xml` inside a unique
`backfill-debug/voucher-orders-*` directory, whose path is printed in the log.
Responses are saved before parsing, including unexpected/error responses. These
XML files can contain company/customer/order information; keep them private and
review before sharing. Debug files and the suggested output filenames are ignored
by Git. Without this option, raw XML is not saved by the backfill diagnostics.

Logging does not repair the missing-count response or relax validation; a malformed
response still stops the command before order-data writes.

## Tests

`npm test` builds and runs the unit suite. The PostgreSQL integration test is opt-in
via `KUNAL_ORDER_TEST_PG_SOCKET=/tmp/ke-order-pg.<suffix>` and deliberately restricted
to database `ke_order_test`, port `55439`, on a disposable Unix-socket-only instance.
It creates/drops test tables there; **never point tests at a real mirror**.

The companion Frappe app includes pure contract tests and database-backed voucher
correction/mirror tests. Run the latter only on a disposable migrated Frappe test site.
No live PostgreSQL/Frappe migration or Tally request is part of these code changes.
