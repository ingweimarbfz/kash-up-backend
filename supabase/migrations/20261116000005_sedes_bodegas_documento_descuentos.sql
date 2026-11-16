-- KU-008 · Sedes y bodegas (una bodega principal por negocio y varias por sede), existencias por bodega,
-- traslados entre bodegas, foto del documento por ambas caras y descuentos con ícono y color.

-- ---------- Sedes ----------
create table public.sites (
  id bigint generated always as identity primary key,
  org_id bigint not null references public.organizations(id) on delete cascade,
  name text not null,
  city text,
  address text,
  phone text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  constraint sites_org_name_key unique (org_id, name)
);

-- ---------- Bodegas ----------
create table public.warehouses (
  id bigint generated always as identity primary key,
  org_id bigint not null references public.organizations(id) on delete cascade,
  site_id bigint not null references public.sites(id) on delete restrict,
  name text not null,
  description text,
  responsible text,
  location text,
  is_general boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  constraint warehouses_org_name_key unique (org_id, name)
);
create unique index warehouses_one_general_idx on public.warehouses (org_id) where is_general;
create index warehouses_site_idx on public.warehouses (site_id);

-- Existencias de cada producto en cada bodega. products.stock queda como el total de todas las bodegas.
create table public.warehouse_stock (
  org_id bigint not null references public.organizations(id) on delete cascade,
  warehouse_id bigint not null references public.warehouses(id) on delete restrict,
  product_id bigint not null references public.products(id) on delete restrict,
  stock integer not null default 0 check (stock >= 0),
  primary key (warehouse_id, product_id)
);
create index warehouse_stock_product_idx on public.warehouse_stock (product_id);

-- Usuarios y créditos pueden quedar asociados a una sede / bodega.
alter table public.users add column site_id bigint references public.sites(id) on delete set null;
alter table public.credits add column warehouse_id bigint references public.warehouses(id) on delete set null;

-- Sede y bodega principal para cada negocio existente, y el stock actual pasa a la bodega principal.
insert into public.sites (org_id, name) select id, 'Sede principal' from public.organizations;
insert into public.warehouses (org_id, site_id, name, is_general)
  select s.org_id, s.id, 'Bodega principal', true from public.sites s;
insert into public.warehouse_stock (org_id, warehouse_id, product_id, stock)
  select p.org_id, w.id, p.id, p.stock from public.products p join public.warehouses w on w.org_id = p.org_id and w.is_general where p.stock > 0;
update public.credits c set warehouse_id = w.id from public.warehouses w where w.org_id = c.org_id and w.is_general and c.kind = 'producto';

-- ---------- Movimientos por bodega ----------
alter table public.inventory_movements add column warehouse_id bigint references public.warehouses(id) on delete restrict;
alter table public.inventory_movements add column ref text;   -- número del traslado (TR-0001) que une la salida y la entrada
update public.inventory_movements m set warehouse_id = w.id from public.warehouses w where w.org_id = m.org_id and w.is_general;
alter table public.inventory_movements alter column warehouse_id set not null;
alter table public.inventory_movements drop constraint inventory_movements_type_check;
alter table public.inventory_movements add constraint inventory_movements_type_check
  check (type in ('entrada', 'salida_credito', 'devolucion', 'ajuste', 'baja', 'traslado_salida', 'traslado_entrada'));
create index inventory_movements_warehouse_idx on public.inventory_movements (warehouse_id, created_at desc);

-- Cada movimiento mueve las existencias de su bodega y el total del producto. Si una bodega quedara negativa, se cancela todo.
create or replace function public.apply_inventory_movement() returns trigger
language plpgsql set search_path = '' as $$
declare s integer; n text; w text;
begin
  select name into n from public.products where id = new.product_id and org_id = new.org_id for update;
  if n is null then raise exception 'Producto no encontrado' using errcode = 'P0001'; end if;
  select name into w from public.warehouses where id = new.warehouse_id and org_id = new.org_id;
  if w is null then raise exception 'Bodega no encontrada' using errcode = 'P0001'; end if;
  insert into public.warehouse_stock (org_id, warehouse_id, product_id, stock) values (new.org_id, new.warehouse_id, new.product_id, 0)
    on conflict (warehouse_id, product_id) do nothing;
  select stock into s from public.warehouse_stock where warehouse_id = new.warehouse_id and product_id = new.product_id for update;
  if s + new.quantity < 0 then
    raise exception 'Stock insuficiente de "%" en % (disponible: %)', n, w, s using errcode = 'P0001';
  end if;
  update public.warehouse_stock set stock = stock + new.quantity where warehouse_id = new.warehouse_id and product_id = new.product_id;
  update public.products set stock = stock + new.quantity where id = new.product_id;
  if new.type = 'entrada' and new.unit_cost is not null then
    update public.products set cost = new.unit_cost where id = new.product_id;
  end if;
  return new;
