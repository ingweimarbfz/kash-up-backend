const test = require('node:test')
const assert = require('node:assert')
const { rescheduleDates } = require('../src/lib/schedule')

const inst = (dates, paid = 0) => dates.map((d, i) => ({ id: i + 1, number: i + 1, due_date: d, status: i < paid ? 'pagada' : 'pendiente' }))
const base = { frequency: 'semanal', customDays: 7, skipSundays: false, disbursementDate: '2026-11-01' }

test('mover una cuota y las siguientes con la misma frecuencia', () => {
  const r = rescheduleDates({ ...base, installments: inst(['2026-11-08', '2026-11-15', '2026-11-22', '2026-11-29'], 1), fromNumber: 2, newDate: '2026-11-18' })
  assert.deepStrictEqual(r.changes.map((c) => [c.number, c.from, c.to]), [[2, '2026-11-15', '2026-11-18'], [3, '2026-11-22', '2026-11-25'], [4, '2026-11-29', '2026-12-02']])
})

test('mover solo una cuota: debe quedar entre la anterior y la siguiente', () => {
  const list = inst(['2026-11-08', '2026-11-15', '2026-11-22'])
  assert.deepStrictEqual(rescheduleDates({ ...base, installments: list, fromNumber: 2, newDate: '2026-11-17', mode: 'una' }).changes, [{ id: 2, number: 2, from: '2026-11-15', to: '2026-11-17' }])
  assert.match(rescheduleDates({ ...base, installments: list, fromNumber: 2, newDate: '2026-11-22', mode: 'una' }).error, /anterior a la cuota 3/)
})

test('no se mueve una cuota pagada ni antes de la anterior o del desembolso', () => {
  const list = inst(['2026-11-08', '2026-11-15'], 1)
  assert.match(rescheduleDates({ ...base, installments: list, fromNumber: 1, newDate: '2026-11-09' }).error, /ya está pagada/)
  assert.match(rescheduleDates({ ...base, installments: list, fromNumber: 2, newDate: '2026-11-08' }).error, /posterior a la cuota 1/)
  assert.match(rescheduleDates({ ...base, installments: inst(['2026-11-08']), fromNumber: 1, newDate: '2026-11-01' }).error, /posterior al desembolso/)
})

test('diario sin domingos: salta el domingo al recorrer', () => {
  const r = rescheduleDates({ ...base, frequency: 'diaria', customDays: 1, skipSundays: true, installments: inst(['2026-11-19', '2026-11-20', '2026-11-21']), fromNumber: 1, newDate: '2026-11-20' })
  assert.deepStrictEqual(r.changes.map((c) => c.to), ['2026-11-20', '2026-11-21', '2026-11-23'])
})
