// =====================================================================
// Cobro (KU-011): rutero del día, visitas, morosos, mapa, gastos y cierre de jornada.
// · Rutero: créditos activos del prestamista con cuotas vencidas o que vencen ese día, en el orden de la ruta.
// · Visitas: resultado de cada visita sin pago (no pagó, no estaba, promesa de pago).
// · Gastos: salen de la caja del prestamista (o del negocio). Cierre: cuadre del efectivo del día.
// La plata y las reglas viven en la base (register_expense, void_expense, day_summary, close_day).
// =====================================================================
const express = require('express')
const supabase = require('../db')
const { currentOrg } = require('../tenant')
const { h, fail, clean, todayBogota, imageError } = require('../http')
const { auth, ADMIN, STAFF } = require('../auth')
const { audit } = require('../audit')

const router = express.Router()
const fullName = (x) => (x ? `${x.name} ${x.last_name || ''}`.trim() : null)
const ISO = /^\d{4}-\d{2}-\d{2}$/
const n = (v) => Number(v || 0)
const sum = (rows, f) => rows.reduce((s, r) => s + f(r), 0)
const daysBetween = (a, b) => Math.round((new Date(`${b}T12:00:00Z`) - new Date(`${a}T12:00:00Z`)) / 86400000)

const VISIT_LABELS = { no_pago: 'No pagó', no_estaba: 'No estaba', promesa: 'Promesa de pago', otro: 'Otro' }
const EXPENSE_LABELS = { combustible: 'Combustible', alimentacion: 'Alimentación', transporte: 'Transporte', mantenimiento: 'Mantenimiento', papeleria: 'Papelería', comunicaciones: 'Comunicaciones', otro: 'Otro' }

// El prestamista solo ve lo suyo; el administrador elige (?prestamista=).
const lenderScope = (req) => (req.user.role === 'prestamista' ? req.user.id : (Number(req.query.prestamista || req.body?.lenderId) || null))
const dayParam = (v) => (ISO.test(v || '') && v <= todayBogota() ? v : todayBogota())

const latestBy = (rows, key) => {
  const m = {}
  for (const r of rows) if (!m[r[key]] || r.id > m[r[key]].id) m[r[key]] = r
  return m
}

// ---------------------------------------------------------------------
// Rutero del día
// ---------------------------------------------------------------------
const buildRoute = async (lenderId, day, all = false) => {
  const { data: credits, error } = await supabase.from('credits')
    .select('id, number, kind, installment_amount, frequency, customer:customers(id, name, last_name, identification, phone, address, neighborhood, lat, lng, photo_thumb, route_order)')
    .eq('lender_id', lenderId).eq('status', 'activo')
  if (error) throw error
  const ids = credits.map((c) => c.id)
  if (!ids.length) return { day, rows: [], totals: { stops: 0, toCollect: 0, collected: 0, pending: 0, paid: 0, visited: 0, overdue: 0 } }
  const [{ data: inst }, { data: pays }, { data: visits }, { data: bal }] = await Promise.all([
    supabase.from('installments').select('credit_id, number, due_date, amount, paid_amount, waived').in('credit_id', ids).in('status', ['pendiente', 'parcial']).order('due_date'),
    supabase.from('payments').select('id, credit_id, amount, method, number').in('credit_id', ids).eq('paid_on', day).eq('status', 'aplicado').neq('kind', 'renovacion'),
    supabase.from('visits').select('id, credit_id, result, note, promise_date').in('credit_id', ids).eq('visited_on', day),
    supabase.from('credit_balances').select('credit_id, balance').in('credit_id', ids)
  ])
  const balance = Object.fromEntries((bal || []).map((b) => [b.credit_id, n(b.balance)]))
  const lastVisit = latestBy(visits || [], 'credit_id')
  const rows = credits.map((c) => {
    const own = (inst || []).filter((i) => i.credit_id === c.id)
    const due = own.filter((i) => i.due_date <= day)
    const left = (i) => n(i.amount) - n(i.paid_amount) - n(i.waived)
    const dueAmount = sum(due, left)
    const overdue = sum(due.filter((i) => i.due_date < day), left)
    const paidToday = sum((pays || []).filter((p) => p.credit_id === c.id), (p) => n(p.amount))
    const v = lastVisit[c.id]
    const status = paidToday > 0 ? (dueAmount > 0 ? 'parcial' : 'cobrado') : v ? v.result : 'pendiente'
    const next = own.find((i) => i.due_date > day)
    return {
      creditId: c.id, number: c.number, kind: c.kind, installmentAmount: n(c.installment_amount), balance: balance[c.id] ?? 0,
      customer: { id: c.customer.id, fullName: fullName(c.customer), identification: c.customer.identification, phone: c.customer.phone, address: c.customer.address, neighborhood: c.customer.neighborhood, lat: c.customer.lat, lng: c.customer.lng, photoThumb: c.customer.photo_thumb, routeOrder: c.customer.route_order },
      dueAmount, dueCount: due.length, overdue, overdueCount: due.filter((i) => i.due_date < day).length, oldestDue: due[0]?.due_date || null,
      nextDueDate: next?.due_date || null, paidToday, status, statusLabel: status === 'cobrado' ? 'Cobrado' : status === 'parcial' ? 'Abonó' : status === 'pendiente' ? 'Pendiente' : VISIT_LABELS[status],
      visit: v ? { result: v.result, label: VISIT_LABELS[v.result], note: v.note, promiseDate: v.promise_date } : null
    }
  }).filter((r) => all || r.dueAmount > 0 || r.paidToday > 0)
    .sort((a, b) => (a.customer.routeOrder ?? 1e9) - (b.customer.routeOrder ?? 1e9) || a.customer.fullName.localeCompare(b.customer.fullName))
  return {
    day,
    rows,
    totals: {
      stops: rows.length,
      toCollect: sum(rows, (r) => r.dueAmount + r.paidToday),
      collected: sum(rows, (r) => r.paidToday),
      pending: sum(rows, (r) => r.dueAmount),
      overdue: sum(rows, (r) => r.overdue),
      paid: rows.filter((r) => r.paidToday > 0).length,
      visited: rows.filter((r) => !r.paidToday && r.visit).length
    }
  }
}

