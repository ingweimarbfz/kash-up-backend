-- =====================================================================
-- KU-026 · Planes, países y monedas
-- · countries: países donde se ofrece KashUp (Panamá y Suramérica, sin Surinam, Guyana ni Guayana Francesa).
-- · plan_features: funcionalidades que un plan puede incluir (cada una habilita módulos del sistema).
-- · plans: límites de sedes, usuarios por rol y clientes, y las funcionalidades incluidas.
-- · plan_prices: precio mensual de cada plan en cada país, en la moneda de ese país.
-- · organizations: país, plan, ciclo de pago y fechas del servicio de cada negocio.
-- · plan_requests: solicitudes de cambio de plan que hace el administrador desde "Mi plan".
-- · users.platform_admin: quién entra a la plataforma de planes (/plataforma).
-- =====================================================================

create table if not exists public.countries (
  code text primary key check (code ~ '^[A-Z]{2}$'),
  name text not null,
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  currency_name text not null,
  locale text not null,
  timezone text not null,
  phone_prefix text not null,
  active boolean not null default true,
  sort_order int not null default 0
);

insert into public.countries (code, name, currency, currency_name, locale, timezone, phone_prefix, sort_order) values
  ('CO', 'Colombia', 'COP', 'Peso colombiano', 'es-CO', 'America/Bogota', '+57', 1),
  ('PA', 'Panamá', 'USD', 'Dólar estadounidense', 'es-PA', 'America/Panama', '+507', 2),
  ('VE', 'Venezuela', 'USD', 'Dólar estadounidense', 'es-VE', 'America/Caracas', '+58', 3),
  ('EC', 'Ecuador', 'USD', 'Dólar estadounidense', 'es-EC', 'America/Guayaquil', '+593', 4),
  ('PE', 'Perú', 'PEN', 'Sol peruano', 'es-PE', 'America/Lima', '+51', 5),
  ('BO', 'Bolivia', 'BOB', 'Boliviano', 'es-BO', 'America/La_Paz', '+591', 6),
  ('BR', 'Brasil', 'BRL', 'Real brasileño', 'pt-BR', 'America/Sao_Paulo', '+55', 7),
  ('PY', 'Paraguay', 'PYG', 'Guaraní', 'es-PY', 'America/Asuncion', '+595', 8),
  ('CL', 'Chile', 'CLP', 'Peso chileno', 'es-CL', 'America/Santiago', '+56', 9),
  ('AR', 'Argentina', 'ARS', 'Peso argentino', 'es-AR', 'America/Argentina/Buenos_Aires', '+54', 10),
  ('UY', 'Uruguay', 'UYU', 'Peso uruguayo', 'es-UY', 'America/Montevideo', '+598', 11)
on conflict (code) do nothing;

create table if not exists public.plan_features (
  key text primary key,
  label text not null,
  grp text not null,
  description text,
  core boolean not null default false,   -- viene en todos los planes
  sort_order int not null default 0
);

