const express = require('express')
const supabase = require('../db')
const { h, fail, clean, num, imageError } = require('../http')
const { auth, ADMIN, STAFF } = require('../auth')
const { audit } = require('../audit')
const { currentOrg } = require('../tenant')

const router = express.Router()

// =====================================================================
// Inventario por sedes y bodegas (modelo de integra-ips):
// · Cada negocio tiene una bodega principal y puede tener varias bodegas por sede.
// · Las existencias se llevan por bodega (warehouse_stock); products.stock es el total.
// · Las entradas, ajustes y bajas se hacen en una bodega; los traslados mueven entre bodegas.
// · El crédito de producto entrega desde una bodega y la anulación devuelve a esa bodega.
// =====================================================================
const p0001 = (res, error) => (error.code === 'P0001' ? fail(res, error.message, 400) : fail(res, error))
const generalWarehouse = async () => {
  const { data, error } = await supabase.from('warehouses').select('id, name, site_id').eq('is_general', true).maybeSingle()
  if (error) throw error
  return data
}
// Bodegas a consultar según ?bodega= o ?sede= (null = todas).
const warehouseFilter = async (req) => {
  if (Number(req.query.bodega)) return [Number(req.query.bodega)]
  if (Number(req.query.sede)) {
    const { data } = await supabase.from('warehouses').select('id').eq('site_id', Number(req.query.sede))
    return (data || []).map((w) => w.id)
  }
  return null
}

// ---------- Sedes ----------
const siteDTO = (s) => ({ id: s.id, name: s.name, city: s.city, address: s.address, phone: s.phone, active: s.active })
router.get('/sedes', auth(STAFF), h(async (req, res) => {
  let q = supabase.from('sites').select('*').order('id')
  if (req.query.activas === '1') q = q.eq('active', true)
  const { data, error } = await q
  if (error) throw error
  res.send(data.map(siteDTO))
}))
const siteRow = (b) => ({ name: clean(b.name), city: clean(b.city), address: clean(b.address), phone: clean(b.phone), active: b.active !== false })
router.post('/sedes', auth(ADMIN), h(async (req, res) => {
  const b = req.body || {}
  if (!clean(b.name)) return fail(res, 'El nombre de la sede es requerido', 400)
  const { data, error } = await supabase.from('sites').insert(siteRow(b)).select('*').single()
  if (error) return error.code === '23505' ? fail(res, 'Ya existe una sede con ese nombre', 409) : fail(res, error)
  // Cada sede nueva arranca con su propia bodega.
  if (b.createWarehouse !== false) await supabase.from('warehouses').insert({ site_id: data.id, name: `Bodega ${data.name}` })
  await audit(req, 'crear', 'sede', data.id)
  res.status(201).send(siteDTO(data))
}))
router.put('/sedes/:id', auth(ADMIN), h(async (req, res) => {
  const b = req.body || {}
  const id = Number(req.params.id)
  if (!clean(b.name)) return fail(res, 'El nombre de la sede es requerido', 400)
  if (b.active === false) {
    const { data: gen } = await supabase.from('warehouses').select('id').eq('site_id', id).eq('is_general', true).maybeSingle()
    if (gen) return fail(res, 'La sede de la bodega principal no se puede desactivar', 400)
  }
  const { data, error } = await supabase.from('sites').update(siteRow(b)).eq('id', id).select('*').maybeSingle()
  if (error) return error.code === '23505' ? fail(res, 'Ya existe una sede con ese nombre', 409) : fail(res, error)
  if (!data) return fail(res, 'Sede no encontrada', 404)
  await audit(req, 'editar', 'sede', id)
  res.send(siteDTO(data))
}))

