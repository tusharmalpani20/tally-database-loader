-- Stop every older loader executable before applying this additive migration.
-- The column-explicit loader is the oldest supported rollback target afterward.
begin;
alter table public.trn_voucher add column if not exists order_details jsonb;
alter table public.trn_voucher add column if not exists order_number text;
comment on column public.trn_voucher.order_details is
    'Tally InvoiceOrderList entries. NULL means not extracted; [] means verified empty.';
comment on column public.trn_voucher.order_number is
    'One distinct trimmed BasicPurchaseOrderNo, otherwise NULL. Never inventory OrderNo.';
commit;
