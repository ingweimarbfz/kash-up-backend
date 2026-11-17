// =====================================================================
// Plan de cada negocio (KU-026): qué funcionalidades tiene y cuántas sedes, usuarios y clientes puede crear.
// · Sin plan asignado el negocio no tiene restricciones (como antes de los planes).
// · El estado se guarda en memoria un minuto por negocio; la plataforma lo recarga al cambiar algo.
// =====================================================================
const supabase = require('./db')
const { HttpError } = require('./http')

// Ruta de la API → funcionalidad que la habilita. Lo que no aparece aquí es del núcleo (siempre disponible).
const FEATURE_ROUTES = [
  ['/inventario/promociones', 'promociones'],
  ['/promociones', 'promociones'],
  ['/inventario', 'productos'],
  ['/solicitudes-credito', 'solicitudes'],
  ['/rutas', 'rutas'], ['/ruta', 'rutas'], ['/visitas', 'rutas'],
  ['/mapa', 'mapa'],
  ['/gastos', 'gastos'], ['/cierres', 'gastos'],
  ['/capital', 'cajas'], ['/traslados-caja', 'cajas'], ['/mi-caja', 'cajas'],
  ['/vehiculos', 'vehiculos'],
  ['/conductores', 'conductores'],
  ['/reportes', 'reportes'],
  ['/bitacora', 'bitacora'],
  ['/auditoria', 'auditoria'],
  ['/notificaciones', 'telegram'], ['/mis-notificaciones', 'telegram'],
  ['/mis-creditos', 'portal_cliente'], ['/mis-pagos', 'portal_cliente']
]
const featureFor = (path) => {
  const hit = FEATURE_ROUTES.find(([p]) => path === p || path.startsWith(`${p}/`) || path.startsWith(`${p}?`))
  return hit ? hit[1] : null
}
// El conductor ve su vehículo aunque el plan no tenga "conductores" (lo crea el plan con vehículos).
const LIMITS = {
  sites: ['max_sites', 'sedes'],
  admins: ['max_admins', 'administradores'],
  lenders: ['max_lenders', 'prestamistas'],
  drivers: ['max_drivers', 'conductores'],
  client_users: ['max_client_users', 'clientes con usuario'],
  customers: ['max_customers', 'clientes']
}

const EMPTY = { plan: null, features: null, org: null, country: null, loadedAt: 0 }
const states = new Map()

const load = async (orgId) => {
  const { data: org } = await supabase.from('organizations').select('id, name, status, country_code, billing_cycle, start_date, renewal_date, extra_features, plan:plans(*), country:countries(*)').eq('id', orgId).maybeSingle()
  const st = { ...EMPTY, loadedAt: Date.now() }
  if (org) {
    st.org = { id: org.id, name: org.name, status: org.status, billingCycle: org.billing_cycle, startDate: org.start_date, renewalDate: org.renewal_date }
    st.country = org.country ? { code: org.country.code, name: org.country.name, currency: org.country.currency, locale: org.country.locale, timezone: org.country.timezone } : null
    if (org.plan) {
      st.plan = org.plan
      st.features = [...new Set([...(org.plan.features || []), ...(org.extra_features || [])])]
    }
  }
  states.set(Number(orgId), st)
  return st
}
const ensure = async (orgId) => {
  const s = states.get(Number(orgId))
  return s && Date.now() - s.loadedAt < 60000 ? s : load(orgId)
}
const refresh = async (orgId) => { if (orgId) states.delete(Number(orgId)); else states.clear() }
const has = (st, feature) => !st.features || st.features.includes(feature)

// ¿El plan del negocio permite esta ruta? Devuelve el mensaje de error o null.
const blockedFor = async (orgId, path) => {
  const feature = featureFor(path)
  if (!feature) return null
  const st = await ensure(orgId)
  if (has(st, feature)) return null
  const { data: f } = await supabase.from('plan_features').select('label').eq('key', feature).maybeSingle()
  return `Tu plan ${st.plan.name} no incluye "${f?.label || feature}". El administrador puede pedir un cambio de plan en "Mi plan".`
}

// Uso actual de cada límite del negocio.
const usage = async () => {
  const count = async (table, f = (q) => q) => (await f(supabase.from(table).select('id', { count: 'exact', head: true }))).count || 0
  const role = (r) => count('users', (q) => q.eq('role', r).eq('active', true))
  const [sites, admins, lenders, drivers, clientUsers, customers] = await Promise.all([
    count('sites', (q) => q.eq('active', true)), role('administrador'), role('prestamista'),
    count('drivers', (q) => q.eq('active', true)), role('cliente'), count('customers', (q) => q.neq('status', 'inactivo'))
  ])
  return { sites, admins, lenders, drivers, client_users: clientUsers, customers }
}

// Lanza un error si crear uno más de `kind` supera el plan.
const checkLimit = async (orgId, kind, adding = 1) => {
  const st = await ensure(orgId)
  if (!st.plan) return
  const [col, label] = LIMITS[kind]
  const max = st.plan[col]
  if (max === null || max === undefined) return
  const used = (await usage())[kind]
  if (used + adding > max) {
    throw new HttpError(max === 0
      ? `Tu plan ${st.plan.name} no incluye ${label}. Pide un plan mayor en "Mi plan".`
      : `Tu plan ${st.plan.name} permite hasta ${max} ${label} y ya tienes ${used}. Pide un plan mayor en "Mi plan".`, 409)
  }
}
const roleLimit = { administrador: 'admins', prestamista: 'lenders', cliente: 'client_users', conductor: null }

// Precio anual con descuento, redondeado a una cifra cómoda según el tamaño del precio.
const annual = (price, discount) => {
  const p = Number(price)
  const step = p >= 100000 ? 1000 : p >= 1000 ? 100 : 1
  return Math.round((p * 12 * (1 - Number(discount) / 100)) / step) * step
}
const limitsDTO = (p) => ({ sites: p.max_sites, admins: p.max_admins, lenders: p.max_lenders, drivers: p.max_drivers, clientUsers: p.max_client_users, customers: p.max_customers })

module.exports = { FEATURE_ROUTES, featureFor, LIMITS, load, ensure, refresh, has, blockedFor, usage, checkLimit, roleLimit, annual, limitsDTO }
