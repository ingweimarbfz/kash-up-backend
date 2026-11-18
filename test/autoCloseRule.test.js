const test = require('node:test')
const assert = require('node:assert')
const { validTime, localTime, resolveRule } = require('../src/lib/autoCloseRule')

test('hora válida del cierre automático: entre 12:00 y 23:59', () => {
  assert.ok(validTime('20:00'))
  assert.ok(validTime('12:00'))
  assert.ok(validTime('23:59'))
  assert.ok(!validTime('11:59'))
  assert.ok(!validTime('24:00'))
  assert.ok(!validTime('8:00'))
  assert.ok(!validTime(''))
})

test('hora local según la zona horaria del país', () => {
  const now = new Date('2026-11-18T23:30:00Z')
  assert.strictEqual(localTime('America/Bogota', now), '18:30')
  assert.strictEqual(localTime('America/Sao_Paulo', now), '20:30')
})

test('regla: hora del país, hora propia o desactivado', () => {
  const country = { autoCloseTime: '20:00', timezone: 'America/Sao_Paulo' }
  assert.deepStrictEqual(resolveRule(null, country), { mode: 'pais', countryTime: '20:00', ownTime: null, time: '20:00', timezone: 'America/Sao_Paulo' })
  assert.strictEqual(resolveRule({ auto_close_mode: 'hora', auto_close_time: '21:30:00' }, country).time, '21:30')
  assert.strictEqual(resolveRule({ auto_close_mode: 'desactivado' }, country).time, null)
  assert.strictEqual(resolveRule({ auto_close_mode: 'pais' }, { autoCloseTime: null }).time, null)
})
