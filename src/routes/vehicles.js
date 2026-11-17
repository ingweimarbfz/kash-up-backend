// =====================================================================
// Vehículos de cobro (KU-015): hoja de vida, documentos, mantenimientos, tanqueos y kilometraje.
// · El administrador crea y edita los vehículos y asigna el prestamista que cobra y el conductor.
// · El prestamista ve su vehículo y registra tanqueos, kilometraje y mantenimientos; si lo pagó
//   de su caja, se registra también como gasto (sale de la caja y aparece en el cierre de jornada).
// =====================================================================
const express = require('express')
const supabase = require('../db')
const { currentOrg } = require('../tenant')
const { h, fail, clean, todayBogota, imageError, PHONE_RE } = require('../http')
const { bySite } = require('../site')
const bcrypt = require('bcryptjs')
const { auth, ADMIN, STAFF, FLEET } = require('../auth')
const { audit } = require('../audit')

const router = express.Router()
const fullName = (x) => (x ? `${x.name} ${x.last_name || ''}`.trim() : null)
const ISO = /^\d{4}-\d{2}-\d{2}$/
const n = (v) => Number(v || 0)
const int = (v) => (v === '' || v === null || v === undefined ? null : Math.round(Number(v)))
const p0001 = (res, e) => (e.code === 'P0001' ? fail(res, e.message, 400) : fail(res, e))
const daysTo = (d, today) => (d ? Math.round((new Date(`${d}T12:00:00Z`) - new Date(`${today}T12:00:00Z`)) / 86400000) : null)

const KINDS = { moto: 'Moto', carro: 'Carro', camioneta: 'Camioneta', otro: 'Otro' }
const MAINT = { preventivo: 'Preventivo', correctivo: 'Correctivo', cambio_aceite: 'Cambio de aceite', llantas: 'Llantas', frenos: 'Frenos', otro: 'Otro' }
const LICENSE_CATS = ['A1', 'A2', 'B1', 'B2', 'B3', 'C1', 'C2', 'C3']
const DOCS = [['soat_expires', 'SOAT'], ['tecno_expires', 'Técnico-mecánica'], ['insurance_expires', 'Póliza']]

const DRIVER_COLS = 'id, name, last_name, identification, phone, license_number, license_category, license_expires, active'
const SELECT = `*, collector:users!vehicles_collector_id_fkey(id, name, last_name, phone), driver:drivers(${DRIVER_COLS})`
const driverDTO = (d) => (d ? { id: d.id, fullName: fullName(d), identification: d.identification, phone: d.phone, licenseNumber: d.license_number, licenseCategory: d.license_category, licenseExpires: d.license_expires, active: d.active, userId: d.user_id ?? null } : null)

// Alertas: documentos vencidos o por vencer (30 días) y cambio de aceite.
const alertsOf = (v, lastOil, today) => {
  const out = []
  for (const [k, label] of DOCS) {
    const d = daysTo(v[k], today)
    if (d === null) { if (k !== 'insurance_expires') out.push({ level: 'warn', text: `Sin fecha de ${label}` }); continue }
    if (d < 0) out.push({ level: 'bad', text: `${label} vencido hace ${-d} día(s)` })
    else if (d <= 30) out.push({ level: 'warn', text: `${label} vence en ${d} día(s)` })
  }
  if (v.oil_change_km) {
    const since = v.odometer - (lastOil ?? 0)
    if (lastOil !== null && lastOil !== undefined && since >= v.oil_change_km) out.push({ level: 'bad', text: `Cambio de aceite atrasado (${since.toLocaleString('es-CO')} km desde el último)` })
    else if (lastOil !== null && lastOil !== undefined && since >= v.oil_change_km * 0.9) out.push({ level: 'warn', text: `Cambio de aceite en ${(v.oil_change_km - since).toLocaleString('es-CO')} km` })
  }
  if (v.driver?.license_expires) {
    const d = daysTo(v.driver.license_expires, today)
    if (d < 0) out.push({ level: 'bad', text: `Licencia de ${fullName(v.driver)} vencida hace ${-d} día(s)` })
    else if (d <= 30) out.push({ level: 'warn', text: `Licencia de ${fullName(v.driver)} vence en ${d} día(s)` })
  }
  if (v.status === 'taller') out.push({ level: 'warn', text: 'En el taller' })
  return out
}

