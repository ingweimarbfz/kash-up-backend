const express = require('express')
const bcrypt = require('bcryptjs')
const supabase = require('../db')
const { h, fail, clean, EMAIL_RE, PHONE_RE, DOC_RE } = require('../http')
const { auth, ADMIN, ROLES, USER_COLUMNS, toUserDTO } = require('../auth')
const { audit } = require('../audit')

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
  if (creating && (!b.password || b.password.length < 8)) errors.push('La contraseña debe tener al menos 8 caracteres')
  if (!creating && b.password && b.password.length < 8) errors.push('La contraseña debe tener al menos 8 caracteres')
  return errors
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

router.post('/usuarios', auth(ADMIN), h(async (req, res) => {
  const b = req.body || {}
  const errors = validate(b, { creating: true })
  if (b.role === 'conductor') errors.push('El acceso de un conductor se crea desde Conductores, para enlazarlo con su vehículo')
  if (errors.length) return fail(res, errors.join('. '), 400)
  const { data, error } = await supabase.from('users').insert({
    identification: clean(b.identification),
    name: clean(b.name),
    last_name: clean(b.lastName) || '',
    username: clean(b.username).toLowerCase(),
    email: clean(b.email),
    phone: clean(b.phone),
    role: b.role,
    site_id: Number(b.siteId) || null,
    password_hash: await bcrypt.hash(b.password, 10),
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
  const { data: current } = await supabase.from('users').select('id, role, active').eq('id', id).maybeSingle()
  if (!current) return fail(res, 'Usuario no encontrado', 404)
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
    active: b.active !== false
  }
  if (b.password) patch.password_hash = await bcrypt.hash(b.password, 10)
  const { data, error } = await supabase.from('users').update(patch).eq('id', id).select(USER_COLUMNS).single()
  if (error) return dupMessage(error) ? fail(res, dupMessage(error), 409) : fail(res, error)
  await audit(req, 'editar', 'usuario', id, { role: data.role, active: data.active, password: Boolean(b.password) })
  res.send(toUserDTO(data))
}))

module.exports = router
