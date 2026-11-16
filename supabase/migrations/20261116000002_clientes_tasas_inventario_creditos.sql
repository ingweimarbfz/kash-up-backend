-- =====================================================================
-- Etapa 2 · Clientes, tasas de interés, inventario, descuentos y créditos
-- KU-004 clientes · KU-005 tasas · KU-006 inventario y descuentos · KU-007 créditos y cuotas
-- =====================================================================

-- Consecutivos por organización (número de crédito, etc.).
create table public.org_counters (
  org_id bigint not null references public.organizations(id) on delete cascade,
  key text not null,
  value bigint not null default 0,
  primary key (org_id, key)
);
create or replace function public.next_counter(p_org bigint, p_key text) returns bigint
language plpgsql set search_path = '' as $$
declare v bigint;
begin
  insert into public.org_counters (org_id, key, value) values (p_org, p_key, 1)
  on conflict (org_id, key) do update set value = public.org_counters.value + 1
  returning value into v;
  return v;
end $$;

-- ---------- KU-004 · Clientes ----------
create table public.customers (
  id bigint generated always as identity primary key,
  org_id bigint not null references public.organizations(id) on delete cascade,
  doc_type text not null default 'CC' check (doc_type in ('CC', 'CE', 'TI', 'PA', 'PPT', 'NIT')),
  identification text not null,
  name text not null,
  last_name text not null default '',
  phone text,
  phone2 text,
  email text,
  address text,
  neighborhood text,
  city text,
  occupation text,
  business_address text,
  birth_date date,
  photo_url text not null,          -- foto de la persona (obligatoria)
  photo_thumb text,                 -- miniatura para listas
  id_photo_url text,                -- foto del documento (opcional)
  lat numeric(9, 6),
  lng numeric(9, 6),
  lender_id bigint references public.users(id) on delete set null,   -- prestamista asignado
  user_id bigint references public.users(id) on delete set null,     -- usuario con rol cliente
  credit_limit numeric(14, 2),
  status text not null default 'activo' check (status in ('activo', 'bloqueado', 'inactivo')),
  notes text,
  created_by bigint references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint customers_org_ident_key unique (org_id, identification),
  constraint customers_user_key unique (user_id)
);
create index customers_org_lender_idx on public.customers (org_id, lender_id);
create index customers_org_name_idx on public.customers (org_id, name, last_name);
create trigger customers_touch before update on public.customers for each row execute function public.touch_updated_at();

-- ---------- KU-005 · Tasas de interés ----------
-- method: fija (interés plano sobre el capital inicial), sobre_saldo (cuota fija, interés sobre saldo: sistema francés),
--         anticipada (el interés se descuenta al desembolsar y las cuotas solo pagan capital).
-- rate_basis: mensual (la tasa es por mes de plazo) o total (la tasa es por todo el crédito).
create table public.interest_rates (
  id bigint generated always as identity primary key,
  org_id bigint not null references public.organizations(id) on delete cascade,
  name text not null,
  method text not null check (method in ('fija', 'sobre_saldo', 'anticipada')),
  rate numeric(7, 4) not null check (rate >= 0 and rate <= 100),
  rate_basis text not null default 'mensual' check (rate_basis in ('mensual', 'total')),
  default_frequency text check (default_frequency in ('diaria', 'semanal', 'quincenal', 'mensual', 'personalizada')),
  notes text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  constraint interest_rates_org_name_key unique (org_id, name)
);

-- ---------- KU-006 · Inventario y descuentos ----------
create table public.product_categories (
  id bigint generated always as identity primary key,
  org_id bigint not null references public.organizations(id) on delete cascade,
  name text not null,
  active boolean not null default true,
  constraint product_categories_org_name_key unique (org_id, name)
);

create table public.products (
  id bigint generated always as identity primary key,
  org_id bigint not null references public.organizations(id) on delete cascade,
  sku text,
  name text not null,
  category_id bigint references public.product_categories(id) on delete set null,
  brand text,
  description text,
  cost numeric(14, 2) not null default 0 check (cost >= 0),
  price numeric(14, 2) not null default 0 check (price >= 0),
  stock integer not null default 0 check (stock >= 0),
  min_stock integer not null default 0 check (min_stock >= 0),
  photo_url text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint products_org_sku_key unique (org_id, sku)
);
create index products_org_name_idx on public.products (org_id, name);
create trigger products_touch before update on public.products for each row execute function public.touch_updated_at();