const dto = (v, extra = {}) => ({
  id: v.id, code: v.code, plate: v.plate, kind: v.kind, kindLabel: KINDS[v.kind], brand: v.brand, line: v.line, modelYear: v.model_year, color: v.color,
  engineCc: v.engine_cc, vin: v.vin, ownerName: v.owner_name, photoUrl: v.photo_url, status: v.status, odometer: v.odometer,
  collector: v.collector ? { id: v.collector.id, fullName: fullName(v.collector), phone: v.collector.phone } : null,
  driver: driverDTO(v.driver), driverId: v.driver_id,
  soatExpires: v.soat_expires, soatNumber: v.soat_number, tecnoExpires: v.tecno_expires,
  insuranceCompany: v.insurance_company, insurancePolicy: v.insurance_policy, insuranceExpires: v.insurance_expires,
  oilChangeKm: v.oil_change_km, notes: v.notes, createdAt: v.created_at, ...extra
})

// Último cambio de aceite (km) por vehículo.
const lastOilKm = async (ids) => {
  if (!ids.length) return {}
  const { data } = await supabase.from('vehicle_maintenances').select('vehicle_id, odometer').in('vehicle_id', ids).eq('kind', 'cambio_aceite').not('odometer', 'is', null).order('odometer', { ascending: false })
  const out = {}
  for (const r of data || []) if (out[r.vehicle_id] === undefined) out[r.vehicle_id] = r.odometer
  return out
}

// Vehículos que ve cada rol: el prestamista, los que cobra o conduce; el conductor, los que conduce (KU-021).
const myDrivers = async (userId) => ((await supabase.from('drivers').select('id').eq('user_id', userId)).data || []).map((d) => d.id)
// Devuelve un filtro (q => q) y no la consulta: un query builder de supabase es "thenable",
// así que devolverlo desde una función async lo ejecuta antes de tiempo (KU-025).
const vehicleScope = async (req) => {
  if (req.user.role === 'administrador') return (q) => q
  const drivers = await myDrivers(req.user.id)
  if (req.user.role === 'conductor') return (q) => q.in('driver_id', drivers.length ? drivers : [0])
  return drivers.length ? (q) => q.or(`collector_id.eq.${req.user.id},driver_id.in.(${drivers.join(',')})`) : (q) => q.eq('collector_id', req.user.id)
}
const findVehicle = async (req, id) => {
  const scope = await vehicleScope(req)
  const { data } = await scope(supabase.from('vehicles').select(SELECT).eq('id', Number(id))).maybeSingle()
  return data
}

router.get('/vehiculos', auth(FLEET), h(async (req, res) => {
  let q = supabase.from('vehicles').select(SELECT).order('code')
  q = req.user.role === 'administrador' ? bySite(req, q, 'collector_id') : (await vehicleScope(req))(q)
  const { data, error } = await q
  if (error) throw error
  const today = todayBogota()
  const ids = data.map((v) => v.id)
  const monthStart = `${today.slice(0, 8)}01`
  const [oil, { data: fuel }, { data: maint }] = await Promise.all([
    lastOilKm(ids),
    ids.length ? supabase.from('vehicle_fuel_logs').select('vehicle_id, amount, filled_on').in('vehicle_id', ids).gte('filled_on', monthStart) : { data: [] },
    ids.length ? supabase.from('vehicle_maintenances').select('vehicle_id, cost').in('vehicle_id', ids).gte('done_on', monthStart) : { data: [] }
  ])
  res.send(data.map((v) => dto(v, {
    alerts: alertsOf(v, oil[v.id], today),
    monthFuel: (fuel || []).filter((f) => f.vehicle_id === v.id).reduce((s, f) => s + n(f.amount), 0),
    monthMaintenance: (maint || []).filter((m) => m.vehicle_id === v.id).reduce((s, m) => s + n(m.cost), 0)
  })))
}))

