const express = require('express')
const bcrypt = require('bcryptjs')
const supabase = require('../db')
const { h, fail, clean, EMAIL_RE, PHONE_RE, DOC_RE, imageError } = require('../http')
const { auth, ADMIN, ROLES, USER_COLUMNS, toUserDTO } = require('../auth')
const { audit } = require('../audit')
const { currentOrg } = require('../tenant')
const plan = require('../plan')

const router = express.Router()

const validate = (b, { creating }) => {
  const errors = []
  for (const [k, label] of [['identification', 'Identificación'], ['name', 'Nombre'], ['username', 'Usuario'], ['role', 'Rol']]) {
    if (!clean(b[k])) errors.push(`${label} es requerido`)
  }
  if (b.role && !ROLES.includes(b.role)) errors.push('Rol inválido')
  if (clean(b.identification) && !DOC_RE.test(clean(b.identification))) errors.push('Identificación no válida')
  if (clean(b.username) && !/^[a-z0-9._-]{3,30}$/i.test(clean(b.username))) errors.push('El usuario solo admite letras, números, punto, guion y guion bajo (3 a 30)')
  if (clean(b.email) && !EMAIL_RE.test(clean(b.email))) errors.push('Correo no válido')
  if (clean(b.phone) && !PHONE_RE.test(clean(b.phone))) errors.push('Teléfono no válido (7 a 10 dígitos)')
  if (!creating && b.password && b.role !== 'cliente' && b.password.length < 8) errors.push('La contraseña debe tener al menos 8 caracteres')
  for (const [k, kb] of [['avatarUrl', 200], ['photoUrl', 1500], ['idPhotoUrl', 1500], ['idPhotoBackUrl', 1500]]) {
    const e = imageError(b[k], kb)
    if (e) errors.push(e)
  }
  return errors
}

// KU-024: foto de la persona y del documento por ambas caras (obligatorias al crear y si faltan al editar).
// El cliente ya tiene sus fotos en la ficha del cliente.
const missingPhotos = (b, current = {}) => b.role === 'cliente' ? [] : [
  !(b.photoUrl || current.photo_url) && 'la foto de la persona',
  !(b.idPhotoUrl || current.id_photo_url) && 'la foto del documento (frente)',
  !(b.idPhotoBackUrl || current.id_photo_back_url) && 'la foto del documento (reverso)'
].filter(Boolean)
const photoPatch = (b) => {
  const p = {}
  if (b.photoUrl !== undefined) { p.photo_url = clean(b.photoUrl); if (b.avatarUrl !== undefined) p.avatar_url = clean(b.avatarUrl) }
  if (b.idPhotoUrl !== undefined) p.id_photo_url = clean(b.idPhotoUrl)
  if (b.idPhotoBackUrl !== undefined) p.id_photo_back_url = clean(b.idPhotoBackUrl)
  return p
}

const dupMessage = (e) => (e?.code === '23505'
  ? (String(e.message).includes('username') ? 'Ese nombre de usuario ya existe' : 'Ya existe un usuario con esa identificación')
  : null)

const activeAdmins = async (excludeId) => {
  const { count, error } = await supabase.from('users').select('id', { count: 'exact', head: true })
    .eq('role', 'administrador').eq('active', true).neq('id', excludeId)
  if (error) throw error
  return count
}

router.get('/usuarios', auth(ADMIN), h(async (req, res) => {
  let q = supabase.from('users').select(USER_COLUMNS).order('name')
  if (ROLES.includes(req.query.rol)) q = q.eq('role', req.query.rol)
  if (req.siteId) q = q.or(`site_id.eq.${req.siteId},role.eq.administrador`)
  const { data, error } = await q
  if (error) throw error
  res.send(data.map(toUserDTO))
}))

// Fotos del usuario (no van en la lista para no hacerla pesada).
router.get('/usuarios/:id', auth(ADMIN), h(async (req, res) => {
  const { data, error } = await supabase.from('users').select(`${USER_COLUMNS}, photo_url, id_photo_url, id_photo_back_url`).eq('id', Number(req.params.id)).maybeSingle()
  if (error) throw error
  if (!data) return fail(res, 'Usuario no encontrado', 404)
  res.send({ ...toUserDTO(data), photoUrl: data.photo_url, idPhotoUrl: data.id_photo_url, idPhotoBackUrl: data.id_photo_back_url })
}))

