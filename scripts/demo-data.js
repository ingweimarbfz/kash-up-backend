// =====================================================================
// Genera un SQL con datos de prueba para el negocio 1: sedes, prestamistas (ruteros), conductores,
// vehículos, clientes, créditos con cuotas y pagos de las últimas dos semanas, gastos, cierres de
// jornada, productos con galería y promociones.
// · Usa las mismas funciones de la base que usa la app (create_credit, register_payment, register_expense,
//   fund_assign, close_day, void_payment), así los saldos, cajas e inventario quedan cuadrados.
// · Se simula día por día y se ajusta la hora de cada registro para que la bitácora y los reportes se vean reales.
// · Contraseñas: el número de documento de cada persona (KU-024).
// Uso: node scripts/demo-data.js [AAAA-MM-DD hoy] > datos.sql
// =====================================================================
const bcrypt = require('bcryptjs')
const { buildSchedule, toISO, parseISO } = require('../src/lib/schedule')

const [todayArg] = process.argv.slice(2)
const hash = (doc) => bcrypt.hashSync(String(doc), 10)
const face = (k) => `https://i.pravatar.cc/400?u=kashup-${k}`
const docImg = (k, side) => `https://placehold.co/900x570/e2e8f0/334155.png?text=Documento+${side}+${encodeURIComponent(k)}`
const photos = (k) => `'${face(k)}', '${face(k)}', '${docImg(k, 'frente')}', '${docImg(k, 'reverso')}'`
const TODAY = todayArg || new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date())
const DAYS = 14
const addDays = (iso, n) => { const d = parseISO(iso); d.setUTCDate(d.getUTCDate() + n); return toISO(d) }
const isSunday = (iso) => parseISO(iso).getUTCDay() === 0
const workday = (iso) => (isSunday(iso) ? addDays(iso, 1) : iso)
// Día hábil anterior a hoy (sin domingos).
const prevWorkday = (n = 1) => { let d = TODAY; for (let k = 0; k < n; k++) { d = addDays(d, -1); if (isSunday(d)) d = addDays(d, -1) } return d }
const ts = (day, h, m) => `'${day} ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00-05'`
const q = (v) => (v === null || v === undefined ? 'null' : `'${String(v).replace(/'/g, "''")}'`)
const j = (o) => `${q(JSON.stringify(o))}::jsonb`
let seed = 7
const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646 }
const pick = (a) => a[Math.floor(rnd() * a.length)]
const between = (a, b) => a + Math.floor(rnd() * (b - a + 1))
let key = 0
const out = []
const sql = (s) => out.push(s)
const m = (k) => `pg_temp.m('${k}')`
// Guarda el id devuelto por una función o un insert.
const keep = (k, expr) => sql(`insert into _m values ('${k}', (${expr}));`)
const keepInsert = (k, insert) => sql(`with x as (${insert} returning id) insert into _m select '${k}', id from x;`)
const audit = (user, action, entity, entityId, detail, at) => sql(`insert into audit_log (org_id, user_id, action, entity, entity_id, detail, ip, created_at) values (1, ${user}, '${action}', '${entity}', (${entityId})::text, ${j(detail || {})}, '181.54.${between(1, 250)}.${between(1, 250)}', ${at});`)