end $$;

-- Traslado entre bodegas: una salida y una entrada por producto, con el mismo número de traslado.
create or replace function public.transfer_stock(p jsonb) returns text
language plpgsql set search_path = '' as $$
declare
  v_org bigint := (p->>'org_id')::bigint;
  v_from bigint := (p->>'from_warehouse_id')::bigint;
  v_to bigint := (p->>'to_warehouse_id')::bigint;
  v_user bigint := nullif(p->>'user_id', '')::bigint;
  v_ref text;
  r jsonb;
begin
  if v_from = v_to then raise exception 'La bodega de origen y la de destino son la misma' using errcode = 'P0001'; end if;
  if not exists (select 1 from public.warehouses where id = v_from and org_id = v_org) then raise exception 'Bodega de origen no encontrada' using errcode = 'P0001'; end if;
  if not exists (select 1 from public.warehouses where id = v_to and org_id = v_org and active) then raise exception 'La bodega de destino no existe o está inactiva' using errcode = 'P0001'; end if;
  v_ref := 'TR-' || lpad(public.next_counter(v_org, 'traslado')::text, 4, '0');
  for r in select * from jsonb_array_elements(p->'items') loop
    if coalesce((r->>'quantity')::int, 0) <= 0 then raise exception 'Cantidad inválida en el traslado' using errcode = 'P0001'; end if;
    insert into public.inventory_movements (org_id, warehouse_id, product_id, type, quantity, ref, note, user_id)
      values (v_org, v_from, (r->>'product_id')::bigint, 'traslado_salida', -(r->>'quantity')::int, v_ref, p->>'note', v_user);
    insert into public.inventory_movements (org_id, warehouse_id, product_id, type, quantity, ref, note, user_id)
      values (v_org, v_to, (r->>'product_id')::bigint, 'traslado_entrada', (r->>'quantity')::int, v_ref, p->>'note', v_user);
  end loop;
  return v_ref;
end $$;

-- El crédito de producto entrega desde una bodega y la anulación devuelve a esa misma bodega.
create or replace function public.create_credit(p jsonb) returns bigint
language plpgsql set search_path = '' as $$
declare
  v_org bigint := (p->>'org_id')::bigint;
  v_wh bigint := nullif(p->>'warehouse_id', '')::bigint;
  v_id bigint;
  r jsonb;
begin
  if jsonb_array_length(coalesce(p->'items', '[]'::jsonb)) > 0 and v_wh is null then
    select id into v_wh from public.warehouses where org_id = v_org and is_general;
  end if;
  insert into public.credits (
    org_id, number, customer_id, lender_id, kind, products_total, discount_id, discount_name, discount_amount, down_payment,
    principal, interest_rate_id, interest_name, interest_method, rate, rate_basis, frequency, interval_days, installments_count,
    skip_sundays, disbursement_date, first_due_date, last_due_date, total_interest, total_amount, installment_amount,
    disbursed_amount, notes, created_by, warehouse_id
  ) values (
    v_org, public.next_counter(v_org, 'credito'), (p->>'customer_id')::bigint, nullif(p->>'lender_id', '')::bigint, p->>'kind',
    coalesce((p->>'products_total')::numeric, 0), nullif(p->>'discount_id', '')::bigint, p->>'discount_name', coalesce((p->>'discount_amount')::numeric, 0),
    coalesce((p->>'down_payment')::numeric, 0), (p->>'principal')::numeric, nullif(p->>'interest_rate_id', '')::bigint, p->>'interest_name',
    p->>'interest_method', (p->>'rate')::numeric, p->>'rate_basis', p->>'frequency', (p->>'interval_days')::int, (p->>'installments_count')::int,
    coalesce((p->>'skip_sundays')::boolean, false), (p->>'disbursement_date')::date, (p->>'first_due_date')::date, (p->>'last_due_date')::date,
    (p->>'total_interest')::numeric, (p->>'total_amount')::numeric, (p->>'installment_amount')::numeric, (p->>'disbursed_amount')::numeric,
    p->>'notes', nullif(p->>'created_by', '')::bigint, v_wh
  ) returning id into v_id;

  for r in select * from jsonb_array_elements(coalesce(p->'references', '[]'::jsonb)) loop
    insert into public.credit_references (org_id, credit_id, name, phone, relationship, address)
    values (v_org, v_id, r->>'name', r->>'phone', r->>'relationship', r->>'address');
  end loop;

  for r in select * from jsonb_array_elements(coalesce(p->'items', '[]'::jsonb)) loop
    insert into public.credit_items (org_id, credit_id, product_id, product_name, quantity, unit_price, subtotal)
    values (v_org, v_id, (r->>'product_id')::bigint, r->>'product_name', (r->>'quantity')::int, (r->>'unit_price')::numeric, (r->>'subtotal')::numeric);
    insert into public.inventory_movements (org_id, warehouse_id, product_id, type, quantity, credit_id, note, user_id)
    values (v_org, v_wh, (r->>'product_id')::bigint, 'salida_credito', -(r->>'quantity')::int, v_id, 'Entrega en crédito', nullif(p->>'created_by', '')::bigint);
  end loop;

  for r in select * from jsonb_array_elements(p->'installments') loop
    insert into public.installments (org_id, credit_id, number, due_date, capital, interest, amount)
    values (v_org, v_id, (r->>'number')::int, (r->>'due_date')::date, (r->>'capital')::numeric, (r->>'interest')::numeric, (r->>'amount')::numeric);
  end loop;

  return v_id;