router.post('/usuarios', auth(ADMIN), h(async (req, res) => {
  const b = req.body || {}
  const errors = validate(b, { creating: true })
  if (b.role === 'conductor') errors.push('El acceso de un conductor se crea desde Conductores, para enlazarlo con su vehículo')
  const missing = missingPhotos(b)
  if (missing.length) errors.push(`Falta ${missing.join(', ')}`)
  if (errors.length) return fail(res, errors.join('. '), 400)
  if (plan.roleLimit[b.role] && b.active !== false) await plan.checkLimit(currentOrg(), plan.roleLimit[b.role])
  const { data, error } = await supabase.from('users').insert({
    identification: clean(b.identification),
    name: clean(b.name),
    last_name: clean(b.lastName) || '',
    username: clean(b.username).toLowerCase(),
    email: clean(b.email),
    phone: clean(b.phone),
    role: b.role,
    site_id: Number(b.siteId) || null,
    // KU-024: la contraseña inicial es el número de identificación (el cliente la conserva siempre).
    password_hash: await bcrypt.hash(String(clean(b.identification)), 10),
    ...photoPatch(b),
    active: b.active !== false
  }).select(USER_COLUMNS).single()
  if (error) return dupMessage(error) ? fail(res, dupMessage(error), 409) : fail(res, error)
  await audit(req, 'crear', 'usuario', data.id, { role: data.role, username: data.username })
  res.status(201).send(toUserDTO(data))
}))

router.put('/usuarios/:id', auth(ADMIN), h(async (req, res) => {
  const id = Number(req.params.id)
  const b = req.body || {}
  const errors = validate(b, { creating: false })
  if (errors.length) return fail(res, errors.join('. '), 400)
  const { data: current } = await supabase.from('users').select('id, role, active, identification, photo_url, id_photo_url, id_photo_back_url').eq('id', id).maybeSingle()
  if (!current) return fail(res, 'Usuario no encontrado', 404)
  const missing = missingPhotos(b, current)
  if (missing.length) return fail(res, `Falta ${missing.join(', ')}`, 400)
  // Reactivar o cambiar de rol cuenta contra el límite del plan.
  if (plan.roleLimit[b.role] && b.active !== false && (!current.active || current.role !== b.role)) await plan.checkLimit(currentOrg(), plan.roleLimit[b.role])
  // Siempre debe quedar al menos un administrador activo.
  const losesAdmin = current.role === 'administrador' && current.active && (b.role !== 'administrador' || b.active === false)
  if (losesAdmin && (await activeAdmins(id)) === 0) return fail(res, 'Debe quedar al menos un administrador activo', 400)
  const patch = {
    identification: clean(b.identification),
    name: clean(b.name),
    last_name: clean(b.lastName) || '',
    username: clean(b.username).toLowerCase(),
    email: clean(b.email),
    phone: clean(b.phone),
    role: b.role,
    site_id: Number(b.siteId) || null,
    ...photoPatch(b),
    active: b.active !== false
  }
  // El cliente siempre entra con su documento. A los demás se les puede poner una clave o volverla al documento.
  const reset = b.role === 'cliente' ? (current.role !== 'cliente' || patch.identification !== current.identification || b.resetPassword) : b.resetPassword
  if (reset) patch.password_hash = await bcrypt.hash(String(patch.identification), 10)
  else if (b.password && b.role !== 'cliente') patch.password_hash = await bcrypt.hash(b.password, 10)
  const { data, error } = await supabase.from('users').update(patch).eq('id', id).select(USER_COLUMNS).single()
  if (error) return dupMessage(error) ? fail(res, dupMessage(error), 409) : fail(res, error)
  await audit(req, 'editar', 'usuario', id, { role: data.role, active: data.active, password: Boolean(reset || (b.password && b.role !== 'cliente')) })
  res.send(toUserDTO(data))
}))

module.exports = router