router.get('/vehiculos/:id', auth(FLEET), h(async (req, res) => {
  const v = await findVehicle(req, req.params.id)
  if (!v) return fail(res, 'Vehículo no encontrado', 404)
  const userSel = 'user:users!USER_FK(name, last_name)'
  const [{ data: maint }, { data: fuel }, { data: odo }, oil] = await Promise.all([
    supabase.from('vehicle_maintenances').select(`*, ${userSel.replace('USER_FK', 'vehicle_maintenances_user_id_fkey')}, expense:expenses(number, status)`).eq('vehicle_id', v.id).order('done_on', { ascending: false }).order('id', { ascending: false }).limit(200),
    supabase.from('vehicle_fuel_logs').select(`*, ${userSel.replace('USER_FK', 'vehicle_fuel_logs_user_id_fkey')}, expense:expenses(number, status)`).eq('vehicle_id', v.id).order('odometer', { ascending: false }).order('id', { ascending: false }).limit(200),
    supabase.from('vehicle_odometer_logs').select(`*, ${userSel.replace('USER_FK', 'vehicle_odometer_logs_user_id_fkey')}`).eq('vehicle_id', v.id).order('read_on', { ascending: false }).order('id', { ascending: false }).limit(60),
    lastOilKm([v.id])
  ])
  const today = todayBogota()
  // Rendimiento: km recorridos entre tanqueos completos / galones cargados.
  const asc = (fuel || []).slice().sort((a, b) => a.odometer - b.odometer)
  let km = 0; let gal = 0
  for (let i = 1; i < asc.length; i++) if (asc[i].full_tank && n(asc[i].gallons)) { km += asc[i].odometer - asc[i - 1].odometer; gal += n(asc[i].gallons) }
  const from30 = new Date(`${today}T12:00:00Z`); from30.setUTCDate(from30.getUTCDate() - 30)
  const f30 = from30.toISOString().slice(0, 10)
  const odo30 = (odo || []).filter((o) => o.read_on >= f30)
  const km30 = odo30.length ? v.odometer - Math.min(...odo30.map((o) => o.odometer)) : 0
  const spent30 = (fuel || []).filter((f) => f.filled_on >= f30).reduce((s, f) => s + n(f.amount), 0) + (maint || []).filter((m) => m.done_on >= f30).reduce((s, m) => s + n(m.cost), 0)
  // Gasto por mes (6 meses) en combustible y mantenimiento.
  const months = []
  for (let i = 5; i >= 0; i--) { const d = new Date(`${today.slice(0, 8)}01T12:00:00Z`); d.setUTCMonth(d.getUTCMonth() - i); months.push(d.toISOString().slice(0, 7)) }
  const byMonth = months.map((m) => ({
    label: m,
    combustible: (fuel || []).filter((f) => f.filled_on.startsWith(m)).reduce((s, f) => s + n(f.amount), 0),
    mantenimiento: (maint || []).filter((x) => x.done_on.startsWith(m)).reduce((s, x) => s + n(x.cost), 0)
  }))
  const exp = (e) => (e ? { number: e.number, status: e.status } : null)
  res.send(dto(v, {
    alerts: alertsOf(v, oil[v.id], today),
    lastOilKm: oil[v.id] ?? null,
    stats: { kmPerGallon: gal ? Math.round((km / gal) * 10) / 10 : null, km30, spent30, costPerKm: km30 ? Math.round(spent30 / km30) : null, totalFuel: (fuel || []).reduce((s, f) => s + n(f.amount), 0), totalMaintenance: (maint || []).reduce((s, m) => s + n(m.cost), 0) },
    byMonth,
    maintenances: (maint || []).map((m) => ({ id: m.id, doneOn: m.done_on, kind: m.kind, kindLabel: MAINT[m.kind], description: m.description, odometer: m.odometer, cost: n(m.cost), workshop: m.workshop, nextDate: m.next_date, nextOdometer: m.next_odometer, photoUrl: m.photo_url, expense: exp(m.expense), user: fullName(m.user) })),
    fuel: (fuel || []).map((f, i, arr) => ({ id: f.id, filledOn: f.filled_on, odometer: f.odometer, gallons: f.gallons === null ? null : n(f.gallons), amount: n(f.amount), station: f.station, fullTank: f.full_tank, photoUrl: f.photo_url, expense: exp(f.expense), user: fullName(f.user), kmSincePrev: arr[i + 1] ? f.odometer - arr[i + 1].odometer : null })),
    odometerLogs: (odo || []).map((o) => ({ id: o.id, readOn: o.read_on, odometer: o.odometer, source: o.source, note: o.note, user: fullName(o.user) }))
  }))
}))