// ---------- Personas y sedes ----------
const SITES = [
  { k: 'med', name: 'Sede Medellín', city: 'Medellín', address: 'Cra 70 # 44-12, Laureles', lat: 6.2476, lng: -75.5658, wh: 'Bodega Medellín' },
  { k: 'cal', name: 'Sede Cali', city: 'Cali', address: 'Av 6N # 23-50, Granada', lat: 3.4516, lng: -76.532, wh: 'Bodega Cali' }
]
const LENDERS = [
  { k: 'carlos', username: 'carlos.perez', name: 'Carlos', last: 'Pérez', id: '1017234501', site: 'med' },
  { k: 'diana', username: 'diana.gomez', name: 'Diana', last: 'Gómez', id: '1017234502', site: 'med' },
  { k: 'jorge', username: 'jorge.rios', name: 'Jorge', last: 'Ríos', id: '1144056703', site: 'cal' },
  { k: 'laura', username: 'laura.mora', name: 'Laura', last: 'Mora', id: '1144056704', site: 'cal' },
  { k: 'andres', username: 'andres.vargas', name: 'Andrés', last: 'Vargas', id: '1020456705', site: 2 }
]
const DRIVERS = [
  { k: 'sebastian', username: 'sebastian.ortiz', name: 'Sebastián', last: 'Ortiz', id: '1017888001', phone: '3104567801', user: true },
  { k: 'miguel', username: 'miguel.torres', name: 'Miguel', last: 'Torres', id: '1144888002', phone: '3154567802', user: true },
  // Jorge Ríos es prestamista y también conduce: entra con su usuario de prestamista.
  { k: 'jorgec', name: 'Jorge', last: 'Ríos', id: '1144056703', phone: '3164567803', lender: 'jorge' }
]
const FIRST = ['María', 'Luis', 'Paola', 'Andrés', 'Sandra', 'Hernán', 'Camila', 'Juan', 'Gloria', 'Óscar', 'Natalia', 'Fabio', 'Yolanda', 'Wilson', 'Liliana', 'Edwin', 'Marta', 'Ricardo', 'Diana', 'Javier', 'Rosa', 'Mauricio', 'Adriana', 'Fredy', 'Claudia', 'Germán', 'Luz Dary', 'Álvaro', 'Beatriz', 'Nelson']
const LAST = ['Restrepo', 'Arango', 'Cárdenas', 'Mejía', 'López', 'Vélez', 'Ortiz', 'Zapata', 'Henao', 'Rendón', 'Muñoz', 'Castaño', 'Salazar', 'Ocampo', 'Giraldo', 'Valencia', 'Cardona', 'Montoya', 'Ramírez', 'Quintero']
const HOODS = { med: ['Laureles', 'Belén', 'Robledo', 'Castilla', 'Aranjuez', 'Buenos Aires'], cal: ['Granada', 'Siloé', 'El Poblado', 'Alfonso López', 'San Fernando', 'Ciudad Córdoba'], 2: ['Usaquén', 'Toberín', 'Cedritos', 'Verbenal', 'Suba', 'Orquídeas'] }
const CENTER = { med: [6.2476, -75.5658], cal: [3.4516, -76.532], 2: [4.7110, -74.0300] }
const BUSINESS = ['Tienda', 'Peluquería', 'Venta de arepas', 'Miscelánea', 'Taller de motos', 'Frutería', 'Panadería', 'Modistería', 'Venta de minutos', 'Ferretería']

const sqlHeader = () => {
  sql(`-- Datos de prueba de KashUp (generado el ${TODAY}). Se ejecuta una sola vez en el SQL Editor de Supabase.`)
  sql('begin;')
  sql(`do $$ begin if exists (select 1 from public.users where username = 'carlos.perez') then raise exception 'Los datos de prueba ya están cargados'; end if; end $$;`)
  sql('set local search_path = public;')
  sql('create temp table _m (k text primary key, id bigint) on commit drop;')
  sql('create function pg_temp.m(text) returns bigint language sql as $$ select id from _m where k = $1 $$;')
  sql(`insert into _m values ('admin', (select id from users where org_id = 1 and role = 'administrador' order by id limit 1));`)
  sql(`insert into _m values ('biz', public.fund_business_account(1));`)
}

