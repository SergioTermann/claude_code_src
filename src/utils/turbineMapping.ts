import turbineMappingData from '../data/turbineMapping.json'

export type TurbineMappingEntry = {
  turbineId: string
  unitNumber: string
  site: string
  siteFull: string
  brand: string
  model: string
  standardModel: string
}

const TURBINE_MAPPING_ENTRIES =
  turbineMappingData as TurbineMappingEntry[]

const SITE_TURBINE_LOOKUP = new Map<string, TurbineMappingEntry>()
const GLOBAL_TURBINE_LOOKUP = new Map<string, TurbineMappingEntry[]>()
const KNOWN_SITES = [...new Set(TURBINE_MAPPING_ENTRIES.map(entry => entry.site))]
const ALL_KNOWN_TURBINE_IDS = new Set(
  TURBINE_MAPPING_ENTRIES.map(entry => normalizeTurbineId(entry.turbineId)).filter(Boolean),
)

for (const entry of TURBINE_MAPPING_ENTRIES) {
  const turbineId = normalizeTurbineId(entry.turbineId)
  const siteKey = normalizeSiteKey(entry.site)
  SITE_TURBINE_LOOKUP.set(`${siteKey}\u0000${turbineId}`, entry)
  const globalMatches = GLOBAL_TURBINE_LOOKUP.get(turbineId) ?? []
  globalMatches.push(entry)
  GLOBAL_TURBINE_LOOKUP.set(turbineId, globalMatches)
}

export function listTurbineMappingEntries(): TurbineMappingEntry[] {
  return TURBINE_MAPPING_ENTRIES
}

export function knownTurbineIds(): string[] {
  return TURBINE_MAPPING_ENTRIES.map(entry => entry.turbineId)
}

export function knownSites(): string[] {
  return KNOWN_SITES
}

export function extractSiteFromText(text: string): string | null {
  const normalized = normalizeSiteKey(text)
  if (!normalized) return null
  let best: string | null = null
  for (const site of KNOWN_SITES) {
    const siteKey = normalizeSiteKey(site)
    if (!siteKey) continue
    if (normalized.includes(siteKey) && (!best || siteKey.length > normalizeSiteKey(best).length)) {
      best = site
    }
  }
  return best
}

export function lookupTurbineMapping(
  turbineId: string,
  site?: string,
): TurbineMappingEntry | null {
  for (const candidate of buildTurbineIdCandidates(turbineId, site)) {
    const match = lookupTurbineCandidate(candidate.id, candidate.site)
    if (match) return match
  }
  return null
}

