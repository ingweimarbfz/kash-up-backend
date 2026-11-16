// =====================================================================
// Pagos (KU-010): cuotas, abono a capital y recibos.
// · Un pago de cuota se aplica a las cuotas pendientes desde la más antigua.
// · El abono a capital exige estar al día y acorta el plazo (condona el interés de las cuotas que cubre).
// · El dinero entra a la caja del prestamista del crédito (o del negocio).
// Toda la lógica vive en la base (register_payment / void_payment) para que sea atómica.
// =====================================================================
const express = require('express')
const supabase = require('../db')
const { currentOrg } = require('../tenant')
const { h, fail, clean, todayBogota } = require('../http')
const { bySite } = require('../site')
const { auth, ADMIN, STAFF } = require('../auth')
const { audit } = require('../audit')

const router = express.Router()
const fullName = (x) => (x ? `${x.name} ${x.last_name || ''}`.trim() : null)
const ISO = /^\d{4}-\d{2}-\d{2}$/
const KIND_LABELS = { cuota: 'Pago de cuota', abono_capital: 'Abono a capital', renovacion: 'Cierre por renovación' }
const METHOD_LABELS = { efectivo: 'Efectivo', transferencia: 'Transferencia', otro: 'Otro', renovacion: 'Renovación' }

const SELECT = 'id, number, kind, amount, method, reference, paid_on, note, status, void_reason, created_at, lat, lng, credit_id, ' +
  'credit:credits(id, number, kind, installment_amount, frequency), customer:customers(id, name, last_name, identification, phone, photo_thumb), ' +
  'lender:users!payments_lender_id_fkey(id, name, last_name), user:users!payments_user_id_fkey(name, last_name)'

const receiptNo = (n) => `RC-${String(n).padStart(4, '0')}`
const toDTO = (p) => ({
  id: p.id, number: receiptNo(p.number), kind: p.kind, kindLabel: KIND_LABELS[p.kind], amount: Number(p.amount), method: p.method, methodLabel: METHOD_LABELS[p.method],
  reference: p.reference, paidOn: p.paid_on, note: p.note, status: p.status, voidReason: p.void_reason, createdAt: p.created_at,
  credit: p.credit ? { id: p.credit.id, number: p.credit.number, kind: p.credit.kind } : null,
  customer: p.customer ? { id: p.customer.id, fullName: fullName(p.customer), identification: p.customer.identification, phone: p.customer.phone, photoThumb: p.customer.photo_thumb } : null,
  lender: p.lender ? { id: p.lender.id, fullName: fullName(p.lender) } : null, user: fullName(p.user)
})

// Recibo: el pago con el saldo del crédito después del pago.
const receipt = async (id) => {
  const { data: p } = await supabase.from('payments').select(SELECT).eq('id', id).maybeSingle()
  if (!p) return null
  const [{ data: b }, { data: alloc }, { data: s }] = await Promise.all([
    supabase.from('credit_balances').select('balance, overdue_amount, overdue_count, paid_count, next_due_date').eq('credit_id', p.credit_id).single(),
    supabase.from('payment_allocations').select('amount, waived, installment:installments(number, due_date)').eq('payment_id', id),
    supabase.from('app_settings').select('business_name, receipt_footer').maybeSingle()
  ])
  return {
    ...toDTO(p),
    business: s?.business_name || 'KashUp', footer: s?.receipt_footer || null,
    installments: (alloc || []).map((a) => ({ number: a.installment?.number, dueDate: a.installment?.due_date, amount: Number(a.amount), waived: Number(a.waived) })).sort((x, y) => x.number - y.number),
    after: { balance: Number(b.balance), overdue: Number(b.overdue_amount), overdueCount: b.overdue_count, paidCount: b.paid_count, nextDueDate: b.next_due_date }
  }
}

