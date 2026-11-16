-- =====================================================================
-- KU-002 · Base multi-cliente de KashUp
-- Cada negocio de préstamos es una organización (org_id). Todas las tablas del negocio llevan org_id.
-- El backend usa la clave secreta (service role); el navegador nunca toca la base directamente,
-- por eso RLS queda activado sin políticas: anon y authenticated no ven nada.
-- =====================================================================

create table public.organizations (
  id bigint generated always as identity primary key,
  name text not null,
  nit text,
  phone text,
  email text,
  address text,
  city text,
  status text not null default 'prueba' check (status in ('activa', 'prueba', 'suspendida')),
  created_at timestamptz not null default now()
);

create table public.users (
  id bigint generated always as identity primary key,
  org_id bigint not null references public.organizations(id) on delete cascade,
  identification text not null,
  name text not null,
  last_name text not null default '',
  username text not null,
  email text,
  phone text,
  role text not null check (role in ('administrador', 'prestamista', 'cliente')),
  password_hash text not null,
  avatar_url text,
  active boolean not null default true,
  last_login_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint users_username_key unique (username),
  constraint users_org_identification_key unique (org_id, identification)
);
create index users_org_role_idx on public.users (org_id, role);

-- Configuración del negocio (una fila por organización).
create table public.app_settings (
  org_id bigint primary key references public.organizations(id) on delete cascade,
  business_name text not null,
  short_name text,
  logo_url text,
  currency text not null default 'COP',
  timezone text not null default 'America/Bogota',
  receipt_footer text,
  updated_at timestamptz not null default now()
);

-- Auditoría: quién hizo qué y cuándo.
create table public.audit_log (
  id bigint generated always as identity primary key,
  org_id bigint not null references public.organizations(id) on delete cascade,
  user_id bigint references public.users(id) on delete set null,
  action text not null,
  entity text not null,
  entity_id text,
  detail jsonb,
  ip text,
  created_at timestamptz not null default now()
);
create index audit_log_org_created_idx on public.audit_log (org_id, created_at desc);
create index audit_log_user_idx on public.audit_log (user_id);

create or replace function public.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin new.updated_at = now(); return new; end $$;
create trigger users_touch before update on public.users for each row execute function public.touch_updated_at();
create trigger app_settings_touch before update on public.app_settings for each row execute function public.touch_updated_at();

alter table public.organizations enable row level security;
alter table public.users enable row level security;
alter table public.app_settings enable row level security;
alter table public.audit_log enable row level security;
revoke all on public.organizations, public.users, public.app_settings, public.audit_log from anon, authenticated;
