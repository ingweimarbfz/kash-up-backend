const express = require('express')
const supabase = require('../db')
const { currentOrg } = require('../tenant')
const { availableFor } = require('./funds')
const { h, fail, clean, PHONE_RE, todayBogota } = require('../http')
const { auth, ADMIN, STAFF } = require('../auth')
const { audit } = require('../audit')
const { buildSchedule, suggestFirstDue, intervalDays } = require('../lib/schedule')

const router = express.Router()
const money = (v) => Math.round(Number(v) || 0)
const fullName = (x) => (x ? `${x.name} ${x.last_name || ''}`.trim() : null)
const FREQ_LABELS = { diaria: 'Diaria', semanal: 'Semanal', quincenal: 'Quincenal', mensual: 'Mensual', personalizada: 'Personalizada' }

class Bad extends Error { constructor (m) { super(m); this.status = 400 } }

// Arma todo lo necesario para un crédito (sirve para simular y para guardar).
const prepare = async (req, b) => {
  const errors = []
  if (!['efectivo', 'producto'].includes(b.kind)) throw new Bad('Tipo de crédito inválido')

  // Cliente
  let cq = supabase.from('customers').select('id, name, last_name, status, lender_id, credit_limit').eq('id', Number(b.customerId))
  if (req.user.role === 'prestamista') cq = cq.eq('lender_id', req.user.id)
  const { data: customer } = await cq.maybeSingle()
  if (!customer) throw new Bad('Selecciona un cliente válido')
  if (customer.status !== 'activo') throw new Bad(`El cliente está ${customer.status}; no se le pueden otorgar créditos`)

  // Productos
  let items = []
  let productsTotal = 0
  let discountAmount = 0
  let discount = null
  let warehouse = null
  const downPayment = money(b.downPayment)
  if (b.kind === 'producto') {
    // Bodega que entrega: la elegida o, si no se elige, la bodega principal.
    let wq = supabase.from('warehouses').select('id, name, active')
    wq = Number(b.warehouseId) ? wq.eq('id', Number(b.warehouseId)) : wq.eq('is_general', true)
    const { data: wh } = await wq.maybeSingle()
    if (!wh || !wh.active) throw new Bad('Selecciona una bodega activa para entregar los productos')
    warehouse = wh
    const wanted = (Array.isArray(b.items) ? b.items : []).filter((i) => Number(i.productId) && Number(i.quantity) > 0)
    if (!wanted.length) throw new Bad('Agrega al menos un producto')
    const ids = [...new Set(wanted.map((i) => Number(i.productId)))]
    if (ids.length !== wanted.length) throw new Bad('Un producto aparece dos veces; ajusta la cantidad en una sola línea')
    const { data: products, error } = await supabase.from('products').select('id, name, price, active').in('id', ids)
    if (error) throw error
    const { data: stocks } = await supabase.from('warehouse_stock').select('product_id, stock').eq('warehouse_id', warehouse.id).in('product_id', ids)
    for (const p of products) p.stock = stocks?.find((x) => x.product_id === p.id)?.stock ?? 0
    for (const w of wanted) {
      const p = products.find((x) => x.id === Number(w.productId))
      if (!p || !p.active) throw new Bad('Uno de los productos no existe o está inactivo')
      const qty = Number(w.quantity)
      if (!Number.isInteger(qty)) throw new Bad(`Cantidad inválida para ${p.name}`)
      if (qty > p.stock) throw new Bad(`Stock insuficiente de "${p.name}" en ${warehouse.name} (disponible: ${p.stock})`)
      // El precio lo toma del inventario; solo el administrador puede ajustarlo en el crédito.
      const unit = req.user.role === 'administrador' && w.unitPrice !== undefined && w.unitPrice !== '' ? money(w.unitPrice) : money(p.price)
      items.push({ product_id: p.id, product_name: p.name, quantity: qty, unit_price: unit, subtotal: unit * qty })
    }
    productsTotal = items.reduce((s, i) => s + i.subtotal, 0)
    if (Number(b.discountId)) {
      const { data: d } = await supabase.from('discounts').select('*').eq('id', Number(b.discountId)).eq('active', true).maybeSingle()
      if (!d) throw new Bad('El descuento no existe o está inactivo')
      discount = d
      discountAmount = Math.min(productsTotal, d.type === 'porcentaje' ? Math.round(productsTotal * Number(d.value) / 100) : money(d.value))
    }
    if (downPayment < 0) errors.push('Cuota inicial inválida')
    if (downPayment >= productsTotal - discountAmount) errors.push('La cuota inicial debe ser menor que el total de los productos')
  }
  const principal = b.kind === 'producto' ? productsTotal - discountAmount - downPayment : money(b.principal)
  if (!(principal > 0)) errors.push('El valor a financiar debe ser mayor que cero')

  // Tasa: del catálogo o personalizada.
  let rateInfo
  if (Number(b.interestRateId)) {
    const { data: r } = await supabase.from('interest_rates').select('*').eq('id', Number(b.interestRateId)).eq('active', true).maybeSingle()
    if (!r) throw new Bad('La tasa seleccionada no existe o está inactiva')
    rateInfo = { id: r.id, name: r.name, method: r.method, rate: Number(r.rate), rateBasis: r.rate_basis }
  } else {
    rateInfo = { id: null, name: 'Personalizada', method: b.method, rate: Number(b.rate), rateBasis: b.rateBasis }
  }

  // Cupo del cliente.
  if (customer.credit_limit !== null && principal > 0) {
    const { data: bal } = await supabase.from('credit_balances').select('capital_balance').eq('customer_id', customer.id).eq('status', 'activo')
    const used = (bal || []).reduce((s, x) => s + Number(x.capital_balance), 0)
    if (used + principal > Number(customer.credit_limit)) errors.push(`Supera el cupo del cliente (cupo ${Number(customer.credit_limit).toLocaleString('es-CO')}, en uso ${used.toLocaleString('es-CO')})`)
  }
  if (errors.length) throw new Bad(errors.join('. '))

  const disbursementDate = b.disbursementDate || todayBogota()
  const firstDueDate = b.firstDueDate || suggestFirstDue(disbursementDate, b.frequency, b.customDays, b.skipSundays)
  const schedule = buildSchedule({
    principal, method: rateInfo.method, rate: rateInfo.rate, rateBasis: rateInfo.rateBasis, frequency: b.frequency, customDays: b.customDays,
    count: Number(b.count), disbursementDate, firstDueDate, skipSundays: Boolean(b.skipSundays), roundTo: b.roundTo === undefined ? 100 : Number(b.roundTo)
  })
  return { customer, items, warehouse, productsTotal, discount, discountAmount, downPayment, principal, rateInfo, disbursementDate, schedule }
}

