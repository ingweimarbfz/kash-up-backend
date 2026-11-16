// Configuración de las notificaciones por Telegram (KU-018): bot, grupos por sección y sede, pruebas,
// resúmenes manuales y enlaces para que cada usuario se una a los grupos que le corresponden.
const express = require('express')
const supabase = require('../db')
const { h, fail, clean } = require('../http')
const { auth, ADMIN } = require('../auth')
const { SECTIONS, tg, esc, loadSettings, sendSummary } = require('../notify')

const router = express.Router()
const TOKEN_RE = /^\d{6,12}:[A-Za-z0-9_-]{30,}$/
const mask = (t) => (t ? `${t.split(':')[0]}:••••••${t.slice(-4)}` : null)
// Lo que puede recibir un rutero: los grupos de su sede en estas secciones.
const LENDER_SECTIONS = ['cobros', 'creditos', 'gastos', 'resumen']

const channelDTO = (c, sites) => ({
  id: c.id, section: c.section, sectionLabel: SECTIONS[c.section]?.label, siteId: c.site_id,
  siteName: c.site_id ? sites.find((s) => s.id === c.site_id)?.name || 'Sede' : 'Todas las sedes',
  chatId: c.chat_id, title: c.title, enabled: c.enabled, createdAt: c.created_at
})
const settingsDTO = (st) => ({
  configured: Boolean(st?.bot_token), enabled: Boolean(st?.enabled), token: mask(st?.bot_token),
  username: st?.bot_username || null, name: st?.bot_name || null,
  morningHour: st?.morning_hour ?? 7, eveningHour: st?.evening_hour ?? 19,
  morningEnabled: st?.morning_enabled ?? true, eveningEnabled: st?.evening_enabled ?? true,
  lastMorningOn: st?.last_morning_on || null, lastEveningOn: st?.last_evening_on || null
})
const needBot = async () => {
  const st = await loadSettings()
  if (!st?.bot_token) throw Object.assign(new Error('Primero conecta el bot de Telegram'), { status: 400 })
  return st
}
const sitesList = async () => (await supabase.from('sites').select('id, name, city').eq('active', true).order('name')).data || []

router.get('/notificaciones', auth(ADMIN), h(async (req, res) => {
  const [st, sites, { data: chans }, { data: log }] = await Promise.all([
    loadSettings(), sitesList(),
    supabase.from('notification_channels').select('*').order('section').order('id'),
    supabase.from('notification_log').select('*').order('id', { ascending: false }).limit(40)
  ])
  res.send({
    bot: settingsDTO(st), sites,
    sections: Object.entries(SECTIONS).map(([key, s]) => ({ key, ...s })),
    channels: (chans || []).map((c) => channelDTO(c, sites)),
    log: (log || []).map((l) => ({
      id: l.id, section: l.section, sectionLabel: SECTIONS[l.section]?.label || l.section, status: l.status, detail: l.detail, createdAt: l.created_at,
      siteName: l.site_id ? sites.find((s) => s.id === l.site_id)?.name : null,
      chatTitle: (chans || []).find((c) => c.chat_id === l.chat_id)?.title || l.chat_id
    }))
  })
}))

