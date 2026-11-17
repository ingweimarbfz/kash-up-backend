// Scoring crediticio del cliente a partir de su historial de cuotas.
// · Cuotas pagadas a tiempo suman; pagadas tarde restan según los días de atraso.
// · Cuotas vencidas sin pagar hoy restan fuerte.
// · Créditos castigados llevan el puntaje a riesgo.
// Resultado: puntaje 0–100 y nivel. Sin cuotas cumplidas aún = "Nuevo".
const DAY = 86400000
const daysBetween = (a, b) => Math.round((new Date(b) - new Date(a)) / DAY)

const LEVELS = [
  [85, 'Excelente', 'ok'],
  [70, 'Bueno', 'brand'],
  [50, 'Regular', 'warn'],
  [0, 'Riesgo', 'bad']
]

const score = ({ installments = [], credits = [], today }) => {
  const due = installments.filter((i) => i.status !== 'anulada' && i.due_date <= today)
  if (!due.length && !credits.some((c) => c.status === 'castigado')) return { score: null, level: 'Nuevo', tone: '', detail: { evaluated: 0 } }

  let points = 0
  let onTime = 0
  let late = 0
  let overdue = 0
  let maxLateDays = 0
  for (const i of due) {
    if (i.status === 'pagada') {
      const lateDays = i.paid_at ? Math.max(0, daysBetween(i.due_date, String(i.paid_at).slice(0, 10))) : 0
      maxLateDays = Math.max(maxLateDays, lateDays)
      if (lateDays === 0) { onTime++; points += 100 } else { late++; points += Math.max(20, 90 - lateDays * 5) }
    } else {
      const lateDays = daysBetween(i.due_date, today)
      maxLateDays = Math.max(maxLateDays, lateDays)
      overdue++
      points += Math.max(0, 40 - lateDays * 4)
    }
  }
  let value = Math.round(points / due.length)
  if (credits.some((c) => c.status === 'castigado')) value = Math.min(value, 20)
  if (credits.filter((c) => c.status === 'pagado').length >= 2 && value >= 70) value = Math.min(100, value + 5)
  const [, level, tone] = LEVELS.find(([min]) => value >= min)
  return { score: value, level, tone, detail: { evaluated: due.length, onTime, late, overdue, maxLateDays } }
}

module.exports = { score }
