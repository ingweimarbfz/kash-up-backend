const express = require('express')
const supabase = require('../db')
const { h } = require('../http')
const { auth } = require('../auth')

const router = express.Router()

// Dashboard por rol. En esta etapa entrega la estructura con los indicadores en cero;
// cada etapa siguiente (créditos, cobros) llena sus cifras.
const emptySeries = () => {
  const out = []
  const now = new Date()
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    out.push({ mes: d.toLocaleDateString('es-CO', { month: 'short' }).replace('.', ''), colocado: 0, recaudado: 0 })
  }
  return out
}

router.get('/dashboard', auth(), h(async (req, res) => {
  const role = req.user.role
  if (role === 'administrador') {
    const { data: users } = await supabase.from('users').select('role, active')
    const count = (r) => (users || []).filter((u) => u.role === r && u.active).length
    return res.send({
      role,
      kpis: { carteraActiva: 0, recaudoHoy: 0, enMora: 0, creditosActivos: 0, prestamistas: count('prestamista'), clientes: count('cliente') },
      series: emptySeries(),
      cartera: [{ name: 'Al día', value: 0 }, { name: 'En mora', value: 0 }]
    })
  }
  if (role === 'prestamista') {
    return res.send({ role, kpis: { porCobrarHoy: 0, cobradoHoy: 0, visitasPendientes: 0, clientesEnMora: 0 }, series: emptySeries() })
  }
  return res.send({ role, kpis: { saldoPendiente: 0, proximaCuota: null, cuotasPagadas: 0, creditosActivos: 0 }, creditos: [] })
}))

module.exports = router
