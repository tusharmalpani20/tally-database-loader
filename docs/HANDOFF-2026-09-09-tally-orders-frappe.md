# Handoff: Tally order extraction, one-voucher backfill, and Frappe activation

Prepared 9 September 2026 for the next agent with access to the live Frappe site,
PostgreSQL mirror, and remote Tally environment. This distinguishes observed
results from code inspection and work that remains unverified.

## 1. Current state — start here

- Tally returned the correct order data through both the direct backfill report
  and the normal collection report. All five remote compatibility tests passed.
- The single target voucher's PostgreSQL `order_number` and `order_details` were
  subsequently verified populated using an enforced read-only connection.
- Frappe ingestion is NOT confirmed complete. It first failed because
  `tally_source_company` was unset. After the user corrected that, ingestion
  passed the mirror metadata check and failed because the approved fulfillment
  voucher-type list was empty/unset.
- The last advice was to configure the reviewed Kukatpally challan type and run
  Frappe's read-only `diagnose_vouchers`. No output confirming execution of that
  advice has been received. Check the actual site before making changes.
- The user currently does not care about export speed. Do not prioritize a
  performance redesign over finishing configuration, import, and reconciliation.
- Do not claim a complete normal incremental scheduler run has been verified:
  successful zero/one-voucher report tests do not establish every update,
  deletion, concurrency, or publication case.

## 2. Locations and deployment identity

Local parent workspace:
`/home/tm/Desktop/work/kunal_enterprise_frappe`

Active loader fork:
`my_tally-database-loader/tally-database-loader`

Origin: `git@github.com:tusharmalpani20/tally-database-loader.git`

Branch: `tally-sync-timeout-and-diagnostics`

Other local repositories exist (`tally-database-loader` and
`original_tally-database-loader`); they are not the active fork used for these
latest fixes. Do not patch or deploy the wrong copy.

Local Frappe app:
`kunal-frappe/apps/kunal_enterprises`

Live site: `ke-dev.hopnet.co.in`

Remote tracebacks show the Bench command package under
`/home/erpmaster/kunal-frappe/apps/frappe`, while the custom app resolves under
`/home/erpmaster/kunal-enterprises/apps/kunal_enterprises`. This may be a linked
app checkout. Verify the active bench, app path, branch, and worker deployment
before changing files or running migrations.

The user runs the loader on Windows from an extracted branch ZIP, with a folder
name containing `tally-database-loader-tally-sync-timeout-and-diagnostics`.
Do not assume it is a Git clone. Built `dist/*.mjs` files are tracked and pushed.
Preserve the user's `config.json` when replacing the ZIP checkout.

Credential source on this workstation:
`kunal_tally_credentails/database.txt` (spelling intentional). It contains
`tally_postgres_*` connection settings. Read securely if needed; never put its
contents in logs, Git, this handoff, or user-facing output.

## 3. Exact target identities

| Attribute | Verified value |
|---|---|
| Source company | `KUNAL ENTERPRISES - (from 1-Apr-24)` |
| Company GUID | `aac3341a-ee89-4145-9f7a-3edec7de877b` |
| Voucher GUID | `aac3341a-ee89-4145-9f7a-3edec7de877b-000f577f` |
| Voucher number | `KP/8535/26-27` |
| MasterID | `1005439` |
| Observed AlterID | `1855152` |
| Voucher date | `2026-09-02` |
| Voucher type | `Delivery Challan Kukatpally` |
| Voucher type GUID | `aac3341a-ee89-4145-9f7a-3edec7de877b-0000f4f7` |
| Order number | `KE-SO-00018-26-27` |
| Order date | `2026-09-02` |
| Export period used | `2024-04-01` through `2027-03-31` |

The conversation initially mentioned a different voucher, `KP/8533/26-27`,
whose GUID ends in `000f5777`. The actual exported XML and successful backfill
target are **KP/8535**, ending in **000f577f**. Do not confuse them.

