#!/usr/bin/env python3
"""Extended API + browser regression tests for Windrise fault routing."""

from __future__ import annotations

import json
import os
import re
import sys
import time
from dataclasses import dataclass, field

import requests
from playwright.sync_api import TimeoutError as PlaywrightTimeout
from playwright.sync_api import sync_playwright

BASE_URL = 'http://10.46.161.210:5002'
USERNAME = 'admin'
PASSWORD = 'admin'
MESSAGE_TIMEOUT_MS = 120_000


@dataclass
class CaseResult:
    name: str
    channel: str
    ok: bool
    query: str = ''
    failures: list[str] = field(default_factory=list)
    preview: str = ''


CASES = [
    {
        'name': 'MY45_A1_blade_sync',
        'q': '良井子风场MY45风机变桨A1叶片同步故障',
        'must_have': ['1404055', '桨叶1不同步', 'MY45'],
        'must_not_have': ['1401092', '急停开关拍下'],
    },
    {
        'name': 'MY45_A2_blade_sync',
        'q': '良井子风场MY45风机变桨A2叶片同步故障',
        'must_have': ['1404056', '桨叶2不同步'],
        'must_not_have': ['1401093'],
    },
    {
        'name': 'F21_blade3_emergency',
        'q': '新华风场F21风机桨叶3紧急顺桨模式',
        'must_have': ['15804', '桨叶3紧急顺桨', 'F21'],
        'must_not_have': ['15819', '手动允许超限'],
    },
    {
        'name': 'A32_PLC_comm',
        'q': '同发风场A32号风机主PLC检测到从PLC通讯错误',
        'must_have': ['272', '主PLC'],
        'must_not_have': ['SS-4'],
    },
    {
        'name': 'ZC05_power_low',
        'q': '八面风场ZC05风机功率过低切出',
        'must_have': ['70029', 'ZC05'],
        'must_not_have': ['272'],
    },
    {
        'name': 'A32_SS4_brake',
        'q': '同发风场A32号风机 SS-4刹车存储继电器',
        'must_have': ['5', 'SS-4'],
        'must_not_have': ['272'],
    },
]

EFC_CASE = {
    'name': 'SY27_EFC_signal_loss',
    'history': [
        {'role': 'user', 'content': '什花道风电场SY27'},
        {
            'role': 'assistant',
            'content': '风机编号「SY27」对应 什花道风电场 / 三一 / 高速系列 / 具体型号：SE16033。',
        },
    ],
    'q': '变桨轴1硬件EFC信号丢失',
    'must_have': ['4171', 'EFC', '变桨轴1硬件EFC信号丢失'],
    'must_not_have': ['4160', '自动模式下通讯故障'],
}

C4_SCOPE_TRIGGER_CASE = {
    'name': 'C4_scope_trigger_followup',
    'history': [
        {'role': 'user', 'content': '偏航回路欠压故障触发条件'},
        {'role': 'assistant', 'content': '请先补充风场、风机编号等设备范围。'},
        {'role': 'user', 'content': '八面风场'},
        {'role': 'assistant', 'content': '请补充风机编号。'},
        {'role': 'user', 'content': 'ZC09'},
        {
            'role': 'assistant',
            'content': (
                '**证据命中**\n【故障代码】120014\n【故障名称】偏航回路欠压\n'
                '【触发条件】\n机组偏航时液压偏航回路压力低于10bar持续3s'
            ),
        },
    ],
    'q': '触发条件是什么',
    'must_have': ['120014', '10bar'],
    'must_not_have': ['120008'],
}


def launch_playwright_browser(playwright):
    launch_kwargs = {'headless': True}
    try:
        return playwright.chromium.launch(**launch_kwargs)
    except Exception:
        return playwright.chromium.launch(channel='chrome', **launch_kwargs)


def evaluate_answer(answer: str, case: dict) -> list[str]:
    main = (answer or '').split('备选答案')[0]
    failures = []
    for token in case.get('must_have', []):
        if token not in (answer or ''):
            failures.append(f'missing:{token}')
    for token in case.get('must_not_have', []):
        if token in main:
            failures.append(f'leaked:{token}')
    return failures


def login_session() -> tuple[requests.Session, str]:
    session = requests.Session()
    data = session.post(
        f'{BASE_URL}/api/login',
        json={'username': USERNAME, 'password': PASSWORD},
        timeout=20,
    ).json()
    if not data.get('csrf_token'):
        raise RuntimeError(f'login failed: {data}')
    return session, data['csrf_token']


