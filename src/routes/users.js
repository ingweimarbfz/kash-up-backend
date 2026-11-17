const express = require('express')
const bcrypt = require('bcryptjs')
const supabase = require('../db')
const { h, fail, clean, EMAIL_RE, PHONE_RE, DOC_RE, NAME_RE, imageError, HttpError } = require('../http')
const { auth, ADMIN, ROLES, PROFILE_ORDER, USER_COLUMNS, toUserDTO } = require('../auth')
const { audit } = require('../audit')
const { currentOrg } = require('../tenant')
const plan = require('../plan')
const { driverRow } = require('./vehicles')

const router = express.Router()

const validate = (b, { creating }) => {
  const errors = []
  for (const [k, label] of [['identification', 'Identificación'], ['name', 'Nombre'], ['username', 'Usuario'], ['role', 'Rol']]) {
    if (!clean(b[k])) errors.push(`${label} es requerido`)
  }
  if (b.role && !ROLES.includes(b.role)) errors.push('Rol inválido')
  if (clean(b.identification) && !DOC_RE.test(clean(b.identification))) errors.push('Identificación no válida')
  if (clean(b.name) && !NAME_RE.test(clean(b.name))) errors.push('Los nombres solo admiten letras')
  if (clean(b.lastName) && !NAME_RE.test(clean(b.lastName))) errors.push('Los apellidos solo admiten letras')
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

// KU-031: perfiles pedidos en el formulario → perfil principal (role) y adicionales (extra_roles).
// Precedencia del principal: administrador > prestamista > conductor. El cliente no combina perfiles.
const profilesFrom = (b) => {
  if (b.role === 'cliente') return { role: 'cliente', extra: [] }
  const list = Array.isArray(b.profiles) && b.profiles.length ? b.profiles : [b.role]
  const set = PROFILE_ORDER.filter((r) => list.includes(r))
  if (!set.length) throw new HttpError('Elige al menos un perfil: administrador, prestamista o conductor')
  return { role: set[0], extra: set.slice(1) }
}

// Perfil de conductor: necesita su ficha en Conductores (licencia y fotos). Se valida antes de guardar
// el usuario y se enlaza después. Si ya hay un conductor con ese documento, se reutiliza su ficha.
const prepareDriver = async (b, userId, current = {}) => {
  const linked = userId ? (await supabase.from('drivers').select('*').eq('user_id', userId).maybeSingle()).data : null
  const same = linked || (await supabase.from('drivers').select('*').eq('identification', clean(b.identification)).maybeSingle()).data
  const d = b.driver || {}
  const pick = (k, col) => (d[k] !== undefined && d[k] !== '' ? d[k] : same?.[col])
  const { r, e } = driverRow({
    name: b.name, lastName: b.lastName, identification: b.identification, phone: clean(b.phone) || same?.phone,
    address: same?.address, notes: same?.notes, active: true,
    licenseNumber: pick('licenseNumber', 'license_number'), licenseCategory: pick('licenseCategory', 'license_category'), licenseExpires: pick('licenseExpires', 'license_expires'),
    licensePhotoUrl: d.licensePhotoUrl !== undefined ? d.licensePhotoUrl : same?.license_photo_url,
    photoUrl: b.photoUrl || current.photo_url || same?.photo_url,
    idPhotoUrl: b.idPhotoUrl || current.id_photo_url || same?.id_photo_url,
    idPhotoBackUrl: b.idPhotoBackUrl || current.id_photo_back_url || same?.id_photo_back_url
  })
  if (!clean(b.phone) && !same?.phone) e.unshift('El celular es obligatorio para el perfil de conductor')
  if (e.length) throw new HttpError(`Perfil de conductor: ${[...new Set(e)].join('. ')}`)
  if (same && same.user_id && same.user_id !== userId) throw new HttpError('Ese conductor ya tiene acceso con otro usuario')
  if (!same) await plan.checkLimit(currentOrg(), 'drivers')
  return { r, same }
}
const linkDriver = async (req, prep, userId) => {
  const row = { ...prep.r, user_id: userId }
  const { data, error } = prep.same
    ? await supabase.from('drivers').update(row).eq('id', prep.same.id).select('id').single()
    : await supabase.from('drivers').insert(row).select('id').single()
  if (error) throw error
  await audit(req, prep.same ? 'enlazar_usuario' : 'crear', 'conductor', data.id, { user: userId })
}
const unlinkDriver = (userId) => supabase.from('drivers').update({ user_id: null }).eq('user_id', userId)

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
  if (req.siteId) q = q.or(`site_id.eq.${req.siteId},role.eq.administrador`)
  const { data, error } = await q
  if (error) throw error
  // KU-031: el filtro por rol incluye a quien tiene ese perfil como adicional.
  const rol = ROLES.includes(req.query.rol) ? req.query.rol : null
  res.send(data.filter((u) => !rol || u.role === rol || (u.extra_roles || []).includes(rol)).map(toUserDTO))
}))