// ---------- Bodegas ----------
const WH_COLUMNS = 'id, name, description, responsible, location, is_general, active, site_id, site:sites(id, name, city)'
const warehouseDTO = (w) => ({
  id: w.id, name: w.name, description: w.description, responsible: w.responsible, location: w.location,
  isGeneral: w.is_general, active: w.active, siteId: w.site_id, siteName: w.site?.name ?? null, city: w.site?.city ?? null
})
router.get('/inventario/bodegas', auth(STAFF), h(async (req, res) => {
  let q = supabase.from('warehouses').select(WH_COLUMNS).order('is_general', { ascending: false }).order('name')
  if (Number(req.query.sede)) q = q.eq('site_id', Number(req.query.sede))
  if (req.query.activas === '1') q = q.eq('active', true)
  const [{ data, error }, { data: stock }] = await Promise.all([
    q, supabase.from('warehouse_stock').select('warehouse_id, stock, product:products(cost, price, min_stock)').gt('stock', 0)
  ])
  if (error) throw error
  res.send(data.map((w) => {
    const ls = (stock || []).filter((s) => s.warehouse_id === w.id)
    return {
      ...warehouseDTO(w),
      products: ls.length,
      units: ls.reduce((a, s) => a + s.stock, 0),
      costValue: ls.reduce((a, s) => a + s.stock * Number(s.product?.cost || 0), 0),
      saleValue: ls.reduce((a, s) => a + s.stock * Number(s.product?.price || 0), 0)
    }
  }))
}))
const validateWarehouse = async (b) => {
  const errors = []
  if (!clean(b.name)) errors.push('El nombre de la bodega es requerido')
  const { data: site } = await supabase.from('sites').select('id, active').eq('id', Number(b.siteId)).maybeSingle()
  if (!site) errors.push('Selecciona la sede de la bodega')
  else if (!site.active) errors.push('La sede está inactiva')
  return errors
}
const warehouseRow = (b) => ({ name: clean(b.name), site_id: Number(b.siteId), description: clean(b.description), responsible: clean(b.responsible), location: clean(b.location), active: b.active !== false })
router.post('/inventario/bodegas', auth(ADMIN), h(async (req, res) => {
  const b = req.body || {}
  const errors = await validateWarehouse(b)
  if (errors.length) return fail(res, errors.join('. '), 400)
  const { data, error } = await supabase.from('warehouses').insert({ ...warehouseRow(b), is_general: false }).select(WH_COLUMNS).single()
  if (error) return error.code === '23505' ? fail(res, 'Ya existe una bodega con ese nombre', 409) : fail(res, error)
  await audit(req, 'crear', 'bodega', data.id)
  res.status(201).send(warehouseDTO(data))
}))
router.put('/inventario/bodegas/:id', auth(ADMIN), h(async (req, res) => {
  const b = req.body || {}
  const id = Number(req.params.id)
  const { data: cur } = await supabase.from('warehouses').select('id, is_general, site_id').eq('id', id).maybeSingle()
  if (!cur) return fail(res, 'Bodega no encontrada', 404)
  const errors = await validateWarehouse(b)
  if (cur.is_general && b.active === false) errors.push('La bodega principal no se puede desactivar')
  const moving = Number(b.siteId) !== cur.site_id
  if (b.active === false || moving) {
    const { count } = await supabase.from('warehouse_stock').select('product_id', { count: 'exact', head: true }).eq('warehouse_id', id).gt('stock', 0)
    if (count) errors.push(b.active === false ? 'La bodega tiene existencias; trasládalas antes de desactivarla' : 'Solo se puede cambiar de sede una bodega sin existencias')
  }
  if (errors.length) return fail(res, errors.join('. '), 400)
  const { data, error } = await supabase.from('warehouses').update(warehouseRow(b)).eq('id', id).select(WH_COLUMNS).single()
  if (error) return error.code === '23505' ? fail(res, 'Ya existe una bodega con ese nombre', 409) : fail(res, error)
  await audit(req, 'editar', 'bodega', id)
  res.send(warehouseDTO(data))
}))

// ---------- Categorías ----------
const categoryDTO = (c) => ({ id: c.id, name: c.name, description: c.description, active: c.active, products: c.products?.[0]?.count ?? undefined })
router.get('/inventario/categorias', auth(STAFF), h(async (req, res) => {
  const { data, error } = await supabase.from('product_categories').select('id, name, description, active, products(count)').order('name')
  if (error) throw error
  res.send(data.map(categoryDTO))
}))
router.post('/inventario/categorias', auth(ADMIN), h(async (req, res) => {
  const name = clean(req.body?.name)
  if (!name) return fail(res, 'El nombre es requerido', 400)
  const { data, error } = await supabase.from('product_categories').insert({ name, description: clean(req.body?.description) }).select('id, name, description, active').single()
  if (error) return error.code === '23505' ? fail(res, 'Esa categoría ya existe', 409) : fail(res, error)
  res.status(201).send(categoryDTO(data))
}))
router.put('/inventario/categorias/:id', auth(ADMIN), h(async (req, res) => {
  const name = clean(req.body?.name)
  if (!name) return fail(res, 'El nombre es requerido', 400)
  const { data, error } = await supabase.from('product_categories').update({ name, description: clean(req.body?.description), active: req.body?.active !== false }).eq('id', Number(req.params.id)).select('id, name, description, active').maybeSingle()
  if (error) return error.code === '23505' ? fail(res, 'Esa categoría ya existe', 409) : fail(res, error)
  if (!data) return fail(res, 'Categoría no encontrada', 404)
  res.send(categoryDTO(data))
}))

