import windFarmModelsData from '../data/windFarmModels.json'

export type WindFarmModelEntry = {
  site: string
  aliases?: string[]
  models: string[]
}

export type WindFarmModelLookup = {
  kind: 'all' | 'site' | 'model'
  entries: WindFarmModelEntry[]
}

const WIND_FARM_MODEL_ENTRIES =
  windFarmModelsData as WindFarmModelEntry[]

export function shouldAnswerWindFarmModelQuestion(text: string): boolean {
  const normalized = normalizeWindFarmModelText(text)
  if (!normalized) return false

  const hasMappingIntent =
    /(风场|风电场|机型|型号|风机|品牌|对应|匹配|属于|哪个|哪些|什么|查询|查一下|列出|清单|关系)/i.test(
      text,
    )
  if (!hasMappingIntent) return false

  return (
    /(风场|风电场).*(机型|型号|风机|品牌|对应|关系)|(机型|型号|风机|品牌).*(风场|风电场|对应|属于|哪个|哪些)/i.test(
      text,
    ) ||
    WIND_FARM_MODEL_ENTRIES.some(entry =>
      entrySearchValues(entry).some(value =>
        normalized.includes(normalizeWindFarmModelText(value)),
      ),
    )
  )
}

export function lookupWindFarmModels(text: string): WindFarmModelLookup | null {
  const normalized = normalizeWindFarmModelText(text)
  if (!normalized) return null

  if (/(全部|所有|清单|列表|对应关系|关系表|有哪些风场|风场有哪些)/.test(text)) {
    return { kind: 'all', entries: WIND_FARM_MODEL_ENTRIES }
  }

  const siteMatches = WIND_FARM_MODEL_ENTRIES.filter(entry =>
    siteSearchValues(entry).some(value => {
      const normalizedValue = normalizeWindFarmModelText(value)
      return (
        normalizedValue.length >= 2 &&
        (normalized.includes(normalizedValue) ||
          normalized.includes(normalizedValue.replace(/风电场$/u, '')))
      )
    }),
  )
  if (siteMatches.length > 0) {
    return { kind: 'site', entries: sortSpecificMatches(siteMatches) }
  }

  const modelMatches = WIND_FARM_MODEL_ENTRIES.filter(entry =>
    modelSearchValues(entry).some(model => {
      const normalizedModel = normalizeWindFarmModelText(model)
      return normalizedModel.length >= 3 && normalized.includes(normalizedModel)
    }),
  )
  if (modelMatches.length > 0) {
    return { kind: 'model', entries: sortSpecificMatches(modelMatches) }
  }

  return null
}

export function renderWindFarmModelAnswer(lookup: WindFarmModelLookup): string {
  if (lookup.entries.length === 0) {
    return '没有在内置风场机型表中找到匹配项。'
  }

  const title =
    lookup.kind === 'all'
      ? '内置风场与风机型号对应关系：'
      : lookup.kind === 'model'
        ? '该机型对应的风场如下：'
        : '查询结果：'

  return [
    title,
    ...lookup.entries.map(entry => `- ${entry.site}：${entry.models.join('、')}`),
  ].join('\n')
}

export function createWindFarmModelContext(text: string): string | undefined {
  const lookup = lookupWindFarmModels(text)
  if (!lookup) return undefined
  return [
    '<风场机型映射>',
    '下面是系统内置的风场与风机型号对应关系。回答必须严格基于这些条目，不要用模型常识补充。',
    renderWindFarmModelAnswer(lookup),
    '</风场机型映射>',
  ].join('\n')
}

function sortSpecificMatches(entries: WindFarmModelEntry[]): WindFarmModelEntry[] {
  return [...entries].sort(
    (a, b) =>
      longestSearchValue(b).length - longestSearchValue(a).length ||
      a.site.localeCompare(b.site, 'zh-Hans-CN'),
  )
}

function longestSearchValue(entry: WindFarmModelEntry): string {
  return entrySearchValues(entry).sort((a, b) => b.length - a.length)[0] ?? ''
}

function entrySearchValues(entry: WindFarmModelEntry): string[] {
  return [...siteSearchValues(entry), ...modelSearchValues(entry)]
}

function siteSearchValues(entry: WindFarmModelEntry): string[] {
  return [entry.site, ...(entry.aliases ?? [])]
}

function modelSearchValues(entry: WindFarmModelEntry): string[] {
  return [
    ...entry.models,
    ...entry.models.map(model => model.replace(/^\S+\s+/, '')),
  ].filter(Boolean)
}

function normalizeWindFarmModelText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[（）]/g, match => (match === '（' ? '(' : ')'))
    .replace(/[.\s_\-—–/\\()（）]/g, '')
    .replace(/风力发电场/g, '风电场')
    .trim()
}
