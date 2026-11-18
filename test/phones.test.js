const test = require('node:test')
const assert = require('node:assert')
const { isValidPhone, phoneMessage } = require('../src/lib/phones')
const { isValidDocType, docTypesFor } = require('../src/lib/docTypes')

test('celulares según el país', () => {
  assert.ok(isValidPhone('3001234567', 'CO'))
  assert.ok(!isValidPhone('30012345678', 'CO'))
  assert.ok(isValidPhone('44999963190', 'BR'))
  assert.ok(isValidPhone('4499996319', 'BR'))
  assert.ok(!isValidPhone('449999631', 'BR'))
  assert.ok(isValidPhone('912345678', 'PE'))
  assert.ok(!isValidPhone('91234567a', 'PE'))
  assert.ok(isValidPhone('3001234567', null))
  assert.strictEqual(phoneMessage('CL'), 'Celular no válido (9 dígitos, sin el indicativo del país)')
})

test('tipos de documento según el país', () => {
  assert.deepStrictEqual(docTypesFor('BR').map((t) => t.code), ['CPF', 'RG', 'CNH', 'RNM', 'PA', 'CNPJ'])
  assert.ok(isValidDocType('CNPJ', 'BR'))
  assert.ok(!isValidDocType('CC', 'BR'))
  assert.ok(isValidDocType('CC', 'BR', 'CC'))
  assert.ok(isValidDocType('CC', null))
})