// ---------- Productos ----------
const PRODUCT_COLUMNS = 'id, sku, name, category_id, brand, description, cost, price, stock, min_stock, photo_url, active, category:product_categories(id, name)'
const productDTO = (p) => ({
  id: p.id, sku: p.sku, name: p.name, categoryId: p.category_id, category: p.category?.name ?? null, brand: p.brand, description: p.description,
  cost: Number(p.cost), price: Number(p.price), stock: p.stock, minStock: p.min_stock, lowStock: p.stock <= p.min_stock, photoUrl: p.photo_url, active: p.active
})
const validateProduct = async (b) => {
  const errors = []
  if (!clean(b.name)) errors.push('El nombre es requerido')
  if (!Number(b.categoryId)) errors.push('Selecciona la categoría del producto')
  else {
    const { data: c } = await supabase.from('product_categories').select('id, active').eq('id', Number(b.categoryId)).maybeSingle()
    if (!c || !c.active) errors.push('La categoría no existe o está inactiva')
  }
  if (!(Number(b.price) >= 0)) errors.push('Precio de venta inválido')
  if (b.cost !== undefined && b.cost !== '' && !(Number(b.cost) >= 0)) errors.push('Costo inválido')
  if (b.minStock !== undefined && b.minStock !== '' && !(Number.isInteger(Number(b.minStock)) && Number(b.minStock) >= 0)) errors.push('Stock mínimo inválido')
  const e = imageError(b.photoUrl, 600); if (e) errors.push(`Foto: ${e}`)
  return errors
}
const productRow = (b) => ({
  sku: clean(b.sku), name: clean(b.name), category_id: num(b.categoryId), brand: clean(b.brand), description: clean(b.description),
  cost: Number(b.cost) || 0, price: Number(b.price) || 0, min_stock: Number(b.minStock) || 0, photo_url: clean(b.photoUrl), active: b.active !== false
})

// Con ?bodega= o ?sede=, stock es lo que hay en esas bodegas (y byWarehouse el detalle).
router.get('/inventario/productos', auth(STAFF), h(async (req, res) => {
  let q = supabase.from('products').select(PRODUCT_COLUMNS).order('name')
  if (req.query.activos === '1') q = q.eq('active', true)
  if (Number(req.query.categoria)) q = q.eq('category_id', Number(req.query.categoria))
  const whs = await warehouseFilter(req)
  let sq = supabase.from('warehouse_stock').select('product_id, warehouse_id, stock, warehouse:warehouses(name)').gt('stock', 0)
  if (whs) sq = sq.in('warehouse_id', whs.length ? whs : [0])
  const [{ data, error }, { data: stock, error: e2 }] = await Promise.all([q, sq])
  if (error) throw error
  if (e2) throw e2
  let rows = data.map((p) => {
    const ls = stock.filter((s) => s.product_id === p.id)
    const dto = productDTO(p)
    if (whs) { dto.stock = ls.reduce((a, s) => a + s.stock, 0); dto.lowStock = dto.stock <= dto.minStock }
    dto.byWarehouse = ls.map((s) => ({ warehouseId: s.warehouse_id, name: s.warehouse?.name, stock: s.stock }))
    return dto
  })
  if (req.query.disponibles === '1') rows = rows.filter((p) => p.stock > 0)
  res.send(rows)
}))

