const jwt = require('jsonwebtoken')
const supabase = require('./db')
const tenant = require('./tenant')
const { JWT_SECRET, SESSION_HOURS } = require('./config')
const { fail } = require('./http')
const { loadSite } = require('./site')

// Roles de QuontUp360:
// · administrador: dueño u operador del negocio; ve y configura todo.
// · prestamista: cobrador/vendedor en campo; ve su ruta, sus clientes y sus cobros.
// · cliente: deudor; consulta sus créditos, cuotas y pagos.
// · conductor: maneja un vehículo de la flota; solo consulta el reporte de su vehículo (KU-021).
const ROLES = ['administrador', 'prestamista', 'cliente', 'conductor']
const ROLE_LABELS = { administrador: 'Administrador', prestamista: 'Prestamista', cliente: 'Cliente', conductor: 'Conductor' }
const ADMIN = ['administrador']
const STAFF = ['administrador', 'prestamista']
const FLEET = ['administrador', 'prestamista', 'conductor']
const ALL = ROLES

const USER_COLUMNS = 'id, org_id, identification, name, last_name, username, email, phone, role, extra_roles, is_lender, avatar_url, active, last_login_at, created_at, site_id, site:sites(id, name, city)'

// KU-031: perfiles con los que puede entrar un usuario. role es el principal; extra_roles, los adicionales.
const PROFILE_ORDER = ['administrador', 'prestamista', 'conductor']
const profilesOf = (u) => {
  const base = u.primary_role || u.role
  if (base === 'cliente') return ['cliente']
  const set = new Set([base, ...(u.extra_roles || [])])
  return PROFILE_ORDER.filter((r) => set.has(r))
}

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
  primaryRole: u.primary_role || u.role,
  extraRoles: u.extra_roles || [],
  profiles: profilesOf(u),
  isLender: Boolean(u.is_lender),
  avatarUrl: u.avatar_url,
  active: u.active,
  lastLoginAt: u.last_login_at,
  createdAt: u.created_at,
  siteId: u.site_id ?? null,
  site: u.site ? { id: u.site.id, name: u.site.name, city: u.site.city } : null
})

// El token lleva el perfil con el que entró (KU-031).
const signToken = (user, role = user.role) => jwt.sign({ sub: String(user.id), org: user.org_id, role }, JWT_SECRET, { expiresIn: `${SESSION_HOURS}h` })

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
    if (['suspendida', 'cancelada'].includes(user.org?.status)) return fail(res, 'El servicio de tu negocio está suspendido. Contacta a QuontUp360.', 401)
    // KU-031: el resto de la petición usa el perfil con el que entró, si todavía lo tiene.
    user.primary_role = user.role
    if (payload.role && payload.role !== user.role && profilesOf(user).includes(payload.role)) user.role = payload.role
    if (!roles.includes(user.role)) return fail(res, 'No tienes permiso para esta acción', 403)
    req.user = user
    return tenant.runAsOrg(user.org_id, async () => {
      try {
        // KU-026: la ruta debe estar incluida en el plan del negocio.
        const blocked = await require('./plan').blockedFor(user.org_id, req.originalUrl.split('?')[0])
        if (blocked) return fail(res, blocked, 403)
        await loadSite(req)
      } catch (e) { return fail(res, e) }
      return next()
    })
  } catch (e) {
    fail(res, e)
  }
}

module.exports = { PROFILE_ORDER, profilesOf, ROLES, ROLE_LABELS, ADMIN, STAFF, FLEET, ALL, USER_COLUMNS, toUserDTO, signToken, auth }
