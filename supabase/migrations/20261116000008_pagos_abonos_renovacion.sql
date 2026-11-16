-- KU-010 · Pagos, abono a capital, renovación de créditos y un solo prestamista por cliente.

-- ---------- Cuotas: interés condonado por abono a capital ----------
alter table public.installments add column waived numeric(14, 2) not null default 0 check (waived >= 0);

-- ---------- Créditos: renovación ----------
alter table public.credits drop constraint credits_status_check;
alter table public.credits add constraint credits_status_check check (status in ('activo', 'pagado', 'renovado', 'anulado', 'castigado'));
alter table public.credits add column renewed_from_id bigint references public.credits(id) on delete set null;
alter table public.credits add column payoff_amount numeric(14, 2) not null default 0;   -- saldo del crédito anterior descontado al renovar
alter table public.credits add column closed_at timestamptz;

-- ---------- Pagos ----------
create table public.payments (
  id bigint generated always as identity primary key,
  org_id bigint not null references public.organizations(id) on delete cascade,
  number bigint not null,
  credit_id bigint not null references public.credits(id) on delete restrict,
  customer_id bigint not null references public.customers(id) on delete restrict,
  lender_id bigint references public.users(id) on delete set null,        -- caja que recibe el dinero
  kind text not null check (kind in ('cuota', 'abono_capital', 'renovacion')),
  amount numeric(14, 2) not null check (amount > 0),
  method text not null default 'efectivo' check (method in ('efectivo', 'transferencia', 'otro', 'renovacion')),
  reference text,
  paid_on date not null,
  note text,
  lat numeric(9, 6),
  lng numeric(9, 6),
  status text not null default 'aplicado' check (status in ('aplicado', 'anulado')),
  void_reason text,
  user_id bigint references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint payments_org_number_key unique (org_id, number)
);
create index payments_org_date_idx on public.payments (org_id, paid_on desc);
create index payments_credit_idx on public.payments (credit_id);
create index payments_lender_date_idx on public.payments (lender_id, paid_on);

create table public.payment_allocations (
  id bigint generated always as identity primary key,
  org_id bigint not null references public.organizations(id) on delete cascade,
  payment_id bigint not null references public.payments(id) on delete cascade,
  installment_id bigint not null references public.installments(id) on delete cascade,
  amount numeric(14, 2) not null,     -- lo que se abonó a la cuota
  waived numeric(14, 2) not null default 0   -- interés condonado en esa cuota (abono a capital)
);
create index payment_allocations_payment_idx on public.payment_allocations (payment_id);

-- ---------- Saldos (ahora descuentan el interés condonado) ----------
create or replace view public.credit_balances with (security_invoker = true) as
select
  c.id as credit_id,
  c.org_id,
  c.customer_id,
  c.lender_id,
  c.status,
  c.total_amount,
  coalesce(sum(i.paid_amount), 0) as paid_amount,
  coalesce(sum(i.amount - i.paid_amount - i.waived), 0) as balance,
  coalesce(sum(greatest(i.capital - i.paid_amount, 0)) filter (where i.status in ('pendiente', 'parcial')), 0) as capital_balance,
  coalesce(sum(i.amount - i.paid_amount - i.waived) filter (where i.status in ('pendiente', 'parcial') and i.due_date < (now() at time zone 'America/Bogota')::date), 0) as overdue_amount,
  count(*) filter (where i.status in ('pendiente', 'parcial') and i.due_date < (now() at time zone 'America/Bogota')::date) as overdue_count,
  min(i.due_date) filter (where i.status in ('pendiente', 'parcial') and i.due_date < (now() at time zone 'America/Bogota')::date) as oldest_overdue_date,
  count(*) filter (where i.status = 'pagada') as paid_count,
  min(i.due_date) filter (where i.status in ('pendiente', 'parcial')) as next_due_date,
  coalesce(sum(i.waived), 0) as waived_amount
from public.credits c
left join public.installments i on i.credit_id = c.id and i.status <> 'anulada'
group by c.id;
revoke all on public.credit_balances from anon, authenticated;

-- Marca la cuota según lo pagado + condonado.
create or replace function public.installment_status(p_amount numeric, p_paid numeric, p_waived numeric) returns text
language sql immutable set search_path = '' as $$
  select case when p_paid + p_waived >= p_amount then 'pagada' when p_paid + p_waived > 0 then 'parcial' else 'pendiente' end
$$;

