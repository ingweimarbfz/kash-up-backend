-- =====================================================================
-- KU-020 · Galería de productos y promociones
-- · products.gallery: hasta 3 imágenes adicionales (la principal sigue en photo_url).
-- · promotions: descuento por producto con emoji, tag y color (estilo de los descuentos), vigente por
--   rango de fechas y horas, por franja horaria diaria y días de la semana, o por ambas.
--   Alcance: todos los productos, unas categorías o unos productos.
-- · credit_items guarda el precio de lista y la promoción aplicada (queda el histórico aunque cambie).
-- =====================================================================
alter table public.products add column if not exists gallery text[] not null default '{}';
alter table public.products drop constraint if exists products_gallery_max;
alter table public.products add constraint products_gallery_max check (coalesce(array_length(gallery, 1), 0) <= 3);

create table if not exists public.promotions (
  id bigint generated always as identity primary key,
  org_id bigint not null references public.organizations(id) on delete cascade,
  name text not null,
  tag text,
  emoji text,
  color text not null default '#111111',
  description text,
  type text not null check (type in ('porcentaje', 'valor')),
  value numeric(14,2) not null check (value > 0),
  starts_at timestamptz,
  ends_at timestamptz,
  time_from time,
  time_to time,
  weekdays smallint[] not null default '{}',
  scope text not null default 'todos' check (scope in ('todos', 'categorias', 'productos')),
  category_ids bigint[] not null default '{}',
  product_ids bigint[] not null default '{}',
  active boolean not null default true,
  created_by bigint references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (type <> 'porcentaje' or value <= 100),
  check (ends_at is null or starts_at is null or ends_at > starts_at),
  check ((time_from is null) = (time_to is null))
);
create index if not exists promotions_org_idx on public.promotions (org_id, active);

alter table public.credit_items add column if not exists list_price numeric(14,2);
alter table public.credit_items add column if not exists promotion_id bigint references public.promotions(id) on delete set null;
alter table public.credit_items add column if not exists promotion_name text;

-- create_credit guarda también el precio de lista y la promoción de cada producto.
CREATE OR REPLACE FUNCTION public.create_credit(p jsonb)
 RETURNS bigint
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
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
    insert into public.credit_items (org_id, credit_id, product_id, product_name, quantity, unit_price, subtotal, list_price, promotion_id, promotion_name)
    values (v_org, v_id, (r->>'product_id')::bigint, r->>'product_name', (r->>'quantity')::int, (r->>'unit_price')::numeric, (r->>'subtotal')::numeric,
      nullif(r->>'list_price', '')::numeric, nullif(r->>'promotion_id', '')::bigint, nullif(r->>'promotion_name', ''));
    insert into public.inventory_movements (org_id, warehouse_id, product_id, type, quantity, credit_id, note, user_id)
    values (v_org, v_wh, (r->>'product_id')::bigint, 'salida_credito', -(r->>'quantity')::int, v_id, 'Entrega en crédito', nullif(p->>'created_by', '')::bigint);
  end loop;

  for r in select * from jsonb_array_elements(p->'installments') loop
    insert into public.installments (org_id, credit_id, number, due_date, capital, interest, amount)
    values (v_org, v_id, (r->>'number')::int, (r->>'due_date')::date, (r->>'capital')::numeric, (r->>'interest')::numeric, (r->>'amount')::numeric);
  end loop;

  return v_id;
end $function$;

alter table public.promotions enable row level security;
revoke all on public.promotions from anon, authenticated;
revoke execute on function public.create_credit(jsonb) from public, anon, authenticated;
