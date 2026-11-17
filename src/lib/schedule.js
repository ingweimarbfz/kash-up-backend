// =====================================================================
// Motor de cálculo de créditos de QuontUp360.
// Calcula el plan de cuotas (fechas, capital, interés y valor) para las tres modalidades de interés:
//
// · fija         Interés plano sobre el capital inicial. Interés total = capital × tasa × meses de plazo
//                (o × 1 si la tasa es por todo el crédito). Capital e interés se reparten por igual en las cuotas.
// · sobre_saldo  Cuota fija con interés sobre el saldo (sistema francés). La tasa mensual se lleva al periodo
//                de la cuota (tasa × días del periodo / 30). Cada cuota paga menos interés y más capital.
// · anticipada   El interés (calculado como la fija) se cobra al desembolsar: el cliente recibe capital − interés
//                y las cuotas solo pagan capital.
//
// Periodicidad: diaria (1 día), semanal (7), quincenal (15), mensual (mismo día cada mes) o personalizada
// (cada N días). Con "excluir domingos" una cuota que caiga en domingo pasa al lunes.
// Valores en pesos enteros. Las cuotas de fija y anticipada se redondean hacia arriba al múltiplo de roundTo
// y la última cuota ajusta la diferencia para que el total cuadre exacto.
// =====================================================================

const FREQUENCIES = { diaria: 1, semanal: 7, quincenal: 15, mensual: 30 }
const METHODS = ['fija', 'sobre_saldo', 'anticipada']
const BASES = ['mensual', 'total']

const pad = (n) => String(n).padStart(2, '0')
const toISO = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
const parseISO = (s) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))) return null
  const [y, m, d] = s.split('-').map(Number)
  const date = new Date(Date.UTC(y, m - 1, d))
  return date.getUTCMonth() === m - 1 ? date : null
}
const addDays = (d, n) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + n))
// Suma meses conservando el día; si el mes no tiene ese día (31 → febrero) usa el último día del mes.
const addMonths = (d, n, day) => {
  const y = d.getUTCFullYear()
  const m = d.getUTCMonth() + n
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate()
  return new Date(Date.UTC(y, m, Math.min(day, last)))
}
const isSunday = (d) => d.getUTCDay() === 0

const intervalDays = (frequency, customDays) => (frequency === 'personalizada' ? Number(customDays) : FREQUENCIES[frequency])

// Fechas de vencimiento de las n cuotas.
const dueDates = ({ frequency, customDays, count, firstDueDate, skipSundays }) => {
  const first = parseISO(firstDueDate)
  const out = []
  let cur = first
  if (skipSundays && isSunday(cur)) cur = addDays(cur, 1)
  for (let i = 0; i < count; i++) {
    if (i > 0) {
      if (frequency === 'mensual') cur = addMonths(first, i, first.getUTCDate())
      else cur = addDays(out[i - 1], intervalDays(frequency, customDays))
      if (skipSundays && isSunday(cur)) cur = addDays(cur, 1)
    }
    out.push(cur)
  }
  return out.map(toISO)
}

// Primer vencimiento sugerido: un periodo después del desembolso.
const suggestFirstDue = (disbursementDate, frequency, customDays, skipSundays) => {
  const d = parseISO(disbursementDate)
  if (!d) return null
  let f = frequency === 'mensual' ? addMonths(d, 1, d.getUTCDate()) : addDays(d, intervalDays(frequency, customDays) || 1)
  if (skipSundays && isSunday(f)) f = addDays(f, 1)
  return toISO(f)
}

const roundUp = (v, step) => (step > 1 ? Math.ceil(v / step) * step : Math.ceil(v))

// Reparte un total en n cuotas redondeadas hacia arriba; la última ajusta.
const split = (total, n, step) => {
  const base = Math.min(roundUp(total / n, step), Math.floor(total / Math.max(n - 1, 1)) || total)
  const out = Array(n).fill(base)
  out[n - 1] = total - base * (n - 1)
  // Si el redondeo deja la última cuota negativa o en cero (cuotas muy pequeñas), se reparte sin redondear.
  if (out[n - 1] <= 0) {
    const plain = Math.floor(total / n)
    out.fill(plain)
    out[n - 1] = total - plain * (n - 1)
  }
  return out
}