-- ---------- Registrar un pago ----------
-- kind 'cuota': se aplica a las cuotas pendientes desde la más antigua.
-- kind 'abono_capital': requiere estar al día; paga el capital de las últimas cuotas hacia atrás
--   y condona el interés de las cuotas que quedan cubiertas (el plazo se acorta).
-- kind 'renovacion': cierra el saldo completo del crédito (no entra efectivo a la caja).
create or replace function public.register_payment(p jsonb) returns bigint
language plpgsql set search_path = '' as $$
declare
  v_org bigint := (p->>'org_id')::bigint;
  v_credit bigint := (p->>'credit_id')::bigint;
  v_kind text := coalesce(p->>'kind', 'cuota');
  v_amount numeric := round((p->>'amount')::numeric);
  v_user bigint := nullif(p->>'user_id', '')::bigint;
  c record; i record; b record;
  v_left numeric; v_take numeric; v_cap numeric; v_waive numeric;
  v_pay bigint; v_acc bigint;
begin
  select * into c from public.credits where id = v_credit and org_id = v_org for update;
  if c.id is null then raise exception 'Crédito no encontrado' using errcode = 'P0001'; end if;
  if c.status <> 'activo' then raise exception 'El crédito #% no está activo', c.number using errcode = 'P0001'; end if;
  if coalesce(v_amount, 0) <= 0 then raise exception 'El valor del pago debe ser mayor que cero' using errcode = 'P0001'; end if;
  select * into b from public.credit_balances where credit_id = v_credit;
  if v_amount > b.balance then
    raise exception 'El pago (%) supera el saldo del crédito (%)', public.cop(v_amount), public.cop(b.balance) using errcode = 'P0001';
  end if;
  if v_kind = 'abono_capital' and b.overdue_count > 0 then
    raise exception 'Para abonar a capital el crédito debe estar al día. Primero paga lo vencido (%)', public.cop(b.overdue_amount) using errcode = 'P0001';
  end if;
  if v_kind = 'abono_capital' and v_amount > b.capital_balance then
    raise exception 'El abono a capital (%) supera el capital pendiente (%)', public.cop(v_amount), public.cop(b.capital_balance) using errcode = 'P0001';
  end if;
  if v_kind = 'renovacion' and v_amount <> b.balance then
    raise exception 'La renovación debe cubrir el saldo completo (%)', public.cop(b.balance) using errcode = 'P0001';
  end if;

  insert into public.payments (org_id, number, credit_id, customer_id, lender_id, kind, amount, method, reference, paid_on, note, lat, lng, user_id)
  values (v_org, public.next_counter(v_org, 'pago'), v_credit, c.customer_id, coalesce(nullif(p->>'lender_id', '')::bigint, c.lender_id), v_kind, v_amount,
          case when v_kind = 'renovacion' then 'renovacion' else coalesce(p->>'method', 'efectivo') end, p->>'reference',
          coalesce((p->>'paid_on')::date, (now() at time zone 'America/Bogota')::date), p->>'note',
          nullif(p->>'lat', '')::numeric, nullif(p->>'lng', '')::numeric, v_user)
  returning id into v_pay;

  v_left := v_amount;
  if v_kind in ('cuota', 'renovacion') then
    for i in select * from public.installments where credit_id = v_credit and status in ('pendiente', 'parcial') order by number for update loop
      exit when v_left <= 0;
      v_take := least(v_left, i.amount - i.paid_amount - i.waived);
      continue when v_take <= 0;
      update public.installments set paid_amount = paid_amount + v_take, paid_at = now(),
        status = public.installment_status(amount, paid_amount + v_take, waived) where id = i.id;
      insert into public.payment_allocations (org_id, payment_id, installment_id, amount) values (v_org, v_pay, i.id, v_take);
      v_left := v_left - v_take;
    end loop;
  else
    for i in select * from public.installments where credit_id = v_credit and status in ('pendiente', 'parcial') order by number desc for update loop
      exit when v_left <= 0;
      v_cap := greatest(i.capital - i.paid_amount, 0);
      continue when v_cap <= 0;
      if v_left >= v_cap then
        v_take := v_cap;
        v_waive := i.amount - i.paid_amount - i.waived - v_cap;   -- interés que ya no se cobra
      else
        v_take := v_left; v_waive := 0;
      end if;
      update public.installments set paid_amount = paid_amount + v_take, waived = waived + v_waive, paid_at = now(),
        status = public.installment_status(amount, paid_amount + v_take, waived + v_waive) where id = i.id;
      insert into public.payment_allocations (org_id, payment_id, installment_id, amount, waived) values (v_org, v_pay, i.id, v_take, v_waive);
      v_left := v_left - v_take;
    end loop;
  end if;

  -- El efectivo recaudado entra a la caja de quien cobra (o del negocio).
  if v_kind <> 'renovacion' then
    v_acc := case when coalesce(nullif(p->>'lender_id', '')::bigint, c.lender_id) is null then public.fund_business_account(v_org)
                  else public.fund_lender_account(v_org, coalesce(nullif(p->>'lender_id', '')::bigint, c.lender_id)) end;
    insert into public.fund_movements (org_id, account_id, type, amount, credit_id, note, user_id)
      values (v_org, v_acc, 'recaudo', v_amount, v_credit, (case when v_kind = 'abono_capital' then 'Abono a capital' else 'Pago' end) || ' del crédito #' || c.number, v_user);
  end if;

  -- ¿Quedó pagado?
  if not exists (select 1 from public.installments where credit_id = v_credit and status in ('pendiente', 'parcial')) then
    update public.credits set status = case when v_kind = 'renovacion' then 'renovado' else 'pagado' end, closed_at = now() where id = v_credit;
  end if;
  return v_pay;
