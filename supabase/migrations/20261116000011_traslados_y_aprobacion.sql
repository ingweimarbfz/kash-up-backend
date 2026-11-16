-- =====================================================================
-- KU-014
-- 1) Traslado de dinero entre prestamistas a través del administrador:
--    el prestamista envía el valor a la caja del negocio (queda "pendiente") y el administrador
--    se lo entrega al otro prestamista, o lo rechaza y el dinero vuelve a quien lo envió.
-- 2) Un cliente puede tener varios créditos, pero si el prestamista le hace uno nuevo (no renovación)
--    teniendo otro activo, queda como solicitud hasta que el administrador la apruebe.
-- =====================================================================

-- ---------- 1) Traslados de dinero ----------
alter table public.fund_movements drop constraint fund_movements_type_check;
alter table public.fund_movements add constraint fund_movements_type_check check (type in
  ('aporte', 'retiro', 'asignacion', 'devolucion_asignacion', 'desembolso', 'reverso_desembolso', 'recaudo', 'ajuste', 'gasto', 'reverso_gasto', 'traslado'));

-- Igual que antes, pero el dinero de un traslado solo pasa por el negocio: no se le exige la reserva mínima.
create or replace function public.apply_fund_movement() returns trigger
language plpgsql set search_path = '' as $$
declare a record; v_pct numeric; v_reserve numeric; v_who text;
begin
  select * into a from public.fund_accounts where id = new.account_id and org_id = new.org_id for update;
  if a.id is null then raise exception 'Cuenta no encontrada' using errcode = 'P0001'; end if;
  if a.kind = 'negocio' and new.type in ('aporte', 'retiro') then
    update public.fund_accounts set capital = capital + new.amount where id = a.id;
    a.capital := a.capital + new.amount;
  end if;
  if a.balance + new.amount < 0 then
    if a.kind = 'negocio' then
      raise exception 'Saldo insuficiente en la cuenta del negocio (disponible: %)', public.cop(a.balance) using errcode = 'P0001';
    end if;
    select trim(name || ' ' || coalesce(last_name, '')) into v_who from public.users where id = a.user_id;
    raise exception 'Saldo insuficiente en la caja de % (disponible: %)', v_who, public.cop(a.balance) using errcode = 'P0001';
  end if;
  if a.kind = 'negocio' and new.amount < 0 and new.type <> 'traslado' then
    select coalesce(min_reserve_pct, 10) into v_pct from public.app_settings where org_id = new.org_id;
    v_pct := coalesce(v_pct, 10);
    v_reserve := round(greatest(a.capital, 0) * v_pct / 100);
    if a.balance + new.amount < v_reserve then
      raise exception 'La cuenta del negocio debe conservar la reserva mínima del % %% (%). Disponible para usar: %',
        trim(trailing '.' from to_char(v_pct, 'FM990.99')), public.cop(v_reserve), public.cop(greatest(a.balance - v_reserve, 0)) using errcode = 'P0001';
    end if;
  end if;
  update public.fund_accounts set balance = balance + new.amount where id = a.id returning balance into new.balance_after;
  return new;
end $$;

create table public.cash_transfers (
  id bigint generated always as identity primary key,
  org_id bigint not null references public.organizations(id) on delete cascade,
  number text not null,
  from_lender_id bigint not null references public.users(id) on delete restrict,
  to_lender_id bigint references public.users(id) on delete set null,        -- a quién pidió que se le pase
  delivered_to_id bigint references public.users(id) on delete set null,     -- a quién se le entregó finalmente
  amount numeric(14, 2) not null check (amount > 0),
  note text,
  status text not null default 'pendiente' check (status in ('pendiente', 'entregado', 'rechazado')),
  review_note text,
  reviewed_by bigint references public.users(id) on delete set null,
  reviewed_at timestamptz,
  created_by bigint references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint cash_transfers_org_number_key unique (org_id, number)
);
create index cash_transfers_org_status_idx on public.cash_transfers (org_id, status);

-- Mueve dinero entre dos cuentas con el tipo "traslado".
create or replace function public.fund_move(p_org bigint, p_from bigint, p_to bigint, p_amount numeric, p_ref text, p_note text, p_user bigint) returns void
language plpgsql set search_path = '' as $$
begin
  insert into public.fund_movements (org_id, account_id, type, amount, counterpart_account_id, ref, note, user_id) values (p_org, p_from, 'traslado', -p_amount, p_to, p_ref, p_note, p_user);
  insert into public.fund_movements (org_id, account_id, type, amount, counterpart_account_id, ref, note, user_id) values (p_org, p_to, 'traslado', p_amount, p_from, p_ref, p_note, p_user);
end $$;

