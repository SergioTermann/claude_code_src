#!/usr/bin/env python3
"""Run Windrise multi-turn scenario experiments from windrise-long-context-test-cases.md."""

from __future__ import annotations

import importlib.util
import re
import sys
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('windrise', ROOT / 'dify_web_server_.py')
windrise = importlib.util.module_from_spec(spec)
spec.loader.exec_module(windrise)


def extract_fault_code(answer: str) -> str:
    if not answer:
        return ''
    m = re.search(r'【故障代码】\s*(\d+)', answer)
    if m:
        return m.group(1)
    m = re.search(r'(?:^|\s)(\d{1,8})\s*[|｜]', answer)
    if m:
        return m.group(1)
    m = re.search(r'故障码\s*(\d+)', answer)
    if m:
        return m.group(1)
    return ''


def run_scenario(name: str, steps: list[dict]) -> list[dict]:
    history: list[dict] = []
    results = []
    with patch.object(windrise, 'call_windrise_semantic_router'):
        for step in steps:
            query = step['q']
            answer, route = windrise.build_windrise_response_payload(query, history)
            code = extract_fault_code(answer or '')
            row = {
                'scenario': name,
                'query': query,
                'reason': route.get('reason'),
                'code': code,
                'answer_preview': (answer or '').replace('\n', ' ')[:120],
            }
            failed = []
            main_answer = (answer or '').split('备选答案')[0]
            for token in step.get('must_have', []):
                if token not in (answer or ''):
                    failed.append(f'missing:{token}')
            for token in step.get('must_not_have', []):
                if token in main_answer:
                    failed.append(f'leaked:{token}')
            for token in step.get('must_have_code', []):
                if code != token and token not in (answer or ''):
                    failed.append(f'code!=${token}')
            row['ok'] = not failed
            row['failures'] = failed
            results.append(row)
            history.extend([
                {'role': 'user', 'content': query},
                {'role': 'assistant', 'content': answer or ''},
            ])
    return results


