const test = require('node:test')
const assert = require('node:assert')
process.env.SUPABASE_URL ||= 'http://x'; process.env.SUPABASE_SECRET_KEY ||= 'x'; process.env.JWT_SECRET ||= 'x'
const { statusOf, bestFor, priceWith } = require('../src/promo')

const base = { id: 1, active: true, type: 'porcentaje', value: 20, scope: 'todos', weekdays: [], category_ids: [], product_ids: [] }
const tv = { id: 10, category_id: 3, price: 1000000 }
// 2026-11-27 (viernes) 10:00 en Colombia = 15:00 UTC
const bf = new Date('2026-11-27T15:00:00Z')

test('rango de fechas: programada, vigente y vencida', () => {
  const p = { ...base, starts_at: '2026-11-27T05:00:00Z', ends_at: '2026-11-28T05:00:00Z' }
  assert.equal(statusOf(p, new Date('2026-11-26T15:00:00Z')), 'programada')
  assert.equal(statusOf(p, bf), 'vigente')
  assert.equal(statusOf(p, new Date('2026-11-28T06:00:00Z')), 'vencida')
})

test('franja diaria y días de la semana (hora de Colombia)', () => {
  const p = { ...base, time_from: '08:00:00', time_to: '12:00:00', weekdays: [5] }
  assert.equal(statusOf(p, bf), 'vigente')
  assert.equal(statusOf(p, new Date('2026-11-27T18:00:00Z')), 'fuera_de_horario') // 1 p. m.
  assert.equal(statusOf(p, new Date('2026-11-28T15:00:00Z')), 'fuera_de_horario') // sábado
  const night = { ...base, time_from: '22:00', time_to: '02:00' }
  assert.equal(statusOf(night, new Date('2026-11-27T04:30:00Z')), 'vigente') // 11:30 p. m.
})

test('alcance y mejor precio', () => {
  const a = { ...base, id: 1, value: 10 }
  const b = { ...base, id: 2, type: 'valor', value: 250000, scope: 'categorias', category_ids: [3] }
  const c = { ...base, id: 3, value: 50, scope: 'productos', product_ids: [99] }
  const best = bestFor([a, b, c], tv, bf)
  assert.equal(best.promo.id, 2)
  assert.equal(best.price, 750000)
  assert.equal(priceWith({ type: 'valor', value: 5 }, 3), 0)
  assert.equal(bestFor([{ ...a, active: false }], tv, bf), null)
})