-- Movimientos: entrada (compra), salida_credito (entrega en un crédito), devolucion, ajuste (+/-) y baja.
create table public.inventory_movements (
  id bigint generated always as identity primary key,
  org_id bigint not null references public.organizations(id) on delete cascade,
  product_id bigint not null references public.products(id) on delete restrict,
  type text not null check (type in ('entrada', 'salida_credito', 'devolucion', 'ajuste', 'baja')),
  quantity integer not null check (quantity <> 0),  -- con signo: positivo entra, negativo sale
  unit_cost numeric(14, 2),
  credit_id bigint,
  note text,
  user_id bigint references public.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index inventory_movements_product_idx on public.inventory_movements (product_id, created_at desc);
create index inventory_movements_org_idx on public.inventory_movements (org_id, created_at desc);

-- El stock del producto se mueve con cada movimiento; si quedara negativo, la operación completa se cancela.
create or replace function public.apply_inventory_movement() returns trigger
language plpgsql set search_path = '' as $$
declare s integer; n text;
begin
  update public.products set stock = stock + new.quantity
   where id = new.product_id and org_id = new.org_id
   returning stock, name into s, n;
  if s is null then raise exception 'Producto no encontrado'; end if;
  if s < 0 then raise exception 'Stock insuficiente de "%"', n using errcode = 'P0001'; end if;
  if new.type = 'entrada' and new.unit_cost is not null then
    update public.products set cost = new.unit_cost where id = new.product_id;
  end if;
  return new;
end $$;
create trigger inventory_movements_apply after insert on public.inventory_movements for each row execute function public.apply_inventory_movement();

create table public.discounts (
  id bigint generated always as identity primary key,
  org_id bigint not null references public.organizations(id) on delete cascade,
  name text not null,
  type text not null check (type in ('porcentaje', 'valor')),
  value numeric(14, 2) not null check (value >= 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  constraint discounts_org_name_key unique (org_id, name),
  constraint discounts_pct_check check (type <> 'porcentaje' or value <= 100)
);

-- ---------- KU-007 · Créditos ----------
create table public.credits (
  id bigint generated always as identity primary key,
  org_id bigint not null references public.organizations(id) on delete cascade,
  number bigint not null,
  customer_id bigint not null references public.customers(id) on delete restrict,
  lender_id bigint references public.users(id) on delete set null,
  kind text not null check (kind in ('efectivo', 'producto')),
  -- Productos (crédito de producto)
  products_total numeric(14, 2) not null default 0,
  discount_id bigint references public.discounts(id) on delete set null,
  discount_name text,
  discount_amount numeric(14, 2) not null default 0,
  down_payment numeric(14, 2) not null default 0,
  -- Condiciones
  principal numeric(14, 2) not null check (principal > 0),       -- capital financiado
  interest_rate_id bigint references public.interest_rates(id) on delete set null,
  interest_name text,
  interest_method text not null check (interest_method in ('fija', 'sobre_saldo', 'anticipada')),
  rate numeric(7, 4) not null,
  rate_basis text not null check (rate_basis in ('mensual', 'total')),
  frequency text not null check (frequency in ('diaria', 'semanal', 'quincenal', 'mensual', 'personalizada')),
  interval_days integer not null check (interval_days between 1 and 365),
  installments_count integer not null check (installments_count between 1 and 720),
  skip_sundays boolean not null default false,
  disbursement_date date not null,
  first_due_date date not null,
  last_due_date date not null,
  total_interest numeric(14, 2) not null,
  total_amount numeric(14, 2) not null,        -- lo que paga el cliente en cuotas
  installment_amount numeric(14, 2) not null,  -- cuota de referencia
  disbursed_amount numeric(14, 2) not null,    -- efectivo entregado (anticipada: capital - interés)
  status text not null default 'activo' check (status in ('activo', 'pagado', 'anulado', 'castigado')),
  notes text,
  void_reason text,
  created_by bigint references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint credits_org_number_key unique (org_id, number)
);
create index credits_org_customer_idx on public.credits (org_id, customer_id);
create index credits_org_lender_status_idx on public.credits (org_id, lender_id, status);
create trigger credits_touch before update on public.credits for each row execute function public.touch_updated_at();

create table public.credit_items (
  id bigint generated always as identity primary key,
  org_id bigint not null references public.organizations(id) on delete cascade,
  credit_id bigint not null references public.credits(id) on delete cascade,
  product_id bigint not null references public.products(id) on delete restrict,
  product_name text not null,
  quantity integer not null check (quantity > 0),
  unit_price numeric(14, 2) not null check (unit_price >= 0),
  subtotal numeric(14, 2) not null
);
create index credit_items_credit_idx on public.credit_items (credit_id);

create table public.credit_references (
  id bigint generated always as identity primary key,
  org_id bigint not null references public.organizations(id) on delete cascade,
  credit_id bigint not null references public.credits(id) on delete cascade,
  name text not null,
  phone text not null,
  relationship text,
  address text
);
create index credit_references_credit_idx on public.credit_references (credit_id);

create table public.installments (
  id bigint generated always as identity primary key,
  org_id bigint not null references public.organizations(id) on delete cascade,
  credit_id bigint not null references public.credits(id) on delete cascade,
  number integer not null,
  due_date date not null,
  capital numeric(14, 2) not null,
  interest numeric(14, 2) not null,
  amount numeric(14, 2) not null,
  paid_amount numeric(14, 2) not null default 0,
  paid_at timestamptz,
  status text not null default 'pendiente' check (status in ('pendiente', 'parcial', 'pagada', 'anulada')),
  constraint installments_credit_number_key unique (credit_id, number)
);
create index installments_org_due_idx on public.installments (org_id, due_date) where status in ('pendiente', 'parcial');

alter table public.inventory_movements add constraint inventory_movements_credit_fk foreign key (credit_id) references public.credits(id) on delete set null;

-- Crea el crédito completo en una sola transacción: número, referencias, productos (con salida de inventario) y cuotas.
-- El plan de cuotas lo calcula el backend (src/lib/schedule.js) y llega ya armado en p->'installments'.
create or replace function public.create_credit(p jsonb) returns bigint
language plpgsql set search_path = '' as $$
declare
  v_org bigint := (p->>'org_id')::bigint;
  v_id bigint;
  r jsonb;
begin
  insert into public.credits (
    org_id, number, customer_id, lender_id, kind, products_total, discount_id, discount_name, discount_amount, down_payment,
    principal, interest_rate_id, interest_name, interest_method, rate, rate_basis, frequency, interval_days, installments_count,
    skip_sundays, disbursement_date, first_due_date, last_due_date, total_interest, total_amount, installment_amount,
    disbursed_amount, notes, created_by
  ) values (
    v_org, public.next_counter(v_org, 'credito'), (p->>'customer_id')::bigint, nullif(p->>'lender_id', '')::bigint, p->>'kind',
    coalesce((p->>'products_total')::numeric, 0), nullif(p->>'discount_id', '')::bigint, p->>'discount_name', coalesce((p->>'discount_amount')::numeric, 0),
    coalesce((p->>'down_payment')::numeric, 0), (p->>'principal')::numeric, nullif(p->>'interest_rate_id', '')::bigint, p->>'interest_name',
    p->>'interest_method', (p->>'rate')::numeric, p->>'rate_basis', p->>'frequency', (p->>'interval_days')::int, (p->>'installments_count')::int,
    coalesce((p->>'skip_sundays')::boolean, false), (p->>'disbursement_date')::date, (p->>'first_due_date')::date, (p->>'last_due_date')::date,
    (p->>'total_interest')::numeric, (p->>'total_amount')::numeric, (p->>'installment_amount')::numeric, (p->>'disbursed_amount')::numeric,
    p->>'notes', nullif(p->>'created_by', '')::bigint
  ) returning id into v_id;

  for r in select * from jsonb_array_elements(coalesce(p->'references', '[]'::jsonb)) loop
    insert into public.credit_references (org_id, credit_id, name, phone, relationship, address)
    values (v_org, v_id, r->>'name', r->>'phone', r->>'relationship', r->>'address');
  end loop;

  for r in select * from jsonb_array_elements(coalesce(p->'items', '[]'::jsonb)) loop
    insert into public.credit_items (org_id, credit_id, product_id, product_name, quantity, unit_price, subtotal)
    values (v_org, v_id, (r->>'product_id')::bigint, r->>'product_name', (r->>'quantity')::int, (r->>'unit_price')::numeric, (r->>'subtotal')::numeric);
    insert into public.inventory_movements (org_id, product_id, type, quantity, credit_id, note, user_id)
    values (v_org, (r->>'product_id')::bigint, 'salida_credito', -(r->>'quantity')::int, v_id, 'Entrega en crédito', nullif(p->>'created_by', '')::bigint);
  end loop;

  for r in select * from jsonb_array_elements(p->'installments') loop
    insert into public.installments (org_id, credit_id, number, due_date, capital, interest, amount)
    values (v_org, v_id, (r->>'number')::int, (r->>'due_date')::date, (r->>'capital')::numeric, (r->>'interest')::numeric, (r->>'amount')::numeric);
  end loop;

  return v_id;
end $$;

-- Anula un crédito sin pagos: devuelve los productos al inventario.
create or replace function public.void_credit(p_org bigint, p_credit bigint, p_reason text, p_user bigint) returns void
language plpgsql set search_path = '' as $$
declare r record;
begin
  if exists (select 1 from public.installments where credit_id = p_credit and paid_amount > 0) then
    raise exception 'El crédito ya tiene pagos; no se puede anular' using errcode = 'P0001';
  end if;
  update public.credits set status = 'anulado', void_reason = p_reason where id = p_credit and org_id = p_org and status = 'activo';
  if not found then raise exception 'Crédito no encontrado o no está activo' using errcode = 'P0001'; end if;
  update public.installments set status = 'anulada' where credit_id = p_credit;
  for r in select product_id, quantity from public.credit_items where credit_id = p_credit loop
    insert into public.inventory_movements (org_id, product_id, type, quantity, credit_id, note, user_id)
    values (p_org, r.product_id, 'devolucion', r.quantity, p_credit, 'Anulación del crédito', p_user);
  end loop;
end $$;

-- Seguridad: solo el backend (service role) usa estas tablas y funciones.
do $$
declare t text;
begin
  foreach t in array array['org_counters', 'customers', 'interest_rates', 'product_categories', 'products', 'inventory_movements', 'discounts', 'credits', 'credit_items', 'credit_references', 'installments'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;
revoke execute on function public.next_counter(bigint, text), public.create_credit(jsonb), public.void_credit(bigint, bigint, text, bigint), public.apply_inventory_movement(), public.touch_updated_at() from public, anon, authenticated;