export function extractTurbineIdsFromText(
  text: string,
  extraKnownIds: Iterable<string> = [],
): string[] {
  const normalized = String(text || '').trim()
  if (!normalized) return []
  // SC table fault codes contain fragments such as "SC03" that also look
  // like turbine IDs. Remove the complete code before scanning free-form IDs.
  const turbineScanText = normalized.replace(
    /\bSC\s*\d{2}\s*[_/-]?\s*\d{2}\s*[_/-]?\s*\d{3}\b/giu,
    ' ',
  )

  const known = new Set<string>(ALL_KNOWN_TURBINE_IDS)
  for (const extraId of extraKnownIds) {
    const id = normalizeTurbineId(extraId)
    if (id) known.add(id)
  }
  const found = new Set<string>()

  for (const match of normalized.matchAll(
    /(?:风机编号|风机号|机位号|机组编号|对应编号|标牌|编号)[:：]?\s*([A-Za-z0-9#_-]+)/giu,
  )) {
    const id = normalizeTurbineId(match[1] ?? '')
    if (id && !/^SC\d{2}[_/-]?\d{2}[_/-]?\d{3}$/iu.test(id)) found.add(id)
  }

  for (const match of turbineScanText.matchAll(
    /(?<![A-Za-z0-9])([A-Za-z]{1,4}\d{1,3}#?)(?![A-Za-z0-9.])/giu,
  )) {
    const id = normalizeTurbineId(match[1] ?? '')
    if (id && (known.has(id) || isLikelyTurbineLabel(id))) found.add(id)
  }

  for (const match of turbineScanText.matchAll(/(?<![A-Za-z0-9])(\d{1,3})#/giu)) {
    const id = normalizeTurbineId(`${match[1]}#`)
    if (known.has(id) || isLikelyTurbineLabel(id)) found.add(id)
  }

  for (const match of turbineScanText.matchAll(/(?<![A-Za-z0-9])(\d{1,3})号(?![A-Za-z0-9])/giu)) {
    const numeric = match[1] ?? ''
    const hashId = normalizeTurbineId(`${numeric}#`)
    const plainId = normalizeTurbineId(numeric)
    if (known.has(hashId)) found.add(hashId)
    else if (known.has(plainId)) found.add(plainId)
    else if (isLikelyTurbineLabel(hashId)) found.add(hashId)
  }

  for (const match of turbineScanText.matchAll(
    /(?<![A-Za-z0-9#_-])([A-Za-z0-9#_-]{1,8})(?![A-Za-z0-9#_-])/giu,
  )) {
    const raw = match[1] ?? ''
    if (!raw) continue
    const id = normalizeTurbineId(raw)
    if (known.has(id)) {
      found.add(id)
      continue
    }
    if (/^\d+$/.test(raw)) {
      const hashId = normalizeTurbineId(`${raw}#`)
      if (known.has(hashId)) found.add(hashId)
    }
  }

  return dedupeTurbineIds([...found], normalized)
}

function dedupeTurbineIds(ids: string[], text: string): string[] {
  const upper = String(text || '').toUpperCase()
  const set = new Set(ids.map(id => normalizeTurbineId(id)).filter(Boolean))
  const result: string[] = []
  for (const id of set) {
    if (!id.endsWith('#')) {
      const hashId = `${id}#`
      if (set.has(hashId)) {
        const hashInQuery = new RegExp(
          `(?<![A-Za-z0-9])${escapeRegExp(hashId)}(?![A-Za-z0-9])`,
          'i',
        ).test(upper)
        if (hashInQuery) continue
      }
    }
    result.push(id)
  }
  return result
}

export function splitTurbineIds(value: string): string[] {
  return String(value || '')
    .split(/[、,，;；/]/u)
    .map(item => normalizeTurbineId(item))
    .filter(Boolean)
}

export function recordMatchesTurbineId(
  turbineIds: string | undefined,
  turbineId: string,
  site?: string,
): boolean {
  const target = normalizeTurbineId(turbineId)
  if (!target) return false
  const ids = splitTurbineIds(turbineIds ?? '')
  if (ids.includes(target)) return true

  const siteKey = site ? normalizeSiteKey(site) : ''
  if (siteKey) {
    for (const candidate of buildTurbineIdCandidates(turbineId, site)) {
      if (ids.includes(candidate.id)) return true
    }
  }
  return false
}

/** When KB lists sibling IDs (e.g. H01#) but query uses mapped alias (A01#) of same brand/model. */
export function recordMatchesMappedTurbineModel(
  record: {
    site?: string
    brand?: string
    model?: string
    standardModel?: string
    turbineIds?: string
  },
  turbineId: string,
  site?: string,
): boolean {
  if (recordMatchesTurbineId(record.turbineIds, turbineId, site)) return true
  const entry = lookupTurbineMapping(turbineId, site)
  if (!entry) return false

  const recordSites = String(record.site || '')
    .split(/[、,，;；/]/u)
    .map(item => normalizeSiteKey(item))
    .filter(Boolean)
  if (
    recordSites.length > 0 &&
    !recordSites.includes(normalizeSiteKey(entry.site))
  ) {
    return false
  }
  if (record.brand && entry.brand && record.brand !== entry.brand) return false

  const entryModels = [entry.model, entry.standardModel]
    .map(value => normalizeModelKey(value))
    .filter(Boolean)
  const recordModels = [record.model, record.standardModel]
    .map(value => normalizeModelKey(value))
    .filter(Boolean)
  if (entryModels.length === 0 || recordModels.length === 0) return false
  return entryModels.some(model => recordModels.includes(model))
}

function normalizeModelKey(value: string | undefined): string {
  return String(value || '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/系列$/u, '')
    .trim()
}

export function renderTurbineMappingAnswer(entry: TurbineMappingEntry): string {
  return [
    `## 本地答案：${entry.turbineId}`,
    '',
    `**结论：** 风机编号「${entry.turbineId}」对应 ${entry.siteFull} / ${entry.brand} / ${entry.model}${entry.standardModel ? ` / 具体型号：${entry.standardModel}` : ''}。`,
    '',
    `- 风场：${entry.siteFull}`,
    `- 品牌：${entry.brand}`,
    `- 机型：${entry.model}`,
    entry.standardModel ? `- 具体型号：${entry.standardModel}` : '',
    entry.unitNumber ? `- 机位编号：${entry.unitNumber}` : '',
    `- 风机编号：${entry.turbineId}`,
  ]
    .filter(Boolean)
    .join('\n')
}

const TURBINE_FAULT_SUBJECT_PATTERN =
  /(故障|异常|错误|出错|问题|报警|告警|失效|损坏|丢失|断开|超限|过高|过低|不足|扭缆|纽缆|绕缆|润滑|温度|压力|振动|跳闸|偏航|变桨|传感器|风速仪|齿轮箱|发电机|轴承|主控|变流器|机舱|塔底|塔基|急停|刹车|制动|供电|维护|计数|模块|火灾|手动停机|Safety|按钮|停机)/i

export function hasFaultHandlingIntent(text: string): boolean {
  const normalized = String(text || '').trim()
  if (!normalized) return false
  if (/(故障码|故障代码|报码|告警码|报警码)/i.test(normalized)) return false
  return (
    /(存在|出现|发生|报了).{0,12}(故障|异常|报警|告警)/i.test(normalized) ||
    /(故障|异常|报警|告警).{0,24}(怎么处理|如何处理|怎么办|如何排查|处理步骤|什么原因)/i.test(normalized) ||
    /(怎么处理|如何处理|怎么办|如何排查|处理步骤)/i.test(normalized)
  ) && TURBINE_FAULT_SUBJECT_PATTERN.test(normalized)
}

export function expandTurbineTokensForExclusion(
  turbineId: string,
  site?: string,
): string[] {
  const tokens = new Set<string>()
  for (const candidate of buildTurbineIdCandidates(turbineId, site)) {
    const id = normalizeTurbineId(candidate.id)
    if (!id) continue
    tokens.add(id)
    if (id.endsWith('#')) {
      tokens.add(id.slice(0, -1))
      const numeric = id.slice(0, -1)
      if (/^\d+$/.test(numeric)) {
        tokens.add(numeric.padStart(2, '0'))
        tokens.add(numeric.padStart(3, '0'))
      }
    } else if (/^\d+$/.test(id)) {
      tokens.add(`${id}#`)
      tokens.add(id.padStart(2, '0'))
      tokens.add(`${id.padStart(2, '0')}#`)
    }
    const alphaNumeric = id.match(/^([A-Z]+)(\d+)#?$/u)
    if (alphaNumeric) {
      tokens.add(alphaNumeric[2] ?? '')
    }
  }
  return [...tokens].filter(Boolean)
}

export function resolveTurbineContextFromQuery(text: string): TurbineMappingEntry | null {
  const site = extractSiteFromText(text) ?? undefined
  for (const turbineId of extractTurbineIdsFromText(text)) {
    const entry = lookupTurbineMapping(turbineId, site)
    if (entry) return entry
  }
  return null
}

export function hasTurbineFaultSymptomSubject(text: string): boolean {
  const normalized = String(text || '').trim()
  if (!normalized) return false
  if (/(故障码|故障代码|报码|告警码|报警码)/i.test(normalized)) return false
  return TURBINE_FAULT_SUBJECT_PATTERN.test(normalized)
}

export function shouldAnswerTurbineMappingQuestion(text: string): boolean {
  const normalized = String(text || '').trim()
  if (!normalized) return false
  if (/(故障码|故障代码|报码|告警码|报警码)/i.test(normalized)) return false
  if (hasFaultHandlingIntent(normalized)) return false
  const ids = extractTurbineIdsFromText(normalized)
  if (ids.length > 0 && hasTurbineFaultSymptomSubject(normalized)) return false
  if (ids.length !== 1) return false
  const stripped = normalized
    .replace(new RegExp(escapeRegExp(ids[0] ?? ''), 'giu'), ' ')
    .replace(/\d{1,3}号/g, ' ')
    .replace(/(?:风机编号|风机号|机位号|机组编号|对应编号|标牌|编号)[:：]?/giu, ' ')
    .replace(/(是什么|是啥|什么|哪个|哪些|查询|查一下|查下|检索|属于|对应|机型|型号|风场|风电场|场站|风机|机组)/giu, ' ')
    .replace(/[？?，,。.、:：；;\s]/g, '')
    .trim()
  for (const site of KNOWN_SITES) {
    if (stripped.includes(normalizeSiteKey(site))) {
      return stripped.replace(normalizeSiteKey(site), '').length <= 2
    }
  }
  return stripped.length <= 2
}

function lookupTurbineCandidate(
  turbineId: string,
  site?: string,
): TurbineMappingEntry | null {
  const normalized = normalizeTurbineId(turbineId)
  if (!normalized) return null

  if (site) {
    const siteMatch = SITE_TURBINE_LOOKUP.get(`${normalizeSiteKey(site)}\u0000${normalized}`)
    if (siteMatch) return siteMatch
  }

  const globalMatches = GLOBAL_TURBINE_LOOKUP.get(normalized) ?? []
  if (globalMatches.length === 1) {
    const only = globalMatches[0] ?? null
    if (
      only &&
      site &&
      normalizeSiteKey(only.site) !== normalizeSiteKey(site)
    ) {
      return null
    }
    return only
  }
  if (globalMatches.length > 1 && site) {
    const siteKey = normalizeSiteKey(site)
    return globalMatches.find(entry => normalizeSiteKey(entry.site) === siteKey) ?? null
  }
  return globalMatches[0] ?? null
}

function buildTurbineIdCandidates(
  turbineId: string,
  site?: string,
): Array<{ id: string; site?: string }> {
  const normalized = normalizeTurbineId(turbineId)
  const candidates: Array<{ id: string; site?: string }> = [{ id: normalized, site }]
  if (!normalized) return candidates

  if (/^\d+$/.test(normalized)) {
    candidates.push({ id: `${normalized}#`, site })
    candidates.push({ id: normalized.padStart(2, '0') + '#', site })
    candidates.push({ id: normalized.padStart(3, '0'), site })
  }

  if (normalized.endsWith('#')) {
    candidates.push({ id: normalized.slice(0, -1), site })
  } else if (/^[A-Z]+\d+$/u.test(normalized)) {
    candidates.push({ id: `${normalized}#`, site })
  }

  if (site) {
    const siteKey = normalizeSiteKey(site)
    const numericText = normalized.endsWith('#') ? normalized.slice(0, -1) : normalized
    if (/^\d+$/.test(numericText)) {
      const numeric = Number.parseInt(numericText, 10)
      for (const entry of TURBINE_MAPPING_ENTRIES) {
        if (normalizeSiteKey(entry.site) !== siteKey) continue
        const unitNumber = normalizeTurbineId(entry.unitNumber)
        if (unitNumber && Number.parseInt(unitNumber, 10) === numeric) {
          candidates.push({ id: entry.turbineId, site })
        }
      }
    }
  }

  const seen = new Set<string>()
  return candidates.filter(candidate => {
    const key = `${candidate.site ?? ''}\u0000${candidate.id}`
    if (seen.has(key)) return false
    seen.add(key)
    return Boolean(candidate.id)
  })
}

function isLikelyTurbineLabel(value: string): boolean {
  return /^([A-Z]{1,4}\d{1,3}#?|\d{1,3}#)$/u.test(value)
}

function normalizeTurbineId(value: string): string {
  return String(value || '').trim().toUpperCase()
}

function normalizeSiteKey(value: string): string {
  return String(value || '')
    .trim()
    .replace(/风电场$/u, '')
    .toLowerCase()
    .replace(/[.\s_\-—–/\\()（）]/g, '')
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