// ---------- Crear / editar (administrador) ----------
const rowFrom = (b) => {
  const r = {
    code: clean(b.code), plate: clean(b.plate)?.toUpperCase().replace(/\s+/g, ''), kind: b.kind || 'moto', brand: clean(b.brand), line: clean(b.line),
    model_year: int(b.modelYear), color: clean(b.color), engine_cc: int(b.engineCc), vin: clean(b.vin), owner_name: clean(b.ownerName),
    status: b.status || 'activo', collector_id: Number(b.collectorId) || null, driver_id: Number(b.driverId) || null,
    soat_expires: clean(b.soatExpires), soat_number: clean(b.soatNumber), tecno_expires: clean(b.tecnoExpires),
    insurance_company: clean(b.insuranceCompany), insurance_policy: clean(b.insurancePolicy), insurance_expires: clean(b.insuranceExpires),
    oil_change_km: int(b.oilChangeKm), notes: clean(b.notes)
  }
  if (b.photoUrl !== undefined) r.photo_url = clean(b.photoUrl)
  return r
}
const validate = (r, b) => {
  const e = []
  if (!r.code) e.push('El número interno (móvil) es obligatorio')
  if (!r.plate || !/^[A-Z0-9-]{5,8}$/.test(r.plate)) e.push('Placa no válida')
  if (!KINDS[r.kind]) e.push('Tipo de vehículo no válido')
  if (!['activo', 'taller', 'inactivo'].includes(r.status)) e.push('Estado no válido')
  if (r.model_year && (r.model_year < 1950 || r.model_year > 2100)) e.push('Año del modelo no válido')
  for (const k of ['soat_expires', 'tecno_expires', 'insurance_expires']) if (r[k] && !ISO.test(r[k])) e.push('Fecha no válida')
  const img = b.photoUrl ? imageError(b.photoUrl) : null
  if (img) e.push(img)
  return e
}
const checkDriver = async (id) => {
  if (!id) return true
  const { data } = await supabase.from('drivers').select('id').eq('id', id).eq('active', true).maybeSingle()
  return Boolean(data)
}
const checkCollector = async (id) => {
  if (!id) return true
  const { data } = await supabase.from('users').select('id').eq('id', id).eq('role', 'prestamista').maybeSingle()
  return Boolean(data)
}
const dupMsg = (error) => (error?.code === '23505' ? (String(error.message).includes('plate') ? 'Ya existe un vehículo con esa placa' : 'Ya existe un vehículo con ese número interno') : null)

router.post('/vehiculos', auth(ADMIN), h(async (req, res) => {
  const b = req.body || {}
  const r = rowFrom(b)
  const errors = validate(r, b)
  if (errors.length) return fail(res, errors.join('. '), 400)
  if (!(await checkCollector(r.collector_id))) return fail(res, 'El prestamista elegido no existe', 400)
  if (!(await checkDriver(r.driver_id))) return fail(res, 'El conductor elegido no existe o está inactivo', 400)
  r.odometer = Math.max(int(b.odometer) || 0, 0)
  const { data, error } = await supabase.from('vehicles').insert(r).select('id').single()
  if (error) return dupMsg(error) ? fail(res, dupMsg(error), 400) : fail(res, error)
  if (r.odometer) await supabase.from('vehicle_odometer_logs').insert({ vehicle_id: data.id, read_on: todayBogota(), odometer: r.odometer, source: 'manual', note: 'Kilometraje inicial', user_id: req.user.id })
  await audit(req, 'crear', 'vehiculo', data.id, { plate: r.plate })
  res.status(201).send({ id: data.id })
}))

