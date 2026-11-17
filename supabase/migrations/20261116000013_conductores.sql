-- =====================================================================
-- KU-016
-- Conductores registrados con su licencia: el vehículo elige el conductor de una lista
-- y su celular y licencia salen del registro.
-- =====================================================================

create table public.drivers (
  id bigint generated always as identity primary key,
  org_id bigint not null references public.organizations(id) on delete cascade,
  name text not null,
  last_name text,
  identification text not null,
  phone text not null,
  address text,
  license_number text not null,
  license_category text not null check (license_category in ('A1', 'A2', 'B1', 'B2', 'B3', 'C1', 'C2', 'C3')),
  license_expires date not null,
  license_photo_url text,
  photo_url text,
  active boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  constraint drivers_org_identification_key unique (org_id, identification)
);

alter table public.vehicles add column driver_id bigint references public.drivers(id) on delete set null;
alter table public.vehicles drop column driver_name, drop column driver_phone, drop column driver_license, drop column driver_license_expires;

alter table public.drivers enable row level security;
revoke all on public.drivers from anon, authenticated;
