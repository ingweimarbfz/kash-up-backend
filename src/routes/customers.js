const express = require('express')
const bcrypt = require('bcryptjs')
const supabase = require('../db')
const { h, fail, clean, num, EMAIL_RE, PHONE_RE, DOC_RE, imageError, todayBogota } = require('../http')
const { auth, ADMIN, STAFF, toUserDTO, USER_COLUMNS } = require('../auth')
const { audit } = require('../audit')
const { score } = require('../lib/scoring')
const { currentOrg } = require('../tenant')
const plan = require('../plan')
const { bySite } = require('../site')

const router = express.Router()
const DOC_TYPES = ['CC', 'CE', 'TI', 'PA', 'PPT', 'NIT']
const LIST_COLUMNS = 'id, doc_type, identification, name, last_name, phone, address, neighborhood, city, photo_thumb, utility_bill_at, lender_id, user_id, status, created_at, lender:users!customers_lender_id_fkey(id, name, last_name)'

const fullName = (x) => (x ? `${x.name} ${x.last_name || ''}`.trim() : null)
const toDTO = (c, extra = {}) => ({
  id: c.id,
  docType: c.doc_type,
  identification: c.identification,
  name: c.name,
  lastName: c.last_name,
  fullName: fullName(c),
  phone: c.phone,
  phone2: c.phone2 ?? null,
  email: c.email ?? null,
  address: c.address,
  neighborhood: c.neighborhood,
  city: c.city,
  occupation: c.occupation ?? null,
  businessAddress: c.business_address ?? null,
  birthDate: c.birth_date ?? null,
  photoUrl: c.photo_url ?? null,
  photoThumb: c.photo_thumb ?? null,
  idPhotoUrl: c.id_photo_url ?? null,
  idPhotoBackUrl: c.id_photo_back_url ?? null,
  utilityBillUrl: c.utility_bill_url ?? null,
  utilityBillAt: c.utility_bill_at ?? null,
  hasUtilityBill: Boolean(c.utility_bill_at || c.utility_bill_url),
  lat: c.lat ?? null,
  lng: c.lng ?? null,
  lenderId: c.lender_id,
  lender: c.lender ? { id: c.lender.id, fullName: fullName(c.lender) } : null,
  userId: c.user_id,
  creditLimit: c.credit_limit === undefined || c.credit_limit === null ? null : Number(c.credit_limit),
  status: c.status,
  notes: c.notes ?? null,
  createdAt: c.created_at,
  ...extra
})

// El prestamista solo ve y edita los clientes que tiene asignados.
const scoped = (req, q) => (req.user.role === 'prestamista' ? q.eq('lender_id', req.user.id) : bySite(req, q))
// La ficha de un cliente se abre aunque sea de otra sede (por ejemplo, desde el buscador).
const mineOnly = (req, q) => (req.user.role === 'prestamista' ? q.eq('lender_id', req.user.id) : q)
const loadOne = async (req, id) => {
  const { data } = await mineOnly(req, supabase.from('customers').select('*, lender:users!customers_lender_id_fkey(id, name, last_name)').eq('id', id)).maybeSingle()
  return data
}