router.post('/inventario/productos', auth(ADMIN), h(async (req, res) => {
  const b = req.body || {}
  const errors = await validateProduct(b)
  const initial = Number(b.initialStock) || 0
  if (!(Number.isInteger(initial) && initial >= 0)) errors.push('Stock inicial inválido')
  if (errors.length) return fail(res, errors.join('. '), 400)
  const { data, error } = await supabase.from('products').insert(productRow(b)).select('id').single()
  if (error) return error.code === '23505' ? fail(res, 'Ya existe un producto con ese código (SKU)', 409) : fail(res, error)
  if (initial > 0) {
    const warehouseId = Number(b.warehouseId) || (await generalWarehouse()).id
    const { error: e2 } = await supabase.from('inventory_movements').insert({ warehouse_id: warehouseId, product_id: data.id, type: 'entrada', quantity: initial, unit_cost: Number(b.cost) || 0, note: 'Stock inicial', user_id: req.user.id })
    if (e2) return p0001(res, e2)
  }
  await audit(req, 'crear', 'producto', data.id)
  const { data: p } = await supabase.from('products').select(PRODUCT_COLUMNS).eq('id', data.id).single()
  res.status(201).send(productDTO(p))
}))

router.put('/inventario/productos/:id', auth(ADMIN), h(async (req, res) => {
  const errors = await validateProduct(req.body || {})
  if (errors.length) return fail(res, errors.join('. '), 400)
  const { data, error } = await supabase.from('products').update(productRow(req.body)).eq('id', Number(req.params.id)).select(PRODUCT_COLUMNS).maybeSingle()
  if (error) return error.code === '23505' ? fail(res, 'Ya existe un producto con ese código (SKU)', 409) : fail(res, error)
  if (!data) return fail(res, 'Producto no encontrado', 404)
  await audit(req, 'editar', 'producto', data.id)
  res.send(productDTO(data))
}))