router.put('/vehiculos/:id', auth(ADMIN), h(async (req, res) => {
  const b = req.body || {}
  const r = rowFrom(b)
  const errors = validate(r, b)
  if (errors.length) return fail(res, errors.join('. '), 400)
  if (!(await checkCollector(r.collector_id))) return fail(res, 'El prestamista elegido no existe', 400)
  if (!(await checkDriver(r.driver_id))) return fail(res, 'El conductor elegido no existe o está inactivo', 400)
  // El administrador puede corregir el kilometraje (por ejemplo, si se registró mal).
  if (b.odometer !== undefined && b.odometer !== '') r.odometer = Math.max(int(b.odometer) || 0, 0)
  const { data, error } = await supabase.from('vehicles').update(r).eq('id', Number(req.params.id)).select('id').maybeSingle()
  if (error) return dupMsg(error) ? fail(res, dupMsg(error), 400) : fail(res, error)
  if (!data) return fail(res, 'Vehículo no encontrado', 404)
  await audit(req, 'editar', 'vehiculo', data.id, { plate: r.plate })
  res.send({ id: data.id })
}))

// ---------- Registros: tanqueo, mantenimiento, kilometraje ----------
// Si se pagó de una caja, se registra el gasto con register_expense y queda ligado.
const registerExpense = async (req, v, { pay, category, amount, day, note, photoUrl }) => {
  if (!pay || pay === 'ninguna' || !(amount > 0)) return null
  let lenderId = null
  if (req.user.role === 'prestamista') lenderId = req.user.id
  else if (pay === 'prestamista') {
    if (!v.collector_id) throw Object.assign(new Error('El vehículo no tiene prestamista asignado; elige "Caja del negocio"'), { code: 'P0001' })
    lenderId = v.collector_id
  }
  const { data: id, error } = await supabase.rpc('register_expense', {
    p: { org_id: currentOrg(), lender_id: lenderId, category, amount, spent_on: day, note, photo_url: photoUrl, user_id: req.user.id }
  })
  if (error) throw error
  return id
}
const voidExpense = async (req, id, reason) => {
  if (!id) return
  await supabase.rpc('void_expense', { p_org: currentOrg(), p_expense: id, p_reason: reason, p_user: req.user.id })
}
const dayOf = (req, b) => (req.user.role === 'administrador' && ISO.test(b.date || '') ? b.date : todayBogota())

router.post('/vehiculos/:id/tanqueos', auth(STAFF), h(async (req, res) => {
  const v = await findVehicle(req, req.params.id)
  if (!v) return fail(res, 'Vehículo no encontrado', 404)
  const b = req.body || {}
  const amount = Math.round(Number(b.amount) || 0)
  const odometer = int(b.odometer)
  if (!(amount > 0)) return fail(res, 'Ingresa el valor del tanqueo', 400)
  if (odometer === null || odometer < 0) return fail(res, 'Ingresa el kilometraje del tablero', 400)
  if (odometer < v.odometer) return fail(res, `El kilometraje (${odometer.toLocaleString('es-CO')}) es menor que el actual del vehículo (${v.odometer.toLocaleString('es-CO')})`, 400)
  if (b.photoUrl && imageError(b.photoUrl)) return fail(res, imageError(b.photoUrl), 400)
  const day = dayOf(req, b)
  let expenseId = null
  try {
    expenseId = await registerExpense(req, v, { pay: b.pay, category: 'combustible', amount, day, note: `Tanqueo ${v.plate}${clean(b.station) ? ` · ${clean(b.station)}` : ''}`, photoUrl: clean(b.photoUrl) })
  } catch (e) { return p0001(res, e) }
  const { data, error } = await supabase.from('vehicle_fuel_logs').insert({
    vehicle_id: v.id, filled_on: day, odometer, gallons: Number(b.gallons) > 0 ? Number(b.gallons) : null, amount, station: clean(b.station),
    full_tank: b.fullTank !== false, photo_url: clean(b.photoUrl), expense_id: expenseId, user_id: req.user.id
  }).select('id').single()
  if (error) { await voidExpense(req, expenseId, 'Error al registrar el tanqueo'); return p0001(res, error) }
  await audit(req, 'crear', 'tanqueo', data.id, { vehicle: v.plate, amount, odometer })
  res.status(201).send({ id: data.id })
}))

