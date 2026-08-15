#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeTurbineId } from './turbine-id-utils.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const MAPPING_PATH = join(ROOT, 'src', 'data', 'turbineMapping.json')

const TURBINE_MAPPING_ENTRIES = loadEntries()
const SITE_TURBINE_LOOKUP = new Map()
const GLOBAL_TURBINE_LOOKUP = new Map()
const UNIT_TURBINE_LOOKUP = new Map()
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

  const unitNumber = normalizeTurbineId(entry.unitNumber)
  if (unitNumber) {
    pushUnitLookup(siteKey, unitNumber, entry)
    if (/^\d+$/.test(unitNumber)) {
      const bare = String(Number.parseInt(unitNumber, 10))
      if (bare !== unitNumber) {
        pushUnitLookup(siteKey, bare, entry)
      }
      const padded2 = unitNumber.padStart(2, '0')
      if (padded2 !== unitNumber) {
        pushUnitLookup(siteKey, padded2, entry)
      }
    }
  }
}

function pushUnitLookup(siteKey, unitNumber, entry) {
  const unitKey = `${siteKey}\u0000${unitNumber}`
  const unitMatches = UNIT_TURBINE_LOOKUP.get(unitKey) ?? []
  if (!unitMatches.includes(entry)) {
    unitMatches.push(entry)
  }
  UNIT_TURBINE_LOOKUP.set(unitKey, unitMatches)
}

