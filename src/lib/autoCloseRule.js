// Reglas del cierre automático de jornada (sin base de datos, para probarlas aparte).
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/
// Se permite entre el mediodía y la medianoche: así el día del cierre es el mismo en todos los países.
const validTime = (t) => HHMM.test(String(t || '')) && String(t) >= '12:00'
const hhmm = (t) => (t ? String(t).slice(0, 5) : null)

// Hora local (HH:MM) en una zona horaria.
const localTime = (tz, now = new Date()) => {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz || 'America/Bogota', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now)
  const get = (k) => parts.find((p) => p.type === k)?.value || '00'
  return `${get('hour')}:${get('minute')}`
}

// Regla que aplica al negocio: { mode, countryTime, ownTime, time (la que rige o null), timezone }.
const resolveRule = (settings, country) => {
  const mode = settings?.auto_close_mode || 'pais'
  const countryTime = hhmm(country?.autoCloseTime ?? country?.auto_close_time)
  const ownTime = hhmm(settings?.auto_close_time)
  const time = mode === 'desactivado' ? null : mode === 'hora' ? ownTime : countryTime
  return { mode, countryTime, ownTime, time: time || null, timezone: settings?.timezone || country?.timezone || 'America/Bogota' }
}

module.exports = { validTime, hhmm, localTime, resolveRule }
