# Order-number normalization

At Tally XML ingestion, both normal voucher export and direct backfill now:

1. Replace ASCII and C1 control characters with spaces (including tabs/newlines).
2. Trim leading/trailing whitespace.
3. Keep at most 140 Unicode code points, without splitting surrogate pairs.
4. Remove any trailing whitespace exposed by truncation.

The same cleaned value is used in `order_details` and in scalar order-number
resolution. Existing PostgreSQL rows are not rewritten by deploying this code.
Malformed XML and invalid order dates still fail validation; this does not repair
invalid raw XML. Publication continues to validate staged data strictly.

Every changed value emits a `[voucher-orders] Normalized order number` warning.
At the user's request it includes the full original and normalized values,
voucher GUID, one-based order entry, lengths, control-character replacement count,
truncated-character count, and available voucher context. Normal exports include
voucher number/type/date/revision/party from the profile; direct exports include
MasterID, company identity, revision, and available type/date. Control characters
are JSON-escaped so each warning remains a single line. Unchanged values do not
emit warnings. Capture stderr with `2>&1 | Tee-Object -FilePath sync-output.txt`.

These logs contain private business data. Truncation is deliberately lossy and
can make two different long numbers identical; cleaned identifiers may no longer
match an original Frappe order identifier. Review warnings when investigating
reconciliation discrepancies. The original value is retained in logs, not in an
additional PostgreSQL column. This change does not trigger Frappe reconciliation.