// Conecta el bot (valida el token con getMe) o cambia horarios y activación.
router.put('/notificaciones/bot', auth(ADMIN), h(async (req, res) => {
  const b = req.body || {}
  const st = await loadSettings()
  const row = {}
  if (b.token !== undefined && b.token !== '') {
    const token = String(b.token).trim()
    if (!TOKEN_RE.test(token)) return fail(res, 'El token no tiene el formato de @BotFather (número:clave)', 400)
    let me
    try { me = await tg(token, 'getMe') } catch (e) { return fail(res, 'Telegram no reconoce ese token. Cópialo de nuevo desde @BotFather', 400) }
    Object.assign(row, { bot_token: token, bot_username: me.username, bot_name: me.first_name, enabled: b.enabled ?? true })
  } else if (!st?.bot_token) return fail(res, 'Pega el token del bot que te dio @BotFather', 400)
  if (typeof b.enabled === 'boolean') row.enabled = b.enabled
  for (const [k, col] of [['morningHour', 'morning_hour'], ['eveningHour', 'evening_hour']]) {
    if (b[k] === undefined) continue
    const v = Number(b[k])
    if (!Number.isInteger(v) || v < 0 || v > 23) return fail(res, 'La hora debe estar entre 0 y 23', 400)
    row[col] = v
  }
  const mh = row.morning_hour ?? st?.morning_hour ?? 7
  const eh = row.evening_hour ?? st?.evening_hour ?? 19
  if (mh >= eh) return fail(res, 'La agenda de la mañana debe salir antes que el resumen del cierre', 400)
  if (typeof b.morningEnabled === 'boolean') row.morning_enabled = b.morningEnabled
  if (typeof b.eveningEnabled === 'boolean') row.evening_enabled = b.eveningEnabled
  row.updated_at = new Date().toISOString()
  const { error } = st ? await supabase.from('notification_settings').update(row).not('org_id', 'is', null) : await supabase.from('notification_settings').insert(row)
  if (error) throw error
  res.send(settingsDTO(await loadSettings()))
}))

router.delete('/notificaciones/bot', auth(ADMIN), h(async (req, res) => {
  await supabase.from('notification_settings').update({ bot_token: null, bot_username: null, bot_name: null, enabled: false, updated_at: new Date().toISOString() }).not('org_id', 'is', null)
  res.send(settingsDTO(await loadSettings()))
}))

// Grupos donde está el bot: lee los mensajes recientes (hay que escribir algo en el grupo después de agregarlo).
router.post('/notificaciones/buscar-grupos', auth(ADMIN), h(async (req, res) => {
  const st = await needBot()
  const updates = await tg(st.bot_token, 'getUpdates', { limit: 100, allowed_updates: ['message', 'my_chat_member', 'channel_post'] })
  const found = new Map()
  for (const u of updates || []) {
    const chat = u.message?.chat || u.my_chat_member?.chat || u.channel_post?.chat
    if (!chat || chat.type === 'private') continue
    if (u.my_chat_member && ['left', 'kicked'].includes(u.my_chat_member.new_chat_member?.status)) { found.delete(String(chat.id)); continue }
    found.set(String(chat.id), { chatId: String(chat.id), title: chat.title || 'Grupo', type: chat.type })
  }
  res.send([...found.values()])
}))

router.post('/notificaciones/canales', auth(ADMIN), h(async (req, res) => {
  const b = req.body || {}
  if (!SECTIONS[b.section]) return fail(res, 'Elige la sección', 400)
  const chatId = clean(String(b.chatId ?? ''))
  if (!chatId || !/^-?\d{5,20}$/.test(chatId)) return fail(res, 'Elige el grupo de Telegram', 400)
  const siteId = Number(b.siteId) || null
  if (siteId && !(await supabase.from('sites').select('id').eq('id', siteId).maybeSingle()).data) return fail(res, 'Sede no encontrada', 404)
  const { data: dup } = await supabase.from('notification_channels').select('site_id').eq('section', b.section).eq('chat_id', chatId)
  if ((dup || []).some((d) => (d.site_id ?? null) === siteId)) return fail(res, 'Ese grupo ya recibe esa sección para esa sede', 400)
  const { data, error } = await supabase.from('notification_channels').insert({ section: b.section, chat_id: chatId, site_id: siteId, title: clean(b.title) || 'Grupo', enabled: true }).select('*').single()
  if (error) throw error
  res.status(201).send(channelDTO(data, await sitesList()))
}))