const withBad = (fn) => h(async (req, res) => {
  try { await fn(req, res) } catch (e) { if (e.status === 400) return fail(res, e.message, 400); throw e }
})

// Renovación: el crédito anterior debe estar activo, al día y ser del mismo cliente. Se descuenta su saldo.
const renewalInfo = async (req, oldId) => {
  let q = supabase.from('credits').select('id, number, customer_id, lender_id, status').eq('id', Number(oldId))
  if (req.user.role === 'prestamista') q = q.eq('lender_id', req.user.id)
  const { data: old } = await q.maybeSingle()
  if (!old) throw new Bad('El crédito a renovar no existe')
  const { data: b } = await supabase.from('credit_balances').select('balance, overdue_amount, overdue_count').eq('credit_id', old.id).single()
  const info = { creditId: old.id, number: old.number, customerId: old.customer_id, lenderId: old.lender_id, payoff: Number(b.balance), overdue: Number(b.overdue_amount), overdueCount: b.overdue_count }
  info.canRenew = old.status === 'activo' && b.overdue_count === 0
  info.reason = old.status !== 'activo' ? `El crédito #${old.number} está ${old.status}` : b.overdue_count ? `Debe ponerse al día primero: tiene ${b.overdue_count} cuota(s) vencida(s) por ${Number(b.overdue_amount).toLocaleString('es-CO')}` : null
  return info
}

// Quién presta: el prestamista que crea, o el elegido / asignado al cliente.
const resolveLender = (req, b, customer) => (req.user.role === 'prestamista' ? req.user.id : (Number(b.lenderId) || customer.lender_id || null))

