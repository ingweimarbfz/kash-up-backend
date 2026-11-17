-- =====================================================================
-- KU-012 · Recibo de servicios y traslado de ruta
-- · Foto de un recibo de servicios públicos para comprobar la dirección del hogar.
-- · Si el cliente se muda a la zona de otra ruta, se traslada al prestamista de esa ruta:
--   sus créditos activos pasan a ese prestamista y desde ese momento él los cobra.
-- =====================================================================
alter table public.customers add column utility_bill_url text;
alter table public.customers add column utility_bill_at timestamptz;

create table public.customer_transfers (
  id bigint generated always as identity primary key,
  org_id bigint not null references public.organizations(id) on delete cascade,
  customer_id bigint not null references public.customers(id) on delete cascade,
  from_lender_id bigint references public.users(id) on delete set null,
  to_lender_id bigint references public.users(id) on delete set null,
  old_address text,
  new_address text,
  credits_moved integer not null default 0,
  balance_moved numeric(14, 2) not null default 0,
  note text,
  user_id bigint references public.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index customer_transfers_customer_idx on public.customer_transfers (customer_id, created_at desc);

-- Trasladar un cliente a otra ruta (y opcionalmente a su nueva dirección).
create or replace function public.transfer_customer(p jsonb) returns bigint
language plpgsql set search_path = '' as $$
declare
  v_org bigint := (p->>'org_id')::bigint;
  v_to bigint := nullif(p->>'to_lender_id', '')::bigint;
  c record; v_moved int; v_bal numeric; v_id bigint; v_new_addr text;
begin
  select * into c from public.customers where id = (p->>'customer_id')::bigint and org_id = v_org for update;
  if c.id is null then raise exception 'Cliente no encontrado' using errcode = 'P0001'; end if;
  if v_to is not null and not exists (select 1 from public.users where id = v_to and org_id = v_org and role = 'prestamista' and active) then
    raise exception 'El prestamista de destino no existe o está inactivo' using errcode = 'P0001';
  end if;
  v_new_addr := coalesce(nullif(p->>'address', ''), c.address);
  if v_to is not distinct from c.lender_id and v_new_addr = c.address then
    raise exception 'Elige otro prestamista o registra la nueva dirección' using errcode = 'P0001';
  end if;
  select count(*), coalesce(sum(b.balance), 0) into v_moved, v_bal from public.credit_balances b where b.customer_id = c.id and b.status = 'activo';
  if v_to is distinct from c.lender_id then
    update public.credits set lender_id = v_to where customer_id = c.id and status = 'activo';
  else
    v_moved := 0; v_bal := 0;
  end if;
  update public.customers set
    lender_id = v_to,
    route_order = case when v_to is distinct from c.lender_id then null else route_order end,
    address = v_new_addr,
    neighborhood = case when p ? 'neighborhood' then nullif(p->>'neighborhood', '') else neighborhood end,
    city = case when p ? 'city' then nullif(p->>'city', '') else city end,
    lat = case when p ? 'lat' then nullif(p->>'lat', '')::numeric else lat end,
    lng = case when p ? 'lng' then nullif(p->>'lng', '')::numeric else lng end,
    utility_bill_url = coalesce(nullif(p->>'utility_bill_url', ''), utility_bill_url),
    utility_bill_at = case when nullif(p->>'utility_bill_url', '') is not null then now() else utility_bill_at end
  where id = c.id;
  insert into public.customer_transfers (org_id, customer_id, from_lender_id, to_lender_id, old_address, new_address, credits_moved, balance_moved, note, user_id)
    values (v_org, c.id, c.lender_id, v_to, c.address, v_new_addr, v_moved, v_bal, nullif(p->>'note', ''), nullif(p->>'user_id', '')::bigint)
    returning id into v_id;
  return v_id;
end $$;

-- Un solo prestamista por cliente: el prestamista solo presta a los clientes de su ruta
-- y si no tienen créditos activos con otro prestamista. El administrador puede siempre.
create or replace function public.check_credit_lender() returns trigger
language plpgsql set search_path = '' as $$
declare v_role text; v_other text; v_owner bigint;
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
  end if;
  return new;
end $$;

alter table public.customer_transfers enable row level security;
revoke all on public.customer_transfers from anon, authenticated;
revoke execute on function public.transfer_customer(jsonb) from public, anon, authenticated;