insert into public.plan_features (key, label, grp, description, core, sort_order) values
  ('creditos', 'Créditos en efectivo, tasas y simulador', 'cartera', 'Cuotas diarias, semanales, quincenales o mensuales, interés fijo, sobre saldo o anticipado.', true, 1),
  ('pagos', 'Pagos con recibo imprimible', 'cartera', 'Recibo de caja con el saldo al día; abonos a capital y renovaciones.', true, 2),
  ('solicitudes', 'Solicitudes y aprobación de créditos', 'cartera', 'El prestamista pide y el administrador aprueba los créditos adicionales.', false, 3),
  ('productos', 'Créditos de productos con inventario', 'productos', 'Catálogo con fotos, bodegas por sede, existencias y traslados.', false, 10),
  ('promociones', 'Promociones por fechas y horarios', 'productos', 'Black Friday, horas felices y temporadas con su tag y emoji.', false, 11),
  ('rutas', 'Rutas, rutero y visitas', 'cobro', 'Orden de visita del día, cobros en calle y visitas sin pago.', false, 20),
  ('mapa', 'Mapa de clientes y cobros', 'cobro', 'Ubicación de cada cliente y de cada pago registrado.', false, 21),
  ('gastos', 'Gastos y cierre de jornada', 'cobro', 'Gastos con soporte y cuadre del efectivo al final del día.', false, 22),
  ('cajas', 'Capital, cajas y traslados de dinero', 'cobro', 'Capital del negocio, caja de cada prestamista y entregas de efectivo.', false, 23),
  ('vehiculos', 'Vehículos de cobro', 'flota', 'SOAT, tecnomecánica, tanqueos, mantenimientos y kilometraje.', false, 30),
  ('conductores', 'Conductores con acceso a su vehículo', 'flota', 'El conductor consulta los gastos y mantenimientos de su vehículo.', false, 31),
  ('reportes', 'Reportes e informes en PDF', 'control', 'Recaudo, colocación, cartera y resultados listos para imprimir.', false, 40),
  ('bitacora', 'Bitácora del prestamista', 'control', 'Todo lo que movió dinero, con alertas de faltantes y anulaciones.', false, 41),
  ('auditoria', 'Auditoría de acciones', 'control', 'Quién hizo qué y cuándo dentro del sistema.', false, 42),
  ('telegram', 'Avisos por Telegram', 'control', 'Grupos por sede para cobros, créditos, gastos y resúmenes del día.', false, 43),
  ('portal_cliente', 'Portal del cliente', 'clientes', 'El cliente consulta sus créditos, cuotas y pagos con su documento.', false, 50)
on conflict (key) do nothing;

