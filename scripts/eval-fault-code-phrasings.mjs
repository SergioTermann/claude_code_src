#!/usr/bin/env node

import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const root = fileURLToPath(new URL('..', import.meta.url))
const runner = join(root, 'scripts', 'run-lmstudio-claude.mjs')

function norm(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[（）()]/g, '')
    .replace(/[_.\-/]+/g, '')
}

async function ask(query) {
  const { stdout } = await execFileAsync(
    process.execPath,
    [runner, '--print', '--bare', `/llmwiki ask ${query} --limit 8`],
    {
      cwd: root,
      env: {
        ...process.env,
        LLMWIKI_PROJECT: join(root, '风机故障码'),
      },
      maxBuffer: 20 * 1024 * 1024,
      timeout: 120_000,
    },
  )
  return stdout.trim()
}

function hasCode(answer, code) {
  return norm(answer).includes(norm(code))
}

function hasCodes(answer, codes) {
  return codes.every(code => hasCode(answer, code))
}

function hasText(answer, text) {
  if (!text) return true
  return norm(answer).includes(norm(text))
}

function isNoMatch(answer) {
  return /^No matches/i.test(answer)
}

const cases = [
  // 纯数字长码
  { group: '长数字码', query: '303804', expectCode: '303804', expectText: '24V主电源开关故障' },
  { group: '长数字码', query: '故障码303804', expectCode: '303804', expectText: '24V主电源开关故障' },
  { group: '长数字码', query: '303804是什么故障', expectCode: '303804', expectText: '24V主电源开关故障' },
  { group: '长数字码', query: '303804怎么处理', expectCode: '303804', expectText: '24V主电源开关故障' },
  { group: '长数字码', query: '303804什么原因', expectCode: '303804', expectText: '24V主电源开关故障' },
  { group: '长数字码', query: '报303804怎么办', expectCode: '303804', expectText: '24V主电源开关故障' },
  { group: '长数字码', query: '帮我查一下303804', expectCode: '303804', expectText: '24V主电源开关故障' },
  { group: '长数字码', query: '华仪303804', expectCode: '303804', expectText: '24V主电源开关故障' },

  // 短码歧义
  { group: '短码歧义', query: '320', expectCode: '320', expectText: '不同含义' },
  { group: '短码歧义', query: '320是什么故障', expectCode: '320', expectText: '不同含义' },
  { group: '短码歧义', query: '故障码320', expectCode: '320', expectText: '不同含义' },
  { group: '短码歧义', query: '三一 320', expectCode: '320', expectText: '主轴超速开关断开', rejectText: '变频器检测到故障(EMS)' },
  { group: '短码歧义', query: '320怎么处理', expectCode: '320', expectText: '不同含义' },
  { group: '短码歧义', query: '504', expectCode: '504', expectText: '不同含义' },
  { group: '短码歧义', query: '504哪些风场有', expectCode: '504', expectText: '风场' },
  { group: '短码歧义', query: '200', expectCode: '200', expectText: '不同含义' },
  { group: '短码歧义', query: '故障码200本来应该出来3个不同的风场的结果', expectCode: '200', expectText: '不同含义', rejectText: '3：' },

  // SC 下划线
  { group: 'SC下划线', query: 'SC04_05_028', expectCode: 'SC04_05_028', expectText: '齿轮箱高速轴' },
  { group: 'SC下划线', query: 'SC04_05_028是什么故障', expectCode: 'SC04_05_028', expectText: '齿轮箱高速轴' },
  { group: 'SC下划线', query: '故障码 SC04_05_028', expectCode: 'SC04_05_028', expectText: '齿轮箱高速轴' },
  { group: 'SC下划线', query: 'SC0405 028', expectCode: 'SC04_05_028', expectText: '齿轮箱高速轴' },
  { group: 'SC下划线', query: 'SC0103031', expectCode: 'SC01_03_031', expectText: '' },
  { group: 'SC下划线', query: '什花道 SC04_05_028', expectCode: 'SC04_05_028', expectText: '什花道' },
  { group: 'SC下划线', query: 'SC04_05_028怎么处理', expectCode: 'SC04_05_028', expectText: '齿轮箱' },

  // SM 长码
  { group: 'SM模块码', query: 'SM290012', expectCode: 'SM290012', expectText: '变桨齿轮润滑' },
  { group: 'SM模块码', query: 'SM290012是什么', expectCode: 'SM290012', expectText: '变桨齿轮润滑' },
  { group: 'SM模块码', query: '故障码SM290012', expectCode: 'SM290012', expectText: '变桨齿轮润滑' },
  { group: 'SM模块码', query: 'SM900801怎么处理', expectCode: 'SM900801', expectText: 'X20IF1061' },

  // 名称反查
  { group: '名称反查', query: '风速仪故障的故障码是什么', expectCode: '5307', expectText: '风速仪故障', alsoCode: '170010' },
  { group: '名称反查', query: '齿轮箱温度高有哪些故障码', expectText: '117', expectTextInConclusion: '齿轮箱温度高' },
  { group: '名称反查', query: '风速仪故障有什么故障码', expectText: '风速仪故障', expectTextInConclusion: '风速仪故障' },
  { group: '名称反查', query: '偏航电机反馈故障对应哪些故障码', expectCode: '706', expectText: '偏航' },

  // 维度过滤
  { group: '维度约束', query: '320 金风', expectCode: '320', expectText: '未找到与', rejectText: '主轴超速开关断开' },
  { group: '维度约束', query: '709 洮北', expectCode: '709', expectText: '纽缆' },

  // 负例
  { group: '负例', query: '538', expectNoMatch: true },
  { group: '负例', query: '999999', expectNoMatch: true },
  { group: '负例', query: 'SC01_03', expectNoMatch: true },
  { group: '负例', query: '随便乱写不存在的超级电容爆炸故障码是什么', expectNoMatch: true },

  // 口语/场景化
  { group: '口语化', query: '请问504这个码啥意思', expectCode: '504', expectText: '轴承温度' },
  { group: '口语化', query: '现场HMI报了709，帮我看看', expectCode: '709', expectText: '扭缆' },
  { group: '口语化', query: '变流器CANopen通讯故障是什么故障码', expectCode: '1023', expectText: 'CANopen' },
  { group: '口语化', query: '查一下三一320什么原因', expectCode: '320', expectText: '主轴超速' },
  { group: '口语化', query: '303804 复位条件', expectCode: '303804', expectText: '24V' },
  { group: '口语化', query: 'SC02_05_028 哪些风场有', expectCode: 'SC02_05_028', expectText: '风场' },

  // 现场口语 - 弹窗/报警
  { group: '现场口语', query: '主控弹了个709', expectCode: '709', expectText: '扭缆' },
  { group: '现场口语', query: 'HMI报了504', expectCode: '504', expectText: '轴承' },
  { group: '现场口语', query: '屏幕上显示320', expectCode: '320', expectText: '不同含义' },
  { group: '现场口语', query: '刚跳出来303804', expectCode: '303804', expectText: '24V' },
  { group: '现场口语', query: '风机报了个320咋整', expectCode: '320', expectText: '不同含义' },
  { group: '现场口语', query: 'SCADA上出了709', expectCode: '709', expectText: '扭缆' },
  { group: '现场口语', query: '这个709咋回事', expectCode: '709', expectText: '扭缆' },
  { group: '现场口语', query: '504是啥情况', expectCode: '504', expectText: '轴承' },
  { group: '现场口语', query: '麻烦帮看下320什么原因', expectCode: '320', expectText: '不同含义' },
  { group: '现场口语', query: 'HMI上SC0405 028啥意思', expectCode: 'SC04_05_028', expectText: '齿轮箱' },
  { group: '现场口语', query: '主控里SC04_05_028是什么意思', expectCode: 'SC04_05_028', expectText: '齿轮箱' },
  { group: '现场口语', query: 'SM290012这个码咋处理', expectCode: 'SM290012', expectText: '变桨' },
  { group: '现场口语', query: '刚才报303804是什么鬼', expectCode: '303804', expectText: '24V' },
  { group: '现场口语', query: '集控看到709了帮忙查下', expectCode: '709', expectText: '扭缆' },
  { group: '现场口语', query: '320这个故障码在三一机型上什么意思', expectCode: '320', expectText: '主轴超速', rejectText: '变频器检测到故障(EMS)' },
  { group: '现场口语', query: '504能不能远程复位', expectCode: '504', expectText: '轴承' },
  { group: '现场口语', query: '303804咋复位', expectCode: '303804', expectText: '24V' },
  { group: '现场口语', query: '709接下来怎么处理', expectCode: '709', expectText: '扭缆' },
  { group: '现场口语', query: '机组跳闸报504', expectCode: '504', expectText: '轴承' },
  { group: '现场口语', query: '界面弹出709了', expectCode: '709', expectText: '扭缆' },
  { group: '现场口语', query: '变流器报了1023', expectCode: '1023', expectText: 'CANopen' },
  { group: '现场口语', query: '504这个咋整啊', expectCode: '504', expectText: '轴承' },
  { group: '现场口语', query: '709啥意思啊', expectCode: '709', expectText: '扭缆' },
  { group: '现场口语', query: '303804咋回事', expectCode: '303804', expectText: '24V' },
  { group: '现场口语', query: 'SC04_05_028咋处理', expectCode: 'SC04_05_028', expectText: '齿轮箱' },
  { group: '现场口语', query: 'SM900801这个码啥情况', expectCode: 'SM900801', expectText: 'X20IF1061' },
  { group: '现场口语', query: '帮忙查下709', expectCode: '709', expectText: '扭缆' },
  { group: '现场口语', query: '帮忙看看504', expectCode: '504', expectText: '轴承' },
  { group: '现场口语', query: '风机报了709怎么办', expectCode: '709', expectText: '扭缆' },
  { group: '现场口语', query: '主控界面显示504', expectCode: '504', expectText: '轴承' },
  { group: '现场口语', query: '刚刚弹出来303804', expectCode: '303804', expectText: '24V' },
  { group: '现场口语', query: '320在三一上啥意思', expectCode: '320', expectText: '主轴超速', rejectText: '变频器检测到故障(EMS)' },
  { group: '现场口语', query: '504复位条件是什么', expectCode: '504', expectText: '轴承' },
  { group: '现场口语', query: '709为啥会报', expectCode: '709', expectText: '扭缆' },
  { group: '现场口语', query: '303804什么原因', expectCode: '303804', expectText: '24V' },
  { group: '现场口语', query: 'SC0405 028咋回事', expectCode: 'SC04_05_028', expectText: '齿轮箱' },
  { group: '现场口语', query: '齿轮箱温度高了会报哪些码', expectText: '117', expectTextInConclusion: '齿轮箱温度' },

  // 口语负例
  { group: '口语负例', query: '538.2V电压正常吗', expectNoMatch: true },
  { group: '口语负例', query: '主控版本是3.0MW', expectNoMatch: true },
  { group: '口语负例', query: '风速仪坏了报啥码', expectText: '风速仪', alsoCode: '5307' },

  // 超口语 / 语音转写 / 省略
  { group: '超口语', query: '哥 709 啥情况', expectCode: '709', expectText: '扭缆' },
  { group: '超口语', query: '504又报了咋弄', expectCode: '504', expectText: '轴承' },
  { group: '超口语', query: '303804 这玩意儿咋整', expectCode: '303804', expectText: '24V' },
  { group: '超口语', query: '320 三一 啥故障', expectCode: '320', expectText: '主轴超速', rejectText: '变频器检测到故障(EMS)' },
  { group: '超口语', query: '709?', expectCode: '709', expectText: '扭缆' },
  { group: '超口语', query: '504…又弹了', expectCode: '504', expectText: '轴承' },
  { group: '超口语', query: 'code 709 啥意思', expectCode: '709', expectText: '扭缆' },
  { group: '超口语', query: 'fault code 303804', expectCode: '303804', expectText: '24V' },
  { group: '超口语', query: 'HMI 上 SC04 05 028', expectCode: 'SC04_05_028', expectText: '齿轮箱' },
  { group: '超口语', query: 'sc0405 028 啥情况', expectCode: 'SC04_05_028', expectText: '齿轮箱' },
  { group: '超口语', query: 'SM290012 咋弄啊', expectCode: 'SM290012', expectText: '变桨' },
  { group: '超口语', query: '偏航电机反馈故障 报啥', expectCode: '706', expectText: '偏航' },
  { group: '超口语', query: '扭缆了 报啥码', expectCode: '709', expectText: '扭缆' },
  { group: '超口语', query: '齿轮箱温度高 会出啥码', expectText: '117', expectTextInConclusion: '齿轮箱温度' },
  { group: '超口语', query: '现场说504 轴承温度高 查下', expectCode: '504', expectText: '轴承' },
  { group: '超口语', query: '集控那边709亮了', expectCode: '709', expectText: '扭缆' },
  { group: '超口语', query: '机组停了一看320', expectCode: '320', expectText: '不同含义' },
  { group: '超口语', query: '303804 能复位不', expectCode: '303804', expectText: '24V' },
  { group: '超口语', query: '504 远程能复位吗', expectCode: '504', expectText: '轴承' },
  { group: '超口语', query: '1023 CANopen 啥故障', expectCode: '1023', expectText: 'CANopen' },
  { group: '超口语', query: '三一320 主轴超速 对不对', expectCode: '320', expectText: '主轴超速', rejectText: '变频器检测到故障(EMS)' },
  { group: '超口语', query: '啥情况啊504', expectCode: '504', expectText: '轴承' },
  { group: '超口语', query: '709 这个 又出来了', expectCode: '709', expectText: '扭缆' },
  { group: '超口语', query: '麻烦查 SC04_05_028', expectCode: 'SC04_05_028', expectText: '齿轮箱' },
  { group: '超口语', query: '报马303804', expectCode: '303804', expectText: '24V' },
  { group: '超口语', query: '告警了504看一下', expectCode: '504', expectText: '轴承' },
  { group: '超口语', query: '320码 三一', expectCode: '320', expectText: '主轴超速', rejectText: '变频器检测到故障(EMS)' },
  { group: '超口语', query: '709 扭缆 对吧', expectCode: '709', expectText: '扭缆' },
  { group: '超口语', query: 'SM900801 模块故障 咋查', expectCode: 'SM900801', expectText: 'X20IF1061' },
  { group: '超口语', query: '啥码 风速仪', expectText: '风速仪', alsoCode: '5307' },

  // 超口语负例
  { group: '超口语负例', query: '今天风速多大', expectNoMatch: true },
  { group: '超口语负例', query: '3.0兆瓦机组有几个', expectNoMatch: true },
  { group: '超口语负例', query: '主控程序版本号多少', expectNoMatch: true },

  // 多码同问
  { group: '多码同问', query: '504 和 709 啥意思', expectCodes: ['504', '709'], expectText: '扭缆' },
  { group: '多码同问', query: '320跟504都报了', expectCodes: ['320', '504'] },
  { group: '多码同问', query: '303804、709 一起弹了 咋整', expectCodes: ['303804', '709'] },
  { group: '多码同问', query: '帮忙查下504和709', expectCodes: ['504', '709'] },
  { group: '多码同问', query: '504跟709都啥情况', expectCodes: ['504', '709'] },

  // 方言/错字/语音
  { group: '方言错字', query: '报吗504又出来了', expectCode: '504', expectText: '轴承' },
  { group: '方言错字', query: '303804 整不明白', expectCode: '303804', expectText: '24V' },
  { group: '方言错字', query: '709 咋弄啊', expectCode: '709', expectText: '扭缆' },
  { group: '方言错字', query: '504 整啥呢', expectCode: '504', expectText: '轴承' },
  { group: '方言错字', query: 'SC 零四 零五 零二八 啥意思', expectCode: 'SC04_05_028', expectText: '齿轮箱' },
  { group: '方言错字', query: 'sc零四零五零二八', expectCode: 'SC04_05_028', expectText: '齿轮箱' },
  { group: '方言错字', query: '报嘛709看一下', expectCode: '709', expectText: '扭缆' },
  { group: '方言错字', query: '320 码 504 码 都啥意思', expectCodes: ['320', '504'] },
  { group: '方言错字', query: '偏航反馈故障 会出啥码', expectCode: '706', expectText: '偏航' },
  { group: '方言错字', query: '超级电容 报啥', expectText: '超级电容' },

  // 方言负例
  { group: '方言负例', query: '今天几号', expectNoMatch: true },
  { group: '方言负例', query: '谁值班', expectNoMatch: true },

  // 三码及以上
  { group: '三码同问', query: '504、709、303804 都啥意思', expectCodes: ['504', '709', '303804'] },
  { group: '三码同问', query: '320 504 709 一起报了', expectCodes: ['320', '504', '709'] },
  { group: '三码同问', query: '帮忙查504和709还有303804', expectCodes: ['504', '709', '303804'] },
  { group: '三码同问', query: '504 709 303804 帮看看', expectCodes: ['504', '709', '303804'] },

  // 机型/风场 + 多码
  { group: '三码同问', query: '三一那个320和504都报了', expectCodes: ['320', '504'], expectText: '主轴超速', rejectText: '变频器检测到故障(EMS)' },
  { group: '三码同问', query: '洮北709跟504啥情况', expectCodes: ['709', '504'], expectText: '纽缆' },

  // 中文数字短码
  { group: '中文数字码', query: '七零九啥意思', expectCode: '709', expectText: '扭缆' },
  { group: '中文数字码', query: '五零四又报了', expectCode: '504', expectText: '轴承' },
  { group: '中文数字码', query: '三零三八零四咋整', expectCode: '303804', expectText: '24V' },
  { group: '中文数字码', query: 'SM二九零零一二咋弄', expectCode: 'SM290012', expectText: '变桨' },

  // 更野口语
  { group: '更野口语', query: '一块儿弹了504和709', expectCodes: ['504', '709'] },
  { group: '更野口语', query: '整不会了303804', expectCode: '303804', expectText: '24V' },
  { group: '更野口语', query: '504跟709一块儿弹的', expectCodes: ['504', '709'] },
  { group: '更野口语', query: '那个320还有504都啥情况', expectCodes: ['320', '504'] },
  { group: '更野口语', query: '七零九跟五零四同时报了', expectCodes: ['709', '504'] },

  // 更野负例
  { group: '更野负例', query: '三一重工股票多少钱', expectNoMatch: true },
  { group: '更野负例', query: '三个小伙子来了', expectNoMatch: true },

  // 故障描述反查（无需说「故障码是什么」）
  { group: '故障描述反查', query: '扭缆', expectCode: '709', expectText: '扭缆', alsoCode: '708', expectTextInConclusion: '按故障描述' },
  { group: '故障描述反查', query: '偏航电机反馈异常', expectCode: '706', alsoCode: '721', expectTextInConclusion: '偏航电机反馈异常' },
  { group: '故障描述反查', query: '变桨润滑不足', expectCode: '3021', alsoCode: '3018', expectTextInConclusion: '变桨润滑不足', rejectText: '50刹车失败' },
  { group: '故障描述反查', query: '齿轮箱温度高', expectCode: '117', expectTextInConclusion: '齿轮箱温度高' },
  { group: '故障描述反查', query: 'CANopen通讯故障', expectCode: '1023', expectText: 'CANopen', expectTextInConclusion: 'CANopen' },
  { group: '故障描述反查', query: '发电机轴承温度高', expectTextInConclusion: '发电机轴承温度高' },
]

