// Celulares y teléfonos según el país del negocio: número nacional, solo dígitos, sin el indicativo
// del país (+57, +55…). min y max son la cantidad de dígitos aceptada; example, un número de muestra.
const PHONE_RULES = {
  CO: { min: 7, max: 10, example: '3001234567' },
  PA: { min: 7, max: 8, example: '61234567' },
  VE: { min: 10, max: 10, example: '4121234567' },
  EC: { min: 8, max: 9, example: '991234567' },
  PE: { min: 8, max: 9, example: '912345678' },
  BO: { min: 7, max: 8, example: '71234567' },
  BR: { min: 10, max: 11, example: '11912345678' },
  PY: { min: 8, max: 9, example: '981234567' },
  CL: { min: 9, max: 9, example: '912345678' },
  AR: { min: 10, max: 10, example: '1123456789' },
  UY: { min: 8, max: 8, example: '94123456' }
}

const phoneRule = (country) => PHONE_RULES[String(country || '').toUpperCase()] || PHONE_RULES.CO
const digitsText = ({ min, max }) => (min === max ? `${min} dígitos` : max === min + 1 ? `${min} u ${max} dígitos` : `${min} a ${max} dígitos`)
const isValidPhone = (value, country) => {
  const { min, max } = phoneRule(country)
  return new RegExp(`^[0-9]{${min},${max}}$`).test(String(value ?? ''))
}
// "Celular no válido (10 u 11 dígitos, sin el indicativo del país)"
const phoneMessage = (country, label = 'Celular') => `${label} no válido (${digitsText(phoneRule(country))}, sin el indicativo del país)`

module.exports = { PHONE_RULES, phoneRule, isValidPhone, phoneMessage, digitsText }
