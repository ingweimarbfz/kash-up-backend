-- =====================================================================
-- KU-011 · Rutero del día, visitas, gastos y cierre de jornada
-- · Las transferencias entran a la cuenta del negocio (no a la caja del prestamista).
-- · Gastos de ruta que salen de la caja del prestamista (o del negocio).
-- · Visitas: resultado de cada visita de cobro (no pagó, no estaba, promesa de pago).
-- · Cierre de jornada: cuadre del efectivo del prestamista; con la jornada cerrada el prestamista ya no registra pagos ni gastos de ese día.
-- =====================================================================

-- ---------- Movimientos de caja ligados al pago y nuevos tipos ----------
alter table public.fund_movements add column payment_id bigint references public.payments(id) on delete set null;
alter table public.fund_movements add column expense_id bigint;
alter table public.fund_movements drop constraint fund_movements_type_check;
alter table public.fund_movements add constraint fund_movements_type_check check (type in
  ('aporte', 'retiro', 'asignacion', 'devolucion_asignacion', 'desembolso', 'reverso_desembolso', 'recaudo', 'ajuste', 'gasto', 'reverso_gasto'));
-- Los recaudos existentes quedan ligados a su pago (el más reciente del mismo crédito y valor).
update public.fund_movements m set payment_id = (
  select p.id from public.payments p where p.credit_id = m.credit_id and p.amount = m.amount and p.kind <> 'renovacion' order by abs(extract(epoch from p.created_at - m.created_at)) limit 1)
 where m.type = 'recaudo' and m.payment_id is null and m.credit_id is not null;

-- ---------- Orden de la ruta ----------
alter table public.customers add column route_order integer;

