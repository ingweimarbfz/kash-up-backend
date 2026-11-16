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
const { auth, ADMIN, STAFF } = require('../auth')
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
const DOCS = [['soat_expires', 'SOAT'], ['tecno_expires', 'Técnico-mecánica'], ['insurance_expires', 'Póliza'], ['driver_license_expires', 'Licencia del conductor']]

const SELECT = '*, collector:users!vehicles_collector_id_fkey(id, name, last_name, phone)'

// Alertas: documentos vencidos o por vencer (30 días) y cambio de aceite.
const alertsOf = (v, lastOil, today) => {
  const out = []
  for (const [k, label] of DOCS) {
    const d = daysTo(v[k], today)
    if (d === null) { if (k !== 'driver_license_expires' && k !== 'insurance_expires') out.push({ level: 'warn', text: `Sin fecha de ${label}` }); continue }
    if (d < 0) out.push({ level: 'bad', text: `${label} vencido hace ${-d} día(s)` })
    else if (d <= 30) out.push({ level: 'warn', text: `${label} vence en ${d} día(s)` })
  }
  if (v.oil_change_km) {
    const since = v.odometer - (lastOil ?? 0)
    if (lastOil !== null && lastOil !== undefined && since >= v.oil_change_km) out.push({ level: 'bad', text: `Cambio de aceite atrasado (${since.toLocaleString('es-CO')} km desde el último)` })
    else if (lastOil !== null && lastOil !== undefined && since >= v.oil_change_km * 0.9) out.push({ level: 'warn', text: `Cambio de aceite en ${(v.oil_change_km - since).toLocaleString('es-CO')} km` })
  }
  if (v.status === 'taller') out.push({ level: 'warn', text: 'En el taller' })
  return out
}

const dto = (v, extra = {}) => ({
  id: v.id, code: v.code, plate: v.plate, kind: v.kind, kindLabel: KINDS[v.kind], brand: v.brand, line: v.line, modelYear: v.model_year, color: v.color,
  engineCc: v.engine_cc, vin: v.vin, ownerName: v.owner_name, photoUrl: v.photo_url, status: v.status, odometer: v.odometer,
  collector: v.collector ? { id: v.collector.id, fullName: fullName(v.collector), phone: v.collector.phone } : null,
  driverName: v.driver_name, driverPhone: v.driver_phone, driverLicense: v.driver_license, driverLicenseExpires: v.driver_license_expires,
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

// El prestamista solo ve y registra sobre el vehículo con el que cobra.
const findVehicle = async (req, id) => {
  let q = supabase.from('vehicles').select(SELECT).eq('id', Number(id))
  if (req.user.role === 'prestamista') q = q.eq('collector_id', req.user.id)
  const { data } = await q.maybeSingle()
  return data
}

router.get('/vehiculos', auth(STAFF), h(async (req, res) => {
  let q = supabase.from('vehicles').select(SELECT).order('code')
  if (req.user.role === 'prestamista') q = q.eq('collector_id', req.user.id)
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

router.get('/vehiculos/:id', auth(STAFF), h(async (req, res) => {
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
    status: b.status || 'activo', collector_id: Number(b.collectorId) || null,
    driver_name: clean(b.driverName), driver_phone: clean(b.driverPhone), driver_license: clean(b.driverLicense), driver_license_expires: clean(b.driverLicenseExpires),
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
  if (r.driver_phone && !PHONE_RE.test(r.driver_phone)) e.push('Celular del conductor no válido')
  for (const k of ['soat_expires', 'tecno_expires', 'insurance_expires', 'driver_license_expires']) if (r[k] && !ISO.test(r[k])) e.push('Fecha no válida')
  const img = b.photoUrl ? imageError(b.photoUrl) : null
  if (img) e.push(img)
  return e
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

module.exports = router
module.exports.alertsOf = alertsOf
