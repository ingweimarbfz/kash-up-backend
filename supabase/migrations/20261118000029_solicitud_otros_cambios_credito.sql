-- =====================================================================
-- KU-038 · La solicitud del prestamista puede ser de cambio de fecha o de otro cambio
-- · kind = 'fecha': igual que antes (cuota, nueva fecha, modo); el administrador la aprueba o la rechaza.
-- · kind = 'otro': cambiar valor, interés, número de cuotas u otro dato. Solo se pide si el crédito
--   no tiene pagos; el administrador la rechaza y pide anular el crédito y crear uno nuevo.
-- Idempotente: se puede correr más de una vez.
-- =====================================================================
alter table public.credit_change_requests add column if not exists kind text not null default 'fecha';
alter table public.credit_change_requests add column if not exists topic text;
alter table public.credit_change_requests alter column from_number drop not null;
alter table public.credit_change_requests alter column new_date drop not null;
alter table public.credit_change_requests alter column skip_sundays drop not null;

alter table public.credit_change_requests drop constraint if exists credit_change_requests_kind_check;
alter table public.credit_change_requests add constraint credit_change_requests_kind_check check (
  (kind = 'fecha' and from_number is not null and new_date is not null and skip_sundays is not null)
  or (kind = 'otro' and topic in ('valor', 'interes', 'cuotas', 'otro'))
);
