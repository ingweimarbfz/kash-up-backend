-- =====================================================================
-- KU-017 · Sedes (cobros por ciudad)
-- · Los prestamistas (ruteros) se asignan a una sede (users.site_id, ya existía).
-- · Cada sede puede trabajar con el capital general del negocio o con un capital aparte:
--   sites.own_capital = true crea una cuenta "negocio" propia de la sede. Las asignaciones,
--   entregas de cierre y traslados de sus prestamistas usan esa cuenta.
-- =====================================================================

alter table public.sites add column own_capital boolean not null default false;

alter table public.fund_accounts add column site_id bigint references public.sites(id) on delete restrict;
alter table public.fund_accounts add constraint fund_accounts_site_kind check (site_id is null or kind = 'negocio');
drop index public.fund_accounts_org_business_idx;
create unique index fund_accounts_org_business_idx on public.fund_accounts (org_id) where kind = 'negocio' and site_id is null;
create unique index fund_accounts_site_business_idx on public.fund_accounts (site_id) where kind = 'negocio' and site_id is not null;

-- Mensajes de saldo con el nombre de la sede cuando la cuenta es de una sede.
create or replace function public.apply_fund_movement() returns trigger
language plpgsql set search_path = '' as $$
declare a record; v_pct numeric; v_reserve numeric; v_who text; v_acc text;
begin
  select * into a from public.fund_accounts where id = new.account_id and org_id = new.org_id for update;
  if a.id is null then raise exception 'Cuenta no encontrada' using errcode = 'P0001'; end if;
  if a.kind = 'negocio' and new.type in ('aporte', 'retiro') then
    update public.fund_accounts set capital = capital + new.amount where id = a.id;
    a.capital := a.capital + new.amount;
  end if;
  v_acc := 'la cuenta del negocio';
  if a.site_id is not null then select 'el capital de la sede ' || name into v_acc from public.sites where id = a.site_id; end if;
  if a.balance + new.amount < 0 then
    if a.kind = 'negocio' then
      raise exception 'Saldo insuficiente en % (disponible: %)', v_acc, public.cop(a.balance) using errcode = 'P0001';
    end if;
    select trim(name || ' ' || coalesce(last_name, '')) into v_who from public.users where id = a.user_id;
    raise exception 'Saldo insuficiente en la caja de % (disponible: %)', v_who, public.cop(a.balance) using errcode = 'P0001';
  end if;
  if a.kind = 'negocio' and new.amount < 0 and new.type <> 'traslado' then
    select coalesce(min_reserve_pct, 10) into v_pct from public.app_settings where org_id = new.org_id;
    v_pct := coalesce(v_pct, 10);
    v_reserve := round(greatest(a.capital, 0) * v_pct / 100);
    if a.balance + new.amount < v_reserve then
      raise exception '% debe conservar la reserva mínima del % %% (%). Disponible para usar: %',
        initcap(left(v_acc, 1)) || substr(v_acc, 2), trim(trailing '.' from to_char(v_pct, 'FM990.99')), public.cop(v_reserve), public.cop(greatest(a.balance - v_reserve, 0)) using errcode = 'P0001';
    end if;
  end if;
  update public.fund_accounts set balance = balance + new.amount where id = a.id returning balance into new.balance_after;
  return new;
end $$;

-- Cuenta general del negocio.
create or replace function public.fund_business_account(p_org bigint) returns bigint
language plpgsql set search_path = '' as $$
declare v bigint;
begin
  select id into v from public.fund_accounts where org_id = p_org and kind = 'negocio' and site_id is null;
  if v is null then insert into public.fund_accounts (org_id, kind) values (p_org, 'negocio') returning id into v; end if;
  return v;
end $$;

-- Cuenta de capital de una sede: la suya si maneja capital aparte; si no, la general.
create or replace function public.fund_site_account(p_org bigint, p_site bigint) returns bigint
language plpgsql set search_path = '' as $$
declare v bigint; v_own boolean;
begin
  select own_capital into v_own from public.sites where id = p_site and org_id = p_org;
  if not coalesce(v_own, false) then return public.fund_business_account(p_org); end if;
  select id into v from public.fund_accounts where org_id = p_org and kind = 'negocio' and site_id = p_site;
  if v is null then insert into public.fund_accounts (org_id, kind, site_id) values (p_org, 'negocio', p_site) returning id into v; end if;
  return v;
end $$;

-- Cuenta de capital que respalda a un prestamista (según su sede).
create or replace function public.fund_business_account_for(p_org bigint, p_lender bigint) returns bigint
language plpgsql set search_path = '' as $$
declare v_site bigint;
begin
  select site_id into v_site from public.users where id = p_lender and org_id = p_org;
  return public.fund_site_account(p_org, v_site);
end $$;