router.post('/vehiculos/:id/mantenimientos', auth(STAFF), h(async (req, res) => {
  const v = await findVehicle(req, req.params.id)
  if (!v) return fail(res, 'Vehículo no encontrado', 404)
  const b = req.body || {}
  const cost = Math.max(Math.round(Number(b.cost) || 0), 0)
  if (!MAINT[b.kind]) return fail(res, 'Tipo de mantenimiento no válido', 400)
  if (!clean(b.description)) return fail(res, 'Describe qué se le hizo al vehículo', 400)
  if (b.photoUrl && imageError(b.photoUrl)) return fail(res, imageError(b.photoUrl), 400)
  const day = dayOf(req, b)
  let expenseId = null
  try {
    expenseId = await registerExpense(req, v, { pay: b.pay, category: 'mantenimiento', amount: cost, day, note: `${MAINT[b.kind]} ${v.plate}: ${clean(b.description)}`, photoUrl: clean(b.photoUrl) })
  } catch (e) { return p0001(res, e) }
  const { data, error } = await supabase.from('vehicle_maintenances').insert({
    vehicle_id: v.id, done_on: day, kind: b.kind, description: clean(b.description), odometer: int(b.odometer), cost, workshop: clean(b.workshop),
    next_date: ISO.test(b.nextDate || '') ? b.nextDate : null, next_odometer: int(b.nextOdometer), photo_url: clean(b.photoUrl), expense_id: expenseId, user_id: req.user.id
  }).select('id').single()
  if (error) { await voidExpense(req, expenseId, 'Error al registrar el mantenimiento'); return p0001(res, error) }
  if (b.inShop !== undefined && req.user.role === 'administrador') await supabase.from('vehicles').update({ status: b.inShop ? 'taller' : 'activo' }).eq('id', v.id)
  await audit(req, 'crear', 'mantenimiento', data.id, { vehicle: v.plate, kind: b.kind, cost })
  res.status(201).send({ id: data.id })
}))

// ---------- Conductores ----------
const driverRow = (b) => {
  const r = {
    name: clean(b.name), last_name: clean(b.lastName), identification: clean(b.identification), phone: clean(b.phone), address: clean(b.address),
    license_number: clean(b.licenseNumber), license_category: clean(b.licenseCategory), license_expires: clean(b.licenseExpires), notes: clean(b.notes), active: b.active !== false
  }
  if (b.licensePhotoUrl !== undefined) r.license_photo_url = clean(b.licensePhotoUrl)
  if (b.photoUrl !== undefined) r.photo_url = clean(b.photoUrl)
  if (b.idPhotoUrl !== undefined) r.id_photo_url = clean(b.idPhotoUrl)
  if (b.idPhotoBackUrl !== undefined) r.id_photo_back_url = clean(b.idPhotoBackUrl)
  const e = []
  if (!r.name) e.push('El nombre es obligatorio')
  if (!r.identification || !/^[0-9A-Za-z.-]{5,15}$/.test(r.identification)) e.push('Número de documento no válido')
  if (!r.phone || !PHONE_RE.test(r.phone)) e.push('Celular no válido')
  if (!r.license_number) e.push('El número de la licencia es obligatorio')
  if (!LICENSE_CATS.includes(r.license_category)) e.push('Elige la categoría de la licencia')
  if (!ISO.test(r.license_expires || '')) e.push('La fecha de vencimiento de la licencia es obligatoria')
  for (const k of ['licensePhotoUrl', 'photoUrl', 'idPhotoUrl', 'idPhotoBackUrl']) if (b[k] && imageError(b[k])) e.push(imageError(b[k]))
  // KU-024: foto de la persona y del documento por ambas caras.
  if (!r.photo_url || !r.id_photo_url || !r.id_photo_back_url) e.push(`Falta ${[!r.photo_url && 'la foto del conductor', !r.id_photo_url && 'la foto del documento (frente)', !r.id_photo_back_url && 'la foto del documento (reverso)'].filter(Boolean).join(', ')}`)
  return { r, e }
}
const fullDriver = (d, vehicles = [], today = todayBogota()) => ({
  ...driverDTO(d), lastName: d.last_name, name: d.name, address: d.address, notes: d.notes, licensePhotoUrl: d.license_photo_url, photoUrl: d.photo_url, idPhotoUrl: d.id_photo_url, idPhotoBackUrl: d.id_photo_back_url,
  licenseDays: daysTo(d.license_expires, today), vehicles: vehicles.filter((v) => v.driver_id === d.id).map((v) => ({ id: v.id, code: v.code, plate: v.plate }))
})