router.post('/creditos/simular', auth(STAFF), withBad(async (req, res) => {
  const b = req.body || {}
  const p = await prepare(req, b)
  let renewal = null
  if (Number(b.renewFromId)) {
    renewal = await renewalInfo(req, b.renewFromId)
    renewal.net = p.schedule.disbursedAmount - renewal.payoff
  }
  const cashOut = renewal ? Math.max(renewal.net, 0) : p.schedule.disbursedAmount
  // Dinero disponible en la caja que presta (solo crédito en efectivo).
  let funds = null
  if (b.kind === 'efectivo') {
    funds = await availableFor(resolveLender(req, b, p.customer))
    funds.enough = funds.available >= cashOut
  }
  res.send({ funds, renewal, productsTotal: p.productsTotal, discountAmount: p.discountAmount, discountName: p.discount?.name ?? null, downPayment: p.downPayment, rate: p.rateInfo, ...p.schedule })
}))

router.post('/creditos', auth(STAFF), withBad(async (req, res) => {
  const b = req.body || {}
  const refs = (Array.isArray(b.references) ? b.references : []).map((r) => ({ name: clean(r.name), phone: clean(r.phone), relationship: clean(r.relationship), address: clean(r.address) })).filter((r) => r.name || r.phone)
  if (!refs.length) return fail(res, 'Agrega al menos una referencia personal', 400)
  for (const r of refs) {
    if (!r.name || !r.phone) return fail(res, 'Cada referencia necesita nombre y celular', 400)
    if (!PHONE_RE.test(r.phone)) return fail(res, `Celular de la referencia ${r.name} no válido`, 400)
  }
  const p = await prepare(req, b)
  let lenderId = resolveLender(req, b, p.customer)
  if (lenderId && req.user.role === 'administrador') {
    const { data: l } = await supabase.from('users').select('id').eq('id', lenderId).eq('role', 'prestamista').eq('active', true).maybeSingle()
    if (!l) return fail(res, 'El prestamista seleccionado no existe o está inactivo', 400)
  }
  const s = p.schedule
  let renewal = null
  if (Number(b.renewFromId)) {
    if (b.kind !== 'efectivo') return fail(res, 'La renovación se hace como crédito en efectivo', 400)
    renewal = await renewalInfo(req, b.renewFromId)
    if (renewal.customerId !== p.customer.id) return fail(res, 'La renovación debe ser para el mismo cliente', 400)
    if (!renewal.canRenew) return fail(res, `No se puede renovar. ${renewal.reason}`, 400)
    if (s.disbursedAmount - renewal.payoff <= 0) return fail(res, `El nuevo crédito debe entregar más que el saldo actual (${renewal.payoff.toLocaleString('es-CO')})`, 400)
  }
  const { data: id, error } = await supabase.rpc(renewal ? 'renew_credit' : 'create_credit', {
    p: {
      ...(renewal ? { renewed_from_id: renewal.creditId, payoff_amount: renewal.payoff } : {}),
      org_id: currentOrg(), customer_id: p.customer.id, lender_id: lenderId, kind: b.kind,
      products_total: p.productsTotal, discount_id: p.discount?.id ?? null, discount_name: p.discount?.name ?? null, discount_amount: p.discountAmount, down_payment: p.downPayment,
      principal: s.principal, interest_rate_id: p.rateInfo.id, interest_name: p.rateInfo.name, interest_method: s.method, rate: s.rate, rate_basis: s.rateBasis,
      frequency: s.frequency, interval_days: s.intervalDays, installments_count: s.count, skip_sundays: Boolean(b.skipSundays),
      disbursement_date: p.disbursementDate, first_due_date: s.firstDueDate, last_due_date: s.lastDueDate,
      total_interest: s.totalInterest, total_amount: s.totalAmount, installment_amount: s.installmentAmount, disbursed_amount: renewal ? s.disbursedAmount - renewal.payoff : s.disbursedAmount,
      notes: clean(b.notes), created_by: req.user.id,
      references: refs, items: p.items, warehouse_id: p.warehouse?.id ?? null,
      installments: s.installments.map((i) => ({ number: i.number, due_date: i.dueDate, capital: i.capital, interest: i.interest, amount: i.amount }))
    }
  })
  if (error) return error.code === 'P0001' ? fail(res, error.message, 400) : fail(res, error)
  await audit(req, renewal ? 'renovar' : 'crear', 'credito', id, { kind: b.kind, principal: s.principal, customer: p.customer.id, renewedFrom: renewal?.number })
  res.status(201).send(await detail(req, id))
}))