let passed = 0
let failed = 0
const failures = []
const byGroup = {}

console.log(`多种问法测试：${cases.length} 条\n`)

for (const testCase of cases) {
  const answer = await ask(testCase.query)
  const reasons = []

  if (testCase.expectNoMatch) {
    if (!isNoMatch(answer)) reasons.push('应无匹配但有结果')
  } else {
    if (isNoMatch(answer)) reasons.push('返回 No matches')
    if (testCase.expectCode && !hasCode(answer, testCase.expectCode)) {
      reasons.push(`缺少码 ${testCase.expectCode}`)
    }
    if (testCase.expectCodes && !hasCodes(answer, testCase.expectCodes)) {
      reasons.push(`缺少码 ${testCase.expectCodes.filter(code => !hasCode(answer, code)).join('、')}`)
    }
    if (testCase.alsoCode && !hasCode(answer, testCase.alsoCode)) {
      reasons.push(`缺少码 ${testCase.alsoCode}`)
    }
    if (testCase.expectText && !hasText(answer, testCase.expectText)) {
      reasons.push(`缺少文本「${testCase.expectText}」`)
    }
  }
  if (testCase.expectTextInConclusion) {
    const conclusion = (answer.match(/\*\*结论：\*\*[^\n]+/) || [])[0] || ''
    if (!hasText(conclusion, testCase.expectTextInConclusion)) {
      reasons.push(`结论缺少「${testCase.expectTextInConclusion}」`)
    }
  }
  if (testCase.rejectText && hasText(answer, testCase.rejectText)) {
    reasons.push(`不应出现「${testCase.rejectText}」`)
  }

  const ok = reasons.length === 0
  byGroup[testCase.group] = byGroup[testCase.group] || { passed: 0, failed: 0 }
  if (ok) {
    passed += 1
    byGroup[testCase.group].passed += 1
    process.stdout.write('.')
  } else {
    failed += 1
    byGroup[testCase.group].failed += 1
    failures.push({ ...testCase, reasons, preview: answer.split('\n').slice(0, 3).join(' | ') })
    process.stdout.write('F')
  }
}

console.log('\n\n========== 问法测试汇总 ==========')
console.log(`通过: ${passed}/${cases.length}`)
console.log(`失败: ${failed}/${cases.length}`)
console.log('\n按分组:')
for (const [group, stats] of Object.entries(byGroup)) {
  console.log(`  ${group}: ${stats.passed}/${stats.passed + stats.failed}`)
}

if (failures.length) {
  console.log('\n--- 失败明细 ---')
  for (const f of failures) {
    console.log(`\n[${f.group}] ${f.query}`)
    console.log(`  原因: ${f.reasons.join('；')}`)
    console.log(`  回答: ${f.preview}`)
  }
  process.exit(1)
}

console.log('\n全部问法测试通过。')
