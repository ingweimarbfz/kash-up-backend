// Tipos de documento de identidad según el país del negocio.
// El primero de cada lista es el que se propone por defecto al registrar a una persona.
// Los códigos se guardan en doc_type (clientes, usuarios y conductores).
const DOC_TYPES = {
  CO: [['CC', 'Cédula de ciudadanía'], ['CE', 'Cédula de extranjería'], ['TI', 'Tarjeta de identidad'], ['PPT', 'Permiso por protección temporal'], ['PA', 'Pasaporte'], ['NIT', 'NIT']],
  PA: [['CIP', 'Cédula de identidad personal'], ['CR', 'Carné de residente'], ['PA', 'Pasaporte'], ['RUC', 'RUC']],
  VE: [['V', 'Cédula de identidad (venezolano)'], ['E', 'Cédula de identidad (extranjero)'], ['PA', 'Pasaporte'], ['RIF', 'RIF']],
  EC: [['CI', 'Cédula de identidad'], ['PA', 'Pasaporte'], ['RUC', 'RUC']],
  PE: [['DNI', 'DNI'], ['CE', 'Carné de extranjería'], ['CPP', 'Carné de permiso temporal de permanencia'], ['PA', 'Pasaporte'], ['RUC', 'RUC']],
  BO: [['CI', 'Cédula de identidad'], ['CE', 'Cédula de extranjero'], ['PA', 'Pasaporte'], ['NIT', 'NIT']],
  BR: [['CPF', 'CPF'], ['RG', 'RG (carteira de identidade)'], ['CNH', 'CNH (carteira de motorista)'], ['RNM', 'RNM (estrangeiro)'], ['PA', 'Passaporte'], ['CNPJ', 'CNPJ']],
  PY: [['CI', 'Cédula de identidad'], ['PA', 'Pasaporte'], ['RUC', 'RUC']],
  CL: [['RUN', 'RUN (cédula de identidad)'], ['PA', 'Pasaporte'], ['RUT', 'RUT']],
  AR: [['DNI', 'DNI'], ['CUIL', 'CUIL'], ['PA', 'Pasaporte'], ['CUIT', 'CUIT']],
  UY: [['CI', 'Cédula de identidad'], ['PA', 'Pasaporte'], ['RUT', 'RUT']]
}
const DEFAULT_COUNTRY = 'CO'

// [{ code, label }] para el país; si el país no tiene lista propia, la de Colombia.
const docTypesFor = (country) => (DOC_TYPES[String(country || '').toUpperCase()] || DOC_TYPES[DEFAULT_COUNTRY]).map(([code, label]) => ({ code, label }))
const defaultDocType = (country) => docTypesFor(country)[0].code

// Todos los códigos conocidos (de cualquier país).
const ALL_CODES = new Set(Object.values(DOC_TYPES).flat().map(([code]) => code))

// ¿El tipo es válido para el país? Se acepta además el valor que la persona ya tenía guardado,
// para que los registros anteriores (por ejemplo, CC en un negocio de otro país) se puedan seguir editando.
const isValidDocType = (code, country, current = null) =>
  Boolean(code) && (docTypesFor(country).some((t) => t.code === code) || (current !== null && code === current))

module.exports = { DOC_TYPES, docTypesFor, defaultDocType, isValidDocType, ALL_CODES }