router.put('/notificaciones/canales/:id', auth(ADMIN), h(async (req, res) => {
  const { data, error } = await supabase.from('notification_channels').update({ enabled: Boolean(req.body?.enabled) }).eq('id', Number(req.params.id)).select('*').maybeSingle()
  if (error) throw error
  if (!data) return fail(res, 'Grupo no encontrado', 404)
  res.send(channelDTO(data, await sitesList()))
}))

router.delete('/notificaciones/canales/:id', auth(ADMIN), h(async (req, res) => {
  await supabase.from('notification_channels').delete().eq('id', Number(req.params.id))
  res.status(204).end()
}))

router.post('/notificaciones/canales/:id/prueba', auth(ADMIN), h(async (req, res) => {
  const st = await needBot()
  const { data: c } = await supabase.from('notification_channels').select('*').eq('id', Number(req.params.id)).maybeSingle()
  if (!c) return fail(res, 'Grupo no encontrado', 404)
  const site = c.site_id ? (await supabase.from('sites').select('name').eq('id', c.site_id).maybeSingle()).data?.name : null
  const html = `✅ <b>KashUp conectado</b>\n━━━━━━━━━━━━━━━\nEste grupo recibirá: <b>${esc(SECTIONS[c.section].label)}</b>\n📍 ${esc(site || 'Todas las sedes')}\nℹ️ ${esc(SECTIONS[c.section].hint)}`
  let status = 'enviado'; let detail = null
  try { await tg(st.bot_token, 'sendMessage', { chat_id: c.chat_id, text: html, parse_mode: 'HTML' }) } catch (e) { status = 'error'; detail = e.message }
  await supabase.from('notification_log').insert({ section: c.section, chat_id: c.chat_id, site_id: c.site_id, status, detail })
  if (status === 'error') return fail(res, detail, 400)
  res.send({ ok: true })
}))

// Envía ya la agenda de la mañana o el resumen del cierre (para probar o reenviar).
router.post('/notificaciones/resumen/:kind(manana|cierre)', auth(ADMIN), h(async (req, res) => {
  await needBot()
  const sent = await sendSummary(req.params.kind === 'manana' ? 'morning' : 'evening')
  if (!sent) return fail(res, 'No hay grupos activos de "Resumen diario" o ninguno tiene ruteros', 400)
  res.send({ sent })
}))

// Grupos a los que puede unirse el usuario: el administrador a todos; el rutero a los de su sede.
const myChannels = async (user) => {
  let q = supabase.from('notification_channels').select('*').eq('enabled', true).order('section')
  if (user.role === 'prestamista') {
    if (!user.site_id) return []
    q = q.eq('site_id', user.site_id).in('section', LENDER_SECTIONS)
  } else if (user.role !== 'administrador') return []
  return (await q).data || []
}
router.get('/mis-notificaciones', auth(['administrador', 'prestamista']), h(async (req, res) => {
  const st = await loadSettings()
  if (!st?.enabled || !st.bot_token) return res.send({ enabled: false, groups: [] })
  const [chans, sites] = await Promise.all([myChannels(req.user), sitesList()])
  res.send({ enabled: true, bot: st.bot_username, groups: chans.map((c) => ({ ...channelDTO(c, sites), hint: SECTIONS[c.section]?.hint })) })
}))
router.post('/mis-notificaciones/:id/unirme', auth(['administrador', 'prestamista']), h(async (req, res) => {
  const st = await needBot()
  const c = (await myChannels(req.user)).find((x) => x.id === Number(req.params.id))
  if (!c) return fail(res, 'No tienes acceso a ese grupo', 403)
  try {
    const link = await tg(st.bot_token, 'createChatInviteLink', { chat_id: c.chat_id, name: `${req.user.name}`.slice(0, 32), member_limit: 1, expire_date: Math.floor(Date.now() / 1000) + 86400 })
    res.send({ url: link.invite_link })
  } catch (e) {
    fail(res, 'No se pudo crear el enlace. El bot debe ser administrador del grupo con permiso para invitar.', 400)
  }
}))

module.exports = router
