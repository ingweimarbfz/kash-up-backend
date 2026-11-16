const test = require('node:test')
const assert = require('node:assert')
const { buildSchedule, dueDates, suggestFirstDue } = require('../src/lib/schedule')

const base = { principal: 1000000, rate: 20, rateBasis: 'total', method: 'fija', frequency: 'diaria', count: 30, disbursementDate: '2026-11-16', firstDueDate: '2026-11-17' }
const sum = (rows, k) => rows.reduce((s, r) => s + r[k], 0)

test('fija con tasa total: 1.000.000 al 20 % en 30 cuotas diarias', () => {
  const s = buildSchedule(base)
  assert.strictEqual(s.totalInterest, 200000)
  assert.strictEqual(s.totalAmount, 1200000)
  assert.strictEqual(s.installmentAmount, 40000)
  assert.strictEqual(sum(s.installments, 'capital'), 1000000)
  assert.strictEqual(s.disbursedAmount, 1000000)
  assert.strictEqual(s.installments.length, 30)
})

test('fija mensual: 10 % mensual, 4 cuotas mensuales = 40 % de interés', () => {
  const s = buildSchedule({ ...base, rate: 10, rateBasis: 'mensual', frequency: 'mensual', count: 4, firstDueDate: '2026-12-16' })
  assert.strictEqual(s.totalInterest, 400000)
  assert.strictEqual(s.installmentAmount, 350000)
  assert.deepStrictEqual(s.installments.map((r) => r.dueDate), ['2026-12-16', '2027-01-16', '2027-02-16', '2027-03-16'])
})

test('fija semanal con tasa mensual usa los meses del plazo', () => {
  const s = buildSchedule({ ...base, principal: 300000, rate: 10, rateBasis: 'mensual', frequency: 'semanal', count: 12, firstDueDate: '2026-11-23' })
  // 12 semanas = 84 días = 2,8 meses → 28 %
  assert.strictEqual(s.totalInterest, 84000)
  assert.strictEqual(s.totalAmount, 384000)
})

test('redondeo: la última cuota ajusta y el total cuadra', () => {
  const s = buildSchedule({ ...base, principal: 500000, rate: 15, count: 23 })
  assert.strictEqual(s.totalAmount, 575000)
  assert.strictEqual(sum(s.installments, 'amount'), 575000)
  assert.strictEqual(sum(s.installments, 'capital'), 500000)
  assert.ok(s.installments.slice(0, -1).every((r) => r.amount % 100 === 0))
  assert.ok(s.installments.every((r) => r.amount > 0 && r.capital >= 0 && r.interest >= 0))
})

test('sobre saldo (francés): cuota fija y el saldo llega a cero', () => {
  const s = buildSchedule({ ...base, method: 'sobre_saldo', rateBasis: 'mensual', rate: 5, frequency: 'mensual', count: 12, firstDueDate: '2026-12-16' })
  assert.strictEqual(sum(s.installments, 'capital'), 1000000)
  assert.strictEqual(s.installmentAmount, 112825) // 1.000.000 × 0,05 / (1 − 1,05^−12)
  assert.ok(s.installments[0].interest > s.installments[11].interest)
  assert.strictEqual(s.installments[0].interest, 50000)
})

test('sobre saldo con tasa 0', () => {
  const s = buildSchedule({ ...base, method: 'sobre_saldo', rateBasis: 'mensual', rate: 0, count: 4 })
  assert.strictEqual(s.totalInterest, 0)
  assert.strictEqual(s.totalAmount, 1000000)
})

test('sobre saldo exige tasa mensual', () => {
  assert.throws(() => buildSchedule({ ...base, method: 'sobre_saldo', rateBasis: 'total' }), /tasa mensual/)
})

test('anticipada: desembolsa capital − interés y las cuotas solo pagan capital', () => {
  const s = buildSchedule({ ...base, method: 'anticipada' })
  assert.strictEqual(s.disbursedAmount, 800000)
  assert.strictEqual(s.anticipatedInterest, 200000)
  assert.strictEqual(s.totalAmount, 1000000)
  assert.strictEqual(sum(s.installments, 'interest'), 0)
  assert.strictEqual(s.totalInterest, 200000)
})

test('diaria sin domingos: ningún vencimiento cae en domingo', () => {
  const dates = dueDates({ frequency: 'diaria', count: 14, firstDueDate: '2026-11-21', skipSundays: true }) // sábado
  assert.strictEqual(dates[0], '2026-11-21')
  assert.strictEqual(dates[1], '2026-11-23') // domingo 22 → lunes 23
  assert.ok(dates.every((d) => new Date(d + 'T00:00:00Z').getUTCDay() !== 0))
})

test('quincenal y personalizada', () => {
  assert.deepStrictEqual(dueDates({ frequency: 'quincenal', count: 3, firstDueDate: '2026-12-01' }), ['2026-12-01', '2026-12-16', '2026-12-31'])
  assert.deepStrictEqual(dueDates({ frequency: 'personalizada', customDays: 10, count: 3, firstDueDate: '2026-12-01' }), ['2026-12-01', '2026-12-11', '2026-12-21'])
})

test('mensual el día 31 pasa al último día de los meses cortos', () => {
  assert.deepStrictEqual(dueDates({ frequency: 'mensual', count: 3, firstDueDate: '2027-01-31' }), ['2027-01-31', '2027-02-28', '2027-03-31'])
})

test('primera cuota sugerida', () => {
  assert.strictEqual(suggestFirstDue('2026-11-16', 'diaria'), '2026-11-17')
  assert.strictEqual(suggestFirstDue('2026-11-16', 'semanal'), '2026-11-23')
  assert.strictEqual(suggestFirstDue('2026-11-21', 'diaria', null, true), '2026-11-23')
  assert.strictEqual(suggestFirstDue('2026-11-16', 'mensual'), '2026-12-16')
})

test('valida datos', () => {
  assert.throws(() => buildSchedule({ ...base, principal: 0 }), /capital/)
  assert.throws(() => buildSchedule({ ...base, frequency: 'personalizada' }), /cuántos días/)
  assert.throws(() => buildSchedule({ ...base, firstDueDate: '2026-11-10' }), /antes del desembolso/)
  assert.throws(() => buildSchedule({ ...base, count: 0 }), /cuotas/)
})