router.get('/ruta', auth(STAFF), h(async (req, res) => {
  const lender = lenderScope(req)
  if (!lender) return fail(res, 'Elige un prestamista', 400)
  const day = dayParam(req.query.fecha)
  const [route, { data: closure }] = await Promise.all([
    buildRoute(lender, day, req.query.todos === '1'),
    supabase.from('route_closures').select('id, created_at').eq('lender_id', lender).eq('day', day).maybeSingle()
  ])
  res.send({ ...route, closed: Boolean(closure), closedAt: closure?.created_at || null })
}))

// Orden de la ruta: lista de clientes en el orden de visita.
router.put('/ruta/orden', auth(STAFF), h(async (req, res) => {
  const ids = (Array.isArray(req.body?.customerIds) ? req.body.customerIds : []).map(Number).filter(Boolean)
  if (!ids.length) return fail(res, 'Sin clientes para ordenar', 400)
  let q = supabase.from('customers').select('id').in('id', ids)
  if (req.user.role === 'prestamista') q = q.eq('lender_id', req.user.id)
  const { data } = await q
  const allowed = new Set((data || []).map((c) => c.id))
  await Promise.all(ids.filter((id) => allowed.has(id)).map((id, i) => supabase.from('customers').update({ route_order: i + 1 }).eq('id', id)))
  res.send({ ok: true })
}))

// Resumen de todas las rutas (administrador).
router.get('/rutas', auth(ADMIN), h(async (req, res) => {
  const day = dayParam(req.query.fecha)
  const { data: lenders } = await supabase.from('users').select('id, name, last_name').eq('role', 'prestamista').eq('active', true).order('name')
  const { data: closures } = await supabase.from('route_closures').select('lender_id, difference, counted_cash').eq('day', day)
  const rows = await Promise.all((lenders || []).map(async (l) => {
    const [route, { data: s }] = await Promise.all([buildRoute(l.id, day), supabase.rpc('day_summary', { p_org: currentOrg(), p_lender: l.id, p_day: day })])
    const c = (closures || []).find((x) => x.lender_id === l.id)
    return {
      lender: { id: l.id, fullName: fullName(l) }, ...route.totals,
      collectedCash: n(s?.collected_cash), collectedOther: n(s?.collected_other), expenses: n(s?.expenses), disbursed: n(s?.disbursed), cash: n(s?.balance),
      closed: Boolean(c), difference: c ? n(c.difference) : null
    }
  }))
  res.send({ day, rows })
}))