const validate = (b, isNew = false) => {
  const errors = []
  if (!DOC_TYPES.includes(b.docType || 'CC')) errors.push('Tipo de documento inválido')
  if (!clean(b.identification)) errors.push('La identificación es requerida')
  else if (!DOC_RE.test(clean(b.identification))) errors.push('Identificación no válida')
  if (!clean(b.name)) errors.push('El nombre es requerido')
  if (!clean(b.phone)) errors.push('El celular es requerido')
  else if (!PHONE_RE.test(clean(b.phone))) errors.push('Celular no válido (7 a 10 dígitos)')
  if (clean(b.phone2) && !PHONE_RE.test(clean(b.phone2))) errors.push('Teléfono 2 no válido')
  if (clean(b.email) && !EMAIL_RE.test(clean(b.email))) errors.push('Correo no válido')
  if (!clean(b.address)) errors.push('La dirección es requerida')
  if (!clean(b.photoUrl)) errors.push('La foto del cliente es obligatoria')
  if (isNew && !clean(b.utilityBillUrl)) errors.push('La foto del recibo de servicios (para comprobar la dirección) es obligatoria')
  for (const [k, label] of [['photoUrl', 'La foto'], ['photoThumb', 'La miniatura'], ['idPhotoUrl', 'La foto del documento (delantera)'], ['idPhotoBackUrl', 'La foto del documento (trasera)'], ['utilityBillUrl', 'La foto del recibo de servicios']]) {
    const e = imageError(b[k], 900); if (e) errors.push(`${label}: ${e}`)
  }
  if (b.lat !== undefined && b.lat !== null && b.lat !== '' && !(Math.abs(Number(b.lat)) <= 90)) errors.push('Latitud inválida')
  if (b.lng !== undefined && b.lng !== null && b.lng !== '' && !(Math.abs(Number(b.lng)) <= 180)) errors.push('Longitud inválida')
  if (b.creditLimit !== undefined && b.creditLimit !== null && b.creditLimit !== '' && !(Number(b.creditLimit) >= 0)) errors.push('Cupo inválido')
  if (b.status && !['activo', 'bloqueado', 'inactivo'].includes(b.status)) errors.push('Estado inválido')
  return errors
}

const rowFrom = (b) => {
  const row = {
  doc_type: b.docType || 'CC',
  identification: clean(b.identification),
  name: clean(b.name),
  last_name: clean(b.lastName) || '',
  phone: clean(b.phone),
  phone2: clean(b.phone2),
  email: clean(b.email),
  address: clean(b.address),
  neighborhood: clean(b.neighborhood),
  city: clean(b.city),
  occupation: clean(b.occupation),
  business_address: clean(b.businessAddress),
  birth_date: clean(b.birthDate),
  photo_url: clean(b.photoUrl),
  photo_thumb: clean(b.photoThumb),
  id_photo_url: clean(b.idPhotoUrl),
  id_photo_back_url: clean(b.idPhotoBackUrl),
  lat: num(b.lat),
  lng: num(b.lng),
  credit_limit: num(b.creditLimit),
  notes: clean(b.notes)
  }
  // El recibo solo se toca si viene en la petición (no se borra al editar otros datos).
  if (b.utilityBillUrl !== undefined && clean(b.utilityBillUrl)) row.utility_bill_url = clean(b.utilityBillUrl)
  return row
}

// Valida que el prestamista asignado exista y tenga ese rol.
const checkLender = async (id) => {
  if (!id) return null
  const { data } = await supabase.from('users').select('id').eq('id', Number(id)).eq('role', 'prestamista').eq('active', true).maybeSingle()
  return data ? data.id : undefined
}

const dupMessage = (e) => (e?.code === '23505' ? 'Ya existe un cliente con esa identificación' : null)

// Lista con saldo de créditos activos.
router.get('/clientes', auth(STAFF), h(async (req, res) => {
  let q = scoped(req, supabase.from('customers').select(LIST_COLUMNS)).order('name').limit(Math.min(Number(req.query.limit) || 1000, 1000))
  if (req.query.estado) q = q.eq('status', req.query.estado)
  if (req.user.role === 'administrador' && Number(req.query.prestamista)) q = q.eq('lender_id', Number(req.query.prestamista))
  const term = clean(req.query.q)
  if (term) {
    const t = term.replace(/[%,()]/g, ' ')
    q = q.or(`name.ilike.%${t}%,last_name.ilike.%${t}%,identification.ilike.%${t}%,phone.ilike.%${t}%`)
  }
  const { data, error } = await q
  if (error) throw error
  const ids = data.map((c) => c.id)
  const balances = {}
  if (ids.length) {
    const { data: bal, error: e2 } = await supabase.from('credit_balances').select('customer_id, balance, overdue_amount').eq('status', 'activo').in('customer_id', ids)
    if (e2) throw e2
    for (const b of bal) {
      const x = balances[b.customer_id] || (balances[b.customer_id] = { activeCredits: 0, balance: 0, overdue: 0 })
      x.activeCredits++; x.balance += Number(b.balance); x.overdue += Number(b.overdue_amount)
    }
  }
  res.send(data.map((c) => toDTO(c, balances[c.id] || { activeCredits: 0, balance: 0, overdue: 0 })))
}))