router.get('/conductores', auth(STAFF), h(async (req, res) => {
  let q = supabase.from('drivers').select('*').order('name')
  if (req.query.activos) q = q.eq('active', true)
  const [{ data, error }, { data: veh }, { data: users }] = await Promise.all([q, supabase.from('vehicles').select('id, code, plate, driver_id').not('driver_id', 'is', null),
    supabase.from('users').select('id, username, role, active, identification').in('role', ['conductor', 'prestamista'])])
  if (error) throw error
  res.send(data.map((d) => {
    const u = (users || []).find((x) => x.id === d.user_id)
    const lender = (users || []).find((x) => x.role === 'prestamista' && x.identification === d.identification)
    return { ...fullDriver(d, veh || []), access: u ? { userId: u.id, username: u.username, role: u.role, active: u.active } : null, isLender: Boolean(lender) }
  }))
}))

router.post('/conductores', auth(ADMIN), h(async (req, res) => {
  const { r, e } = driverRow(req.body || {})
  if (e.length) return fail(res, e.join('. '), 400)
  const { data, error } = await supabase.from('drivers').insert(r).select('*').single()
  if (error) return error.code === '23505' ? fail(res, 'Ya existe un conductor con ese documento', 400) : fail(res, error)
  await audit(req, 'crear', 'conductor', data.id, { identification: r.identification })
  res.status(201).send(fullDriver(data))
}))

router.put('/conductores/:id', auth(ADMIN), h(async (req, res) => {
  const { r, e } = driverRow(req.body || {})
  if (e.length) return fail(res, e.join('. '), 400)
  const { data, error } = await supabase.from('drivers').update(r).eq('id', Number(req.params.id)).select('*').maybeSingle()
  if (error) return error.code === '23505' ? fail(res, 'Ya existe un conductor con ese documento', 400) : fail(res, error)
  if (!data) return fail(res, 'Conductor no encontrado', 404)
  if (!data.active) await supabase.from('vehicles').update({ driver_id: null }).eq('driver_id', data.id)
  await audit(req, 'editar', 'conductor', data.id, { active: data.active })
  res.send(fullDriver(data))
}))

router.post('/vehiculos/:id/kilometraje', auth(STAFF), h(async (req, res) => {
  const v = await findVehicle(req, req.params.id)
  if (!v) return fail(res, 'Vehículo no encontrado', 404)
  const odometer = int(req.body?.odometer)
  if (odometer === null || odometer < 0) return fail(res, 'Ingresa el kilometraje del tablero', 400)
  if (odometer < v.odometer) return fail(res, `El kilometraje es menor que el actual (${v.odometer.toLocaleString('es-CO')})`, 400)
  const { error } = await supabase.from('vehicle_odometer_logs').insert({ vehicle_id: v.id, read_on: todayBogota(), odometer, source: 'manual', note: clean(req.body?.note), user_id: req.user.id })
  if (error) return p0001(res, error)
  res.status(201).send({ odometer })
}))

