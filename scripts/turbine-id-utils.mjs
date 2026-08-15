export function clean(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function normalizeTurbineId(value) {
  return clean(value).toUpperCase()
}

export function expandTurbineIdSpec(value) {
  const text = clean(value)
  if (!text || /无|已技改/u.test(text)) return []

  const parts = text
    .split(/[、,，;；/\s]+/u)
    .map(part => clean(part))
    .filter(Boolean)

  const expanded = []
  for (const part of parts) {
    expanded.push(...expandTurbineIdPart(part))
  }
  return expanded
}

export function expandParallelTurbineIdSpecs(...specs) {
  const groups = specs.map(spec => expandTurbineIdSpec(spec))
  const active = groups.filter(group => group.length > 0)
  if (active.length === 0) return []
  const length = active[0].length
  if (!active.every(group => group.length === length)) {
    return active[0]
  }
  return active.map((group, index) => {
    const row = {}
    for (const [specIndex, specGroup] of groups.entries()) {
      if (specGroup.length === length) {
        row[`col${specIndex}`] = specGroup[index]
      }
    }
    return row
  })
}

function expandTurbineIdPart(part) {
  const rangeMatch = part.match(/^(.+?)-(.+)$/u)
  if (rangeMatch) {
    const left = clean(rangeMatch[1])
    const right = clean(rangeMatch[2])
    if (/\d/u.test(left) && /\d/u.test(right)) {
      const expanded = expandTokenRange(left, right)
      if (expanded.length > 0) return expanded
    }
  }
  const normalized = normalizeTurbineId(part)
  return normalized ? [normalized] : []
}

function expandTokenRange(startToken, endToken) {
  const start = parseTurbineToken(startToken)
  let end = parseTurbineToken(endToken)
  if (!start || !end) return []

  if (!end.prefix && start.prefix) {
    end = {
      ...end,
      prefix: start.prefix,
      suffix: end.suffix || start.suffix,
      width: Math.max(end.width, start.width),
    }
  }

  if (start.prefix !== end.prefix || start.suffix !== end.suffix) return []
  if (end.num < start.num) return []

  const ids = []
  for (let num = start.num; num <= end.num; num += 1) {
    ids.push(
      normalizeTurbineId(
        formatTurbineToken({
          prefix: start.prefix,
          num,
          suffix: start.suffix,
          width: start.width,
        }),
      ),
    )
  }
  return ids
}

function parseTurbineToken(token) {
  const value = clean(token)
  const match = value.match(/^([A-Za-z]*?)(\d+)(#?)$/u)
  if (!match) return null
  return {
    prefix: match[1].toUpperCase(),
    num: Number.parseInt(match[2], 10),
    suffix: match[3],
    width: match[2].length,
  }
}

function formatTurbineToken({ prefix, num, suffix, width }) {
  return `${prefix}${String(num).padStart(width, '0')}${suffix}`
}

export function zipExpandedTurbineRows(labelIds, unitNumbers) {
  const labels = expandTurbineIdSpec(labelIds)
  const units = expandTurbineIdSpec(unitNumbers)
  if (labels.length === 0) return []
  if (units.length === labels.length) {
    return labels.map((labelId, index) => ({
      labelId,
      unitNumber: units[index] ?? '',
    }))
  }
  return labels.map(labelId => ({ labelId, unitNumber: '' }))
}
