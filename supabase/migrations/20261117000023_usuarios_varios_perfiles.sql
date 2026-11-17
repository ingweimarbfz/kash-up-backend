-- KU-031: un mismo usuario puede entrar con varios perfiles (administrador, prestamista, conductor).
-- · users.role sigue siendo el perfil principal (precedencia: administrador > prestamista > conductor).
-- · users.extra_roles: perfiles adicionales del mismo usuario. Solo prestamista y conductor.
-- · users.is_lender: verdadero si el usuario cobra (principal o adicional). Las listas y validaciones
--   de prestamistas usan esta columna en lugar de role = 'prestamista'.
-- · El perfil de conductor se enlaza con su ficha en drivers (drivers.user_id), como hasta ahora.

alter table public.users add column if not exists extra_roles text[] not null default '{}';

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'users_extra_roles_chk') then
    alter table public.users add constraint users_extra_roles_chk
      check (extra_roles <@ array['prestamista', 'conductor']::text[] and not (role = any(extra_roles)));
  end if;
end $$;

alter table public.users add column if not exists is_lender boolean
  generated always as (role = 'prestamista' or 'prestamista' = any(extra_roles)) stored;

create index if not exists users_is_lender_idx on public.users (org_id) where is_lender;

-- Funciones que validan que el destino sea un prestamista: aceptan también a quien cobra como perfil adicional.
do $$
declare r record;
begin
  for r in
    select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f' and pg_get_functiondef(p.oid) like '%and role = ''prestamista''%'
  loop
    execute replace(pg_get_functiondef(r.oid), 'and role = ''prestamista''', 'and is_lender');
  end loop;
end $$;

-- Prestamistas o administradores que ya estaban enlazados a una ficha de conductor: ahora tienen el perfil de conductor.
update public.users u set extra_roles = array_append(u.extra_roles, 'conductor')
where u.role in ('administrador', 'prestamista') and not ('conductor' = any(u.extra_roles))
  and exists (select 1 from public.drivers d where d.user_id = u.id);