MasterID is the direct Tally object lookup ID; it is NOT AlterID. Company GUID,
voucher GUID, and voucher-type GUID are also distinct identifiers.

## 4. Data flow and intended semantics

Tally is the source of truth. PostgreSQL is the mirrored/audit source consumed
by Frappe. The user wanted actual order numbers instead of relying on the
voucher reference for order matching.

The relevant Tally data comes from the voucher's `InvoiceOrderList`:

- `BasicPurchaseOrderNo` supplies the order number.
- `BasicOrderDate` supplies the order date.
- `$$NumItems:InvoiceOrderList` proves the number of extracted entries.

The item/batch allocation `ORDERNO` was empty in the observed voucher; it is not
the source to use for this case. Store the header order list in
`trn_voucher.order_details` (JSONB), plus `trn_voucher.order_number` (text).
Keep multiple entries; the scalar is only resolved when there is one distinct
nonblank order number. Do not collapse several different orders arbitrarily.

Inventory quantities remain in `trn_inventory`. Frappe needs both the header
order mapping and inventory lines for fulfillment reconciliation. Populated
order fields alone do not prove quantities or master mappings are complete.

## 5. What failed and what changed

Earlier broad GUID-filtered collection requests were slow and returned order
data but omitted export completeness/company metadata. The parser correctly
refused to publish these responses. There was also an earlier JavaScript
replacement-string issue that consumed `$$` in TDL functions; callback-based
replacement preserves those expressions.

A company-root/ObjectEx direct report returned an empty envelope, and a
company-context voucher-existence expression returned zero for an existing
voucher. Neither was safe to use as proof that the voucher was absent.

A minimal report-level binding worked:
`<OBJECT>Voucher : "ID:1005439"</OBJECT>`, with the voucher's order-list explosion.

The new direct protocol initially still returned empty envelopes. Audit found
`KEDODATE` and `KEDODate` defined as different fields even though Tally definition
names are case-insensitive. The nested field was renamed `KEDOOrderDate` and a
case/space-insensitive duplicate-definition regression test was added. This was
a genuine defect, but fixing it alone did not resolve the empty response.

Comparison with the working report then found missing root-part
`<SCROLLED>Vertical</SCROLLED>`. It was added to the direct root and normal-sync
metadata root. Remote tests after these changes all returned valid data.
These results support the corrected layout; avoid claiming an independently
proven internal Tally cause beyond what the experiments demonstrate.

`TOPPARTS`/`TOPLINES` were investigated and are valid TDL aliases; they were not
blindly replaced. No new permanent TDL installation was needed for these
embedded XML reports. Do not confuse this with the separate installed custom
inventory-line TDL used by the existing loader.

## 6. Code map and safety boundaries

Loader files:

- `src/direct-order-protocol.mts`: direct MasterID report, complete source and
  identity checks, dates, cancellation/optional status, eligibility, order count,
  XML structure validation, and diagnostic field stages.
- `src/order-backfill.mts`: explicit single-MasterID source pin, preview and
  revision-matched apply. Uses the full direct validator, not reduced probes.
- `src/order-store.mts`: SQL publication and import lock. Backfill updates only
  the two order columns where GUID AND AlterID match. It rechecks any existing
  company-GUID binding inside the SQL transaction. It does not create a durable
  binding when older mirrors have no Company GUID config row.
- `src/order-details.mts`: normal counted order and identity reports/parsers;
  root metadata scrolling correction also affects the identity export layout.
- `src/voucher-diagnostics.mts`: read-only probes; no PostgreSQL/Frappe access;
  captured request/response, timing events, progress and summary files.
- `src/backfill-diagnostics.mts`: backfill logging and XML capture before parsing.
- `src/cli.mts`: options and diagnostic case registration.
- `docs/order-protocol-release-gates.md`: current command/reference guidance.

New diagnostic modes:

