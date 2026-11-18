// =====================================================================
// KU-032 · Cierre automático de jornada
// · La hora sale del país del negocio (countries.auto_close_time) o de una hora propia del negocio
//   (app_settings.auto_close_mode = 'hora'). Se compara con la hora local de la zona horaria del país.
// · Cada 10 minutos, pasada la hora, se cierran las jornadas de hoy que sigan abiertas: el efectivo
//   contado se toma igual al esperado (no hubo conteo) y el cierre queda marcado como automático.
// · No se vuelve a cerrar una jornada que el administrador reabrió ese día.
// · Si el plan del negocio no incluye "Gastos y cierre de jornada", no se hace nada.
// =====================================================================
const supabase = require('./db')
const plan = require('./plan')
const { currentOrg, forEachOrg } = require('./tenant')
const { todayBogota } = require('./http')
const { audit } = require('./audit')

const { validTime, hhmm, localTime, resolveRule } = require('./lib/autoCloseRule')

const ruleForOrg = async () => {
  const st = await plan.ensure(currentOrg())
  const { data: s } = await supabase.from('app_settings').select('auto_close_mode, auto_close_time, timezone').maybeSingle()
  return { ...resolveRule(s, st.country), enabledInPlan: plan.has(st, 'gastos') }
}

// El sistema firma los cierres automáticos.
const SYSTEM_REQ = { user: { id: null, name: 'Cierre automático', last_name: '' }, headers: {}, socket: {} }

// Cierra las jornadas abiertas de hoy del negocio actual. Devuelve cuántas cerró.
const closeOpenDays = async (rule) => {
  const day = todayBogota()
  const [{ data: lenders }, { data: closures }, { data: reopened }] = await Promise.all([
    supabase.from('users').select('id').eq('is_lender', true).eq('active', true),
    supabase.from('route_closures').select('lender_id').eq('day', day),
    supabase.from('route_reopen_requests').select('lender_id').eq('day', day).eq('status', 'aprobada')
  ])
  const skip = new Set([...(closures || []), ...(reopened || [])].map((r) => r.lender_id))
  let closed = 0
  for (const { id } of (lenders || []).filter((l) => !skip.has(l.id))) {
    const { data: s, error: e1 } = await supabase.rpc('day_summary', { p_org: currentOrg(), p_lender: id, p_day: day })
    if (e1) { console.error('Cierre automático (resumen):', e1.message); continue }
    const counted = Math.round(Number(s?.balance) || 0)
    const { data: closureId, error } = await supabase.rpc('close_day', {
      p: { org_id: currentOrg(), lender_id: id, day, counted_cash: Math.max(counted, 0), deliver: 0, note: `Cierre automático a las ${rule.time} (sin conteo de efectivo)`, user_id: null }
    })
    if (error) { if (error.code !== 'P0001') console.error('Cierre automático:', error.message); continue }
    await supabase.from('route_closures').update({ automatic: true }).eq('id', closureId)
    await audit(SYSTEM_REQ, 'cerrar_jornada', 'prestamista', id, { day, counted, deliver: 0, automatic: true })
    closed++
  }
  return closed
}

const tick = async () => {
  const rule = await ruleForOrg()
  if (!rule.enabledInPlan || !rule.time) return
  if (localTime(rule.timezone) < rule.time) return
  await closeOpenDays(rule)
}

const startAutoClose = () => {
  const run = () => forEachOrg(supabase, tick).catch((e) => console.error('Cierre automático:', e.message))
  setTimeout(run, 45000).unref()
  setInterval(run, 10 * 60000).unref()
}

module.exports = { validTime, hhmm, localTime, resolveRule, ruleForOrg, closeOpenDays, startAutoClose }
