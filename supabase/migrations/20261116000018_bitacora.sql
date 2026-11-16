-- =====================================================================
-- KU-023 · Bitácora del prestamista
-- No se crea otra tabla: la bitácora lee audit_log (que ya registra cada acción con su usuario) y la
-- enriquece con pagos, gastos, créditos y cierres. Solo se agrega un índice para consultar rápido
-- las acciones de un usuario en un rango de fechas.
-- =====================================================================
create index if not exists audit_log_org_user_created_idx on public.audit_log (org_id, user_id, created_at desc);
create index if not exists audit_log_org_entity_idx on public.audit_log (org_id, entity, entity_id);