-- ---------- Visitas de cobro ----------
create table public.visits (
  id bigint generated always as identity primary key,
  org_id bigint not null references public.organizations(id) on delete cascade,
  credit_id bigint not null references public.credits(id) on delete cascade,
  customer_id bigint not null references public.customers(id) on delete cascade,
  lender_id bigint references public.users(id) on delete set null,
  visited_on date not null,
  result text not null check (result in ('no_pago', 'no_estaba', 'promesa', 'otro')),
  promise_date date,
  note text,
  lat numeric(9, 6),
  lng numeric(9, 6),
  user_id bigint references public.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index visits_credit_idx on public.visits (credit_id, created_at desc);
create index visits_lender_day_idx on public.visits (org_id, lender_id, visited_on);

-- ---------- Gastos ----------
create table public.expenses (
  id bigint generated always as identity primary key,
  org_id bigint not null references public.organizations(id) on delete cascade,
  number text not null,
  lender_id bigint references public.users(id) on delete set null,       -- caja de la que sale (null = negocio)
  category text not null check (category in ('combustible', 'alimentacion', 'transporte', 'mantenimiento', 'papeleria', 'comunicaciones', 'otro')),
  amount numeric(14, 2) not null check (amount > 0),
  spent_on date not null,
  note text,
  photo_url text,
  status text not null default 'aplicado' check (status in ('aplicado', 'anulado')),
  void_reason text,
  user_id bigint references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint expenses_org_number_key unique (org_id, number)
);
create index expenses_org_day_idx on public.expenses (org_id, spent_on desc);
alter table public.fund_movements add constraint fund_movements_expense_fkey foreign key (expense_id) references public.expenses(id) on delete set null;

-- ---------- Cierres de jornada ----------
create table public.route_closures (
  id bigint generated always as identity primary key,
  org_id bigint not null references public.organizations(id) on delete cascade,
  lender_id bigint not null references public.users(id) on delete cascade,
  day date not null,
  collected_cash numeric(14, 2) not null default 0,
  collected_other numeric(14, 2) not null default 0,
  disbursed numeric(14, 2) not null default 0,
  expenses numeric(14, 2) not null default 0,
  received numeric(14, 2) not null default 0,        -- asignado por el negocio en el día
  delivered numeric(14, 2) not null default 0,       -- entregado al negocio (incluye la entrega del cierre)
  expected_cash numeric(14, 2) not null default 0,   -- saldo de la caja al cerrar, antes de la entrega
  counted_cash numeric(14, 2) not null default 0,    -- efectivo contado por el prestamista
  difference numeric(14, 2) not null default 0,      -- contado - esperado
  visits integer not null default 0,
  payments integer not null default 0,
  delivery_ref text,
  note text,
  closed_by bigint references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint route_closures_unique unique (org_id, lender_id, day)
);

-- ¿El prestamista ya cerró ese día?
create or replace function public.day_closed(p_org bigint, p_lender bigint, p_day date) returns boolean
language sql stable set search_path = '' as $$
  select exists (select 1 from public.route_closures where org_id = p_org and lender_id = p_lender and day = p_day)
$$;

-- Con la jornada cerrada, el prestamista no registra pagos ni gastos de ese día (el administrador sí puede).
create or replace function public.check_day_open() returns trigger
language plpgsql set search_path = '' as $$
declare v_role text; v_day date;
begin
  select role into v_role from public.users where id = new.user_id;
  if v_role is distinct from 'prestamista' or new.lender_id is null then return new; end if;
  v_day := (to_jsonb(new)->>(case when tg_table_name = 'payments' then 'paid_on' else 'spent_on' end))::date;
  if public.day_closed(new.org_id, new.lender_id, v_day) then
    raise exception 'La jornada del % ya está cerrada. Pide al administrador que la reabra', to_char(v_day, 'DD/MM/YYYY') using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger payments_day_open before insert on public.payments for each row execute function public.check_day_open();
create trigger expenses_day_open before insert on public.expenses for each row execute function public.check_day_open();

-- Registrar un gasto: sale de la caja del prestamista (o del negocio).
create or replace function public.register_expense(p jsonb) returns bigint
language plpgsql set search_path = '' as $$
declare
  v_org bigint := (p->>'org_id')::bigint;
  v_lender bigint := nullif(p->>'lender_id', '')::bigint;
  v_amount numeric := round((p->>'amount')::numeric);
  v_id bigint; v_num text; v_acc bigint;
begin
  if coalesce(v_amount, 0) <= 0 then raise exception 'El valor del gasto debe ser mayor que cero' using errcode = 'P0001'; end if;
  v_num := 'GA-' || lpad(public.next_counter(v_org, 'gasto')::text, 4, '0');
  insert into public.expenses (org_id, number, lender_id, category, amount, spent_on, note, photo_url, user_id)
    values (v_org, v_num, v_lender, p->>'category', v_amount, (p->>'spent_on')::date, nullif(p->>'note', ''), nullif(p->>'photo_url', ''), nullif(p->>'user_id', '')::bigint)
    returning id into v_id;
  v_acc := case when v_lender is null then public.fund_business_account(v_org) else public.fund_lender_account(v_org, v_lender) end;
  insert into public.fund_movements (org_id, account_id, type, amount, expense_id, ref, note, user_id)
    values (v_org, v_acc, 'gasto', -v_amount, v_id, v_num, coalesce(nullif(p->>'note', ''), 'Gasto ' || (p->>'category')), nullif(p->>'user_id', '')::bigint);
  return v_id;
end $$;

-- Anular un gasto: el dinero vuelve a la caja de la que salió.
create or replace function public.void_expense(p_org bigint, p_expense bigint, p_reason text, p_user bigint) returns void
language plpgsql set search_path = '' as $$
declare e record; m record;
begin
  select * into e from public.expenses where id = p_expense and org_id = p_org for update;
  if e.id is null then raise exception 'Gasto no encontrado' using errcode = 'P0001'; end if;
  if e.status = 'anulado' then raise exception 'El gasto ya está anulado' using errcode = 'P0001'; end if;
  update public.expenses set status = 'anulado', void_reason = p_reason where id = e.id;
  for m in select account_id, amount from public.fund_movements where expense_id = e.id and type = 'gasto' loop
    insert into public.fund_movements (org_id, account_id, type, amount, expense_id, ref, note, user_id)
      values (p_org, m.account_id, 'reverso_gasto', -m.amount, e.id, e.number, 'Anulación del gasto ' || e.number, p_user);
  end loop;
end $$;

-- Resumen de la jornada de un prestamista (lo que se ve antes de cerrar).
create or replace function public.day_summary(p_org bigint, p_lender bigint, p_day date) returns jsonb
language plpgsql stable set search_path = '' as $$
declare v_acc bigint; r jsonb;
begin
  v_acc := (select id from public.fund_accounts where org_id = p_org and kind = 'prestamista' and user_id = p_lender);
  select jsonb_build_object(
    'collected_cash', coalesce((select sum(amount) from public.payments where org_id = p_org and lender_id = p_lender and paid_on = p_day and status = 'aplicado' and kind <> 'renovacion' and method = 'efectivo'), 0),
    'collected_other', coalesce((select sum(amount) from public.payments where org_id = p_org and lender_id = p_lender and paid_on = p_day and status = 'aplicado' and kind <> 'renovacion' and method <> 'efectivo'), 0),
    'payments', (select count(*) from public.payments where org_id = p_org and lender_id = p_lender and paid_on = p_day and status = 'aplicado' and kind <> 'renovacion'),
    'expenses', coalesce((select sum(amount) from public.expenses where org_id = p_org and lender_id = p_lender and spent_on = p_day and status = 'aplicado'), 0),
    'disbursed', coalesce((select -sum(amount) from public.fund_movements where account_id = v_acc and type in ('desembolso', 'reverso_desembolso') and (created_at at time zone 'America/Bogota')::date = p_day), 0),
    'received', coalesce((select sum(amount) from public.fund_movements where account_id = v_acc and type = 'asignacion' and (created_at at time zone 'America/Bogota')::date = p_day), 0),
    'delivered', coalesce((select -sum(amount) from public.fund_movements where account_id = v_acc and type = 'devolucion_asignacion' and (created_at at time zone 'America/Bogota')::date = p_day), 0),
    'visits', (select count(*) from public.visits where org_id = p_org and lender_id = p_lender and visited_on = p_day),
    'balance', coalesce((select balance from public.fund_accounts where id = v_acc), 0)
  ) into r;
  return r;
end $$;

-- Cerrar la jornada: guarda el cuadre y, si se indica, entrega efectivo al negocio.
create or replace function public.close_day(p jsonb) returns bigint
language plpgsql set search_path = '' as $$
declare
  v_org bigint := (p->>'org_id')::bigint;
  v_lender bigint := (p->>'lender_id')::bigint;
  v_day date := (p->>'day')::date;
  v_counted numeric := round(coalesce((p->>'counted_cash')::numeric, 0));
  v_deliver numeric := round(coalesce((p->>'deliver')::numeric, 0));
  v_user bigint := nullif(p->>'user_id', '')::bigint;
  s jsonb; v_ref text; v_id bigint;
begin
  if public.day_closed(v_org, v_lender, v_day) then raise exception 'La jornada del % ya está cerrada', to_char(v_day, 'DD/MM/YYYY') using errcode = 'P0001'; end if;
  if v_counted < 0 or v_deliver < 0 then raise exception 'Los valores no pueden ser negativos' using errcode = 'P0001'; end if;
  if v_deliver > v_counted then raise exception 'No puedes entregar más efectivo del que contaste (%)', public.cop(v_counted) using errcode = 'P0001'; end if;
  s := public.day_summary(v_org, v_lender, v_day);
  if v_deliver > 0 then
    v_ref := public.fund_assign(v_org, v_lender, -v_deliver, v_user, 'Entrega en el cierre de jornada del ' || to_char(v_day, 'DD/MM/YYYY'));
  end if;
  insert into public.route_closures (org_id, lender_id, day, collected_cash, collected_other, disbursed, expenses, received, delivered,
      expected_cash, counted_cash, difference, visits, payments, delivery_ref, note, closed_by)
    values (v_org, v_lender, v_day, (s->>'collected_cash')::numeric, (s->>'collected_other')::numeric, (s->>'disbursed')::numeric, (s->>'expenses')::numeric,
      (s->>'received')::numeric, (s->>'delivered')::numeric + v_deliver, (s->>'balance')::numeric, v_counted, v_counted - (s->>'balance')::numeric,
      (s->>'visits')::int, (s->>'payments')::int, v_ref, nullif(p->>'note', ''), v_user)
    returning id into v_id;
  return v_id;
end $$;

-- ---------- Pagos: transferencias al negocio y anulación desde la misma caja ----------
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

  -- El dinero recaudado entra a una caja.
  if v_kind <> 'renovacion' then
    -- Efectivo: a la caja de quien cobra. Transferencia u otro medio: a la cuenta del negocio.
    v_acc := case when coalesce(p->>'method', 'efectivo') <> 'efectivo' or coalesce(nullif(p->>'lender_id', '')::bigint, c.lender_id) is null then public.fund_business_account(v_org)
                  else public.fund_lender_account(v_org, coalesce(nullif(p->>'lender_id', '')::bigint, c.lender_id)) end;
    insert into public.fund_movements (org_id, account_id, type, amount, credit_id, payment_id, note, user_id)
      values (v_org, v_acc, 'recaudo', v_amount, v_credit, v_pay, (case when v_kind = 'abono_capital' then 'Abono a capital' else 'Pago' end) || ' del crédito #' || c.number, v_user);
  end if;

  -- ¿Quedó pagado?
  if not exists (select 1 from public.installments where credit_id = v_credit and status in ('pendiente', 'parcial')) then
    update public.credits set status = case when v_kind = 'renovacion' then 'renovado' else 'pagado' end, closed_at = now() where id = v_credit;
  end if;
  return v_pay;
end $$;

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
  -- Sale de la misma caja a la que entró.
  select account_id into v_acc from public.fund_movements where payment_id = pay.id and type = 'recaudo' limit 1;
  if v_acc is null then
    v_acc := case when pay.lender_id is null then public.fund_business_account(p_org) else public.fund_lender_account(p_org, pay.lender_id) end;
  end if;
  insert into public.fund_movements (org_id, account_id, type, amount, credit_id, payment_id, note, user_id)
    values (p_org, v_acc, 'ajuste', -pay.amount, c.id, pay.id, 'Anulación del pago #' || pay.number || ' del crédito #' || c.number, p_user);
end $$;

-- ---------- Seguridad ----------
alter table public.visits enable row level security;
alter table public.expenses enable row level security;
alter table public.route_closures enable row level security;
revoke all on public.visits, public.expenses, public.route_closures from anon, authenticated;
revoke execute on function public.day_closed(bigint, bigint, date), public.check_day_open(), public.register_expense(jsonb), public.void_expense(bigint, bigint, text, bigint),
  public.day_summary(bigint, bigint, date), public.close_day(jsonb) from public, anon, authenticated;
