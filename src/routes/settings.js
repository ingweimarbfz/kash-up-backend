const express = require('express')
const supabase = require('../db')
const { currentOrg } = require('../tenant')
const { h, fail, clean, imageError } = require('../http')
const { auth, ADMIN } = require('../auth')
const { audit } = require('../audit')
const plan = require('../plan')
const { validTime, resolveRule } = require('../lib/autoCloseRule')

const router = express.Router()

const toDTO = (s, org, country) => ({
  businessName: s?.business_name || org?.name || 'Mi negocio',
  shortName: s?.short_name || null,
  logoUrl: s?.logo_url || null,
  currency: s?.currency || 'COP',
  timezone: s?.timezone || 'America/Bogota',
  receiptFooter: s?.receipt_footer || null,
  nit: org?.nit || null,
  phone: org?.phone || null,
  email: org?.email || null,
  address: org?.address || null,
  city: org?.city || null,
  autoClose: (({ mode, countryTime, ownTime, time, timezone }) => ({ mode, countryTime, ownTime, time, timezone }))(resolveRule(s, country))
})

const load = async () => {
  const org = currentOrg()
  const [{ data: s }, { data: o }] = await Promise.all([
    supabase.from('app_settings').select('*').maybeSingle(),
    supabase.from('organizations').select('*').eq('id', org).maybeSingle()
  ])
  const st = await plan.ensure(org)
  return toDTO(s, o, st.country)
}

router.get('/configuracion', auth(), h(async (req, res) => res.send(await load())))

router.put('/configuracion', auth(ADMIN), h(async (req, res) => {
  const b = req.body || {}
  if (!clean(b.businessName)) return fail(res, 'El nombre del negocio es requerido', 400)
  const logoErr = imageError(b.logoUrl, 600)
  if (logoErr) return fail(res, logoErr, 400)
  const { error } = await supabase.from('app_settings').upsert({
    business_name: clean(b.businessName),
    short_name: clean(b.shortName),
    logo_url: clean(b.logoUrl),
    receipt_footer: clean(b.receiptFooter)
  }, { onConflict: 'org_id' })
  if (error) throw error
  const { error: e2 } = await supabase.from('organizations').update({
    name: clean(b.businessName), nit: clean(b.nit), phone: clean(b.phone), email: clean(b.email), address: clean(b.address), city: clean(b.city)
  }).eq('id', currentOrg())
  if (e2) throw e2
  await audit(req, 'editar', 'configuracion', currentOrg())
  res.send(await load())
}))

// Cierre automático de jornada: hora del país, hora propia del negocio o desactivado.
router.put('/configuracion/cierre-automatico', auth(ADMIN), h(async (req, res) => {
  const b = req.body || {}
  const mode = ['pais', 'hora', 'desactivado'].includes(b.mode) ? b.mode : null
  if (!mode) return fail(res, 'Elige cómo se cierra la jornada', 400)
  if (mode === 'hora' && !validTime(b.time)) return fail(res, 'Escribe una hora entre las 12:00 y las 23:59', 400)
  // update y no upsert: el upsert intenta insertar sin business_name (obligatorio) y falla.
  const patch = { auto_close_mode: mode, auto_close_time: mode === 'hora' ? b.time : null }
  const { data: updated, error } = await supabase.from('app_settings').update(patch).select('org_id')
  if (error) throw error
  if (!updated?.length) {
    const { data: o } = await supabase.from('organizations').select('name').eq('id', currentOrg()).maybeSingle()
    const { error: e2 } = await supabase.from('app_settings').insert({ ...patch, business_name: o?.name || 'Mi negocio' })
    if (e2) throw e2
  }
  await audit(req, 'editar', 'cierre_automatico', currentOrg(), { mode, time: mode === 'hora' ? b.time : null })
  res.send((await load()).autoClose)
}))

module.exports = router