- `direct-isolate`: sequential `direct-layout`, `direct-source`, `direct-safe`;
  stops at the first failure.
- `direct-layout`: identity and counted order extraction without company/status
  additions. Diagnostic-only, not acceptable input for production publication.
- `direct-source`: adds actual source company name/GUID checks.
- `direct-safe`: full production direct protocol and checks.
- `normal-empty` / `normal-one`: actual normal order generator and parser,
  with explicit count/company validation, not the experimental attribute report.

Older `batch-empty`/`batch-one` attribute-layout experiments remain available but
are not the tests that established success here. Opt-in probes are excluded
from `--case all`. Diagnostics have a one-hour HTTP limit per request; do not
assume this independently changes every scheduler timeout. On 10 September 2026,
the normal scheduler inactivity and absolute request defaults were also raised to
one hour. The local Tally request-lock queue remains a separate 15-minute limit.

Audit also added runtime rejection of invalid diagnostic stages and ambiguous
profiles containing duplicate `trn_voucher` definitions.

## 7. Commits and local verification

Already pushed to the active fork before this handoff:

| Commit | Purpose |
|---|---|
| `b5222a5` | Minimal direct orders/company metadata diagnostics |
| `121f109` | Strict direct protocol and batch probes |
| `6644d56` | Backfill source checks and release gates |
| `b48e8a2` | Case-insensitive date-field collision fix |
| `d60735a` | Root scrolling and staged direct checks |
| `7f30ac3` | Production-path diagnostics, validation, and documentation |

Most recent complete local suite: `npm test` built TypeScript and ran 88 tests:
**87 passed, 1 live PostgreSQL integration test skipped, 0 failures**.
These are not a substitute for end-to-end live Frappe verification.

At handoff preparation both the loader fork and local Frappe app worktrees were
clean. This latest phase made no Frappe code edits. Do not attribute all prior
Frappe features in that repository to these latest loader commits.

## 8. Remote evidence inspected

Local received artifacts: `/home/tm/Downloads/diagnose-debug`.

| Folder | Cases | Result / elapsed time |
|---|---|---|
| `diagnose-ovw4OJ` | direct-layout | passed, 599 ms |
| same | direct-source | passed, 35 ms |
| same | direct-safe | passed, 385 ms |
| `diagnose-T7YdRv` | normal-empty | passed, 2,563,113 ms (42m43s) |
| `diagnose-39wCs0` | normal-one | passed, 3,022,767 ms (50m23s) |

All responses were independently re-parsed locally with the current parsers.
The direct-safe response matched company GUID, voucher GUID, MasterID, AlterID,
date, `CANCELLED=0`, `OPTIONAL=0`, `ELIGIBLE=1`, and exactly one order.
Normal-empty returned actual `KEEXPORTCOUNT=0` plus the correct company, not an
empty envelope. Normal-one returned `KEEXPORTCOUNT=1`, the complete header,
`KEORDERCOUNT=1`, and the expected order/date.

For normal tests, request-lock acquisition was 0–1 ms and connection startup
was milliseconds. Nearly all the elapsed time preceded HTTP response headers;
the response body was small and arrived immediately afterward. The logs locate
the delay at waiting for Tally, not database writes, local locking, or XML
download. They do not distinguish Tally's internal processing from other
server-side waiting. Even the explicit zero-result request scanned slowly.

Older reference files include `/home/tm/Downloads/kp-8535.xml` (Alt+E export)
and `/home/tm/Downloads/tally/Archive`. Raw XML contains customer/business data;
it has not been committed into Git. Ask the user to transfer artifacts if the
next agent cannot access this workstation.

## 9. PostgreSQL backfill: confirmed result

After the user ran the backfill, the assistant connected with session
`default_transaction_read_only=on`, began `READ ONLY`, confirmed
`transaction_read_only=on`, selected the exact GUID, and rolled back/closed.
Exactly one row was returned:

