// =====================================================================
// Bitácora del prestamista (KU-023)
// · Lee audit_log (no guarda nada nuevo) y muestra lo que compromete dinero: pagos, abonos, gastos,
//   créditos, solicitudes, traslados de caja, asignaciones, cierres de jornada y traslados de clientes.
// · Incluye lo que el prestamista hizo y lo que el administrador hizo sobre su caja (asignar capital,
//   cerrar o reabrir su jornada).
// · Marca lo que merece revisión: faltantes, anulaciones, pagos fuera de horario o sin ubicación y
//   gastos altos.
// =====================================================================
const express = require('express')
const supabase = require('../db')
const { h, fail, todayBogota } = require('../http')
const { auth, ADMIN } = require('../auth')

const router = express.Router()
const n = (v) => Number(v || 0)
const fullName = (x) => (x ? `${x.name} ${x.last_name || ''}`.trim() : null)
const ISO = /^\d{4}-\d{2}-\d{2}$/
const rc = (num) => `RC-${String(num).padStart(4, '0')}`
const TZ = 'America/Bogota'
const hourOf = (iso) => Number(new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', hour12: false }).format(new Date(iso))) % 24
const dayOf = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(iso))

// Acción → categoría de la bitácora y etiqueta.
const KINDS = {
  'registrar_pago:credito': ['cobro', 'Pago registrado'],
  'abono_capital:credito': ['cobro', 'Abono a capital'],
  'anular:pago': ['cobro', 'Pago anulado'],
  'crear:gasto': ['gasto', 'Gasto registrado'],
  'anular:gasto': ['gasto', 'Gasto anulado'],
  'crear:tanqueo': ['gasto', 'Tanqueo'],
  'crear:mantenimiento': ['gasto', 'Mantenimiento de vehículo'],
  'crear:credito': ['credito', 'Crédito entregado'],
  'renovar:credito': ['credito', 'Crédito renovado'],
  'aprobar:credito': ['credito', 'Solicitud aprobada'],
  'anular:credito': ['credito', 'Crédito anulado'],
  'editar:credito': ['credito', 'Crédito editado'],
  'solicitar:credito': ['credito', 'Solicitud de crédito'],
  'cancelar:solicitud_credito': ['credito', 'Solicitud cancelada'],
  'rechazar:solicitud_credito': ['credito', 'Solicitud rechazada'],
  'crear:traslado_caja': ['caja', 'Envió dinero'],
  'entregar:traslado_caja': ['caja', 'Traslado entregado'],
  'rechazar:traslado_caja': ['caja', 'Traslado rechazado'],
  'asignar_capital:prestamista': ['caja', 'Recibió capital'],
  'quitar_capital:prestamista': ['caja', 'Devolvió capital'],
  'cerrar_jornada:prestamista': ['caja', 'Cierre de jornada'],
  'reabrir_jornada:prestamista': ['caja', 'Jornada reabierta'],
  'trasladar:cliente': ['cliente', 'Cliente trasladado'],
  'crear:cliente': ['cliente', 'Cliente nuevo'],
  'login:usuario': ['sesion', 'Inició sesión']
}
const ACTIONS = [...new Set(Object.keys(KINDS).map((k) => k.split(':')[0]))]
// Umbrales de revisión.
const EARLY = 5; const LATE = 21 // pagos antes de las 5 a. m. o desde las 9 p. m.
const HIGH_EXPENSE = 150000

const inChunks = async (table, cols, ids) => {
  const out = []
  const list = [...new Set(ids.filter(Boolean).map(Number))]
  for (let i = 0; i < list.length; i += 400) {
    const { data } = await supabase.from(table).select(cols).in('id', list.slice(i, i + 400))
    out.push(...(data || []))
  }
  return out
}