// ---------------------------------------------------------------------
// Visitas
// ---------------------------------------------------------------------
router.post('/visitas', auth(STAFF), h(async (req, res) => {
  const b = req.body || {}
  let q = supabase.from('credits').select('id, customer_id, lender_id, status').eq('id', Number(b.creditId))
  if (req.user.role === 'prestamista') q = q.eq('lender_id', req.user.id)
  const { data: c } = await q.maybeSingle()
  if (!c) return fail(res, 'Crédito no encontrado', 404)
  if (!VISIT_LABELS[b.result]) return fail(res, 'Elige el resultado de la visita', 400)
  if (b.result === 'promesa' && !ISO.test(b.promiseDate || '')) return fail(res, 'Indica la fecha en que promete pagar', 400)
  if (b.result === 'promesa' && b.promiseDate < todayBogota()) return fail(res, 'La fecha de la promesa no puede ser pasada', 400)
  const { data, error } = await supabase.from('visits').insert({
    credit_id: c.id, customer_id: c.customer_id, lender_id: c.lender_id, visited_on: todayBogota(), result: b.result,
    promise_date: b.result === 'promesa' ? b.promiseDate : null, note: clean(b.note), lat: b.lat ?? null, lng: b.lng ?? null, user_id: req.user.id
  }).select('id').single()
  if (error) throw error
  await audit(req, 'visita', 'credito', c.id, { result: b.result })
  res.status(201).send({ id: data.id })
}))

router.get('/creditos/:id/visitas', auth(STAFF), h(async (req, res) => {
  const { data, error } = await supabase.from('visits').select('id, visited_on, result, promise_date, note, created_at, user:users!visits_user_id_fkey(name, last_name)').eq('credit_id', Number(req.params.id)).order('id', { ascending: false }).limit(50)
  if (error) throw error
  res.send(data.map((v) => ({ id: v.id, visitedOn: v.visited_on, result: v.result, label: VISIT_LABELS[v.result], promiseDate: v.promise_date, note: v.note, createdAt: v.created_at, user: fullName(v.user) })))
}))

// ---------------------------------------------------------------------
// Morosos
// ---------------------------------------------------------------------
const TIERS = [['1-7', 1, 7], ['8-30', 8, 30], ['31-60', 31, 60], ['60+', 61, Infinity]]

router.get('/morosos', auth(STAFF), h(async (req, res) => {
  const today = todayBogota()
  let q = supabase.from('credits').select('id, number, kind, installment_amount, customer:customers(id, name, last_name, identification, phone, address, neighborhood, photo_thumb, lat, lng), lender:users!credits_lender_id_fkey(id, name, last_name)').eq('status', 'activo')
  const lender = lenderScope(req)
  if (lender) q = q.eq('lender_id', lender)
  const { data: credits, error } = await q
  if (error) throw error
  const ids = credits.map((c) => c.id)
  if (!ids.length) return res.send({ rows: [], totals: { count: 0, overdue: 0, balance: 0 }, tiers: TIERS.map(([k]) => ({ key: k, count: 0, overdue: 0 })) })
  const { data: bal } = await supabase.from('credit_balances').select('credit_id, balance, overdue_amount, overdue_count').in('credit_id', ids).gt('overdue_count', 0)
  const late = (bal || []).map((b) => b.credit_id)
  if (!late.length) return res.send({ rows: [], totals: { count: 0, overdue: 0, balance: 0 }, tiers: TIERS.map(([k]) => ({ key: k, count: 0, overdue: 0 })) })
  const [{ data: inst }, { data: pays }, { data: visits }] = await Promise.all([
    supabase.from('installments').select('credit_id, due_date').in('credit_id', late).in('status', ['pendiente', 'parcial']).lt('due_date', today).order('due_date'),
    supabase.from('payments').select('id, credit_id, paid_on, amount').in('credit_id', late).eq('status', 'aplicado').neq('kind', 'renovacion'),
    supabase.from('visits').select('id, credit_id, visited_on, result, promise_date, note').in('credit_id', late)
  ])
  const lastPay = latestBy(pays || [], 'credit_id')
  const lastVisit = latestBy(visits || [], 'credit_id')
  let rows = (bal || []).map((b) => {
    const c = credits.find((x) => x.id === b.credit_id)
    const oldest = (inst || []).find((i) => i.credit_id === b.credit_id)?.due_date || today
    const daysLate = daysBetween(oldest, today)
    const v = lastVisit[b.credit_id]
    return {
      creditId: c.id, number: c.number, kind: c.kind, installmentAmount: n(c.installment_amount),
      customer: { id: c.customer.id, fullName: fullName(c.customer), identification: c.customer.identification, phone: c.customer.phone, address: c.customer.address, neighborhood: c.customer.neighborhood, photoThumb: c.customer.photo_thumb, lat: c.customer.lat, lng: c.customer.lng },
      lender: c.lender ? { id: c.lender.id, fullName: fullName(c.lender) } : null,
      balance: n(b.balance), overdue: n(b.overdue_amount), overdueCount: b.overdue_count, oldestDue: oldest, daysLate,
      tier: TIERS.find(([, a, z]) => daysLate >= a && daysLate <= z)?.[0] || '1-7',
      lastPayment: lastPay[b.credit_id] ? { paidOn: lastPay[b.credit_id].paid_on, amount: n(lastPay[b.credit_id].amount) } : null,
      lastVisit: v ? { visitedOn: v.visited_on, label: VISIT_LABELS[v.result], result: v.result, promiseDate: v.promise_date, note: v.note } : null
    }
  }).sort((a, b) => b.daysLate - a.daysLate || b.overdue - a.overdue)
  const tiers = TIERS.map(([k]) => ({ key: k, count: rows.filter((r) => r.tier === k).length, overdue: sum(rows.filter((r) => r.tier === k), (r) => r.overdue) }))
  if (req.query.tramo) rows = rows.filter((r) => r.tier === req.query.tramo)
  res.send({ rows, tiers, totals: { count: rows.length, overdue: sum(rows, (r) => r.overdue), balance: sum(rows, (r) => r.balance) } })
}))

