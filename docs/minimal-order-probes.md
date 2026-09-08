# Isolate the empty Tally report

The remote direct backfill returned a valid empty ENVELOPE. Its input XML was
valid, including escaped comparisons. Production report rendering is still
unverified: do not apply a backfill or assume scheduled order exports work yet.

These read-only diagnostic cases use the PARTS/LINES layout from the successful
company and direct identity probes. They do not use the metadata-root hierarchy,
TOPPARTS/TOPLINES or part-level ObjectEx. No installed TDL changes are necessary;
the loader embeds these small TDL definitions in each export request.

Run in PowerShell from the updated repository with scheduled exports stopped:

```powershell
node dist/cli.mjs voucher-diagnose --guid aac3341a-ee89-4145-9f7a-3edec7de877b-000f577f --master-id 1005439 --from 2024-04-01 --to 2027-03-31 --case direct-orders 2>&1 | Tee-Object -FilePath backfill-output-direct-orders.txt
```

This binds the REPORT directly to MasterID 1005439, exports GUID/AlterID/MasterID,
and explodes InvoiceOrderList into order numbers/dates with a list count. The
summary includes parsed orders. Expected for the supplied historical export:
KE-SO-00018-26-27, 2026-09-02. Later Tally edits may change those values.

After the first command returns (do not overlap requests), run independently:

```powershell
node dist/cli.mjs voucher-diagnose --guid aac3341a-ee89-4145-9f7a-3edec7de877b-000f577f --master-id 1005439 --from 2024-04-01 --to 2027-03-31 --case company-metadata 2>&1 | Tee-Object -FilePath backfill-output-company-metadata.txt
```

This exports the actual company name and evaluates voucher existence in company
context. It has no voucher collection scan or order explosion. Expected response:
F01 equals the configured company and F02 equals 1.

Each case saves request/response XML, progress.log and summary.json in its own
backfill-debug/diagnose-* directory; failures preserve available output too.
Share both folders after reviewing private data. Both commands allow one hour
per HTTP request and never connect to PostgreSQL or Frappe. If HTTP times out,
check Tally is responsive before sending the second request.

These are isolation probes, not production-safe import payloads. In particular,
direct-orders does not verify company metadata or business/date eligibility;
the dates are request variables, not a filter on a direct object lookup. Neither
success nor failure here changes the production parser or permits importing an
uncounted/unauthenticated report. No database or production TDL changes are made
by running these probes.