```json
{
  "guid": "aac3341a-ee89-4145-9f7a-3edec7de877b-000f577f",
  "alterid": 1855152,
  "order_number": "KE-SO-00018-26-27",
  "order_details": [
    {"order_date": "2026-09-02", "order_number": "KE-SO-00018-26-27"}
  ]
}
```

The database state is confirmed; no apply log was supplied to establish the
exact execution timestamp. No PostgreSQL writes were performed by the assistant
during that verification. No reason exists to rerun the backfill blindly.

Read-only recheck, after verifying the configured schema (example uses public):

```sql
BEGIN READ ONLY;
SELECT guid, alterid, order_number, order_details
FROM public.trn_voucher
WHERE guid = 'aac3341a-ee89-4145-9f7a-3edec7de877b-000f577f';
ROLLBACK;
```

## 10. Frappe path and the two observed errors

The active path is:
`integrations.tally_postgres.import_all` -> `import_vouchers` ->
`voucher_snapshot.import_snapshot` -> `voucher_mirror.read_mirror` ->
`voucher_contract` validation -> `apply_snapshot` -> reconciliation.

It is not the older `cron/tally_sync.py` voucher routine. Code inspection shows
the mirror reader reads all headers and order payloads, not only headers with
a newly increased AlterID. Snapshot comparison can therefore detect an
order-only backfill with unchanged AlterID. This is conditional on a successful
import and all mapping/fulfillment checks, not a guarantee that an order status
will immediately change.

First error:

```text
ValueError: Configured Tally company does not match the PostgreSQL mirror
company = None
```

Advice given:

```bash
bench --site ke-dev.hopnet.co.in set-config tally_source_company "KUNAL ENTERPRISES - (from 1-Apr-24)"
```

The next user-run `import_all` got past the mirror metadata validation, then
failed in `validate_snapshot`:

```text
ValueError: Configure tally_source_company and tally_fulfillment_voucher_type_guids before importing vouchers
```

Given the passed company check, the missing/empty approved-type list is the
immediate blocker. The later `NameError: name 'kunal_enterprises' is not defined`
is secondary: Bench's exception fallback attempted to evaluate the dotted
method expression. It does not establish that the custom app is uninstalled.
Likewise, a connection shown as `closed: 1` in an unwound traceback is not proof
that a connection failure caused this validation error.

The earlier traceback's observed mirror state was:

- last master AlterID `586304`;
- transaction and voucher inventory markers both `1855754`;
- latest successful completed import ID `650`, finished 3 September 2026 at
  16:35:59 IST;
- latest failure ID `649`, which predates that success.

These are historical observations, not current database assertions. Metadata
validation requires matching company, latest success, a genuine completed
import message (`Import completed successfully.`), no later unrecovered
failure, valid period, and inventory caught up to transaction marker. Do not
forge sync pings or checkpoints to satisfy these conditions.

## 11. Next agent: safe execution sequence

1. Inspect the live site settings, installed app revision, pending migrations,
   worker configuration, and actual bench path. Do not dump credentials.
2. Recheck the target PostgreSQL row read-only. Check that its inventory lines
   and relevant customer/item/godown mappings exist before predicting fulfillment.
3. Review which voucher types should count as fulfillment. Do not automatically
   include Sales invoices, orders, all inventory types, or every branch.
4. Inspect the existing `tally_fulfillment_voucher_type_guids` list before setting
   it: `set-config` replaces the value. Preserve already reviewed types.

The exact command previously suggested, ONLY if enabling Kukatpally alone is
the agreed scope and no existing approved entries would be lost:

```bash
bench --site ke-dev.hopnet.co.in set-config tally_fulfillment_voucher_type_guids '["aac3341a-ee89-4145-9f7a-3edec7de877b-0000f4f7"]' --parse
```

Candidate-type inventory query (read-only; confirm schema):

```sql
SELECT voucher_type, _voucher_type, count(*)
FROM public.trn_voucher
GROUP BY voucher_type, _voucher_type
ORDER BY voucher_type;
```

