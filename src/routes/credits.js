const express = require('express')
const supabase = require('../db')
const { currentOrg } = require('../tenant')
const plan = require('../plan')
const { availableFor } = require('./funds')
const { h, fail, clean, PHONE_RE, todayBogota } = require('../http')
const { isValidPhone, phoneMessage, phoneRule, digitsText } = require('../lib/phones')
const { bySite } = require('../site')
const { auth, ADMIN, STAFF } = require('../auth')
const { audit } = require('../audit')
const { buildSchedule, suggestFirstDue, intervalDays, roundStepFor } = require('../lib/schedule')
const { bestFor, loadActive } = require('../promo')

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
  let cq = supabase.from('customers').select('id, name, last_name, status, lender_id, credit_limit, has_id_photos').eq('id', Number(b.customerId))
  if (req.user.role === 'prestamista') cq = cq.eq('lender_id', req.user.id)
  const { data: customer } = await cq.maybeSingle()
  if (!customer) throw new Bad('Selecciona un cliente válido')
  if (customer.status !== 'activo') throw new Bad(`El cliente está ${customer.status}; no se le pueden otorgar créditos`)
  if (!customer.has_id_photos) throw new Bad('Falta la foto del documento del cliente por ambas caras (delantera y trasera). Súbela antes de prestar')
  // Exclusividad: si el cliente ya tiene créditos con otro prestamista, solo el administrador le presta.
  if (req.user.role === 'prestamista') {
    const { data: other } = await supabase.from('credits').select('lender:users!credits_lender_id_fkey(name, last_name)')
      .eq('customer_id', customer.id).eq('status', 'activo').neq('lender_id', req.user.id).not('lender_id', 'is', null).limit(1)
    if (other?.length) throw new Bad(`Este cliente ya tiene créditos con ${fullName(other[0].lender)}. Solo el administrador puede otorgarle uno con otro prestamista`)
  }

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
    const [{ data: products, error }, promos] = await Promise.all([supabase.from('products').select('id, name, price, active, category_id').in('id', ids), loadActive()])
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
      // Si hay una promoción vigente, el precio base es el de la promoción (KU-020).
      const best = bestFor(promos, p)
      const base = best ? best.price : money(p.price)
      const unit = req.user.role === 'administrador' && w.unitPrice !== undefined && w.unitPrice !== '' && money(w.unitPrice) !== base ? money(w.unitPrice) : base
      items.push({ product_id: p.id, product_name: p.name, quantity: qty, unit_price: unit, subtotal: unit * qty, list_price: money(p.price), promotion_id: best && unit === best.price ? best.promo.id : null, promotion_name: best && unit === best.price ? [best.promo.emoji, best.promo.tag || best.promo.name].filter(Boolean).join(' ') : null })
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
    count: Number(b.count), disbursementDate, firstDueDate, skipSundays: Boolean(b.skipSundays), roundTo: b.roundTo === undefined ? roundStepFor((await plan.ensure(currentOrg())).country?.currency) : Number(b.roundTo)
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
  // El prestamista necesita aprobación del administrador si el cliente ya tiene un crédito activo.
  let needsApproval = null
  if (!renewal && req.user.role === 'prestamista') {
    const active = await activeCredits(p.customer.id)
    if (active.length) needsApproval = { activeCredits: active.map((c) => c.number) }
  }
  res.send({ funds, renewal, needsApproval, productsTotal: p.productsTotal, discountAmount: p.discountAmount, discountName: p.discount?.name ?? null, downPayment: p.downPayment, rate: p.rateInfo, ...p.schedule })
}))

const validRefs = (b, country) => {
  const refs = (Array.isArray(b.references) ? b.references : []).map((r) => ({ name: clean(r.name), phone: clean(r.phone), relationship: clean(r.relationship), address: clean(r.address) })).filter((r) => r.name || r.phone)
  if (!refs.length) throw new Bad('Agrega al menos una referencia personal')
  for (const r of refs) {
    if (!r.name || !r.phone) throw new Bad('Cada referencia necesita nombre y celular')
    if (!isValidPhone(r.phone, country)) throw new Bad(`Celular de la referencia ${r.name} no válido (${digitsText(phoneRule(country))}, sin el indicativo del país)`)
  }
  return refs
}

// ¿El cliente ya tiene un crédito activo? (para pedir aprobación al administrador)
const activeCredits = async (customerId) => {
  const { data } = await supabase.from('credits').select('id, number').eq('customer_id', customerId).eq('status', 'activo')
  return data || []
}