const build = async () => {
  sqlHeader()
  const start = addDays(TODAY, -DAYS)

  // Sedes y bodegas.
  sql('-- Sedes y bodegas')
  for (const s of SITES) {
    keepInsert(`site:${s.k}`, `insert into sites (org_id, name, city, address, phone, active) values (1, ${q(s.name)}, ${q(s.city)}, ${q(s.address)}, '6045550${between(100, 999)}', true)`)
    keepInsert(`wh:${s.k}`, `insert into warehouses (org_id, site_id, name, responsible, location, is_general, active) values (1, ${m(`site:${s.k}`)}, ${q(s.wh)}, 'Coordinador ${s.city}', ${q(s.address)}, false, true)`)
  }
  sql(`insert into _m values ('site:2', 2), ('wh:2', 2);`)
  sql(`update sites set city = 'Bogotá' where id in (1, 2) and city is null;`)

  // Capital del negocio y prestamistas.
  sql('-- Capital: aporte del dueño')
  sql(`insert into fund_movements (org_id, account_id, type, amount, note, user_id, created_at) values (1, ${m('biz')}, 'aporte', 40000000, 'Aporte de capital (datos de prueba)', ${m('admin')}, ${ts(start, 7, 0)});`)
  sql('-- Prestamistas (ruteros)')
  for (const l of LENDERS) {
    keepInsert(`u:${l.k}`, `insert into users (org_id, identification, name, last_name, username, email, phone, role, password_hash, site_id, active, avatar_url, photo_url, id_photo_url, id_photo_back_url) values (1, '${l.id}', ${q(l.name)}, ${q(l.last)}, '${l.username}', null, '300${l.id.slice(-7)}', 'prestamista', '${hash(l.id)}', ${m(`site:${l.site}`)}, true, ${photos(l.username)})`)
    sql(`select public.fund_assign(1, ${m(`u:${l.k}`)}, 6000000, ${m('admin')}, 'Base inicial de la ruta');`)
    audit(m('admin'), 'asignar_capital', 'prestamista', m(`u:${l.k}`), { amount: 6000000 }, ts(start, 7, 10))
  }
  sql(`update fund_movements set created_at = ${ts(start, 7, 10)} where type in ('asignacion') and created_at > now() - interval '1 minute' and note = 'Base inicial de la ruta';`)

  // Conductores y vehículos.
  sql('-- Conductores y vehículos')
  for (const d of DRIVERS) {
    if (d.user) keepInsert(`u:${d.k}`, `insert into users (org_id, identification, name, last_name, username, phone, role, password_hash, active, avatar_url, photo_url, id_photo_url, id_photo_back_url) values (1, '${d.id}', ${q(d.name)}, ${q(d.last)}, '${d.username}', '${d.phone}', 'conductor', '${hash(d.id)}', true, ${photos(d.username || d.k)})`)
    keepInsert(`d:${d.k}`, `insert into drivers (org_id, name, last_name, identification, phone, address, license_number, license_category, license_expires, active, notes, user_id, photo_url, license_photo_url, id_photo_url, id_photo_back_url) values (1, ${q(d.name)}, ${q(d.last)}, '${d.id}', '${d.phone}', 'Barrio ${pick(['Centro', 'La América', 'Bello Horizonte'])}', 'LC${d.id.slice(-6)}', 'A2', '${addDays(TODAY, d.k === 'miguel' ? 20 : 400)}', true, null, ${d.user ? m(`u:${d.k}`) : m(`u:${d.lender}`)}, '${face(d.username || 'jorge.rios')}', '${docImg(d.k, 'licencia')}', '${docImg(d.k, 'frente')}', '${docImg(d.k, 'reverso')}')`)
  }
  const VEH = [
    { k: 'v1', code: 'MED-01', plate: 'KTM45F', brand: 'Bajaj', line: 'Boxer CT 100', year: 2022, color: 'Roja', odo: 18400, driver: 'sebastian', collector: 'carlos', soat: 90, tecno: 12 },
    { k: 'v2', code: 'CAL-01', plate: 'XZA81G', brand: 'Honda', line: 'CB 125F', year: 2024, color: 'Negra', odo: 6200, driver: 'miguel', collector: 'laura', soat: 8, tecno: 200 },
    { k: 'v3', code: 'CAL-02', plate: 'JRP27E', brand: 'Suzuki', line: 'Gixxer 150', year: 2023, color: 'Azul', odo: 11050, driver: 'jorgec', collector: 'jorge', soat: 160, tecno: 160 }
  ]
  for (const v of VEH) {
    keepInsert(`veh:${v.k}`, `insert into vehicles (org_id, code, plate, kind, brand, line, model_year, color, status, odometer, collector_id, driver_id, soat_expires, soat_number, tecno_expires, oil_change_km, notes) values (1, '${v.code}', '${v.plate}', 'moto', '${v.brand}', ${q(v.line)}, ${v.year}, '${v.color}', 'activo', ${v.odo}, ${m(`u:${v.collector}`)}, ${m(`d:${v.driver}`)}, '${addDays(TODAY, v.soat)}', 'SOAT-${v.plate}', '${addDays(TODAY, v.tecno)}', 2000, 'Moto de la ruta (datos de prueba)')`)
    let odo = v.odo
    for (let k = 0; k < 5; k++) {
      const day = addDays(start, k * 3 + 1)
      odo += between(150, 260)
      const gal = (between(15, 30) / 10).toFixed(1)
      sql(`insert into vehicle_fuel_logs (org_id, vehicle_id, filled_on, odometer, gallons, amount, station, full_tank, user_id, created_at) values (1, ${m(`veh:${v.k}`)}, '${day}', ${odo}, ${gal}, ${Math.round(gal * 16500 / 100) * 100}, '${pick(['Terpel', 'Primax', 'Biomax', 'Texaco'])}', ${rnd() > 0.4}, ${m(`u:${v.collector}`)}, ${ts(day, 7, between(0, 40))});`)
    }
    const mday = addDays(start, between(3, 10))
    sql(`insert into vehicle_maintenances (org_id, vehicle_id, done_on, kind, description, odometer, cost, workshop, next_date, next_odometer, user_id, created_at) values (1, ${m(`veh:${v.k}`)}, '${mday}', 'cambio_aceite', 'Cambio de aceite y filtro', ${v.odo + 300}, 45000, 'Motos ${pick(['El Rayo', 'La 30', 'Express'])}', '${addDays(mday, 60)}', ${v.odo + 2300}, ${m(`u:${v.collector}`)}, ${ts(mday, 16, 20)});`)
    if (v.k === 'v2') sql(`insert into vehicle_maintenances (org_id, vehicle_id, done_on, kind, description, odometer, cost, workshop, user_id, created_at) values (1, ${m(`veh:${v.k}`)}, '${prevWorkday(2)}', 'frenos', 'Cambio de pastillas delanteras', ${v.odo + 900}, 68000, 'Taller Granada', ${m(`u:${v.collector}`)}, ${ts(prevWorkday(2), 15, 5)});`)
    sql(`update vehicles set odometer = ${odo} where id = ${m(`veh:${v.k}`)};`)
  }

  // Productos: fotos, galería, productos nuevos y existencias por bodega.
  sql('-- Productos, galería y existencias')
  const img = (s) => `https://picsum.photos/seed/kashup-${s}/800/800`
  sql(`update products set photo_url = coalesce(photo_url, 'https://picsum.photos/seed/kashup-p' || id || '/800/800'), gallery = array['https://picsum.photos/seed/kashup-p' || id || 'a/800/800', 'https://picsum.photos/seed/kashup-p' || id || 'b/800/800'], description = coalesce(description, 'Producto de muestra para probar la ficha, la galería y las promociones.') where org_id = 1;`)
  const NEWP = [
    { k: 'lav', sku: 'LAV-16', name: 'Lavadora 16 kg', cat: 1, brand: 'LG', cost: 1150000, price: 1590000, desc: 'Lavadora de carga superior, 16 kg, 8 programas.' },
    { k: 'red', sku: 'CEL-RN13', name: 'Celular Redmi Note 13', cat: 2, brand: 'Xiaomi', cost: 640000, price: 899000, desc: '256 GB, cámara de 108 MP, batería de 5000 mAh.' },
    { k: 'com', sku: 'COM-4P', name: 'Comedor 4 puestos', cat: 3, brand: 'Muebles Jamar', cost: 520000, price: 840000, desc: 'Mesa en madera con 4 sillas tapizadas.' }
  ]
  for (const p of NEWP) {
    keepInsert(`p:${p.k}`, `insert into products (org_id, sku, name, category_id, brand, description, cost, price, stock, min_stock, photo_url, gallery, active) values (1, '${p.sku}', ${q(p.name)}, ${p.cat}, ${q(p.brand)}, ${q(p.desc)}, ${p.cost}, ${p.price}, 0, 2, '${img(p.k)}', array['${img(p.k + '1')}', '${img(p.k + '2')}', '${img(p.k + '3')}'], true)`)
  }
  const stockIn = [['med', 'p:lav', 4], ['med', 'p:red', 6], ['med', 'p:com', 3], ['cal', 'p:lav', 3], ['cal', 'p:red', 5], ['cal', 'p:com', 2]]
  for (const [s, p, n] of stockIn) sql(`insert into inventory_movements (org_id, warehouse_id, product_id, type, quantity, unit_cost, note, user_id, created_at) values (1, ${m(`wh:${s}`)}, ${m(p)}, 'entrada', ${n}, null, 'Inventario inicial de la sede', ${m('admin')}, ${ts(start, 8, 0)});`)
  sql(`insert into inventory_movements (org_id, warehouse_id, product_id, type, quantity, note, user_id, created_at) select 1, ${m('wh:med')}, id, 'entrada', 3, 'Inventario inicial de la sede', ${m('admin')}, ${ts(start, 8, 0)} from products where org_id = 1 and sku in ('TV-50', 'COL-DOB', 'CEL-A15');`)
  sql(`insert into inventory_movements (org_id, warehouse_id, product_id, type, quantity, note, user_id, created_at) select 1, 2, id, 'entrada', 3, 'Reposición de la sede', ${m('admin')}, ${ts(start, 8, 0)} from products where org_id = 1 and sku = 'COL-DOB';`)
  sql(`insert into inventory_movements (org_id, warehouse_id, product_id, type, quantity, note, user_id, created_at) select 1, ${m('wh:cal')}, id, 'entrada', 2, 'Inventario inicial de la sede', ${m('admin')}, ${ts(start, 8, 0)} from products where org_id = 1 and sku in ('TV-50', 'NEV-300', 'CEL-A15');`)

  // Promociones: una vigente ahora, una por franja horaria, Black Friday programado y diciembre.
  sql('-- Promociones')
  sql(`insert into promotions (org_id, name, tag, emoji, color, description, type, value, starts_at, ends_at, time_from, time_to, weekdays, scope, category_ids, product_ids, active, created_by) values
 (1, 'Quincena del hogar', 'HOGAR', '🏠', '#0EA5E9', '15 % en electrodomésticos durante la quincena.', 'porcentaje', 15, ${ts(start, 0, 0)}, ${ts(addDays(TODAY, 6), 23, 59)}, null, null, '{}', 'categorias', array[1]::bigint[], '{}', true, ${m('admin')}),
 (1, 'Hora feliz celulares', 'HORA FELIZ', '⚡', '#F59E0B', 'Todos los días de 6 a 8 p. m. los celulares tienen $ 60.000 menos.', 'valor', 60000, null, null, '18:00', '20:00', '{}', 'categorias', array[2]::bigint[], '{}', true, ${m('admin')}),
 (1, 'Black Friday', 'BLACK FRIDAY', '🖤', '#111827', 'El viernes negro: 25 % en todo el catálogo.', 'porcentaje', 25, '2026-11-27 00:00:00-05', '2026-11-30 23:59:00-05', null, null, '{}', 'todos', '{}', '{}', true, ${m('admin')}),
 (1, 'Navidad en casa', 'NAVIDAD', '🎄', '#DC2626', 'Comedor y colchón con precio especial en diciembre.', 'porcentaje', 12, '2026-12-01 00:00:00-05', '2026-12-24 23:59:00-05', null, null, '{}', 'productos', '{}', array[${m('p:com')}, (select id from products where sku = 'COL-DOB' and org_id = 1)]::bigint[], true, ${m('admin')}),
 (1, 'Fin de semana Redmi', 'FINDE', '📱', '#8B5CF6', 'Sábados y domingos, 10 % en el Redmi Note 13.', 'porcentaje', 10, null, null, null, null, '{6,7}', 'productos', '{}', array[${m('p:red')}]::bigint[], true, ${m('admin')});`)

  // Clientes por prestamista.
  sql('-- Clientes')
  const customers = []
  const clientUsers = []
  let ci = 0
  for (const l of LENDERS) {
    const n = l.k === 'andres' ? 5 : 7
    for (let i = 0; i < n; i++) {
      const name = FIRST[ci % FIRST.length]; const last = `${LAST[(ci * 7) % LAST.length]} ${LAST[(ci * 3 + 5) % LAST.length]}`
      const [la, ln] = CENTER[l.site]
      const c = { k: `c${ci}`, lender: l, name, last, lat: la + (rnd() - 0.5) * 0.06, lng: ln + (rnd() - 0.5) * 0.06, profile: i === 0 ? 'atrasado' : i === 1 ? 'muy_atrasado' : i === 2 ? 'adelantado' : 'puntual' }
      customers.push(c)
      const ident = String(1000000000 + 43711 * (ci + 11))
      keepInsert(`c:${c.k}`, `insert into customers (org_id, photo_url, photo_thumb, id_photo_url, id_photo_back_url, doc_type, identification, name, last_name, phone, address, neighborhood, city, occupation, business_address, lat, lng, lender_id, credit_limit, status, route_order, created_by, created_at) values (1, '${face(c.k)}', '${face(c.k)}', '${docImg(c.k, 'frente')}', '${docImg(c.k, 'reverso')}', 'CC', '${ident}', ${q(name)}, ${q(last)}, '3${between(0, 2)}${between(10000000, 99999999)}', ${q(`Calle ${between(10, 99)} # ${between(10, 80)}-${between(10, 99)}`)}, ${q(pick(HOODS[l.site]))}, ${q(l.site === 'med' ? 'Medellín' : l.site === 'cal' ? 'Cali' : 'Bogotá')}, ${q(pick(BUSINESS))}, ${q(`Local ${between(1, 30)}`)}, ${c.lat.toFixed(6)}, ${c.lng.toFixed(6)}, ${m(`u:${l.k}`)}, ${pick([1000000, 1500000, 2000000])}, 'activo', ${i + 1}, ${m(`u:${l.k}`)}, ${ts(start, 8, 30 + i)})`)
      audit(m(`u:${l.k}`), 'crear', 'cliente', m(`c:${c.k}`), {}, ts(start, 8, 30 + i))
      // Algunos clientes con acceso a la app: su contraseña es siempre su documento.
      if (i === 2 && ['carlos', 'jorge'].includes(l.k)) {
        const username = `${name}.${last.split(' ')[0]}`.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, '')
        clientUsers.push({ username, ident, lender: l })
        keepInsert(`cu:${c.k}`, `insert into users (org_id, identification, name, last_name, username, role, password_hash, active, avatar_url) values (1, '${ident}', ${q(name)}, ${q(last)}, '${username}', 'cliente', '${hash(ident)}', true, '${face(c.k)}')`)
        sql(`update customers set user_id = ${m(`cu:${c.k}`)} where id = ${m(`c:${c.k}`)};`)
      }
      ci++
    }
  }

  // Simulación día por día.
  const lenderOf = (c) => c.lender
  const credits = [] // { c, k, schedule, paid, lender }
  customers.forEach((c, i) => {
    const kind = i % 9 === 4 ? 'producto' : 'efectivo'
    const weekly = i % 5 === 3
    const day = workday(addDays(start, 1 + (i % 6)))
    credits.push({ c, k: `k${i}`, day, kind, weekly, principal: kind === 'producto' ? null : pick([200000, 300000, 400000, 500000, 600000, 700000]) })
  })
  const RATES = { diario: { id: 1, name: 'Diario 20 %', method: 'fija', rate: 20, basis: 'total', freq: 'diaria' }, semanal: { id: 2, name: 'Semanal 5 % mensual', method: 'fija', rate: 5, basis: 'mensual', freq: 'semanal' } }
  const PRODUCT_FOR = { med: { k: 'p:lav', name: 'Lavadora 16 kg', price: 1590000, promo: 15 }, cal: { k: 'p:red', name: 'Celular Redmi Note 13', price: 899000 }, 2: { sku: 'COL-DOB', name: 'Colchón doble', price: 620000 } }
  const lenderDayOps = {}
  for (let d = 0; d <= DAYS; d++) {
    const day = addDays(start, d)
    if (isSunday(day)) continue
    sql(`-- Día ${day}`)
    for (const l of LENDERS) {
      let minute = 7 * 60 + between(0, 25)
      const at = () => { minute += between(9, 32); return ts(day, Math.floor(minute / 60), minute % 60) }
      const u = m(`u:${l.k}`)
      // Créditos nuevos del día.
      for (const k of credits.filter((x) => x.c.lender === l && x.day === day)) {
        const r = k.weekly ? RATES.semanal : RATES.diario
        const count = k.weekly ? 8 : 24
        let items = []; let productsTotal = 0; let down = 0; let wh = null
        let principal = k.principal
        if (k.kind === 'producto') {
          const p = PRODUCT_FOR[l.site]
          const unit = p.promo ? Math.round(p.price * (1 - p.promo / 100)) : p.price
          productsTotal = unit; down = Math.round(unit * 0.1 / 1000) * 1000; principal = unit - down
          wh = l.site === 2 ? 2 : m(`wh:${l.site}`)
          items = [{ product_id: p.k ? `__${p.k}__` : `__sku:${p.sku}__`, product_name: p.name, quantity: 1, unit_price: unit, subtotal: unit, list_price: p.price, promotion_id: p.promo ? '__promo__' : null, promotion_name: p.promo ? 'Quincena del hogar' : null }]
        }
        const s = buildSchedule({ principal, method: r.method, rate: r.rate, rateBasis: r.basis, frequency: r.freq, count, disbursementDate: day, firstDueDate: addDays(day, k.weekly ? 7 : 1), skipSundays: !k.weekly })
        k.s = s
        const payload = {
          org_id: 1, customer_id: '__cust__', lender_id: '__lender__', kind: k.kind, products_total: productsTotal, discount_id: null, discount_name: null, discount_amount: 0, down_payment: down,
          principal: s.principal, interest_rate_id: r.id, interest_name: r.name, interest_method: s.method, rate: s.rate, rate_basis: s.rateBasis, frequency: s.frequency, interval_days: s.intervalDays,
          installments_count: s.count, skip_sundays: !k.weekly, disbursement_date: day, first_due_date: s.firstDueDate, last_due_date: s.lastDueDate, total_interest: s.totalInterest, total_amount: s.totalAmount,
          installment_amount: s.installmentAmount, disbursed_amount: k.kind === 'producto' ? 0 : s.disbursedAmount, notes: null, created_by: '__lender__',
          references: [{ name: `${pick(FIRST)} ${pick(LAST)}`, phone: `31${between(10000000, 99999999)}`, relationship: pick(['Hermana', 'Vecino', 'Esposo', 'Amiga']), address: null }],
          items, warehouse_id: wh ? '__wh__' : null,
          installments: s.installments.map((x) => ({ number: x.number, due_date: x.dueDate, capital: x.capital, interest: x.interest, amount: x.amount }))
        }
        let pj = `jsonb_set(jsonb_set(jsonb_set(${j(payload)}, '{customer_id}', to_jsonb(${m(`c:${k.c.k}`)})), '{lender_id}', to_jsonb(${u})), '{created_by}', to_jsonb(${u}))`
        if (wh) pj = `jsonb_set(${pj}, '{warehouse_id}', to_jsonb(${wh}))`
        if (items.length) {
          const p = PRODUCT_FOR[l.site]
          const pid = p.k ? m(p.k) : `(select id from products where org_id = 1 and sku = '${p.sku}')`
          pj = `jsonb_set(${pj}, '{items,0,product_id}', to_jsonb(${pid}))`
          if (p.promo) pj = `jsonb_set(${pj}, '{items,0,promotion_id}', to_jsonb((select id from promotions where org_id = 1 and name = 'Quincena del hogar')))`
        }
        const when = at()
        keep(`cr:${k.k}`, `select public.create_credit(${pj})`)
        sql(`update credits set created_at = ${when} where id = ${m(`cr:${k.k}`)};`)
        sql(`update fund_movements set created_at = ${when} where credit_id = ${m(`cr:${k.k}`)};`)
        sql(`update inventory_movements set created_at = ${when} where credit_id = ${m(`cr:${k.k}`)};`)
        audit(u, 'crear', 'credito', m(`cr:${k.k}`), { kind: k.kind, principal: s.principal, customer: '' }, when)
        k.paidThrough = 0; k.balance = s.totalAmount
      }
      // Cobros del día (hoy solo la primera mitad de la ruta).
      const route = credits.filter((x) => x.c.lender === l && x.s && x.day < day && x.balance > 0)
      let collected = 0
      route.forEach((k, idx) => {
        if (day === TODAY && idx % 2) return
        const due = k.s.installments.filter((x) => x.dueDate <= day)
        const owed = due.reduce((t, x) => t + x.amount, 0) - (k.s.totalAmount - k.balance)
        if (owed <= 0) return
        const prof = k.c.profile
        if (prof === 'muy_atrasado' && rnd() < 0.75) return
        if (prof === 'atrasado' && rnd() < 0.35) return
        if (prof === 'puntual' && rnd() < 0.06) return
        let amount = prof === 'adelantado' && rnd() < 0.5 ? k.s.installmentAmount * 2 : Math.min(owed, k.s.installmentAmount * (prof === 'atrasado' && rnd() < 0.3 ? 2 : 1))
        if (prof === 'atrasado' && rnd() < 0.25) amount = Math.round(k.s.installmentAmount / 2 / 100) * 100
        amount = Math.min(amount, k.balance)
        if (amount <= 0) return
        const late = l.k === 'jorge' && day === prevWorkday(1) && idx === route.length - 1
        const when = late ? ts(day, 4, 50) : at()
        const transfer = rnd() < 0.12
        const noGps = !transfer && rnd() < 0.08
        const lat = noGps ? null : (k.c.lat + (rnd() - 0.5) * 0.0008).toFixed(6)
        const lng = noGps ? null : (k.c.lng + (rnd() - 0.5) * 0.0008).toFixed(6)
        const pk = `pay${++key}`
        keep(pk, `select public.register_payment(jsonb_build_object('org_id', 1, 'credit_id', ${m(`cr:${k.k}`)}, 'kind', 'cuota', 'amount', ${amount}, 'method', '${transfer ? 'transferencia' : 'efectivo'}', 'reference', ${transfer ? q(`Nequi ${between(100000, 999999)}`) : 'null'}, 'paid_on', '${day}', 'lat', ${lat ?? 'null'}, 'lng', ${lng ?? 'null'}, 'user_id', ${u}))`)
        sql(`update payments set created_at = ${when} where id = ${m(pk)}; update fund_movements set created_at = ${when} where payment_id = ${m(pk)};`)
        audit(u, 'registrar_pago', 'credito', m(`cr:${k.k}`), { payment: `__${pk}__`, amount }, when)
        sql(`update audit_log set detail = jsonb_build_object('payment', ${m(pk)}, 'amount', ${amount}) where id = (select max(id) from audit_log);`)
        k.balance -= amount
        if (!transfer) collected += amount
        // Un pago anulado por el administrador (mal digitado).
        if (l.k === 'diana' && day === prevWorkday(3) && !lenderDayOps.voided) {
          lenderDayOps.voided = true
          sql(`select public.void_payment(1, ${m(pk)}, 'Valor mal digitado, el cliente pagó otra cantidad', ${m('admin')});`)
          sql(`update fund_movements set created_at = ${ts(day, 17, 5)} where payment_id = ${m(pk)} and created_at > now() - interval '1 minute';`)
          audit(m('admin'), 'anular', 'pago', m(pk), { reason: 'Valor mal digitado' }, ts(day, 17, 5))
          k.balance += amount; collected -= transfer ? 0 : amount
        }
      })
      // Gastos del día.
      const expenses = []
      if (rnd() < 0.55) expenses.push(['alimentacion', pick([12000, 15000, 18000]), 'Almuerzo en ruta'])
      if (rnd() < 0.3) expenses.push(['combustible', pick([20000, 25000, 30000]), 'Tanqueo de la moto'])
      if (l.k === 'diana' && day === prevWorkday(4)) expenses.push(['mantenimiento', 180000, 'Cambio de llanta trasera y neumático'])
      if (rnd() < 0.08) expenses.push(['comunicaciones', 20000, 'Recarga de datos'])
      for (const [cat, amount, note] of expenses) {
        const when = at()
        const ek = `exp${++key}`
        keep(ek, `select public.register_expense(jsonb_build_object('org_id', 1, 'lender_id', ${u}, 'category', '${cat}', 'amount', ${amount}, 'spent_on', '${day}', 'note', ${q(note)}, 'user_id', ${u}))`)
        sql(`update expenses set created_at = ${when} where id = ${m(ek)}; update fund_movements set created_at = ${when} where expense_id = ${m(ek)};`)
        audit(u, 'crear', 'gasto', m(ek), { amount }, when)
      }
      // Cierre de jornada (no se cierra hoy). Un día con faltante para ver la alerta.
      if (day < TODAY) {
        const when = ts(day, 18, between(0, 50))
        const short = l.k === 'carlos' && day === prevWorkday(1) ? 20000 : l.k === 'laura' && day === prevWorkday(6) ? 5000 : 0
        const ck = `cl${++key}`
        keep(ck, `select public.close_day(jsonb_build_object('org_id', 1, 'lender_id', ${u}, 'day', '${day}', 'counted_cash', (select balance from fund_accounts where org_id = 1 and kind = 'prestamista' and user_id = ${u}) - ${short}, 'deliver', greatest((select balance from fund_accounts where org_id = 1 and kind = 'prestamista' and user_id = ${u}) - ${short} - 4000000, 0), 'note', ${short ? q('Faltó plata en el conteo') : 'null'}, 'user_id', ${m('admin')}))`)
        sql(`update route_closures set created_at = ${when} where id = ${m(ck)}; update fund_movements set created_at = ${when} where ref = (select delivery_ref from route_closures where id = ${m(ck)});`)
        sql(`insert into audit_log (org_id, user_id, action, entity, entity_id, detail, created_at) select 1, ${m('admin')}, 'cerrar_jornada', 'prestamista', (${u})::text, jsonb_build_object('day', '${day}', 'counted', counted_cash, 'deliver', delivered), ${when} from route_closures where id = ${m(ck)};`)
      }
      // Inicio de sesión del día.
      sql(`insert into audit_log (org_id, user_id, action, entity, entity_id, ip, created_at) values (1, ${u}, 'login', 'usuario', (${u})::text, '190.${between(60, 90)}.${between(1, 250)}.${between(1, 250)}', ${ts(day, 6, between(30, 59))});`)
      void collected; void lenderOf
    }
  }
  // Un traslado de caja pendiente (Jorge envía plata a la oficina).
  sql('-- Traslado de caja pendiente y solicitud de crédito')
  keep('tr1', `select public.request_cash_transfer(jsonb_build_object('org_id', 1, 'from_lender_id', ${m('u:jorge')}, 'amount', 350000, 'note', 'Envío lo recaudado a la oficina', 'user_id', ${m('u:jorge')}))`)
  audit(m('u:jorge'), 'crear', 'traslado_caja', m('tr1'), { amount: 350000 }, ts(TODAY, 11, 20))
  sql(`update users set last_login_at = ${ts(TODAY, 6, 45)} where id in (${LENDERS.map((l) => m(`u:${l.k}`)).join(', ')});`)
  sql('commit;')
  const site = (l) => (l.site === 2 ? 'Sede Norte' : SITES.find((x) => x.k === l.site).name)
  const lines = [
    ...LENDERS.map((l) => `--   ${l.username.padEnd(18)} ${l.id.padEnd(12)} prestamista (${site(l)})`),
    ...DRIVERS.filter((d) => d.user).map((d) => `--   ${d.username.padEnd(18)} ${d.id.padEnd(12)} conductor`),
    ...clientUsers.map((c) => `--   ${c.username.padEnd(18)} ${c.ident.padEnd(12)} cliente de ${c.lender.name}`)
  ]
  console.log(['-- Usuarios creados (usuario · contraseña = documento · rol):', ...lines, ''].join('\n') + out.join('\n'))
}

build().catch((e) => { console.error(e); process.exit(1) })
