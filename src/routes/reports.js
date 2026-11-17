// =====================================================================
// Reportes (KU-013) y buscador inteligente.
// · Recaudo, colocación, cartera y resultados (intereses cobrados − gastos) por rango y prestamista.
// · /buscar: busca a la vez clientes, créditos, recibos, gastos, productos y usuarios, y entiende atajos
//   como "#12" (crédito), "RC-0003" (recibo), "GA-0002" (gasto) o un número de documento o celular.
// =====================================================================
const express = require('express')
const supabase = require('../db')
const { h, fail, clean, todayBogota } = require('../http')
const { auth, ADMIN, STAFF } = require('../auth')
const { bySite, byLenders } = require('../site')

const router = express.Router()
const fullName = (x) => (x ? `${x.name} ${x.last_name || ''}`.trim() : null)
const ISO = /^\d{4}-\d{2}-\d{2}$/
const n = (v) => Number(v || 0)
const sum = (rows, f) => rows.reduce((s, r) => s + f(r), 0)
const daysBetween = (a, b) => Math.round((new Date(`${b}T12:00:00Z`) - new Date(`${a}T12:00:00Z`)) / 86400000)
const addDays = (d, k) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + k); return x.toISOString().slice(0, 10) }

// Rango: por defecto el mes en curso. Máximo un año.
const range = (q) => {
  const today = todayBogota()
  let hasta = ISO.test(q.hasta || '') ? q.hasta : today
  let desde = ISO.test(q.desde || '') ? q.desde : `${today.slice(0, 8)}01`
  if (desde > hasta) [desde, hasta] = [hasta, desde]
  if (daysBetween(desde, hasta) > 366) desde = addDays(hasta, -366)
  return { desde, hasta }
}
const days = (desde, hasta) => { const out = []; for (let d = desde; d <= hasta; d = addDays(d, 1)) out.push(d); return out }
// Agrupa por día si el rango es corto y por mes si es largo.
const bucketOf = (desde, hasta) => (daysBetween(desde, hasta) > 62 ? (d) => d.slice(0, 7) : (d) => d)
const buckets = (desde, hasta) => { const f = bucketOf(desde, hasta); return [...new Set(days(desde, hasta).map(f))] }

const lenders = async () => {
  const { data } = await supabase.from('users').select('id, name, last_name, active').eq('role', 'prestamista').order('name')
  return data || []
}
const lenderName = (all, id) => (id ? fullName(all.find((l) => l.id === id)) || '—' : 'Negocio')

