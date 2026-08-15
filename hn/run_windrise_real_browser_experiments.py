#!/usr/bin/env python3
"""Real-browser Windrise experiments: login UI, type messages, click send, read answers."""

from __future__ import annotations

import json
import os
import re
import sys
import time
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path

from playwright.sync_api import TimeoutError as PlaywrightTimeout
from playwright.sync_api import sync_playwright

# Reuse hardened UI helpers from the smaller browser suite.
from run_windrise_browser_experiments import (
    BASE_URL,
    MESSAGE_TIMEOUT_MS,
    PASSWORD,
    USERNAME,
    disable_streaming,
    send_chat_message,
    start_new_session,
    wait_for_bot_answer_after_send,
    wait_token_for_step,
)
from run_windrise_scenario_experiments import SCENARIOS as CORE_SCENARIOS

REPORT_PATH = Path(__file__).with_name('windrise_real_browser_experiment_report.json')
SCREENSHOT_DIR = Path(__file__).with_name('browser_experiment_screenshots')


@dataclass
class StepResult:
    scenario: str
    step_index: int
    query: str
    ok: bool
    answer: str = ''
    failures: list[str] = field(default_factory=list)
    error: str = ''
    duration_ms: int = 0
    screenshot: str = ''


EXTRA_SCENARIOS = {
    'D_scope_then_new_fault': [
        {'q': '偏航回路欠压故障触发条件', 'must_have': ['风场']},
        {'q': '八面风场', 'must_have': ['具体风机编号'], 'wait_for': '具体风机编号'},
        {'q': 'ZC09', 'must_have': ['120014']},
        {'q': '同发风场A32号风机主PLC检测到从PLC通讯错误', 'must_have': ['272'], 'must_not_have': ['120014']},
        {'q': '功率过低切出', 'must_have': ['70029'], 'must_not_have': ['272']},
    ],
    'E_symptom_followup': [
        {'q': '八面风场ZC05风机功率过低切出', 'must_have': ['70029', 'ZC05']},
        {'q': '功率过低切出', 'must_have': ['70029'], 'must_not_have': ['272']},
        {'q': '触发条件是什么', 'must_have': ['70029', '10Kw'], 'wait_for': '10Kw'},
        {'q': '齿轮箱油温高', 'must_have': ['60011'], 'must_not_have': ['70029']},
    ],
    'J_cross_farm': [
        {'q': '同发风场A32号风机SS-4刹车存储继电器', 'must_have': ['5', 'SS-4']},
        {'q': '八面风场ZC09风机偏航回路欠压故障触发条件是什么', 'must_have': ['120014', '八面']},
        {'q': 'ZC05风机功率过低切出', 'must_have': ['70029'], 'must_not_have': ['120014']},
        {'q': '同发风场A32号风机主PLC检测到从PLC通讯错误', 'must_have': ['272'], 'must_not_have': ['70029']},
    ],
    'K_long_pressure': [
        {'q': '你好', 'must_have': ['Windrise']},
        {'q': '同发有哪些风机机型', 'must_have': ['同发']},
        {'q': '同发风场A32号风机 SS-4刹车存储继电器', 'must_have': ['5']},
        {'q': '怎么处理', 'must_have': ['制动'], 'wait_for': '制动'},
        {'q': '同发风场A32号风机主PLC检测到从PLC通讯错误', 'must_have': ['272'], 'must_not_have': ['SS-4']},
        {'q': '八面风场ZC05风机 功率过低切出', 'must_have': ['70029'], 'must_not_have': ['272']},
        {'q': '功率过低切出', 'must_have': ['70029'], 'must_not_have': ['272']},
        {'q': '故障码5922是什么', 'must_have': ['5922'], 'must_not_have': ['70029']},
        {'q': '1200010', 'must_have': ['1200010'], 'must_not_have': ['5922']},
    ],
    'O_same_turbine_symptoms': [
        {'q': '同发风场A32号风机', 'must_have': ['A32', 'SL1500']},
        {'q': '主PLC通讯错误', 'must_have': ['272']},
        {'q': 'SS-4刹车存储继电器', 'must_have': ['5'], 'must_not_have': ['272']},
        {'q': '从PLC通讯错误', 'must_have': ['273'], 'must_not_have': ['272']},
    ],
    'R_cwt_symptom_variants': [
        {'q': '八面风场ZC09风机', 'must_have': ['ZC09', 'CWT']},
        {'q': '偏航回路欠压故障触发条件', 'must_have': ['120014']},
        {'q': '偏航欠压', 'must_have': ['120014'], 'must_not_have': ['272']},
        {'q': '齿轮箱油池温度高', 'must_have': ['60011', '齿轮箱'], 'must_not_have': ['120014']},
    ],
    'MY45_blade_sync': [
        {'q': '良井子风场MY45风机变桨A1叶片同步故障', 'must_have': ['1404055', 'MY45'], 'must_not_have': ['1401092']},
        {'q': '良井子风场MY45风机变桨A2叶片同步故障', 'must_have': ['1404056'], 'must_not_have': ['1401093']},
    ],
    'F21_emergency_feather': [
        {'q': '新华风场F21风机桨叶3紧急顺桨模式', 'must_have': ['15804', 'F21'], 'must_not_have': ['15819']},
    ],
    'SY27_efc_signal': [
        {'q': '什花道风电场SY27', 'must_have': ['SY27', '什花道']},
        {'q': '变桨轴1硬件EFC信号丢失', 'must_have': ['4171', 'EFC'], 'must_not_have': ['4160']},
    ],
    'C_scope_full_intent': [
        {'q': '偏航回路欠压故障触发条件', 'must_have': ['风场']},
        {'q': '八面风场', 'must_have': ['具体风机编号'], 'wait_for': '具体风机编号'},
        {'q': 'ZC09', 'must_have': ['120014']},
        {'q': '触发条件是什么', 'must_have': ['120014'], 'must_not_have': ['120008'], 'wait_for': '10bar'},
        {'q': '怎么处理', 'must_have': ['偏航', '液压'], 'wait_for': '检查'},
    ],
}


