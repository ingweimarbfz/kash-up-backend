const supabase = require('./db')

// Avisos por Telegram (KU-018): cada acción auditada puede generar un mensaje. Se carga tarde para evitar ciclos.
const notifyAudit = (...a) => { try { require('./notify').onAudit(...a) } catch (e) { console.warn('[telegram]', e.message) } }

// Registra una acción en la auditoría. Nunca rompe la petición si falla.
const audit = async (req, action, entity, entityId = null, detail = null) => {
  try {
    await supabase.from('audit_log').insert({
      user_id: req.user?.id ?? null,
      action,
      entity,
      entity_id: entityId === null ? null : String(entityId),
      detail,
      ip: (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim() || null
    })
  } catch (e) {
    console.warn('[auditoría]', e.message)
  }
  notifyAudit(req, action, entity, entityId, detail)
}

module.exports = { audit }
