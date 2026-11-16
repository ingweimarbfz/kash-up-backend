const express = require('express')
const supabase = require('../db')
const { h, fail, clean, num, imageError } = require('../http')
const { auth, ADMIN, STAFF } = require('../auth')
const { audit } = require('../audit')

const router = express.Router()

// ---------- Categorías ----------
router.get('/inventario/categorias', auth(STAFF), h(async (req, res) => {
  const { data, error } = await supabase.from('product_categories').select('id, name, active').order('name')
  if (error) throw error
  res.send(data)
}))
router.post('/inventario/categorias', auth(ADMIN), h(async (req, res) => {
  const name = clean(req.body?.name)
  if (!name) return fail(res, 'El nombre es requerido', 400)
  const { data, error } = await supabase.from('product_categories').insert({ name }).select('id, name, active').single()
  if (error) return error.code === '23505' ? fail(res, 'Esa categoría ya existe', 409) : fail(res, error)
  res.status(201).send(data)
}))
router.put('/inventario/categorias/:id', auth(ADMIN), h(async (req, res) => {
  const name = clean(req.body?.name)
  if (!name) return fail(res, 'El nombre es requerido', 400)
  const { data, error } = await supabase.from('product_categories').update({ name, active: req.body?.active !== false }).eq('id', Number(req.params.id)).select('id, name, active').maybeSingle()
  if (error) return error.code === '23505' ? fail(res, 'Esa categoría ya existe', 409) : fail(res, error)
  if (!data) return fail(res, 'Categoría no encontrada', 404)
  res.send(data)
}))