const validate = (p) => {
  const errors = []
  if (!(Number(p.principal) > 0)) errors.push('El capital debe ser mayor que cero')
  if (!METHODS.includes(p.method)) errors.push('Modalidad de interés inválida')
  if (!BASES.includes(p.rateBasis)) errors.push('Base de la tasa inválida')
  if (!(Number(p.rate) >= 0 && Number(p.rate) <= 100)) errors.push('La tasa debe estar entre 0 % y 100 %')
  if (p.method === 'sobre_saldo' && p.rateBasis !== 'mensual') errors.push('El interés sobre saldo usa una tasa mensual')
  if (!(p.frequency in FREQUENCIES) && p.frequency !== 'personalizada') errors.push('Periodicidad inválida')
  if (p.frequency === 'personalizada' && !(Number.isInteger(Number(p.customDays)) && Number(p.customDays) >= 1 && Number(p.customDays) <= 365)) errors.push('Indica cada cuántos días (1 a 365) en la periodicidad personalizada')
  if (!(Number.isInteger(Number(p.count)) && Number(p.count) >= 1 && Number(p.count) <= 720)) errors.push('El número de cuotas debe estar entre 1 y 720')
  if (!parseISO(p.disbursementDate)) errors.push('Fecha de desembolso inválida')
  if (!parseISO(p.firstDueDate)) errors.push('Fecha de la primera cuota inválida')
  else if (parseISO(p.disbursementDate) && parseISO(p.firstDueDate) < parseISO(p.disbursementDate)) errors.push('La primera cuota no puede ser antes del desembolso')
  return errors
}

/**
 * Calcula el plan de cuotas.
 * @param {object} p principal, method, rate (% ej. 20), rateBasis, frequency, customDays, count,
 *                   disbursementDate, firstDueDate, skipSundays, roundTo (por defecto 100)
 */
const buildSchedule = (p) => {
  const errors = validate(p)
  if (errors.length) { const e = new Error(errors.join('. ')); e.status = 400; throw e }

  const principal = Math.round(Number(p.principal))
  const n = Number(p.count)
  const rate = Number(p.rate) / 100
  const days = intervalDays(p.frequency, p.customDays)
  const step = p.roundTo === undefined ? 100 : Number(p.roundTo) || 1
  const dates = dueDates({ frequency: p.frequency, customDays: p.customDays, count: n, firstDueDate: p.firstDueDate, skipSundays: Boolean(p.skipSundays) })
  // Meses de plazo: periodos × días del periodo / 30 (mensual = número de cuotas).
  const months = p.frequency === 'mensual' ? n : (n * days) / 30
  const flatInterest = Math.round(principal * rate * (p.rateBasis === 'total' ? 1 : months))

  let rows
  if (p.method === 'sobre_saldo') {
    const i = rate * (p.frequency === 'mensual' ? 1 : days / 30)
    const cuota = i === 0 ? principal / n : (principal * i) / (1 - (1 + i) ** -n)
    const amount = Math.round(cuota)
    let balance = principal
    rows = dates.map((dueDate, k) => {
      const interest = Math.round(balance * i)
      let capital = amount - interest
      if (k === n - 1 || capital > balance) capital = balance
      balance -= capital
      return { number: k + 1, dueDate, capital, interest, amount: capital + interest }
    })
  } else {
    const anticipated = p.method === 'anticipada'
    const total = anticipated ? principal : principal + flatInterest
    const amounts = split(total, n, step)
    const capitals = split(principal, n, 1)
    // En fija el interés de cada cuota es lo que excede al capital; se recalcula para que capital + interés = cuota.
    let capLeft = principal
    rows = dates.map((dueDate, k) => {
      const amount = amounts[k]
      let capital = anticipated ? amount : Math.min(capitals[k], amount, capLeft)
      if (k === n - 1) capital = capLeft
      capLeft -= capital
      return { number: k + 1, dueDate, capital, interest: amount - capital, amount }
    })
  }

  const totalInterest = rows.reduce((s, r) => s + r.interest, 0) + (p.method === 'anticipada' ? flatInterest : 0)
  const totalAmount = rows.reduce((s, r) => s + r.amount, 0)
  return {
    principal,
    method: p.method,
    rate: Number(p.rate),
    rateBasis: p.rateBasis,
    frequency: p.frequency,
    intervalDays: days,
    count: n,
    months: Math.round(months * 100) / 100,
    totalInterest,
    totalAmount,
    installmentAmount: rows[0].amount,
    disbursedAmount: p.method === 'anticipada' ? principal - flatInterest : principal,
    anticipatedInterest: p.method === 'anticipada' ? flatInterest : 0,
    firstDueDate: rows[0].dueDate,
    lastDueDate: rows[n - 1].dueDate,
    installments: rows
  }
}

module.exports = { buildSchedule, suggestFirstDue, dueDates, intervalDays, FREQUENCIES, METHODS, parseISO, toISO }