// ---------- Recaudo ----------
router.get('/reportes/recaudo', auth(ADMIN), h(async (req, res) => {
  const { desde, hasta } = range(req.query)
  let q = supabase.from('payments').select('id, kind, amount, method, paid_on, lender_id').eq('status', 'aplicado').neq('kind', 'renovacion').gte('paid_on', desde).lte('paid_on', hasta).limit(20000)
  if (Number(req.query.prestamista)) q = q.eq('lender_id', Number(req.query.prestamista))
  q = bySite(req, q)
  const [{ data: pays, error }, all] = await Promise.all([q, lenders()])
  if (error) throw error
  // Parte de interés de lo cobrado: proporcional al interés de cada cuota (el abono a capital es solo capital).
  const ids = pays.map((p) => p.id)
  let interest = 0
  for (let i = 0; i < ids.length; i += 500) {
    const { data: al } = await supabase.from('payment_allocations').select('amount, payment:payments!inner(kind), installment:installments(amount, interest)').in('payment_id', ids.slice(i, i + 500))
    interest += sum(al || [], (a) => (a.payment.kind === 'abono_capital' || !n(a.installment?.amount) ? 0 : n(a.amount) * n(a.installment.interest) / n(a.installment.amount)))
  }
  const key = bucketOf(desde, hasta)
  const series = buckets(desde, hasta).map((b) => {
    const rows = pays.filter((p) => key(p.paid_on) === b)
    return { label: b, efectivo: sum(rows.filter((p) => p.method === 'efectivo'), (p) => n(p.amount)), otros: sum(rows.filter((p) => p.method !== 'efectivo'), (p) => n(p.amount)) }
  })
  const byLender = [...new Set(pays.map((p) => p.lender_id))].map((id) => {
    const rows = pays.filter((p) => p.lender_id === id)
    return { lender: lenderName(all, id), count: rows.length, amount: sum(rows, (p) => n(p.amount)), cash: sum(rows.filter((p) => p.method === 'efectivo'), (p) => n(p.amount)), capital: sum(rows.filter((p) => p.kind === 'abono_capital'), (p) => n(p.amount)) }
  }).sort((a, b) => b.amount - a.amount)
  const amount = sum(pays, (p) => n(p.amount))
  // Detalle para el reporte en PDF (?detalle=1): cada pago con cliente y crédito.
  let rows
  if (req.query.detalle === '1') {
    const det = []
    for (let i = 0; i < ids.length && i < 2000; i += 500) {
      const { data } = await supabase.from('payments').select('id, number, kind, amount, method, paid_on, lender_id, credit:credits(number), customer:customers(name, last_name, identification)').in('id', ids.slice(i, i + 500))
      det.push(...(data || []))
    }
    rows = det.sort((a, b) => (a.paid_on === b.paid_on ? a.number - b.number : a.paid_on < b.paid_on ? -1 : 1)).map((p) => ({
      id: p.id, number: `RC-${String(p.number).padStart(4, '0')}`, date: p.paid_on, customer: fullName(p.customer), identification: p.customer?.identification,
      credit: p.credit?.number, lender: lenderName(all, p.lender_id), method: p.method, kind: p.kind, amount: n(p.amount)
    }))
  }
  res.send({
    desde, hasta, series, byLender, rows,
    totals: {
      count: pays.length, amount, cash: sum(pays.filter((p) => p.method === 'efectivo'), (p) => n(p.amount)), other: sum(pays.filter((p) => p.method !== 'efectivo'), (p) => n(p.amount)),
      abonos: sum(pays.filter((p) => p.kind === 'abono_capital'), (p) => n(p.amount)), interest: Math.round(interest), capital: Math.round(amount - interest),
      days: days(desde, hasta).length
    }
  })
}))

// ---------- Colocación ----------
router.get('/reportes/colocacion', auth(ADMIN), h(async (req, res) => {
  const { desde, hasta } = range(req.query)
  let q = supabase.from('credits').select('id, number, kind, principal, total_interest, total_amount, disbursed_amount, payoff_amount, renewed_from_id, disbursement_date, lender_id, status, customer:customers(name, last_name)')
    .neq('status', 'anulado').gte('disbursement_date', desde).lte('disbursement_date', hasta).order('disbursement_date', { ascending: false }).limit(5000)
  if (Number(req.query.prestamista)) q = q.eq('lender_id', Number(req.query.prestamista))
  q = bySite(req, q)
  const [{ data: cr, error }, all] = await Promise.all([q, lenders()])
  if (error) throw error
  const key = bucketOf(desde, hasta)
  const series = buckets(desde, hasta).map((b) => {
    const rows = cr.filter((c) => key(c.disbursement_date) === b)
    return { label: b, efectivo: sum(rows.filter((c) => c.kind === 'efectivo'), (c) => n(c.principal)), producto: sum(rows.filter((c) => c.kind === 'producto'), (c) => n(c.principal)) }
  })
  const byLender = [...new Set(cr.map((c) => c.lender_id))].map((id) => {
    const rows = cr.filter((c) => c.lender_id === id)
    return { lender: lenderName(all, id), count: rows.length, principal: sum(rows, (c) => n(c.principal)), interest: sum(rows, (c) => n(c.total_interest)), renewals: rows.filter((c) => c.renewed_from_id).length }
  }).sort((a, b) => b.principal - a.principal)
  res.send({
    desde, hasta, series, byLender,
    rows: cr.slice(0, 200).map((c) => ({ id: c.id, number: c.number, kind: c.kind, customer: fullName(c.customer), lender: lenderName(all, c.lender_id), date: c.disbursement_date, principal: n(c.principal), interest: n(c.total_interest), renewal: Boolean(c.renewed_from_id), status: c.status })),
    totals: {
      count: cr.length, principal: sum(cr, (c) => n(c.principal)), interest: sum(cr, (c) => n(c.total_interest)), total: sum(cr, (c) => n(c.total_amount)),
      cashOut: sum(cr.filter((c) => c.kind === 'efectivo'), (c) => n(c.disbursed_amount)), renewals: cr.filter((c) => c.renewed_from_id).length,
      product: sum(cr.filter((c) => c.kind === 'producto'), (c) => n(c.principal)), avgTicket: cr.length ? Math.round(sum(cr, (c) => n(c.principal)) / cr.length) : 0
    }
  })
}))