end $$;

create or replace function public.void_credit(p_org bigint, p_credit bigint, p_reason text, p_user bigint) returns void
language plpgsql set search_path = '' as $$
declare r record; v_wh bigint;
begin
  if exists (select 1 from public.installments where credit_id = p_credit and paid_amount > 0) then
    raise exception 'El crédito ya tiene pagos; no se puede anular' using errcode = 'P0001';
  end if;
  update public.credits set status = 'anulado', void_reason = p_reason where id = p_credit and org_id = p_org and status = 'activo'
    returning warehouse_id into v_wh;
  if not found then raise exception 'Crédito no encontrado o no está activo' using errcode = 'P0001'; end if;
  if v_wh is null then select id into v_wh from public.warehouses where org_id = p_org and is_general; end if;
  update public.installments set status = 'anulada' where credit_id = p_credit;
  for r in select product_id, quantity from public.credit_items where credit_id = p_credit loop
    insert into public.inventory_movements (org_id, warehouse_id, product_id, type, quantity, credit_id, note, user_id)
    values (p_org, v_wh, r.product_id, 'devolucion', r.quantity, p_credit, 'Anulación del crédito', p_user);
  end loop;
end $$;

-- ---------- Foto del documento por ambas caras ----------
comment on column public.customers.id_photo_url is 'Foto del documento, cara delantera';
alter table public.customers add column id_photo_back_url text;

-- ---------- Categoría obligatoria en productos ----------
insert into public.product_categories (org_id, name)
  select distinct p.org_id, 'General' from public.products p where p.category_id is null
  on conflict (org_id, name) do nothing;
update public.products p set category_id = c.id from public.product_categories c
  where p.category_id is null and c.org_id = p.org_id and c.name = 'General';
alter table public.products drop constraint products_category_id_fkey;
alter table public.products add constraint products_category_id_fkey foreign key (category_id) references public.product_categories(id) on delete restrict;
alter table public.products alter column category_id set not null;
alter table public.product_categories add column description text;

-- ---------- Descuentos con ícono y color ----------
alter table public.discounts add column icon text not null default 'tag';
alter table public.discounts add column color text not null default '#10B981' check (color ~ '^#[0-9A-Fa-f]{6}$');
alter table public.discounts add column description text;

-- ---------- Seguridad ----------
do $$
declare t text;
begin
  foreach t in array array['sites', 'warehouses', 'warehouse_stock'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;
revoke execute on function public.transfer_stock(jsonb), public.create_credit(jsonb), public.void_credit(bigint, bigint, text, bigint), public.apply_inventory_movement() from public, anon, authenticated;

-- Al crear un negocio nuevo se le crean su sede y su bodega principal.
create or replace function public.org_defaults() returns trigger
language plpgsql set search_path = '' as $$
declare v_site bigint;
begin
  insert into public.sites (org_id, name) values (new.id, 'Sede principal') returning id into v_site;
  insert into public.warehouses (org_id, site_id, name, is_general) values (new.id, v_site, 'Bodega principal', true);
  return new;
end $$;
create trigger organizations_defaults after insert on public.organizations for each row execute function public.org_defaults();
revoke execute on function public.org_defaults() from public, anon, authenticated;
