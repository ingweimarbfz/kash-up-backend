-- =====================================================================
-- KU-032 · Cierre automático de jornada y solicitudes para reabrirla
-- · countries.auto_close_time: hora (local del país) a la que se cierran solas las jornadas
--   que siguen abiertas. Vacía = el país no tiene cierre automático.
-- · app_settings.auto_close_mode: 'pais' (usa la hora del país), 'hora' (hora propia del negocio)
--   o 'desactivado'. app_settings.auto_close_time: la hora propia.
-- · route_closures.automatic: el cierre lo hizo el sistema (sin conteo: lo contado = lo esperado).
-- · route_reopen_requests: el prestamista pide reabrir su jornada con un motivo; solo el
--   administrador la aprueba (se borra el cierre y la jornada queda abierta) o la rechaza.
--   Una jornada reabierta ese día ya no se vuelve a cerrar sola.
-- =====================================================================

alter table public.countries add column if not exists auto_close_time time
  check (auto_close_time is null or auto_close_time between '12:00' and '23:59');

alter table public.app_settings add column if not exists auto_close_mode text not null default 'pais'
  check (auto_close_mode in ('pais', 'hora', 'desactivado'));
alter table public.app_settings add column if not exists auto_close_time time
  check (auto_close_time is null or auto_close_time between '12:00' and '23:59');

alter table public.route_closures add column if not exists automatic boolean not null default false;

create table if not exists public.route_reopen_requests (
  id bigint generated always as identity primary key,
  org_id bigint not null references public.organizations(id) on delete cascade,
  lender_id bigint not null references public.users(id) on delete cascade,
  day date not null,
  closure_id bigint references public.route_closures(id) on delete set null,
  reason text not null check (char_length(reason) between 5 and 300),
  status text not null default 'pendiente' check (status in ('pendiente', 'aprobada', 'rechazada', 'cancelada')),
  resolution text,
  snapshot jsonb,                                  -- el cierre que se anuló al aprobar
  requested_by bigint references public.users(id) on delete set null,
  resolved_by bigint references public.users(id) on delete set null,
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index if not exists route_reopen_requests_pending_key on public.route_reopen_requests (org_id, lender_id, day) where status = 'pendiente';
create index if not exists route_reopen_requests_org_idx on public.route_reopen_requests (org_id, status, created_at desc);
alter table public.route_reopen_requests enable row level security;
revoke all on public.route_reopen_requests from anon, authenticated;

-- Mensaje del bloqueo: ahora el prestamista pide la reapertura desde la app.
create or replace function public.check_day_open() returns trigger
language plpgsql set search_path = '' as $$
declare v_role text; v_day date;
begin
  select role into v_role from public.users where id = new.user_id;
  if v_role is distinct from 'prestamista' or new.lender_id is null then return new; end if;
  v_day := (to_jsonb(new)->>(case when tg_table_name = 'payments' then 'paid_on' else 'spent_on' end))::date;
  if public.day_closed(new.org_id, new.lender_id, v_day) then
    raise exception 'La jornada del % ya está cerrada. Pide al administrador que la reabra desde Cierre de jornada', to_char(v_day, 'DD/MM/YYYY') using errcode = 'P0001';
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------
-- Clientes: el documento por ambas caras es obligatorio; el recibo de servicios pasa a ser opcional.
-- has_id_photos evita leer las imágenes para saber si están (listas y validación del crédito).
-- ---------------------------------------------------------------------
alter table public.customers add column if not exists has_id_photos boolean
  generated always as (coalesce(id_photo_url, '') <> '' and coalesce(id_photo_back_url, '') <> '') stored;
