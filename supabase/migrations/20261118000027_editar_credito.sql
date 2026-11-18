-- =====================================================================
-- KU-034 · Editar un crédito (administrador)
-- Cambia en una sola transacción las fechas de cobro de las cuotas, la regla de no cobrar los
-- domingos y las notas. Los montos no cambian. El cambio queda en la auditoría y en la bitácora.
-- p: { org_id, credit_id, changes: [{ id, to }], skip_sundays (opcional), notes (opcional) }
-- =====================================================================
create or replace function public.edit_credit(p jsonb) returns void
language plpgsql set search_path = '' as $$
declare
  v_org bigint := (p->>'org_id')::bigint;
  v_credit bigint := (p->>'credit_id')::bigint;
  c record;
begin
  select id, status into c from public.credits where id = v_credit and org_id = v_org for update;
  if c.id is null then raise exception 'Crédito no encontrado' using errcode = 'P0001'; end if;
  if c.status = 'anulado' then raise exception 'El crédito está anulado; no se puede editar' using errcode = 'P0001'; end if;

  update public.installments i set due_date = x.due
    from jsonb_to_recordset(coalesce(p->'changes', '[]'::jsonb)) as x(id bigint, due date)
    where i.id = x.id and i.credit_id = v_credit and i.org_id = v_org and i.status <> 'pagada';

  update public.credits set
    first_due_date = (select min(due_date) from public.installments where credit_id = v_credit and status <> 'anulada'),
    last_due_date = (select max(due_date) from public.installments where credit_id = v_credit and status <> 'anulada'),
    skip_sundays = case when p ? 'skip_sundays' then (p->>'skip_sundays')::boolean else skip_sundays end,
    notes = case when p ? 'notes' then nullif(p->>'notes', '') else notes end,
    updated_at = now()
  where id = v_credit;
end $$;
revoke execute on function public.edit_credit(jsonb) from public, anon, authenticated;
grant execute on function public.edit_credit(jsonb) to service_role;