// Crea el crédito. Con `approval` se crea a partir de una solicitud aprobada por el administrador.
const createCredit = async (req, b, approval = null) => {
  if (b.kind === 'producto' && !plan.has(await plan.ensure(currentOrg()), 'productos')) throw new Bad('Tu plan no incluye créditos de productos')
  const refs = validRefs(b, (await plan.ensure(currentOrg())).country?.code)
  const p = await prepare(req, b)
  let lenderId = resolveLender(req, b, p.customer)
  if (lenderId && req.user.role === 'administrador') {
    const { data: l } = await supabase.from('users').select('id').eq('id', lenderId).eq('is_lender', true).eq('active', true).maybeSingle()
    if (!l) throw new Bad('El prestamista seleccionado no existe o está inactivo')
  }
  const s = p.schedule
  let renewal = null
  if (Number(b.renewFromId)) {
    if (b.kind !== 'efectivo') throw new Bad('La renovación se hace como crédito en efectivo')
    renewal = await renewalInfo(req, b.renewFromId)
    if (renewal.customerId !== p.customer.id) throw new Bad('La renovación debe ser para el mismo cliente')
    if (!renewal.canRenew) throw new Bad(`No se puede renovar. ${renewal.reason}`)
    if (s.disbursedAmount - renewal.payoff <= 0) throw new Bad(`El nuevo crédito debe entregar más que el saldo actual (${renewal.payoff.toLocaleString('es-CO')})`)
  }
  const payload = {
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
  // Prestamista + cliente con otro crédito activo (y no es renovación): queda como solicitud para el administrador.
  if (!approval && !renewal && req.user.role === 'prestamista') {
    const active = await activeCredits(p.customer.id)
    if (active.length) {
      const { data: pending } = await supabase.from('credit_requests').select('number').eq('customer_id', p.customer.id).eq('status', 'pendiente').maybeSingle()
      if (pending) throw new Bad(`Este cliente ya tiene la solicitud ${pending.number} esperando aprobación del administrador`)
      const { data: n } = await supabase.rpc('next_counter', { p_org: currentOrg(), p_key: 'solicitud_credito' })
      const { data: reqRow, error } = await supabase.from('credit_requests').insert({
        number: `SC-${String(n).padStart(4, '0')}`, customer_id: p.customer.id, lender_id: lenderId, kind: b.kind, principal: s.principal,
        installment_amount: s.installmentAmount, installments_count: s.count, frequency: s.frequency, payload: b, reason: clean(b.requestReason), requested_by: req.user.id
      }).select('id, number').single()
      if (error) throw error
      await audit(req, 'solicitar', 'credito', reqRow.id, { customer: p.customer.id, principal: s.principal, active: active.map((c) => c.number) })
      return { request: { id: reqRow.id, number: reqRow.number, activeCredits: active.map((c) => c.number) } }
    }
  }
  const { data: id, error } = approval
    ? await supabase.rpc('approve_credit_request', { p_org: currentOrg(), p_request: approval.id, p_user: approval.userId, p_note: approval.note, p: payload })
    : await supabase.rpc(renewal ? 'renew_credit' : 'create_credit', { p: payload })
  if (error) { if (error.code === 'P0001') throw new Bad(error.message); throw error }
  await audit(approval ? approval.req : req, approval ? 'aprobar' : renewal ? 'renovar' : 'crear', 'credito', id, { kind: b.kind, principal: s.principal, customer: p.customer.id, renewedFrom: renewal?.number, request: approval?.number })
  return { id }
}

router.post('/creditos', auth(STAFF), withBad(async (req, res) => {
  const out = await createCredit(req, req.body || {})
  if (out.request) return res.status(202).send({ request: out.request, message: `El cliente ya tiene un crédito activo (#${out.request.activeCredits.join(', #')}). Se envió la solicitud ${out.request.number} al administrador para que la apruebe.` })
  res.status(201).send(await detail(req, out.id))
}))

// ---------- Solicitudes de crédito adicional ----------
const REQ_SELECT = 'id, number, kind, principal, installment_amount, installments_count, frequency, reason, status, credit_id, review_note, reviewed_at, created_at, customer:customers(id, name, last_name, identification, photo_thumb), lender:users!credit_requests_lender_id_fkey(id, name, last_name), reviewer:users!credit_requests_reviewed_by_fkey(name, last_name)'
const reqDTO = (r, extra = {}) => ({
  id: r.id, number: r.number, kind: r.kind, principal: Number(r.principal), installmentAmount: Number(r.installment_amount), installmentsCount: r.installments_count,
  frequency: r.frequency, frequencyLabel: FREQ_LABELS[r.frequency] || r.frequency, reason: r.reason, status: r.status, creditId: r.credit_id, reviewNote: r.review_note,
  reviewedAt: r.reviewed_at, reviewer: fullName(r.reviewer), createdAt: r.created_at,
  customer: r.customer ? { id: r.customer.id, fullName: fullName(r.customer), identification: r.customer.identification, photoThumb: r.customer.photo_thumb } : null,
  lender: r.lender ? { id: r.lender.id, fullName: fullName(r.lender) } : null, ...extra
})

router.get('/solicitudes-credito', auth(STAFF), h(async (req, res) => {
  let q = supabase.from('credit_requests').select(REQ_SELECT).order('id', { ascending: false }).limit(300)
  if (req.user.role === 'prestamista') q = q.eq('lender_id', req.user.id)
  else q = bySite(req, q)
  if (req.query.estado) q = q.eq('status', req.query.estado)
  const { data, error } = await q
  if (error) throw error
  // Lo que el cliente ya debe, para decidir.
  const ids = [...new Set(data.filter((r) => r.status === 'pendiente').map((r) => r.customer?.id))]
  const { data: bal } = ids.length ? await supabase.from('credit_balances').select('customer_id, balance, overdue_amount, overdue_count').in('customer_id', ids).eq('status', 'activo') : { data: [] }
  res.send(data.map((r) => {
    const b = (bal || []).filter((x) => x.customer_id === r.customer?.id)
    return reqDTO(r, r.status === 'pendiente' ? { current: { credits: b.length, balance: b.reduce((s, x) => s + Number(x.balance), 0), overdue: b.reduce((s, x) => s + Number(x.overdue_amount), 0) } } : {})
  }))
}))

router.post('/solicitudes-credito/:id/aprobar', auth(ADMIN), withBad(async (req, res) => {
  const { data: r } = await supabase.from('credit_requests').select('id, number, status, payload, requested_by').eq('id', Number(req.params.id)).maybeSingle()
  if (!r) throw new Bad('Solicitud no encontrada')
  if (r.status !== 'pendiente') throw new Bad(`La solicitud ${r.number} ya fue ${r.status}`)
  const { data: who } = await supabase.from('users').select('id, role, name, last_name, active').eq('id', r.requested_by).maybeSingle()
  if (!who?.active) throw new Bad('El prestamista que hizo la solicitud está inactivo')
  // Se recalcula a hoy, como si lo hiciera el prestamista (su caja, sus reglas).
  const b = { ...r.payload, disbursementDate: todayBogota() }
  if (!b.firstDueDate || b.firstDueDate <= b.disbursementDate) delete b.firstDueDate
  const asLender = { ...req, user: { ...req.user, id: who.id, role: who.role } }
  const out = await createCredit(asLender, b, { id: r.id, number: r.number, userId: req.user.id, note: clean(req.body?.note), req })
  res.status(201).send({ creditId: out.id })
}))

router.post('/solicitudes-credito/:id/rechazar', auth(STAFF), withBad(async (req, res) => {
  let q = supabase.from('credit_requests').select('id, number, status, lender_id').eq('id', Number(req.params.id))
  if (req.user.role === 'prestamista') q = q.eq('requested_by', req.user.id)
  const { data: r } = await q.maybeSingle()
  if (!r) throw new Bad('Solicitud no encontrada')
  if (r.status !== 'pendiente') throw new Bad(`La solicitud ${r.number} ya fue ${r.status}`)
  const admin = req.user.role === 'administrador'
  if (admin && !clean(req.body?.note)) throw new Bad('Escribe el motivo del rechazo')
  const { error } = await supabase.from('credit_requests').update({ status: admin ? 'rechazada' : 'cancelada', review_note: clean(req.body?.note), reviewed_by: req.user.id, reviewed_at: new Date().toISOString() }).eq('id', r.id)
  if (error) throw error
  await audit(req, admin ? 'rechazar' : 'cancelar', 'solicitud_credito', r.id, { number: r.number })
  res.send({ ok: true })
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
  else q = bySite(req, q)
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
    supabase.from('credit_items').select('product_id, product_name, quantity, unit_price, subtotal, list_price, promotion_name').eq('credit_id', id),
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
    items: (items || []).map((i) => ({ productId: i.product_id, name: i.product_name, quantity: i.quantity, unitPrice: Number(i.unit_price), subtotal: Number(i.subtotal), listPrice: i.list_price === null ? null : Number(i.list_price), promotion: i.promotion_name })),
    references: refs || [],
    renewedFrom: from ? { id: from.id, number: from.number } : null, payoffAmount: Number(c.payoff_amount || 0),
    renewedBy: renewedBy ? { id: renewedBy.id, number: renewedBy.number } : null,
    waivedAmount: Number(bal[id]?.waived_amount ?? 0),
    payments: (pays || []).map((p) => ({
      id: p.id, number: `RC-${String(p.number).padStart(4, '0')}`, kind: p.kind, amount: Number(p.amount), method: p.method, reference: p.reference, paidOn: p.paid_on, note: p.note,
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
