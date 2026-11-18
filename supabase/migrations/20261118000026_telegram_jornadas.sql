-- =====================================================================
-- KU-033 · Telegram: sección propia para cierres y reaperturas de jornada
-- · Nueva sección 'jornadas': cierres (manuales y automáticos), solicitudes para reabrir,
--   aprobaciones (reaperturas) y rechazos.
-- · Los grupos que hoy reciben "Capital y cajas" se copian a 'jornadas' para que sigan
--   recibiendo los cierres como hasta ahora (se pueden quitar desde Notificaciones).
-- =====================================================================
alter table public.notification_channels drop constraint if exists notification_channels_section_check;
alter table public.notification_channels add constraint notification_channels_section_check
  check (section in ('cobros', 'creditos', 'caja', 'jornadas', 'gastos', 'clientes', 'vehiculos', 'resumen'));

insert into public.notification_channels (org_id, section, site_id, chat_id, title, enabled)
select org_id, 'jornadas', site_id, chat_id, title, enabled
from public.notification_channels c
where section = 'caja'
  and not exists (
    select 1 from public.notification_channels j
    where j.org_id = c.org_id and j.section = 'jornadas' and coalesce(j.site_id, 0) = coalesce(c.site_id, 0) and j.chat_id = c.chat_id
  );
