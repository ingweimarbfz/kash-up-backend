-- KU-024: foto de la persona y del documento (frente y reverso) para usuarios y conductores.
-- users.avatar_url sigue siendo la miniatura que se ve en listas; photo_url es la foto completa.
alter table public.users add column if not exists photo_url text;
alter table public.users add column if not exists id_photo_url text;
alter table public.users add column if not exists id_photo_back_url text;
alter table public.drivers add column if not exists id_photo_url text;
alter table public.drivers add column if not exists id_photo_back_url text;