SCENARIOS = {
    'A_fault_bleed': [
        {'q': '同发风场A32号风机 SS-4刹车存储继电器', 'must_have': ['5', 'SS-4']},
        {'q': '同发风场A32号风机主PLC检测到从PLC通讯错误', 'must_have': ['272', '主PLC'], 'must_not_have': ['SS-4']},
        {'q': '八面风场ZC05风机 功率过低切出', 'must_have': ['70029', 'ZC05'], 'must_not_have': ['SS-4', '272']},
        {'q': '故障码5922是什么', 'must_have': ['5922'], 'must_not_have': ['272', '70029']},
        {'q': '1200010', 'must_have': ['1200010'], 'must_not_have': ['5922']},
    ],
    'B_same_turbine_faults': [
        {'q': '同发风场A32号风机主PLC检测到从PLC通讯错误', 'must_have': ['272']},
        {'q': '同发风场A32号风机SS-4刹车存储继电器', 'must_have': ['5'], 'must_not_have': ['272']},
        {'q': '同发风场A32号风机从PLC检测到从PLC通讯错误', 'must_have': ['273'], 'must_not_have': ['272']},
    ],
    'C_scope_completion': [
        {'q': '偏航回路欠压故障触发条件', 'must_have': ['风场']},
        {'q': '八面风场', 'must_have': ['风机编号', 'ZC09']},
        {'q': 'ZC09', 'must_have': ['120014', '偏航']},
        {'q': '触发条件是什么', 'must_have': ['120014']},
    ],
    'L_scoped_symptom_after_mapping': [
        {'q': '八面风场ZC09风机', 'must_have': ['ZC09', 'CWT']},
        {'q': '偏航回路欠压', 'must_have': ['120014', 'ZC09']},
        {'q': '齿轮箱油温高', 'must_have': ['60011', 'ZC09', '齿轮箱'], 'must_not_have': ['120014']},
        {'q': '功率过低切出', 'must_have': ['70029'], 'must_not_have': ['60011']},
    ],
    'M_scope_then_new_symptom': [
        {'q': '偏航回路欠压故障触发条件', 'must_have': ['风场']},
        {'q': '八面风场', 'must_have': ['风机编号']},
        {'q': 'ZC09', 'must_have': ['120014']},
        {'q': '齿轮箱油温高', 'must_have': ['60011', '齿轮箱', 'ZC09'], 'must_not_have': ['120014']},
    ],
    'N_model_then_symptom': [
        {'q': '同发风场A32是什么型号', 'must_have': ['SL1500', 'A32']},
        {'q': '主PLC检测到从PLC通讯错误', 'must_have': ['272', 'A32']},
        {'q': 'SS-4刹车存储继电器', 'must_have': ['5'], 'must_not_have': ['272']},
        {'q': '从PLC检测到从PLC通讯错误', 'must_have': ['273'], 'must_not_have': ['272']},
    ],
    'P_cross_farm_symptom': [
        {'q': '同发风场A32号风机主PLC检测到从PLC通讯错误', 'must_have': ['272']},
        {'q': '同发风场A32号风机SS-4刹车存储继电器', 'must_have': ['5']},
        {'q': '八面风场ZC05风机功率过低切出', 'must_have': ['70029', 'ZC05'], 'must_not_have': ['272', 'SS-4']},
        {'q': '功率过低切出', 'must_have': ['70029', '八面'], 'must_not_have': ['272']},
        {'q': '风机功率过低切出', 'must_have': ['70029', 'ZC05'], 'must_not_have': ['SL1500', '同发风电场 A32']},
        {'q': '齿轮箱油温高', 'must_have': ['60011', 'ZC05'], 'must_not_have': ['70029']},
    ],
    'F_mapping_vs_fault': [
        {'q': '同发有哪些风机机型', 'must_have': ['同发', '机型']},
        {'q': 'A32是什么型号', 'must_have': ['A32']},
        {'q': '同发风场A32号风机主PLC检测到从PLC通讯错误', 'must_have': ['272'], 'must_not_have': ['机型清单']},
    ],
    'G_casual': [
        {'q': '你好', 'must_have': ['Windrise']},
        {'q': '偏航系统是怎么工作的', 'must_have': []},
        {'q': '同发风场A32号风机主PLC检测到从PLC通讯错误', 'must_have': ['272']},
    ],
    'H_explicit_codes': [
        {'q': '同发风场A32号风机 SS-4刹车存储继电器', 'must_have': ['5']},
        {'q': '八面风场ZC05风机功率过低切出', 'must_have': ['70029']},
        {'q': '故障码5922是什么', 'must_have': ['5922'], 'must_not_have': ['70029']},
        {'q': '1200010', 'must_have': ['1200010']},
    ],
    'T_long_session': [
        {'q': '你好', 'must_have': ['Windrise']},
        {'q': '偏航回路欠压故障触发条件', 'must_have': ['风场']},
        {'q': '八面风场', 'must_have': ['风机编号']},
        {'q': 'ZC09', 'must_have': ['120014']},
        {'q': '齿轮箱油温高', 'must_have': ['60011', 'ZC09']},
        {'q': '怎么处理', 'must_have': ['齿轮箱']},
        {'q': '同发风场A32号风机', 'must_have': ['A32', 'SL1500']},
        {'q': '主PLC检测到从PLC通讯错误', 'must_have': ['272', 'A32'], 'must_not_have': ['ZC09']},
        {'q': '八面风场ZC05风机', 'must_have': ['ZC05', 'CWT']},
        {'q': '功率过低切出', 'must_have': ['70029', 'ZC05'], 'must_not_have': ['A32']},
        {'q': '故障码5922是什么', 'must_have': ['5922'], 'must_not_have': ['ZC05']},
        {'q': '1200010', 'must_have': ['1200010']},
    ],
}


def main() -> int:
    all_results = []
    for name, steps in SCENARIOS.items():
        all_results.extend(run_scenario(name, steps))

    passed = [r for r in all_results if r['ok']]
    failed = [r for r in all_results if not r['ok']]

    print('=' * 72)
    print(f'Windrise scenario experiments: {len(passed)}/{len(all_results)} steps passed')
    print('=' * 72)

    current = ''
    for row in all_results:
        if row['scenario'] != current:
            current = row['scenario']
            print(f"\n## {current}")
        status = 'PASS' if row['ok'] else 'FAIL'
        print(f"  [{status}] {row['query']}")
        print(f"         reason={row['reason']} code={row['code'] or '-'}")
        if row['failures']:
            print(f"         => {', '.join(row['failures'])}")
        if not row['ok']:
            print(f"         preview: {row['answer_preview']}")

    if failed:
        print('\n' + '=' * 72)
        print(f'FAILED STEPS ({len(failed)}):')
        for row in failed:
            print(f"  - [{row['scenario']}] {row['query']}: {', '.join(row['failures'])}")
        return 1

    print('\nAll scenario steps passed.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
