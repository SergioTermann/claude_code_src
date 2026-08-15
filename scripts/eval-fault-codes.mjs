#!/usr/bin/env node

import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const root = fileURLToPath(new URL('..', import.meta.url))
const runner = join(root, 'scripts', 'run-lmstudio-claude.mjs')

const cases = [
  {
    name: 'structured fault index exists',
    command: '/llmwiki read fault-index-summary.json',
    expects: ['"recordCount"', '"byBrand"', '"华仪"'],
  },
  {
    name: 'structured exact code answer',
    command: '/llmwiki ask 303804 --limit 2',
    expects: ['本地答案：303804', '24V主电源开关故障', '来源：'],
  },
  {
    name: 'short exact code 200 resolves by fault-code field',
    command: '/llmwiki ask 200 --limit 4',
    expects: ['本地答案：200', '不同含义', '200：'],
    rejects: ['20007'],
  },
  {
    name: 'fault-code 200 ignores ordinary count words in query',
    command: '/llmwiki ask 故障码200本来应该出来3个不同的风场的结果 --limit 4',
    expects: ['本地答案：故障码200', '命中 5 条记录', '覆盖 6 组风场/机型', '不同含义', '风场/机型：', '同发', '镇赉', '洮北'],
    rejects: ['结论：200 为「预留」', '3：'],
  },
  {
    name: 'fault-name reverse lookup returns all matching fault codes',
    command: '/llmwiki ask 风速仪故障的故障码是什么 --limit 4',
    expects: ['按名称/描述「风速仪故障」', '涉及', '170010：风速仪故障', '5307：风速仪故障', '风场/机型：'],
    rejects: ['没有找到与当前描述精确匹配', '5308：机组冰冻告警', '6504：风轮锁紧'],
  },
  {
    name: 'lookup query strips 有哪些故障码 without leaving 有',
    command: '/llmwiki ask 齿轮箱温度高有哪些故障码 --limit 4',
    expects: ['按名称/描述「齿轮箱温度高」', '涉及', '117：', '齿轮箱'],
    rejects: ['按名称/描述「齿轮箱温度高有」', '按名称/描述「齿轮箱温度高有故障码」'],
  },
  {
    name: 'lookup query strips 有哪些故障码 on search path',
    command: '/llmwiki search 齿轮箱温度高有哪些故障码 --limit 4',
    expects: ['按名称/描述「齿轮箱温度高」', '117：'],
    rejects: ['按名称/描述「齿轮箱温度高有」'],
  },
  {
    name: 'lookup query strips 有什么故障码 without leaving 有',
    command: '/llmwiki ask 风速仪故障有什么故障码 --limit 6',
    expects: ['按名称/描述「风速仪故障」', '涉及', '风速仪故障'],
    rejects: ['按名称/描述「风速仪故障有」'],
  },
  {
    name: 'short ask 320 reports ambiguity without suffix-code pollution',
    command: '/llmwiki ask 320 --limit 8',
    expects: ['不同含义', '变频器检测到故障(EMS)', '主轴超速开关断开', 'WP2035(R)过速'],
    rejects: ['5320：', 'T_320：'],
  },
  {
    name: 'brand-qualified short code filters to current brand',
    command: '/llmwiki ask 三一 320 --limit 4',
    expects: ['故障码 320 为「主轴超速开关断开」', '三一', '裕民', '新华'],
    rejects: ['变频器检测到故障(EMS)', 'WP2035(R)过速'],
  },
  {
    name: 'brand-qualified short code search matches ask',
    command: '/llmwiki search 三一 320 --limit 4',
    expects: ['故障码 320 为「主轴超速开关断开」', '三一'],
    rejects: ['变频器检测到故障(EMS)', 'WP2035(R)过速'],
  },
  {
    name: 'short exact code 320 outranks contextual cabinet text',
    command: '/llmwiki search 320 --limit 3',
    expects: ['不同含义', '主轴超速开关断开'],
    rejects: ['320柜风扇接触器输出与反馈不一致'],
  },
  {
    name: 'short exact code 504 groups all current meanings',
    command: '/llmwiki ask 504 --limit 4',
    expects: ['归并为 3 类不同含义', '504：发电机驱动端(DE)轴承温度高报警重复故障', '风场：四平', '风场：新华', '风场：团结'],
    rejects: ['6504：', '5043：', '5044：', '5047：', '5048：'],
  },
  {
    name: 'short exact code 504 search matches ask grouping',
    command: '/llmwiki search 504 --limit 4',
    expects: ['归并为 3 类不同含义', '504：发电机驱动端(DE)轴承温度高报警重复故障'],
    rejects: ['6504：', '5043：'],
  },
  {
    name: 'bare code 538 does not match threshold voltage text',
    command: '/llmwiki ask 538 --limit 8',
    expects: ['No matches for "538"'],
    rejects: ['3242：', '538.2V', '变流器电网电压跌落超限'],
  },
  {
    name: 'unknown bare code does not fall back to fuzzy body text',
    command: '/llmwiki ask 999999 --limit 8',
    expects: ['No matches for "999999"'],
    rejects: ['SM030939', '变流器反馈保留99故障', '风场：', '品牌：', '机型：'],
  },
  {
    name: 'dimension mismatch returns explicit no-match for qualified code',
    command: '/llmwiki ask 320 金风 --limit 4',
    expects: ['未找到与', '匹配的记录', '320'],
    rejects: ['主轴超速开关断开', '变频器检测到故障(EMS)'],
  },
  {
    name: 'explicit leading fault code label query',
    command: '/llmwiki ask 故障码320 --limit 4',
    expects: ['故障码 320', '不同含义'],
    rejects: ['320柜'],
  },
  {
    name: 'long numeric code exact match',
    command: '/llmwiki ask 303804 --limit 2',
    expects: ['303804', '24V主电源开关故障'],
    rejects: ['不同含义'],
  },
  {
    name: 'long numeric code search',
    command: '/llmwiki search 303804 --limit 2',
    expects: ['303804', '24V主电源开关故障'],
  },
  {
    name: 'descriptive query reranks 303804 first',
    command: '/llmwiki search 变桨24V开关 --limit 1',
    expects: ['303804', '24V主电源开关故障'],
  },
  {
    name: 'multi-term yaw motor query',
    command: '/llmwiki search 偏航 电机 --limit 1',
    expects: ['偏航', '电机'],
  },
  {
    name: 'simple sensor query',
    command: '/llmwiki search 风速仪 --limit 1',
    expects: ['按故障描述「风速仪」', '涉及', '风速仪'],
  },
  {
    name: 'ask and search agree on bare 200 ambiguity count',
    command: '/llmwiki search 200 --limit 4',
    expects: ['不同含义', '200：'],
    rejects: ['20007'],
  },
  {
    name: 'fault name lookup via search path',
    command: '/llmwiki search 风速仪故障的故障码是什么 --limit 6',
    expects: ['按名称/描述「风速仪故障」', '170010', '5307'],
    rejects: ['5308：机组冰冻告警'],
  },
  {
    name: 'coverage question for ambiguous code 504',
    command: '/llmwiki ask 504 哪些风场有 --limit 6',
    expects: ['504', '风场', '四平', '新华', '团结'],
    rejects: ['6504'],
  },
  {
    name: 'generator bearing temperature lookup label',
    command: '/llmwiki ask 发电机轴承温度高有哪些故障码 --limit 6',
    expects: ['按名称/描述「发电机轴承温度高」', '涉及'],
    rejects: ['按名称/描述「发电机轴承温度高有」'],
  },
  {
    name: 'strict nonexistent fault name returns no matches',
    command: '/llmwiki ask 随便乱写不存在的超级电容爆炸故障码是什么 --limit 4',
    expects: ['No matches'],
    rejects: ['按名称/描述「随便乱写」'],
  },
  {
    name: 'plain fault description returns all related codes - 扭缆',
    command: '/llmwiki ask 扭缆 --limit 8',
    expects: ['按故障描述「扭缆」', '涉及', '708：', '709：'],
    rejects: ['431：', '50刹车失败'],
  },
  {
    name: 'plain fault description returns all related codes - 偏航电机反馈异常',
    command: '/llmwiki ask 偏航电机反馈异常 --limit 8',
    expects: ['按故障描述「偏航电机反馈异常」', '706：', '721：'],
    rejects: ['No matches'],
  },
  {
    name: 'plain fault description returns lubrication family codes',
    command: '/llmwiki ask 变桨润滑不足 --limit 8',
    expects: ['按故障描述「变桨润滑不足」', '3021：', '3018：'],
    rejects: ['431：', '50刹车失败'],
  },
  {
    name: 'plain fault description search path matches ask',
    command: '/llmwiki search 齿轮箱温度高 --limit 6',
    expects: ['按故障描述「齿轮箱温度高」', '117：'],
    rejects: ['Matches for'],
  },
  {
    name: 'turbine id lookup returns mapping',
    command: '/llmwiki ask 洮北 58号 --limit 4',
    expects: ['风机编号「58#」', '洮北', '歌美飒', 'G58-850'],
  },
  {
    name: 'site-scoped turbine label lookup',
    command: '/llmwiki ask 团结 S03 --limit 4',
    expects: ['风机编号「S03」', '团结', '三一', 'SI-200625'],
  },
  {
    name: 'SH09 bare turbine id maps to 富荣',
    command: '/llmwiki ask SH09 --limit 4',
    expects: ['风机编号「SH09」', '富荣', '上海电气', 'LeapX'],
    rejects: ['该机型对应的风场如下', 'W2000系列'],
  },
  {
    name: '四平SH09 maps to W2000 not 富荣 LeapX',
    command: '/llmwiki ask 四平SH09 --limit 4',
    expects: ['风机编号「SH09#」', '四平', '上海电气', 'W2000'],
    rejects: ['LeapX', '富荣风电场'],
  },
  {
    name: '编号SH09 recognized as turbine id',
    command: '/llmwiki ask 编号SH09 --limit 4',
    expects: ['风机编号「SH09」', '富荣', 'LeapX'],
    rejects: ['该机型对应的风场如下'],
  },
  {
    name: 'turbine-qualified fault code query',
    command: '/llmwiki ask 四平 S01# 709 --limit 4',
    expects: ['709', '顺时针', '风机编号：S01#', '四平'],
    rejects: ['未找到与', '5012'],
  },
  {
    name: 'site turbine fault description lookup',
    command: '/llmwiki ask 洮北58号偏航传感器故障怎么处理 --limit 4',
    expects: ['偏航传感器', '歌美飒', '洮北', '100'],
    rejects: ['故障码 58 未找到', '需要补充定位'],
  },
  {
    name: 'site turbine fault description with handling intent',
    command: '/llmwiki ask 四平风场SH09风机存在机舱温度超限故障，如何处理? --limit 4',
    expects: ['270011', '机舱温度', '上海电气', '四平'],
    rejects: ['需要补充定位', '431 条', 'LeapX'],
  },
  {
    name: 'site turbine symptom without fault code',
    command: '/llmwiki ask 团结 S03 扭缆 --limit 4',
    expects: ['扭缆', '团结', '三一'],
    rejects: ['本地答案：S03', '需要补充定位'],
  },
]

