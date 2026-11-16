// =====================================================================
// Capital del negocio y caja de cada prestamista (KU-009).
// · El administrador registra aportes y retiros de capital en la cuenta del negocio.
// · Desde ahí asigna (o quita) dinero a cada prestamista según el comportamiento de su ruta.
// · Los créditos en efectivo salen de la caja del prestamista que cobra; sin saldo no se presta.
// · La cuenta del negocio conserva siempre una reserva mínima (% del capital aportado).
// Las reglas viven en la base de datos (trigger apply_fund_movement), así nada las salta.
// =====================================================================
const express = require('express')
const supabase = require('../db')
const { currentOrg } = require('../tenant')
const { h, fail, clean } = require('../http')
const { auth, ADMIN } = require('../auth')
const { audit } = require('../audit')

const router = express.Router()
const p0001 = (res, e) => (e.code === 'P0001' ? fail(res, e.message, 400) : fail(res, e))
const fullName = (u) => (u ? `${u.name} ${u.last_name || ''}`.trim() : null)
const MOVE_LABELS = {
  aporte: 'Aporte de capital', retiro: 'Retiro de capital', asignacion: 'Asignación', devolucion_asignacion: 'Devolución de asignación',
  desembolso: 'Desembolso de crédito', reverso_desembolso: 'Anulación de crédito', recaudo: 'Recaudo', ajuste: 'Ajuste', gasto: 'Gasto', reverso_gasto: 'Anulación de gasto'
}

const businessAccount = async () => {
  const { data: id, error } = await supabase.rpc('fund_business_account', { p_org: currentOrg() })
  if (error) throw error
  const [{ data: acc }, { data: s }] = await Promise.all([
    supabase.from('fund_accounts').select('id, balance, capital').eq('id', id).single(),
    supabase.from('app_settings').select('min_reserve_pct').maybeSingle()
  ])
  const pct = Number(s?.min_reserve_pct ?? 10)
  const reserve = Math.round(Math.max(Number(acc.capital), 0) * pct / 100)
  return { id: acc.id, balance: Number(acc.balance), capital: Number(acc.capital), reservePct: pct, reserve, available: Math.max(Number(acc.balance) - reserve, 0) }
}

// Saldo disponible para prestar de un prestamista (o del negocio si lenderId es null).
const availableFor = async (lenderId) => {
  if (!lenderId) { const b = await businessAccount(); return { account: 'negocio', available: b.available } }
  const { data } = await supabase.from('fund_accounts').select('balance').eq('user_id', lenderId).maybeSingle()
  return { account: 'prestamista', available: Number(data?.balance ?? 0) }
}

const movementDTO = (m) => ({
  id: m.id, type: m.type, typeLabel: MOVE_LABELS[m.type], amount: Number(m.amount), balanceAfter: Number(m.balance_after), ref: m.ref, note: m.note,
  createdAt: m.created_at, creditId: m.credit_id, creditNumber: m.credit?.number ?? null, user: fullName(m.user),
  account: m.account ? (m.account.kind === 'negocio' ? 'Negocio' : fullName(m.account.owner)) : null,
  counterpart: m.counterpart ? (m.counterpart.kind === 'negocio' ? 'Negocio' : fullName(m.counterpart.owner)) : null
})
const MOVE_SELECT = 'id, type, amount, balance_after, ref, note, created_at, credit_id, credit:credits(number), user:users!fund_movements_user_id_fkey(name, last_name), account:fund_accounts!fund_movements_account_id_fkey(kind, owner:users(name, last_name)), counterpart:fund_accounts!fund_movements_counterpart_account_id_fkey(kind, owner:users(name, last_name))'

// Resumen para el administrador: negocio + caja de cada prestamista.
router.get('/capital', auth(ADMIN), h(async (req, res) => {
  const biz = await businessAccount()
  const [{ data: lenders, error }, { data: accounts }, { data: moves }, { data: bal }] = await Promise.all([
    supabase.from('users').select('id, name, last_name, active, avatar_url').eq('role', 'prestamista').order('name'),
    supabase.from('fund_accounts').select('id, user_id, balance').eq('kind', 'prestamista'),
    supabase.from('fund_movements').select('account_id, type, amount').in('type', ['asignacion', 'devolucion_asignacion', 'desembolso', 'reverso_desembolso', 'recaudo']),
    supabase.from('credit_balances').select('lender_id, balance, overdue_amount').eq('status', 'activo')
  ])
  if (error) throw error
  const rows = lenders.map((u) => {
    const acc = (accounts || []).find((a) => a.user_id === u.id)
    const ms = acc ? (moves || []).filter((m) => m.account_id === acc.id) : []
    const sum = (types) => ms.filter((m) => types.includes(m.type)).reduce((s, m) => s + Number(m.amount), 0)
    const port = (bal || []).filter((b) => b.lender_id === u.id)
    return {
      id: u.id, fullName: fullName(u), active: u.active, avatarUrl: u.avatar_url,
      balance: Number(acc?.balance ?? 0),
      assigned: sum(['asignacion', 'devolucion_asignacion']),
      lent: -sum(['desembolso', 'reverso_desembolso']),
      collected: sum(['recaudo']),
      portfolio: port.reduce((s, b) => s + Number(b.balance), 0),
      overdue: port.reduce((s, b) => s + Number(b.overdue_amount), 0),
      activeCredits: port.length
    }
  })
  res.send({ business: biz, lenders: rows, totals: { lendersBalance: rows.reduce((s, r) => s + r.balance, 0), portfolio: rows.reduce((s, r) => s + r.portfolio, 0) } })
}))

