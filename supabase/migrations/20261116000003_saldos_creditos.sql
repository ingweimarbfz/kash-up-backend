-- Saldos por crédito: lo pagado, el saldo, lo vencido y la próxima cuota.
-- "Hoy" se toma en la hora de Colombia. security_invoker: la vista respeta los permisos de quien consulta.
create or replace view public.credit_balances with (security_invoker = true) as
select
  c.id as credit_id,
  c.org_id,
  c.customer_id,
  c.lender_id,
  c.status,
  c.total_amount,
  coalesce(sum(i.paid_amount), 0) as paid_amount,
  c.total_amount - coalesce(sum(i.paid_amount), 0) as balance,
  coalesce(sum(i.capital) filter (where i.status in ('pendiente', 'parcial')), 0)
    - coalesce(sum(least(i.paid_amount, i.capital)) filter (where i.status = 'parcial'), 0) as capital_balance,
  coalesce(sum(i.amount - i.paid_amount) filter (where i.status in ('pendiente', 'parcial') and i.due_date < (now() at time zone 'America/Bogota')::date), 0) as overdue_amount,
  count(*) filter (where i.status in ('pendiente', 'parcial') and i.due_date < (now() at time zone 'America/Bogota')::date) as overdue_count,
  min(i.due_date) filter (where i.status in ('pendiente', 'parcial') and i.due_date < (now() at time zone 'America/Bogota')::date) as oldest_overdue_date,
  count(*) filter (where i.status = 'pagada') as paid_count,
  min(i.due_date) filter (where i.status in ('pendiente', 'parcial')) as next_due_date
from public.credits c
left join public.installments i on i.credit_id = c.id and i.status <> 'anulada'
group by c.id;

revoke all on public.credit_balances from anon, authenticated;