// Borrar un registro (administrador). Si generó un gasto, el gasto se anula y el dinero vuelve a la caja.
router.delete('/vehiculos/:id/:kind(tanqueos|mantenimientos)/:rid', auth(ADMIN), h(async (req, res) => {
  const table = req.params.kind === 'tanqueos' ? 'vehicle_fuel_logs' : 'vehicle_maintenances'
  const { data: r } = await supabase.from(table).select('id, expense_id, expense:expenses(status)').eq('id', Number(req.params.rid)).eq('vehicle_id', Number(req.params.id)).maybeSingle()
  if (!r) return fail(res, 'Registro no encontrado', 404)
  if (r.expense_id && r.expense?.status === 'aplicado') {
    const { error } = await supabase.rpc('void_expense', { p_org: currentOrg(), p_expense: r.expense_id, p_reason: 'Se eliminó el registro del vehículo', p_user: req.user.id })
    if (error) return p0001(res, error)
  }
  const { error } = await supabase.from(table).delete().eq('id', r.id)
  if (error) throw error
  await audit(req, 'eliminar', table === 'vehicle_fuel_logs' ? 'tanqueo' : 'mantenimiento', r.id, {})
  res.send({ ok: true })
}))

// Acceso del conductor a la app (KU-021). Si su documento es el de un prestamista, se enlaza a ese usuario.
router.post('/conductores/:id/acceso', auth(ADMIN), h(async (req, res) => {
  const b = req.body || {}
  const { data: d } = await supabase.from('drivers').select('*').eq('id', Number(req.params.id)).maybeSingle()
  if (!d) return fail(res, 'Conductor no encontrado', 404)
  if (!d.active) return fail(res, 'Activa el conductor antes de darle acceso', 400)
  const { data: same } = await supabase.from('users').select('id, role, username, active').eq('identification', d.identification).maybeSingle()
  if (same && same.role === 'prestamista') {
    await supabase.from('drivers').update({ user_id: same.id }).eq('id', d.id)
    await audit(req, 'enlazar_prestamista', 'conductor', d.id, { user: same.id })
    return res.send({ linked: 'prestamista', username: same.username, message: 'Es prestamista: entra con su usuario y ve el vehículo en "Mi vehículo".' })
  }
  if (same && same.role !== 'conductor') return fail(res, `Ese documento ya es de un usuario con rol ${same.role}`, 400)
  const username = clean(b.username)?.toLowerCase()
  if (!username || !/^[a-z0-9._-]{3,30}$/.test(username)) return fail(res, 'El usuario solo admite letras, números, punto, guion y guion bajo (3 a 30)', 400)
  // KU-024: la contraseña inicial es el número de documento; el conductor la cambia en "Mi perfil".
  const row = { identification: d.identification, name: d.name, last_name: d.last_name || '', phone: d.phone, username, role: 'conductor', active: true }
  if (!same || b.resetPassword) row.password_hash = await bcrypt.hash(String(d.identification), 10)
  const { data: u, error } = same
    ? await supabase.from('users').update(row).eq('id', same.id).select('id, username').single()
    : await supabase.from('users').insert(row).select('id, username').single()
  if (error) return error.code === '23505' ? fail(res, 'Ese nombre de usuario ya existe', 409) : fail(res, error)
  await supabase.from('drivers').update({ user_id: u.id }).eq('id', d.id)
  await audit(req, same ? 'editar' : 'crear', 'usuario_conductor', u.id, { driver: d.id })
  res.send({ linked: 'conductor', username: u.username, passwordReset: !same || Boolean(b.resetPassword) })
}))

router.delete('/conductores/:id/acceso', auth(ADMIN), h(async (req, res) => {
  const { data: d } = await supabase.from('drivers').select('id, user_id').eq('id', Number(req.params.id)).maybeSingle()
  if (!d?.user_id) return fail(res, 'Este conductor no tiene acceso', 404)
  const { data: u } = await supabase.from('users').select('id, role').eq('id', d.user_id).maybeSingle()
  if (u?.role === 'conductor') await supabase.from('users').update({ active: false }).eq('id', u.id)
  await supabase.from('drivers').update({ user_id: null }).eq('id', d.id)
  await audit(req, 'quitar_acceso', 'conductor', d.id)
  res.status(204).end()
}))

module.exports = router
module.exports.alertsOf = alertsOf