create table if not exists public.plans (
  id bigint generated always as identity primary key,
  code text not null unique,
  name text not null,
  tagline text,
  max_sites int check (max_sites is null or max_sites > 0),
  max_admins int check (max_admins is null or max_admins > 0),
  max_lenders int check (max_lenders is null or max_lenders >= 0),
  max_drivers int check (max_drivers is null or max_drivers >= 0),
  max_client_users int check (max_client_users is null or max_client_users >= 0),
  max_customers int check (max_customers is null or max_customers >= 0),
  support text,
  highlight boolean not null default false,
  badge text,
  bullets text[] not null default '{}',
  features text[] not null default '{}',
  annual_discount numeric(5,2) not null default 16.7 check (annual_discount >= 0 and annual_discount <= 90),
  trial_days int not null default 15 check (trial_days >= 0),
  sort_order int not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.plan_prices (
  plan_id bigint not null references public.plans(id) on delete cascade,
  country_code text not null references public.countries(code),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  price_month numeric(14,2) not null check (price_month >= 0),
  primary key (plan_id, country_code)
);

-- Planes iniciales (null = ilimitado). Los precios se ajustan desde la plataforma.
insert into public.plans (code, name, tagline, max_sites, max_admins, max_lenders, max_drivers, max_client_users, max_customers, support, highlight, badge, bullets, features, sort_order) values
  ('emprendedor', 'Emprendedor', 'Para quien empieza su cartera y cobra en una sola ruta.', 1, 1, 2, 0, 50, 150, 'WhatsApp en horario hábil', false, null,
    array['1 sede y 2 prestamistas', 'Hasta 150 clientes', 'Créditos en efectivo con recibo', 'Rutero, gastos y cierre de jornada'],
    array['creditos', 'pagos', 'rutas', 'gastos', 'portal_cliente'], 1),
  ('profesional', 'Profesional', 'Para el negocio que ya tiene varias rutas, productos y cajas.', 3, 2, 8, 4, 500, 1000, 'WhatsApp y llamada', true, 'Más elegido',
    array['3 sedes y 8 prestamistas', 'Hasta 1.000 clientes', 'Créditos de productos con promociones', 'Capital, cajas, reportes en PDF y avisos por Telegram'],
    array['creditos', 'pagos', 'solicitudes', 'productos', 'promociones', 'rutas', 'mapa', 'gastos', 'cajas', 'vehiculos', 'reportes', 'telegram', 'portal_cliente'], 2),
  ('empresarial', 'Empresarial', 'Para la operación grande, con flota y control total del dinero.', null, 5, 30, 15, null, null, 'Prioritario con acompañamiento', false, null,
    array['Sedes y clientes ilimitados', '30 prestamistas y 15 conductores', 'Flota con conductores y bitácora del prestamista', 'Auditoría y todos los módulos'],
    array['creditos', 'pagos', 'solicitudes', 'productos', 'promociones', 'rutas', 'mapa', 'gastos', 'cajas', 'vehiculos', 'conductores', 'reportes', 'bitacora', 'auditoria', 'telegram', 'portal_cliente'], 3)
on conflict (code) do nothing;

insert into public.plan_prices (plan_id, country_code, currency, price_month)
select p.id, v.country, v.currency, case p.code when 'emprendedor' then v.p1 when 'profesional' then v.p2 else v.p3 end
from public.plans p
cross join (values
  ('CO', 'COP', 89900, 189900, 389900),
  ('PA', 'USD', 24, 49, 99),
  ('VE', 'USD', 19, 39, 79),
  ('EC', 'USD', 24, 49, 99),
  ('PE', 'PEN', 89, 179, 369),
  ('BO', 'BOB', 159, 329, 679),
  ('BR', 'BRL', 119, 249, 519),
  ('PY', 'PYG', 179000, 369000, 759000),
  ('CL', 'CLP', 21900, 44900, 92900),
  ('AR', 'ARS', 24900, 52900, 109900),
  ('UY', 'UYU', 990, 1990, 3990)
) as v(country, currency, p1, p2, p3)
where p.code in ('emprendedor', 'profesional', 'empresarial')
on conflict do nothing;

-- Datos comerciales de cada negocio.
alter table public.organizations drop constraint if exists organizations_status_check;
alter table public.organizations add constraint organizations_status_check check (status in ('activa', 'prueba', 'suspendida', 'cancelada'));
alter table public.organizations add column if not exists country_code text not null default 'CO' references public.countries(code);
alter table public.organizations add column if not exists plan_id bigint references public.plans(id);
alter table public.organizations add column if not exists billing_cycle text not null default 'mensual' check (billing_cycle in ('mensual', 'anual'));
alter table public.organizations add column if not exists start_date date;
alter table public.organizations add column if not exists renewal_date date;
alter table public.organizations add column if not exists contact_name text;
alter table public.organizations add column if not exists extra_features text[] not null default '{}';
alter table public.organizations add column if not exists notes text;
alter table public.organizations add column if not exists updated_at timestamptz not null default now();

-- El negocio de prueba queda en el plan Empresarial (todo habilitado).
update public.organizations set plan_id = (select id from public.plans where code = 'empresarial'), status = 'activa',
  start_date = coalesce(start_date, created_at::date), renewal_date = coalesce(renewal_date, (created_at + interval '1 year')::date)
where id = 1 and plan_id is null;

create table if not exists public.plan_requests (
  id bigint generated always as identity primary key,
  org_id bigint not null references public.organizations(id) on delete cascade,
  from_plan_id bigint references public.plans(id),
  to_plan_id bigint not null references public.plans(id),
  billing_cycle text not null default 'mensual' check (billing_cycle in ('mensual', 'anual')),
  message text,
  contact_phone text,
  requested_by bigint references public.users(id),
  status text not null default 'pendiente' check (status in ('pendiente', 'contactado', 'aplicada', 'rechazada')),
  response text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists plan_requests_org_idx on public.plan_requests (org_id, created_at desc);

alter table public.users add column if not exists platform_admin boolean not null default false;
-- El administrador del negocio de prueba administra la plataforma de planes.
update public.users set platform_admin = true where org_id = 1 and username = 'admin';

alter table public.countries enable row level security;
alter table public.plan_features enable row level security;
alter table public.plans enable row level security;
alter table public.plan_prices enable row level security;
alter table public.plan_requests enable row level security;
