-- KU-029 · Cambio de marca KashUp → QuontUp360.
-- 1) La variable de transacción con la que la aprobación de solicitudes habilita el crédito pasa de
--    "kashup.approved_request" a "quontup360.approved_request". Se reescriben las dos funciones que la usan
--    (check_credit_lender la lee y approve_credit_request la escribe) en la misma migración, así nunca quedan desalineadas.
-- 2) El negocio de demostración pasa de "KashUp Demo" a "QuontUp360 Demo".
do $$
declare f record;
begin
  for f in
    select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname in ('check_credit_lender', 'approve_credit_request')
       and p.prosrc like '%kashup.approved_request%'
  loop
    execute replace(pg_get_functiondef(f.oid), 'kashup.approved_request', 'quontup360.approved_request');
  end loop;
end $$;

update public.organizations set name = replace(name, 'KashUp', 'QuontUp360') where name like 'KashUp%';
update public.app_settings set business_name = replace(business_name, 'KashUp', 'QuontUp360') where business_name like 'KashUp%';