-- El prestamista envía el dinero al negocio para que se lo pasen a otro prestamista.
create or replace function public.request_cash_transfer(p jsonb) returns bigint
language plpgsql set search_path = '' as $$
declare
  v_org bigint := (p->>'org_id')::bigint;
  v_from bigint := (p->>'from_lender_id')::bigint;
  v_to bigint := nullif(p->>'to_lender_id', '')::bigint;
  v_amount numeric := round(coalesce((p->>'amount')::numeric, 0));
  v_user bigint := nullif(p->>'user_id', '')::bigint;
  v_num text; v_id bigint; v_name text;
begin
  if v_amount <= 0 then raise exception 'Ingresa el valor a trasladar' using errcode = 'P0001'; end if;
  if v_to = v_from then raise exception 'Elige otro prestamista' using errcode = 'P0001'; end if;
  if v_to is not null and not exists (select 1 from public.users where id = v_to and org_id = v_org and role = 'prestamista' and active) then
    raise exception 'El prestamista de destino no existe o está inactivo' using errcode = 'P0001';
  end if;
  v_num := 'TR-' || lpad(public.next_counter(v_org, 'traslado_caja')::text, 4, '0');
  select trim(name || ' ' || coalesce(last_name, '')) into v_name from public.users where id = v_to;
  perform public.fund_move(v_org, public.fund_lender_account(v_org, v_from), public.fund_business_account(v_org), v_amount, v_num,
    'Traslado ' || v_num || coalesce(' para ' || v_name, '') || ' (pendiente de entrega)', v_user);
  insert into public.cash_transfers (org_id, number, from_lender_id, to_lender_id, amount, note, created_by)
    values (v_org, v_num, v_from, v_to, v_amount, nullif(p->>'note', ''), v_user) returning id into v_id;
  return v_id;
end $$;

-- El administrador entrega el traslado (al prestamista pedido u otro) o lo rechaza (vuelve a quien lo envió).
create or replace function public.resolve_cash_transfer(p jsonb) returns void
language plpgsql set search_path = '' as $$
declare
  v_org bigint := (p->>'org_id')::bigint;
  v_user bigint := nullif(p->>'user_id', '')::bigint;
  v_action text := p->>'action';
  t record; v_to bigint; v_name text;
begin
  select * into t from public.cash_transfers where id = (p->>'id')::bigint and org_id = v_org for update;
  if t.id is null then raise exception 'Traslado no encontrado' using errcode = 'P0001'; end if;
  if t.status <> 'pendiente' then raise exception 'El traslado % ya fue %', t.number, t.status using errcode = 'P0001'; end if;
  if v_action = 'entregar' then
    v_to := coalesce(nullif(p->>'to_lender_id', '')::bigint, t.to_lender_id);
    if v_to is null then raise exception 'Elige el prestamista que recibe el dinero' using errcode = 'P0001'; end if;
    if v_to = t.from_lender_id then raise exception 'El dinero no puede volver a entregarse a quien lo envió. Usa "Rechazar"' using errcode = 'P0001'; end if;
    select trim(name || ' ' || coalesce(last_name, '')) into v_name from public.users where id = v_to and org_id = v_org and role = 'prestamista' and active;
    if v_name is null then raise exception 'El prestamista que recibe no existe o está inactivo' using errcode = 'P0001'; end if;
    perform public.fund_move(v_org, public.fund_business_account(v_org), public.fund_lender_account(v_org, v_to), t.amount, t.number, 'Entrega del traslado ' || t.number || ' a ' || v_name, v_user);
    update public.cash_transfers set status = 'entregado', delivered_to_id = v_to, review_note = nullif(p->>'note', ''), reviewed_by = v_user, reviewed_at = now() where id = t.id;
  elsif v_action = 'rechazar' then
    perform public.fund_move(v_org, public.fund_business_account(v_org), public.fund_lender_account(v_org, t.from_lender_id), t.amount, t.number, 'Traslado ' || t.number || ' rechazado: vuelve a la caja', v_user);
    update public.cash_transfers set status = 'rechazado', review_note = nullif(p->>'note', ''), reviewed_by = v_user, reviewed_at = now() where id = t.id;
  else
    raise exception 'Acción no válida' using errcode = 'P0001';
  end if;
end $$;

-- El cierre de jornada cuenta los traslados como dinero recibido o entregado.
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
    'received', coalesce((select sum(amount) from public.fund_movements where account_id = v_acc and (type = 'asignacion' or (type = 'traslado' and amount > 0)) and (created_at at time zone 'America/Bogota')::date = p_day), 0),
    'delivered', coalesce((select -sum(amount) from public.fund_movements where account_id = v_acc and (type = 'devolucion_asignacion' or (type = 'traslado' and amount < 0)) and (created_at at time zone 'America/Bogota')::date = p_day), 0),
    'visits', (select count(*) from public.visits where org_id = p_org and lender_id = p_lender and visited_on = p_day),
    'balance', coalesce((select balance from public.fund_accounts where id = v_acc), 0)
  ) into r;
  return r;