// ---------------------------------------------------------------------
// Mapa de clientes
// ---------------------------------------------------------------------
router.get('/mapa', auth(STAFF), h(async (req, res) => {
  const today = todayBogota()
  let q = supabase.from('customers').select('id, name, last_name, identification, phone, address, neighborhood, lat, lng, photo_thumb, lender:users!customers_lender_id_fkey(id, name, last_name)').not('lat', 'is', null).not('lng', 'is', null).neq('status', 'inactivo')
  const lender = lenderScope(req)
  if (lender) q = q.eq('lender_id', lender)
  const { data: customers, error } = await q
  if (error) throw error
  const ids = customers.map((c) => c.id)
  const { data: credits } = ids.length ? await supabase.from('credits').select('id, customer_id').in('customer_id', ids).eq('status', 'activo') : { data: [] }
  const cids = (credits || []).map((c) => c.id)
  const [{ data: bal }, { data: pays }] = cids.length
    ? await Promise.all([supabase.from('credit_balances').select('credit_id, balance, overdue_amount').in('credit_id', cids), supabase.from('payments').select('credit_id, amount').in('credit_id', cids).eq('paid_on', today).eq('status', 'aplicado')])
    : [{ data: [] }, { data: [] }]
  const rows = customers.map((c) => {
    const mine = (credits || []).filter((k) => k.customer_id === c.id).map((k) => k.id)
    const b = (bal || []).filter((x) => mine.includes(x.credit_id))
    const overdue = sum(b, (x) => n(x.overdue_amount))
    const paidToday = sum((pays || []).filter((p) => mine.includes(p.credit_id)), (p) => n(p.amount))
    return {
      id: c.id, fullName: fullName(c), identification: c.identification, phone: c.phone, address: c.address, neighborhood: c.neighborhood,
      lat: Number(c.lat), lng: Number(c.lng), photoThumb: c.photo_thumb, lender: c.lender ? fullName(c.lender) : null,
      activeCredits: mine.length, balance: sum(b, (x) => n(x.balance)), overdue, paidToday,
      status: !mine.length ? 'sin_credito' : paidToday > 0 ? 'cobrado' : overdue > 0 ? 'mora' : 'al_dia'
    }
  })
  res.send(rows)
}))

// ---------------------------------------------------------------------
// Gastos
// ---------------------------------------------------------------------
const expenseDTO = (e) => ({
  id: e.id, number: e.number, category: e.category, categoryLabel: EXPENSE_LABELS[e.category], amount: n(e.amount), spentOn: e.spent_on, note: e.note,
  photoUrl: e.photo_url, status: e.status, voidReason: e.void_reason, createdAt: e.created_at,
  lender: e.lender ? { id: e.lender.id, fullName: fullName(e.lender) } : null, user: fullName(e.user)
})
const EXP_SELECT = 'id, number, category, amount, spent_on, note, photo_url, status, void_reason, created_at, lender:users!expenses_lender_id_fkey(id, name, last_name), user:users!expenses_user_id_fkey(name, last_name)'

