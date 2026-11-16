const express = require('express')
const supabase = require('../db')
const { h } = require('../http')
const { auth, ADMIN } = require('../auth')

const router = express.Router()

// Últimos movimientos de auditoría (los filtros y reportes completos llegan en la etapa 4).
router.get('/auditoria', auth(ADMIN), h(async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200)
  const { data, error } = await supabase.from('audit_log')
    .select('id, action, entity, entity_id, detail, ip, created_at, user:users(id, name, last_name, username)')
    .order('created_at', { ascending: false }).limit(limit)
  if (error) throw error
  res.send(data.map((a) => ({
    id: a.id, action: a.action, entity: a.entity, entityId: a.entity_id, detail: a.detail, ip: a.ip, createdAt: a.created_at,
    user: a.user ? { id: a.user.id, fullName: `${a.user.name} ${a.user.last_name || ''}`.trim(), username: a.user.username } : null
  })))
}))

module.exports = router