// Prestamistas activos (para asignar clientes y créditos).
router.get('/prestamistas', auth(STAFF), h(async (req, res) => {
  const { data, error } = await bySite(req, supabase.from('users').select('id, name, last_name, site_id').eq('role', 'prestamista').eq('active', true).order('name'), 'id')
  if (error) throw error
  res.send(data.map((u) => ({ id: u.id, fullName: fullName(u), siteId: u.site_id })))
}))

router.get('/clientes/:id', auth(STAFF), h(async (req, res) => {
  const c = await loadOne(req, Number(req.params.id))
  if (!c) return fail(res, 'Cliente no encontrado', 404)
  const [{ data: credits }, { data: inst }, { data: bal }, { data: user }, { data: transfers }] = await Promise.all([
    supabase.from('credits').select('id, number, kind, principal, total_amount, frequency, installments_count, disbursement_date, status, created_at').eq('customer_id', c.id).order('created_at', { ascending: false }),
    supabase.from('installments').select('due_date, status, paid_at, credit:credits!inner(customer_id)').eq('credit.customer_id', c.id),
    supabase.from('credit_balances').select('credit_id, balance, overdue_amount, overdue_count, next_due_date, paid_count').eq('customer_id', c.id),
    c.user_id ? supabase.from('users').select('id, username, active').eq('id', c.user_id).maybeSingle() : Promise.resolve({ data: null }),
    supabase.from('customer_transfers').select('id, old_address, new_address, credits_moved, balance_moved, note, created_at, from:users!customer_transfers_from_lender_id_fkey(name, last_name), to:users!customer_transfers_to_lender_id_fkey(name, last_name), user:users!customer_transfers_user_id_fkey(name, last_name)').eq('customer_id', c.id).order('id', { ascending: false })
  ])
  const byId = Object.fromEntries((bal || []).map((b) => [b.credit_id, b]))
  res.send(toDTO(c, {
    score: score({ installments: inst || [], credits: credits || [], today: todayBogota() }),
    user: user ? { id: user.id, username: user.username, active: user.active } : null,
    transfers: (transfers || []).map((t) => ({ id: t.id, from: fullName(t.from), to: fullName(t.to), oldAddress: t.old_address, newAddress: t.new_address, creditsMoved: t.credits_moved, balanceMoved: Number(t.balance_moved), note: t.note, createdAt: t.created_at, user: fullName(t.user) })),
    credits: (credits || []).map((k) => ({
      id: k.id, number: k.number, kind: k.kind, principal: Number(k.principal), totalAmount: Number(k.total_amount), frequency: k.frequency,
      installmentsCount: k.installments_count, disbursementDate: k.disbursement_date, status: k.status,
      balance: Number(byId[k.id]?.balance ?? 0), overdue: Number(byId[k.id]?.overdue_amount ?? 0), overdueCount: byId[k.id]?.overdue_count ?? 0,
      paidCount: byId[k.id]?.paid_count ?? 0, nextDueDate: byId[k.id]?.next_due_date ?? null
    }))
  }))
}))

