// =====================================================================
// Notificaciones por Telegram (KU-018, etapa 6; modelo de integra-ips)
// · Cada negocio configura su bot (token de @BotFather) y uno o más grupos por sección.
// · Cada grupo pertenece a una sede (solo recibe los avisos de los ruteros de esa sede) o a todas.
// · Los avisos salen de la auditoría: cada acción registrada (pago, crédito, gasto, traslado…) arma su
//   mensaje aquí. El envío corre en segundo plano y nunca hace fallar la petición que lo origina.
// · Resumen de la mañana (agenda del día) y del cierre (recaudo por rutero) a la hora configurada.
// =====================================================================
const supabase = require('./db')
const { todayBogota } = require('./http')
const { currentOrg, forEachOrg } = require('./tenant')

const SECTIONS = {
  cobros: { label: 'Cobros', hint: 'Cada pago o abono recibido, con el saldo que queda, y los pagos anulados' },
  creditos: { label: 'Créditos', hint: 'Créditos nuevos y renovados, solicitudes por aprobar, aprobaciones, rechazos y anulaciones' },
  caja: { label: 'Capital y cajas', hint: 'Aportes y retiros, asignaciones a ruteros, traslados de dinero y cierres de jornada' },
  gastos: { label: 'Gastos', hint: 'Gastos registrados y anulados (gasolina, almuerzo, etc.)' },
  clientes: { label: 'Clientes', hint: 'Clientes nuevos y clientes trasladados de ruta' },
  vehiculos: { label: 'Vehículos', hint: 'Tanqueos y mantenimientos de los vehículos de cobro' },
  resumen: { label: 'Resumen diario', hint: 'Agenda de la mañana (cuotas del día, promesas, mora) y resumen del cierre (recaudo por rutero)' }
}
const API = 'https://api.telegram.org'
const TZ = 'America/Bogota'
// Enlace a la app en cada aviso: PUBLIC_APP_URL o el primer origen permitido que no sea local.
const APP_URL = () => (process.env.PUBLIC_APP_URL || (process.env.CORS_ORIGIN || '').split(',').map((o) => o.trim()).find((o) => /^https:\/\//.test(o)) || '').replace(/\/$/, '')

const esc = (t) => String(t ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
const money = (v) => `$ ${Math.round(Number(v || 0)).toLocaleString('es-CO')}`
const fullName = (x) => (x ? `${x.name} ${x.last_name || ''}`.trim() : '—')
const hour = (d = new Date()) => new Intl.DateTimeFormat('es-CO', { timeStyle: 'short', timeZone: TZ }).format(new Date(d))
const fmtDate = (iso) => (iso ? String(iso).slice(0, 10).split('-').reverse().join('/') : '')
const rc = (n) => `RC-${String(n).padStart(4, '0')}`
const SEP = '━━━━━━━━━━━━━━━'

const tgError = (message, extra = {}) => Object.assign(new Error(message), { status: 400, ...extra })
const tg = async (token, method, body) => {
  const r = await fetch(`${API}/bot${token}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}), signal: AbortSignal.timeout(15000) })
  const j = await r.json().catch(() => ({}))
  if (!j.ok) throw tgError(`Telegram: ${j.description || `error ${r.status}`}`, { migrateTo: j.parameters?.migrate_to_chat_id ? String(j.parameters.migrate_to_chat_id) : null })
  return j.result
}
// Si Telegram convierte el grupo en supergrupo, cambia su id: se actualiza y se reintenta.
const sendTo = async (token, chatId, html) => {
  const body = (id) => ({ chat_id: id, text: html, parse_mode: 'HTML', disable_web_page_preview: true })
  try { await tg(token, 'sendMessage', body(chatId)); return String(chatId) } catch (e) {
    if (!e.migrateTo) throw e
    await supabase.from('notification_channels').update({ chat_id: e.migrateTo }).eq('chat_id', String(chatId))
    await tg(token, 'sendMessage', body(e.migrateTo))
    return e.migrateTo
  }
}
const loadSettings = async () => (await supabase.from('notification_settings').select('*').maybeSingle()).data
const withLink = (html, path) => (path && APP_URL() ? `${html}\n🔗 <a href="${APP_URL()}${path}">Abrir en QuontUp360</a>` : html)

// Sede de un prestamista (para enviar al grupo de esa sede y a los de "todas las sedes").
const siteOf = async (lenderId) => {
  if (!lenderId) return { id: null, name: null }
  const { data } = await supabase.from('users').select('site_id, site:sites(name)').eq('id', lenderId).maybeSingle()
  return { id: data?.site_id ?? null, name: data?.site?.name ?? null }
}

// Envía a los grupos de la sección: los de la sede del aviso y los de todas las sedes.
const send = async (section, build) => {
  if (!SECTIONS[section]) return
  const st = await loadSettings()
  if (!st?.enabled || !st.bot_token) return
  let q = supabase.from('notification_channels').select('chat_id, site_id').eq('section', section).eq('enabled', true)
  const { data: chans } = await q
  if (!chans?.length) return
  const msg = await build()
  if (!msg) return
  const siteId = msg.siteId ?? null
  q = chans.filter((c) => c.site_id === null || (siteId && Number(c.site_id) === Number(siteId)))
  const html = withLink(msg.html, msg.path)
  for (const c of q) {
    let status = 'enviado'; let detail = null; let sentTo = c.chat_id
    try { sentTo = await sendTo(st.bot_token, c.chat_id, html) } catch (e) { status = 'error'; detail = e.message.slice(0, 300) }
    await supabase.from('notification_log').insert({ section, chat_id: sentTo, status, detail, site_id: siteId })
  }
}
const notify = (section, build) => { send(section, build).catch((e) => console.error('Telegram:', e.message)) }

// ---------------------------------------------------------------------
// Mensajes de cada acción del sistema
// ---------------------------------------------------------------------
const siteLine = (s) => (s?.name ? ` · 📍 ${esc(s.name)}` : '')
const byUser = (req) => esc(fullName(req.user))

const PAY_SELECT = 'id, number, amount, method, kind, status, void_reason, paid_on, credit_id, lender_id, credit:credits(number, installments_count), customer:customers(name, last_name), lender:users!payments_lender_id_fkey(name, last_name)'
const payment = async (id, voided, req) => {
  const { data: p } = await supabase.from('payments').select(PAY_SELECT).eq('id', id).maybeSingle()
  if (!p) return null
  const site = await siteOf(p.lender_id)
  const { data: b } = await supabase.from('credit_balances').select('balance, paid_count, overdue_amount, status').eq('credit_id', p.credit_id).maybeSingle()
  const method = { efectivo: 'efectivo', transferencia: 'transferencia', otro: 'otro medio' }[p.method] || p.method
  if (voided) {
    return { siteId: site.id, path: `/creditos/${p.credit_id}`,
      html: `🚫 <b>PAGO ANULADO · ${rc(p.number)}</b>\n${SEP}\n👤 ${esc(fullName(p.customer))} · Crédito #${p.credit.number}\n💰 ${money(p.amount)} · ${fmtDate(p.paid_on)}\n📝 Motivo: ${esc(p.void_reason || '—')}\n🧑‍💼 Anuló: ${byUser(req)}${siteLine(site)}` }
  }
  const paidOff = b && Number(b.balance) <= 0
  return { siteId: site.id, path: `/creditos/${p.credit_id}`,
    html: `💵 <b>${p.kind === 'abono_capital' ? 'ABONO A CAPITAL' : 'PAGO RECIBIDO'} · ${rc(p.number)}</b>\n${SEP}\n` +
      `👤 ${esc(fullName(p.customer))} · Crédito #${p.credit.number}\n💰 <b>${money(p.amount)}</b> en ${method}\n` +
      (b ? (paidOff ? '🎉 <b>Crédito pagado por completo</b>' : `📉 Saldo: ${money(b.balance)} · cuotas pagadas ${b.paid_count}/${p.credit.installments_count}${Number(b.overdue_amount) > 0 ? `\n⚠️ Sigue en mora: ${money(b.overdue_amount)}` : ''}`) : '') +
      `\n🧑‍💼 Cobró: ${esc(fullName(p.lender))}${siteLine(site)} · 🕒 ${hour()}` }
}

const CREDIT_SELECT = 'id, number, kind, principal, total_amount, installment_amount, installments_count, frequency, lender_id, status, void_reason, renewed_from_id, payoff_amount, disbursed_amount, customer:customers(name, last_name), lender:users!credits_lender_id_fkey(name, last_name)'
const FREQ = { diaria: 'diarias', semanal: 'semanales', quincenal: 'quincenales', mensual: 'mensuales', personalizada: '' }
const credit = async (id, action, req) => {
  const { data: c } = await supabase.from('credits').select(CREDIT_SELECT).eq('id', id).maybeSingle()
  if (!c) return null
  const site = await siteOf(c.lender_id)
  const head = { crear: '🆕 <b>CRÉDITO NUEVO', renovar: '🔄 <b>CRÉDITO RENOVADO', aprobar: '✅ <b>CRÉDITO APROBADO', anular: '🚫 <b>CRÉDITO ANULADO' }[action]
  const base = `${head} · #${c.number}</b>\n${SEP}\n👤 ${esc(fullName(c.customer))}\n`
  if (action === 'anular') return { siteId: site.id, path: `/creditos/${c.id}`, html: `${base}💰 Capital ${money(c.principal)}\n📝 Motivo: ${esc(c.void_reason || '—')}\n🧑‍💼 Anuló: ${byUser(req)}${siteLine(site)}` }
  return { siteId: site.id, path: `/creditos/${c.id}`,
    html: `${base}💰 ${c.kind === 'producto' ? 'Producto' : 'Efectivo'}: <b>${money(c.principal)}</b> · total ${money(c.total_amount)}\n` +
      `📆 ${c.installments_count} cuotas ${FREQ[c.frequency] || ''} de ${money(c.installment_amount)}` +
      (action === 'renovar' && Number(c.payoff_amount) ? `\n♻️ Cerró el saldo anterior: ${money(c.payoff_amount)} · entregado ${money(c.disbursed_amount)}` : '') +
      `\n🧑‍💼 Rutero: ${esc(fullName(c.lender))}${siteLine(site)}${action === 'aprobar' ? `\n✔️ Aprobó: ${byUser(req)}` : ''}` }
}

const request = async (id, action, req) => {
  const { data: r } = await supabase.from('credit_requests').select('id, number, principal, installments_count, installment_amount, reason, review_note, lender_id, customer:customers(name, last_name), lender:users!credit_requests_lender_id_fkey(name, last_name)').eq('id', id).maybeSingle()
  if (!r) return null
  const site = await siteOf(r.lender_id)
  if (action === 'solicitar') {
    return { siteId: site.id, path: '/solicitudes',
      html: `📝 <b>SOLICITUD DE CRÉDITO · ${esc(r.number)}</b>\n${SEP}\n👤 ${esc(fullName(r.customer))} (ya tiene un crédito activo)\n💰 ${money(r.principal)} en ${r.installments_count} cuotas de ${money(r.installment_amount)}\n` +
        (r.reason ? `💬 ${esc(r.reason)}\n` : '') + `🧑‍💼 Pide: ${esc(fullName(r.lender))}${siteLine(site)}\n⏳ <b>Pendiente de aprobación del administrador</b>` }
  }
  return { siteId: site.id, path: '/solicitudes',
    html: `${action === 'rechazar' ? '❌ <b>SOLICITUD RECHAZADA' : '↩️ <b>SOLICITUD CANCELADA'} · ${esc(r.number)}</b>\n${SEP}\n👤 ${esc(fullName(r.customer))} · ${money(r.principal)}\n` +
      (r.review_note ? `📝 ${esc(r.review_note)}\n` : '') + `🧑‍💼 ${byUser(req)}${siteLine(site)}` }
}

const expense = async (id, voided, req) => {
  const { data: e } = await supabase.from('expenses').select('id, number, category, amount, note, lender_id, void_reason, lender:users!expenses_lender_id_fkey(name, last_name)').eq('id', id).maybeSingle()
  if (!e) return null
  const site = await siteOf(e.lender_id)
  const CAT = { combustible: '⛽ Combustible', alimentacion: '🍽️ Alimentación', transporte: '🚌 Transporte', mantenimiento: '🔧 Mantenimiento', papeleria: '📎 Papelería', comunicaciones: '📱 Comunicaciones', otro: '🧾 Otro' }
  return { siteId: site.id, path: '/gastos',
    html: `${voided ? '🚫 <b>GASTO ANULADO' : '🧾 <b>GASTO REGISTRADO'} · ${esc(e.number)}</b>\n${SEP}\n${CAT[e.category] || esc(e.category)} · <b>${money(e.amount)}</b>\n` +
      (e.note ? `📝 ${esc(e.note)}\n` : '') + (voided ? `❗ Motivo: ${esc(e.void_reason || '—')}\n` : '') +
      `💼 Caja: ${e.lender_id ? esc(fullName(e.lender)) : 'Negocio'}${siteLine(site)} · 👤 ${byUser(req)}` }
}

const capital = async (action, entityId, detail, req) => {
  if (action === 'aporte_capital' || action === 'retiro_capital') {
    const { data: m } = await supabase.from('fund_movements').select('amount, note, balance_after, account:fund_accounts!fund_movements_account_id_fkey(site_id, site:sites(name))').eq('id', entityId).maybeSingle()
    const sName = m?.account?.site?.name
    return { siteId: m?.account?.site_id ?? null, path: '/capital',
      html: `${action === 'aporte_capital' ? '🏦 <b>APORTE DE CAPITAL' : '🏧 <b>RETIRO DE CAPITAL'}</b>\n${SEP}\n💰 <b>${money(detail?.amount)}</b>${sName ? ` · capital de ${esc(sName)}` : ''}\n` +
        (m?.note ? `📝 ${esc(m.note)}\n` : '') + `🏦 Saldo: ${money(m?.balance_after)}\n👤 ${byUser(req)}` }
  }
  if (action === 'asignar_capital' || action === 'quitar_capital') {
    const site = await siteOf(entityId)
    const { data: u } = await supabase.from('users').select('name, last_name').eq('id', entityId).maybeSingle()
    const { data: acc } = await supabase.from('fund_accounts').select('balance').eq('user_id', entityId).maybeSingle()
    return { siteId: site.id, path: '/capital',
      html: `${action === 'asignar_capital' ? '➡️ <b>ASIGNACIÓN A RUTERO' : '⬅️ <b>DINERO DEVUELTO AL NEGOCIO'} · ${esc(detail?.ref || '')}</b>\n${SEP}\n🧑‍💼 ${esc(fullName(u))}${siteLine(site)}\n💰 <b>${money(detail?.amount)}</b>\n💼 Queda en su caja: ${money(acc?.balance)}\n👤 ${byUser(req)}` }
  }
  return null
}

const transfer = async (id, action, req) => {
  const { data: t } = await supabase.from('cash_transfers').select('number, amount, note, review_note, status, from_lender_id, from:users!cash_transfers_from_lender_id_fkey(name, last_name), to:users!cash_transfers_to_lender_id_fkey(name, last_name), delivered:users!cash_transfers_delivered_to_id_fkey(name, last_name)').eq('id', id).maybeSingle()
  if (!t) return null
  const site = await siteOf(t.from_lender_id)
  const title = { crear: '🔁 <b>TRASLADO DE DINERO PENDIENTE', entregar: '✅ <b>TRASLADO ENTREGADO', rechazar: '↩️ <b>TRASLADO RECHAZADO' }[action]
  return { siteId: site.id, path: '/capital',
    html: `${title} · ${esc(t.number)}</b>\n${SEP}\n💰 <b>${money(t.amount)}</b>\n📤 Envía: ${esc(fullName(t.from))}${siteLine(site)}\n` +
      (action === 'entregar' ? `📥 Recibió: ${esc(fullName(t.delivered))}` : t.to ? `📥 Para: ${esc(fullName(t.to))}` : '') +
      (t.note && action === 'crear' ? `\n📝 ${esc(t.note)}` : '') + (t.review_note && action !== 'crear' ? `\n📝 ${esc(t.review_note)}` : '') +
      (action === 'crear' ? '\n⏳ El administrador debe entregarlo o rechazarlo' : `\n👤 ${byUser(req)}`) }
}

const closure = async (lenderId, detail, reopened, req) => {
  const site = await siteOf(lenderId)
  const { data: u } = await supabase.from('users').select('name, last_name').eq('id', lenderId).maybeSingle()
  if (reopened) return { siteId: site.id, path: '/rutas', html: `🔓 <b>JORNADA REABIERTA</b>\n${SEP}\n🧑‍💼 ${esc(fullName(u))}${siteLine(site)} · 📅 ${fmtDate(detail?.day)}\n👤 ${byUser(req)}` }
  const { data: c } = await supabase.from('route_closures').select('*').eq('lender_id', lenderId).eq('day', detail?.day).maybeSingle()
  if (!c) return null
  const diff = Number(c.difference)
  return { siteId: site.id, path: `/rutas/${lenderId}`,
    html: `🔒 <b>${c.automatic ? 'CIERRE AUTOMÁTICO DE JORNADA' : 'CIERRE DE JORNADA'}</b>\n${SEP}\n🧑‍💼 ${esc(fullName(u))}${siteLine(site)} · 📅 ${fmtDate(c.day)}\n` +
      `💵 Recaudo en efectivo: ${money(c.collected_cash)}${Number(c.collected_other) ? ` · otros ${money(c.collected_other)}` : ''}\n` +
      `🧾 Pagos: ${c.payments} · 🚪 Visitas: ${c.visits}\n💸 Prestado: ${money(c.disbursed)} · Gastos: ${money(c.expenses)}\n` +
      `🧮 Esperado: ${money(c.expected_cash)} · Contado: ${money(c.counted_cash)}\n` +
      (diff === 0 ? '✅ Cuadre exacto' : diff > 0 ? `🟢 Sobrante: ${money(diff)}` : `🔴 <b>Faltante: ${money(-diff)}</b>`) +
      (Number(c.delivered) ? `\n🏦 Entregó al negocio: ${money(c.delivered)}` : '') + (c.note ? `\n📝 ${esc(c.note)}` : '') }
}

const reopenRequest = async (id, action, detail, req) => {
  const site = await siteOf(detail?.lender)
  const { data: u } = await supabase.from('users').select('name, last_name').eq('id', detail?.lender || 0).maybeSingle()
  if (action === 'rechazar') return { siteId: site.id, path: '/rutas', html: `⛔ <b>REAPERTURA DE JORNADA RECHAZADA</b>\n${SEP}\n🧑‍💼 ${esc(fullName(u))}${siteLine(site)} · 📅 ${fmtDate(detail?.day)}\n📝 ${esc(detail?.note || '')}\n👤 ${byUser(req)}` }
  return { siteId: site.id, path: '/rutas', html: `🙋 <b>SOLICITUD PARA REABRIR JORNADA</b>\n${SEP}\n🧑‍💼 ${esc(fullName(u))}${siteLine(site)} · 📅 ${fmtDate(detail?.day)}\n📝 ${esc(detail?.reason || '')}\n⏳ El administrador debe aprobarla o rechazarla en Rutas` }
}

const customer = async (id, action, detail, req) => {
  const { data: c } = await supabase.from('customers').select('id, name, last_name, identification, phone, neighborhood, address, lender_id, lender:users!customers_lender_id_fkey(name, last_name)').eq('id', id).maybeSingle()
  if (!c) return null
  const site = await siteOf(c.lender_id)
  if (action === 'trasladar') {
    const { data: from } = await supabase.from('users').select('name, last_name').eq('id', detail?.from || 0).maybeSingle()
    return { siteId: site.id, path: `/clientes/${c.id}`, html: `🔀 <b>CLIENTE TRASLADADO DE RUTA</b>\n${SEP}\n👤 ${esc(fullName(c))} · C.C. ${esc(c.identification)}\n📤 De: ${esc(fullName(from))}\n📥 A: ${esc(fullName(c.lender))}${siteLine(site)}${detail?.moving ? `\n🏠 Nueva dirección: ${esc(c.address || '—')}` : ''}\n👤 ${byUser(req)}` }
  }
  return { siteId: site.id, path: `/clientes/${c.id}`,
    html: `🙋 <b>CLIENTE NUEVO</b>\n${SEP}\n👤 ${esc(fullName(c))} · C.C. ${esc(c.identification)}\n📱 ${esc(c.phone || '—')}${c.neighborhood ? ` · ${esc(c.neighborhood)}` : ''}\n🧑‍💼 Rutero: ${c.lender_id ? esc(fullName(c.lender)) : 'sin asignar'}${siteLine(site)}\n👤 Registró: ${byUser(req)}` }
}

const vehicleLog = async (id, kind, req) => {
  const table = kind === 'tanqueo' ? 'vehicle_fuel_logs' : 'vehicle_maintenances'
  const { data: r } = await supabase.from(table).select('*, vehicle:vehicles(id, code, plate, collector_id)').eq('id', id).maybeSingle()
  if (!r) return null
  const site = await siteOf(r.vehicle?.collector_id)
  const v = `🏍️ ${esc(r.vehicle?.plate)} · Móvil ${esc(r.vehicle?.code)}`
  if (kind === 'tanqueo') {
    return { siteId: site.id, path: `/vehiculos/${r.vehicle?.id}`, html: `⛽ <b>TANQUEO</b>\n${SEP}\n${v}${siteLine(site)}\n💰 <b>${money(r.amount)}</b>${r.gallons ? ` · ${Number(r.gallons).toLocaleString('es-CO')} gal` : ''}${r.station ? ` · ${esc(r.station)}` : ''}\n🛣️ Km ${Number(r.odometer).toLocaleString('es-CO')}\n👤 ${byUser(req)}` }
  }
  return { siteId: site.id, path: `/vehiculos/${r.vehicle?.id}`,
    html: `🔧 <b>MANTENIMIENTO</b>\n${SEP}\n${v}${siteLine(site)}\n🛠️ ${esc(r.description)}${r.workshop ? ` · ${esc(r.workshop)}` : ''}\n💰 <b>${money(r.cost)}</b>${r.odometer ? ` · Km ${Number(r.odometer).toLocaleString('es-CO')}` : ''}` +
      (r.next_odometer || r.next_date ? `\n⏭️ Próximo: ${[r.next_odometer && `${Number(r.next_odometer).toLocaleString('es-CO')} km`, r.next_date && fmtDate(r.next_date)].filter(Boolean).join(' · ')}` : '') + `\n👤 ${byUser(req)}` }
}

// Acción de la auditoría → sección y mensaje.
const onAudit = (req, action, entity, id, detail) => {
  const route = {
    'registrar_pago:credito': ['cobros', () => payment(detail?.payment, false, req)],
    'abono_capital:credito': ['cobros', () => payment(detail?.payment, false, req)],
    'anular:pago': ['cobros', () => payment(id, true, req)],
    'crear:credito': ['creditos', () => credit(id, 'crear', req)],
    'renovar:credito': ['creditos', () => credit(id, 'renovar', req)],
    'aprobar:credito': ['creditos', () => credit(id, 'aprobar', req)],
    'anular:credito': ['creditos', () => credit(id, 'anular', req)],
    'solicitar:credito': ['creditos', () => request(id, 'solicitar', req)],
    'rechazar:solicitud_credito': ['creditos', () => request(id, 'rechazar', req)],
    'cancelar:solicitud_credito': ['creditos', () => request(id, 'cancelar', req)],
    'crear:gasto': ['gastos', () => expense(id, false, req)],
    'anular:gasto': ['gastos', () => expense(id, true, req)],
    'aporte_capital:capital': ['caja', () => capital(action, id, detail, req)],
    'retiro_capital:capital': ['caja', () => capital(action, id, detail, req)],
    'asignar_capital:prestamista': ['caja', () => capital(action, id, detail, req)],
    'quitar_capital:prestamista': ['caja', () => capital(action, id, detail, req)],
    'crear:traslado_caja': ['caja', () => transfer(id, 'crear', req)],
    'entregar:traslado_caja': ['caja', () => transfer(id, 'entregar', req)],
    'rechazar:traslado_caja': ['caja', () => transfer(id, 'rechazar', req)],
    'cerrar_jornada:prestamista': ['caja', () => closure(id, detail, false, req)],
    'reabrir_jornada:prestamista': ['caja', () => closure(id, detail, true, req)],
    'solicitar:reabrir_jornada': ['caja', () => reopenRequest(id, 'solicitar', detail, req)],
    'rechazar:reabrir_jornada': ['caja', () => reopenRequest(id, 'rechazar', detail, req)],
    'crear:cliente': ['clientes', () => customer(id, 'crear', detail, req)],
    'trasladar:cliente': ['clientes', () => customer(id, 'trasladar', detail, req)],
    'crear:tanqueo': ['vehiculos', () => vehicleLog(id, 'tanqueo', req)],
    'crear:mantenimiento': ['vehiculos', () => vehicleLog(id, 'mantenimiento', req)]
  }[`${action}:${entity}`]
  if (!route || !currentOrg()) return
  notify(route[0], route[1])
}

// ---------------------------------------------------------------------
// Resúmenes programados (por sede: un mensaje para cada sede y uno general)
// ---------------------------------------------------------------------
const groupsFor = async () => {
  const { data: chans } = await supabase.from('notification_channels').select('site_id').eq('section', 'resumen').eq('enabled', true)
  return [...new Set((chans || []).map((c) => c.site_id ?? null))]
}
const lendersOf = async (siteId) => {
  let q = supabase.from('users').select('id, name, last_name').eq('is_lender', true).eq('active', true).order('name')
  if (siteId) q = q.eq('site_id', siteId)
  return (await q).data || []
}
const siteName = async (siteId) => (siteId ? (await supabase.from('sites').select('name').eq('id', siteId).maybeSingle()).data?.name : null)

// Mañana: lo que hay que cobrar hoy, promesas de pago y mora, por rutero.
const morningFor = async (siteId) => {
  const today = todayBogota()
  const lenders = await lendersOf(siteId)
  const ids = lenders.map((l) => l.id)
  if (!ids.length) return null
  const [{ data: due }, { data: bal }, { data: promises }] = await Promise.all([
    supabase.from('installments').select('amount, paid_amount, waived, due_date, credit:credits!inner(lender_id, customer_id, status)').in('status', ['pendiente', 'parcial']).lte('due_date', today).eq('credit.status', 'activo').in('credit.lender_id', ids),
    supabase.from('credit_balances').select('lender_id, customer_id, overdue_amount').eq('status', 'activo').in('lender_id', ids),
    supabase.from('visits').select('lender_id, customer:customers(name, last_name)').eq('result', 'promesa').eq('promise_date', today).in('lender_id', ids)
  ])
  const rest = (i) => Number(i.amount) - Number(i.paid_amount) - Number(i.waived || 0)
  const rows = lenders.map((l) => {
    const d = (due || []).filter((i) => i.credit.lender_id === l.id)
    return { name: fullName(l), toCollect: d.reduce((t, i) => t + rest(i), 0), stops: new Set(d.map((i) => i.credit.customer_id)).size, promises: (promises || []).filter((p) => p.lender_id === l.id).length }
  })
  const overdue = (bal || []).reduce((t, b) => t + Number(b.overdue_amount), 0)
  const late = new Set((bal || []).filter((b) => Number(b.overdue_amount) > 0).map((b) => b.customer_id)).size
  const name = await siteName(siteId)
  return {
    siteId, path: '/rutas',
    html: `☀️ <b>AGENDA DE COBRO · ${fmtDate(today)}</b>${name ? `\n📍 ${esc(name)}` : ''}\n${SEP}\n` +
      `💰 Por cobrar hoy: <b>${money(rows.reduce((t, r) => t + r.toCollect, 0))}</b> en ${rows.reduce((t, r) => t + r.stops, 0)} visitas\n` +
      `⚠️ En mora: ${money(overdue)} (${late} cliente${late === 1 ? '' : 's'})\n🤝 Promesas de pago para hoy: ${(promises || []).length}\n\n` +
      `🧑‍💼 <b>Por rutero</b>\n${rows.map((r) => ` • ${esc(r.name)}: ${money(r.toCollect)} · ${r.stops} visitas${r.promises ? ` · ${r.promises} promesa${r.promises === 1 ? '' : 's'}` : ''}`).join('\n')}`
  }
}

// Cierre: recaudo del día por rutero, jornadas sin cerrar, faltantes y créditos colocados.
const eveningFor = async (siteId) => {
  const today = todayBogota()
  const lenders = await lendersOf(siteId)
  const ids = lenders.map((l) => l.id)
  if (!ids.length) return null
  const [{ data: pays }, { data: closures }, { data: cr }, { data: exps }] = await Promise.all([
    supabase.from('payments').select('lender_id, amount, method').eq('status', 'aplicado').neq('kind', 'renovacion').eq('paid_on', today).in('lender_id', ids),
    supabase.from('route_closures').select('lender_id, difference').eq('day', today).in('lender_id', ids),
    supabase.from('credits').select('lender_id, principal').neq('status', 'anulado').eq('disbursement_date', today).in('lender_id', ids),
    supabase.from('expenses').select('lender_id, amount').eq('status', 'aplicado').eq('spent_on', today).in('lender_id', ids)
  ])
  const sum = (rows, f = (x) => Number(x.amount)) => (rows || []).reduce((t, x) => t + f(x), 0)
  const rows = lenders.map((l) => {
    const p = (pays || []).filter((x) => x.lender_id === l.id)
    const c = (closures || []).find((x) => x.lender_id === l.id)
    return { name: fullName(l), amount: sum(p), count: p.length, closed: Boolean(c), diff: c ? Number(c.difference) : 0 }
  })
  const open = rows.filter((r) => !r.closed)
  const short = rows.filter((r) => r.closed && r.diff < 0)
  const name = await siteName(siteId)
  return {
    siteId, path: '/reportes',
    html: `🌙 <b>RESUMEN DEL DÍA · ${fmtDate(today)}</b>${name ? `\n📍 ${esc(name)}` : ''}\n${SEP}\n` +
      `💵 Recaudado: <b>${money(sum(pays))}</b> en ${(pays || []).length} pagos\n🆕 Colocado: ${money(sum(cr, (x) => Number(x.principal)))} en ${(cr || []).length} créditos\n🧾 Gastos: ${money(sum(exps))}\n\n` +
      `🧑‍💼 <b>Por rutero</b>\n${rows.map((r) => ` • ${esc(r.name)}: ${money(r.amount)} (${r.count})${r.closed ? (r.diff < 0 ? ` 🔴 faltante ${money(-r.diff)}` : ' ✅') : ' ⏳ sin cerrar'}`).join('\n')}` +
      (open.length ? `\n\n⏳ <b>Jornadas sin cerrar:</b> ${open.map((r) => esc(r.name)).join(', ')}` : '') +
      (short.length ? `\n🔴 <b>Con faltante:</b> ${short.map((r) => esc(r.name)).join(', ')}` : '')
  }
}

// Envía un resumen a cada grupo de "Resumen diario" (cada sede recibe el suyo; los generales, el de todo).
const sendSummary = async (kind) => {
  const st = await loadSettings()
  if (!st?.enabled || !st.bot_token) return 0
  const sites = await groupsFor()
  let sent = 0
  for (const siteId of sites) {
    const msg = kind === 'morning' ? await morningFor(siteId) : await eveningFor(siteId)
    if (!msg) continue
    const { data: chans } = await (siteId ? supabase.from('notification_channels').select('chat_id').eq('section', 'resumen').eq('enabled', true).eq('site_id', siteId) : supabase.from('notification_channels').select('chat_id').eq('section', 'resumen').eq('enabled', true).is('site_id', null))
    for (const c of chans || []) {
      let status = 'enviado'; let detail = null; let sentTo = c.chat_id
      try { sentTo = await sendTo(st.bot_token, c.chat_id, withLink(msg.html, msg.path)); sent++ } catch (e) { status = 'error'; detail = e.message.slice(0, 300) }
      await supabase.from('notification_log').insert({ section: 'resumen', chat_id: sentTo, status, detail, site_id: siteId })
    }
  }
  return sent
}

// Tarea programada: cada 10 minutos revisa la hora de Colombia y envía cada resumen una vez al día.
const tick = async () => {
  const st = await loadSettings()
  if (!st?.enabled || !st.bot_token) return
  const today = todayBogota()
  const h = Number(new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', hour12: false }).format(new Date())) % 24
  if (st.morning_enabled && h >= st.morning_hour && h < st.evening_hour && st.last_morning_on !== today) {
    await supabase.from('notification_settings').update({ last_morning_on: today }).not('org_id', 'is', null)
    await sendSummary('morning')
  }
  if (st.evening_enabled && h >= st.evening_hour && st.last_evening_on !== today) {
    await supabase.from('notification_settings').update({ last_evening_on: today }).not('org_id', 'is', null)
    await sendSummary('evening')
  }
}
const startScheduler = () => {
  const run = () => forEachOrg(supabase, tick).catch((e) => console.error('Resúmenes de Telegram:', e.message))
  setTimeout(run, 30000).unref()
  setInterval(run, 10 * 60000).unref()
}

module.exports = { SECTIONS, tg, esc, loadSettings, onAudit, notify, sendSummary, startScheduler, morningFor, eveningFor }
