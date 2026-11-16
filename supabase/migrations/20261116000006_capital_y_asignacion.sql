-- KU-009 · Capital del negocio y asignación a cada prestamista (rutero).
-- · Cuenta "negocio": el administrador registra aportes y retiros de capital.
-- · Cuenta por prestamista: el administrador le asigna (o le quita) dinero desde la cuenta del negocio.
-- · Un crédito en efectivo sale de la cuenta del prestamista que cobra (o del negocio si no tiene prestamista).
--   Si no hay saldo, el crédito no se crea. Anular el crédito devuelve el dinero a la misma cuenta.
-- · La cuenta del negocio nunca puede bajar de la reserva mínima: un % del capital aportado (app_settings.min_reserve_pct).

alter table public.app_settings add column min_reserve_pct numeric(5, 2) not null default 10 check (min_reserve_pct >= 0 and min_reserve_pct <= 100);

create table public.fund_accounts (
  id bigint generated always as identity primary key,
  org_id bigint not null references public.organizations(id) on delete cascade,
  kind text not null check (kind in ('negocio', 'prestamista')),
  user_id bigint references public.users(id) on delete restrict,
  balance numeric(16, 2) not null default 0,
  capital numeric(16, 2) not null default 0,   -- solo cuenta negocio: aportes − retiros (base de la reserva)
  created_at timestamptz not null default now(),
  constraint fund_accounts_kind_user check ((kind = 'negocio') = (user_id is null)),
  constraint fund_accounts_balance_check check (balance >= 0)
);
create unique index fund_accounts_org_business_idx on public.fund_accounts (org_id) where kind = 'negocio';
create unique index fund_accounts_user_idx on public.fund_accounts (user_id) where user_id is not null;

