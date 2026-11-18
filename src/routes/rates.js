const express = require('express')
const supabase = require('../db')
const { h, fail, clean } = require('../http')
const { auth, ADMIN, STAFF } = require('../auth')
const { audit } = require('../audit')
const { buildSchedule, suggestFirstDue, roundStepFor, METHODS, FREQUENCIES } = require('../lib/schedule')
const plan = require('../plan')
const { currentOrg } = require('../tenant')

const router = express.Router()
const FREQS = [...Object.keys(FREQUENCIES), 'personalizada']
const toDTO = (r) => ({
  id: r.id, name: r.name, method: r.method, rate: Number(r.rate), rateBasis: r.rate_basis,
  defaultFrequency: r.default_frequency, notes: r.notes, active: r.active
})

const validate = (b) => {
  const errors = []
  if (!clean(b.name)) errors.push('El nombre es requerido')
  if (!METHODS.includes(b.method)) errors.push('Modalidad inválida')
  if (!(Number(b.rate) >= 0 && Number(b.rate) <= 100)) errors.push('La tasa debe estar entre 0 % y 100 %')
  if (!['mensual', 'total'].includes(b.rateBasis)) errors.push('Base de la tasa inválida')
  if (b.method === 'sobre_saldo' && b.rateBasis !== 'mensual') errors.push('El interés sobre saldo usa una tasa mensual')
  if (b.defaultFrequency && !FREQS.includes(b.defaultFrequency)) errors.push('Periodicidad inválida')
  return errors
}
const row = (b) => ({ name: clean(b.name), method: b.method, rate: Number(b.rate), rate_basis: b.rateBasis, default_frequency: b.defaultFrequency || null, notes: clean(b.notes), active: b.active !== false })
const dup = (e) => e?.code === '23505'

router.get('/tasas', auth(STAFF), h(async (req, res) => {
  let q = supabase.from('interest_rates').select('*').order('name')
  if (req.query.activas === '1') q = q.eq('active', true)
  const { data, error } = await q
  if (error) throw error
  res.send(data.map(toDTO))
}))

router.post('/tasas', auth(ADMIN), h(async (req, res) => {
  const errors = validate(req.body || {})
  if (errors.length) return fail(res, errors.join('. '), 400)
  const { data, error } = await supabase.from('interest_rates').insert(row(req.body)).select().single()
  if (error) return dup(error) ? fail(res, 'Ya existe una tasa con ese nombre', 409) : fail(res, error)
  await audit(req, 'crear', 'tasa', data.id, { rate: data.rate, method: data.method })
  res.status(201).send(toDTO(data))
}))

router.put('/tasas/:id', auth(ADMIN), h(async (req, res) => {
  const errors = validate(req.body || {})
  if (errors.length) return fail(res, errors.join('. '), 400)
  const { data, error } = await supabase.from('interest_rates').update(row(req.body)).eq('id', Number(req.params.id)).select().maybeSingle()
  if (error) return dup(error) ? fail(res, 'Ya existe una tasa con ese nombre', 409) : fail(res, error)
  if (!data) return fail(res, 'Tasa no encontrada', 404)
  await audit(req, 'editar', 'tasa', data.id, { rate: data.rate, method: data.method, active: data.active })
  res.send(toDTO(data))
}))

// Simulador: calcula el plan de cuotas sin guardar nada.
router.post('/simulador', auth(STAFF), h(async (req, res) => {
  const b = req.body || {}
  const firstDueDate = b.firstDueDate || suggestFirstDue(b.disbursementDate, b.frequency, b.customDays, b.skipSundays)
  const roundTo = b.roundTo === undefined ? roundStepFor((await plan.ensure(currentOrg())).country?.currency) : b.roundTo
  try {
    res.send(buildSchedule({ ...b, firstDueDate, roundTo }))
  } catch (e) {
    if (e.status === 400) return fail(res, e.message, 400)
    throw e
  }
}))

module.exports = router
