const express = require('express')
const supabase = require('../db')
const { currentOrg } = require('../tenant')
const { h, fail, clean, imageError } = require('../http')
const { auth, ADMIN } = require('../auth')
const { audit } = require('../audit')

const router = express.Router()

const toDTO = (s, org) => ({
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
  city: org?.city || null
})

const load = async () => {
  const org = currentOrg()
  const [{ data: s }, { data: o }] = await Promise.all([
    supabase.from('app_settings').select('*').maybeSingle(),
    supabase.from('organizations').select('*').eq('id', org).maybeSingle()
  ])
  return toDTO(s, o)
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

module.exports = router
