const express = require('express')
const supabase = require('../db')
const { h, todayBogota } = require('../http')
const { auth } = require('../auth')

const router = express.Router()

// Últimos 6 meses (YYYY-MM) con su etiqueta corta.
const lastMonths = () => {
  const [y, m] = todayBogota().split('-').map(Number)
  const out = []
  for (let i = 5; i >= 0; i--) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1))
    out.push({ key: d.toISOString().slice(0, 7), mes: d.toLocaleDateString('es-CO', { month: 'short', timeZone: 'UTC' }).replace('.', '') })
  }
  return out
}

// Colocado por mes (capital de créditos no anulados) y recaudado por mes (pagos aplicados a cuotas).
const series = async (lenderId) => {
  const months = lastMonths()
  const from = `${months[0].key}-01`
  let cq = supabase.from('credits').select('principal, disbursement_date').neq('status', 'anulado').gte('disbursement_date', from)
  let iq = supabase.from('installments').select('paid_amount, paid_at, credit:credits!inner(lender_id)').gt('paid_amount', 0).gte('paid_at', from)
  if (lenderId) { cq = cq.eq('lender_id', lenderId); iq = iq.eq('credit.lender_id', lenderId) }
  const [{ data: credits }, { data: paid }] = await Promise.all([cq, iq])
  return months.map(({ key, mes }) => ({
    mes,
    colocado: (credits || []).filter((c) => c.disbursement_date.startsWith(key)).reduce((s, c) => s + Number(c.principal), 0),
    recaudado: (paid || []).filter((p) => String(p.paid_at).startsWith(key)).reduce((s, p) => s + Number(p.paid_amount), 0)
  }))
}

const sumBy = (rows, k) => rows.reduce((s, r) => s + Number(r[k] || 0), 0)

router.get('/dashboard', auth(), h(async (req, res) => {
  const role = req.user.role
  const today = todayBogota()

  if (role === 'administrador') {
    const [{ data: users }, { data: bal }, s] = await Promise.all([
      supabase.from('users').select('role, active'),
      supabase.from('credit_balances').select('balance, capital_balance, overdue_amount, customer_id').eq('status', 'activo'),
      series()
    ])
    const count = (r) => (users || []).filter((u) => u.role === r && u.active).length
    const enMora = sumBy(bal || [], 'overdue_amount')
    const cartera = sumBy(bal || [], 'balance')
    return res.send({
      role,
      kpis: {
        carteraActiva: cartera, capitalPorCobrar: sumBy(bal || [], 'capital_balance'), recaudoHoy: 0, enMora,
        creditosActivos: (bal || []).length, clientesEnMora: new Set((bal || []).filter((b) => Number(b.overdue_amount) > 0).map((b) => b.customer_id)).size,
        prestamistas: count('prestamista'), clientes: count('cliente')
      },
      series: s,
      cartera: [{ name: 'Al día', value: Math.max(0, cartera - enMora) }, { name: 'En mora', value: enMora }]
    })
  }

  if (role === 'prestamista') {
    const [{ data: due }, { data: bal }, s] = await Promise.all([
      supabase.from('installments').select('amount, paid_amount, credit:credits!inner(lender_id, customer_id, status)').in('status', ['pendiente', 'parcial']).lte('due_date', today).eq('credit.lender_id', req.user.id).eq('credit.status', 'activo'),
      supabase.from('credit_balances').select('customer_id, overdue_amount').eq('status', 'activo').eq('lender_id', req.user.id),
      series(req.user.id)
    ])
    return res.send({
      role,
      kpis: {
        porCobrarHoy: (due || []).reduce((t, i) => t + Number(i.amount) - Number(i.paid_amount), 0),
        cobradoHoy: 0,
        visitasPendientes: new Set((due || []).map((i) => i.credit.customer_id)).size,
        clientesEnMora: new Set((bal || []).filter((b) => Number(b.overdue_amount) > 0).map((b) => b.customer_id)).size
      },
      series: s
    })
  }

  // Cliente
  const { data: customer } = await supabase.from('customers').select('id').eq('user_id', req.user.id).maybeSingle()
  if (!customer) return res.send({ role, kpis: { saldoPendiente: 0, proximaCuota: null, cuotasPagadas: 0, creditosActivos: 0 }, creditos: [] })
  const [{ data: bal }, { data: next }] = await Promise.all([
    supabase.from('credit_balances').select('credit_id, balance, paid_count, overdue_amount').eq('customer_id', customer.id).eq('status', 'activo'),
    supabase.from('installments').select('due_date, amount, paid_amount, credit:credits!inner(customer_id, status)').eq('credit.customer_id', customer.id).eq('credit.status', 'activo').in('status', ['pendiente', 'parcial']).order('due_date').limit(1)
  ])
  const n = next?.[0]
  return res.send({
    role,
    kpis: {
      saldoPendiente: sumBy(bal || [], 'balance'),
      enMora: sumBy(bal || [], 'overdue_amount'),
      proximaCuota: n ? { valor: Number(n.amount) - Number(n.paid_amount), fecha: n.due_date } : null,
      cuotasPagadas: sumBy(bal || [], 'paid_count'),
      creditosActivos: (bal || []).length
    }
  })
}))

module.exports = router