end $$;

-- ---------- 2) Solicitudes de crédito adicional ----------
alter table public.credits add column approved_by bigint references public.users(id) on delete set null;

create table public.credit_requests (
  id bigint generated always as identity primary key,
  org_id bigint not null references public.organizations(id) on delete cascade,
  number text not null,
  customer_id bigint not null references public.customers(id) on delete cascade,
  lender_id bigint references public.users(id) on delete set null,
  kind text not null,
  principal numeric(14, 2) not null,
  installment_amount numeric(14, 2),
  installments_count int,
  frequency text,
  payload jsonb not null,                     -- lo que llenó el prestamista; se vuelve a calcular al aprobar
  reason text,                                -- por qué el prestamista pide otro crédito
  status text not null default 'pendiente' check (status in ('pendiente', 'aprobada', 'rechazada', 'cancelada')),
  credit_id bigint references public.credits(id) on delete set null,
  review_note text,
  reviewed_by bigint references public.users(id) on delete set null,
  reviewed_at timestamptz,
  requested_by bigint references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint credit_requests_org_number_key unique (org_id, number)
);
create index credit_requests_org_status_idx on public.credit_requests (org_id, status);
create unique index credit_requests_one_pending on public.credit_requests (customer_id) where status = 'pendiente';

-- El prestamista no puede crear un segundo crédito (que no sea renovación) sin una solicitud aprobada.
-- La aprobación pasa la solicitud en "kashup.approved_request" dentro de la misma transacción.
create or replace function public.check_credit_lender() returns trigger
language plpgsql set search_path = '' as $$
declare v_role text; v_other text; v_owner bigint; v_req bigint;
begin
  select role into v_role from public.users where id = new.created_by;
  if v_role = 'prestamista' then
    select lender_id into v_owner from public.customers where id = new.customer_id;
    if v_owner is distinct from new.lender_id then
      select trim(name || ' ' || coalesce(last_name, '')) into v_other from public.users where id = v_owner;
      raise exception 'Este cliente pertenece a la ruta de %. Solo el administrador puede otorgarle un crédito con otro prestamista', coalesce(v_other, 'otro prestamista') using errcode = 'P0001';
    end if;
    select trim(u.name || ' ' || coalesce(u.last_name, '')) into v_other
      from public.credits k join public.users u on u.id = k.lender_id
     where k.customer_id = new.customer_id and k.status = 'activo' and k.lender_id is distinct from new.lender_id limit 1;
    if v_other is not null then
      raise exception 'Este cliente ya tiene créditos con %. Solo el administrador puede otorgarle uno con otro prestamista', v_other using errcode = 'P0001';
    end if;
    if new.renewed_from_id is null and exists (select 1 from public.credits where customer_id = new.customer_id and status = 'activo') then
      v_req := nullif(current_setting('kashup.approved_request', true), '')::bigint;
      if v_req is null or not exists (select 1 from public.credit_requests where id = v_req and customer_id = new.customer_id and status = 'pendiente') then
        raise exception 'Este cliente ya tiene un crédito activo. Envía la solicitud para que el administrador apruebe el nuevo crédito' using errcode = 'P0001';
      end if;
    end if;
  end if;
  return new;
end $$;

-- Aprueba la solicitud: crea el crédito (con los datos recalculados a hoy) y la marca como aprobada.
create or replace function public.approve_credit_request(p_org bigint, p_request bigint, p_user bigint, p_note text, p jsonb) returns bigint
language plpgsql set search_path = '' as $$
declare r record; v_id bigint;
begin
  select * into r from public.credit_requests where id = p_request and org_id = p_org for update;
  if r.id is null then raise exception 'Solicitud no encontrada' using errcode = 'P0001'; end if;
  if r.status <> 'pendiente' then raise exception 'La solicitud % ya fue %', r.number, r.status using errcode = 'P0001'; end if;
  perform set_config('kashup.approved_request', p_request::text, true);
  v_id := public.create_credit(p);
  perform set_config('kashup.approved_request', '', true);
  update public.credits set approved_by = p_user where id = v_id;
  update public.credit_requests set status = 'aprobada', credit_id = v_id, review_note = nullif(p_note, ''), reviewed_by = p_user, reviewed_at = now() where id = r.id;
  return v_id;
end $$;

alter table public.cash_transfers enable row level security;
alter table public.credit_requests enable row level security;
revoke all on public.cash_transfers, public.credit_requests from anon, authenticated;
revoke execute on function public.fund_move(bigint, bigint, bigint, numeric, text, text, bigint), public.request_cash_transfer(jsonb), public.resolve_cash_transfer(jsonb),
  public.approve_credit_request(bigint, bigint, bigint, text, jsonb) from public, anon, authenticated;