create table public.fund_movements (
  id bigint generated always as identity primary key,
  org_id bigint not null references public.organizations(id) on delete cascade,
  account_id bigint not null references public.fund_accounts(id) on delete restrict,
  type text not null check (type in ('aporte', 'retiro', 'asignacion', 'devolucion_asignacion', 'desembolso', 'reverso_desembolso', 'recaudo', 'ajuste')),
  amount numeric(16, 2) not null check (amount <> 0),   -- con signo: positivo entra, negativo sale
  balance_after numeric(16, 2) not null default 0,
  counterpart_account_id bigint references public.fund_accounts(id) on delete set null,
  credit_id bigint references public.credits(id) on delete set null,
  ref text,
  note text,
  user_id bigint references public.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index fund_movements_account_idx on public.fund_movements (account_id, created_at desc);
create index fund_movements_org_idx on public.fund_movements (org_id, created_at desc);

-- Cuenta del negocio (se crea si no existe).
create or replace function public.fund_business_account(p_org bigint) returns bigint
language plpgsql set search_path = '' as $$
declare v bigint;
begin
  select id into v from public.fund_accounts where org_id = p_org and kind = 'negocio';
  if v is null then insert into public.fund_accounts (org_id, kind) values (p_org, 'negocio') returning id into v; end if;
  return v;
end $$;

-- Cuenta de un prestamista (se crea si no existe).
create or replace function public.fund_lender_account(p_org bigint, p_user bigint) returns bigint
language plpgsql set search_path = '' as $$
declare v bigint;
begin
  if not exists (select 1 from public.users where id = p_user and org_id = p_org and role = 'prestamista') then
    raise exception 'El prestamista no existe' using errcode = 'P0001';
  end if;
  select id into v from public.fund_accounts where org_id = p_org and user_id = p_user;
  if v is null then insert into public.fund_accounts (org_id, kind, user_id) values (p_org, 'prestamista', p_user) returning id into v; end if;
  return v;
end $$;

-- Cada movimiento mueve el saldo de su cuenta; si queda negativo, se cancela con un mensaje claro.
-- En la cuenta del negocio además se exige la reserva mínima en todo lo que saca dinero.
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
      raise exception 'Saldo insuficiente en la cuenta del negocio (disponible: %)', to_char(a.balance, 'FM999G999G999G990') using errcode = 'P0001';
    end if;
    select trim(name || ' ' || coalesce(last_name, '')) into v_who from public.users where id = a.user_id;
    raise exception 'Saldo insuficiente de % para prestar (disponible: %)', v_who, to_char(a.balance, 'FM999G999G999G990') using errcode = 'P0001';
  end if;
  if a.kind = 'negocio' and new.amount < 0 then
    select coalesce(min_reserve_pct, 10) into v_pct from public.app_settings where org_id = new.org_id;
    v_reserve := round(greatest(a.capital, 0) * coalesce(v_pct, 10) / 100);
    if a.balance + new.amount < v_reserve then
      raise exception 'La cuenta del negocio debe conservar la reserva mínima del % %% (%). Disponible para usar: %',
        coalesce(v_pct, 10), to_char(v_reserve, 'FM999G999G999G990'), to_char(greatest(a.balance - v_reserve, 0), 'FM999G999G999G990') using errcode = 'P0001';
    end if;
  end if;
  update public.fund_accounts set balance = balance + new.amount where id = a.id returning balance into new.balance_after;
  return new;
end $$;
create trigger fund_movements_apply before insert on public.fund_movements for each row execute function public.apply_fund_movement();

-- Asignar (monto positivo) o quitar (negativo) dinero a un prestamista desde/hacia la cuenta del negocio.
create or replace function public.fund_assign(p_org bigint, p_lender bigint, p_amount numeric, p_user bigint, p_note text) returns text
language plpgsql set search_path = '' as $$
declare v_biz bigint; v_len bigint; v_ref text;
begin
  if coalesce(p_amount, 0) = 0 then raise exception 'El valor debe ser distinto de cero' using errcode = 'P0001'; end if;
  v_biz := public.fund_business_account(p_org);
  v_len := public.fund_lender_account(p_org, p_lender);
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

-- El crédito en efectivo descuenta lo entregado de la cuenta que presta.
create or replace function public.fund_on_credit() returns trigger
language plpgsql set search_path = '' as $$
declare v_acc bigint;
begin
  if new.kind <> 'efectivo' or coalesce(new.disbursed_amount, 0) <= 0 then return new; end if;
  v_acc := case when new.lender_id is null then public.fund_business_account(new.org_id) else public.fund_lender_account(new.org_id, new.lender_id) end;
  insert into public.fund_movements (org_id, account_id, type, amount, credit_id, note, user_id)
    values (new.org_id, v_acc, 'desembolso', -new.disbursed_amount, new.id, 'Desembolso del crédito #' || new.number, new.created_by);
  return new;
end $$;
create trigger credits_fund_disburse after insert on public.credits for each row execute function public.fund_on_credit();

-- Al anular, el dinero desembolsado vuelve a la cuenta de la que salió.
create or replace function public.fund_on_void() returns trigger
language plpgsql set search_path = '' as $$
declare m record;
begin
  if new.status = 'anulado' and old.status <> 'anulado' then
    for m in select account_id, amount from public.fund_movements where credit_id = new.id and type = 'desembolso' loop
      insert into public.fund_movements (org_id, account_id, type, amount, credit_id, note)
        values (new.org_id, m.account_id, 'reverso_desembolso', -m.amount, new.id, 'Anulación del crédito #' || new.number);
    end loop;
  end if;
  return new;
end $$;
create trigger credits_fund_void after update of status on public.credits for each row execute function public.fund_on_void();

-- Seguridad
alter table public.fund_accounts enable row level security;
alter table public.fund_movements enable row level security;
revoke all on public.fund_accounts, public.fund_movements from anon, authenticated;
revoke execute on function public.fund_business_account(bigint), public.fund_lender_account(bigint, bigint), public.apply_fund_movement(),
  public.fund_assign(bigint, bigint, numeric, bigint, text), public.fund_on_credit(), public.fund_on_void() from public, anon, authenticated;

-- Cuentas para los negocios existentes.
insert into public.fund_accounts (org_id, kind) select id, 'negocio' from public.organizations;