// ---------- Existencias por bodega ----------
router.get('/inventario/existencias', auth(STAFF), h(async (req, res) => {
  const whs = await warehouseFilter(req)
  let q = supabase.from('warehouse_stock')
    .select('stock, warehouse_id, product_id, warehouse:warehouses(id, name, is_general, site:sites(name)), product:products(id, sku, name, brand, price, cost, min_stock, active, category_id, category:product_categories(name))')
  if (whs) q = q.in('warehouse_id', whs.length ? whs : [0])
  if (req.query.todos !== '1') q = q.gt('stock', 0)
  const { data, error } = await q
  if (error) throw error
  const term = clean(req.query.q)?.toLowerCase()
  const cat = Number(req.query.categoria)
  res.send(data
    .filter((r) => r.product && (!cat || r.product.category_id === cat))
    .filter((r) => !term || [r.product.name, r.product.sku, r.product.brand].some((x) => x && x.toLowerCase().includes(term)))
    .map((r) => ({
      warehouseId: r.warehouse_id, warehouse: r.warehouse?.name, isGeneral: r.warehouse?.is_general, site: r.warehouse?.site?.name,
      productId: r.product_id, sku: r.product.sku, name: r.product.name, brand: r.product.brand, category: r.product.category?.name,
      stock: r.stock, minStock: r.product.min_stock, low: r.stock <= r.product.min_stock,
      price: Number(r.product.price), saleValue: r.stock * Number(r.product.price), costValue: r.stock * Number(r.product.cost)
    }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.warehouse.localeCompare(b.warehouse)))
}))

// ---------- Movimientos ----------
const MOVE_LABELS = {
  entrada: 'Entrada', salida_credito: 'Entrega en crédito', devolucion: 'Devolución', ajuste: 'Ajuste', baja: 'Baja',
  traslado_salida: 'Traslado enviado', traslado_entrada: 'Traslado recibido'
}
router.get('/inventario/movimientos', auth(STAFF), h(async (req, res) => {
  let q = supabase.from('inventory_movements')
    .select('id, type, quantity, unit_cost, note, ref, created_at, credit_id, warehouse_id, warehouse:warehouses(id, name), product:products(id, name, sku), user:users(name, last_name), credit:credits(number)')
    .order('created_at', { ascending: false }).order('id', { ascending: false }).limit(Math.min(Number(req.query.limit) || 200, 500))
  if (Number(req.query.producto)) q = q.eq('product_id', Number(req.query.producto))
  if (req.query.tipo && MOVE_LABELS[req.query.tipo]) q = q.eq('type', req.query.tipo)
  const whs = await warehouseFilter(req)
  if (whs) q = q.in('warehouse_id', whs.length ? whs : [0])
  const { data, error } = await q
  if (error) throw error
  res.send(data.map((m) => ({
    id: m.id, type: m.type, typeLabel: MOVE_LABELS[m.type], quantity: m.quantity, unitCost: m.unit_cost === null ? null : Number(m.unit_cost), note: m.note, ref: m.ref, createdAt: m.created_at,
    warehouse: m.warehouse ? { id: m.warehouse.id, name: m.warehouse.name } : null,
    product: m.product, creditId: m.credit_id, creditNumber: m.credit?.number ?? null, user: m.user ? `${m.user.name} ${m.user.last_name || ''}`.trim() : null
  })))
}))

// Entrada (compra), ajuste (+/-) o baja (daño, pérdida) en una bodega. Las salidas por crédito las hace el crédito.
router.post('/inventario/movimientos', auth(ADMIN), h(async (req, res) => {
  const b = req.body || {}
  const qty = Number(b.quantity)
  if (!['entrada', 'ajuste', 'baja'].includes(b.type)) return fail(res, 'Tipo de movimiento inválido', 400)
  if (!Number.isInteger(qty) || qty === 0) return fail(res, 'La cantidad debe ser un número entero distinto de cero', 400)
  if (b.type !== 'ajuste' && qty < 0) return fail(res, 'La cantidad debe ser positiva', 400)
  if ((b.type === 'ajuste' || b.type === 'baja') && !clean(b.note)) return fail(res, 'Escribe el motivo del ajuste o la baja', 400)
  const warehouseId = Number(b.warehouseId) || (await generalWarehouse()).id
  const { data: wh } = await supabase.from('warehouses').select('id, active').eq('id', warehouseId).maybeSingle()
  if (!wh || !wh.active) return fail(res, 'Selecciona una bodega activa', 400)
  const quantity = b.type === 'baja' ? -qty : qty
  const note = [clean(b.supplier) && `Proveedor: ${clean(b.supplier)}`, clean(b.invoice) && `Factura: ${clean(b.invoice)}`, clean(b.note)].filter(Boolean).join(' · ') || null
  const { data, error } = await supabase.from('inventory_movements').insert({
    warehouse_id: warehouseId, product_id: Number(b.productId), type: b.type, quantity,
    unit_cost: b.type === 'entrada' && b.unitCost !== '' && b.unitCost !== undefined ? Number(b.unitCost) : null,
    note, user_id: req.user.id
  }).select('id').single()
  if (error) return p0001(res, error)
  await audit(req, 'crear', 'movimiento_inventario', data.id, { type: b.type, quantity, product: Number(b.productId), warehouse: warehouseId })
  const { data: p } = await supabase.from('products').select(PRODUCT_COLUMNS).eq('id', Number(b.productId)).single()
  res.status(201).send(productDTO(p))
}))

// ---------- Traslados entre bodegas ----------
router.post('/inventario/traslados', auth(ADMIN), h(async (req, res) => {
  const b = req.body || {}
  const from = Number(b.fromWarehouseId); const to = Number(b.toWarehouseId)
  if (!from || !to) return fail(res, 'Selecciona la bodega de origen y la de destino', 400)
  if (from === to) return fail(res, 'La bodega de origen y la de destino son la misma', 400)
  const items = (Array.isArray(b.items) ? b.items : []).map((i) => ({ product_id: Number(i.productId), quantity: Number(i.quantity) })).filter((i) => i.product_id)
  if (!items.length) return fail(res, 'Agrega al menos un producto al traslado', 400)
  if (new Set(items.map((i) => i.product_id)).size !== items.length) return fail(res, 'Hay productos repetidos en el traslado', 400)
  if (items.some((i) => !Number.isInteger(i.quantity) || i.quantity <= 0)) return fail(res, 'Las cantidades deben ser enteros mayores que cero', 400)
  const { data: ref, error } = await supabase.rpc('transfer_stock', { p: { org_id: currentOrg(), from_warehouse_id: from, to_warehouse_id: to, user_id: req.user.id, note: clean(b.note), items } })
  if (error) return p0001(res, error)
  await audit(req, 'crear', 'traslado', null, { ref, from, to, items: items.length })
  res.status(201).send({ ref, items: items.length })
}))

// Resumen: valor del inventario y productos con stock bajo (de todo el negocio, de una sede o de una bodega).
router.get('/inventario/resumen', auth(STAFF), h(async (req, res) => {
  const whs = await warehouseFilter(req)
  const [{ data: products, error }, { data: stock }, { data: cats }] = await Promise.all([
    supabase.from('products').select('id, stock, min_stock, cost, price, active, category:product_categories(name)').eq('active', true),
    (() => { let q = supabase.from('warehouse_stock').select('product_id, stock'); if (whs) q = q.in('warehouse_id', whs.length ? whs : [0]); return q })(),
    supabase.from('product_categories').select('id').eq('active', true)
  ])
  if (error) throw error
  const qty = (p) => (whs ? (stock || []).filter((s) => s.product_id === p.id).reduce((a, s) => a + s.stock, 0) : p.stock)
  const rows = products.map((p) => ({ ...p, qty: qty(p) }))
  const byCategory = {}
  for (const p of rows) { const k = p.category?.name || 'Sin categoría'; byCategory[k] = (byCategory[k] || 0) + p.qty * Number(p.price) }
  res.send({
    products: rows.filter((p) => p.qty > 0).length,
    units: rows.reduce((s, p) => s + p.qty, 0),
    costValue: rows.reduce((s, p) => s + p.qty * Number(p.cost), 0),
    saleValue: rows.reduce((s, p) => s + p.qty * Number(p.price), 0),
    lowStock: rows.filter((p) => p.qty <= p.min_stock).length,
    categories: cats?.length ?? 0,
    byCategory: Object.entries(byCategory).map(([name, value]) => ({ name, value })).filter((c) => c.value > 0).sort((a, b) => b.value - a.value)
  })
}))

// ---------- Descuentos ----------
const DISCOUNT_ICONS = ['tag', 'star', 'heart', 'gift', 'handshake', 'cake', 'trophy', 'fire', 'percent', 'user']
const discountDTO = (d) => ({ id: d.id, name: d.name, type: d.type, value: Number(d.value), icon: d.icon, color: d.color, description: d.description, active: d.active })
const discountRow = (b) => ({ name: clean(b.name), type: b.type, value: Number(b.value), icon: DISCOUNT_ICONS.includes(b.icon) ? b.icon : 'tag', color: /^#[0-9A-Fa-f]{6}$/.test(b.color || '') ? b.color : '#10B981', description: clean(b.description), active: b.active !== false })
const validateDiscount = (b) => {
  const errors = []
  if (!clean(b.name)) errors.push('El nombre es requerido')
  if (!['porcentaje', 'valor'].includes(b.type)) errors.push('Tipo inválido')
  if (!(Number(b.value) >= 0)) errors.push('Valor inválido')
  if (b.type === 'porcentaje' && Number(b.value) > 100) errors.push('El porcentaje no puede superar 100')
  return errors
}
router.get('/descuentos', auth(STAFF), h(async (req, res) => {
  let q = supabase.from('discounts').select('*').order('name')
  if (req.query.activos === '1') q = q.eq('active', true)
  const { data, error } = await q
  if (error) throw error
  res.send(data.map(discountDTO))
}))
router.post('/descuentos', auth(ADMIN), h(async (req, res) => {
  const errors = validateDiscount(req.body || {})
  if (errors.length) return fail(res, errors.join('. '), 400)
  const b = req.body
  const { data, error } = await supabase.from('discounts').insert(discountRow(b)).select().single()
  if (error) return error.code === '23505' ? fail(res, 'Ya existe un descuento con ese nombre', 409) : fail(res, error)
  await audit(req, 'crear', 'descuento', data.id)
  res.status(201).send(discountDTO(data))
}))
router.put('/descuentos/:id', auth(ADMIN), h(async (req, res) => {
  const errors = validateDiscount(req.body || {})
  if (errors.length) return fail(res, errors.join('. '), 400)
  const b = req.body
  const { data, error } = await supabase.from('discounts').update(discountRow(b)).eq('id', Number(req.params.id)).select().maybeSingle()
  if (error) return error.code === '23505' ? fail(res, 'Ya existe un descuento con ese nombre', 409) : fail(res, error)
  if (!data) return fail(res, 'Descuento no encontrado', 404)
  await audit(req, 'editar', 'descuento', data.id)
  res.send(discountDTO(data))
}))

module.exports = router