-- Asignar / quitar dinero: con la cuenta de capital de la sede del prestamista.
create or replace function public.fund_assign(p_org bigint, p_lender bigint, p_amount numeric, p_user bigint, p_note text) returns text
language plpgsql set search_path = '' as $$
declare v_biz bigint; v_len bigint; v_ref text;
begin
  if coalesce(p_amount, 0) = 0 then raise exception 'El valor debe ser distinto de cero' using errcode = 'P0001'; end if;
  v_len := public.fund_lender_account(p_org, p_lender);
  v_biz := public.fund_business_account_for(p_org, p_lender);
  v_ref := 'AS-' || lpad(public.next_counter(p_org, 'asignacion')::text, 4, '0');
  if p_amount > 0 then
    insert into public.fund_movements (org_id, account_id, type, amount, counterpart_account_id, ref, note, user_id) values (p_org, v_biz, 'asignacion', -p_amount, v_len, v_ref, p_note, p_user);
    insert into public.fund_movements (org_id, account_id, type, amount, counterpart_account_id, ref, note, user_id) values (p_org, v_len, 'asignacion', p_amount, v_biz, v_ref, p_note, p_user);
  else
    insert into public.fund_movements (org_id, account_id, type, amount, counterpart_account_id, ref, note, user_id) values (p_org, v_len, 'devolucion_asignacion', p_amount, v_biz, v_ref, p_note, p_user);
    insert into public.fund_movements (org_id, account_id, type, amount, counterpart_account_id, ref, note, user_id) values (p_org, v_biz, 'devolucion_asignacion', -p_amount, v_len, v_ref, p_note, p_user);
  end if;
  return v_ref;
end $$;

-- Traslados: el dinero entra a la cuenta de capital de quien lo envía y sale de ahí al entregarlo.
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
  perform public.fund_move(v_org, public.fund_lender_account(v_org, v_from), public.fund_business_account_for(v_org, v_from), v_amount, v_num,
    'Traslado ' || v_num || coalesce(' para ' || v_name, '') || ' (pendiente de entrega)', v_user);
  insert into public.cash_transfers (org_id, number, from_lender_id, to_lender_id, amount, note, created_by)
    values (v_org, v_num, v_from, v_to, v_amount, nullif(p->>'note', ''), v_user) returning id into v_id;
  return v_id;
end $$;

create or replace function public.resolve_cash_transfer(p jsonb) returns void
language plpgsql set search_path = '' as $$
declare
  v_org bigint := (p->>'org_id')::bigint;
  v_user bigint := nullif(p->>'user_id', '')::bigint;
  v_action text := p->>'action';
  t record; v_to bigint; v_name text; v_biz bigint;
begin
  select * into t from public.cash_transfers where id = (p->>'id')::bigint and org_id = v_org for update;
  if t.id is null then raise exception 'Traslado no encontrado' using errcode = 'P0001'; end if;
  if t.status <> 'pendiente' then raise exception 'El traslado % ya fue %', t.number, t.status using errcode = 'P0001'; end if;
  -- El dinero quedó en la cuenta de capital de quien lo envió (según su sede al enviarlo).
  select account_id into v_biz from public.fund_movements where org_id = v_org and ref = t.number and type = 'traslado' and amount > 0 order by id limit 1;
  v_biz := coalesce(v_biz, public.fund_business_account_for(v_org, t.from_lender_id));
  if v_action = 'entregar' then
    v_to := coalesce(nullif(p->>'to_lender_id', '')::bigint, t.to_lender_id);
    if v_to is null then raise exception 'Elige el prestamista que recibe el dinero' using errcode = 'P0001'; end if;
    if v_to = t.from_lender_id then raise exception 'El dinero no puede volver a entregarse a quien lo envió. Usa "Rechazar"' using errcode = 'P0001'; end if;
    select trim(name || ' ' || coalesce(last_name, '')) into v_name from public.users where id = v_to and org_id = v_org and role = 'prestamista' and active;
    if v_name is null then raise exception 'El prestamista que recibe no existe o está inactivo' using errcode = 'P0001'; end if;
    perform public.fund_move(v_org, v_biz, public.fund_lender_account(v_org, v_to), t.amount, t.number, 'Entrega del traslado ' || t.number || ' a ' || v_name, v_user);
    update public.cash_transfers set status = 'entregado', delivered_to_id = v_to, review_note = nullif(p->>'note', ''), reviewed_by = v_user, reviewed_at = now() where id = t.id;
  elsif v_action = 'rechazar' then
    perform public.fund_move(v_org, v_biz, public.fund_lender_account(v_org, t.from_lender_id), t.amount, t.number, 'Traslado ' || t.number || ' rechazado: vuelve a la caja', v_user);
    update public.cash_transfers set status = 'rechazado', review_note = nullif(p->>'note', ''), reviewed_by = v_user, reviewed_at = now() where id = t.id;
  else
    raise exception 'Acción no válida' using errcode = 'P0001';
  end if;
end $$;

revoke execute on function public.fund_site_account(bigint, bigint), public.fund_business_account_for(bigint, bigint) from public, anon, authenticated;

-- Los prestamistas sin sede quedan en la sede principal (la primera de cada negocio).
update public.users u set site_id = s.id
  from (select distinct on (org_id) id, org_id from public.sites order by org_id, id) s
  where u.org_id = s.org_id and u.role = 'prestamista' and u.site_id is null;
