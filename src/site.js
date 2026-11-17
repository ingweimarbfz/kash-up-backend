const supabase = require('./db')

// Sedes (cobros por ciudad). El administrador elige una sede con ?sede= (o "todas") y la información
// se filtra por los prestamistas (ruteros) de esa sede: cada cliente, crédito, pago y gasto pertenece
// a la sede de su prestamista. El prestamista ya ve solo lo suyo, así que no necesita filtro.
const loadSite = async (req) => {
  req.siteId = null
  req.siteLenders = null
  if (req.user.role !== 'administrador') return
  const id = Number(req.query?.sede)
  if (!id) return
  const { data } = await supabase.from('users').select('id').eq('role', 'prestamista').eq('site_id', id)
  req.siteId = id
  req.siteLenders = (data || []).map((u) => u.id)
  if (!req.siteLenders.length) req.siteLenders = [0]
}

// Restringe una consulta a la sede elegida (columna con el prestamista: lender_id, collector_id…).
const bySite = (req, q, col = 'lender_id') => (req.siteLenders ? q.in(col, req.siteLenders) : q)
// ¿El prestamista pertenece a la sede elegida?
const inSite = (req, lenderId) => !req.siteLenders || req.siteLenders.includes(Number(lenderId))

// Filtro por prestamista: un id, una lista de ids (sede) o null (todo).
const byLenders = (q, who, col = 'lender_id') => (who == null ? q : Array.isArray(who) ? q.in(col, who) : q.eq(col, who))

module.exports = { loadSite, bySite, inSite, byLenders }
