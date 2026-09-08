# Read-only voucher performance probes

The `voucher-diagnose` command sends exports to the Tally endpoint/company in
`config.json`. It never connects to PostgreSQL or Frappe, never applies order data,
and does not change installed TDL. Run it from the loader folder on the Windows
machine that can reach Tally, after obtaining the updated build.

Pause scheduled loader exports first, and do not run multiple diagnostic processes.
The local request lock does not coordinate clients on other machines. A timed-out
client request does not guarantee that Tally stopped processing it.

## Windows PowerShell command

```powershell
node dist/cli.mjs voucher-diagnose --guid aac3341a-ee89-4145-9f7a-3edec7de877b-000f577f --from 2024-04-01 --to 2027-03-31 --case all 2>&1 | Tee-Object -FilePath backfill-output-diagnostics.txt
```

The period above matches the failed request. Keep it unchanged for a controlled
comparison. Each HTTP request has an explicit **3,600,000ms (one hour)** limit for
both inactivity and total request time, overriding timeout environment variables
for this command only. Normal `voucher-orders` and sync defaults are unchanged.
The existing local-lock queue may add up to 15 minutes before an HTTP request starts.
Seven sequential tests can take several hours; the suite stops on the first failure.

| Case | What it measures |
| --- | --- |
| `company` | Small selected-company request: endpoint responsiveness |
| `guid` | Voucher collection with GUID-only filter and GUID/AlterID/MasterID fields |
| `direct` | Same identity fields from a report bound directly to the discovered MasterID, without a collection repeat |
| `filters` | Same fields as `guid`, adding the production cancellation/optional/type filters |
| `fields` | Production filters, header fields and fetch list, without the nested order report |
| `orders` | Full order extraction and metadata layout, but replaces only the total voucher-count expression with a diagnostic constant |
| `count` | Full production report, including total voucher count and production parser validation |

`all` discovers MasterID from the `guid` response and uses it for `direct`. If no
usable MasterID is returned, that test is recorded as skipped. MasterID is **not**
AlterID; no ID is guessed from the GUID. The report-object syntax follows
[Tally's voucher-identity documentation](https://help.tallysolutions.com/article/DeveloperReference/faq/6191.html).
Actual compatibility and timings must be verified on the target Tally installation.

To rerun just one case, replace `--case all` with e.g. `--case orders`. Standalone
`--case direct` additionally requires `--master-id <value-from-guid-result>`.
Do not immediately retry after a timeout; first check that Tally is responsive and
the previous export has finished. Do not use diagnostic XML as an import/backfill:
the `orders` count is deliberately disabled and several probes omit production fields.

## Artifacts and interpretation

The printed directory `backfill-debug/diagnose-*` contains:

- `progress.log`: timestamped events, also printed to the terminal;
- `summary.json`: completed/skipped/failed tests, elapsed times and timing events;
- `<case>-request.xml` and `<case>-response.xml` for completed HTTP responses;
- `<case>-partial.xml` for available incomplete/error response data, possibly empty.

These files contain private business information. Keep them private and review
before sharing. Output filenames/directories shown here are ignored by Git.

`lock_wait`/`lock_acquired` measure local queue time. After acquisition, event times
start at HTTP request creation: `connecting`, `dns_resolved` (if needed),
`tcp_connected`, `request_sent_waiting_for_response`, `response_headers`,
`first_body_chunk`, `receiving_body`, and `response_complete`/error. Waiting and
receiving phases repeat every 15 seconds. Byte counters describe decoded UTF-16
body bytes, not packet-level network traffic. A sent request means Node flushed
the request; it does not prove Tally has started executing the report.

Compare `guid` vs `filters` for filtering cost, `filters` vs `fields` for richer
fetch/field cost, `fields` vs `orders` for the order-report additions, and `orders`
vs `count` for total counting. Compare `guid` vs `direct` for the potential benefit
of object lookup. Tally caching, concurrent workload and test order can affect
results; repeat selected pairs before concluding that one operation is the cause.
Only `count` runs the full production order parser; earlier tests check XML errors
and returned identity/company, not suitability for updating PostgreSQL.