let passed = 0
let failed = 0
const failures = []

for (const testCase of cases) {
  process.stdout.write(`- ${testCase.name}... `)
  try {
    const stdout = await runLlmwiki(testCase.command)
    for (const expected of testCase.expects) {
      if (!stdout.includes(expected)) {
        throw new Error(
          `Expected ${JSON.stringify(expected)} for ${testCase.command}\n\n${stdout}`,
        )
      }
    }
    for (const rejected of testCase.rejects ?? []) {
      if (stdout.includes(rejected)) {
        throw new Error(
          `Did not expect ${JSON.stringify(rejected)} for ${testCase.command}\n\n${stdout}`,
        )
      }
    }
    passed += 1
    process.stdout.write('OK\n')
  } catch (error) {
    failed += 1
    failures.push({ name: testCase.name, error: error.message })
    process.stdout.write('FAIL\n')
  }
}

console.log(`\nFault-code eval: ${passed} passed, ${failed} failed (${cases.length} total).`)

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`\n=== ${failure.name} ===\n${failure.error}`)
  }
  process.exit(1)
}

async function runLlmwiki(command) {
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      [runner, '--print', '--bare', command],
      {
        cwd: root,
        env: {
          ...process.env,
          LLMWIKI_PROJECT: join(root, '风机故障码'),
          WINDRISE_MODEL_MODE: process.env.WINDRISE_MODEL_MODE || 'lmstudio',
          ANTHROPIC_MODEL_PROVIDER:
            process.env.ANTHROPIC_MODEL_PROVIDER || 'lmstudio',
          LMSTUDIO_BASE_URL: process.env.LMSTUDIO_BASE_URL || 'http://127.0.0.1:1234',
          LMSTUDIO_MODEL: process.env.LMSTUDIO_MODEL || 'qwen/qwen3.5-9b',
        },
        maxBuffer: 20 * 1024 * 1024,
        timeout: 120_000,
      },
    )
    return stdout
  } catch (error) {
    throw new Error(`${error.stdout ?? ''}${error.stderr ?? ''}` || error.message)
  }
}