// ---------- Cartera (foto de hoy) ----------
const TIERS = [['Al día', -Infinity, 0], ['1-7', 1, 7], ['8-30', 8, 30], ['31-60', 31, 60], ['60+', 61, Infinity]]
const portfolio = async (lenderId = null) => { // un id, una lista (sede) o null
  const today = todayBogota()
  let q = supabase.from('credit_balances').select('credit_id, lender_id, customer_id, balance, capital_balance, overdue_amount, overdue_count, oldest_overdue_date').eq('status', 'activo')
  q = byLenders(q, lenderId)
  const { data: bal, error } = await q
  if (error) throw error
  return bal.map((b) => {
    const dl = b.oldest_overdue_date ? daysBetween(b.oldest_overdue_date, today) : 0
    return { ...b, daysLate: dl, tier: TIERS.find(([, a, z]) => dl >= a && dl <= z)[0] }
  })
}
const summarize = (rows) => {
  const balance = sum(rows, (r) => n(r.balance))
  const atRisk = sum(rows.filter((r) => r.daysLate > 0), (r) => n(r.balance))
  return {
    credits: rows.length, customers: new Set(rows.map((r) => r.customer_id)).size, balance, capital: sum(rows, (r) => n(r.capital_balance)),
    overdue: sum(rows, (r) => n(r.overdue_amount)), lateCredits: rows.filter((r) => r.daysLate > 0).length,
    par: balance ? Math.round((atRisk / balance) * 1000) / 10 : 0, par30: balance ? Math.round((sum(rows.filter((r) => r.daysLate > 30), (r) => n(r.balance)) / balance) * 1000) / 10 : 0
  }
}

router.get('/reportes/cartera', auth(ADMIN), h(async (req, res) => {
  const [rows, all] = await Promise.all([portfolio(Number(req.query.prestamista) || req.siteLenders), lenders()])
  // Detalle para el PDF: créditos atrasados, del más atrasado al menos.
  let late
  if (req.query.detalle === '1') {
    const lr = rows.filter((r) => r.daysLate > 0).sort((a, b) => b.daysLate - a.daysLate).slice(0, 1000)
    const cids = lr.map((r) => r.credit_id)
    const info = []
    for (let i = 0; i < cids.length; i += 500) {
      const { data } = await supabase.from('credits').select('id, number, customer:customers(name, last_name, phone, neighborhood)').in('id', cids.slice(i, i + 500))
      info.push(...(data || []))
    }
    late = lr.map((r) => { const c = info.find((x) => x.id === r.credit_id); return { credit: c?.number, customer: fullName(c?.customer), phone: c?.customer?.phone, neighborhood: c?.customer?.neighborhood, lender: lenderName(all, r.lender_id), daysLate: r.daysLate, overdueCount: r.overdue_count, overdue: n(r.overdue_amount), balance: n(r.balance) } })
  }
  res.send({
    late,
    totals: summarize(rows),
    tiers: TIERS.map(([k]) => { const r = rows.filter((x) => x.tier === k); return { key: k, credits: r.length, balance: sum(r, (x) => n(x.balance)), overdue: sum(r, (x) => n(x.overdue_amount)) } }),
    byLender: [...new Set(rows.map((r) => r.lender_id))].map((id) => ({ lender: lenderName(all, id), ...summarize(rows.filter((r) => r.lender_id === id)) })).sort((a, b) => b.balance - a.balance)
  })
}))

