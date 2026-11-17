-- =====================================================================
-- KU-027 · Comprobante de los pagos por transferencia
-- · payments.receipt_url: foto o PDF del comprobante (data URL, como las demás fotos).
-- · payments.has_receipt: para listar sin traer el archivo.
-- Los pagos por transferencia nuevos exigen el comprobante (lo valida la API).
-- =====================================================================
alter table public.payments add column if not exists receipt_url text;
alter table public.payments add column if not exists has_receipt boolean generated always as (receipt_url is not null) stored;
