-- =====================================================================
-- KU-018 · Etapa 6: notificaciones por Telegram (modelo de integra-ips)
-- · Cada negocio configura su bot (token de @BotFather) y uno o más grupos por sección.
-- · Cada grupo pertenece a una sede (solo recibe los avisos de esa sede) o a todas (sin sede).
-- · Resumen de la mañana (agenda de cobro) y del cierre del día a la hora configurada.
-- =====================================================================
create table public.notification_settings (
  org_id bigint primary key references public.organizations(id) on delete cascade,
  bot_token text,
  bot_username text,
  bot_name text,
  enabled boolean not null default false,
  morning_hour int not null default 7 check (morning_hour between 0 and 23),
  evening_hour int not null default 19 check (evening_hour between 0 and 23),
  morning_enabled boolean not null default true,
  evening_enabled boolean not null default true,
  last_morning_on date,
  last_evening_on date,
  updated_at timestamptz not null default now()
);

create table public.notification_channels (
  id bigint generated always as identity primary key,
  org_id bigint not null references public.organizations(id) on delete cascade,
  section text not null check (section in ('cobros', 'creditos', 'caja', 'gastos', 'clientes', 'vehiculos', 'resumen')),
  site_id bigint references public.sites(id) on delete cascade,
  chat_id text not null,
  title text,
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);
create unique index notification_channels_unique_idx on public.notification_channels (org_id, section, coalesce(site_id, 0), chat_id);

create table public.notification_log (
  id bigint generated always as identity primary key,
  org_id bigint not null references public.organizations(id) on delete cascade,
  section text not null,
  site_id bigint,
  chat_id text,
  status text not null check (status in ('enviado', 'error')),
  detail text,
  created_at timestamptz not null default now()
);
create index notification_log_org_idx on public.notification_log (org_id, created_at desc);

alter table public.notification_settings enable row level security;
alter table public.notification_channels enable row level security;
alter table public.notification_log enable row level security;
revoke all on public.notification_settings, public.notification_channels, public.notification_log from anon, authenticated;