router.get('/gastos', auth(STAFF), h(async (req, res) => {
  let q = supabase.from('expenses').select(EXP_SELECT).order('spent_on', { ascending: false }).order('id', { ascending: false }).limit(500)
  if (req.user.role === 'prestamista') q = q.eq('lender_id', req.user.id)
  else if (req.query.prestamista === 'negocio') q = q.is('lender_id', null)
  else if (Number(req.query.prestamista)) q = q.eq('lender_id', Number(req.query.prestamista))
  if (ISO.test(req.query.desde || '')) q = q.gte('spent_on', req.query.desde)
  if (ISO.test(req.query.hasta || '')) q = q.lte('spent_on', req.query.hasta)
  if (EXPENSE_LABELS[req.query.categoria]) q = q.eq('category', req.query.categoria)
  const { data, error } = await q
  if (error) throw error
  const rows = data.map(expenseDTO)
  const ok = rows.filter((e) => e.status === 'aplicado')
  const byCategory = Object.keys(EXPENSE_LABELS).map((k) => ({ key: k, label: EXPENSE_LABELS[k], amount: sum(ok.filter((e) => e.category === k), (e) => e.amount) })).filter((c) => c.amount > 0)
  res.send({ rows, totals: { count: ok.length, amount: sum(ok, (e) => e.amount) }, byCategory })
}))

router.post('/gastos', auth(STAFF), h(async (req, res) => {
  const b = req.body || {}
  if (!EXPENSE_LABELS[b.category]) return fail(res, 'Elige la categoría del gasto', 400)
  const amount = Math.round(Number(b.amount))
  if (!(amount > 0)) return fail(res, 'Ingresa el valor del gasto', 400)
  const spentOn = b.spentOn || todayBogota()
  if (!ISO.test(spentOn) || spentOn > todayBogota()) return fail(res, 'Fecha del gasto inválida (no puede ser futura)', 400)
  if (req.user.role === 'prestamista' && spentOn !== todayBogota()) return fail(res, 'El prestamista solo registra gastos con fecha de hoy', 400)
  const imgErr = imageError(b.photoUrl, 2000)
  if (imgErr) return fail(res, `Soporte: ${imgErr}`, 400)
  let lenderId = req.user.role === 'prestamista' ? req.user.id : (Number(b.lenderId) || null)
  if (lenderId && req.user.role === 'administrador') {
    const { data: l } = await supabase.from('users').select('id').eq('id', lenderId).eq('role', 'prestamista').maybeSingle()
    if (!l) return fail(res, 'Prestamista no válido', 400)
  }
  const { data: id, error } = await supabase.rpc('register_expense', {
    p: { org_id: currentOrg(), lender_id: lenderId, category: b.category, amount, spent_on: spentOn, note: clean(b.note), photo_url: clean(b.photoUrl), user_id: req.user.id }
  })
  if (error) return error.code === 'P0001' ? fail(res, error.message, 400) : fail(res, error)
  await audit(req, 'crear', 'gasto', id, { amount, category: b.category })
  const { data } = await supabase.from('expenses').select(EXP_SELECT).eq('id', id).single()
  res.status(201).send(expenseDTO(data))
}))

router.post('/gastos/:id/anular', auth(ADMIN), h(async (req, res) => {
  const reason = clean(req.body?.reason)
  if (!reason) return fail(res, 'Escribe el motivo de la anulación', 400)
  const { error } = await supabase.rpc('void_expense', { p_org: currentOrg(), p_expense: Number(req.params.id), p_reason: reason, p_user: req.user.id })
  if (error) return error.code === 'P0001' ? fail(res, error.message, 400) : fail(res, error)
  await audit(req, 'anular', 'gasto', Number(req.params.id), { reason })
  const { data } = await supabase.from('expenses').select(EXP_SELECT).eq('id', Number(req.params.id)).single()
  res.send(expenseDTO(data))
}))