// Registrar un pago a un crédito.
router.post('/creditos/:id/pagos', auth(STAFF), h(async (req, res) => {
  const b = req.body || {}
  const creditId = Number(req.params.id)
  let q = supabase.from('credits').select('id, lender_id, status').eq('id', creditId)
  if (req.user.role === 'prestamista') q = q.eq('lender_id', req.user.id)
  const { data: c } = await q.maybeSingle()
  if (!c) return fail(res, 'Crédito no encontrado', 404)
  const kind = b.kind === 'abono_capital' ? 'abono_capital' : 'cuota'
  const amount = Math.round(Number(b.amount))
  if (!(amount > 0)) return fail(res, 'Ingresa el valor del pago', 400)
  if (!['efectivo', 'transferencia', 'otro'].includes(b.method || 'efectivo')) return fail(res, 'Medio de pago inválido', 400)
  const paidOn = b.paidOn || todayBogota()
  if (!ISO.test(paidOn) || paidOn > todayBogota()) return fail(res, 'Fecha del pago inválida (no puede ser futura)', 400)
  if (req.user.role === 'prestamista' && paidOn !== todayBogota()) return fail(res, 'El prestamista solo registra pagos con fecha de hoy', 400)
  const { data: id, error } = await supabase.rpc('register_payment', {
    p: {
      org_id: currentOrg(), credit_id: creditId, kind, amount, method: b.method || 'efectivo', reference: clean(b.reference), paid_on: paidOn,
      note: clean(b.note), lat: b.lat ?? null, lng: b.lng ?? null, user_id: req.user.id
    }
  })
  if (error) return error.code === 'P0001' ? fail(res, error.message, 400) : fail(res, error)
  await audit(req, kind === 'abono_capital' ? 'abono_capital' : 'registrar_pago', 'credito', creditId, { payment: id, amount })
  res.status(201).send(await receipt(id))
}))

// Lista de pagos con filtros (el prestamista solo ve los suyos).
router.get('/pagos', auth(STAFF), h(async (req, res) => {
  let q = supabase.from('payments').select(SELECT).order('paid_on', { ascending: false }).order('id', { ascending: false }).limit(Math.min(Number(req.query.limit) || 300, 1000))
  if (req.user.role === 'prestamista') q = q.eq('lender_id', req.user.id)
  else if (Number(req.query.prestamista)) q = q.eq('lender_id', Number(req.query.prestamista))
  else q = bySite(req, q)
  if (ISO.test(req.query.desde || '')) q = q.gte('paid_on', req.query.desde)
  if (ISO.test(req.query.hasta || '')) q = q.lte('paid_on', req.query.hasta)
  if (Number(req.query.cliente)) q = q.eq('customer_id', Number(req.query.cliente))
  if (Number(req.query.credito)) q = q.eq('credit_id', Number(req.query.credito))
  if (req.query.estado) q = q.eq('status', req.query.estado)
  const { data, error } = await q
  if (error) throw error
  const rows = data.map(toDTO)
  const ok = rows.filter((p) => p.status === 'aplicado' && p.kind !== 'renovacion')
  res.send({
    rows,
    totals: {
      count: ok.length, amount: ok.reduce((s, p) => s + p.amount, 0),
      cash: ok.filter((p) => p.method === 'efectivo').reduce((s, p) => s + p.amount, 0),
      transfer: ok.filter((p) => p.method !== 'efectivo').reduce((s, p) => s + p.amount, 0),
      capital: ok.filter((p) => p.kind === 'abono_capital').reduce((s, p) => s + p.amount, 0)
    }
  })
}))

router.get('/pagos/:id', auth(['administrador', 'prestamista', 'cliente']), h(async (req, res) => {
  const r = await receipt(Number(req.params.id))
  if (!r) return fail(res, 'Pago no encontrado', 404)
  if (req.user.role === 'prestamista' && r.lender?.id !== req.user.id) return fail(res, 'Pago no encontrado', 404)
  if (req.user.role === 'cliente') {
    const { data: me } = await supabase.from('customers').select('id').eq('user_id', req.user.id).maybeSingle()
    if (!me || r.customer?.id !== me.id) return fail(res, 'Pago no encontrado', 404)
  }
  res.send(r)
}))

// Anular un pago (administrador; solo el último pago del crédito).
router.post('/pagos/:id/anular', auth(ADMIN), h(async (req, res) => {
  const reason = clean(req.body?.reason)
  if (!reason) return fail(res, 'Escribe el motivo de la anulación', 400)
  const { error } = await supabase.rpc('void_payment', { p_org: currentOrg(), p_payment: Number(req.params.id), p_reason: reason, p_user: req.user.id })
  if (error) return error.code === 'P0001' ? fail(res, error.message, 400) : fail(res, error)
  await audit(req, 'anular', 'pago', Number(req.params.id), { reason })
  res.send(await receipt(Number(req.params.id)))
}))

// Portal del cliente: sus pagos.
router.get('/mis-pagos', auth(['cliente']), h(async (req, res) => {
  const { data: me } = await supabase.from('customers').select('id').eq('user_id', req.user.id).maybeSingle()
  if (!me) return res.send([])
  const { data, error } = await supabase.from('payments').select(SELECT).eq('customer_id', me.id).eq('status', 'aplicado').order('id', { ascending: false }).limit(200)
  if (error) throw error
  res.send(data.map(toDTO))
}))

module.exports = router