router.post('/clientes', auth(STAFF), h(async (req, res) => {
  const b = req.body || {}
  const errors = validate(b, true)
  if (errors.length) return fail(res, errors.join('. '), 400)
  await plan.checkLimit(currentOrg(), 'customers')
  let lenderId = req.user.role === 'prestamista' ? req.user.id : await checkLender(b.lenderId)
  if (lenderId === undefined) return fail(res, 'El prestamista asignado no existe o está inactivo', 400)
  const row = { ...rowFrom(b), utility_bill_at: new Date().toISOString(), lender_id: lenderId, created_by: req.user.id }
  if (req.user.role === 'administrador' && b.status) row.status = b.status
  const { data, error } = await supabase.from('customers').insert(row).select('id').single()
  if (error) return dupMessage(error) ? fail(res, dupMessage(error), 409) : fail(res, error)
  await audit(req, 'crear', 'cliente', data.id, { identification: row.identification })
  res.status(201).send(toDTO(await loadOne(req, data.id)))
}))

router.put('/clientes/:id', auth(STAFF), h(async (req, res) => {
  const id = Number(req.params.id)
  const current = await loadOne(req, id)
  if (!current) return fail(res, 'Cliente no encontrado', 404)
  const b = req.body || {}
  const errors = validate(b)
  if (errors.length) return fail(res, errors.join('. '), 400)
  const patch = rowFrom(b)
  if (patch.utility_bill_url && patch.utility_bill_url !== current.utility_bill_url) patch.utility_bill_at = new Date().toISOString()
  if (req.user.role === 'administrador') {
    const lenderId = await checkLender(b.lenderId)
    if (lenderId === undefined) return fail(res, 'El prestamista asignado no existe o está inactivo', 400)
    // Cambiar de prestamista es un traslado de ruta: sus créditos activos pasan al nuevo prestamista.
    if (b.lenderId !== undefined && (lenderId || null) !== (current.lender_id || null)) {
      const { error: te } = await supabase.rpc('transfer_customer', { p: { org_id: currentOrg(), customer_id: id, to_lender_id: lenderId, note: 'Cambio de prestamista desde la ficha', user_id: req.user.id } })
      if (te) return te.code === 'P0001' ? fail(res, te.message, 400) : fail(res, te)
    }
    if (b.status) patch.status = b.status
  } else {
    delete patch.credit_limit // el cupo lo define el administrador
  }
  const { error } = await supabase.from('customers').update(patch).eq('id', id)
  if (error) return dupMessage(error) ? fail(res, dupMessage(error), 409) : fail(res, error)
  // KU-024: si cambió el documento, el usuario del cliente se actualiza y su contraseña vuelve a ser el documento.
  if (current.user_id && patch.identification && patch.identification !== current.identification) {
    await supabase.from('users').update({ identification: patch.identification, password_hash: await bcrypt.hash(String(patch.identification), 10) }).eq('id', current.user_id)
  }
  await audit(req, 'editar', 'cliente', id)
  res.send(toDTO(await loadOne(req, id)))
}))

// Subir o cambiar la foto del recibo de servicios.
router.put('/clientes/:id/recibo', auth(STAFF), h(async (req, res) => {
  const id = Number(req.params.id)
  const current = await loadOne(req, id)
  if (!current) return fail(res, 'Cliente no encontrado', 404)
  const url = clean(req.body?.utilityBillUrl)
  if (!url) return fail(res, 'Toma la foto del recibo de servicios', 400)
  const e = imageError(url, 900)
  if (e) return fail(res, `Recibo: ${e}`, 400)
  const { error } = await supabase.from('customers').update({ utility_bill_url: url, utility_bill_at: new Date().toISOString() }).eq('id', id)
  if (error) throw error
  await audit(req, 'recibo', 'cliente', id)
  res.send(toDTO(await loadOne(req, id)))
}))