router.get('/bitacora', auth(ADMIN), h(async (req, res) => {
  const today = todayBogota()
  const desde = ISO.test(req.query.desde || '') ? req.query.desde : today
  const hasta = ISO.test(req.query.hasta || '') ? req.query.hasta : today
  // Prestamistas del alcance (sede seleccionada o uno en particular).
  let lq = supabase.from('users').select('id, name, last_name, site_id').eq('is_lender', true).order('name')
  if (req.siteId) lq = lq.eq('site_id', req.siteId)
  const { data: lenders } = await lq
  const wanted = Number(req.query.prestamista) || null
  const ids = (lenders || []).map((l) => l.id).filter((id) => !wanted || id === wanted)
  if (!ids.length) return res.send({ desde, hasta, lenders: lenders || [], summary: [], entries: [] })

  // Lo que hizo el prestamista y lo que se hizo sobre su caja.
  const from = new Date(`${desde}T00:00:00-05:00`).toISOString()
  const to = new Date(`${hasta}T23:59:59.999-05:00`).toISOString()
  const base = () => supabase.from('audit_log').select('id, user_id, action, entity, entity_id, detail, ip, created_at, user:users(id, name, last_name, role)')
    .gte('created_at', from).lte('created_at', to).in('action', ACTIONS).order('created_at', { ascending: false }).limit(3000)
  const [{ data: mine, error }, { data: onThem }, { data: byAdmin }] = await Promise.all([
    base().in('user_id', ids),
    base().eq('entity', 'prestamista').in('entity_id', ids.map(String)),
    // Lo que el administrador anuló o resolvió sobre la plata del prestamista (se filtra luego por prestamista).
    base().not('user_id', 'in', `(${ids.join(',')})`).in('entity', ['pago', 'gasto', 'traslado_caja', 'credito']).in('action', ['anular', 'entregar', 'rechazar', 'editar'])
  ])
  if (error) throw error
  const seen = new Set()
  const logs = [...(mine || []), ...(onThem || []), ...(byAdmin || [])].filter((a) => KINDS[`${a.action}:${a.entity}`] && !seen.has(a.id) && seen.add(a.id))
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))

  // Datos de cada registro.
  const payIds = logs.map((a) => (a.entity === 'credito' && a.detail?.payment) || (a.entity === 'pago' && a.entity_id))
  const expIds = logs.filter((a) => a.entity === 'gasto').map((a) => a.entity_id)
  const credIds = logs.filter((a) => a.entity === 'credito' && !a.detail?.payment && a.action !== 'solicitar').map((a) => a.entity_id)
  const reqIds = logs.filter((a) => a.entity === 'solicitud_credito' || a.action === 'solicitar').map((a) => a.entity_id)
  const trIds = logs.filter((a) => a.entity === 'traslado_caja').map((a) => a.entity_id)
  const custIds = logs.filter((a) => a.entity === 'cliente').map((a) => a.entity_id)
  const fuelIds = logs.filter((a) => a.entity === 'tanqueo').map((a) => a.entity_id)
  const mtIds = logs.filter((a) => a.entity === 'mantenimiento').map((a) => a.entity_id)
  const [pays, exps, creds, reqs, trs, custs, fuels, mts, { data: closures }] = await Promise.all([
    inChunks('payments', 'id, number, amount, method, kind, status, lat, lng, lender_id, credit:credits(number), customer:customers(name, last_name)', payIds),
    inChunks('expenses', 'id, number, category, amount, status, note, lender_id', expIds),
    inChunks('credits', 'id, number, kind, principal, disbursed_amount, status, lender_id, customer:customers(name, last_name)', credIds),
    inChunks('credit_requests', 'id, number, principal, status, lender_id, customer:customers(name, last_name)', reqIds),
    inChunks('cash_transfers', 'id, number, amount, status, from_lender_id', trIds),
    inChunks('customers', 'id, name, last_name, lender_id', custIds),
    inChunks('vehicle_fuel_logs', 'id, amount, vehicle:vehicles(plate, collector_id)', fuelIds),
    inChunks('vehicle_maintenances', 'id, cost, description, vehicle:vehicles(plate, collector_id)', mtIds),
    supabase.from('route_closures').select('lender_id, day, collected_cash, counted_cash, expected_cash, difference, delivered').gte('day', desde).lte('day', hasta).in('lender_id', ids)
  ])
  const find = (rows, id) => rows.find((x) => String(x.id) === String(id))
  const lenderName = (id) => fullName((lenders || []).find((l) => l.id === id)) || '—'

  const entries = logs.map((a) => {
    const [kind, label] = KINDS[`${a.action}:${a.entity}`]
    const e = { id: a.id, at: a.created_at, kind, label, by: fullName(a.user), byAdmin: a.user?.role === 'administrador', amount: null, text: '', flags: [], lenderId: a.user?.role === 'prestamista' ? a.user_id : null }
    const pid = a.entity === 'credito' ? a.detail?.payment : a.entity === 'pago' ? a.entity_id : null
    if (pid) {
      const p = find(pays, pid)
      if (p) {
        Object.assign(e, { amount: n(p.amount), lenderId: p.lender_id ?? e.lenderId, ref: rc(p.number), text: `${fullName(p.customer)} · crédito #${p.credit?.number} · ${p.method}`, map: p.lat && p.lng ? { lat: p.lat, lng: p.lng } : null })
        if (a.action === 'anular') e.flags.push('Pago anulado')
        else {
          if (p.status === 'anulado') e.flags.push('Luego fue anulado')
          const hr = hourOf(a.created_at)
          if (hr < EARLY || hr >= LATE) e.flags.push('Fuera de horario')
          if (p.method === 'efectivo' && !p.lat && a.user?.role === 'prestamista') e.flags.push('Sin ubicación')
        }
      }
    } else if (a.entity === 'gasto') {
      const x = find(exps, a.entity_id)
      if (x) {
        Object.assign(e, { amount: n(x.amount), lenderId: x.lender_id ?? e.lenderId, ref: x.number, text: `${x.category}${x.note ? ` · ${x.note}` : ''}` })
        if (a.action === 'anular') e.flags.push('Gasto anulado')
        else if (n(x.amount) >= HIGH_EXPENSE) e.flags.push('Gasto alto')
      }
    } else if (a.entity === 'tanqueo' || a.entity === 'mantenimiento') {
      const x = find(a.entity === 'tanqueo' ? fuels : mts, a.entity_id)
      if (x) Object.assign(e, { amount: n(x.amount ?? x.cost), text: `${x.vehicle?.plate || ''}${x.description ? ` · ${x.description}` : ''}` })
    } else if (a.entity === 'credito' || a.entity === 'solicitud_credito') {
      const x = a.action === 'solicitar' || a.entity === 'solicitud_credito' ? find(reqs, a.entity_id) : find(creds, a.entity_id)
      if (x) {
        Object.assign(e, { amount: n(x.disbursed_amount ?? x.principal), lenderId: x.lender_id ?? e.lenderId, ref: x.number ? (typeof x.number === 'number' ? `#${x.number}` : x.number) : null, text: `${fullName(x.customer)}${x.kind ? ` · ${x.kind}` : ''}` })
        if (a.action === 'anular') e.flags.push('Crédito anulado')
        if (a.action === 'editar') {
          const d = a.detail || {}
          const first = d.dates?.[0]
          const fmt = (iso) => (iso ? iso.split('-').reverse().join('/') : '—')
          const parts = [
            first && `cuota ${first.n}: ${fmt(first.from)} → ${fmt(first.to)}${d.moved > 1 ? ` (y ${d.moved - 1} siguiente${d.moved - 1 === 1 ? '' : 's'})` : ''}`,
            d.skipSundays && (d.skipSundays.to ? 'ya no cobra los domingos' : 'cobra también los domingos'),
            d.notes && 'notas actualizadas',
            d.reason && `motivo: ${d.reason}`
          ].filter(Boolean)
          e.amount = null
          e.text = `${e.text} · ${parts.join(' · ')}`
          e.flags.push('Crédito editado')
        }
      }
    } else if (a.entity === 'traslado_caja') {
      const x = find(trs, a.entity_id)
      if (x) Object.assign(e, { amount: n(x.amount), lenderId: x.from_lender_id, ref: x.number, text: `Estado: ${x.status}` })
    } else if (a.entity === 'prestamista') {
      e.lenderId = Number(a.entity_id)
      if (a.action === 'cerrar_jornada') {
        const c = (closures || []).find((x) => x.lender_id === e.lenderId && x.day === a.detail?.day)
        if (c) {
          Object.assign(e, { amount: n(c.counted_cash), text: `Día ${a.detail.day} · esperado ${n(c.expected_cash).toLocaleString('es-CO')} · entregó ${n(c.delivered).toLocaleString('es-CO')}` })
          if (n(c.difference) < 0) e.flags.push(`Faltante $ ${(-n(c.difference)).toLocaleString('es-CO')}`)
          if (n(c.difference) > 0) e.flags.push(`Sobrante $ ${n(c.difference).toLocaleString('es-CO')}`)
        }
      } else if (a.action === 'reabrir_jornada') { e.text = `Día ${a.detail?.day}`; e.flags.push('Jornada reabierta') } else Object.assign(e, { amount: n(a.detail?.amount), ref: a.detail?.ref || null })
    } else if (a.entity === 'cliente') {
      const x = find(custs, a.entity_id)
      Object.assign(e, { lenderId: x?.lender_id ?? e.lenderId, text: fullName(x) || '' })
    } else if (a.action === 'login') e.text = a.ip ? `IP ${a.ip}` : ''
    e.lender = lenderName(e.lenderId)
    return e
  }).filter((e) => (e.lenderId ? ids.includes(e.lenderId) : !e.byAdmin))

  // Resumen por prestamista: cobrado, gastos, créditos, inicio y fin de actividad y alertas.
  const summary = ids.map((id) => {
    const mineE = entries.filter((e) => e.lenderId === id)
    const sumOf = (k, labels) => mineE.filter((e) => e.kind === k && (!labels || labels.includes(e.label)) && !e.flags.includes('Luego fue anulado')).reduce((t, e) => t + n(e.amount), 0)
    const own = mineE.filter((e) => !e.byAdmin && e.kind !== 'sesion').map((e) => e.at).sort()
    const cls = (closures || []).filter((c) => c.lender_id === id)
    return {
      lenderId: id, lender: lenderName(id),
      collected: sumOf('cobro', ['Pago registrado', 'Abono a capital']), payments: mineE.filter((e) => e.kind === 'cobro' && e.label !== 'Pago anulado').length,
      expenses: sumOf('gasto', ['Gasto registrado', 'Tanqueo', 'Mantenimiento de vehículo']), lent: sumOf('credito', ['Crédito entregado', 'Crédito renovado']),
      first: own[0] || null, last: own[own.length - 1] || null, days: new Set(own.map(dayOf)).size,
      shortage: cls.reduce((t, c) => t + Math.max(0, -n(c.difference)), 0), closures: cls.length,
      flags: mineE.reduce((t, e) => t + e.flags.length, 0)
    }
  }).filter((s) => s.payments || s.expenses || s.lent || s.flags || s.closures || s.first)

  res.send({ desde, hasta, lenders: (lenders || []).map((l) => ({ id: l.id, fullName: fullName(l) })), summary, entries })
}))

module.exports = router
module.exports.KINDS = KINDS