// ---------- Resultados: intereses cobrados − gastos ----------
router.get('/reportes/resultados', auth(ADMIN), h(async (req, res) => {
  const { desde, hasta } = range(req.query)
  const [{ data: pays }, { data: exps }, { data: cr }] = await Promise.all([
    bySite(req, supabase.from('payments').select('id, kind, amount, paid_on').eq('status', 'aplicado').neq('kind', 'renovacion').gte('paid_on', desde).lte('paid_on', hasta).limit(20000)),
    bySite(req, supabase.from('expenses').select('category, amount, spent_on').eq('status', 'aplicado').gte('spent_on', desde).lte('spent_on', hasta)),
    bySite(req, supabase.from('credits').select('discount_amount').neq('status', 'anulado').gte('disbursement_date', desde).lte('disbursement_date', hasta))
  ])
  const ids = (pays || []).map((p) => p.id)
  const intByPay = {}
  for (let i = 0; i < ids.length; i += 500) {
    const { data: al } = await supabase.from('payment_allocations').select('payment_id, amount, payment:payments!inner(kind), installment:installments(amount, interest)').in('payment_id', ids.slice(i, i + 500))
    for (const a of al || []) intByPay[a.payment_id] = (intByPay[a.payment_id] || 0) + (a.payment.kind === 'abono_capital' || !n(a.installment?.amount) ? 0 : n(a.amount) * n(a.installment.interest) / n(a.installment.amount))
  }
  const key = bucketOf(desde, hasta)
  const series = buckets(desde, hasta).map((b) => {
    const interest = Math.round(sum((pays || []).filter((p) => key(p.paid_on) === b), (p) => intByPay[p.id] || 0))
    const gastos = sum((exps || []).filter((e) => key(e.spent_on) === b), (e) => n(e.amount))
    return { label: b, intereses: interest, gastos, utilidad: interest - gastos }
  })
  const LABELS = { combustible: 'Combustible', alimentacion: 'Alimentación', transporte: 'Transporte', mantenimiento: 'Mantenimiento', papeleria: 'Papelería', comunicaciones: 'Comunicaciones', otro: 'Otro' }
  const interest = sum(series, (s) => s.intereses)
  const expenses = sum(exps || [], (e) => n(e.amount))
  res.send({
    desde, hasta, series,
    expensesByCategory: Object.keys(LABELS).map((k) => ({ key: k, label: LABELS[k], amount: sum((exps || []).filter((e) => e.category === k), (e) => n(e.amount)) })).filter((x) => x.amount > 0).sort((a, b) => b.amount - a.amount),
    totals: { interest, expenses, discounts: sum(cr || [], (c) => n(c.discount_amount)), profit: interest - expenses, margin: interest ? Math.round(((interest - expenses) / interest) * 1000) / 10 : 0 }
  })
}))