router.get('/capital/movimientos', auth(ADMIN), h(async (req, res) => {
  let q = supabase.from('fund_movements').select(MOVE_SELECT).order('created_at', { ascending: false }).order('id', { ascending: false }).limit(Math.min(Number(req.query.limit) || 200, 500))
  if (req.query.cuenta === 'negocio') q = q.eq('account_id', (await businessAccount()).id)
  else if (Number(req.query.cuenta)) {
    const { data: acc } = await supabase.from('fund_accounts').select('id').eq('user_id', Number(req.query.cuenta)).maybeSingle()
    q = q.eq('account_id', acc?.id ?? 0)
  }
  const { data, error } = await q
  if (error) throw error
  res.send(data.map(movementDTO))
}))

// Aporte o retiro de capital del negocio.
router.post('/capital/aportes', auth(ADMIN), h(async (req, res) => {
  const b = req.body || {}
  const amount = Math.round(Number(b.amount))
  if (!['aporte', 'retiro'].includes(b.type)) return fail(res, 'Tipo inválido', 400)
  if (!(amount > 0)) return fail(res, 'Ingresa un valor mayor que cero', 400)
  const biz = await businessAccount()
  const { data, error } = await supabase.from('fund_movements').insert({
    account_id: biz.id, type: b.type, amount: b.type === 'aporte' ? amount : -amount, note: clean(b.note), user_id: req.user.id
  }).select('id').single()
  if (error) return p0001(res, error)
  await audit(req, b.type === 'aporte' ? 'aporte_capital' : 'retiro_capital', 'capital', data.id, { amount })
  res.status(201).send(await businessAccount())
}))

// Asignar dinero a un prestamista (action 'asignar') o quitárselo (action 'quitar').
router.post('/capital/asignaciones', auth(ADMIN), h(async (req, res) => {
  const b = req.body || {}
  const amount = Math.round(Number(b.amount))
  if (!['asignar', 'quitar'].includes(b.action)) return fail(res, 'Acción inválida', 400)
  if (!(amount > 0)) return fail(res, 'Ingresa un valor mayor que cero', 400)
  const { data: ref, error } = await supabase.rpc('fund_assign', {
    p_org: currentOrg(), p_lender: Number(b.lenderId), p_amount: b.action === 'asignar' ? amount : -amount, p_user: req.user.id, p_note: clean(b.note)
  })
  if (error) return p0001(res, error)
  await audit(req, b.action === 'asignar' ? 'asignar_capital' : 'quitar_capital', 'prestamista', Number(b.lenderId), { amount, ref })
  res.status(201).send({ ref })
}))

// Porcentaje de reserva mínima de la cuenta del negocio.
router.put('/capital/reserva', auth(ADMIN), h(async (req, res) => {
  const pct = Number(req.body?.pct)
  if (!(pct >= 0 && pct <= 100)) return fail(res, 'El porcentaje debe estar entre 0 y 100', 400)
  const { data: s } = await supabase.from('app_settings').select('org_id').maybeSingle()
  if (!s) return fail(res, 'Primero guarda la configuración del negocio', 400)
  const { error } = await supabase.from('app_settings').update({ min_reserve_pct: pct }).eq('org_id', currentOrg())
  if (error) throw error
  await audit(req, 'editar', 'reserva_capital', currentOrg(), { pct })
  res.send(await businessAccount())
}))

// Caja del prestamista que entra.
router.get('/mi-caja', auth(['prestamista']), h(async (req, res) => {
  const { data: acc } = await supabase.from('fund_accounts').select('id, balance').eq('user_id', req.user.id).maybeSingle()
  const { data, error } = acc ? await supabase.from('fund_movements').select(MOVE_SELECT).eq('account_id', acc.id).order('created_at', { ascending: false }).order('id', { ascending: false }).limit(100) : { data: [] }
  if (error) throw error
  res.send({ balance: Number(acc?.balance ?? 0), movements: data.map(movementDTO) })
}))

module.exports = { router, availableFor }