function loadEntries() {
  try {
    const parsed = JSON.parse(readFileSync(MAPPING_PATH, 'utf8'))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export function extractSiteFromText(text) {
  const normalized = normalizeSiteKey(text)
  if (!normalized) return null
  let best = null
  for (const site of KNOWN_SITES) {
    const siteKey = normalizeSiteKey(site)
    if (!siteKey) continue
    if (
      normalized.includes(siteKey) &&
      (!best || siteKey.length > normalizeSiteKey(best).length)
    ) {
      best = site
    }
  }
  return best
}

export function extractTurbineIdsFromText(text) {
  const normalized = String(text || '').trim()
  if (!normalized) return []
  const found = new Set()

  for (const match of normalized.matchAll(
    /(?:风机编号|风机号|机位号|机组编号|对应编号|标牌|编号)[:：]?\s*([A-Za-z0-9#_-]+)/giu,
  )) {
    const id = normalizeTurbineId(match[1] ?? '')
    if (id) found.add(id)
  }

  for (const match of normalized.matchAll(
    /(?<![A-Za-z0-9])([A-Za-z]{1,4}\d{1,3}#?)(?![A-Za-z0-9])/giu,
  )) {
    const id = normalizeTurbineId(match[1] ?? '')
    if (id && (ALL_KNOWN_TURBINE_IDS.has(id) || isLikelyTurbineLabel(id))) {
      found.add(id)
    }
  }

  for (const match of normalized.matchAll(/(?<![A-Za-z0-9])(\d{1,3})#/giu)) {
    const id = normalizeTurbineId(`${match[1]}#`)
    if (ALL_KNOWN_TURBINE_IDS.has(id) || isLikelyTurbineLabel(id)) found.add(id)
  }

  for (const match of normalized.matchAll(/(?<![A-Za-z0-9])(\d{1,3})号(?![A-Za-z0-9])/giu)) {
    const numeric = match[1] ?? ''
    const hashId = normalizeTurbineId(`${numeric}#`)
    const plainId = normalizeTurbineId(numeric)
    if (ALL_KNOWN_TURBINE_IDS.has(hashId)) found.add(hashId)
    else if (ALL_KNOWN_TURBINE_IDS.has(plainId)) found.add(plainId)
    else found.add(hashId)
  }

  for (const id of ALL_KNOWN_TURBINE_IDS) {
    if (!id) continue
    // Bare IDs must not match the prefix of ID# (e.g. S01 inside S01#).
    const trailing = id.endsWith('#') ? '(?![A-Za-z0-9])' : '(?![A-Za-z0-9#])'
    if (new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(id)}${trailing}`, 'i').test(normalized)) {
      found.add(id)
    }
  }

  return dedupeTurbineIds([...found], normalized)
}

function dedupeTurbineIds(ids, text) {
  const upper = String(text || '').toUpperCase()
  const set = new Set(ids.map(id => normalizeTurbineId(id)).filter(Boolean))
  const result = []
  for (const id of set) {
    if (!id.endsWith('#')) {
      const hashId = `${id}#`
      if (set.has(hashId)) {
        // Prefer the form that actually appears in the query.
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

export function lookupTurbineMapping(turbineId, site) {
  for (const candidate of buildTurbineIdCandidates(turbineId, site)) {
    const match = lookupTurbineCandidate(candidate.id, candidate.site)
    if (match) return match
  }
  return null
}

export function shouldAnswerTurbineMappingQuestion(text) {
  const normalized = String(text || '').trim()
  if (!normalized) return false
  if (/(故障码|故障代码|报码|告警码|报警码)/i.test(normalized)) return false
  if (hasFaultHandlingIntent(normalized)) return false
  const ids = extractTurbineIdsFromText(normalized)
  if (ids.length === 0) return false
  if (hasTurbineFaultSymptomSubject(normalized)) return false
  if (ids.length !== 1) return false

  let stripped = normalized
    .replace(new RegExp(escapeRegExp(ids[0] ?? ''), 'giu'), ' ')
    .replace(/\d{1,3}号/g, ' ')
    .replace(/(?:风机编号|风机号|机位号|机组编号|对应编号|标牌|编号)[:：]?/giu, ' ')
    .replace(
      /(是什么|是啥|什么|哪个|哪些|查询|查一下|查下|检索|属于|对应|机型|型号|风场|风电场|场站|风机|机组)/giu,
      ' ',
    )
    .replace(/[？?，,。.、:：；;\s]/g, '')
    .trim()

  for (const site of KNOWN_SITES) {
    const siteKey = normalizeSiteKey(site)
    if (stripped.includes(siteKey)) {
      return stripped.replace(siteKey, '').length <= 2
    }
  }
  return stripped.length <= 2
}

export function renderTurbineMappingAnswer(entry) {
  return [
    `风机编号「${entry.turbineId}」对应 ${entry.siteFull} / ${entry.brand} / ${entry.model}${entry.standardModel ? ` / 具体型号：${entry.standardModel}` : ''}。`,
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

export function resolveTurbineMappingAnswer(text) {
  if (!shouldAnswerTurbineMappingQuestion(text)) return ''
  const site = extractSiteFromText(text) || ''
  for (const turbineId of extractTurbineIdsFromText(text)) {
    const entry = lookupTurbineMapping(turbineId, site)
    if (entry) return renderTurbineMappingAnswer(entry)
  }
  return ''
}

export function isKnownTurbineIdToken(token) {
  const id = normalizeTurbineId(token)
  if (!id) return false
  if (ALL_KNOWN_TURBINE_IDS.has(id)) return true
  if (ALL_KNOWN_TURBINE_IDS.has(`${id}#`)) return true
  if (id.endsWith('#') && ALL_KNOWN_TURBINE_IDS.has(id.slice(0, -1))) return true
  return false
}

function lookupTurbineCandidate(turbineId, site) {
  const normalized = normalizeTurbineId(turbineId)
  if (!normalized) return null

  if (site) {
    const siteKey = normalizeSiteKey(site)
    const siteMatch = SITE_TURBINE_LOOKUP.get(`${siteKey}\u0000${normalized}`)
    if (siteMatch) return siteMatch

    const unitMatches = UNIT_TURBINE_LOOKUP.get(`${siteKey}\u0000${normalized}`) || []
    if (unitMatches.length > 0) return unitMatches[0]
  }

  const globalMatches = GLOBAL_TURBINE_LOOKUP.get(normalized) ?? []
  if (globalMatches.length === 1) {
    const only = globalMatches[0]
    if (only && site && normalizeSiteKey(only.site) !== normalizeSiteKey(site)) {
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

function buildTurbineIdCandidates(turbineId, site) {
  const normalized = normalizeTurbineId(turbineId)
  const candidates = [{ id: normalized, site }]
  if (!normalized) return candidates

  if (/^\d+$/.test(normalized)) {
    candidates.push({ id: `${normalized}#`, site })
    candidates.push({ id: normalized.padStart(2, '0'), site })
    candidates.push({ id: `${normalized.padStart(2, '0')}#`, site })
  }

  if (normalized.endsWith('#')) {
    candidates.push({ id: normalized.slice(0, -1), site })
  } else if (/^[A-Z]+\d+$/u.test(normalized)) {
    candidates.push({ id: `${normalized}#`, site })
  }

  const seen = new Set()
  return candidates.filter(candidate => {
    const key = `${candidate.site ?? ''}\u0000${candidate.id}`
    if (seen.has(key) || !candidate.id) return false
    seen.add(key)
    return true
  })
}

function hasFaultHandlingIntent(text) {
  const normalized = String(text || '').trim()
  if (!normalized) return false
  if (/(故障码|故障代码|报码|告警码|报警码)/i.test(normalized)) return false
  return (
    (/(存在|出现|发生|报了).{0,12}(故障|异常|报警|告警)/i.test(normalized) ||
      /(故障|异常|报警|告警).{0,24}(怎么处理|如何处理|怎么办|如何排查|处理步骤|什么原因)/i.test(
        normalized,
      ) ||
      /(怎么处理|如何处理|怎么办|如何排查|处理步骤)/i.test(normalized)) &&
    /(故障|异常|报警|告警|停机|超限|过高|过低|不足|扭缆|纽缆|绕缆|润滑|温度|压力|振动|跳闸|偏航|变桨|传感器|风速仪|齿轮箱|发电机|轴承|主控|变流器|机舱|急停|刹车|制动)/i.test(
      normalized,
    )
  )
}

function hasTurbineFaultSymptomSubject(text) {
  const normalized = String(text || '').trim()
  if (!normalized) return false
  if (/(故障码|故障代码|报码|告警码|报警码)/i.test(normalized)) return false
  return /(故障|异常|错误|问题|报警|告警|失效|损坏|丢失|断开|超限|过高|过低|不足|扭缆|纽缆|绕缆|润滑|温度|压力|振动|跳闸|偏航|变桨|传感器|风速仪|齿轮箱|发电机|轴承|主控|变流器|机舱|急停|刹车|制动)/i.test(
    normalized,
  )
}

function isLikelyTurbineLabel(value) {
  return /^([A-Z]{1,4}\d{1,3}#?|\d{1,3}#)$/u.test(value)
}

function normalizeSiteKey(value) {
  return String(value || '')
    .trim()
    .replace(/风电场$/u, '')
    .toLowerCase()
    .replace(/[.\s_\-—–/\\()（）]/g, '')
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