// ---------------------------------------------------------------------
// Buscador inteligente
// ---------------------------------------------------------------------
router.get('/buscar', auth(STAFF), h(async (req, res) => {
  const raw = clean(req.query.q) || ''
  if (raw.length < 2) return res.send({ q: raw, groups: [] })
  const admin = req.user.role === 'administrador'
  const mine = (q, col = 'lender_id') => (admin ? q : q.eq(col, req.user.id))
  const t = raw.replace(/[%,()]/g, ' ').trim()
  const digits = t.replace(/\D/g, '')
  const creditNo = (t.match(/^(?:#|cr[eé]dito\s*#?\s*)(\d+)$/i) || [])[1]
  const receiptNo = (t.match(/^rc-?\s*(\d+)$/i) || [])[1]
  const expenseNo = (t.match(/^ga-?\s*(\d+)$/i) || [])[1]
  const tasks = []

  // Clientes: nombre, apellido, documento o celular (también "nombre apellido").
  const words = t.split(/\s+/).filter(Boolean)
  let cq = mine(supabase.from('customers').select('id, name, last_name, identification, phone, neighborhood, status, photo_thumb'))
  if (words.length > 1 && !digits) cq = cq.ilike('name', `%${words[0]}%`).ilike('last_name', `%${words.slice(1).join(' ')}%`)
  else cq = cq.or(`name.ilike.%${t}%,last_name.ilike.%${t}%,identification.ilike.%${digits || t}%,phone.ilike.%${digits || t}%`)
  tasks.push(cq.order('name').limit(6).then(({ data }) => ({
    key: 'clientes', label: 'Clientes',
    items: (data || []).map((c) => ({ id: c.id, title: fullName(c), subtitle: `${c.identification} · ${c.phone}${c.neighborhood ? ` · ${c.neighborhood}` : ''}`, badge: c.status !== 'activo' ? c.status : null, image: c.photo_thumb, to: `/clientes/${c.id}` }))
  })))

  // Créditos: por número (#12) o por el nombre del cliente.
  const crq = creditNo || (digits && digits.length <= 5 && digits === t)
    ? mine(supabase.from('credits').select('id, number, kind, status, customer:customers(name, last_name)')).eq('number', Number(creditNo || digits)).limit(3)
    : mine(supabase.from('credits').select('id, number, kind, status, customer:customers!inner(name, last_name)')).or(`name.ilike.%${t}%,last_name.ilike.%${t}%`, { foreignTable: 'customers' }).order('number', { ascending: false }).limit(5)
  tasks.push(crq.then(({ data }) => ({
    key: 'creditos', label: 'Créditos',
    items: (data || []).map((c) => ({ id: c.id, title: `Crédito #${c.number}`, subtitle: `${fullName(c.customer)} · ${c.kind === 'producto' ? 'Producto' : 'Efectivo'}`, badge: c.status, to: `/creditos/${c.id}` }))
  })))

  if (receiptNo) {
    tasks.push(mine(supabase.from('payments').select('id, number, amount, paid_on, credit_id, customer:customers(name, last_name)')).eq('number', Number(receiptNo)).limit(3).then(({ data }) => ({
      key: 'pagos', label: 'Recibos',
      items: (data || []).map((p) => ({ id: p.id, title: `Recibo RC-${String(p.number).padStart(4, '0')}`, subtitle: `${fullName(p.customer)} · $ ${n(p.amount).toLocaleString('es-CO')} · ${p.paid_on}`, to: `/creditos/${p.credit_id}` }))
    })))
  }
  if (expenseNo || /gasto/i.test(t)) {
    let eq = mine(supabase.from('expenses').select('id, number, amount, category, spent_on'))
    eq = expenseNo ? eq.eq('number', `GA-${String(expenseNo).padStart(4, '0')}`) : eq.order('id', { ascending: false })
    tasks.push(eq.limit(4).then(({ data }) => ({ key: 'gastos', label: 'Gastos', items: (data || []).map((e) => ({ id: e.id, title: e.number, subtitle: `${e.category} · $ ${n(e.amount).toLocaleString('es-CO')} · ${e.spent_on}`, to: '/gastos' })) })))
  }
  if (t.length >= 3) {
    tasks.push(mine(supabase.from('vehicles').select('id, code, plate, kind, brand, line'), 'collector_id').or(`plate.ilike.%${t.replace(/\s+/g, '')}%,code.ilike.%${t}%,brand.ilike.%${t}%`).limit(3).then(({ data }) => ({
      key: 'vehiculos', label: 'Vehículos', items: (data || []).map((v) => ({ id: v.id, title: `${v.plate} · Móvil ${v.code}`, subtitle: [v.kind, v.brand, v.line].filter(Boolean).join(' · '), to: `/vehiculos/${v.id}` }))
    })))
  }
  if (admin && !digits) {
    tasks.push(supabase.from('products').select('id, sku, name, price').or(`name.ilike.%${t}%,sku.ilike.%${t}%,brand.ilike.%${t}%`).limit(4).then(({ data }) => ({
      key: 'productos', label: 'Productos', items: (data || []).map((p) => ({ id: p.id, title: p.name, subtitle: `${p.sku} · $ ${n(p.price).toLocaleString('es-CO')}`, to: '/inventario' }))
    })))
    tasks.push(supabase.from('users').select('id, name, last_name, username, role').neq('role', 'cliente').or(`name.ilike.%${t}%,last_name.ilike.%${t}%,username.ilike.%${t}%`).limit(4).then(({ data }) => ({
      key: 'usuarios', label: 'Usuarios', items: (data || []).map((u) => ({ id: u.id, title: fullName(u), subtitle: `${u.username} · ${u.role}`, to: u.role === 'prestamista' ? `/rutas/${u.id}` : '/usuarios' }))
    })))
  }
  const groups = (await Promise.all(tasks)).filter((g) => g.items.length)
  res.send({ q: raw, groups })
}))

// ---------------------------------------------------------------------
// Datos extra del dashboard (KU-013)
// ---------------------------------------------------------------------
router.get('/dashboard/extra', auth(STAFF), h(async (req, res) => {
  const today = todayBogota()
  const from = addDays(today, -13)
  const admin = req.user.role === 'administrador'
  let pq = supabase.from('payments').select('amount, paid_on, lender_id').eq('status', 'aplicado').neq('kind', 'renovacion').gte('paid_on', from)
  pq = admin ? bySite(req, pq) : pq.eq('lender_id', req.user.id)
  const [{ data: pays }, rows] = await Promise.all([pq, portfolio(admin ? req.siteLenders : req.user.id)])
  const daily = days(from, today).map((d) => ({ label: d, recaudado: sum((pays || []).filter((p) => p.paid_on === d), (p) => n(p.amount)) }))
  const out = { daily, portfolio: summarize(rows), tiers: TIERS.map(([k]) => ({ key: k, balance: sum(rows.filter((x) => x.tier === k), (x) => n(x.balance)) })) }

  if (admin) {
    const { buildRoute } = require('./collection')
    const all = (await lenders()).filter((l) => l.active && (!req.siteLenders || req.siteLenders.includes(l.id)))
    const { data: closures } = await supabase.from('route_closures').select('lender_id').eq('day', today)
    out.routes = await Promise.all(all.map(async (l) => {
      const r = await buildRoute(l.id, today)
      return { id: l.id, lender: fullName(l), toCollect: r.totals.toCollect, collected: r.totals.collected, stops: r.totals.stops, done: r.totals.paid + r.totals.visited, closed: (closures || []).some((c) => c.lender_id === l.id) }
    }))
    const [{ count: reqs }, { count: trs }] = await Promise.all([
      bySite(req, supabase.from('credit_requests').select('id', { count: 'exact', head: true }).eq('status', 'pendiente')),
      bySite(req, supabase.from('cash_transfers').select('id', { count: 'exact', head: true }).eq('status', 'pendiente'), 'from_lender_id')
    ])
    const { alertsOf } = require('./vehicles')
    const { data: veh } = await bySite(req, supabase.from('vehicles').select('*').neq('status', 'inactivo'), 'collector_id')
    const vehicleAlerts = (veh || []).filter((v) => alertsOf(v, undefined, today).some((a) => a.level === 'bad')).length
    out.pending = { creditRequests: reqs || 0, cashTransfers: trs || 0, vehicleAlerts }
    const late = rows.filter((r) => r.daysLate > 0).sort((a, b) => n(b.overdue_amount) - n(a.overdue_amount)).slice(0, 5)
    if (late.length) {
      const { data: cr } = await supabase.from('credits').select('id, number, customer:customers(name, last_name, photo_thumb)').in('id', late.map((r) => r.credit_id))
      out.topLate = late.map((r) => { const c = (cr || []).find((x) => x.id === r.credit_id); return { creditId: r.credit_id, number: c?.number, customer: fullName(c?.customer), photoThumb: c?.customer?.photo_thumb, overdue: n(r.overdue_amount), daysLate: r.daysLate } })
    } else out.topLate = []
  } else {
    const { data: promises } = await supabase.from('visits').select('id, promise_date, note, credit_id, customer:customers(name, last_name)').eq('lender_id', req.user.id).eq('result', 'promesa').gte('promise_date', today).order('promise_date').limit(8)
    out.promises = (promises || []).map((v) => ({ id: v.id, date: v.promise_date, note: v.note, creditId: v.credit_id, customer: fullName(v.customer) }))
    const { buildRoute } = require('./collection')
    const r = await buildRoute(req.user.id, today)
    out.route = r.totals
  }
  res.send(out)
}))

// ---------------------------------------------------------------------
// Resumen por sede (KU-017): para comparar los cobros de cada ciudad en la vista "Todas las sedes".
// ---------------------------------------------------------------------
router.get('/dashboard/sedes', auth(ADMIN), h(async (req, res) => {
  const today = todayBogota()
  const month = `${today.slice(0, 8)}01`
  const [{ data: sites }, { data: users }, { data: bal }, { data: pays }, { data: cr }, { data: accs }] = await Promise.all([
    supabase.from('sites').select('id, name, city, own_capital').eq('active', true).order('id'),
    supabase.from('users').select('id, site_id, active').eq('role', 'prestamista'),
    supabase.from('credit_balances').select('lender_id, customer_id, balance, overdue_amount').eq('status', 'activo'),
    supabase.from('payments').select('lender_id, amount, paid_on').eq('status', 'aplicado').neq('kind', 'renovacion').gte('paid_on', month),
    supabase.from('credits').select('lender_id, principal').neq('status', 'anulado').gte('disbursement_date', month),
    supabase.from('fund_accounts').select('kind, site_id, user_id, balance')
  ])
  const build = (id, name, city, ownCapital, ids) => {
    const b = (bal || []).filter((x) => ids.includes(x.lender_id))
    const p = (pays || []).filter((x) => ids.includes(x.lender_id))
    const balance = sum(b, (x) => n(x.balance))
    const overdue = sum(b, (x) => n(x.overdue_amount))
    return {
      id, name, city, ownCapital,
      lenders: (users || []).filter((u) => ids.includes(u.id) && u.active).length,
      customers: new Set(b.map((x) => x.customer_id)).size, credits: b.length, portfolio: balance, overdue,
      overduePct: balance ? Math.round((overdue / balance) * 1000) / 10 : 0,
      collectedToday: sum(p.filter((x) => x.paid_on === today), (x) => n(x.amount)), collectedMonth: sum(p, (x) => n(x.amount)),
      placedMonth: sum((cr || []).filter((x) => ids.includes(x.lender_id)), (x) => n(x.principal)),
      cash: sum((accs || []).filter((a) => a.kind === 'prestamista' && ids.includes(a.user_id)), (a) => n(a.balance)),
      capital: ownCapital ? n((accs || []).find((a) => a.kind === 'negocio' && a.site_id === id)?.balance) : null
    }
  }
  const rows = (sites || []).map((st) => build(st.id, st.name, st.city, st.own_capital, (users || []).filter((u) => u.site_id === st.id).map((u) => u.id)))
  const loose = (users || []).filter((u) => !u.site_id).map((u) => u.id)
  if (loose.length) rows.push(build(null, 'Sin sede', null, false, loose))
  res.send({ rows, general: n((accs || []).find((a) => a.kind === 'negocio' && !a.site_id)?.balance) })
}))

module.exports = router
