-- Tipos de documento según el país del negocio.
-- · customers.doc_type ya no se limita a los tipos de Colombia (CC, CE, TI, PA, PPT, NIT):
--   cada país tiene los suyos (CPF/RG/CNPJ en Brasil, DNI/CE/RUC en Perú, etc.). La lista válida
--   por país vive en el backend (src/lib/docTypes.js); aquí solo se exige un código corto en mayúsculas.
-- · users.doc_type y drivers.doc_type: tipo del documento de usuarios y conductores.
--   Los registros existentes quedan sin tipo (null) y se muestran con el tipo por defecto del país.
-- Los registros existentes no cambian.

alter table public.customers drop constraint if exists customers_doc_type_check;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'customers_doc_type_chk') then
    alter table public.customers add constraint customers_doc_type_chk check (doc_type ~ '^[A-Z]{1,5}$');
  end if;
end $$;

alter table public.users add column if not exists doc_type text check (doc_type is null or doc_type ~ '^[A-Z]{1,5}$');
alter table public.drivers add column if not exists doc_type text check (doc_type is null or doc_type ~ '^[A-Z]{1,5}$');