// ---------------------------------------------------------------------
// Cierre de jornada
// ---------------------------------------------------------------------
const closureDTO = (c) => ({
  id: c.id, day: c.day, lender: c.lender ? { id: c.lender.id, fullName: fullName(c.lender) } : null,
  collectedCash: n(c.collected_cash), collectedOther: n(c.collected_other), disbursed: n(c.disbursed), expenses: n(c.expenses),
  received: n(c.received), delivered: n(c.delivered), expectedCash: n(c.expected_cash), countedCash: n(c.counted_cash), difference: n(c.difference),
  visits: c.visits, payments: c.payments, deliveryRef: c.delivery_ref, note: c.note, closedBy: fullName(c.closer), createdAt: c.created_at
})
const CL_SELECT = '*, lender:users!route_closures_lender_id_fkey(id, name, last_name), closer:users!route_closures_closed_by_fkey(name, last_name)'

// Lo que se ve antes de cerrar: números del día, ruta pendiente y si ya está cerrada.
router.get('/cierres/resumen', auth(STAFF), h(async (req, res) => {
  const lender = lenderScope(req)
  if (!lender) return fail(res, 'Elige un prestamista', 400)
  const day = dayParam(req.query.fecha)
  const [{ data: s, error }, route, { data: closure }] = await Promise.all([
    supabase.rpc('day_summary', { p_org: currentOrg(), p_lender: lender, p_day: day }),
    buildRoute(lender, day),
    supabase.from('route_closures').select(CL_SELECT).eq('lender_id', lender).eq('day', day).maybeSingle()
  ])
  if (error) throw error
  res.send({
    day, lenderId: lender,
    collectedCash: n(s.collected_cash), collectedOther: n(s.collected_other), payments: s.payments, expenses: n(s.expenses), disbursed: n(s.disbursed),
    received: n(s.received), delivered: n(s.delivered), visits: s.visits, cash: n(s.balance),
    route: route.totals, unvisited: route.rows.filter((r) => r.status === 'pendiente').length,
    closure: closure ? closureDTO(closure) : null
  })
}))

router.post('/cierres', auth(STAFF), h(async (req, res) => {
  const b = req.body || {}
  const lender = req.user.role === 'prestamista' ? req.user.id : Number(b.lenderId)
  if (!lender) return fail(res, 'Elige un prestamista', 400)
  const day = req.user.role === 'prestamista' ? todayBogota() : dayParam(b.day)
  const counted = Math.round(Number(b.countedCash))
  if (!(counted >= 0) || b.countedCash === '' || b.countedCash === null || b.countedCash === undefined) return fail(res, 'Escribe el efectivo que tienes en mano', 400)
  const { data: id, error } = await supabase.rpc('close_day', {
    p: { org_id: currentOrg(), lender_id: lender, day, counted_cash: counted, deliver: Math.round(Number(b.deliver) || 0), note: clean(b.note), user_id: req.user.id }
  })
  if (error) return error.code === 'P0001' ? fail(res, error.message, 400) : fail(res, error)
  await audit(req, 'cerrar_jornada', 'prestamista', lender, { day, counted, deliver: Number(b.deliver) || 0 })
  const { data } = await supabase.from('route_closures').select(CL_SELECT).eq('id', id).single()
  res.status(201).send(closureDTO(data))
}))

router.get('/cierres', auth(STAFF), h(async (req, res) => {
  let q = supabase.from('route_closures').select(CL_SELECT).order('day', { ascending: false }).order('id', { ascending: false }).limit(200)
  const lender = lenderScope(req)
  if (lender) q = q.eq('lender_id', lender)
  if (ISO.test(req.query.desde || '')) q = q.gte('day', req.query.desde)
  if (ISO.test(req.query.hasta || '')) q = q.lte('day', req.query.hasta)
  const { data, error } = await q
  if (error) throw error
  res.send(data.map(closureDTO))
}))

// Reabrir una jornada (administrador). La entrega de efectivo ya hecha se mantiene.
router.delete('/cierres/:id', auth(ADMIN), h(async (req, res) => {
  const { data: c } = await supabase.from('route_closures').select('id, lender_id, day').eq('id', Number(req.params.id)).maybeSingle()
  if (!c) return fail(res, 'Cierre no encontrado', 404)
  const { error } = await supabase.from('route_closures').delete().eq('id', c.id)
  if (error) throw error
  await audit(req, 'reabrir_jornada', 'prestamista', c.lender_id, { day: c.day })
  res.send({ ok: true })
}))

module.exports = router
module.exports.buildRoute = buildRoute