def api_chat(session: requests.Session, csrf: str, query: str, mode: str, history: list | None = None) -> str:
    sid = session.post(
        f'{BASE_URL}/api/sessions',
        json={'title': f'regression-{mode}'},
        headers={'X-CSRF-Token': csrf},
        timeout=20,
    ).json()['session']['id']
    for item in history or []:
        session.post(
            f'{BASE_URL}/api/sessions/{sid}/messages',
            json={'role': item['role'], 'content': item['content']},
            headers={'X-CSRF-Token': csrf},
            timeout=20,
        )
    if mode == 'blocking':
        data = session.post(
            f'{BASE_URL}/api/chat',
            json={'message': query, 'response_mode': 'blocking', 'session_id': sid},
            headers={'X-CSRF-Token': csrf},
            timeout=120,
        ).json()
        return data.get('answer') or ''
    text = ''
    response = session.post(
        f'{BASE_URL}/api/chat',
        json={'message': query, 'response_mode': 'streaming', 'session_id': sid},
        headers={'X-CSRF-Token': csrf},
        stream=True,
        timeout=120,
    )
    for line in response.iter_lines(decode_unicode=True):
        if not line or not line.startswith('data:'):
            continue
        payload = json.loads(line[5:])
        if payload.get('answer'):
            text += payload['answer']
        if payload.get('event') == 'message_end':
            break
    return text


def run_api_tests() -> list[CaseResult]:
    session, csrf = login_session()
    results: list[CaseResult] = []
    all_cases = CASES + [EFC_CASE, C4_SCOPE_TRIGGER_CASE]
    for mode in ('blocking', 'streaming'):
        for case in all_cases:
            answer = ''
            failures: list[str] = []
            for attempt in range(2):
                answer = api_chat(session, csrf, case['q'], mode, case.get('history'))
                failures = evaluate_answer(answer, case)
                if not failures:
                    break
                time.sleep(1.5)
            results.append(CaseResult(
                name=case['name'],
                channel=f'api-{mode}',
                ok=not failures,
                query=case['q'],
                failures=failures,
                preview=(answer or '').replace('\n', ' ')[:160],
            ))
    return results


def disable_streaming(page) -> None:
    page.wait_for_function(
        """async () => {
            const response = await fetch('/api/current-user', { credentials: 'same-origin' });
            if (!response.ok) {
                return false;
            }
            const data = await response.json();
            if (!data || !data.success || !data.user_id) {
                return false;
            }
            localStorage.setItem(`streamMode_${data.user_id}`, 'false');
            return true;
        }""",
        timeout=30_000,
    )
    page.reload(wait_until='domcontentloaded')
    page.wait_for_selector('#messageInput', timeout=30_000)


def wait_token_for_step(step: dict) -> str:
    if step.get('wait_for'):
        return step['wait_for']
    must_have = step.get('must_have') or []
    if not must_have:
        return ''
    return max(must_have, key=len)


def send_ui_turn(page, query: str, must_have: str = '') -> str:
    page.wait_for_function('() => { const i=document.getElementById("messageInput"); return i && !i.disabled; }', timeout=MESSAGE_TIMEOUT_MS)
    baseline = page.eval_on_selector_all(
        '#chatMessages .message.bot .message-text-content',
        'els => { const last = els[els.length - 1]; return last ? (last.innerText || last.textContent || "").trim() : ""; }',
    )
    baseline_text = baseline[-1] if baseline else ''
    page.fill('#messageInput', query)
    page.click('#sendBtn')
    try:
        page.wait_for_function(
            '() => { const b=document.getElementById("sendBtn"); return b && b.disabled; }',
            timeout=10_000,
        )
        page.wait_for_function(
            '() => { const b=document.getElementById("sendBtn"); const i=document.getElementById("messageInput"); return b && !b.disabled && i && !i.disabled; }',
            timeout=MESSAGE_TIMEOUT_MS,
        )
    except PlaywrightTimeout:
        pass
    page.wait_for_function(
        """(args) => {
            const token = args.token || '';
            const baseline = args.baseline || '';
            const bots = document.querySelectorAll('#chatMessages .message.bot .message-text-content');
            if (!bots.length) return false;
            const last = bots[bots.length - 1];
            const sendBtn = document.getElementById('sendBtn');
            const input = document.getElementById('messageInput');
            const generating = (sendBtn && sendBtn.disabled) || (input && input.disabled);
            const text = (last.innerText || last.textContent || '').trim();
            if (!text.length) return false;
            if (generating) return false;
            if (!token && baseline && text === baseline) return false;
            if (token && !text.includes(token)) return false;
            return true;
        }""",
        arg={'token': must_have, 'baseline': baseline_text},
        timeout=MESSAGE_TIMEOUT_MS,
    )
    texts = page.eval_on_selector_all(
        '#chatMessages .message.bot .message-text-content',
        'els => els.map(el => (el.innerText || el.textContent || "").trim())',
    )
    return texts[-1] if texts else ''