5. Run the read-only Frappe diagnostic:

```bash
bench --site ke-dev.hopnet.co.in execute kunal_enterprises.integrations.tally_postgres.diagnose_vouchers
```

Review `approved_type_guids`, eligible counts, missing inventory, unavailable
order details, missing imported vouchers, and source publication metadata.
Important: this diagnostic can return an empty approved list and zero eligible
vouchers without raising the same `validate_snapshot` exception. A successful
command exit alone does not prove the site is properly configured. The bounded
sample is not guaranteed to include our target voucher.

6. With approval for live Frappe mutation, backups/migration state checked, and
   overlapping import jobs paused, run a controlled import:

```bash
bench --site ke-dev.hopnet.co.in execute kunal_enterprises.integrations.tally_postgres.import_all
```

This is NOT read-only: it imports masters/stock/vouchers and may reconcile
orders. A prior failed voucher phase does not imply earlier phases had no
effects. Inspect the actual state and logs rather than assuming rollback of
the whole workflow.

7. Verify the target Frappe Tally Voucher by source company and voucher GUID,
   not voucher number alone. Check order payload, inventory quantities,
   accepted/review state, sync logs (`Tally Sync Run`, `Tally Sync Error`), and
   the linked order `KE-SO-00018-26-27`. Resolve any Manual Review reasons from
   evidence rather than forcing status or quantities.
8. Resume schedules only after the controlled import and target reconciliation
   are verified. Background workers may need the deployment's normal refresh
   procedure; don't assume changing a site setting proves existing jobs reloaded.

If schema migration is actually pending, follow the app's rollout documentation
with a backup and explicit live-change authority. This handoff does not assert
that a new migration is needed for the current configuration error.

## 12. Backfill commands for reference, not a request to rerun

Windows PowerShell preview (no order data writes):

```powershell
node dist/cli.mjs voucher-orders --guids aac3341a-ee89-4145-9f7a-3edec7de877b-000f577f --master-id 1005439 --company-guid aac3341a-ee89-4145-9f7a-3edec7de877b --debug-xml 2>&1 | Tee-Object -FilePath backfill-preview.txt
```

Only with successful preview, `revision_matches: true`, and authorization, apply:

```powershell
node dist/cli.mjs voucher-orders --guids aac3341a-ee89-4145-9f7a-3edec7de877b-000f577f --master-id 1005439 --company-guid aac3341a-ee89-4145-9f7a-3edec7de877b --apply --debug-xml 2>&1 | Tee-Object -FilePath backfill-apply.txt
```

Expected success is `updated=1`. A changed revision must not be forced. Backfill
does not trigger Frappe, advance loader checkpoints, or repair a failed normal
publication. PowerShell's initial `NativeCommandError` formatting around stderr
logging is not itself evidence of failure: inspect final status, exit code,
summary and response. `> file 2>&1` redirects output away from the terminal;
`2>&1 | Tee-Object` both displays and saves it.

## 13. Remaining limits and guardrails

- PostgreSQL backfill success is verified; live Frappe reconciliation is not.
- Correct zero/one export structure is verified; complete normal-sync semantics
  and all voucher types are not.
- Do not treat a missing mirror row as proven Tally deletion. The Frappe reader
  explicitly treats missing records as observations requiring review.
- Keep order data at voucher-header level; don't replace it with empty batch
  `ORDERNO`, or quietly fall back to reference numbers for this fix.
- Preserve audit histories, revision guards, type approval, and source checks.
- Do not publish credentials or raw customer XML to origin. This handoff includes
  only the business identifiers necessary to locate the agreed target.

The immediate next task is **review/set the approved fulfillment type list,
run the read-only Frappe preview, then verify a controlled import and the target
order's reconciliation**. Another long Tally scan is not needed merely to fix
the currently reported missing Frappe setting.
