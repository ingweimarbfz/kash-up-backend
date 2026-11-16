-- =====================================================================
-- KU-015 · Vehículos de cobro
-- Hoja de vida de cada vehículo (motos y carros de las rutas), documentos con vencimiento
-- (SOAT, revisión técnico-mecánica, póliza), mantenimientos, tanqueos y kilometraje.
-- En el cobro pueden ir un conductor y el que cobra (prestamista). El combustible y los
-- mantenimientos pagados pueden registrarse también como gasto de la caja.
-- =====================================================================

create table public.vehicles (
  id bigint generated always as identity primary key,
  org_id bigint not null references public.organizations(id) on delete cascade,
  code text not null,                                   -- número interno (móvil)
  plate text not null,
  kind text not null default 'moto' check (kind in ('moto', 'carro', 'camioneta', 'otro')),
  brand text,
  line text,
  model_year int check (model_year between 1950 and 2100),
  color text,
  engine_cc int,
  vin text,                                             -- número de chasis / VIN
  owner_name text,                                      -- propietario según la tarjeta de propiedad
  photo_url text,
  status text not null default 'activo' check (status in ('activo', 'taller', 'inactivo')),
  odometer int not null default 0 check (odometer >= 0),
  collector_id bigint references public.users(id) on delete set null,   -- prestamista que cobra con este vehículo
  driver_name text,                                     -- conductor (si no es el mismo que cobra)
  driver_phone text,
  driver_license text,
  driver_license_expires date,
  soat_expires date,
  soat_number text,
  tecno_expires date,                                   -- revisión técnico-mecánica
  insurance_company text,
  insurance_policy text,
  insurance_expires date,
  oil_change_km int,                                    -- cada cuántos km se cambia el aceite
  notes text,
  created_at timestamptz not null default now(),
  constraint vehicles_org_plate_key unique (org_id, plate),
  constraint vehicles_org_code_key unique (org_id, code)
);
create index vehicles_org_collector_idx on public.vehicles (org_id, collector_id);

create table public.vehicle_maintenances (
  id bigint generated always as identity primary key,
  org_id bigint not null references public.organizations(id) on delete cascade,
  vehicle_id bigint not null references public.vehicles(id) on delete cascade,
  done_on date not null,
  kind text not null default 'preventivo' check (kind in ('preventivo', 'correctivo', 'cambio_aceite', 'llantas', 'frenos', 'otro')),
  description text not null,
  odometer int check (odometer >= 0),
  cost numeric(14, 2) not null default 0 check (cost >= 0),
  workshop text,
  next_date date,
  next_odometer int,
  photo_url text,
  expense_id bigint references public.expenses(id) on delete set null,
  user_id bigint references public.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index vehicle_maintenances_vehicle_idx on public.vehicle_maintenances (vehicle_id, done_on desc);

create table public.vehicle_fuel_logs (
  id bigint generated always as identity primary key,
  org_id bigint not null references public.organizations(id) on delete cascade,
  vehicle_id bigint not null references public.vehicles(id) on delete cascade,
  filled_on date not null,
  odometer int not null check (odometer >= 0),
  gallons numeric(8, 2) check (gallons > 0),
  amount numeric(14, 2) not null check (amount > 0),
  station text,
  full_tank boolean not null default true,
  photo_url text,
  expense_id bigint references public.expenses(id) on delete set null,
  user_id bigint references public.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index vehicle_fuel_vehicle_idx on public.vehicle_fuel_logs (vehicle_id, filled_on desc, odometer desc);

-- Lecturas de kilometraje (también las de tanqueos y mantenimientos) para el historial.
create table public.vehicle_odometer_logs (
  id bigint generated always as identity primary key,
  org_id bigint not null references public.organizations(id) on delete cascade,
  vehicle_id bigint not null references public.vehicles(id) on delete cascade,
  read_on date not null,
  odometer int not null check (odometer >= 0),
  source text not null default 'manual' check (source in ('manual', 'tanqueo', 'mantenimiento')),
  note text,
  user_id bigint references public.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index vehicle_odometer_vehicle_idx on public.vehicle_odometer_logs (vehicle_id, read_on desc);

-- El kilometraje del vehículo es la lectura más alta registrada. No se permite registrar
-- una lectura menor que la actual (salvo el administrador, que puede corregir con una lectura manual).
create or replace function public.vehicle_odometer_bump() returns trigger
language plpgsql set search_path = '' as $$
declare v_now int;
begin
  if new.odometer is null then return new; end if;
  select odometer into v_now from public.vehicles where id = new.vehicle_id for update;
  if tg_table_name = 'vehicle_fuel_logs' and new.odometer < v_now then
    raise exception 'El kilometraje (%) es menor que el actual del vehículo (%)', new.odometer, v_now using errcode = 'P0001';
  end if;
  update public.vehicles set odometer = greatest(odometer, new.odometer) where id = new.vehicle_id;
  if tg_table_name <> 'vehicle_odometer_logs' then
    insert into public.vehicle_odometer_logs (org_id, vehicle_id, read_on, odometer, source, user_id)
      values (new.org_id, new.vehicle_id, coalesce((to_jsonb(new)->>'filled_on')::date, (to_jsonb(new)->>'done_on')::date),
              new.odometer, case when tg_table_name = 'vehicle_fuel_logs' then 'tanqueo' else 'mantenimiento' end, new.user_id);
  end if;
  return new;
end $$;
create trigger vehicle_fuel_odometer after insert on public.vehicle_fuel_logs for each row execute function public.vehicle_odometer_bump();
create trigger vehicle_maint_odometer after insert on public.vehicle_maintenances for each row execute function public.vehicle_odometer_bump();
create trigger vehicle_odo_manual after insert on public.vehicle_odometer_logs for each row when (new.source = 'manual') execute function public.vehicle_odometer_bump();

alter table public.vehicles enable row level security;
alter table public.vehicle_maintenances enable row level security;
alter table public.vehicle_fuel_logs enable row level security;
alter table public.vehicle_odometer_logs enable row level security;
revoke all on public.vehicles, public.vehicle_maintenances, public.vehicle_fuel_logs, public.vehicle_odometer_logs from anon, authenticated;
revoke execute on function public.vehicle_odometer_bump() from public, anon, authenticated;