const LIST_SELECT = 'id, number, kind, principal, total_amount, installment_amount, frequency, interval_days, installments_count, interest_method, rate, rate_basis, disbursement_date, last_due_date, status, created_at, customer:customers(id, name, last_name, identification, photo_thumb, phone), lender:users!credits_lender_id_fkey(id, name, last_name)'

const listDTO = (c, b) => ({
  id: c.id, number: c.number, kind: c.kind, principal: Number(c.principal), totalAmount: Number(c.total_amount), installmentAmount: Number(c.installment_amount),
  frequency: c.frequency, frequencyLabel: c.frequency === 'personalizada' ? `Cada ${c.interval_days} días` : FREQ_LABELS[c.frequency],
  installmentsCount: c.installments_count, interestMethod: c.interest_method, rate: Number(c.rate), rateBasis: c.rate_basis,
  disbursementDate: c.disbursement_date, lastDueDate: c.last_due_date, status: c.status, createdAt: c.created_at,
  customer: c.customer ? { id: c.customer.id, fullName: fullName(c.customer), identification: c.customer.identification, photoThumb: c.customer.photo_thumb, phone: c.customer.phone } : null,
  lender: c.lender ? { id: c.lender.id, fullName: fullName(c.lender) } : null,
  balance: Number(b?.balance ?? 0), paidAmount: Number(b?.paid_amount ?? 0), overdue: Number(b?.overdue_amount ?? 0), overdueCount: b?.overdue_count ?? 0,
  paidCount: b?.paid_count ?? 0, nextDueDate: b?.next_due_date ?? null
})

const balancesFor = async (ids) => {
  if (!ids.length) return {}
  const { data, error } = await supabase.from('credit_balances').select('*').in('credit_id', ids)
  if (error) throw error
  return Object.fromEntries(data.map((b) => [b.credit_id, b]))
}

router.get('/creditos', auth(STAFF), h(async (req, res) => {
  let q = supabase.from('credits').select(LIST_SELECT).order('number', { ascending: false }).limit(1000)
  if (req.user.role === 'prestamista') q = q.eq('lender_id', req.user.id)
  else if (Number(req.query.prestamista)) q = q.eq('lender_id', Number(req.query.prestamista))
  if (req.query.estado) q = q.eq('status', req.query.estado)
  if (req.query.tipo) q = q.eq('kind', req.query.tipo)
  if (Number(req.query.cliente)) q = q.eq('customer_id', Number(req.query.cliente))
  const { data, error } = await q
  if (error) throw error
  const bal = await balancesFor(data.map((c) => c.id))
  let rows = data.map((c) => listDTO(c, bal[c.id]))
  if (req.query.mora === '1') rows = rows.filter((r) => r.overdue > 0)
  res.send(rows)
}))

