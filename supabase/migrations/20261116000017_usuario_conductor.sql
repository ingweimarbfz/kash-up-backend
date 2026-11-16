-- =====================================================================
-- KU-021 · Usuario de conductor
-- · Nuevo rol "conductor": entra a la app y solo ve el reporte de su vehículo (tanqueos, gastos y mantenimientos).
-- · drivers.user_id enlaza el conductor con su usuario. Si el conductor también es prestamista, se enlaza
--   a ese usuario y no se crea otro: ve el vehículo en "Mi vehículo".
-- =====================================================================
alter table public.users drop constraint if exists users_role_check;
alter table public.users add constraint users_role_check check (role in ('administrador', 'prestamista', 'cliente', 'conductor'));

alter table public.drivers add column if not exists user_id bigint references public.users(id) on delete set null;
create unique index if not exists drivers_user_idx on public.drivers (user_id) where user_id is not null;
