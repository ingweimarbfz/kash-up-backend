const test = require('node:test')
const assert = require('node:assert')
const { score } = require('../src/lib/scoring')

const today = '2026-11-16'
test('sin historial es Nuevo', () => assert.strictEqual(score({ installments: [], today }).level, 'Nuevo'))
test('todo a tiempo es Excelente', () => {
  const r = score({ today, installments: [{ due_date: '2026-11-10', status: 'pagada', paid_at: '2026-11-10T15:00:00Z' }, { due_date: '2026-11-11', status: 'pagada', paid_at: '2026-11-09T15:00:00Z' }] })
  assert.strictEqual(r.score, 100); assert.strictEqual(r.level, 'Excelente')
})
test('cuotas vencidas sin pagar bajan a Riesgo', () => {
  const r = score({ today, installments: [{ due_date: '2026-11-01', status: 'pendiente' }, { due_date: '2026-11-05', status: 'pendiente' }] })
  assert.strictEqual(r.level, 'Riesgo'); assert.strictEqual(r.detail.overdue, 2)
})
test('pagos tarde quedan en Bueno o Regular', () => {
  const r = score({ today, installments: [{ due_date: '2026-11-01', status: 'pagada', paid_at: '2026-11-03T15:00:00Z' }, { due_date: '2026-11-02', status: 'pagada', paid_at: '2026-11-02T15:00:00Z' }] })
  assert.strictEqual(r.score, 90)
})
test('crédito castigado limita el puntaje', () => {
  const r = score({ today, credits: [{ status: 'castigado' }], installments: [{ due_date: '2026-11-10', status: 'pagada', paid_at: '2026-11-10' }] })
  assert.strictEqual(r.level, 'Riesgo')
})