// Traslado de ruta: el cliente se muda o pasa a otro prestamista. Sus créditos activos pasan al nuevo prestamista.
// Lo hace el administrador o el prestamista que hoy tiene al cliente.
router.post('/clientes/:id/traslado', auth(STAFF), h(async (req, res) => {
  const id = Number(req.params.id)
  const current = await loadOne(req, id)
  if (!current) return fail(res, 'Cliente no encontrado', 404)
  const b = req.body || {}
  const to = await checkLender(b.lenderId)
  if (to === undefined) return fail(res, 'El prestamista de destino no existe o está inactivo', 400)
  if (!to) return fail(res, 'Elige el prestamista de la nueva ruta', 400)
  const moving = clean(b.address) && clean(b.address) !== current.address
  if (moving && !clean(b.utilityBillUrl)) return fail(res, 'Toma la foto del recibo de servicios de la nueva dirección', 400)
  const e = imageError(b.utilityBillUrl, 900)
  if (e) return fail(res, `Recibo: ${e}`, 400)
  if (b.lat !== undefined && b.lat !== null && b.lat !== '' && !(Math.abs(Number(b.lat)) <= 90)) return fail(res, 'Latitud inválida', 400)
  const p = { org_id: currentOrg(), customer_id: id, to_lender_id: to, note: clean(b.note), user_id: req.user.id }
  if (moving) Object.assign(p, { address: clean(b.address), neighborhood: clean(b.neighborhood) || '', city: clean(b.city) || current.city || '', lat: num(b.lat) ?? '', lng: num(b.lng) ?? '', utility_bill_url: clean(b.utilityBillUrl) })
  else if (clean(b.utilityBillUrl)) p.utility_bill_url = clean(b.utilityBillUrl)
  const { data: tid, error } = await supabase.rpc('transfer_customer', { p })
  if (error) return error.code === 'P0001' ? fail(res, error.message, 400) : fail(res, error)
  await audit(req, 'trasladar', 'cliente', id, { from: current.lender_id, to, moving: Boolean(moving), transfer: tid })
  const { data } = await supabase.from('customers').select('*, lender:users!customers_lender_id_fkey(id, name, last_name)').eq('id', id).single()
  res.send(toDTO(data))
}))

// Crea (o actualiza) el usuario con rol cliente para que consulte sus créditos.
router.post('/clientes/:id/usuario', auth(ADMIN), h(async (req, res) => {
  const id = Number(req.params.id)
  const c = await loadOne(req, id)
  if (!c) return fail(res, 'Cliente no encontrado', 404)
  const username = String(clean(req.body?.username) || '').toLowerCase()
  if (!/^[a-z0-9._-]{3,30}$/.test(username)) return fail(res, 'Usuario inválido (3 a 30: letras, números, punto, guion)', 400)
  if (!c.user_id) await plan.checkLimit(currentOrg(), 'client_users')
  // KU-024: el cliente siempre entra con su número de documento como contraseña.
  const password = String(c.identification)
  let user
  if (c.user_id) {
    const patch = { username, identification: c.identification, active: req.body?.active !== false, password_hash: await bcrypt.hash(password, 10) }
    const { data, error } = await supabase.from('users').update(patch).eq('id', c.user_id).select(USER_COLUMNS).single()
    if (error) return error.code === '23505' ? fail(res, 'Ese nombre de usuario ya existe', 409) : fail(res, error)
    user = data
  } else {
    const { data, error } = await supabase.from('users').insert({
      identification: c.identification, name: c.name, last_name: c.last_name, username, email: c.email, phone: c.phone,
      role: 'cliente', password_hash: await bcrypt.hash(password, 10), avatar_url: c.photo_thumb
    }).select(USER_COLUMNS).single()
    if (error) return error.code === '23505' ? fail(res, String(error.message).includes('username') ? 'Ese nombre de usuario ya existe' : 'Ya existe un usuario con esa identificación', 409) : fail(res, error)
    user = data
    await supabase.from('customers').update({ user_id: user.id }).eq('id', id)
  }
  await audit(req, c.user_id ? 'editar' : 'crear', 'usuario_cliente', user.id, { customer: id })
  res.send(toUserDTO(user))
}))

module.exports = router