// Fotos del usuario (no van en la lista para no hacerla pesada).
router.get('/usuarios/:id', auth(ADMIN), h(async (req, res) => {
  const { data, error } = await supabase.from('users').select(`${USER_COLUMNS}, photo_url, id_photo_url, id_photo_back_url`).eq('id', Number(req.params.id)).maybeSingle()
  if (error) throw error
  if (!data) return fail(res, 'Usuario no encontrado', 404)
  const { data: d } = await supabase.from('drivers').select('id, license_number, license_category, license_expires, license_photo_url').eq('user_id', data.id).maybeSingle()
  res.send({
    ...toUserDTO(data), photoUrl: data.photo_url, idPhotoUrl: data.id_photo_url, idPhotoBackUrl: data.id_photo_back_url,
    driver: d ? { id: d.id, licenseNumber: d.license_number, licenseCategory: d.license_category, licenseExpires: d.license_expires, licensePhotoUrl: d.license_photo_url } : null
  })
}))

router.post('/usuarios', auth(ADMIN), h(async (req, res) => {
  const b = req.body || {}
  const { role, extra } = profilesFrom(b)
  b.role = role
  const errors = validate(b, { creating: true })
  const missing = missingPhotos(b)
  if (missing.length) errors.push(`Falta ${missing.join(', ')}`)
  if (errors.length) return fail(res, errors.join('. '), 400)
  if (plan.roleLimit[role] && b.active !== false) await plan.checkLimit(currentOrg(), plan.roleLimit[role])
  if (extra.includes('prestamista') && b.active !== false) await plan.checkLimit(currentOrg(), 'lenders')
  const wantsDriver = role === 'conductor' || extra.includes('conductor')
  const driverPrep = wantsDriver ? await prepareDriver(b, null) : null
  const { data, error } = await supabase.from('users').insert({
    identification: clean(b.identification),
    name: clean(b.name),
    last_name: clean(b.lastName) || '',
    username: clean(b.username).toLowerCase(),
    email: clean(b.email),
    phone: clean(b.phone),
    role,
    extra_roles: extra,
    site_id: Number(b.siteId) || null,
    // KU-024: la contraseña inicial es el número de identificación (el cliente la conserva siempre).
    password_hash: await bcrypt.hash(String(clean(b.identification)), 10),
    ...photoPatch(b),
    active: b.active !== false
  }).select(USER_COLUMNS).single()
  if (error) return dupMessage(error) ? fail(res, dupMessage(error), 409) : fail(res, error)
  if (driverPrep) await linkDriver(req, driverPrep, data.id)
  await audit(req, 'crear', 'usuario', data.id, { role: data.role, extra, username: data.username })
  res.status(201).send(toUserDTO(data))
}))

router.put('/usuarios/:id', auth(ADMIN), h(async (req, res) => {
  const id = Number(req.params.id)
  const b = req.body || {}
  const { role, extra } = profilesFrom(b)
  b.role = role
  const errors = validate(b, { creating: false })
  if (errors.length) return fail(res, errors.join('. '), 400)
  const { data: current } = await supabase.from('users').select('id, role, extra_roles, is_lender, active, identification, photo_url, id_photo_url, id_photo_back_url').eq('id', id).maybeSingle()
  if (!current) return fail(res, 'Usuario no encontrado', 404)
  const missing = missingPhotos(b, current)
  if (missing.length) return fail(res, `Falta ${missing.join(', ')}`, 400)
  // Reactivar o cambiar de rol cuenta contra el límite del plan.
  if (plan.roleLimit[b.role] && b.active !== false && (!current.active || current.role !== b.role)) await plan.checkLimit(currentOrg(), plan.roleLimit[b.role])
  if (extra.includes('prestamista') && b.active !== false && (!current.active || !current.is_lender)) await plan.checkLimit(currentOrg(), 'lenders')
  const wantsDriver = role === 'conductor' || extra.includes('conductor')
  const driverPrep = wantsDriver ? await prepareDriver(b, id, current) : null
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
    role,
    extra_roles: extra,
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
  if (driverPrep) await linkDriver(req, driverPrep, id)
  else await unlinkDriver(id)
  await audit(req, 'editar', 'usuario', id, { role: data.role, extra, active: data.active, password: Boolean(reset || (b.password && b.role !== 'cliente')) })
  res.send(toUserDTO(data))
}))

module.exports = router