def all_scenarios() -> dict[str, list[dict]]:
    merged = dict(CORE_SCENARIOS)
    for name, steps in EXTRA_SCENARIOS.items():
        if name not in merged:
            merged[name] = steps
    return merged


def launch_browser(playwright, headed: bool):
    slow_mo = int(os.getenv('WINDRISE_BROWSER_SLOW_MO', '40'))
    launch_kwargs = {
        'headless': not headed,
        'slow_mo': slow_mo,
    }
    try:
        return playwright.chromium.launch(channel='chrome', **launch_kwargs)
    except Exception:
        return playwright.chromium.launch(**launch_kwargs)


def login_real_user(page) -> None:
    page.goto(f'{BASE_URL}/login', wait_until='domcontentloaded')
    page.wait_for_selector('#username', timeout=30_000)
    page.click('#username')
    page.fill('#username', USERNAME)
    page.click('#password')
    page.fill('#password', PASSWORD)
    page.click('#loginBtn')
    page.wait_for_url(re.compile(r'.*/(index|chat)?.*'), timeout=30_000)
    page.wait_for_selector('#messageInput', timeout=30_000)
    if os.getenv('WINDRISE_BROWSER_STREAMING', '0').strip().lower() in {'1', 'true', 'yes'}:
        page.wait_for_function(
            """async () => {
                const r = await fetch('/api/current-user', { credentials: 'same-origin' });
                const d = await r.json();
                if (!d?.user_id) return false;
                localStorage.setItem(`streamMode_${d.user_id}`, 'true');
                return true;
            }""",
            timeout=30_000,
        )
        page.reload(wait_until='domcontentloaded')
        page.wait_for_selector('#messageInput', timeout=30_000)
    else:
        disable_streaming(page)


def type_and_send_message(page, message: str, must_have: str = '') -> str:
    """Type like a user (keydown per char) then click send."""
    page.wait_for_function(
        '() => { const i=document.getElementById("messageInput"); return i && !i.disabled; }',
        timeout=MESSAGE_TIMEOUT_MS,
    )
    baseline = page.eval_on_selector_all(
        '#chatMessages .message.bot .message-text-content',
        'els => { const last = els[els.length - 1]; return last ? (last.innerText || last.textContent || "").trim() : ""; }',
    )
    baseline_text = baseline[-1] if baseline else ''
    input_el = page.locator('#messageInput')
    input_el.click()
    input_el.fill('')
    page.keyboard.type(message, delay=25)
    time.sleep(0.15)
    page.click('#sendBtn')
    return wait_for_bot_answer_after_send(page, must_have, baseline_text)