end $$;

-- ---------- Anular un pago (solo el último pago aplicado del crédito, para no descuadrar) ----------
create or replace function public.void_payment(p_org bigint, p_payment bigint, p_reason text, p_user bigint) returns void
language plpgsql set search_path = '' as $$
declare pay record; a record; c record; v_acc bigint;
begin
  select * into pay from public.payments where id = p_payment and org_id = p_org for update;
  if pay.id is null then raise exception 'Pago no encontrado' using errcode = 'P0001'; end if;
  if pay.status = 'anulado' then raise exception 'El pago ya está anulado' using errcode = 'P0001'; end if;
  if pay.kind = 'renovacion' then raise exception 'El pago por renovación se reversa anulando el crédito nuevo' using errcode = 'P0001'; end if;
  if exists (select 1 from public.payments where credit_id = pay.credit_id and status = 'aplicado' and id > pay.id) then
    raise exception 'Solo se puede anular el último pago del crédito' using errcode = 'P0001';
  end if;
  select * into c from public.credits where id = pay.credit_id for update;
  if c.status not in ('activo', 'pagado') then raise exception 'El crédito #% está %', c.number, c.status using errcode = 'P0001'; end if;
  for a in select * from public.payment_allocations where payment_id = pay.id loop
    update public.installments set paid_amount = paid_amount - a.amount, waived = waived - a.waived,
      status = public.installment_status(amount, paid_amount - a.amount, waived - a.waived),
      paid_at = case when paid_amount - a.amount > 0 then paid_at else null end
    where id = a.installment_id;
  end loop;
  update public.payments set status = 'anulado', void_reason = p_reason where id = pay.id;
  if c.status = 'pagado' then update public.credits set status = 'activo', closed_at = null where id = c.id; end if;
  v_acc := case when pay.lender_id is null then public.fund_business_account(p_org) else public.fund_lender_account(p_org, pay.lender_id) end;
  insert into public.fund_movements (org_id, account_id, type, amount, credit_id, note, user_id)
    values (p_org, v_acc, 'ajuste', -pay.amount, c.id, 'Anulación del pago #' || pay.number || ' del crédito #' || c.number, p_user);
end $$;

-- ---------- Un solo prestamista por cliente ----------
-- Si el cliente ya tiene créditos (no anulados) con un prestamista, otro prestamista no le puede prestar;
-- solo el administrador. Se valida en la base para que ninguna vía lo salte.
create or replace function public.check_credit_lender() returns trigger
language plpgsql set search_path = '' as $$
declare v_role text; v_other text;
begin
  select role into v_role from public.users where id = new.created_by;
  if v_role = 'prestamista' then
    select trim(u.name || ' ' || coalesce(u.last_name, '')) into v_other
      from public.credits k join public.users u on u.id = k.lender_id
     where k.customer_id = new.customer_id and k.status <> 'anulado' and k.lender_id is distinct from new.lender_id limit 1;
    if v_other is not null then
      raise exception 'Este cliente ya tiene créditos con %. Solo el administrador puede otorgarle uno con otro prestamista', v_other using errcode = 'P0001';
    end if;
  end if;
  return new;
end $$;
create trigger credits_check_lender before insert on public.credits for each row execute function public.check_credit_lender();

