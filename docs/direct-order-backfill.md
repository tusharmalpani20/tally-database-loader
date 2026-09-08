# Single-voucher order backfill

**Superseded implementation note:** the ObjectEx/company-root path described below
failed remote validation and is no longer used by direct backfill. See
[the current release gates and commands](order-protocol-release-gates.md).
Direct backfill now requires an explicit `--company-guid`; do not run these
historical commands without following the new read-only gates.

The shared counted report now exports a company-root metadata line and explodes
the voucher part beneath it. This replaces sibling metadata/voucher parts that
the September 8 remote responses demonstrated could omit company/count output.
Scheduled voucher exports and deletion-identity scans use the same corrected
layout. The parser still rejects absent metadata, wrong companies, mismatched
counts and malformed order lists. This layout needs confirmation on live Tally;
local XML/unit tests do not execute TDL.

For targeted backfills, `--master-id` binds the voucher part directly using TDL
ObjectEx, without a voucher collection scan or collection count. Tally evaluates
voucher existence for the export count, and exports an explicit eligibility flag
covering all profile/GUID filters and the database export period. Missing/false
eligibility fails validation. Company metadata and order-list counts are still
required. GUID is checked independently and PostgreSQL updates still require the
same GUID and AlterID. No changes to installed custom TDL or schema are needed.

The ID below was returned by this company's diagnostic run: MasterID 1005439,
GUID aac3341a-ee89-4145-9f7a-3edec7de877b-000f577f, KP/8535/26-27.
MasterID is not AlterID and must not be inferred from the GUID.

Stop overlapping loader exports. In Windows PowerShell, run a preview first:

```powershell
node dist/cli.mjs voucher-orders --guids aac3341a-ee89-4145-9f7a-3edec7de877b-000f577f --master-id 1005439 --debug-xml 2>&1 | Tee-Object -FilePath backfill-output-preview.txt
```

Only after preview validates, shows KE-SO-00018-26-27 and
`revision_matches: true`, apply:

```powershell
node dist/cli.mjs voucher-orders --guids aac3341a-ee89-4145-9f7a-3edec7de877b-000f577f --master-id 1005439 --debug-xml --apply 2>&1 | Tee-Object -FilePath backfill-output-apply.txt
```

This updates only PostgreSQL order columns; it does not trigger Frappe. A revision
mismatch requires the normal voucher sync, not bypassing the revision check.
Preview does not update order data but connects to PostgreSQL for schema/company
checks and takes the import lock. Backfill retains its normal timeout settings;
the diagnostic command alone defaults to one hour per request. A successful
direct preview does not validate the separate collection-based scheduler path;
test `voucher-diagnose --case count` with the same GUID and period before relying
on scheduled order imports. Collection performance is not changed by this fix.

TDL references: [ObjectEx and object association](https://help.tallysolutions.com/docs/td9rel54/tdlreference/general_and_collection_enhancements.htm),
[XML report attributes](https://help.tallysolutions.com/sample-xml/).