def evaluate_step(answer: str, step: dict) -> list[str]:
    failures: list[str] = []
    main = (answer or '').split('备选答案')[0]
    for token in step.get('must_have', []):
        if token not in (answer or ''):
            failures.append(f'missing:{token}')
    for token in step.get('must_not_have', []):
        if token in main:
            failures.append(f'leaked:{token}')
    return failures


def run_scenario(page, name: str, steps: list[dict], *, use_typing: bool) -> list[StepResult]:
    results: list[StepResult] = []
    start_new_session(page)
    for index, step in enumerate(steps, start=1):
        query = step['q']
        token = wait_token_for_step(step)
        row = StepResult(scenario=name, step_index=index, query=query, ok=True)
        started = time.monotonic()
        try:
            if use_typing:
                answer = type_and_send_message(page, query, must_have=token)
            else:
                answer = send_chat_message(page, query, must_have=token)
            row.answer = answer
            row.failures = evaluate_step(answer, step)
            row.ok = not row.failures
        except PlaywrightTimeout as exc:
            row.ok = False
            row.error = f'timeout: {exc}'
        except Exception as exc:  # noqa: BLE001
            row.ok = False
            row.error = str(exc)
        row.duration_ms = int((time.monotonic() - started) * 1000)
        if not row.ok:
            SCREENSHOT_DIR.mkdir(parents=True, exist_ok=True)
            shot = SCREENSHOT_DIR / f'{name}_{index:02d}_{int(time.time())}.png'
            try:
                page.screenshot(path=str(shot), full_page=True)
                row.screenshot = str(shot)
            except Exception:
                pass
        results.append(row)
        time.sleep(float(os.getenv('WINDRISE_BROWSER_STEP_PAUSE', '0.6')))
    return results


def print_report(results: list[StepResult], meta: dict) -> int:
    passed = sum(1 for item in results if item.ok)
    print('=' * 72)
    print(f'Real browser experiments: {passed}/{len(results)} steps passed')
    print(f"Mode: headed={meta['headed']} typing={meta['typing']} streaming={meta['streaming']}")
    print('=' * 72)
    current = ''
    for row in results:
        if row.scenario != current:
            current = row.scenario
            print(f'\n## {current}')
        status = 'PASS' if row.ok else 'FAIL'
        print(f"  [{status}] #{row.step_index} {row.query} ({row.duration_ms}ms)")
        preview = row.answer.replace('\n', ' ')[:140]
        if preview:
            print(f'         {preview}')
        if row.failures:
            print(f"         => {', '.join(row.failures)}")
        if row.error:
            print(f'         error: {row.error}')
        if row.screenshot:
            print(f'         screenshot: {row.screenshot}')
    return 0 if passed == len(results) else 1


def main() -> int:
    headed = os.getenv('WINDRISE_BROWSER_HEADED', '0').strip().lower() in {'1', 'true', 'yes'}
    use_typing = os.getenv('WINDRISE_BROWSER_TYPING', '1').strip().lower() not in {'0', 'false', 'no'}
    streaming = os.getenv('WINDRISE_BROWSER_STREAMING', '0').strip().lower() in {'1', 'true', 'yes'}
    only = [name.strip() for name in os.getenv('WINDRISE_BROWSER_ONLY', '').split(',') if name.strip()]

    scenarios = all_scenarios()
    if only:
        scenarios = {name: scenarios[name] for name in only if name in scenarios}

    all_results: list[StepResult] = []
    meta = {
        'started_at': datetime.now(timezone.utc).isoformat(),
        'headed': headed,
        'typing': use_typing,
        'streaming': streaming,
        'base_url': BASE_URL,
        'scenario_count': len(scenarios),
    }

    with sync_playwright() as playwright:
        browser = launch_browser(playwright, headed=headed)
        for name, steps in scenarios.items():
            context = browser.new_context(
                viewport={'width': 1440, 'height': 900},
                locale='zh-CN',
            )
            page = context.new_page()
            login_real_user(page)
            all_results.extend(run_scenario(page, name, steps, use_typing=use_typing))
            context.close()
        browser.close()

    meta['finished_at'] = datetime.now(timezone.utc).isoformat()
    meta['passed'] = sum(1 for item in all_results if item.ok)
    meta['total'] = len(all_results)
    report = {
        'meta': meta,
        'results': [asdict(row) for row in all_results],
    }
    REPORT_PATH.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(f'\nReport saved: {REPORT_PATH}')
    return print_report(all_results, meta)


if __name__ == '__main__':
    sys.exit(main())