-- ---------- Renovación ----------
-- Crea el crédito nuevo y cierra el anterior con su saldo actual. El cliente recibe la diferencia
-- (p.disbursed_amount ya viene neto del saldo). Requiere que el crédito anterior esté al día.
create or replace function public.renew_credit(p jsonb) returns bigint
language plpgsql set search_path = '' as $$
declare
  v_org bigint := (p->>'org_id')::bigint;
  v_old bigint := (p->>'renewed_from_id')::bigint;
  o record; b record; v_new bigint;
begin
  select * into o from public.credits where id = v_old and org_id = v_org for update;
  if o.id is null or o.status <> 'activo' then raise exception 'El crédito a renovar no existe o no está activo' using errcode = 'P0001'; end if;
  if (p->>'customer_id')::bigint <> o.customer_id then raise exception 'La renovación debe ser para el mismo cliente' using errcode = 'P0001'; end if;
  select * into b from public.credit_balances where credit_id = v_old;
  if b.overdue_count > 0 then
    raise exception 'No se puede renovar: el cliente debe ponerse al día primero (vencido: %)', public.cop(b.overdue_amount) using errcode = 'P0001';
  end if;
  if round(b.balance) <> round((p->>'payoff_amount')::numeric) then
    raise exception 'El saldo del crédito cambió (ahora %). Vuelve a calcular la renovación', public.cop(b.balance) using errcode = 'P0001';
  end if;
  if (p->>'disbursed_amount')::numeric <= 0 then
    raise exception 'El nuevo crédito debe ser mayor que el saldo actual (%)', public.cop(b.balance) using errcode = 'P0001';
  end if;
  v_new := public.create_credit(p);
  update public.credits set renewed_from_id = v_old, payoff_amount = b.balance where id = v_new;
  if b.balance > 0 then
    perform public.register_payment(jsonb_build_object('org_id', v_org, 'credit_id', v_old, 'kind', 'renovacion', 'amount', b.balance,
      'user_id', p->>'created_by', 'note', 'Renovado con el crédito #' || (select number from public.credits where id = v_new)));
  else
    update public.credits set status = 'renovado', closed_at = now() where id = v_old;
  end if;
  return v_new;
end $$;

-- Anular un crédito renovado devuelve el anterior a activo y deshace el pago de renovación.
create or replace function public.void_credit(p_org bigint, p_credit bigint, p_reason text, p_user bigint) returns void
language plpgsql set search_path = '' as $$
declare r record; v_wh bigint; v_from bigint; pay record; a record;
begin
  if exists (select 1 from public.payments where credit_id = p_credit and status = 'aplicado') then
    raise exception 'El crédito ya tiene pagos; anula primero los pagos' using errcode = 'P0001';
  end if;
  update public.credits set status = 'anulado', void_reason = p_reason where id = p_credit and org_id = p_org and status = 'activo'
    returning warehouse_id, renewed_from_id into v_wh, v_from;
  if not found then raise exception 'Crédito no encontrado o no está activo' using errcode = 'P0001'; end if;
  if v_wh is null then select id into v_wh from public.warehouses where org_id = p_org and is_general; end if;
  update public.installments set status = 'anulada' where credit_id = p_credit;
  for r in select product_id, quantity from public.credit_items where credit_id = p_credit loop
    insert into public.inventory_movements (org_id, warehouse_id, product_id, type, quantity, credit_id, note, user_id)
    values (p_org, v_wh, r.product_id, 'devolucion', r.quantity, p_credit, 'Anulación del crédito', p_user);
  end loop;
  if v_from is not null then
    for pay in select * from public.payments where credit_id = v_from and kind = 'renovacion' and status = 'aplicado' loop
      for a in select * from public.payment_allocations where payment_id = pay.id loop
        update public.installments set paid_amount = paid_amount - a.amount,
          status = public.installment_status(amount, paid_amount - a.amount, waived),
          paid_at = case when paid_amount - a.amount > 0 then paid_at else null end where id = a.installment_id;
      end loop;
      update public.payments set status = 'anulado', void_reason = 'Anulación del crédito de renovación' where id = pay.id;
    end loop;
    update public.credits set status = 'activo', closed_at = null where id = v_from;
  end if;
end $$;

-- ---------- Seguridad ----------
alter table public.payments enable row level security;
alter table public.payment_allocations enable row level security;
revoke all on public.payments, public.payment_allocations from anon, authenticated;
revoke execute on function public.installment_status(numeric, numeric, numeric), public.register_payment(jsonb), public.void_payment(bigint, bigint, text, bigint),
  public.check_credit_lender(), public.renew_credit(jsonb), public.void_credit(bigint, bigint, text, bigint) from public, anon, authenticated;
