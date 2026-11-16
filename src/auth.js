const jwt = require('jsonwebtoken')
const supabase = require('./db')
const tenant = require('./tenant')
const { JWT_SECRET, SESSION_HOURS } = require('./config')
const { fail } = require('./http')

// Roles de KashUp:
// · administrador: dueño u operador del negocio; ve y configura todo.
// · prestamista: cobrador/vendedor en campo; ve su ruta, sus clientes y sus cobros.
// · cliente: deudor; consulta sus créditos, cuotas y pagos.
const ROLES = ['administrador', 'prestamista', 'cliente']
const ROLE_LABELS = { administrador: 'Administrador', prestamista: 'Prestamista', cliente: 'Cliente' }
const ADMIN = ['administrador']
const STAFF = ['administrador', 'prestamista']
const ALL = ROLES

const USER_COLUMNS = 'id, org_id, identification, name, last_name, username, email, phone, role, avatar_url, active, last_login_at, created_at'

const toUserDTO = (u) => ({
  id: u.id,
  orgId: u.org_id,
  identification: u.identification,
  name: u.name,
  lastName: u.last_name,
  fullName: `${u.name} ${u.last_name || ''}`.trim(),
  username: u.username,
  email: u.email,
  phone: u.phone,
  role: u.role,
  roleLabel: ROLE_LABELS[u.role],
  avatarUrl: u.avatar_url,
  active: u.active,
  lastLoginAt: u.last_login_at,
  createdAt: u.created_at
})

const signToken = (user) => jwt.sign({ sub: String(user.id), org: user.org_id, role: user.role }, JWT_SECRET, { expiresIn: `${SESSION_HOURS}h` })

// Valida el token y vuelve a leer el usuario: un cambio de rol o una desactivación aplican de inmediato.
// El resto de la petición corre en el contexto de la organización del usuario.
const auth = (roles = ALL) => async (req, res, next) => {
  try {
    const header = req.headers.authorization || ''
    const token = header.startsWith('Bearer ') ? header.slice(7) : null
    if (!token) return fail(res, 'Debes iniciar sesión', 401)
    let payload
    try { payload = jwt.verify(token, JWT_SECRET) } catch { return fail(res, 'Tu sesión expiró. Inicia sesión de nuevo.', 401) }

    const { data: user, error } = await supabase.from('users')
      .select(`${USER_COLUMNS}, org:organizations(id, status)`).eq('id', Number(payload.sub)).maybeSingle()
    if (error) throw error
    if (!user || !user.active) return fail(res, 'Usuario inactivo o inexistente', 401)
    if (user.org?.status === 'suspendida') return fail(res, 'El servicio de tu negocio está suspendido. Contacta a KashUp.', 401)
    if (!roles.includes(user.role)) return fail(res, 'No tienes permiso para esta acción', 403)
    req.user = user
    return tenant.runAsOrg(user.org_id, () => next())
  } catch (e) {
    fail(res, e)
  }
}

module.exports = { ROLES, ROLE_LABELS, ADMIN, STAFF, ALL, USER_COLUMNS, toUserDTO, signToken, auth }