const detail = async (req, id) => {
  let q = supabase.from('credits').select(`*, customer:customers(id, name, last_name, identification, doc_type, photo_thumb, phone, address, neighborhood), lender:users!credits_lender_id_fkey(id, name, last_name), creator:users!credits_created_by_fkey(name, last_name), warehouse:warehouses(id, name)`).eq('id', id)
  if (req.user.role === 'prestamista') q = q.eq('lender_id', req.user.id)
  const { data: c } = await q.maybeSingle()
  if (!c) return null
  const [{ data: inst }, { data: items }, { data: refs }, bal, { data: pays }, { data: links }] = await Promise.all([
    supabase.from('installments').select('id, number, due_date, capital, interest, amount, paid_amount, waived, paid_at, status').eq('credit_id', id).order('number'),
    supabase.from('credit_items').select('product_id, product_name, quantity, unit_price, subtotal').eq('credit_id', id),
    supabase.from('credit_references').select('name, phone, relationship, address').eq('credit_id', id),
    balancesFor([id]),
    supabase.from('payments').select('id, number, kind, amount, method, reference, paid_on, note, status, void_reason, created_at, user:users!payments_user_id_fkey(name, last_name)').eq('credit_id', id).order('id', { ascending: false }),
    supabase.from('credits').select('id, number, status, renewed_from_id').or(`id.eq.${c.renewed_from_id || 0},renewed_from_id.eq.${id}`)
  ])
  const today = todayBogota()
  const from = (links || []).find((k) => k.id === c.renewed_from_id)
  const renewedBy = (links || []).find((k) => k.renewed_from_id === id && k.status !== 'anulado')
  return {
    ...listDTO(c, bal[id]),
    customer: { ...listDTO(c, bal[id]).customer, docType: c.customer.doc_type, address: c.customer.address, neighborhood: c.customer.neighborhood },
    productsTotal: Number(c.products_total), discountName: c.discount_name, discountAmount: Number(c.discount_amount), downPayment: Number(c.down_payment),
    interestName: c.interest_name, intervalDays: c.interval_days, skipSundays: c.skip_sundays, firstDueDate: c.first_due_date,
    totalInterest: Number(c.total_interest), disbursedAmount: Number(c.disbursed_amount), notes: c.notes, voidReason: c.void_reason,
    createdBy: fullName(c.creator), warehouse: c.warehouse ? { id: c.warehouse.id, name: c.warehouse.name } : null, capitalBalance: Number(bal[id]?.capital_balance ?? 0),
    items: (items || []).map((i) => ({ productId: i.product_id, name: i.product_name, quantity: i.quantity, unitPrice: Number(i.unit_price), subtotal: Number(i.subtotal) })),
    references: refs || [],
    renewedFrom: from ? { id: from.id, number: from.number } : null, payoffAmount: Number(c.payoff_amount || 0),
    renewedBy: renewedBy ? { id: renewedBy.id, number: renewedBy.number } : null,
    waivedAmount: Number(bal[id]?.waived_amount ?? 0),
    payments: (pays || []).map((p) => ({
      id: p.id, number: p.number, kind: p.kind, amount: Number(p.amount), method: p.method, reference: p.reference, paidOn: p.paid_on, note: p.note,
      status: p.status, voidReason: p.void_reason, createdAt: p.created_at, user: fullName(p.user)
    })),
    installments: (inst || []).map((i) => ({
      id: i.id, number: i.number, dueDate: i.due_date, capital: Number(i.capital), interest: Number(i.interest), amount: Number(i.amount),
      paidAmount: Number(i.paid_amount), waived: Number(i.waived || 0), paidAt: i.paid_at, status: i.status,
      overdue: ['pendiente', 'parcial'].includes(i.status) && i.due_date < today
    }))
  }
}

router.get('/creditos/:id', auth(STAFF), h(async (req, res) => {
  const d = await detail(req, Number(req.params.id))
  if (!d) return fail(res, 'Crédito no encontrado', 404)
  res.send(d)
}))

router.get('/creditos/:id/renovacion', auth(STAFF), withBad(async (req, res) => res.send(await renewalInfo(req, req.params.id))))

router.post('/creditos/:id/anular', auth(ADMIN), h(async (req, res) => {
  const reason = clean(req.body?.reason)
  if (!reason) return fail(res, 'Escribe el motivo de la anulación', 400)
  const id = Number(req.params.id)
  const { error } = await supabase.rpc('void_credit', { p_org: currentOrg(), p_credit: id, p_reason: reason, p_user: req.user.id })
  if (error) return error.code === 'P0001' ? fail(res, error.message, 400) : fail(res, error)
  await audit(req, 'anular', 'credito', id, { reason })
  res.send(await detail(req, id))
}))

// Portal del cliente: sus créditos con cuotas.
router.get('/mis-creditos', auth(['cliente']), h(async (req, res) => {
  const { data: customer } = await supabase.from('customers').select('id').eq('user_id', req.user.id).maybeSingle()
  if (!customer) return res.send([])
  const { data } = await supabase.from('credits').select('id').eq('customer_id', customer.id).neq('status', 'anulado').order('number', { ascending: false })
  const out = []
  for (const c of data || []) out.push(await detail({ user: { role: 'administrador' } }, c.id))
  res.send(out.map(({ references, createdBy, notes, voidReason, ...rest }) => rest))
}))

module.exports = { router, intervalDays }