// ---------- Productos ----------
const PRODUCT_COLUMNS = 'id, sku, name, category_id, brand, description, cost, price, stock, min_stock, photo_url, active, category:product_categories(id, name)'
const productDTO = (p) => ({
  id: p.id, sku: p.sku, name: p.name, categoryId: p.category_id, category: p.category?.name ?? null, brand: p.brand, description: p.description,
  cost: Number(p.cost), price: Number(p.price), stock: p.stock, minStock: p.min_stock, lowStock: p.stock <= p.min_stock, photoUrl: p.photo_url, active: p.active
})
const validateProduct = (b) => {
  const errors = []
  if (!clean(b.name)) errors.push('El nombre es requerido')
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

router.get('/inventario/productos', auth(STAFF), h(async (req, res) => {
  let q = supabase.from('products').select(PRODUCT_COLUMNS).order('name')
  if (req.query.activos === '1') q = q.eq('active', true)
  if (req.query.disponibles === '1') q = q.gt('stock', 0)
  if (Number(req.query.categoria)) q = q.eq('category_id', Number(req.query.categoria))
  const { data, error } = await q
  if (error) throw error
  res.send(data.map(productDTO))
}))

router.post('/inventario/productos', auth(ADMIN), h(async (req, res) => {
  const b = req.body || {}
  const errors = validateProduct(b)
  const initial = Number(b.initialStock) || 0
  if (!(Number.isInteger(initial) && initial >= 0)) errors.push('Stock inicial inválido')
  if (errors.length) return fail(res, errors.join('. '), 400)
  const { data, error } = await supabase.from('products').insert(productRow(b)).select('id').single()
  if (error) return error.code === '23505' ? fail(res, 'Ya existe un producto con ese código (SKU)', 409) : fail(res, error)
  if (initial > 0) {
    const { error: e2 } = await supabase.from('inventory_movements').insert({ product_id: data.id, type: 'entrada', quantity: initial, unit_cost: Number(b.cost) || 0, note: 'Stock inicial', user_id: req.user.id })
    if (e2) throw e2
  }
  await audit(req, 'crear', 'producto', data.id)
  const { data: p } = await supabase.from('products').select(PRODUCT_COLUMNS).eq('id', data.id).single()
  res.status(201).send(productDTO(p))
}))

router.put('/inventario/productos/:id', auth(ADMIN), h(async (req, res) => {
  const errors = validateProduct(req.body || {})
  if (errors.length) return fail(res, errors.join('. '), 400)
  const { data, error } = await supabase.from('products').update(productRow(req.body)).eq('id', Number(req.params.id)).select(PRODUCT_COLUMNS).maybeSingle()
  if (error) return error.code === '23505' ? fail(res, 'Ya existe un producto con ese código (SKU)', 409) : fail(res, error)
  if (!data) return fail(res, 'Producto no encontrado', 404)
  await audit(req, 'editar', 'producto', data.id)
  res.send(productDTO(data))
}))

// ---------- Movimientos ----------
const MOVE_LABELS = { entrada: 'Entrada', salida_credito: 'Entrega en crédito', devolucion: 'Devolución', ajuste: 'Ajuste', baja: 'Baja' }
router.get('/inventario/movimientos', auth(STAFF), h(async (req, res) => {
  let q = supabase.from('inventory_movements')
    .select('id, type, quantity, unit_cost, note, created_at, credit_id, product:products(id, name, sku), user:users(name, last_name), credit:credits(number)')
    .order('created_at', { ascending: false }).limit(Math.min(Number(req.query.limit) || 200, 500))
  if (Number(req.query.producto)) q = q.eq('product_id', Number(req.query.producto))
  const { data, error } = await q
  if (error) throw error
  res.send(data.map((m) => ({
    id: m.id, type: m.type, typeLabel: MOVE_LABELS[m.type], quantity: m.quantity, unitCost: m.unit_cost === null ? null : Number(m.unit_cost), note: m.note, createdAt: m.created_at,
    product: m.product, creditId: m.credit_id, creditNumber: m.credit?.number ?? null, user: m.user ? `${m.user.name} ${m.user.last_name || ''}`.trim() : null
  })))
}))

// Entrada (compra), ajuste (+/-) o baja (daño, pérdida). Las salidas por crédito las hace el crédito.
router.post('/inventario/movimientos', auth(ADMIN), h(async (req, res) => {
  const b = req.body || {}
  const qty = Number(b.quantity)
  if (!['entrada', 'ajuste', 'baja'].includes(b.type)) return fail(res, 'Tipo de movimiento inválido', 400)
  if (!Number.isInteger(qty) || qty === 0) return fail(res, 'La cantidad debe ser un número entero distinto de cero', 400)
  if (b.type !== 'ajuste' && qty < 0) return fail(res, 'La cantidad debe ser positiva', 400)
  if ((b.type === 'ajuste' || b.type === 'baja') && !clean(b.note)) return fail(res, 'Escribe el motivo del ajuste o la baja', 400)
  const quantity = b.type === 'baja' ? -qty : qty
  const { data, error } = await supabase.from('inventory_movements').insert({
    product_id: Number(b.productId), type: b.type, quantity, unit_cost: b.type === 'entrada' && b.unitCost !== '' && b.unitCost !== undefined ? Number(b.unitCost) : null,
    note: clean(b.note), user_id: req.user.id
  }).select('id').single()
  if (error) return error.code === 'P0001' ? fail(res, error.message, 400) : fail(res, error)
  await audit(req, 'crear', 'movimiento_inventario', data.id, { type: b.type, quantity, product: Number(b.productId) })
  const { data: p } = await supabase.from('products').select(PRODUCT_COLUMNS).eq('id', Number(b.productId)).single()
  res.status(201).send(productDTO(p))
}))

// Resumen: valor del inventario y productos con stock bajo.
router.get('/inventario/resumen', auth(STAFF), h(async (req, res) => {
  const { data, error } = await supabase.from('products').select('stock, min_stock, cost, price, active').eq('active', true)
  if (error) throw error
  res.send({
    products: data.length,
    units: data.reduce((s, p) => s + p.stock, 0),
    costValue: data.reduce((s, p) => s + p.stock * Number(p.cost), 0),
    saleValue: data.reduce((s, p) => s + p.stock * Number(p.price), 0),
    lowStock: data.filter((p) => p.stock <= p.min_stock).length
  })
}))

// ---------- Descuentos ----------
const discountDTO = (d) => ({ id: d.id, name: d.name, type: d.type, value: Number(d.value), active: d.active })
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
  const { data, error } = await supabase.from('discounts').insert({ name: clean(b.name), type: b.type, value: Number(b.value), active: b.active !== false }).select().single()
  if (error) return error.code === '23505' ? fail(res, 'Ya existe un descuento con ese nombre', 409) : fail(res, error)
  await audit(req, 'crear', 'descuento', data.id)
  res.status(201).send(discountDTO(data))
}))
router.put('/descuentos/:id', auth(ADMIN), h(async (req, res) => {
  const errors = validateDiscount(req.body || {})
  if (errors.length) return fail(res, errors.join('. '), 400)
  const b = req.body
  const { data, error } = await supabase.from('discounts').update({ name: clean(b.name), type: b.type, value: Number(b.value), active: b.active !== false }).eq('id', Number(req.params.id)).select().maybeSingle()
  if (error) return error.code === '23505' ? fail(res, 'Ya existe un descuento con ese nombre', 409) : fail(res, error)
  if (!data) return fail(res, 'Descuento no encontrado', 404)
  await audit(req, 'editar', 'descuento', data.id)
  res.send(discountDTO(data))
}))

module.exports = router
