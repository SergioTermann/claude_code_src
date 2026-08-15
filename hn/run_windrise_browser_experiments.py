#!/usr/bin/env python3
"""Browser-based Windrise UI experiments via Playwright."""

from __future__ import annotations

import json
import re
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

from playwright.sync_api import TimeoutError as PlaywrightTimeout
from playwright.sync_api import sync_playwright

BASE_URL = 'http://10.46.161.210:5002'
USERNAME = 'admin'
PASSWORD = 'admin'
MESSAGE_TIMEOUT_MS = 120_000
STEP_PAUSE_S = 1.0


@dataclass
class StepResult:
    scenario: str
    query: str
    ok: bool
    answer: str = ''
    failures: list[str] = field(default_factory=list)
    error: str = ''


def launch_playwright_browser(playwright):
    launch_kwargs = {'headless': True}
    try:
        return playwright.chromium.launch(**launch_kwargs)
    except Exception:
        return playwright.chromium.launch(channel='chrome', **launch_kwargs)


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


def send_chat_message(page, message: str, must_have: str = '', retries: int = 2) -> str:
    last_error = None
    for attempt in range(retries):
        try:
            answer = _send_chat_message_once(page, message, must_have=must_have)
            if any(marker in answer for marker in (
                '连接在传输过程中中断',
                '未能获取到回复',
                '回答未能继续',
            )):
                if attempt + 1 < retries:
                    time.sleep(2.0)
                    continue
            return answer
        except PlaywrightTimeout as exc:
            last_error = exc
            if attempt + 1 < retries:
                time.sleep(2.0)
                continue
            raise
    if last_error:
        raise last_error
    return ''


def _send_chat_message_once(page, message: str, must_have: str = '') -> str:
    page.wait_for_function(
        '() => { const i=document.getElementById("messageInput"); return i && !i.disabled; }',
        timeout=MESSAGE_TIMEOUT_MS,
    )
    baseline = page.eval_on_selector_all(
        '#chatMessages .message.bot .message-text-content',
        'els => { const last = els[els.length - 1]; return last ? (last.innerText || last.textContent || "").trim() : ""; }',
    )
    baseline_text = baseline[-1] if baseline else ''
    page.fill('#messageInput', message)
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


def wait_for_bot_answer_after_send(page, must_have: str, baseline_text: str) -> str:
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


def start_new_session(page) -> None:
    page.click('.new-session-btn')
    time.sleep(0.8)
    page.wait_for_selector('#messageInput')


def login(page) -> None:
    page.goto(f'{BASE_URL}/login', wait_until='domcontentloaded')
    page.fill('#username', USERNAME)
    page.fill('#password', PASSWORD)
    page.click('#loginBtn')
    page.wait_for_url(re.compile(r'.*/(index|chat)?.*'), timeout=15_000)
    page.wait_for_selector('#messageInput', timeout=15_000)
    disable_streaming(page)


def run_scenario(page, name: str, steps: list[dict]) -> list[StepResult]:
    results: list[StepResult] = []
    start_new_session(page)
    for step in steps:
        query = step['q']
        row = StepResult(scenario=name, query=query, ok=True)
        try:
            token = wait_token_for_step(step)
            answer = send_chat_message(page, query, must_have=token)
            row.answer = answer
            main = answer.split('备选答案')[0]
            for token_value in step.get('must_have', []):
                if token_value not in answer:
                    row.failures.append(f'missing:{token_value}')
            for token_value in step.get('must_not_have', []):
                if token_value in main:
                    row.failures.append(f'leaked:{token_value}')
            row.ok = not row.failures
        except PlaywrightTimeout as exc:
            row.ok = False
            row.error = f'timeout: {exc}'
        except Exception as exc:  # noqa: BLE001
            row.ok = False
            row.error = str(exc)
        results.append(row)
        time.sleep(STEP_PAUSE_S)
    return results


SCENARIOS = {
    'L_scoped_symptom': [
        {'q': '八面风场ZC09风机', 'must_have': ['ZC09', 'CWT']},
        {'q': '偏航回路欠压', 'must_have': ['120014', '偏航']},
        {'q': '齿轮箱油温高', 'must_have': ['60011', '齿轮箱'], 'must_not_have': ['120014']},
        {'q': '功率过低切出', 'must_have': ['70029'], 'must_not_have': ['60011']},
    ],
    'A_fault_bleed': [
        {'q': '同发风场A32号风机 SS-4刹车存储继电器', 'must_have': ['5', 'SS-4']},
        {'q': '同发风场A32号风机主PLC检测到从PLC通讯错误', 'must_have': ['272'], 'must_not_have': ['SS-4']},
        {'q': '八面风场ZC05风机 功率过低切出', 'must_have': ['70029', 'ZC05'], 'must_not_have': ['272', 'SS-4']},
    ],
    'C_scope_then_intent': [
        {'q': '偏航回路欠压故障触发条件', 'must_have': ['风场']},
        {'q': '八面风场', 'must_have': ['具体风机编号'], 'wait_for': '具体风机编号'},
        {'q': 'ZC09', 'must_have': ['120014']},
        {
            'q': '触发条件是什么',
            'must_have': ['120014'],
            'must_not_have': ['120008'],
            'wait_for': '10bar',
        },
        {'q': '怎么处理', 'must_have': ['偏航', '液压'], 'wait_for': '检查'},
    ],
    'P_cross_farm': [
        {'q': '同发风场A32号风机主PLC检测到从PLC通讯错误', 'must_have': ['272']},
        {'q': '八面风场ZC05风机功率过低切出', 'must_have': ['70029'], 'must_not_have': ['272']},
        {'q': '功率过低切出', 'must_have': ['70029', 'ZC05']},
        {'q': '齿轮箱油温高', 'must_have': ['60011'], 'must_not_have': ['70029']},
    ],
    'PLC_single_shot': [
        {'q': '同发风场A32号风机主PLC检测到从PLC通讯错误', 'must_have': ['272', '主PLC'], 'must_not_have': ['本地映射表共找到']},
    ],
}


def main() -> int:
    all_results: list[StepResult] = []
    with sync_playwright() as playwright:
        browser = launch_playwright_browser(playwright)
        for name, steps in SCENARIOS.items():
            context = browser.new_context(viewport={'width': 1440, 'height': 900})
            page = context.new_page()
            login(page)
            all_results.extend(run_scenario(page, name, steps))
            context.close()
        browser.close()

    passed = sum(1 for item in all_results if item.ok)
    print('=' * 72)
    print(f'Browser UI experiments: {passed}/{len(all_results)} steps passed')
    print('=' * 72)
    current = ''
    for row in all_results:
        if row.scenario != current:
            current = row.scenario
            print(f'\n## {current}')
        status = 'PASS' if row.ok else 'FAIL'
        print(f'  [{status}] {row.query}')
        preview = row.answer.replace('\n', ' ')[:140]
        if preview:
            print(f'         {preview}')
        if row.failures:
            print(f'         => {", ".join(row.failures)}')
        if row.error:
            print(f'         error: {row.error}')

    report_path = Path(__file__).with_name('windrise_browser_experiment_report.json')
    report_path.write_text(
        json.dumps([row.__dict__ for row in all_results], ensure_ascii=False, indent=2),
        encoding='utf-8',
    )
    print(f'\nReport saved: {report_path}')
    return 0 if passed == len(all_results) else 1


if __name__ == '__main__':
    sys.exit(main())