# Live multi-turn C4 UI coverage: run_windrise_browser_experiments.py scenario C_scope_then_intent
C4_UI_STEPS = [
    {'q': '偏航回路欠压故障触发条件', 'must_have': ['风场']},
    {'q': '八面风场', 'must_have': ['风机编号'], 'wait_for': '具体风机编号'},
    {'q': 'ZC09', 'must_have': ['120014']},
    {
        'q': '触发条件是什么',
        'must_have': ['120014', '10bar'],
        'must_not_have': ['120008'],
        'wait_for': '10bar',
    },
]


def login_ui_page(browser, viewport=None):
    viewport = viewport or {'width': 1440, 'height': 900}
    context = browser.new_context(viewport=viewport)
    page = context.new_page()
    page.goto(f'{BASE_URL}/login', wait_until='domcontentloaded')
    page.fill('#username', USERNAME)
    page.fill('#password', PASSWORD)
    page.click('#loginBtn')
    page.wait_for_url(re.compile(r'.*/(index|chat)?.*'), timeout=30_000)
    page.wait_for_selector('#messageInput', timeout=30_000)
    disable_streaming(page)
    return context, page


def run_ui_multi_turn(page, steps: list[dict]) -> tuple[str, list[str]]:
    failures: list[str] = []
    answer = ''
    for step in steps:
        token = wait_token_for_step(step)
        answer = send_ui_turn(page, step['q'], must_have=token)
        failures.extend(evaluate_answer(answer, step))
    return answer, failures


def run_browser_tests() -> list[CaseResult]:
    results: list[CaseResult] = []
    with sync_playwright() as playwright:
        browser = launch_playwright_browser(playwright)

        for case in CASES:
            row = CaseResult(name=case['name'], channel='ui-blocking', query=case['q'], ok=True)
            context = None
            try:
                context, page = login_ui_page(browser)
                page.click('.new-session-btn')
                time.sleep(0.8)
                token = case['must_have'][0] if case.get('must_have') else ''
                answer = send_ui_turn(page, case['q'], must_have=token)
                row.preview = answer.replace('\n', ' ')[:160]
                row.failures = evaluate_answer(answer, case)
                row.ok = not row.failures
            except PlaywrightTimeout as exc:
                row.ok = False
                row.failures = [f'timeout:{exc}']
            finally:
                if context is not None:
                    context.close()
            results.append(row)

        for label, steps in (
            ('SY27_EFC_signal_loss', [
                {'q': item['content']}
                for item in EFC_CASE['history']
            ] + [{
                'q': EFC_CASE['q'],
                'must_have': EFC_CASE['must_have'],
                'must_not_have': EFC_CASE['must_not_have'],
            }]),
        ):
            row = CaseResult(name=label, channel='ui-blocking', query=steps[-1]['q'], ok=True)
            context = None
            try:
                context, page = login_ui_page(browser)
                page.click('.new-session-btn')
                time.sleep(0.8)
                answer, failures = run_ui_multi_turn(page, steps)
                row.preview = answer.replace('\n', ' ')[:160]
                row.failures = failures
                row.ok = not failures
            except PlaywrightTimeout as exc:
                row.ok = False
                row.failures = [f'timeout:{exc}']
            finally:
                if context is not None:
                    context.close()
            results.append(row)

        browser.close()
    return results


def print_report(results: list[CaseResult]) -> int:
    passed = sum(1 for item in results if item.ok)
    print('=' * 72)
    print(f'Extended regression: {passed}/{len(results)} passed')
    print('=' * 72)
    current = ''
    for row in results:
        key = f'{row.channel}'
        if key != current:
            current = key
            print(f'\n## {current}')
        status = 'PASS' if row.ok else 'FAIL'
        print(f'  [{status}] {row.name}: {row.query}')
        if row.preview:
            print(f'         {row.preview}')
        if row.failures:
            print(f'         => {", ".join(row.failures)}')
    return 0 if passed == len(results) else 1


def main() -> int:
    results = run_api_tests()
    if os.getenv('SKIP_BROWSER_TESTS', '').strip().lower() not in {'1', 'true', 'yes'}:
        results.extend(run_browser_tests())
    return print_report(results)


if __name__ == '__main__':
    sys.exit(main())
