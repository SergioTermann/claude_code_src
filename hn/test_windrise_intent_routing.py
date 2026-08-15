import importlib.util
import json
import re
import subprocess
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack
from pathlib import Path
from unittest import TestCase
from unittest.mock import patch


MODULE_PATH = Path(__file__).with_name('dify_web_server_.py')
SPEC = importlib.util.spec_from_file_location('windrise_web_server', MODULE_PATH)
windrise = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(windrise)


def route_payload(**overrides):
    payload = {
        'mode': 'knowledge',
        'intent': 'repair',
        'fault_code': '303804',
        'should_search': True,
        'uses_history_fault_code': True,
        'current_problem_is_new': False,
        'rewritten_query': '故障码303804怎么处理',
        'direct_answer': '',
        'reason': '历史故障维修',
    }
    payload.update(overrides)
    return payload


def semantic_route_payload(rewritten_query, intent='repair', **overrides):
    return route_payload(
        intent=intent,
        fault_code='',
        should_search=True,
        uses_history_fault_code=False,
        current_problem_is_new=True,
        rewritten_query=rewritten_query,
        _model_routed=True,
        **overrides,
    )


def history_with_code(code='303804'):
    return [
        {'role': 'user', 'content': f'故障码{code}是什么故障'},
        {'role': 'assistant', 'content': f'故障码{code}的说明。'},
    ]


class WindriseIntentRoutingTest(TestCase):
    def test_device_measurement_with_scope_is_not_swallowed_as_dimension_ack(self):
        query = '团结风场SY37风机塔底控制柜温度'

        self.assertTrue(windrise.has_device_issue_hint(query))
        self.assertFalse(windrise.is_dimension_only_windrise_user_message(query))
        answer, reason = windrise.build_windrise_deterministic_preflight_answer(query, [])
        self.assertNotEqual(reason, 'in_process_dimension_ack')
        self.assertNotIn('已记录限定条件', answer)

    def test_new_fault_query_does_not_inherit_previous_issue_slots(self):
        q1 = '团结风场SY37风机塔底控制柜温度异常'
        q2 = '同发风场A32号风机SS-4刹车存储继电器'
        history = [
            {'role': 'user', 'content': q1},
            {'role': 'assistant', 'content': '**未找到精确匹配**\n\n本地知识库未找到与“塔底控制柜温度异常”匹配的精确记录。'},
        ]

        self.assertEqual(windrise.extract_scada_style_alarm_name(q2), 'SS-4刹车存储继电器')
        slots = windrise.build_effective_windrise_slots_for_query(q2, history)
        self.assertEqual(slots.get('farm'), '同发')
        self.assertEqual(slots.get('turbine_id'), 'A32#')
        self.assertIn('SS-4', slots.get('fault_name', ''))
        self.assertNotIn('塔底控制柜温度异常', slots.get('fault_name', ''))
        self.assertNotIn('温度异常', slots.get('symptom') or [])
        self.assertEqual(windrise.find_recent_fault_context_for_query(q2, history), {})

    def test_scada_alarm_lookup_after_unrelated_no_match_does_not_bleed_temperature_fault(self):
        q2 = '同发风场A32号风机SS-4刹车存储继电器'
        history = [
            {'role': 'user', 'content': '团结风场SY37风机塔底控制柜温度异常'},
            {'role': 'assistant', 'content': '**未找到精确匹配**\n\n本地知识库未找到与“塔底控制柜温度异常”匹配的精确记录。'},
        ]

        answer = windrise.build_index_scoped_fault_lookup_answer(q2, history)
        self.assertIn('SS-4', answer)
        self.assertNotIn('5205', answer)
        self.assertNotIn('塔底主控柜温度高', answer)

    def test_scope_only_reply_after_unrelated_fault_does_not_reuse_old_topic(self):
        history = [
            {'role': 'user', 'content': '团结风场SY37风机塔底控制柜温度异常'},
            {'role': 'assistant', 'content': '**未找到精确匹配**\n\n本地知识库未找到与“塔底控制柜温度异常”匹配的精确记录。'},
        ]

        self.assertEqual(
            windrise.build_windrise_scope_completion_query('同发风场A32号', history),
            '',
        )
        slots = windrise.build_effective_windrise_slots_for_query('A32号', history)
        self.assertEqual(slots.get('farm'), '')
        self.assertEqual(slots.get('turbine_id'), 'A32')

    def test_context_followup_still_inherits_prior_fault(self):
        history = [
            {'role': 'user', 'content': '同发风场A32号风机SS-4刹车存储继电器'},
            {'role': 'assistant', 'content': '5｜SS-4刹车存储继电器未复位\n对象：同发 / 华锐 / SL1500-ABB系列'},
        ]

        self.assertTrue(windrise.is_context_only_windrise_followup('这个怎么处理'))
        slots = windrise.build_effective_windrise_slots_for_query('这个怎么处理', history)
        self.assertIn('SS-4', slots.get('fault_name', ''))
        self.assertEqual(windrise.find_recent_fault_context_for_query('这个怎么处理', history).get('code'), '5')

    def test_new_symptom_after_prior_fault_does_not_bleed_old_code(self):
        history = [
            {'role': 'user', 'content': '同发风场A32号风机主PLC检测到从PLC通讯错误'},
            {'role': 'assistant', 'content': '**证据命中**\n【故障代码】272\n【故障名称】主PLC检测到从PLC通讯错误'},
            {'role': 'user', 'content': '同发风场A32号风机SS-4刹车存储继电器'},
            {'role': 'assistant', 'content': '**证据命中**\n【故障代码】5\n【故障名称】SS-4刹车存储继电器未复位'},
        ]
        query = '八面风场ZC05风机功率过低切出'

        self.assertEqual(
            windrise.build_windrise_contextual_fault_query(query, history),
            query,
        )
        self.assertEqual(windrise.find_recent_fault_context_for_query(query, history), {})
        with patch.object(windrise, 'call_windrise_semantic_router'):
            answer, route = windrise.build_windrise_response_payload(query, history)

        self.assertEqual(route.get('reason'), 'in_process_scoped_fault_lookup')
        self.assertIn('70029', answer)
        self.assertIn('发电状态下功率过低', answer)
        self.assertNotIn('SS-4刹车存储继电器', answer)
        self.assertNotIn('272', answer)

    def test_detect_windrise_new_case_switch_on_explicit_farm_change(self):
        history = [
            {'role': 'user', 'content': '团结风场SY37风机塔底控制柜温度异常'},
            {'role': 'assistant', 'content': '**未找到精确匹配**'},
        ]
        switched, reason = windrise.detect_windrise_new_case_switch(
            '同发风场A32号风机SS-4刹车存储继电器',
            history,
        )
        self.assertTrue(switched)
        self.assertEqual(reason, 'explicit_farm_switch')

    def test_farm_switch_resets_scope_history_and_retrieval_memory(self):
        history = [
            {'role': 'user', 'content': '八面风场ZC05风机功率过低切出'},
            {'role': 'assistant', 'content': '**证据命中**\n【故障代码】70029\n八面风场 ZC05'},
        ]
        query = '同发风场A32号风机主PLC检测到从PLC通讯错误'
        windrise.reset_windrise_request_context()
        windrise.windrise_request_context.conversation_id = 'conv-farm-switch'
        windrise.windrise_request_context.user_id = 'user-farm-switch'
        windrise.remember_windrise_retrieval_context(
            '八面风场ZC05风机功率过低切出',
            '70029 发电状态下功率过低',
            'conv-farm-switch',
            'user-farm-switch',
        )
        switched, _reason = windrise.detect_windrise_new_case_switch(query, history)
        self.assertTrue(switched)
        windrise.windrise_request_context.new_case_switch = True
        self.assertEqual(
            windrise.build_user_confirmed_windrise_scope_slots(query, history).get('farm'),
            '同发',
        )
        self.assertEqual(
            windrise.reusable_windrise_retrieval_context(query, history),
            '',
        )
        self.assertEqual(windrise.find_recent_fault_context_for_query(query, history), {})
        windrise.reset_windrise_request_context()

    def test_rewritten_symptom_keeps_new_farm_scope_before_history_append(self):
        """Rewritten bare symptoms must not inherit the previous farm before append."""
        history = [
            {'role': 'user', 'content': '八面风场D185号风机偏航误差过大'},
            {
                'role': 'assistant',
                'content': '**还差机型确认**\n\n已记住：风场=八面；风机编号=D185。',
            },
        ]
        query = '什花道风场Y48号风机风机等待运行就绪'
        rewritten = '等待运行就绪'

        windrise.reset_windrise_request_context()
        switched, reason = windrise.detect_windrise_new_case_switch(query, history)
        self.assertTrue(switched)
        self.assertEqual(reason, 'explicit_farm_switch')
        windrise.windrise_request_context.new_case_switch = True
        windrise.stash_windrise_active_scope_slots(query, history)

        slots = windrise.build_effective_windrise_slots_for_query(rewritten, history)
        self.assertEqual(slots.get('farm'), '什花道')
        self.assertEqual(slots.get('turbine_id'), 'Y48')
        self.assertNotEqual(slots.get('brand'), '中车山东')

        applied = windrise.apply_recent_user_dimension_to_windrise_query(rewritten, history)
        self.assertIn('什花道', applied)
        self.assertNotIn('八面', applied)
        windrise.reset_windrise_request_context()

    def test_symptom_followup_keeps_scope_but_not_old_fault(self):
        history = [
            {'role': 'user', 'content': '八面风场ZC05风机功率过低切出'},
            {'role': 'assistant', 'content': '**证据命中**\n【故障代码】70029\n【故障名称】发电状态下功率过低'},
        ]
        with patch.object(windrise, 'call_windrise_semantic_router'):
            answer, route = windrise.build_windrise_response_payload('功率过低切出', history)

        self.assertEqual(route.get('reason'), 'in_process_scoped_fault_lookup')
        self.assertIn('70029', answer)
        self.assertIn('八面', answer)
        self.assertIn('ZC05', answer)

    def test_cross_farm_scoped_symptom_followup_scenario_p(self):
        """Cross-farm history then bare symptom must keep the latest farm/turbine scope."""
        history = []
        steps = [
            (
                '同发风场A32号风机主PLC检测到从PLC通讯错误',
                {'must_have': ['272'], 'must_not_have': ['70029']},
            ),
            (
                '八面风场ZC05风机功率过低切出',
                {'must_have': ['70029', 'ZC05', '八面'], 'must_not_have': ['272', '华锐']},
            ),
            (
                '功率过低切出',
                {'must_have': ['70029', 'ZC05', '八面'], 'must_not_have': ['272', '华锐', 'SL1500']},
            ),
            (
                '齿轮箱油温高',
                {'must_have': ['60011', 'ZC05', '八面'], 'must_not_have': ['272', '华锐', '117']},
            ),
        ]
        with patch.object(windrise, 'call_windrise_semantic_router') as mock_router:
            mock_router.side_effect = lambda query, history: semantic_route_payload(
                f'{query}SL1500-ABB系列CWT4800-D185',
                intent='general',
            )
            for query, expectations in steps:
                scoped_query = windrise.build_windrise_symptom_scope_lookup_query(query, history)
                if scoped_query:
                    self.assertNotIn('SL1500', scoped_query)
                    self.assertNotIn('华锐', scoped_query)
                    self.assertFalse(
                        windrise.should_run_windrise_model_route_before_retrieval(query, history),
                        msg=f'{query} should skip semantic routing when scoped',
                    )
                answer, route = windrise.build_windrise_response_payload(query, history)
                for token in expectations['must_have']:
                    self.assertIn(token, answer, msg=f'{query} missing {token}')
                for token in expectations['must_not_have']:
                    self.assertNotIn(token, answer, msg=f'{query} leaked {token}')
                history.extend([
                    {'role': 'user', 'content': query},
                    {'role': 'assistant', 'content': answer},
                ])

    def test_clamp_semantic_rewrite_for_scoped_symptom_followup(self):
        history = [
            {'role': 'user', 'content': '八面风场ZC05风机功率过低切出'},
            {'role': 'assistant', 'content': '**证据命中**\n【故障代码】70029\n【故障名称】发电状态下功率过低'},
        ]
        polluted = '功率过低切出SL1500-ABB系列CWT4800-D185'
        clamped = windrise.clamp_windrise_semantic_rewritten_query('功率过低切出', history, polluted)
        self.assertIn('功率过低', clamped)
        self.assertNotIn('SL1500', clamped)
        self.assertNotIn('华锐', clamped)
        self.assertNotIn('ZC05', clamped)

    def test_merge_prefers_conversation_cache_turn_order(self):
        session_history = [
            {'role': 'user', 'content': '同发风场A32号风机主PLC检测到从PLC通讯错误'},
            {'role': 'user', 'content': '八面风场ZC05风机功率过低切出'},
            {'role': 'user', 'content': '功率过低切出'},
        ]
        cached_history = [
            {'role': 'user', 'content': '同发风场A32号风机主PLC检测到从PLC通讯错误'},
            {'role': 'assistant', 'content': '**证据命中**\n【故障代码】272'},
            {'role': 'user', 'content': '八面风场ZC05风机功率过低切出'},
            {'role': 'assistant', 'content': '**证据命中**\n【故障代码】70029\n【故障名称】发电状态下功率过低'},
        ]
        merged = windrise.merge_windrise_chat_histories(
            cached_history,
            [],
            session_history,
            '功率过低切出',
        )
        self.assertEqual([item['role'] for item in merged], ['user', 'assistant', 'user', 'assistant'])
        self.assertTrue(windrise.is_windrise_scoped_symptom_followup('功率过低切出', merged))
        scoped_query = windrise.build_windrise_symptom_scope_lookup_query('功率过低切出', merged)
        self.assertIn('功率过低', scoped_query)
        self.assertNotIn('SL1500', scoped_query)

    def test_merge_recovers_prior_user_turns_when_only_current_user_is_presaved(self):
        session_history = [
            {'role': 'user', 'content': '同发风场A32号风机主PLC检测到从PLC通讯错误'},
            {'role': 'user', 'content': '八面风场ZC05风机功率过低切出'},
            {'role': 'user', 'content': '功率过低切出'},
        ]
        merged = windrise.merge_windrise_chat_histories([], [], session_history, '功率过低切出')
        self.assertEqual(len(merged), 2)
        self.assertTrue(windrise.is_windrise_bare_symptom_with_confirmed_scope('功率过低切出', merged))

    def test_merge_ignores_future_polluted_cache_turns(self):
        session_history = [
            {'role': 'user', 'content': '同发风场A32号风机主PLC检测到从PLC通讯错误'},
            {'role': 'assistant', 'content': '**证据命中**\n【故障代码】272'},
            {'role': 'user', 'content': '八面风场ZC05风机功率过低切出'},
            {'role': 'assistant', 'content': '**证据命中**\n【故障代码】70029\n【故障名称】发电状态下功率过低'},
            {'role': 'user', 'content': '功率过低切出'},
        ]
        polluted_cache = session_history + [
            {'role': 'user', 'content': '齿轮箱油温高'},
            {'role': 'assistant', 'content': '**证据命中**\n【故障代码】272\n同发风场A32号风机主PLC通讯错误'},
        ]
        merged = windrise.merge_windrise_chat_histories(
            polluted_cache,
            [],
            session_history,
            '功率过低切出',
        )
        self.assertEqual([item['role'] for item in merged], ['user', 'assistant', 'user', 'assistant'])
        self.assertNotIn('齿轮箱油温高', [item.get('content', '') for item in merged])
        answer = windrise.resolve_windrise_scoped_symptom_preflight('功率过低切出', merged)[0] or ''
        self.assertIn('70029', answer)
        self.assertNotIn('未找到精确匹配', answer)

    def test_scoped_symptom_index_lookup_uses_confirmed_scope_slots(self):
        history = [
            {'role': 'user', 'content': '同发风场A32号风机主PLC检测到从PLC通讯错误'},
            {'role': 'user', 'content': '八面风场ZC05风机功率过低切出'},
            {'role': 'assistant', 'content': '70029 发电状态下功率过低 ZC05 八面'},
        ]
        answer = windrise.build_index_scoped_fault_lookup_answer('功率过低切出', history)
        self.assertIn('70029', answer)
        self.assertIn('ZC05', answer)
        self.assertNotIn('272', answer)

    def test_scoped_symptom_followup_after_scope_completion_flow(self):
        history = []
        steps = [
            '偏航回路欠压故障触发条件',
            '八面风场',
            'ZC09',
        ]
        with patch.object(windrise, 'call_windrise_semantic_router'):
            for query in steps:
                answer, _route = windrise.build_windrise_response_payload(query, history)
                history.extend([
                    {'role': 'user', 'content': query},
                    {'role': 'assistant', 'content': answer},
                ])
            answer, route = windrise.build_windrise_response_payload('齿轮箱油温高', history)

        self.assertEqual(route.get('reason'), 'in_process_scoped_fault_lookup')
        self.assertIn('60011', answer)
        self.assertIn('齿轮箱', answer)
        self.assertIn('ZC09', answer)
        self.assertNotIn('120014', answer)

    def test_scope_completion_survives_truncated_scope_prompts(self):
        history = [
            {'role': 'user', 'content': '偏航回路欠压故障触发条件'},
            {'role': 'assistant', 'content': '**先确认设备范围**'},
            {'role': 'user', 'content': '八面风场'},
            {'role': 'assistant', 'content': '**继续确认设备** 已记住：风场=八面。'},
        ]
        scope_completion = windrise.build_windrise_scope_completion_query('ZC09', history)
        self.assertIn('偏航回路欠压', scope_completion)
        self.assertIn('ZC09', scope_completion)
        self.assertFalse(
            windrise.should_answer_windrise_turbine_mapping_question('ZC09')
            and not windrise.is_windrise_fault_scope_guidance_relevant('ZC09', history)
        )
        answer, route = windrise.build_windrise_response_payload('ZC09', history)
        self.assertEqual(route.get('reason'), 'in_process_scoped_fault_lookup')
        self.assertIn('120014', answer)

    def test_context_only_followup_skips_semantic_router_when_recent_code_known(self):
        history = [
            {'role': 'user', 'content': '偏航回路欠压故障触发条件'},
            {'role': 'assistant', 'content': '**证据命中**\n【故障代码】120014\n【故障名称】偏航回路欠压'},
        ]
        self.assertFalse(
            windrise.should_run_windrise_model_route_before_retrieval('触发条件是什么', history),
        )
        answer, route = windrise.build_windrise_response_payload('触发条件是什么', history)
        self.assertIn('120014', answer)

    def test_xinhua_c23_mapping_then_converter_fault_finds_30201(self):
        history = [
            {'role': 'user', 'content': '新华风场 C23风机'},
            {
                'role': 'assistant',
                'content': (
                    '风机编号「C23#」对应 新华风电场 / 华仪 / HW2-S2000系列 / 具体型号：HW2/S1500(87)。'
                ),
            },
        ]
        query = '变频器网侧标记故障'
        scoped = windrise.build_windrise_symptom_scope_lookup_query(query, history)
        self.assertIn('变频器网侧标记', scoped)
        self.assertNotIn('HW2/S1500', scoped)
        answer, reason = windrise.resolve_windrise_scoped_symptom_preflight(query, history)
        self.assertEqual(reason, 'in_process_scoped_fault_lookup')
        self.assertIn('30201', answer)
        self.assertNotIn('未找到精确匹配', answer)

    def test_shihuadao_sy27_efc_signal_loss_maps_to_4171_not_comm_fault(self):
        history = [
            {'role': 'user', 'content': '什花道风电场SY27'},
            {
                'role': 'assistant',
                'content': (
                    '风机编号「SY27」对应 什花道风电场 / 三一 / 高速系列 / 具体型号：SE16033。'
                ),
            },
        ]
        query = '变桨轴1硬件EFC信号丢失'
        slots = windrise.build_effective_windrise_slots_for_query(query, history)
        self.assertIn('信号丢失', slots.get('symptom') or [])
        self.assertNotIn('断路', slots.get('symptom') or [])
        candidates, _, _, _ = windrise.collect_scoped_fault_index_candidates(query, history)
        self.assertTrue(candidates)
        self.assertEqual(candidates[0].get('code'), '4171')
        self.assertIn('EFC', candidates[0].get('name', ''))
        answer, reason = windrise.resolve_windrise_scoped_symptom_preflight(query, history)
        self.assertEqual(reason, 'in_process_scoped_fault_lookup')
        self.assertIn('4171', answer)
        self.assertIn('变桨轴1硬件EFC信号丢失', answer)
        self.assertNotIn('4160', answer.split('备选答案')[0])
        self.assertNotIn('自动模式下通讯故障', answer.split('备选答案')[0])
        self.assertIn('备选答案', answer)
        self.assertIn('4271', answer)
        self.assertIn('变桨轴2硬件EFC信号丢失', answer)

    def test_xinhua_f21_blade3_emergency_feathering_maps_to_15804(self):
        query = '新华风场F21风机桨叶3紧急顺桨模式'
        candidates, slots, _, _ = windrise.collect_scoped_fault_index_candidates(query, [])
        self.assertTrue(candidates)
        self.assertEqual(candidates[0].get('code'), '15804')
        self.assertEqual(slots.get('turbine_id'), 'F21#')
        self.assertEqual(slots.get('farm'), '新华')
        answer = windrise.build_index_scoped_fault_lookup_answer(query, [])
        self.assertIn('15804', answer)
        self.assertIn('桨叶3紧急顺桨模式', answer)
        self.assertIn('【报警】RP', answer)
        self.assertIn('【复位】MR', answer)
        self.assertNotIn('15819', answer.split('备选答案')[0])
        self.assertNotIn('手动允许超限', answer.split('备选答案')[0])

    def test_liangjingzi_my45_blade_a1_sync_maps_to_1404055(self):
        query = '良井子风场MY45风机变桨A1叶片同步故障'
        slots = windrise.build_effective_windrise_slots_for_query(query, [])
        self.assertEqual(slots.get('turbine_id'), 'MY45#')
        self.assertEqual(slots.get('farm'), '良井子')
        self.assertIn('不同步', slots.get('symptom') or [])
        candidates, _, topic, _ = windrise.collect_scoped_fault_index_candidates(query, [])
        self.assertTrue(candidates)
        self.assertIn('A1', topic)
        self.assertEqual(candidates[0].get('code'), '1404055')
        self.assertIn('桨叶1不同步', candidates[0].get('name', ''))
        answer = windrise.build_index_scoped_fault_lookup_answer(query, [])
        self.assertIn('1404055', answer)
        self.assertIn('桨叶1不同步', answer)
        self.assertNotIn('1401092', answer.split('备选答案')[0])
        self.assertNotIn('急停开关拍下', answer.split('备选答案')[0])

    def test_xinhua_f21_blade3_emergency_one_shot_preflight_maps_to_15804(self):
        query = '新华风场F21风机桨叶3紧急顺桨模式'
        self.assertFalse(windrise.is_dimension_only_windrise_user_message(query))
        preflight_answer, preflight_reason = windrise.build_windrise_deterministic_preflight_answer(query, [])
        self.assertEqual(preflight_reason, 'in_process_scoped_fault_lookup')
        self.assertIn('15804', preflight_answer)
        self.assertIn('桨叶3紧急顺桨模式', preflight_answer)
        self.assertNotIn('已记录限定条件', preflight_answer)

    def test_tongfa_a32_ss4_brake_one_shot_maps_to_5(self):
        query = '同发风场A32号风机 SS-4刹车存储继电器'
        self.assertFalse(windrise.is_dimension_only_windrise_user_message(query))
        preflight_answer, preflight_reason = windrise.build_windrise_deterministic_preflight_answer(query, [])
        self.assertEqual(preflight_reason, 'in_process_scoped_fault_lookup')
        self.assertIn('5', preflight_answer)
        self.assertIn('SS-4', preflight_answer)
        self.assertNotIn('已记录限定条件', preflight_answer)

    def test_bamian_farm_scope_supplement_searches_without_turbine(self):
        history = [
            {'role': 'user', 'content': '偏航回路欠压故障触发条件'},
            {'role': 'assistant', 'content': '**先确认设备范围**\n\n第一步请告诉我：这是哪个风场？'},
        ]
        query = '八面风场'
        answer, reason = windrise.resolve_windrise_fault_scope_followup_answer(query, history)
        self.assertEqual(reason, 'in_process_scoped_fault_lookup')
        self.assertIn('120014', answer)
        self.assertNotIn('具体风机编号', answer)

    def test_trigger_followup_keeps_recent_fault_code(self):
        history = [
            {'role': 'user', 'content': '偏航回路欠压故障触发条件'},
            {'role': 'assistant', 'content': 'scope'},
            {'role': 'user', 'content': '八面风场'},
            {'role': 'assistant', 'content': 'scope2'},
            {'role': 'user', 'content': 'ZC09'},
            {
                'role': 'assistant',
                'content': (
                    '**证据命中**\n【故障代码】120014\n'
                    '【故障名称】偏航回路欠压故障触发条件\n'
                    '【触发条件】\n机组偏航时液压偏航回路压力低于10bar持续3s'
                ),
            },
        ]
        answer, reason = windrise.build_windrise_deterministic_preflight_answer('触发条件是什么', history)
        self.assertIn(
            reason,
            {
                'deterministic_recent_fault_dimension_followup',
                'in_process_dimension_context_lookup',
            },
        )
        self.assertIn('120014', answer)
        self.assertNotIn('120008', answer.split('备选答案')[0])

    def test_c_scope_completion_trigger_followup_full_flow(self):
        history = []
        steps = [
            ('偏航回路欠压故障触发条件', '风场', None),
            ('八面风场', '120014', 'in_process_scoped_fault_lookup'),
            ('ZC09', '120014', 'in_process_scoped_fault_lookup'),
            ('触发条件是什么', '120014', None),
        ]
        with patch.object(windrise, 'call_windrise_semantic_router'):
            for query, must_have, expected_reason in steps:
                answer, route = windrise.build_windrise_response_payload(query, history)
                self.assertIn(must_have, answer or '', msg=query)
                if expected_reason:
                    self.assertEqual(route.get('reason'), expected_reason, msg=query)
                history.extend([
                    {'role': 'user', 'content': query},
                    {'role': 'assistant', 'content': answer or ''},
                ])
        self.assertNotIn('120008', (answer or '').split('备选答案')[0])

    def test_trigger_followup_ignores_alternative_answer_code_in_history(self):
        history = [
            {'role': 'user', 'content': 'ZC09'},
            {
                'role': 'assistant',
                'content': (
                    '**证据命中**\n【故障代码】120014\n【故障名称】偏航回路欠压\n'
                    '【触发条件】机组偏航时液压偏航回路压力低于10bar持续3s\n'
                    '备选答案**（次高相关，供现场核对）\n'
                    '故障代码:120008。故障名称:液压站持续欠压。'
                ),
            },
        ]
        with patch.object(windrise, 'call_windrise_semantic_router'):
            answer, route = windrise.build_windrise_response_payload('触发条件是什么', history)
        self.assertIn('120014', answer or '')
        self.assertNotIn('120008', (answer or '').split('备选答案')[0])

    def test_symptom_first_then_shihuadao_y08_keeps_scope_for_alarm_lookup(self):
        history = [
            {'role': 'user', 'content': '桨角积分判定风速过小'},
            {'role': 'assistant', 'content': '**先确认设备范围**'},
            {'role': 'user', 'content': '什花道风场Y08风机'},
            {
                'role': 'assistant',
                'content': (
                    '风机编号「Y08」对应 什花道风电场 / 远景 / NGP主控系列 / 具体型号：EN-156/3.3。'
                ),
            },
        ]
        query = '桨角积分判定风速过小'
        self.assertTrue(windrise.is_windrise_scoped_symptom_followup(query, history))
        slots = windrise.build_resolved_windrise_scope_slots(query, history)
        self.assertEqual(slots.get('farm'), '什花道')
        self.assertEqual(slots.get('turbine_id'), 'Y08')
        self.assertEqual(slots.get('standard_model'), 'EN-156/3.3')
        answer, reason = windrise.resolve_windrise_scoped_symptom_preflight(query, history)
        self.assertEqual(reason, 'in_process_scoped_fault_lookup_miss')
        self.assertIn('设备范围内未找到精确匹配', answer)
        self.assertIn('什花道', answer)
        self.assertIn('Y08', answer)
        self.assertIn('桨角积分判定风速过小', answer)
        self.assertNotIn('通用现场排查', answer)

    def test_alarm_style_symptom_counts_as_device_issue_hint(self):
        self.assertTrue(windrise.has_device_issue_hint('桨角积分判定风速过小'))
        self.assertTrue(windrise.has_device_issue_hint('变频器网侧标记故障'))

    def test_fault_first_then_xinhua_f28_resumes_scoped_6413_lookup(self):
        history = [
            {'role': 'user', 'content': '同步进行中超时待机'},
            {
                'role': 'assistant',
                'content': (
                    '6413 维修处理建议\n匹配到 2 条记录。\n'
                    '6413｜同步进行中超时待机\n厂家：运达 / 机型：WD2500系列\n'
                    '6413｜同步进行中超时\n厂家：运达 / 机型：WD1500系列 / 风场：新华'
                ),
            },
        ]
        query = '新华风场F28风机'
        self.assertFalse(windrise.extract_fault_codes(query))
        self.assertTrue(windrise.is_windrise_fault_scope_followup_reply(query, history))
        with patch.object(windrise, 'call_windrise_semantic_router'):
            answer, route = windrise.build_windrise_response_payload(query, history)
        self.assertEqual(route.get('reason'), 'in_process_scoped_fault_lookup')
        self.assertIn('6413', answer)
        self.assertIn('F28', answer)
        self.assertIn('新华', answer)
        self.assertIn('同步进行中超时', answer)
        self.assertNotIn('5111', answer)

    def test_scoped_symptom_followup_after_device_mapping(self):
        history = []
        with patch.object(windrise, 'call_windrise_semantic_router'):
            mapping_answer, mapping_route = windrise.build_windrise_response_payload(
                '八面风场ZC09风机',
                history,
            )
            history.extend([
                {'role': 'user', 'content': '八面风场ZC09风机'},
                {'role': 'assistant', 'content': mapping_answer},
            ])
            answer, route = windrise.build_windrise_response_payload('齿轮箱油温高', history)

        self.assertEqual(mapping_route.get('reason'), 'deterministic_device_mapping')
        self.assertEqual(route.get('reason'), 'in_process_scoped_fault_lookup')
        self.assertIn('60011', answer)
        self.assertIn('ZC09', answer)
        self.assertNotIn('120014', answer)

    def test_model_lookup_then_symptom_uses_confirmed_scope(self):
        history = []
        with patch.object(windrise, 'call_windrise_semantic_router'):
            mapping_answer, _mapping_route = windrise.build_windrise_response_payload(
                '同发风场A32是什么型号',
                history,
            )
            history.extend([
                {'role': 'user', 'content': '同发风场A32是什么型号'},
                {'role': 'assistant', 'content': mapping_answer},
            ])
            answer, route = windrise.build_windrise_response_payload(
                '主PLC检测到从PLC通讯错误',
                history,
            )

        self.assertEqual(route.get('reason'), 'in_process_scoped_fault_lookup')
        self.assertIn('272', answer)
        self.assertIn('A32', answer)
        self.assertIn('同发', answer)

    def test_multi_turn_conversation_sequence_does_not_bleed_fault_context(self):
        history = []
        steps = [
            (
                '同发风场A32号风机主PLC检测到从PLC通讯错误',
                {'must_have': ['272', '主PLC检测到从PLC通讯错误'], 'must_not_have': ['70029', 'SS-4']},
            ),
            (
                '同发风场A32号风机SS-4刹车存储继电器',
                {'must_have': ['5', 'SS-4'], 'must_not_have': ['272', '70029']},
            ),
            (
                '八面风场ZC05风机功率过低切出',
                {'must_have': ['70029', '发电状态下功率过低', 'ZC05'], 'must_not_have': ['SS-4', '272', '140002']},
            ),
            (
                '风机功率过低切出',
                {'must_have': ['70029', 'ZC05'], 'must_not_have': ['SS-4', '272', '140002']},
            ),
            (
                '功率过低切出',
                {'must_have': ['70029', '八面'], 'must_not_have': ['SS-4', '272', '140002']},
            ),
        ]
        with patch.object(windrise, 'call_windrise_semantic_router'):
            for query, expectations in steps:
                contextual = windrise.build_windrise_contextual_fault_query(query, history)
                self.assertNotRegex(contextual, r'故障码\s*5\b')
                self.assertNotRegex(contextual, r'故障码\s*272\b')
                answer, route = windrise.build_windrise_response_payload(query, history)
                for token in expectations['must_have']:
                    self.assertIn(token, answer, msg=f'{query} missing {token}')
                for token in expectations['must_not_have']:
                    self.assertNotIn(token, answer, msg=f'{query} leaked {token}')
                history.extend([
                    {'role': 'user', 'content': query},
                    {'role': 'assistant', 'content': answer},
                ])

    def test_user_reported_conversation_ss4_then_plc_then_bamian(self):
        """Reproduce exported chat: SS-4 first, then PLC comm fault, then Bamian power issue."""
        history = []
        steps = [
            (
                '同发风场A32号风机 SS-4刹车存储继电器',
                {'must_have': ['5', 'SS-4'], 'must_not_have': ['272', '70029']},
            ),
            (
                '同发风场A32号风机主PLC检测到从PLC通讯错误',
                {'must_have': ['272', '主PLC检测到从PLC通讯错误'], 'must_not_have': ['SS-4', '故障码 5', '故障码5']},
            ),
            (
                '八面风场ZC05风机 功率过低切出',
                {'must_have': ['70029', '发电状态下功率过低', 'ZC05'], 'must_not_have': ['SS-4', '故障码5', '同发风电场']},
            ),
            (
                '故障码5922是什么',
                {'must_have': ['5922', '小风正常停机'], 'must_not_have': ['SS-4', '272', '70029']},
            ),
            (
                '1200010',
                {'must_have': ['1200010', '风速低于限值'], 'must_not_have': ['5922', 'SS-4']},
            ),
        ]
        with patch.object(windrise, 'call_windrise_semantic_router'):
            for query, expectations in steps:
                contextual = windrise.build_windrise_contextual_fault_query(query, history)
                self.assertNotRegex(contextual, r'故障码\s*5\b')
                answer, route = windrise.build_windrise_response_payload(query, history)
                for token in expectations['must_have']:
                    self.assertIn(token, answer, msg=f'{query} missing {token}')
                for token in expectations['must_not_have']:
                    self.assertNotIn(token, answer, msg=f'{query} leaked {token}')
                history.extend([
                    {'role': 'user', 'content': query},
                    {'role': 'assistant', 'content': answer},
                ])

    def test_conversation_history_isolated_by_user_with_same_conversation_id(self):
        conversation_id = 'shared-conversation-id'
        with windrise.conversation_lock:
            windrise.conversation_histories.clear()
            windrise.hydrated_conversations.clear()

        windrise.add_to_conversation_history(conversation_id, 'user-a', 'user', '用户甲的问题')
        windrise.add_to_conversation_history(conversation_id, 'user-b', 'user', '用户乙的问题')

        history_a = windrise.get_conversation_history(conversation_id, 'user-a')
        history_b = windrise.get_conversation_history(conversation_id, 'user-b')
        self.assertEqual(history_a[-1]['content'], '用户甲的问题')
        self.assertEqual(history_b[-1]['content'], '用户乙的问题')

    def test_logout_clears_in_memory_windrise_state_for_user(self):
        user_id = 'logout-user'
        conversation_id = 'conv-logout'
        with windrise.conversation_lock:
            windrise.windrise_lightweight_histories.clear()
            windrise.windrise_yaw_hydraulic_stages.clear()
        with windrise.windrise_retrieval_memory_lock:
            windrise.windrise_retrieval_memories.clear()

        windrise.remember_windrise_retrieval_context(
            '故障码A', '用户甲的知识库结果', conversation_id, user_id=user_id
        )
        windrise.add_to_windrise_lightweight_history(
            conversation_id, 'user', '用户甲的问题', user_id=user_id
        )
        windrise.forget_windrise_user_transient_state(user_id)

        self.assertIsNone(windrise.get_windrise_retrieval_context(conversation_id, user_id=user_id))
        self.assertEqual(
            windrise.get_windrise_lightweight_history(conversation_id, user_id=user_id),
            [],
        )

    def test_transient_chat_state_is_isolated_by_user_and_conversation(self):
        conversation_id = 'shared-conversation-id'
        with windrise.conversation_lock:
            windrise.windrise_lightweight_histories.clear()
            windrise.windrise_yaw_hydraulic_stages.clear()
        with windrise.windrise_retrieval_memory_lock:
            windrise.windrise_retrieval_memories.clear()

        windrise.add_to_windrise_lightweight_history(
            conversation_id, 'user', '用户甲的问题', user_id='user-a'
        )
        windrise.add_to_windrise_lightweight_history(
            conversation_id, 'user', '用户乙的问题', user_id='user-b'
        )
        windrise.set_windrise_yaw_hydraulic_stage(
            conversation_id, 'await_motor_count', user_id='user-a'
        )
        windrise.remember_windrise_retrieval_context(
            '故障码A', '用户甲的知识库结果', conversation_id, user_id='user-a'
        )

        self.assertEqual(
            windrise.get_windrise_lightweight_history(conversation_id, user_id='user-a')[0]['content'],
            '用户甲的问题',
        )
        self.assertEqual(
            windrise.get_windrise_lightweight_history(conversation_id, user_id='user-b')[0]['content'],
            '用户乙的问题',
        )
        self.assertEqual(
            windrise.get_windrise_yaw_hydraulic_stage(conversation_id, user_id='user-a'),
            'await_motor_count',
        )
        self.assertEqual(
            windrise.get_windrise_yaw_hydraulic_stage(conversation_id, user_id='user-b'),
            '',
        )
        self.assertEqual(
            windrise.get_windrise_retrieval_context(conversation_id, user_id='user-a')['answer'],
            '用户甲的知识库结果',
        )
        self.assertIsNone(
            windrise.get_windrise_retrieval_context(conversation_id, user_id='user-b')
        )

    def test_session_context_rejects_conversation_id_bound_to_another_session(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = str(Path(tmpdir) / 'chat_users.db')
            credentials_path = str(Path(tmpdir) / 'bootstrap_admin_credentials.txt')
            with patch.object(windrise, 'DATABASE_FILE', db_path), \
                    patch.object(windrise, 'BOOTSTRAP_ADMIN_CREDENTIALS_FILE', credentials_path):
                windrise.init_db()
                conn = windrise.get_db_connection()
                try:
                    cursor = conn.cursor()
                    cursor.execute(
                        "INSERT INTO sessions (user_id, session_id, title) VALUES (?, ?, ?)",
                        (1, 'conv-a', '会话A'),
                    )
                    cursor.execute(
                        "INSERT INTO sessions (user_id, session_id, title) VALUES (?, ?, ?)",
                        (1, '', '会话B'),
                    )
                    session_b_id = cursor.lastrowid
                    conn.commit()
                finally:
                    conn.close()

                app_session_id, conversation_id = windrise.resolve_chat_context_from_session(
                    {'session_id': session_b_id, 'conversation_id': 'conv-a'},
                    '1',
                    allow_new_conversation_id=False,
                )

                self.assertEqual(app_session_id, session_b_id)
                self.assertEqual(conversation_id, '')

                conn = windrise.get_db_connection()
                try:
                    cursor = conn.cursor()
                    cursor.execute('SELECT session_id FROM sessions WHERE id = ?', (session_b_id,))
                    self.assertEqual(cursor.fetchone()['session_id'], '')
                finally:
                    conn.close()

    def test_stream_exception_persists_visible_fallback_before_message_end(self):
        saved = []

        def save_conversation(_conversation_id, _user_id, role, content):
            saved.append((role, content))

        with ExitStack() as stack:
            stack.enter_context(patch.object(windrise, 'ensure_windrise_conversation_id', return_value='conv'))
            stack.enter_context(patch.object(windrise, 'load_app_session_history', return_value=[]))
            stack.enter_context(patch.object(windrise, 'get_conversation_history', return_value=[]))
            stack.enter_context(patch.object(windrise, 'get_windrise_lightweight_history', return_value=[]))
            stack.enter_context(patch.object(windrise, 'add_to_conversation_history', side_effect=save_conversation))
            stack.enter_context(patch.object(windrise, 'add_to_windrise_lightweight_history'))
            stack.enter_context(patch.object(windrise, 'update_windrise_yaw_hydraulic_stage'))
            stack.enter_context(patch.object(windrise, 'build_windrise_conversational_fault_clarification', return_value=''))
            stack.enter_context(patch.object(windrise, 'build_windrise_fault_scope_clarification', return_value=''))
            stack.enter_context(patch.object(windrise, 'build_windrise_scope_completion_query', return_value=''))
            stack.enter_context(patch.object(windrise, 'build_windrise_deterministic_preflight_answer', return_value=('', '')))
            stack.enter_context(patch.object(windrise, 'should_run_windrise_model_route_before_retrieval', return_value=False))
            stack.enter_context(patch.object(
                windrise,
                'build_effective_windrise_slots_for_query',
                side_effect=RuntimeError('forced stream failure'),
            ))
            stack.enter_context(patch.object(windrise, 'WINDRISE_SHOW_THINKING_STATUS', False))
            stack.enter_context(patch.object(windrise, 'WINDRISE_STREAM_CHUNK_DELAY', 0))

            with windrise.app.test_request_context('/api/chat'):
                response = windrise.call_windrise_app(
                    '团结风场SY37风机塔底控制柜温度',
                    'conv',
                    'user-a',
                    None,
                    True,
                )
                body_parts = []
                for chunk in response.response:
                    text = chunk.decode() if isinstance(chunk, bytes) else chunk
                    body_parts.append(text)
                    if '"event": "message_end"' in text:
                        self.assertTrue(any(role == 'assistant' and content for role, content in saved))
                body = ''.join(body_parts)

        self.assertEqual(body.count('"event": "message_end"'), 1)
        self.assertNotIn('"event": "error"', body)
        self.assertIn('当前问题', body)

    def test_model_timeout_is_capped_by_whole_request_deadline(self):
        previous_deadline = getattr(windrise.windrise_request_context, 'deadline', None)
        try:
            windrise.windrise_request_context.deadline = windrise.time.monotonic() + 1.0
            fake_response = type('Response', (), {
                'status_code': 200,
                'json': lambda self: {'choices': [{'message': {'content': 'ok'}}]},
            })()
            with patch.object(windrise.http_session, 'post', return_value=fake_response) as post:
                self.assertEqual(
                    windrise.call_chat_model([{'role': 'user', 'content': 'test'}], timeout=45),
                    'ok',
                )
            applied_timeout = post.call_args.kwargs['timeout']
            self.assertGreater(applied_timeout, 0)
            self.assertLessEqual(applied_timeout, 1.0)
        finally:
            if previous_deadline is None:
                try:
                    del windrise.windrise_request_context.deadline
                except AttributeError:
                    pass
            else:
                windrise.windrise_request_context.deadline = previous_deadline

    def test_streaming_explicit_lookup_uses_sse_generation_after_retrieval(self):
        blocking_payload = None
        extractor = None
        with ExitStack() as stack:
            stack.enter_context(patch.object(windrise, 'ensure_windrise_conversation_id', return_value='conv'))
            stack.enter_context(patch.object(windrise, 'load_app_session_history', return_value=[]))
            stack.enter_context(patch.object(windrise, 'get_conversation_history', return_value=[]))
            stack.enter_context(patch.object(windrise, 'get_windrise_lightweight_history', return_value=[]))
            stack.enter_context(patch.object(windrise, 'add_to_conversation_history'))
            stack.enter_context(patch.object(windrise, 'add_to_windrise_lightweight_history'))
            stack.enter_context(patch.object(windrise, 'update_windrise_yaw_hydraulic_stage'))
            stack.enter_context(patch.object(windrise, 'build_windrise_fault_scope_clarification', return_value=''))
            stack.enter_context(patch.object(windrise, 'build_windrise_scope_completion_query', return_value=''))
            model_route = stack.enter_context(patch.object(
                windrise,
                'call_windrise_semantic_router',
                return_value=semantic_route_payload('偏航回路欠压', intent='repair'),
            ))
            stack.enter_context(patch.object(windrise, 'build_windrise_yaw_hydraulic_stage_answer', return_value=''))
            stack.enter_context(patch.object(windrise, 'find_recent_fault_context_from_history', return_value={}))
            stack.enter_context(patch.object(windrise, 'has_current_explicit_windrise_task', return_value=True))
            stack.enter_context(patch.object(windrise, 'has_specific_current_diagnosis_subject', return_value=False))
            stack.enter_context(patch.object(
                windrise,
                'build_effective_windrise_slots_for_query',
                return_value={'farm': '八面', 'brand': '中车山东', 'model': 'CWT系列'},
            ))
            stack.enter_context(patch.object(windrise, 'is_windrise_general_knowledge_question', return_value=False))
            stack.enter_context(patch.object(windrise, 'build_windrise_direct_chat_answer', return_value=''))
            index_lookup = stack.enter_context(patch.object(
                windrise,
                'build_index_scoped_fault_lookup_answer_with_fallback',
                return_value='',
            ))
            stack.enter_context(patch.object(windrise, 'is_explicit_fault_name_lookup_query', return_value=True))
            stack.enter_context(patch.object(windrise, 'is_explicit_fault_action_lookup_query', return_value=False))
            stack.enter_context(patch.object(
                windrise,
                'iter_windrise_knowledge_augmented_answer',
                return_value=iter(['第一段', '第二段']),
            ))
            blocking_payload = stack.enter_context(patch.object(windrise, 'build_windrise_response_payload'))
            stack.enter_context(patch.object(windrise, 'WINDRISE_SHOW_THINKING_STATUS', True))
            stack.enter_context(patch.object(windrise, 'WINDRISE_STREAM_CHUNK_DELAY', 0))
            stack.enter_context(patch.object(windrise, 'WINDRISE_PROGRESS_STEP_DELAY', 0))

            with windrise.app.test_request_context('/api/chat'):
                response = windrise.call_windrise_app(
                    '八面风场CWT偏航回路欠压故障',
                    'conv',
                    'user',
                    None,
                    True,
                )
                body = response.get_data(as_text=True)

        self.assertIn('正在提取知识库检索内容...', body)
        self.assertIn('正在查找知识库：偏航回路欠压...', body)
        self.assertIn('正在核对知识库命中结果与当前问题...', body)
        self.assertIn('正在组织结论、依据和处理建议...', body)
        self.assertIn('"answer": "第一段"', body)
        self.assertIn('"answer": "第二段"', body)
        self.assertLess(body.index('第一段'), body.index('第二段'))
        self.assertLess(body.index('正在提取知识库检索内容'), body.index('正在查找知识库'))
        self.assertLess(body.index('正在查找知识库'), body.index('正在核对知识库命中结果'))
        self.assertLess(body.index('正在核对知识库命中结果'), body.index('正在组织结论'))
        self.assertLess(body.index('正在组织结论'), body.index('第一段'))
        model_route.assert_called_once_with(
            '八面风场CWT偏航回路欠压故障',
            [],
        )
        index_lookup.assert_called_once_with(
            '八面风场CWT偏航回路欠压故障',
            '八面风场CWT偏航回路欠压故障',
            [],
            intent='repair',
        )
        blocking_payload.assert_not_called()

    def test_streaming_lookup_falls_back_to_local_index_when_model_extraction_fails(self):
        with ExitStack() as stack:
            stack.enter_context(patch.object(windrise, 'ensure_windrise_conversation_id', return_value='conv'))
            stack.enter_context(patch.object(windrise, 'load_app_session_history', return_value=[]))
            stack.enter_context(patch.object(windrise, 'get_conversation_history', return_value=[]))
            stack.enter_context(patch.object(windrise, 'get_windrise_lightweight_history', return_value=[]))
            stack.enter_context(patch.object(windrise, 'add_to_conversation_history'))
            stack.enter_context(patch.object(windrise, 'add_to_windrise_lightweight_history'))
            stack.enter_context(patch.object(windrise, 'build_windrise_fault_scope_clarification', return_value=''))
            stack.enter_context(patch.object(windrise, 'build_windrise_scope_completion_query', return_value=''))
            stack.enter_context(patch.object(
                windrise,
                'call_windrise_semantic_router',
                side_effect=RuntimeError('model unavailable'),
            ))
            index_lookup = stack.enter_context(patch.object(
                windrise,
                'build_index_scoped_fault_lookup_answer_with_fallback',
                return_value='1900003｜SC_叶片结冰\n处理：按厂家规程停机并确认无甩冰风险。',
            ))
            stack.enter_context(patch.object(windrise, 'WINDRISE_SHOW_THINKING_STATUS', True))
            stack.enter_context(patch.object(windrise, 'WINDRISE_STREAM_CHUNK_DELAY', 0))
            stack.enter_context(patch.object(windrise, 'WINDRISE_PROGRESS_STEP_DELAY', 0))

            with windrise.app.test_request_context('/api/chat'):
                response = windrise.call_windrise_app(
                    '八面风场ZC09偏航回路欠压怎么处理',
                    'conv',
                    'user',
                    None,
                    True,
                )
                body = response.get_data(as_text=True)

        self.assertNotIn('暂时无法通过大模型提取知识库检索内容', body)
        self.assertNotIn('本次未执行知识库检索', body)
        self.assertIn('1900003｜SC_叶片结冰', body)
        self.assertIn('message_end', body)
        index_lookup.assert_called_once()

    def test_slow_model_route_does_not_block_fast_local_index(self):
        model_started = threading.Event()
        release_model = threading.Event()

        def slow_model_route(_query, _history):
            model_started.set()
            release_model.wait(timeout=5.0)
            return semantic_route_payload('叶片结冰', intent='repair')

        with ExitStack() as stack:
            stack.enter_context(patch.object(windrise, 'ensure_windrise_conversation_id', return_value='conv'))
            stack.enter_context(patch.object(windrise, 'load_app_session_history', return_value=[]))
            stack.enter_context(patch.object(windrise, 'get_conversation_history', return_value=[]))
            stack.enter_context(patch.object(windrise, 'get_windrise_lightweight_history', return_value=[]))
            stack.enter_context(patch.object(windrise, 'add_to_conversation_history'))
            stack.enter_context(patch.object(windrise, 'add_to_windrise_lightweight_history'))
            stack.enter_context(patch.object(windrise, 'update_windrise_yaw_hydraulic_stage'))
            stack.enter_context(patch.object(windrise, 'build_windrise_fault_scope_clarification', return_value=''))
            stack.enter_context(patch.object(windrise, 'build_windrise_scope_completion_query', return_value=''))
            stack.enter_context(patch.object(windrise, 'call_windrise_semantic_router', side_effect=slow_model_route))
            stack.enter_context(patch.object(
                windrise,
                'build_index_scoped_fault_lookup_answer_with_fallback',
                return_value='1900003｜SC_叶片结冰\n处理：保持停机并设置甩冰警戒区。',
            ))
            stack.enter_context(patch.object(windrise, 'WINDRISE_SHOW_THINKING_STATUS', False))
            stack.enter_context(patch.object(windrise, 'WINDRISE_STREAM_CHUNK_DELAY', 0))

            started_at = time.monotonic()
            with windrise.app.test_request_context('/api/chat'):
                response = windrise.call_windrise_app(
                    '叶片结冰怎么办',
                    'conv',
                    'user',
                    None,
                    True,
                )
                body = response.get_data(as_text=True)
            elapsed = time.monotonic() - started_at
            release_model.set()

        self.assertTrue(model_started.is_set())
        self.assertLess(elapsed, 1.5)
        self.assertIn('1900003｜SC_叶片结冰', body)
        self.assertEqual(body.count('"event": "message_end"'), 1)

    def test_streaming_explicit_fault_code_skips_model_extraction_and_uses_index(self):
        with ExitStack() as stack:
            stack.enter_context(patch.object(windrise, 'ensure_windrise_conversation_id', return_value='conv'))
            stack.enter_context(patch.object(windrise, 'load_app_session_history', return_value=[]))
            stack.enter_context(patch.object(windrise, 'get_conversation_history', return_value=[]))
            stack.enter_context(patch.object(windrise, 'get_windrise_lightweight_history', return_value=[]))
            stack.enter_context(patch.object(windrise, 'add_to_conversation_history'))
            stack.enter_context(patch.object(windrise, 'add_to_windrise_lightweight_history'))
            stack.enter_context(patch.object(windrise, 'update_windrise_yaw_hydraulic_stage'))
            stack.enter_context(patch.object(windrise, 'build_windrise_fault_scope_clarification', return_value=''))
            stack.enter_context(patch.object(windrise, 'build_windrise_scope_completion_query', return_value=''))
            model_route = stack.enter_context(patch.object(windrise, 'call_windrise_semantic_router'))
            index_lookup = stack.enter_context(patch.object(
                windrise,
                'build_index_scoped_fault_lookup_answer_with_fallback',
                return_value='303804｜变桨电机转速超限\n处理：检查编码器。',
            ))
            stack.enter_context(patch.object(windrise, 'WINDRISE_SHOW_THINKING_STATUS', True))
            stack.enter_context(patch.object(windrise, 'WINDRISE_STREAM_CHUNK_DELAY', 0))
            stack.enter_context(patch.object(windrise, 'WINDRISE_PROGRESS_STEP_DELAY', 0))

            with windrise.app.test_request_context('/api/chat'):
                response = windrise.call_windrise_app(
                    '故障码303804怎么处理',
                    'conv',
                    'user',
                    None,
                    True,
                )
                body = response.get_data(as_text=True)

        self.assertIn('正在查找知识库：故障码303804怎么处理...', body)
        self.assertNotIn('正在提取知识库检索内容...', body)
        self.assertIn('303804｜变桨电机转速超限', body)
        model_route.assert_not_called()
        index_lookup.assert_called_once_with(
            '故障码303804怎么处理',
            '故障码303804怎么处理',
            [],
            intent='repair',
        )

    def test_streaming_message_end_survives_assistant_persistence_failure(self):
        def save_conversation(_conversation_id, _user_id, role, _content):
            if role == 'assistant':
                raise RuntimeError('database temporarily locked')

        with ExitStack() as stack:
            stack.enter_context(patch.object(windrise, 'ensure_windrise_conversation_id', return_value='conv'))
            stack.enter_context(patch.object(windrise, 'load_app_session_history', return_value=[]))
            stack.enter_context(patch.object(windrise, 'get_conversation_history', return_value=[]))
            stack.enter_context(patch.object(windrise, 'get_windrise_lightweight_history', return_value=[]))
            stack.enter_context(patch.object(
                windrise, 'add_to_conversation_history', side_effect=save_conversation
            ))
            stack.enter_context(patch.object(windrise, 'add_to_windrise_lightweight_history'))
            stack.enter_context(patch.object(windrise, 'update_windrise_yaw_hydraulic_stage'))
            stack.enter_context(patch.object(windrise, 'build_windrise_fault_scope_clarification', return_value=''))
            stack.enter_context(patch.object(windrise, 'build_windrise_scope_completion_query', return_value=''))
            stack.enter_context(patch.object(
                windrise,
                'build_index_scoped_fault_lookup_answer_with_fallback',
                return_value='120014｜偏航回路欠压\n处理：检查偏航液压回路。',
            ))
            stack.enter_context(patch.object(windrise, 'WINDRISE_SHOW_THINKING_STATUS', False))
            stack.enter_context(patch.object(windrise, 'WINDRISE_STREAM_CHUNK_DELAY', 0))

            with windrise.app.test_request_context('/api/chat'):
                response = windrise.call_windrise_app(
                    '故障码120014怎么处理',
                    'conv',
                    'user',
                    None,
                    True,
                )
                body = response.get_data(as_text=True)

        self.assertIn('120014｜偏航回路欠压', body)
        self.assertIn('"event": "message_end"', body)
        self.assertNotIn('"event": "error"', body)

    def test_direct_fault_code_repair_answer_leads_with_name_and_action(self):
        answer, code = windrise.build_explicit_fault_code_exact_answer('故障码120014怎么处理', [])

        self.assertEqual(code, '120014')
        self.assertTrue(answer.startswith('**故障码 120014：偏航回路欠压**'))
        self.assertIn('结论：故障码 120014 表示“偏航回路欠压”', answer)
        self.assertIn('处理建议：检查液压站偏航回路,手动调整偏航回路压力值', answer)
        self.assertIn('**知识库记录**', answer)

    def test_direct_fault_code_trigger_answer_leads_with_name_and_condition(self):
        answer, code = windrise.build_explicit_fault_code_exact_answer('120014的触发条件是什么', [])

        self.assertEqual(code, '120014')
        self.assertTrue(answer.startswith('**故障码 120014：偏航回路欠压**'))
        self.assertIn('结论：故障码 120014 表示“偏航回路欠压”', answer)
        self.assertIn('触发条件：机组偏航时液压偏航回路压力低于10bar持续3s', answer)
        self.assertIn('**知识库记录**', answer)

    def test_streaming_turbine_mapping_resolves_model_before_extraction_and_index(self):
        query = '八面风场ZC09风机偏航回路欠压故障触发条件是什么'
        with ExitStack() as stack:
            stack.enter_context(patch.object(windrise, 'ensure_windrise_conversation_id', return_value='conv'))
            stack.enter_context(patch.object(windrise, 'load_app_session_history', return_value=[]))
            stack.enter_context(patch.object(windrise, 'get_conversation_history', return_value=[]))
            stack.enter_context(patch.object(windrise, 'get_windrise_lightweight_history', return_value=[]))
            stack.enter_context(patch.object(windrise, 'add_to_conversation_history'))
            stack.enter_context(patch.object(windrise, 'add_to_windrise_lightweight_history'))
            stack.enter_context(patch.object(windrise, 'update_windrise_yaw_hydraulic_stage'))
            model_route = stack.enter_context(patch.object(
                windrise,
                'call_windrise_semantic_router',
                return_value=semantic_route_payload('偏航回路欠压', intent='trigger'),
            ))
            index_lookup = stack.enter_context(patch.object(
                windrise,
                'build_index_scoped_fault_lookup_answer_with_fallback',
                return_value='120014｜偏航回路欠压\n触发条件：压力低于10bar持续3s',
            ))
            stack.enter_context(patch.object(windrise, 'WINDRISE_SHOW_THINKING_STATUS', True))
            stack.enter_context(patch.object(windrise, 'WINDRISE_STREAM_CHUNK_DELAY', 0))
            stack.enter_context(patch.object(windrise, 'WINDRISE_PROGRESS_STEP_DELAY', 0))

            with windrise.app.test_request_context('/api/chat'):
                response = windrise.call_windrise_app(
                    query,
                    'conv',
                    'user',
                    None,
                    True,
                )
                body = response.get_data(as_text=True)

        self.assertIn('正在提取知识库检索内容...', body)
        self.assertIn('正在查找知识库', body)
        self.assertIn('120014｜偏航回路欠压', body)
        self.assertNotIn('还差机型确认', body)
        model_route.assert_called_once_with(query, [])
        index_lookup.assert_called_once()

    def test_streaming_broad_bearing_issue_stays_conversational(self):
        history = [
            {'role': 'user', 'content': '八面风场ZC09风机偏航回路欠压故障触发条件是什么'},
            {'role': 'assistant', 'content': '120014｜偏航回路欠压，风场：八面，风机编号：ZC09。'},
        ]
        with ExitStack() as stack:
            stack.enter_context(patch.object(windrise, 'ensure_windrise_conversation_id', return_value='conv'))
            stack.enter_context(patch.object(windrise, 'load_app_session_history', return_value=history))
            stack.enter_context(patch.object(windrise, 'get_conversation_history', return_value=[]))
            stack.enter_context(patch.object(windrise, 'get_windrise_lightweight_history', return_value=[]))
            stack.enter_context(patch.object(windrise, 'add_to_conversation_history'))
            stack.enter_context(patch.object(windrise, 'add_to_windrise_lightweight_history'))
            stack.enter_context(patch.object(windrise, 'update_windrise_yaw_hydraulic_stage'))
            model_route = stack.enter_context(patch.object(windrise, 'call_windrise_semantic_router'))
            index_lookup = stack.enter_context(patch.object(
                windrise,
                'build_index_scoped_fault_lookup_answer_with_fallback',
            ))
            stack.enter_context(patch.object(windrise, 'WINDRISE_SHOW_THINKING_STATUS', True))
            stack.enter_context(patch.object(windrise, 'WINDRISE_STREAM_CHUNK_DELAY', 0))
            stack.enter_context(patch.object(windrise, 'WINDRISE_PROGRESS_STEP_DELAY', 0))

            with windrise.app.test_request_context('/api/chat'):
                response = windrise.call_windrise_app(
                    '轴承温度异常怎么处理',
                    'conv',
                    'user',
                    None,
                    True,
                )
                body = response.get_data(as_text=True)

        self.assertIn('主轴、齿轮箱和发电机轴承', body)
        self.assertNotIn('匹配到', body)
        model_route.assert_not_called()
        index_lookup.assert_not_called()

    def test_required_extraction_calls_model_even_when_optional_switch_is_off(self):
        model_result = json.dumps({
            'farm': '八面',
            'turbine_id': 'ZC09',
            'fault_code': '',
            'symptom': '偏航回路欠压',
            'rewritten_query': '八面风场 ZC09 偏航回路欠压',
            'confidence': 'high',
        }, ensure_ascii=False)
        previous_extracted = getattr(windrise.windrise_request_context, 'retrieval_query_extracted', False)
        try:
            with patch.object(windrise, 'WINDRISE_QUERY_CONSOLIDATOR_ENABLED', False), patch.object(
                windrise, 'is_windrise_llm_temporarily_unavailable', return_value=False
            ), patch.object(
                windrise, 'build_effective_windrise_slots_for_query', return_value={}
            ), patch.object(windrise, 'call_chat_model', return_value=model_result) as model:
                rewritten, _, _ = windrise.consolidate_windrise_user_query(
                    '帮我查八面ZC09偏航回路欠压',
                    [],
                    force=True,
                    required=True,
                )

            prompt = model.call_args.args[0][1]['content']
            self.assertEqual(rewritten, '偏航回路欠压')
            self.assertTrue(windrise.windrise_request_context.retrieval_query_extracted)
            self.assertIn('已确认故障码 > 精确故障名称 > 部件加用户原始核心现象', prompt)
            self.assertIn('风场、风机编号、厂家、机型只填写各自 JSON 字段', prompt)
            self.assertIn('应输出「偏航回路欠压」', prompt)
            model.assert_called_once()
        finally:
            windrise.windrise_request_context.retrieval_query_extracted = previous_extracted

    def test_required_extraction_resolves_vague_followup_from_full_context(self):
        history = [
            {'role': 'user', 'content': '八面风场ZC09报303804'},
            {
                'role': 'assistant',
                'content': '故障码：303804，故障名称：偏航回路欠压，风场：八面，风机编号：ZC09，具体型号：CWT4800-D185。',
            },
        ]
        model_result = json.dumps({
            'brand': '中车山东',
            'farm': '八面',
            'turbine_id': 'ZC09',
            'model': 'CWT系列',
            'standard_model': 'CWT4800-D185',
            'fault_code': '303804',
            'component': '偏航系统',
            'fault_name': '偏航回路欠压',
            'symptom': '',
            'intent': 'repair',
            'rewritten_query': '八面风场 ZC09 CWT4800-D185 303804 偏航回路欠压',
            'confidence': 'high',
        }, ensure_ascii=False)
        slots = {
            'brand': '中车山东',
            'farm': '八面',
            'turbine_id': 'ZC09',
            'standard_model': 'CWT4800-D185',
            'fault_code': '303804',
            'fault_name': '偏航回路欠压',
        }
        recent_context = {
            'code': '303804',
            'name': '偏航回路欠压',
            'site': '八面',
            'standard_model': 'CWT4800-D185',
            'turbine_id': 'ZC09',
        }
        previous_extracted = getattr(windrise.windrise_request_context, 'retrieval_query_extracted', False)
        try:
            with patch.object(
                windrise, 'is_windrise_llm_temporarily_unavailable', return_value=False
            ), patch.object(
                windrise, 'build_effective_windrise_slots_for_query', return_value=slots
            ), patch.object(
                windrise, 'find_recent_fault_context_from_history', return_value=recent_context
            ), patch.object(windrise, 'call_chat_model', return_value=model_result) as model:
                rewritten, merged, _ = windrise.consolidate_windrise_user_query(
                    '这个怎么处理',
                    history,
                    force=True,
                    required=True,
                )

            prompt = model.call_args.args[0][1]['content']
            self.assertEqual(
                rewritten,
                '303804',
            )
            self.assertEqual(merged['fault_code'], '303804')
            self.assertIn('当前用户输入：这个怎么处理', prompt)
            self.assertIn('Windrise：故障码：303804', prompt)
            self.assertIn('最近故障对象：故障码=303804', prompt)
        finally:
            windrise.windrise_request_context.retrieval_query_extracted = previous_extracted

    def test_low_level_retrieval_is_blocked_without_required_extraction(self):
        previous_enforced = getattr(windrise.windrise_request_context, 'enforce_retrieval_extraction', False)
        previous_extracted = getattr(windrise.windrise_request_context, 'retrieval_query_extracted', False)
        try:
            windrise.windrise_request_context.enforce_retrieval_extraction = True
            windrise.windrise_request_context.retrieval_query_extracted = False
            with self.assertRaisesRegex(RuntimeError, 'retrieval extraction unavailable'):
                windrise.run_windrise_answer(['search', '303804'])
        finally:
            windrise.windrise_request_context.enforce_retrieval_extraction = previous_enforced
            windrise.windrise_request_context.retrieval_query_extracted = previous_extracted

    def test_background_retrieval_disconnects_cli_stdin(self):
        previous_enforced = getattr(windrise.windrise_request_context, 'enforce_retrieval_extraction', False)
        previous_extracted = getattr(windrise.windrise_request_context, 'retrieval_query_extracted', False)
        try:
            windrise.windrise_request_context.enforce_retrieval_extraction = True
            windrise.windrise_request_context.retrieval_query_extracted = True
            completed = type('Completed', (), {
                'returncode': 0,
                'stdout': '本地答案：测试结果',
                'stderr': '',
            })()
            with patch.object(windrise, 'resolve_windrise_bin', return_value='/bin/echo'), patch.object(
                windrise, 'direct_windrise_retrieval_memory_hit', return_value=''
            ), patch.object(windrise, 'WINDRISE_SEARCH_CACHE_TTL', 0), patch.object(
                windrise.subprocess, 'run', return_value=completed
            ) as run:
                windrise.run_windrise_answer(['search', '303804'])

            self.assertIs(run.call_args.kwargs['stdin'], subprocess.DEVNULL)
        finally:
            windrise.windrise_request_context.enforce_retrieval_extraction = previous_enforced
            windrise.windrise_request_context.retrieval_query_extracted = previous_extracted

    def test_fault_query_without_scope_guides_farm_first_without_llm(self):
        query = '偏航回路欠压故障触发条件'
        with patch.object(windrise, 'WINDRISE_SEMANTIC_ROUTER_ENABLED', False), patch.object(
            windrise, 'WINDRISE_QUERY_CONSOLIDATOR_ENABLED', False
        ), patch.object(windrise, 'call_chat_model') as model:
            answer, route = windrise.build_windrise_response_payload(query, [])

        self.assertEqual(route['reason'], 'missing_windrise_scope_dimensions')
        self.assertIn('哪个风场', answer)
        self.assertIn('八面风场', answer)
        model.assert_not_called()

    def test_scope_guidance_progresses_farm_then_searches_without_turbine(self):
        query = '偏航回路欠压故障触发条件'
        answer1, _ = windrise.build_windrise_response_payload(query, [])
        history1 = [
            {'role': 'user', 'content': query},
            {'role': 'assistant', 'content': answer1},
            {'role': 'user', 'content': '八面风场'},
        ]
        answer2, route2 = windrise.build_windrise_response_payload('八面风场', history1[:-1])
        self.assertEqual(route2['reason'], 'in_process_scoped_fault_lookup')
        self.assertIn('120014', answer2)
        self.assertNotIn('具体风机编号', answer2)

        history2 = history1 + [{'role': 'assistant', 'content': answer2}]
        with patch.object(
            windrise,
            'call_windrise_semantic_router',
            return_value=semantic_route_payload('偏航回路欠压', intent='trigger'),
        ) as model_route:
            answer3, route3 = windrise.build_windrise_response_payload('ZC09', history2)

        self.assertIn(route3['intent'], {'trigger', 'meaning'})
        self.assertIn('ZC09', answer3)
        self.assertIn('触发条件：机组偏航时液压偏航回路压力低于10bar持续3s', answer3)
        model_route.assert_called_once()

    def test_zhenlai_huari_gearbox_pump_mismatch_one_shot_without_turbine(self):
        query = '镇赉风场华锐风机齿轮箱低速泵输出和反馈不一致'
        clarification = windrise.build_windrise_fault_scope_clarification(query, [])
        self.assertEqual(clarification, '')
        answer, route = windrise.build_windrise_response_payload(query, [])
        self.assertIn(route.get('reason'), {
            'in_process_scoped_fault_lookup',
            'in_process_explicit_fault_code',
        })
        self.assertIn('125', answer or '')
        self.assertIn('齿轮箱低速泵输出和反馈不一致', answer or '')

    def test_unknown_turbine_id_after_scope_prompt_still_searches(self):
        query = '镇赉风场华锐风机齿轮箱低速泵输出和反馈不一致'
        history = [
            {'role': 'user', 'content': query},
            {
                'role': 'assistant',
                'content': (
                    '**继续确认设备**\n\n已记住：风场=镇赉；厂家=华锐。\n\n'
                    '下一步请告诉我具体风机编号，例如“ZC09”。'
                ),
            },
        ]
        answer, reason = windrise.resolve_windrise_fault_scope_followup_answer('不知道编号', history)
        self.assertEqual(reason, 'in_process_scoped_fault_lookup')
        self.assertIn('125', answer)
        self.assertIn('齿轮箱低速泵输出和反馈不一致', answer)

    def test_reused_turbine_id_requires_farm_instead_of_first_match(self):
        self.assertIsNone(windrise.lookup_windrise_turbine_mapping('A01#'))
        answer = windrise.build_windrise_fault_scope_clarification('A01#风机偏航故障', [])
        self.assertIn('哪个风场', answer)
        self.assertIn('同发', answer)
        self.assertIn('新华', answer)

    def test_unique_turbine_id_resolves_farm_and_model_without_prompt(self):
        query = 'ZC09风机偏航回路欠压故障触发条件是什么'

        resolved = windrise.build_resolved_windrise_scope_slots(query, [])
        clarification = windrise.build_windrise_fault_scope_clarification(query, [])
        with patch.object(
            windrise,
            'call_windrise_semantic_router',
            return_value=semantic_route_payload('偏航回路欠压', intent='trigger'),
        ):
            answer, route = windrise.build_windrise_response_payload(query, [])

        self.assertEqual(resolved['farm'], '八面')
        self.assertEqual(resolved['standard_model'], 'CWT4800-D185')
        self.assertEqual(clarification, '')
        self.assertEqual(route['fault_code'], '120014')
        self.assertIn('120014｜偏航回路欠压', answer)

    def test_model_suffix_device_name_resolves_without_model_prompt(self):
        query = '八面风场D185号风机偏航误差过大'
        resolved = windrise.build_resolved_windrise_scope_slots(query, [])
        clarification = windrise.build_windrise_fault_scope_clarification(query, [])

        self.assertEqual(resolved.get('farm'), '八面')
        self.assertEqual(resolved.get('standard_model'), 'CWT4800-D185')
        self.assertEqual(resolved.get('brand'), '中车山东')
        self.assertEqual(resolved.get('model'), 'CWT系列')
        self.assertEqual(resolved.get('turbine_id'), '')
        self.assertIn('turbine_id', resolved.get('_unavailable_dimensions') or [])
        self.assertEqual(clarification, '')

    def test_partial_model_index_resolves_incomplete_cwt_wording(self):
        query = '八面风场CWT4800风机偏航误差过大'
        resolved = windrise.build_resolved_windrise_scope_slots(query, [])
        clarification = windrise.build_windrise_fault_scope_clarification(query, [])

        self.assertEqual(resolved.get('farm'), '八面')
        self.assertEqual(resolved.get('brand'), '中车山东')
        self.assertIn(resolved.get('model'), ('CWT4800', 'CWT系列'))
        self.assertTrue(resolved.get('_model_index_resolved'))
        self.assertNotIn('还差机型确认', clarification or '')

    def test_model_index_fuzzy_matches_partial_standard_model_in_records(self):
        slots = {
            'farm': '八面',
            'brand': '中车山东',
            'model': 'CWT系列',
            'standard_model': 'CWT4800',
            'turbine_id': '',
        }
        matched = [
            record
            for record in windrise.load_windrise_fault_index_records()
            if windrise.record_matches_explicit_windrise_slots(record, slots)
        ]
        self.assertTrue(matched)
        self.assertTrue(
            any(
                'CWT4800-D185' in (record.get('standardModel') or '')
                for record in matched
            )
        )

    def test_lookup_windrise_model_index_supports_family_alias(self):
        matches = windrise.lookup_windrise_model_index(['CWT'], '八面')
        self.assertTrue(matches)
        self.assertEqual(matches[0][1].get('model'), 'CWT系列')

    def test_turbine_mapping_fills_model_without_extra_prompt(self):
        slots = {
            'farm': '八面',
            'turbine_id': 'ZC09',
            'brand': '',
            'model': '',
            'standard_model': '',
        }
        self.assertTrue(windrise.has_windrise_scope_for_fault_answer(slots))
        history = [
            {'role': 'user', 'content': '偏航回路欠压故障触发条件'},
            {'role': 'assistant', 'content': '**先确认设备范围**'},
            {'role': 'user', 'content': '八面风场'},
            {'role': 'assistant', 'content': '**继续确认设备** 已记住：风场=八面。'},
        ]
        clarification = windrise.build_windrise_fault_scope_clarification('ZC09', history)
        self.assertEqual(clarification, '')

    def test_explicitly_unavailable_model_uses_remaining_scope(self):
        query = '八面风场ZC09风机偏航回路欠压故障触发条件是什么'
        clarification = windrise.build_windrise_fault_scope_clarification(query, [])
        history = [
            {'role': 'user', 'content': query},
            {'role': 'assistant', 'content': clarification},
        ]

        with patch.object(
            windrise,
            'call_windrise_semantic_router',
            return_value=semantic_route_payload('偏航回路欠压', intent='trigger'),
        ):
            answer, route = windrise.build_windrise_response_payload('型号无法提供', history)

        self.assertEqual(route['reason'], 'in_process_scoped_fault_lookup')
        self.assertTrue(route['should_search'])
        self.assertIn('暂时无法提供机型/具体型号', answer)
        self.assertIn('120014｜偏航回路欠压', answer)
        self.assertIn('触发条件：机组偏航时液压偏航回路压力低于10bar持续3s', answer)

    def test_generic_unavailable_reply_waives_the_dimension_just_requested(self):
        query = '八面风场ZZ99风机偏航回路欠压故障触发条件是什么'
        clarification = windrise.build_windrise_fault_scope_clarification(query, [])
        history = [
            {'role': 'user', 'content': query},
            {'role': 'assistant', 'content': clarification},
        ]

        slots = windrise.build_user_confirmed_windrise_scope_slots('这个不知道', history)

        self.assertEqual(slots['farm'], '八面')
        self.assertEqual(slots['turbine_id'], 'ZZ99')
        self.assertIn('model', slots['_unavailable_dimensions'])
        self.assertTrue(windrise.has_windrise_scope_for_fault_answer(slots))

    def test_new_turbine_prompt_assigns_generic_unavailability_to_turbine_id(self):
        clarification = (
            '这次请告诉我新的风机编号；如果现场确实无法提供编号，直接说“风机编号无法提供”，'
            '我会按当前已知信息列出相关结果。'
        )
        history = [
            {'role': 'user', 'content': '轴承温度异常怎么处理'},
            {'role': 'user', 'content': '是四平的风场'},
            {'role': 'assistant', 'content': clarification},
        ]

        slots = windrise.build_user_confirmed_windrise_scope_slots('无法提供', history)

        self.assertEqual(
            windrise.infer_windrise_scope_dimension_from_clarification(clarification),
            'turbine_id',
        )
        self.assertEqual(slots['farm'], '四平')
        self.assertEqual(slots.get('turbine_id', ''), '')
        self.assertIn('turbine_id', slots['_unavailable_dimensions'])

    def test_broad_scope_request_uses_known_conditions_without_requiring_model(self):
        turbine_prompt = (
            '这次请告诉我新的风机编号；如果现场确实无法提供编号，直接说“风机编号无法提供”，'
            '我会按当前已知信息列出相关结果。'
        )
        history = [
            {'role': 'user', 'content': '轴承温度异常怎么处理'},
            {'role': 'user', 'content': '是四平的风场'},
            {'role': 'assistant', 'content': turbine_prompt},
            {'role': 'user', 'content': '无法提供'},
            {'role': 'assistant', 'content': '还差机型确认，请回复现场设备的厂家和机型。'},
        ]
        query = '中车山东的，相关的都给我列出来'

        slots = windrise.build_user_confirmed_windrise_scope_slots(query, history)
        clarification = windrise.build_windrise_fault_scope_clarification(query, history)

        self.assertTrue(windrise.is_windrise_broad_scope_search_request(query))
        self.assertTrue(slots['_broad_scope_requested'])
        self.assertEqual(slots['farm'], '四平')
        self.assertEqual(slots['brand'], '中车山东')
        self.assertEqual(slots.get('turbine_id', ''), '')
        self.assertIn('turbine_id', slots['_unavailable_dimensions'])
        self.assertIn('model', slots['_unavailable_dimensions'])
        self.assertEqual(clarification, '')

    def test_broad_scope_request_lists_candidates_even_when_more_scope_would_help(self):
        query = '中车山东的，相关的都给我列出来'
        history = [
            {'role': 'user', 'content': '轴承温度异常怎么处理'},
            {'role': 'user', 'content': '是四平的风场'},
            {'role': 'assistant', 'content': '请告诉我新的风机编号。'},
            {'role': 'user', 'content': '无法提供'},
            {'role': 'assistant', 'content': '还差机型确认。'},
        ]
        records = [
            {
                'code': '20006',
                'name': '主轴轴承温度过高告警',
                'site': '四平',
                'brand': '中车山东',
                'model': 'CWT系列',
                'standardModel': 'CWT4800-D185',
                'turbineIds': '',
                'solution': '检查传感器。',
                'source': 'test.md:1',
                '_score': 100,
                '_topic_score': 60,
            },
            {
                'code': '20007',
                'name': '主轴轴承温度过高停机',
                'site': '四平',
                'brand': '中车山东',
                'model': 'CWT系列',
                'standardModel': 'CWT4800-D185',
                'turbineIds': '',
                'solution': '检查冷却系统。',
                'source': 'test.md:2',
                '_score': 98,
                '_topic_score': 58,
            },
        ]
        with patch.object(
            windrise, 'collect_scoped_fault_index_candidates',
            return_value=(records, {'farm': '四平', 'brand': '中车山东'}, '轴承温度异常', False),
        ), patch.object(windrise, 'should_ask_for_more_windrise_dimensions', return_value=True):
            answer = windrise.build_index_scoped_fault_lookup_answer(query, history)

        self.assertIn('不再继续追问风机编号或机型', answer)
        self.assertIn('20006｜主轴轴承温度过高告警', answer)
        self.assertIn('20007｜主轴轴承温度过高停机', answer)

    def test_broad_scope_no_intersection_returns_actionable_result_after_model_route(self):
        turbine_prompt = '这次请告诉我新的风机编号；如果现场确实无法提供编号，直接说“风机编号无法提供”。'
        history = [
            {'role': 'user', 'content': '轴承温度异常怎么处理'},
            {'role': 'user', 'content': '是四平的风场'},
            {'role': 'assistant', 'content': turbine_prompt},
            {'role': 'user', 'content': '无法提供'},
            {'role': 'assistant', 'content': '还差机型确认。'},
        ]
        semantic_route = route_payload(
            intent='repair',
            fault_code='',
            uses_history_fault_code=False,
            current_problem_is_new=False,
            rewritten_query='轴承温度异常',
            _model_routed=True,
        )
        with patch.object(
            windrise, 'call_windrise_semantic_router', return_value=semantic_route
        ) as model_route, patch.object(
            windrise, 'build_index_scoped_fault_lookup_answer', return_value=''
        ), patch.object(
            windrise, 'build_fault_phenomenon_candidates_answer', return_value=''
        ), patch.object(
            windrise, 'run_windrise_answer', return_value='No matches'
        ), patch.object(
            windrise,
            'call_chat_model',
            return_value='**结论**\n建议先核对风场和厂家是否匹配，再按轴承温度异常做通用排查。',
        ):
            answer, route = windrise.build_windrise_response_payload(
                '中车山东的，相关的都给我列出来', history
            )

        self.assertEqual(route['reason'], 'broad_scope_no_match')
        self.assertTrue(route['should_search'])
        self.assertIn('建议先核对风场和厂家是否匹配', answer)
        model_route.assert_called_once()

    def test_plc_comm_fault_returns_full_kb_inspection_steps(self):
        query = '同发风场A32号风机主PLC检测到从PLC通讯错误'
        with patch.object(windrise, 'call_windrise_semantic_router'):
            answer, route = windrise.build_windrise_response_payload(query, [])

        self.assertEqual(route['reason'], 'in_process_scoped_fault_lookup')
        self.assertIn('**证据命中**', answer)
        self.assertIn('【对象确认】', answer)
        self.assertIn('同发风电场', answer)
        self.assertIn('A32#', answer)
        self.assertIn('272', answer)
        self.assertIn('主PLC检测到从PLC通讯错误', answer)
        self.assertIn('【检查/处理（按顺序）】', answer)
        self.assertIn('检查从站PLC供电是否正常', answer)
        self.assertIn('检查从站PLC到交换机之间的网线是否正常', answer)
        self.assertIn('【持续报警时】', answer)
        self.assertIn('【依据】', answer)
        self.assertIn('机组映射 + fault-index 交叉核对', answer)

    def test_slave_plc_comm_fault_prefers_code_273(self):
        query = '同发风场A32号风机从PLC检测到从PLC通讯错误'
        with patch.object(windrise, 'call_windrise_semantic_router'):
            answer, route = windrise.build_windrise_response_payload(query, [])

        self.assertEqual(route['reason'], 'in_process_scoped_fault_lookup')
        self.assertIn('273', answer)
        self.assertIn('从PLC检测到从PLC通讯错误', answer)

    def test_cross_verify_fault_record_for_tongfa_a32(self):
        slots = windrise.build_effective_windrise_slots_for_query(
            '同发风场A32号风机主PLC检测到从PLC通讯错误',
            [],
        )
        mapping_entry = windrise.lookup_windrise_turbine_mapping('A32#', '同发')
        records = windrise.load_windrise_fault_index_records()
        target = next(
            record for record in records
            if windrise.normalize_context_dimension_value(record.get('code', '')) == '272'
            and '主PLC检测到从PLC通讯错误' in windrise.normalize_text(record.get('name', ''))
        )
        verification = windrise.cross_verify_fault_record(target, slots, mapping_entry)
        self.assertTrue(verification['passed'])
        self.assertTrue(verification['site_covers_farm'])
        self.assertTrue(verification['turbine_covers_id'])

    def test_device_correction_clears_stale_turbine_and_acknowledges_switch(self):
        history = [
            {'role': 'user', 'content': '八面风场ZC09风机偏航回路欠压故障触发条件是什么'},
            {'role': 'assistant', 'content': '120014｜偏航回路欠压，风场：八面，风机编号：ZC09。'},
            {'role': 'user', 'content': '轴承温度异常怎么处理'},
            {'role': 'assistant', 'content': '匹配到多条轴承温度异常记录。'},
            {'role': 'user', 'content': '是四平的风场'},
            {'role': 'assistant', 'content': '还需要确认机型，已记住风场=四平、风机编号=ZC09。'},
        ]
        query = '不是ZC09了，是四平风场相关的问题'

        slots = windrise.build_user_confirmed_windrise_scope_slots(query, history)
        with patch.object(windrise, 'call_chat_model') as model, patch.object(
            windrise, 'run_windrise_answer'
        ) as knowledge_lookup:
            answer, route = windrise.build_windrise_response_payload(query, history)

        self.assertEqual(slots['farm'], '四平')
        self.assertNotIn('turbine_id', slots)
        self.assertEqual(route['reason'], 'missing_windrise_scope_dimensions')
        self.assertIn('已切换到四平风场', answer)
        self.assertIn('已清除上一轮的风机编号 ZC09', answer)
        self.assertIn('新的风机编号', answer)
        self.assertNotIn('风机编号=ZC09', answer)
        model.assert_not_called()
        knowledge_lookup.assert_not_called()

    def test_farm_switch_alone_clears_previous_turbine_without_second_correction(self):
        history = [
            {'role': 'user', 'content': '八面风场ZC09风机偏航回路欠压故障触发条件是什么'},
            {'role': 'assistant', 'content': '120014｜偏航回路欠压，风场：八面，风机编号：ZC09。'},
            {'role': 'user', 'content': '轴承温度异常怎么处理'},
            {'role': 'assistant', 'content': '匹配到多条轴承温度异常记录。'},
        ]

        answer, route = windrise.build_windrise_response_payload('是四平的风场', history)

        self.assertEqual(route['reason'], 'missing_windrise_scope_dimensions')
        self.assertIn('已切换到四平风场', answer)
        self.assertIn('已清除上一轮的风机编号 ZC09', answer)
        self.assertIn('新的风机编号', answer)

    def test_broad_bearing_temperature_issue_gets_conversational_clarification(self):
        history = [
            {'role': 'user', 'content': '八面风场ZC09风机偏航回路欠压故障触发条件是什么'},
            {'role': 'assistant', 'content': '120014｜偏航回路欠压，风场：八面，风机编号：ZC09。'},
        ]
        with patch.object(windrise, 'call_chat_model') as model, patch.object(
            windrise, 'run_windrise_answer'
        ) as knowledge_lookup:
            answer, route = windrise.build_windrise_response_payload('轴承温度异常怎么处理', history)

        self.assertEqual(route['reason'], 'ambiguous_fault_needs_clarification')
        self.assertFalse(route['should_search'])
        self.assertIn('主轴、齿轮箱和发电机轴承', answer)
        self.assertIn('具体是哪个轴承/测点', answer)
        self.assertIn('当前温度', answer)
        self.assertIn('八面风场 ZC09', answer)
        self.assertNotIn('匹配到', answer)
        model.assert_not_called()
        knowledge_lookup.assert_not_called()

    def test_concrete_cwt_model_is_recognized_from_plain_user_text(self):
        slots = windrise.extract_windrise_user_slots('中车山东 CWT4800-D185')
        self.assertEqual(slots['brand'], '中车山东')
        self.assertEqual(slots['model'], 'CWT4800-D185')

    def test_turbine_id_is_not_misclassified_as_fault_code(self):
        slots = windrise.extract_windrise_user_slots('ZC09')
        self.assertEqual(slots['turbine_id'], 'ZC09')
        self.assertEqual(slots['fault_code'], '')

    def test_turbine_range_mapping_resolves_exact_unit(self):
        self.assertEqual(
            windrise.expand_windrise_turbine_id_expression('ZC09-ZC11&#10'),
            ['ZC09', 'ZC10', 'ZC11'],
        )
        mapping = windrise.lookup_windrise_turbine_mapping('ZC09', '八面')
        self.assertEqual(mapping['standardModel'], 'CWT4800-D185')

    def test_explicit_farm_turbine_resolves_model_and_uses_index(self):
        query = '八面风场ZC09风机偏航回路欠压故障触发条件'
        semantic_route = route_payload(
            intent='trigger',
            fault_code='',
            uses_history_fault_code=False,
            current_problem_is_new=True,
            rewritten_query='偏航回路欠压',
            _model_routed=True,
        )
        with patch.object(
            windrise, 'call_windrise_semantic_router', return_value=semantic_route
        ) as model_route:
            answer, route = windrise.build_windrise_response_payload(query, [])

        resolved = windrise.build_resolved_windrise_scope_slots(query, [])
        self.assertEqual(resolved['standard_model'], 'CWT4800-D185')
        self.assertEqual(route['fault_code'], '120014')
        self.assertIn('120014｜偏航回路欠压', answer)
        self.assertIn('触发条件：机组偏航时液压偏航回路压力低于10bar持续3s', answer)
        model_route.assert_called_once()

    def test_explicit_farm_turbine_model_trigger_query_uses_index_after_model_route(self):
        query = '八面风场ZC09中车山东CWT4800-D185风机偏航回路欠压故障触发条件'
        semantic_route = route_payload(
            intent='trigger',
            fault_code='',
            uses_history_fault_code=False,
            current_problem_is_new=True,
            rewritten_query='偏航回路欠压',
            _model_routed=True,
        )
        with patch.object(
            windrise, 'call_windrise_semantic_router', return_value=semantic_route
        ) as model_route:
            answer, route = windrise.build_windrise_response_payload(query, [])

        self.assertEqual(route['fault_code'], '120014')
        self.assertIn('120014｜偏航回路欠压', answer)
        self.assertIn('触发条件：机组偏航时液压偏航回路压力低于10bar持续3s', answer)
        model_route.assert_called_once()

    def test_original_query_index_fallback_survives_overconstrained_model_rewrite(self):
        original = '八面风场ZC09风机偏航回路欠压故障触发条件是什么'
        extracted = '八面 ZC09 中车山东 CWT4800-D185 偏航 偏航回路欠压故障 压力低、欠压'

        answer = windrise.build_index_scoped_fault_lookup_answer_with_fallback(
            original,
            extracted,
            [],
        )

        self.assertIn('120014｜偏航回路欠压', answer)
        self.assertIn('触发条件：机组偏航时液压偏航回路压力低于10bar持续3s', answer)

    def test_query_consolidation_deduplicates_terms_and_preserves_trigger_intent(self):
        model_result = json.dumps({
            'farm': '八面',
            'turbine_id': 'ZC09',
            'brand': '中车山东',
            'standard_model': 'CWT4800-D185',
            'component': '偏航',
            'fault_name': '偏航回路欠压故障',
            'symptom': '压力低、欠压',
            'intent': 'general',
            'rewritten_query': '八面 ZC09 中车山东 CWT4800-D185 偏航 偏航回路欠压故障 压力低、欠压',
            'confidence': 'high',
        }, ensure_ascii=False)
        with patch.object(
            windrise, 'is_windrise_llm_temporarily_unavailable', return_value=False
        ), patch.object(
            windrise, 'build_effective_windrise_slots_for_query', return_value={}
        ), patch.object(windrise, 'call_chat_model', return_value=model_result):
            rewritten, _, note = windrise.consolidate_windrise_user_query(
                '八面风场ZC09风机偏航回路欠压故障触发条件是什么',
                [],
                force=True,
                required=True,
            )

        self.assertEqual(rewritten, '偏航回路欠压故障')
        self.assertEqual(note, f'已理解您的问题为：{rewritten}')

    def test_semantic_router_prompt_uses_llmwiki_high_hit_query_format(self):
        prompt = windrise.build_windrise_semantic_router_prompt(
            '八面风场ZC09风机偏航回路欠压故障触发条件是什么',
            [],
            '',
        )

        self.assertIn('LLM Wiki 高命中格式', prompt)
        self.assertIn('rewritten_query="偏航回路欠压"', prompt)
        self.assertIn('不得加入“八面、ZC09、厂家、机型、压力低”等字段', prompt)
        self.assertIn('knowledge/trigger', prompt)

    def test_single_semantic_pass_skips_query_consolidator(self):
        with patch.object(windrise, 'WINDRISE_SINGLE_SEMANTIC_PASS', True):
            self.assertFalse(
                windrise.should_run_windrise_query_semantic_analysis(
                    '团结风场那台风机最近总是异常',
                    [],
                    {'farm': '团结', 'turbine_id': '', 'fault_code': ''},
                )
            )

    def test_single_semantic_pass_skips_second_semantic_model_call(self):
        previous = getattr(windrise.windrise_request_context, 'semantic_pass_used', False)
        windrise.windrise_request_context.semantic_pass_used = True
        try:
            with patch.object(windrise, 'WINDRISE_SINGLE_SEMANTIC_PASS', True), patch.object(
                windrise, 'looks_like_fault_phenomenon_query', return_value=True
            ), patch.object(windrise, 'call_chat_model') as model:
                result = windrise.call_windrise_fault_semantic_normalizer(
                    '齿轮箱有点不对劲', {'component': '齿轮箱'}
                )
            self.assertEqual(result, {})
            model.assert_not_called()
        finally:
            windrise.windrise_request_context.semantic_pass_used = previous

    def test_knowledge_synthesis_uses_real_vllm_stream(self):
        prepared = {
            'messages': [
                {'role': 'system', 'content': 'system'},
                {'role': 'user', 'content': 'knowledge'},
            ]
        }
        with patch.object(
            windrise, 'prepare_windrise_knowledge_augmented_answer', return_value=prepared
        ), patch.object(
            windrise, 'iter_chat_model_stream', return_value=iter(['第一段', '第二段'])
        ) as stream_model, patch.object(windrise, 'call_chat_model') as blocking_model:
            chunks = list(
                windrise.iter_windrise_knowledge_augmented_answer(
                    '怎么处理', [], ['search', '303804'], {'force_synthesis': True}
                )
            )

        self.assertEqual(chunks, ['第一段', '第二段'])
        stream_model.assert_called_once()
        blocking_model.assert_not_called()

    def test_retrieval_memory_is_injected_once_for_synthesis(self):
        remembered = '唯一检索资料：团结风场 YD16 金风 GW82-1500 故障码303804'
        route = {
            'force_synthesis': True,
            'uses_history_fault_code': True,
            'fault_code': '303804',
            'rewritten_query': '303804为什么会报',
            'reason': 'deterministic_recent_fault_followup',
        }
        with patch.object(
            windrise, 'reusable_windrise_retrieval_context', return_value=remembered
        ), patch.object(windrise, 'run_windrise_answer') as search:
            prepared = windrise.prepare_windrise_knowledge_augmented_answer(
                '为什么会报', history_with_code(), ['search', '303804'], route
            )

        prompt_text = '\n'.join(item['content'] for item in prepared['messages'])
        self.assertEqual(prompt_text.count(remembered), 1)
        search.assert_not_called()

    def test_heuristic_classification_boundaries(self):
        self.assertEqual(windrise.heuristic_classify_question('你好'), 1)
        self.assertEqual(windrise.heuristic_classify_question('风机报警了'), 2)
        self.assertEqual(windrise.heuristic_classify_question('发电机轴承温度高'), 2)
        self.assertEqual(windrise.heuristic_classify_question('发电机轴承温度85度且持续上升'), 3)
        self.assertEqual(windrise.heuristic_classify_question('E0025报警'), 3)

    def test_code_with_alarm_suffix_routes_to_retrieval(self):
        route = windrise.build_windrise_semantic_router_fallback('E0025报警！', [])
        self.assertEqual(route['mode'], 'knowledge')
        self.assertEqual(route['fault_code'], 'E0025')
        self.assertTrue(route['should_search'])

    def test_level_classifier_only_inherits_context_only_followup(self):
        history = history_with_code()
        self.assertEqual(windrise.classify_question_v2('怎么复位', history), 3)
        self.assertEqual(windrise.classify_question_v2('齿轮箱油温上来了', history), 2)

    def test_validate_route_accepts_context_only_history_followup(self):
        route, error = windrise.validate_windrise_semantic_route(
            route_payload(),
            '怎么处理',
            '303804',
        )
        self.assertEqual(error, '')
        self.assertTrue(route['uses_history_fault_code'])
        self.assertEqual(route['fault_code'], '303804')

    def test_validate_route_accepts_llmwiki_fault_name_search_without_code(self):
        route, error = windrise.validate_windrise_semantic_route(
            route_payload(
                intent='trigger',
                fault_code='',
                uses_history_fault_code=False,
                current_problem_is_new=True,
                rewritten_query='偏航回路欠压',
            ),
            '八面风场ZC09风机偏航回路欠压故障触发条件是什么',
            '',
        )

        self.assertEqual(error, '')
        self.assertEqual(route['intent'], 'trigger')
        self.assertEqual(route['rewritten_query'], '偏航回路欠压')
        self.assertTrue(route['should_search'])

    def test_validate_route_rejects_history_code_for_new_subject(self):
        route, error = windrise.validate_windrise_semantic_route(
            route_payload(current_problem_is_new=True),
            '齿轮箱油温上来了',
            '303804',
        )
        self.assertIsNone(route)
        self.assertEqual(error, 'invalid_history_fault_code_inheritance')

    def test_validate_route_rejects_chat_search_and_missing_fields(self):
        route, error = windrise.validate_windrise_semantic_route(
            route_payload(mode='chat'),
            '怎么处理',
            '303804',
        )
        self.assertIsNone(route)
        self.assertEqual(error, 'chat_cannot_search')

        malformed = route_payload()
        del malformed['reason']
        route, error = windrise.validate_windrise_semantic_route(malformed, '怎么处理', '303804')
        self.assertIsNone(route)
        self.assertEqual(error, 'missing_required_fields')

    def test_call_router_uses_fallback_after_invalid_model_route(self):
        invalid = route_payload(mode='chat')
        with patch.object(windrise, 'WINDRISE_SEMANTIC_ROUTER_ENABLED', True), patch.object(
            windrise, 'is_windrise_llm_temporarily_unavailable', return_value=False
        ), patch.object(windrise, 'call_chat_model', return_value=json.dumps(invalid)):
            route = windrise.call_windrise_semantic_router('怎么处理', history_with_code())

        self.assertEqual(route['mode'], 'knowledge')
        self.assertEqual(route['fault_code'], '303804')
        self.assertTrue(route['should_search'])

    def test_call_router_never_reuses_old_code_for_new_subject(self):
        invalid = route_payload(current_problem_is_new=True)
        with patch.object(windrise, 'WINDRISE_SEMANTIC_ROUTER_ENABLED', True), patch.object(
            windrise, 'is_windrise_llm_temporarily_unavailable', return_value=False
        ), patch.object(windrise, 'call_chat_model', return_value=json.dumps(invalid)):
            route = windrise.call_windrise_semantic_router('齿轮箱油温上来了', history_with_code())

        self.assertEqual(route['fault_code'], '')
        self.assertFalse(route['uses_history_fault_code'])
        self.assertFalse(route['should_search'])
        self.assertTrue(route['current_problem_is_new'])
    def test_payload_routes_fault_followup_through_exact_context(self):
        history = history_with_code('120014')
        with patch.object(windrise, 'call_windrise_semantic_router') as semantic_router, patch.object(
            windrise, 'build_windrise_knowledge_augmented_answer'
        ) as knowledge_answer:
            answer, result_route = windrise.build_windrise_response_payload('怎么复位', history)

        semantic_router.assert_not_called()
        knowledge_answer.assert_not_called()
        self.assertIn('故障码 120014：偏航回路欠压', answer)
        self.assertIn('知识库未给出该故障码的复位条件', answer)
        self.assertEqual(result_route['reason'], 'in_process_explicit_fault_code')

    def test_payload_uses_contextual_chat_for_fault_description_explanation(self):
        history = [
            {'role': 'user', 'content': '顺时针扭缆超限停机是什么故障码'},
            {'role': 'assistant', 'content': '对应故障码709，需要先确认扭缆角度。'},
        ]
        route = route_payload(
            mode='chat',
            intent='explain',
            fault_code='',
            should_search=False,
            uses_history_fault_code=False,
            rewritten_query='顺时针扭缆超限停机是什么意思',
            _model_routed=True,
        )
        with patch.object(windrise, 'call_windrise_semantic_router', return_value=route), patch.object(
            windrise, 'build_windrise_chat_answer', return_value='这是扭缆角度超过允许范围导致的停机。'
        ) as chat_answer:
            answer, result_route = windrise.build_windrise_response_payload('这个是什么意思', history)

        chat_answer.assert_called_once_with('这个是什么意思', history, route)
        self.assertEqual(answer, '这是扭缆角度超过允许范围导致的停机。')
        self.assertEqual(result_route, route)

    def test_payload_new_subject_without_scope_does_not_search_history_code(self):
        history = history_with_code()
        route = route_payload(
            fault_code='',
            should_search=False,
            uses_history_fault_code=False,
            current_problem_is_new=True,
            rewritten_query='齿轮箱油温上来了',
        )
        with patch.object(windrise, 'call_windrise_semantic_router', return_value=route) as semantic_router, patch.object(
            windrise, 'build_windrise_chat_answer', return_value='请先确认齿轮箱油温的当前值和趋势。'
        ) as chat_answer, patch.object(windrise, 'run_windrise_answer') as knowledge_search:
            answer, result_route = windrise.build_windrise_response_payload('齿轮箱油温上来了', history)

        semantic_router.assert_not_called()
        chat_answer.assert_not_called()
        knowledge_search.assert_not_called()
        self.assertIn('哪个风场', answer)
        self.assertEqual(result_route['reason'], 'missing_windrise_scope_dimensions')
        self.assertTrue(result_route['current_problem_is_new'])

    def test_payload_explicit_code_without_scope_uses_fast_local_lookup(self):
        with patch.object(windrise, 'call_windrise_semantic_router') as semantic_router, patch.object(
            windrise, 'build_windrise_knowledge_augmented_answer'
        ) as knowledge_answer:
            answer, result_route = windrise.build_windrise_response_payload('120014是什么故障', [])

        semantic_router.assert_not_called()
        knowledge_answer.assert_not_called()
        self.assertIn('故障码 120014：偏航回路欠压', answer)
        self.assertEqual(result_route['reason'], 'in_process_explicit_fault_code')

    def test_index_fallback_prefers_extracted_code_for_context_only_followup(self):
        history = history_with_code()
        with patch.object(
            windrise,
            'build_explicit_fault_code_exact_answer',
            return_value=('120014复位条件', '120014'),
        ) as exact_lookup, patch.object(
            windrise,
            'build_index_scoped_fault_lookup_answer',
        ) as index_lookup:
            answer = windrise.build_index_scoped_fault_lookup_answer_with_fallback(
                '怎么复位',
                '120014',
                history,
                intent='reset',
            )

        self.assertEqual(answer, '120014复位条件')
        exact_lookup.assert_called_once_with('120014 怎么复位', [history[0]])
        index_lookup.assert_not_called()

    def test_assistant_candidate_scope_does_not_become_user_scope(self):
        history = [
            {'role': 'user', 'content': '120014是什么故障'},
            {
                'role': 'assistant',
                'content': (
                    '**故障码 120014：偏航回路欠压**\n'
                    '厂家：中车山东 / 机型：CWT系列 / 风场：八面、向荣 / '
                    '风机编号：ZC08、ZC12、ZC19'
                ),
            },
        ]

        slots = windrise.build_effective_windrise_slots_for_query('20006呢', history)

        self.assertEqual(slots.get('fault_code'), '20006')
        self.assertFalse(slots.get('farm'))
        self.assertFalse(slots.get('brand'))
        self.assertFalse(slots.get('model'))
        self.assertFalse(slots.get('turbine_id'))

    def test_user_confirmed_scope_survives_assistant_answer(self):
        history = [
            {'role': 'user', 'content': '八面风场ZC09风机120014是什么故障'},
            {
                'role': 'assistant',
                'content': (
                    '**故障码 120014：偏航回路欠压**\n'
                    '厂家：中车山东 / 机型：CWT4800-D185 / 风场：八面 / 风机编号：ZC09'
                ),
            },
        ]

        slots = windrise.build_effective_windrise_slots_for_query('怎么处理', history)

        self.assertEqual(slots.get('farm'), '八面')
        self.assertEqual(slots.get('turbine_id'), 'ZC09')

    def test_ordinal_fault_references_use_recent_multi_code_order(self):
        history = [
            {'role': 'user', 'content': '120014和20006有什么区别'},
            {'role': 'assistant', 'content': '120014是偏航回路欠压，20006是主轴轴承温度过高告警。'},
        ]

        self.assertEqual(
            windrise.resolve_windrise_ordinal_fault_code('前一个怎么复位', history),
            '120014',
        )
        self.assertEqual(
            windrise.resolve_windrise_ordinal_fault_code('后一个怎么处理', history),
            '20006',
        )

    def test_ordinal_followups_use_exact_index_without_model_route(self):
        history = [
            {'role': 'user', 'content': '120014和20006有什么区别'},
            {'role': 'assistant', 'content': '120014是偏航回路欠压，20006是主轴轴承温度过高告警。'},
        ]
        with patch.object(windrise, 'call_windrise_semantic_router') as semantic_router:
            first_answer, _ = windrise.build_windrise_response_payload('前一个怎么复位', history)
            second_answer, _ = windrise.build_windrise_response_payload('后一个怎么处理', history)

        semantic_router.assert_not_called()
        self.assertIn('故障码 120014：偏航回路欠压', first_answer)
        self.assertIn('知识库未给出该故障码的复位条件', first_answer)
        self.assertIn('故障码 20006：主轴轴承温度过高告警', second_answer)
        self.assertIn('处理建议', second_answer)

    def test_repeat_followup_reuses_recent_fault_code_without_model_route(self):
        history = history_with_code('120014')
        with patch.object(windrise, 'call_windrise_semantic_router') as semantic_router:
            answer, _ = windrise.build_windrise_response_payload('触发条件再说一遍', history)

        semantic_router.assert_not_called()
        self.assertIn('故障码 120014：偏航回路欠压', answer)
        self.assertIn('低于10bar持续3s', answer)

    def test_trigger_followup_reuses_recent_fault_code_without_model_route(self):
        history = history_with_code('120014')
        with patch.object(windrise, 'call_windrise_semantic_router') as semantic_router:
            answer, route = windrise.build_windrise_response_payload('触发条件是什么', history)

        semantic_router.assert_not_called()
        self.assertEqual(route['reason'], 'in_process_explicit_fault_code')
        self.assertIn('故障码 120014：偏航回路欠压', answer)
        self.assertIn('触发条件：机组偏航时液压偏航回路压力低于10bar持续3s', answer)

    def test_broad_record_followup_reuses_recent_fault_code_without_model_route(self):
        history = history_with_code('120014')
        with patch.object(windrise, 'call_windrise_semantic_router') as semantic_router:
            answer, route = windrise.build_windrise_response_payload('相关记录都列出来', history)

        semantic_router.assert_not_called()
        self.assertEqual(route['reason'], 'in_process_explicit_fault_code')
        self.assertIn('故障码 120014：偏航回路欠压', answer)

    def test_no_match_followup_keeps_the_original_fault_code(self):
        history = [
            {'role': 'user', 'content': '报E-0025怎么处理'},
            {'role': 'assistant', 'content': '**未找到精确匹配**\n本地知识库没有 E-0025。'},
        ]
        with patch.object(windrise, 'call_windrise_semantic_router') as semantic_router:
            answer, _ = windrise.build_windrise_response_payload('它是什么故障', history)

        semantic_router.assert_not_called()
        self.assertIn('E-0025', answer)
        self.assertIn('未找到精确匹配', answer)

    def test_greeting_does_not_continue_previous_fault(self):
        history = history_with_code('120014')
        with patch.object(windrise, 'call_windrise_semantic_router') as semantic_router, patch.object(
            windrise, 'call_chat_model'
        ) as chat_model:
            answer, route = windrise.build_windrise_response_payload('你好', history)

        semantic_router.assert_not_called()
        chat_model.assert_not_called()
        self.assertIn('你好', answer)
        self.assertNotIn('120014', answer)
        self.assertEqual(route['mode'], 'chat')

    def test_component_followup_keeps_previous_bearing_temperature_topic(self):
        history = [
            {'role': 'user', 'content': '轴承温度异常怎么处理'},
            {'role': 'assistant', 'content': '请确认具体是哪个轴承或测点。'},
        ]

        answer = windrise.build_windrise_conversational_fault_clarification('主轴的', history)

        self.assertIn('主轴轴承温度异常', answer)
        self.assertIn('当前温度', answer)

    def test_fault_index_can_resolve_scope_when_mapping_table_has_no_entry(self):
        slots = windrise.build_resolved_windrise_scope_slots('向荣风场ZC12的', [])

        self.assertEqual(slots.get('farm'), '向荣')
        self.assertEqual(slots.get('turbine_id'), 'ZC12')
        self.assertEqual(slots.get('brand'), '中车山东')
        self.assertEqual(slots.get('model'), 'CWT系列')
        self.assertTrue(slots.get('_mapping_resolved'))

    def test_confirmed_scope_repair_followup_uses_grounded_exact_record(self):
        history = [
            {'role': 'user', 'content': '八面风场ZC09风机120014触发条件是什么'},
            {'role': 'assistant', 'content': '**故障码 120014：偏航回路欠压**'},
        ]
        with patch.object(windrise, 'call_windrise_semantic_router') as semantic_router, patch.object(
            windrise, 'call_chat_model'
        ) as chat_model:
            answer, route = windrise.build_windrise_response_payload('怎么处理', history)

        semantic_router.assert_not_called()
        chat_model.assert_not_called()
        self.assertEqual(route['reason'], 'in_process_explicit_fault_code')
        self.assertIn('风机编号：ZC09', answer)
        self.assertIn('检查液压站偏航回路', answer)
        self.assertNotIn('检查偏航电机', answer)
        self.assertNotIn('检查压力传感器', answer)

    def test_real_structured_answer_format_restores_recent_fault_code(self):
        answer = (
            '已理解您的问题为：偏航回路欠压 120014 触发条件 '
            '已按 八面风场 ZC09 定位到对应机型记录。 '
            '1. **120014｜偏航回路欠压** - 厂家：中车山东 / 机型：CWT系列 '
            '/ 具体型号：CWT4800-D185 / 风场：八面 / 风机编号：ZC09'
        )
        history = [
            {'role': 'user', 'content': '八面风场ZC09风机偏航回路欠压故障触发条件是什么'},
            {'role': 'assistant', 'content': answer},
        ]

        self.assertEqual(windrise.find_recent_fault_code_from_history(history), '120014')
        self.assertEqual(
            windrise.find_recent_fault_context_from_history(history).get('name'),
            '偏航回路欠压',
        )
        self.assertEqual(
            windrise.build_windrise_contextual_fault_query('怎么处理', history),
            '故障码120014 怎么处理',
        )
        self.assertEqual(
            windrise.build_windrise_contextual_fault_query('改成向荣风场ZC12的', history),
            '故障码120014 改成向荣风场ZC12的 触发条件',
        )

    def test_full_local_answer_restores_fault_name_for_broad_scope_followup(self):
        answer, _ = windrise.build_explicit_fault_code_exact_answer(
            '八面风场ZC09故障码120014怎么处理',
            [],
        )
        history = [
            {'role': 'user', 'content': '八面风场ZC09故障码120014怎么处理'},
            {'role': 'assistant', 'content': answer},
        ]

        context = windrise.find_recent_fault_context_from_history(history)
        completed = windrise.build_windrise_scope_completion_query(
            '中车山东的，相关的都给我列出来',
            history,
        )

        self.assertEqual(context.get('code'), '120014')
        self.assertEqual(context.get('name'), '偏航回路欠压')
        self.assertEqual(completed, '偏航回路欠压 中车山东的相关的都给我列出来')

    def test_new_fault_topic_blocks_older_fault_code_inheritance(self):
        history = [
            {'role': 'user', 'content': '120014是什么故障'},
            {'role': 'assistant', 'content': '故障码120014表示偏航回路欠压。'},
            {'role': 'user', 'content': '轴承温度异常怎么处理'},
            {'role': 'assistant', 'content': '请确认具体轴承。'},
        ]

        self.assertEqual(windrise.find_recent_fault_code_from_history(history), '')

    def test_blade_icing_is_new_subject_and_cannot_reuse_generator_temperature(self):
        history = [
            {'role': 'user', 'content': '发电机绕组温度'},
            {
                'role': 'assistant',
                'content': '531维修处理建议\n匹配到1条记录。\n1.531|发电机绕组温度高报警',
            },
        ]
        query = '叶片结冰怎么办'

        self.assertTrue(windrise.has_specific_current_diagnosis_subject(query))
        self.assertFalse(windrise.is_context_only_windrise_followup(query))
        fallback = windrise.build_windrise_semantic_router_fallback(query, history)
        self.assertTrue(fallback['current_problem_is_new'])
        self.assertFalse(fallback['uses_history_fault_code'])
        self.assertEqual(fallback['fault_code'], '')
        self.assertTrue(fallback['should_search'])
        self.assertIn('叶片结冰', fallback['rewritten_query'])

        with windrise.windrise_retrieval_memory_lock:
            windrise.windrise_retrieval_memories.clear()
        windrise.windrise_request_context.conversation_id = 'icing-conv'
        windrise.windrise_request_context.user_id = 'icing-user'
        windrise.remember_windrise_retrieval_context(
            '发电机绕组温度',
            '531维修处理建议\n1.531|发电机绕组温度高报警',
            'icing-conv',
            'icing-user',
        )
        self.assertEqual(
            windrise.reusable_windrise_retrieval_context(
                query,
                history,
                {'current_problem_is_new': False},
            ),
            '',
        )

        answer = windrise.build_index_scoped_fault_lookup_answer_with_fallback(
            query,
            fallback['rewritten_query'],
            history,
            intent='repair',
        )
        self.assertTrue(answer)
        self.assertIn('叶片结冰', answer)
        self.assertNotIn('531', answer)
        self.assertNotIn('发电机绕组温度', answer)

    def test_semantic_route_validation_rejects_old_fault_code_for_new_icing_subject(self):
        parsed = {
            'mode': 'knowledge',
            'intent': 'repair',
            'fault_code': '531',
            'should_search': True,
            'uses_history_fault_code': True,
            'current_problem_is_new': False,
            'rewritten_query': '叶片结冰处理方法',
            'direct_answer': '',
            'reason': 'followup',
        }
        validated, error = windrise.validate_windrise_semantic_route(
            parsed,
            '叶片结冰怎么办',
            '531',
        )
        self.assertIsNone(validated)
        self.assertIn(error, {'invalid_history_fault_code_inheritance', 'current_subject_precedence'})

    def test_iter_with_stream_pulses_emits_keepalive_during_blocking_generator(self):
        original_keepalive = windrise.WINDRISE_STREAM_KEEPALIVE_SECONDS
        windrise.WINDRISE_STREAM_KEEPALIVE_SECONDS = 0.05

        def slow_generator():
            time.sleep(0.2)
            yield 'done'

        try:
            pulses = list(windrise.iter_with_stream_pulses(slow_generator(), '处理中'))
        finally:
            windrise.WINDRISE_STREAM_KEEPALIVE_SECONDS = original_keepalive

        self.assertTrue(any(isinstance(item, windrise.WindriseStreamPulse) for item in pulses))
        self.assertEqual(pulses[-1], 'done')

    def test_parallel_stream_requests_keep_user_answers_isolated(self):
        queries = {
            'user-a': '用户甲叶片结冰怎么办',
            'user-b': '用户乙发电机绕组温度过高怎么办',
            'user-c': '用户丙齿轮箱油温过高怎么办',
        }

        def local_index(original_query, *_args, **_kwargs):
            return f'本地答案：{original_query}'

        def execute(item):
            user_id, query = item
            with windrise.app.test_request_context('/api/chat'):
                response = windrise.call_windrise_app(query, f'conv-{user_id}', user_id, None, True)
                return response.get_data(as_text=True)

        with ExitStack() as stack:
            stack.enter_context(patch.object(windrise, 'ensure_windrise_conversation_id', side_effect=lambda _a, _u, c: c))
            stack.enter_context(patch.object(windrise, 'load_app_session_history', return_value=[]))
            stack.enter_context(patch.object(windrise, 'get_conversation_history', return_value=[]))
            stack.enter_context(patch.object(windrise, 'get_windrise_lightweight_history', return_value=[]))
            stack.enter_context(patch.object(windrise, 'add_to_conversation_history'))
            stack.enter_context(patch.object(windrise, 'add_to_windrise_lightweight_history'))
            stack.enter_context(patch.object(windrise, 'update_windrise_yaw_hydraulic_stage'))
            stack.enter_context(patch.object(windrise, 'build_windrise_fault_scope_clarification', return_value=''))
            stack.enter_context(patch.object(windrise, 'build_windrise_scope_completion_query', return_value=''))
            stack.enter_context(patch.object(windrise, 'build_windrise_deterministic_preflight_answer', return_value=('', '')))
            stack.enter_context(patch.object(windrise, 'call_windrise_semantic_router', side_effect=RuntimeError('model unavailable')))
            stack.enter_context(patch.object(windrise, 'build_index_scoped_fault_lookup_answer_with_fallback', side_effect=local_index))
            stack.enter_context(patch.object(windrise, 'WINDRISE_SHOW_THINKING_STATUS', False))
            stack.enter_context(patch.object(windrise, 'WINDRISE_STREAM_CHUNK_DELAY', 0))
            stack.enter_context(patch.object(windrise, 'WINDRISE_PROGRESS_STEP_DELAY', 0))

            with ThreadPoolExecutor(max_workers=3) as executor:
                bodies = list(executor.map(execute, queries.items()))

        for (user_id, query), body in zip(queries.items(), bodies):
            self.assertEqual(body.count('"event": "message_end"'), 1)
            events = [
                json.loads(line[6:])
                for line in body.splitlines()
                if line.startswith('data: ')
            ]
            answer = ''.join(event.get('answer', '') for event in events)
            self.assertIn(f'本地答案：{query}', answer)
            for other_query in queries.values():
                if other_query != query:
                    self.assertNotIn(other_query, answer)
            self.assertNotIn('暂时无法通过大模型提取知识库检索内容', body)

    def test_payload_expands_fault_description_followup_before_search(self):
        history = [
            {'role': 'user', 'content': '齿轮箱油温持续升高怎么办'},
            {'role': 'assistant', 'content': '先确认油温趋势、滤芯压差和当前负荷。'},
        ]
        route = route_payload(
            fault_code='',
            intent='repair',
            should_search=True,
            uses_history_fault_code=False,
            rewritten_query='下一步怎么排查',
        )
        expanded_query = '齿轮箱油温持续升高怎么办；先确认油温趋势、滤芯压差和当前负荷。；下一步怎么排查'
        with patch.object(windrise, 'build_windrise_wiki_query', return_value=expanded_query), patch.object(
            windrise, 'build_windrise_knowledge_augmented_answer', return_value='请先核对油温趋势和滤芯压差。'
        ) as knowledge_answer:
            answer, result_route = windrise.build_windrise_semantic_response_payload('下一步怎么排查', history, route)

        windrise_query = knowledge_answer.call_args.args[2]
        routed_context = knowledge_answer.call_args.args[3]
        self.assertEqual(windrise_query['args'], ['search', expanded_query])
        self.assertEqual(routed_context['rewritten_query'], expanded_query)
        self.assertEqual(answer, '请先核对油温趋势和滤芯压差。')
        self.assertEqual(result_route, route)

    def test_payload_explicit_code_does_not_expand_history_followup(self):
        history = history_with_code()
        route = route_payload(
            fault_code='E0025',
            should_search=True,
            uses_history_fault_code=False,
            rewritten_query='E0025报警',
        )
        with patch.object(windrise, 'build_windrise_wiki_query') as wiki_query, patch.object(
            windrise, 'build_windrise_knowledge_augmented_answer', return_value='E0025查询结果'
        ) as knowledge_answer:
            answer, _ = windrise.build_windrise_semantic_response_payload('E0025报警', history, route)

        wiki_query.assert_not_called()
        self.assertEqual(knowledge_answer.call_args.args[2]['args'], ['search', 'E0025报警'])
        self.assertEqual(answer, 'E0025查询结果')

    def test_fault_code_intent_phrase_matrix(self):
        cases = {
            '120014什么时候报': 'trigger',
            '120014什么条件下产生': 'trigger',
            '120014怎么来的': 'reason',
            '120014是什么故障': 'meaning',
            '120014是啥意思': 'meaning',
            '120014有什么影响': 'impact',
            '120014严重吗': 'risk',
            '120014还能继续运行吗': 'operation',
            '120014需要停机吗': 'operation',
            '120014和20006有什么区别': 'comparison',
            'alarm 120014 reset': 'reset',
        }
        for query, expected in cases.items():
            with self.subTest(query=query):
                self.assertEqual(windrise.classify_windrise_answer_intent(query), expected)

    def test_fault_code_recognition_supports_english_hyphen_and_spoken_digits(self):
        cases = {
            'error code 120014': ['120014'],
            'fault 120014 meaning': ['120014'],
            'alarm 120014 reset': ['120014'],
            '报E-0025怎么处理': ['E-0025'],
            '幺二零零幺四是什么故障': ['120014'],
        }
        for query, expected in cases.items():
            with self.subTest(query=query):
                self.assertEqual(
                    windrise.extract_direct_windrise_fault_codes(query, []),
                    expected,
                )

    def test_measurement_values_are_not_treated_as_fault_codes(self):
        self.assertEqual(windrise.extract_direct_windrise_fault_codes('电压690V正常吗', []), [])
        self.assertEqual(windrise.extract_direct_windrise_fault_codes('压力150bar上不去', []), [])
        self.assertEqual(windrise.extract_direct_windrise_fault_codes('故障码690是什么', []), ['690'])

    def test_colloquial_code_questions_preserve_requested_answer_field(self):
        cases = {
            '120014达到多少会报': 'trigger',
            '120014怎么消警': 'reset',
            '120014必须停吗': 'operation',
        }
        for query, expected in cases.items():
            with self.subTest(query=query):
                self.assertEqual(windrise.classify_windrise_answer_intent(query), expected)
                followup = re.sub(r'^120014', '', query)
                self.assertEqual(windrise.classify_windrise_followup_intent(followup), expected)
        trigger_answer, _ = windrise.build_explicit_fault_code_exact_answer('120014达到多少会报', [])
        self.assertIn('压力低于10bar持续3s', trigger_answer)

    def test_explicit_fault_name_with_typo_searches_without_device_scope(self):
        query = '顺时针扭揽超限停机怎么处理'
        semantic_route = semantic_route_payload('顺时针扭缆超限停机', intent='repair')

        self.assertEqual(windrise.build_windrise_fault_scope_clarification(query, []), '')
        answer, route = windrise.build_windrise_response_payload(
            query,
            [],
            semantic_route=semantic_route,
        )

        self.assertEqual(route['fault_code'], '709')
        self.assertIn('顺时针扭缆超限', answer)
        self.assertIn('处理', answer)

    def test_explicit_unavailable_dimension_is_control_state_not_slot_value(self):
        turbine_slots = windrise.extract_windrise_user_slots('风机编号无法提供')
        model_slots = windrise.extract_windrise_user_slots('型号也无法提供，相关的都给我列出来')

        self.assertEqual(turbine_slots['turbine_id'], '')
        self.assertIn('turbine_id', turbine_slots['_unavailable_dimensions'])
        self.assertEqual(model_slots['model'], '')
        self.assertIn('model', model_slots['_unavailable_dimensions'])

    def test_farm_model_inventory_does_not_inherit_previous_fault_code(self):
        history = [
            {'role': 'user', 'content': '303804是什么故障'},
            {'role': 'assistant', 'content': '故障码303804表示变桨故障。'},
        ]

        answer, route = windrise.build_windrise_response_payload('新华风场有哪些风机机型', history)

        self.assertEqual(route['reason'], 'deterministic_device_mapping')
        self.assertEqual(route['fault_code'], '')
        self.assertIn('新华风电场机型清单', answer)
        self.assertNotIn('303804', answer)

    def test_context_followup_narrows_reused_code_by_previous_fault_name(self):
        history = [
            {'role': 'user', 'content': '顺时针扭揽超限停机怎么处理'},
            {'role': 'assistant', 'content': '709｜顺时针扭缆超限停机\n处理：检查并重新解缆。'},
        ]

        answer, code = windrise.build_explicit_fault_code_exact_answer(
            '故障码709 这个怎么处理',
            history,
        )

        self.assertEqual(code, '709')
        self.assertIn('顺时针扭缆超限停机', answer)
        self.assertNotIn('网关自动检索出错', answer)
        self.assertNotIn('上海电气', answer)

    def test_code_coverage_followup_lists_all_sites_without_model_route(self):
        first_answer, _ = windrise.build_explicit_fault_code_exact_answer('报80', [])
        history = [
            {'role': 'user', 'content': '报80'},
            {'role': 'assistant', 'content': first_answer},
        ]

        contextual_query = windrise.build_windrise_contextual_fault_query('哪些风场有', history)
        answer, route = windrise.build_windrise_response_payload('哪些风场有', history)

        self.assertEqual(contextual_query, '故障码80 哪些风场有')
        self.assertEqual(route['reason'], 'in_process_explicit_fault_code')
        self.assertIn('故障码 80 的知识库覆盖范围', answer)
        self.assertIn('四平', answer)
        self.assertIn('镇赉', answer)
        self.assertIn('同发', answer)

    def test_code_coverage_answer_keeps_code_for_next_followup(self):
        records = [
            record
            for record in windrise.load_windrise_fault_index_records()
            if windrise.normalize_windrise_fault_code(record.get('code')) == '709'
        ]
        coverage_answer = windrise.build_fault_code_coverage_answer(
            '709',
            records,
        )
        history = [
            {'role': 'user', 'content': '709是什么故障'},
            {'role': 'assistant', 'content': '**故障码 709：顺时针扭缆超限停机**'},
            {'role': 'user', 'content': '这个码哪些风场有'},
            {'role': 'assistant', 'content': coverage_answer},
        ]

        context = windrise.find_recent_fault_context_from_history(history)
        contextual_query = windrise.build_windrise_contextual_fault_query('怎么复位', history)

        self.assertEqual(context.get('code'), '709')
        self.assertEqual(contextual_query, '故障码709 怎么复位')

    def test_exact_fault_names_use_local_fast_path_without_model(self):
        cases = (
            ('顺时针扭揽超限停机是什么故障码', '709', '顺时针扭缆超限停机'),
            ('顺时针扭缆超限停机怎么处理', '709', '解缆'),
            ('运达风速仪故障是什么码', '5307', '运达'),
            ('华仪风速仪故障是什么码', '170010', '华仪'),
            ('50刹车失败是什么故障码', '431', '50刹车失败'),
            ('变桨24V主电源开关故障是什么码', '303804', '24V主电源开关故障'),
        )
        for query, expected_code, expected_text in cases:
            with self.subTest(query=query), patch.object(windrise, 'call_windrise_semantic_router') as router:
                answer, route = windrise.build_windrise_response_payload(query, [])

            router.assert_not_called()
            self.assertEqual(route.get('reason'), 'in_process_exact_fault_name')
            self.assertIn(expected_code, answer)
            self.assertIn(expected_text, answer)

    def test_number_inside_fault_name_is_not_treated_as_fault_code(self):
        query = 'SC_变频器驱动柜1掉载故障是什么故障码'

        self.assertEqual(windrise.extract_fault_codes(query), [])
        self.assertEqual(windrise.extract_direct_windrise_fault_codes(query, []), [])
        self.assertEqual(windrise.extract_fault_codes('故障码1是什么'), ['1'])

        with patch.object(windrise, 'call_windrise_semantic_router') as router:
            answer, route = windrise.build_windrise_response_payload(query, [])

        router.assert_not_called()
        self.assertEqual(route.get('reason'), 'in_process_exact_fault_name')
        self.assertIn('0801027', answer)
        self.assertIn('SC_变频器驱动柜1掉载故障', answer)

    def test_dimension_and_measurement_tokens_are_not_fault_codes(self):
        cases = (
            '告警内容是振动传感器2Y向振动大于设定值1',
            '这台机组机型是XE-2000系列',
            '具体型号是XE82-2000，厂家湘电',
            '具体型号是SE8215-L3',
            '具体型号是W2000C-93-80',
        )
        for query in cases:
            with self.subTest(query=query):
                self.assertEqual(windrise.extract_fault_codes(query), [])
                self.assertEqual(windrise.extract_direct_windrise_fault_codes(query, []), [])
                self.assertEqual(windrise.extract_windrise_turbine_ids_from_text(query), [])

    def test_exact_named_fault_with_scope_finds_numeric_sensor_code(self):
        history = [
            {'role': 'user', 'content': '先限定厂家：三一'},
            {'role': 'assistant', 'content': '已记录限定条件：厂家=三一'},
            {'role': 'user', 'content': '现场风场是四平'},
            {'role': 'assistant', 'content': '已记录限定条件：厂家=三一；风场=四平'},
        ]
        query = '告警内容是振动传感器2Y向振动大于设定值1'
        with patch.object(windrise, 'call_windrise_semantic_router') as router:
            answer, route = windrise.build_windrise_response_payload(query, history)

        router.assert_not_called()
        self.assertEqual(route.get('reason'), 'in_process_exact_fault_name')
        self.assertIn('1534', answer)
        self.assertIn('振动传感器2Y向振动大于设定值1', answer)
        self.assertIn('四平', answer)

    def test_sensor_type_inside_exact_fault_name_is_not_used_as_code_or_turbine(self):
        query = '机舱户外温度点PT100故障是什么故障码'

        self.assertEqual(windrise.extract_direct_windrise_fault_codes(query, []), [])
        self.assertEqual(windrise.extract_windrise_turbine_ids_from_text(query), [])
        with patch.object(windrise, 'call_windrise_semantic_router') as router:
            answer, route = windrise.build_windrise_response_payload(query, [])

        router.assert_not_called()
        self.assertEqual(route.get('reason'), 'in_process_exact_fault_name')
        self.assertIn('SC02_02_077', answer)
        self.assertIn('机舱户外温度点PT100故障', answer)

        history = [
            {'role': 'user', 'content': query},
            {'role': 'assistant', 'content': answer},
        ]
        followup, _ = windrise.build_windrise_response_payload('厂家是明阳', history)
        self.assertEqual(windrise.extract_fault_codes('故障码SC02_02_077 厂家是明阳'), ['SC02_02_077'])
        self.assertEqual(windrise.extract_windrise_turbine_ids_from_text('故障码SC02_02_077 厂家是明阳'), [])
        self.assertIn('SC02_02_077｜机舱户外温度点PT100故障', followup)
        self.assertNotIn('未找到精确匹配', followup)

    def test_negative_temperature_is_not_reused_as_turbine_id(self):
        fault_query = '转子轴承B温度的10分钟值小于-14°C，先帮我记住这个故障现象'
        fault_answer = windrise.build_windrise_fault_topic_ack_answer(fault_query)
        history = [
            {'role': 'user', 'content': fault_query},
            {'role': 'assistant', 'content': fault_answer},
            {'role': 'user', 'content': '厂家明阳，机型MY1.5Se系列'},
            {'role': 'assistant', 'content': '已记住：厂家=明阳；机型=MY1.5SE系列。'},
            {'role': 'user', 'content': '具体型号MY1.5Se-82、MY1.5Se-89/70'},
            {'role': 'assistant', 'content': '已记住具体型号。'},
        ]

        self.assertEqual(windrise.extract_windrise_turbine_ids_from_text(fault_query), [])
        with patch.object(windrise, 'call_windrise_semantic_router') as router:
            answer, route = windrise.build_windrise_response_payload(
                '风场是洮北，风机编号无法提供，请按已有信息最终定位故障码、风场、厂家、机型和具体型号，并列出相关结果',
                history,
            )

        router.assert_not_called()
        self.assertEqual(route.get('reason'), 'in_process_scope_completion')
        self.assertIn('SC02 04 032', answer)
        self.assertIn('转子轴承B温度的10分钟值小于-14°C', answer)
        self.assertNotIn('风机编号=14', answer)

    def test_technical_tokens_inside_exact_fault_names_stay_with_the_name(self):
        cases = (
            ('现在报的是报警字 09_03_B14_电网相序错误', 'SC03_05_040'),
            ('发电机绕组U1温度超限故障是什么故障码', 'SM070224'),
            ('现在报的是变桨轴3速度超差故障L4000停机提示', 'SM301745'),
        )
        for query, expected_code in cases:
            with self.subTest(query=query), patch.object(
                windrise,
                'call_windrise_semantic_router',
            ) as router:
                answer, route = windrise.build_windrise_response_payload(query, [])

            router.assert_not_called()
            self.assertEqual(windrise.extract_windrise_turbine_ids_from_text(query), [])
            self.assertEqual(route.get('reason'), 'in_process_exact_fault_name')
            self.assertIn(expected_code, answer)

    def test_scope_completion_keeps_all_codes_for_same_fault_name(self):
        first_query = '告警内容是SC_电网侧极限过流B'
        first_answer, _ = windrise.build_windrise_response_payload(first_query, [])
        history = [
            {'role': 'user', 'content': '先限定厂家：明阳'},
            {'role': 'assistant', 'content': '已记录限定条件：厂家=明阳'},
            {'role': 'user', 'content': '现场风场是良井子'},
            {'role': 'assistant', 'content': '已记录限定条件：厂家=明阳；风场=良井子'},
            {'role': 'user', 'content': first_query},
            {'role': 'assistant', 'content': first_answer},
        ]
        query = (
            '机型MySE3.0,4.0,5.0,6.25系列，具体型号MySE3.2-156、MySE4.0-156，'
            '风机编号无法提供，请按已有信息最终定位故障码、风场、厂家、机型和具体型号，并列出相关结果'
        )
        with patch.object(windrise, 'call_windrise_semantic_router') as router:
            answer, route = windrise.build_windrise_response_payload(query, history)

        router.assert_not_called()
        self.assertEqual(route.get('reason'), 'in_process_scope_completion')
        self.assertIn('1305042', answer)
        self.assertIn('1305542', answer)
        self.assertEqual(answer.count('**1305042｜SC_电网侧极限过流B**'), 1)
        self.assertEqual(answer.count('**1305542｜SC_电网侧极限过流B**'), 1)

    def test_myse_model_values_are_not_treated_as_turbine_ids(self):
        cases = (
            ('厂家明阳，机型MySE3.0,4.0,5.0,6.25系列', 'MYSE3.0,4.0,5.0,6.25系列'),
            ('具体型号MySE3.2-156、MySE4.0-156', 'MYSE3.2-156、MYSE4.0-156'),
        )
        for query, expected_model in cases:
            with self.subTest(query=query):
                slots = windrise.extract_windrise_user_slots(query)
                self.assertEqual(windrise.extract_windrise_turbine_ids_from_text(query), [])
                self.assertEqual(slots.get('turbine_id'), '')
                self.assertIn(expected_model, (slots.get('model', ''), slots.get('standard_model', '')))

    def test_dimension_only_updates_are_acknowledged_without_model(self):
        cases = (
            ('先限定厂家：明阳', '明阳'),
            ('现场风场是良井子', '良井子'),
            ('这台机组机型是MySE3.0,4.0,5.0,6.25系列', 'MYSE3.0,4.0,5.0,6.25系列'),
            ('这台机组机型是6.XMW双馈系列', '6.XMW双馈系列'),
            ('具体型号MySE3.2-156、MySE4.0-156', 'MYSE3.2-156、MYSE4.0-156'),
        )
        for query, expected in cases:
            with self.subTest(query=query), patch.object(
                windrise,
                'call_windrise_semantic_router',
            ) as router:
                answer, route = windrise.build_windrise_response_payload(query, [])

            router.assert_not_called()
            self.assertEqual(route.get('reason'), 'in_process_dimension_ack')
            self.assertFalse(route.get('should_search'))
            self.assertIn('已记录限定条件', answer)
            self.assertIn(expected, answer)

    def test_dimension_updates_after_remembered_fault_topic_skip_model(self):
        history = [
            {'role': 'user', 'content': '轴3零点未定义，先帮我记住这个故障现象'},
            {
                'role': 'assistant',
                'content': windrise.build_windrise_fault_topic_ack_answer(
                    '轴3零点未定义，先帮我记住这个故障现象',
                ),
            },
        ]
        for query, expected in (
            ('厂家三一，机型SE8715系列', '三一'),
            ('具体型号SE8715', 'SE8715'),
        ):
            with self.subTest(query=query), patch.object(
                windrise,
                'call_windrise_semantic_router',
            ) as router:
                answer, route = windrise.build_windrise_response_payload(query, history)

            router.assert_not_called()
            self.assertEqual(route.get('reason'), 'in_process_dimension_ack')
            self.assertIn('已记录限定条件', answer)
            self.assertIn(expected, answer)
            history.extend([
                {'role': 'user', 'content': query},
                {'role': 'assistant', 'content': answer},
            ])

    def test_blocking_web_entry_acknowledges_dimension_after_remembered_fault(self):
        history = [
            {'role': 'user', 'content': '轴3零点未定义，先帮我记住这个故障现象'},
            {
                'role': 'assistant',
                'content': windrise.build_windrise_fault_topic_ack_answer(
                    '轴3零点未定义，先帮我记住这个故障现象',
                ),
            },
        ]
        with ExitStack() as stack:
            stack.enter_context(patch.object(windrise, 'ensure_windrise_conversation_id', return_value='conv'))
            stack.enter_context(patch.object(windrise, 'load_app_session_history', return_value=history))
            stack.enter_context(patch.object(windrise, 'get_conversation_history', return_value=[]))
            stack.enter_context(patch.object(windrise, 'get_windrise_lightweight_history', return_value=[]))
            stack.enter_context(patch.object(windrise, 'add_to_conversation_history'))
            stack.enter_context(patch.object(windrise, 'add_to_windrise_lightweight_history'))
            stack.enter_context(patch.object(windrise, 'update_windrise_yaw_hydraulic_stage'))
            router = stack.enter_context(patch.object(windrise, 'call_windrise_semantic_router'))
            chat_model = stack.enter_context(patch.object(windrise, 'call_chat_model'))

            with windrise.app.test_request_context('/api/chat'):
                response = windrise.call_windrise_app(
                    '厂家三一，机型SE8715系列',
                    'conv',
                    'user',
                    None,
                    False,
                )
                payload = response.get_json()

        router.assert_not_called()
        chat_model.assert_not_called()
        self.assertIn('已记录限定条件', payload['answer'])
        self.assertIn('三一', payload['answer'])
        self.assertIn('SE8715系列', payload['answer'])

    def test_fault_topic_can_be_remembered_without_lookup_or_model(self):
        cases = (
            ('SC_网侧滤波电容过流，先帮我记住这个故障现象', 'SC_网侧滤波电容过流'),
            ('轴3零点未定义，先帮我记住这个故障现象', '轴3零点未定义'),
        )
        for query, expected_topic in cases:
            with self.subTest(query=query), patch.object(
                windrise,
                'call_windrise_semantic_router',
            ) as router, patch.object(
                windrise,
                'run_windrise_answer',
            ) as knowledge_lookup:
                answer, route = windrise.build_windrise_response_payload(query, [])

            router.assert_not_called()
            knowledge_lookup.assert_not_called()
            self.assertEqual(route.get('reason'), 'in_process_fault_topic_ack')
            self.assertFalse(route.get('should_search'))
            self.assertIn('已记录故障现象', answer)
            self.assertIn(expected_topic, answer)
            self.assertEqual(windrise.clean_windrise_fault_topic_text(query), expected_topic)

    def test_explicit_fault_statements_use_exact_index_without_model(self):
        cases = (
            ('告警内容是SC_机舱柜内发电机水冷泵马达保护跳闸信号触发', '0901018'),
            ('现在报的是SC_变流器水冷系统进水压力高', '1300004'),
            ('风场良井子，故障描述：SC_海得变流器直流母线欠压', '1302013'),
            ('风场富荣，故障描述：A23柜模块X20BC_1故障', 'SM902001'),
        )
        for query, expected_code in cases:
            with self.subTest(query=query), patch.object(
                windrise,
                'call_windrise_semantic_router',
            ) as router:
                answer, route = windrise.build_windrise_response_payload(query, [])

            router.assert_not_called()
            self.assertEqual(route.get('reason'), 'in_process_exact_fault_name')
            self.assertIn(expected_code, answer)

    def test_final_scope_completion_reuses_recent_code_without_model(self):
        first_answer = windrise.build_deterministic_exact_fault_name_answer(
            'SC_变频器驱动柜1掉载故障是什么故障码',
            [],
        )
        history = [
            {'role': 'user', 'content': 'SC_变频器驱动柜1掉载故障是什么故障码'},
            {'role': 'assistant', 'content': first_answer},
            {'role': 'user', 'content': '厂家是明阳'},
            {'role': 'assistant', 'content': '已记住：厂家=明阳。'},
            {'role': 'user', 'content': '风场是良井子'},
            {'role': 'assistant', 'content': '已记住：风场=良井子。'},
        ]
        query = (
            '机型是MySE3.0,4.0,5.0,6.25系列，具体型号是MySE3.2-156、MySE4.0-156，'
            '风机编号无法提供，请按已有信息最终定位故障码、风场、厂家、机型和具体型号，并列出相关结果'
        )
        with patch.object(windrise, 'call_windrise_semantic_router') as router:
            answer, route = windrise.build_windrise_response_payload(query, history)

        router.assert_not_called()
        self.assertEqual(route.get('reason'), 'in_process_scope_completion')
        for expected in (
            '0801027', 'SC_变频器驱动柜1掉载故障', '良井子', '明阳',
            'MySE3.0,4.0,5.0,6.25系列', 'MySE3.2-156、MySE4.0-156',
        ):
            self.assertIn(expected.lower(), answer.lower())

    def test_final_scope_completion_resolves_remembered_exact_name_without_model(self):
        history = [
            {'role': 'user', 'content': 'SC_网侧滤波电容过流，先帮我记住这个故障现象'},
            {'role': 'assistant', 'content': windrise.build_windrise_fault_topic_ack_answer(
                'SC_网侧滤波电容过流，先帮我记住这个故障现象'
            )},
            {'role': 'user', 'content': '厂家明阳，机型MySE3.0,4.0,5.0,6.25系列'},
            {'role': 'assistant', 'content': '已记住厂家和机型。'},
            {'role': 'user', 'content': '具体型号MySE3.2-156、MySE4.0-156'},
            {'role': 'assistant', 'content': '已记住具体型号。'},
        ]
        query = (
            '风场是良井子，风机编号无法提供，请按已有信息最终定位故障码、风场、厂家、'
            '机型和具体型号，并列出相关结果'
        )
        with patch.object(windrise, 'call_windrise_semantic_router') as router:
            answer, route = windrise.build_windrise_response_payload(query, history)

        router.assert_not_called()
        self.assertEqual(route.get('reason'), 'in_process_scope_completion')
        self.assertIn('1303085', answer)
        self.assertIn('SC_网侧滤波电容过流', answer)

    def test_dimension_update_refilters_prior_exact_name_candidates_without_model(self):
        first_answer = windrise.build_deterministic_exact_fault_name_answer(
            'SC_电网电压UBC传感器异常是什么故障码',
            [],
        )
        history = [
            {'role': 'user', 'content': 'SC_电网电压UBC传感器异常是什么故障码'},
            {'role': 'assistant', 'content': first_answer},
            {'role': 'user', 'content': '厂家是明阳'},
            {'role': 'assistant', 'content': '已记住：厂家=明阳。'},
        ]
        with patch.object(windrise, 'call_windrise_semantic_router') as router:
            answer, route = windrise.build_windrise_response_payload('风场是良井子', history)

        router.assert_not_called()
        self.assertEqual(route.get('reason'), 'in_process_dimension_context_lookup')
        self.assertIn('良井子', answer)
        self.assertIn('SC_电网电压UBC传感器异常', answer)

    def test_blocking_web_entry_uses_exact_name_preflight_without_model(self):
        with ExitStack() as stack:
            stack.enter_context(patch.object(windrise, 'ensure_windrise_conversation_id', return_value='conv'))
            stack.enter_context(patch.object(windrise, 'load_app_session_history', return_value=[]))
            stack.enter_context(patch.object(windrise, 'get_conversation_history', return_value=[]))
            stack.enter_context(patch.object(windrise, 'get_windrise_lightweight_history', return_value=[]))
            stack.enter_context(patch.object(windrise, 'add_to_conversation_history'))
            stack.enter_context(patch.object(windrise, 'add_to_windrise_lightweight_history'))
            stack.enter_context(patch.object(windrise, 'update_windrise_yaw_hydraulic_stage'))
            router = stack.enter_context(patch.object(windrise, 'call_windrise_semantic_router'))

            with windrise.app.test_request_context('/api/chat'):
                response = windrise.call_windrise_app(
                    '顺时针扭揽超限停机是什么故障码',
                    'conv',
                    'user',
                    None,
                    False,
                )
                payload = response.get_json()

        router.assert_not_called()
        self.assertIn('709', payload['answer'])
        self.assertIn('顺时针扭缆超限停机', payload['answer'])

    def test_dimension_reply_filters_recent_fault_topic_without_model(self):
        history = [
            {
                'role': 'user',
                'content': '轴承温度过高，且反复报错，或异响，震动噪声过大是什么原因造成的',
            },
            {'role': 'assistant', 'content': '请确认具体轴承测点。'},
        ]
        with patch.object(windrise, 'call_windrise_semantic_router') as router:
            answer, route = windrise.build_windrise_response_payload('新华风场运达风机', history)

        router.assert_not_called()
        self.assertEqual(route.get('reason'), 'in_process_dimension_context_lookup')
        self.assertIn('新华', answer)
        self.assertIn('运达', answer)
        self.assertIn('WD1500', answer)
        self.assertIn('轴承温度', answer)

    def test_context_free_action_followup_requests_fault_object_without_model(self):
        with patch.object(windrise, 'call_windrise_semantic_router') as router:
            answer, route = windrise.build_windrise_response_payload('怎么复位', [])

        router.assert_not_called()
        self.assertEqual(route.get('reason'), 'ambiguous_fault_needs_clarification')
        self.assertIn('请补充故障对象', answer)
        self.assertIn('故障码或完整报警名称', answer)

    def test_reason_followup_after_ambiguous_short_code_keeps_code(self):
        first_answer, _ = windrise.build_explicit_fault_code_exact_answer('7是什么故障', [])
        history = [
            {'role': 'user', 'content': '7是什么故障'},
            {'role': 'assistant', 'content': first_answer},
        ]
        contextual_query = windrise.build_windrise_contextual_fault_query('为什么会报', history)
        with patch.object(windrise, 'call_windrise_semantic_router') as router:
            answer, route = windrise.build_windrise_response_payload('为什么会报', history)

        router.assert_not_called()
        self.assertEqual(contextual_query, '故障码7 为什么会报')
        self.assertEqual(route.get('reason'), 'in_process_explicit_fault_code')
        self.assertIn('故障码 7', answer)
        self.assertIn('风机维护状态', answer)

    def test_fabricated_fault_name_returns_local_no_match_without_model(self):
        with patch.object(windrise, 'call_windrise_semantic_router') as router:
            answer, route = windrise.build_windrise_response_payload(
                '不存在的扭缆超级故障是什么码',
                [],
            )

        router.assert_not_called()
        self.assertEqual(route.get('reason'), 'in_process_exact_fault_name')
        self.assertIn('未找到精确匹配', answer)
        self.assertNotIn('顺时针扭缆超限停机', answer)

    def test_multiple_fault_codes_are_all_answered(self):
        answer, primary_code = windrise.build_explicit_fault_code_exact_answer(
            '120014和20006有什么区别',
            [],
        )

        self.assertEqual(primary_code, '120014')
        self.assertIn('故障码对比', answer)
        self.assertIn('120014：偏航回路欠压', answer)
        self.assertIn('20006：主轴轴承温度过高告警', answer)
        self.assertIn('故障码 120014：偏航回路欠压', answer)
        self.assertIn('故障码 20006：主轴轴承温度过高告警', answer)

    def test_missing_reset_field_never_reuses_repair_solution(self):
        answer, _ = windrise.build_explicit_fault_code_exact_answer('120014怎么复位', [])

        self.assertIn('知识库未给出该故障码的复位条件', answer)
        self.assertNotIn('复位建议：检查液压站偏航回路', answer)

    def test_streaming_plain_chat_skips_retrieval_routing_and_index(self):
        with ExitStack() as stack:
            stack.enter_context(patch.object(windrise, 'ensure_windrise_conversation_id', return_value='conv'))
            stack.enter_context(patch.object(windrise, 'load_app_session_history', return_value=[]))
            stack.enter_context(patch.object(windrise, 'get_conversation_history', return_value=[]))
            stack.enter_context(patch.object(windrise, 'get_windrise_lightweight_history', return_value=[]))
            stack.enter_context(patch.object(windrise, 'add_to_conversation_history'))
            stack.enter_context(patch.object(windrise, 'add_to_windrise_lightweight_history'))
            stack.enter_context(patch.object(windrise, 'update_windrise_yaw_hydraulic_stage'))
            model_route = stack.enter_context(patch.object(windrise, 'call_windrise_semantic_router'))
            legacy_extractor = stack.enter_context(patch.object(windrise, 'consolidate_windrise_user_query'))
            index_lookup = stack.enter_context(patch.object(
                windrise, 'build_index_scoped_fault_lookup_answer_with_fallback'
            ))
            stack.enter_context(patch.object(
                windrise, 'iter_windrise_llm_first_answer', return_value=iter(['您好，请问需要了解哪方面的问题？'])
            ))
            stack.enter_context(patch.object(windrise, 'WINDRISE_SHOW_THINKING_STATUS', True))
            stack.enter_context(patch.object(windrise, 'WINDRISE_STREAM_CHUNK_DELAY', 0))
            stack.enter_context(patch.object(windrise, 'WINDRISE_PROGRESS_STEP_DELAY', 0))

            with windrise.app.test_request_context('/api/chat'):
                response = windrise.call_windrise_app('你好', 'conv', 'user', None, True)
                body = response.get_data(as_text=True)

        self.assertIn('你好！', body)
        self.assertIn('我是 Windrise', body)
        self.assertNotIn('正在提取知识库检索内容', body)
        self.assertNotIn('正在查找知识库', body)
        model_route.assert_not_called()
        legacy_extractor.assert_not_called()
        index_lookup.assert_not_called()

    def test_streaming_plc_comm_fault_prefers_index_over_mapping(self):
        query = '同发风场A32号风机主PLC检测到从PLC通讯错误'
        with ExitStack() as stack:
            stack.enter_context(patch.object(windrise, 'ensure_windrise_conversation_id', return_value='conv'))
            stack.enter_context(patch.object(windrise, 'load_app_session_history', return_value=[]))
            stack.enter_context(patch.object(windrise, 'get_conversation_history', return_value=[]))
            stack.enter_context(patch.object(windrise, 'get_windrise_lightweight_history', return_value=[]))
            stack.enter_context(patch.object(windrise, 'add_to_conversation_history'))
            stack.enter_context(patch.object(windrise, 'add_to_windrise_lightweight_history'))
            stack.enter_context(patch.object(windrise, 'update_windrise_yaw_hydraulic_stage'))
            model_route = stack.enter_context(patch.object(windrise, 'call_windrise_semantic_router'))
            stack.enter_context(patch.object(windrise, 'WINDRISE_SHOW_THINKING_STATUS', False))
            stack.enter_context(patch.object(windrise, 'WINDRISE_STREAM_CHUNK_DELAY', 0))
            stack.enter_context(patch.object(windrise, 'WINDRISE_PROGRESS_STEP_DELAY', 0))

            with windrise.app.test_request_context('/api/chat'):
                response = windrise.call_windrise_app(query, 'conv', 'user', None, True)
                body = response.get_data(as_text=True)

        self.assertIn('**证据命中**', body)
        self.assertIn('272', body)
        self.assertIn('主PLC检测到从PLC通', body)
        self.assertNotIn('本地映射表共找到', body)

    def test_direct_chat_skips_mapping_for_plc_comm_fault(self):
        query = '同发风场A32号风机主PLC检测到从PLC通讯错误'
        self.assertFalse(windrise.build_windrise_direct_chat_answer(query, []))
        self.assertFalse(windrise.build_windrise_model_mapping_answer(query))

    def test_streaming_cross_farm_scoped_symptom_scenario_p(self):
        """Streaming multi-turn path must keep scoped symptom lookup after cross-farm history."""
        conv_id = 'conv-scenario-p'
        session_history = []

        def load_session_history(_session_id, _user_id, _limit=0):
            return list(session_history)

        def presave_user_message(query):
            session_history.append({'role': 'user', 'content': query})

        def collect_stream_body(response):
            return response.get_data(as_text=True)

        steps = [
            (
                '同发风场A32号风机主PLC检测到从PLC通讯错误',
                {'must_have': ['272'], 'must_not_have': ['70029']},
            ),
            (
                '八面风场ZC05风机功率过低切出',
                {'must_have': ['70029', 'ZC05'], 'must_not_have': ['272', '60022']},
            ),
            (
                '功率过低切出',
                {'must_have': ['70029', 'ZC05'], 'must_not_have': ['272', '60022']},
            ),
            (
                '齿轮箱油温高',
                {'must_have': ['60011', 'ZC05'], 'must_not_have': ['272', '60022', '70029']},
            ),
        ]

        polluted_router = lambda query, history: windrise.build_windrise_semantic_router_fallback(
            f'{query}SL1500-ABB系列CWT4800-D185',
            history,
        )

        with ExitStack() as stack:
            stack.enter_context(patch.object(windrise, 'ensure_windrise_conversation_id', return_value=conv_id))
            stack.enter_context(patch.object(windrise, 'load_app_session_history', side_effect=load_session_history))
            stack.enter_context(patch.object(windrise, 'get_windrise_lightweight_history', return_value=[]))
            stack.enter_context(patch.object(windrise, 'update_windrise_yaw_hydraulic_stage'))
            stack.enter_context(patch.object(windrise, 'call_windrise_semantic_router', side_effect=polluted_router))
            stack.enter_context(patch.object(windrise, 'WINDRISE_SHOW_THINKING_STATUS', False))
            stack.enter_context(patch.object(windrise, 'WINDRISE_STREAM_CHUNK_DELAY', 0))
            stack.enter_context(patch.object(windrise, 'WINDRISE_PROGRESS_STEP_DELAY', 0))
            stack.enter_context(patch.object(windrise, 'iter_windrise_knowledge_augmented_answer', side_effect=AssertionError('LLMWiki should not run for scoped symptoms')))

            for query, expectations in steps:
                presave_user_message(query)
                with windrise.app.test_request_context('/api/chat'):
                    response = windrise.call_windrise_app(query, conv_id, 'user', 99, True)
                    body = collect_stream_body(response)

                for token in expectations['must_have']:
                    self.assertIn(token, body, msg=f'{query} missing {token}')
                for token in expectations['must_not_have']:
                    self.assertNotIn(token, body, msg=f'{query} leaked {token}')

                answer_parts = []
                for line in body.splitlines():
                    if '"answer": "' not in line:
                        continue
                    chunk = line.split('"answer": "', 1)[1]
                    if chunk.endswith('",'):
                        chunk = chunk[:-2]
                    elif chunk.endswith('"'):
                        chunk = chunk[:-1]
                    answer_parts.append(
                        chunk.encode('utf-8').decode('unicode_escape')
                        if '\\u' in chunk else chunk
                    )
                answer = ''.join(answer_parts)
                windrise.persist_completed_windrise_stream_answer(conv_id, 'user', query, answer)

    def test_streaming_scope_then_intent_scenario_c(self):
        """Streaming scope collection must reconnect ZC09 to the remembered fault topic."""
        conv_id = 'conv-scenario-c'
        session_history = []

        def load_session_history(_session_id, _user_id, _limit=0):
            return list(session_history)

        def presave_user_message(query):
            session_history.append({'role': 'user', 'content': query})

        def collect_stream_body(response):
            return response.get_data(as_text=True)

        steps = [
            ('偏航回路欠压故障触发条件', {'must_have': ['风场']}),
            ('八面风场', {'must_have': ['风机编号']}),
            ('ZC09', {'must_have': ['120014', '偏航']}),
            ('触发条件是什么', {'must_have': ['120014']}),
            ('怎么处理', {'must_have': ['偏航', '液压']}),
        ]

        with ExitStack() as stack:
            stack.enter_context(patch.object(windrise, 'ensure_windrise_conversation_id', return_value=conv_id))
            stack.enter_context(patch.object(windrise, 'load_app_session_history', side_effect=load_session_history))
            stack.enter_context(patch.object(windrise, 'get_conversation_history', return_value=[]))
            stack.enter_context(patch.object(windrise, 'get_windrise_lightweight_history', return_value=[]))
            stack.enter_context(patch.object(windrise, 'update_windrise_yaw_hydraulic_stage'))
            stack.enter_context(patch.object(windrise, 'call_windrise_semantic_router', side_effect=windrise.build_windrise_semantic_router_fallback))
            stack.enter_context(patch.object(windrise, 'WINDRISE_SHOW_THINKING_STATUS', False))
            stack.enter_context(patch.object(windrise, 'WINDRISE_STREAM_CHUNK_DELAY', 0))
            stack.enter_context(patch.object(windrise, 'WINDRISE_PROGRESS_STEP_DELAY', 0))

            for query, expectations in steps:
                presave_user_message(query)
                with windrise.app.test_request_context('/api/chat'):
                    response = windrise.call_windrise_app(query, conv_id, 'user', 100, True)
                    body = collect_stream_body(response)

                for token in expectations['must_have']:
                    self.assertIn(token, body, msg=f'{query} missing {token}')

                answer_parts = []
                for line in body.splitlines():
                    if '"answer": "' not in line:
                        continue
                    chunk = line.split('"answer": "', 1)[1]
                    if chunk.endswith('",'):
                        chunk = chunk[:-2]
                    elif chunk.endswith('"'):
                        chunk = chunk[:-1]
                    answer_parts.append(
                        chunk.encode('utf-8').decode('unicode_escape')
                        if '\\u' in chunk else chunk
                    )
                answer = ''.join(answer_parts)
                windrise.persist_completed_windrise_stream_answer(conv_id, 'user', query, answer)

    def test_general_knowledge_question_skips_scope_clarification(self):
        with patch.object(windrise, 'call_windrise_semantic_router') as router, patch.object(
            windrise,
            'build_windrise_chat_answer',
            return_value='偏航系统通过液压或电机驱动机舱对准风向。',
        ) as chat:
            answer, route = windrise.build_windrise_response_payload('偏航系统是怎么工作的', [])

        router.assert_not_called()
        chat.assert_called_once()
        self.assertEqual(route.get('reason'), 'general_wind_knowledge_question')
        self.assertIn('偏航系统', answer)
        self.assertNotIn('请补充风场', answer)

    def test_wind_power_principle_question_uses_chat_not_fault_index(self):
        history = [
            {'role': 'user', 'content': '什花道风场 SY27'},
            {
                'role': 'assistant',
                'content': '【对象确认】\n什花道 / SY27# / 三一 / SE16033',
            },
        ]
        with patch.object(windrise, 'call_windrise_semantic_router') as router, patch.object(
            windrise,
            'build_windrise_chat_answer',
            return_value='风力发电利用风能驱动叶轮旋转，经齿轮箱增速后带动发电机发电。',
        ) as chat:
            answer, route = windrise.build_windrise_response_payload('风力发电的原理是什么', history)

        router.assert_not_called()
        chat.assert_called_once()
        self.assertEqual(route.get('reason'), 'general_wind_knowledge_question')
        self.assertIn('风力发电', answer)
        self.assertNotIn('设备范围内未找到精确匹配', answer)
        self.assertNotIn('fault-index', answer)

    def test_resolve_windrise_route_plan_prioritizes_general_knowledge_over_fault_index(self):
        history = [
            {'role': 'user', 'content': '什花道风场 SY27'},
            {
                'role': 'assistant',
                'content': '【对象确认】\n什花道 / SY27# / 三一 / SE16033',
            },
        ]
        plan = windrise.resolve_windrise_route_plan('风力发电的原理是什么', history)
        self.assertEqual(plan['kind'], windrise.WINDRISE_ROUTE_GENERAL_KNOWLEDGE)
        self.assertIsNone(plan['terminal_answer'])
        self.assertFalse(plan['preflight_local_answer'])
        self.assertFalse(plan['needs_model_route'])

    def test_resolve_windrise_route_plan_scoped_symptom_stays_fault_lookup(self):
        history = [
            {'role': 'user', 'content': '什花道风场 SY27'},
            {
                'role': 'assistant',
                'content': '【对象确认】\n什花道 / SY27# / 三一 / SE16033',
            },
        ]
        with patch.object(windrise, 'resolve_windrise_scoped_symptom_preflight', return_value=('本地命中', 'in_process_scoped_fault_lookup')):
            plan = windrise.resolve_windrise_route_plan('齿轮箱油温高', history)
        self.assertEqual(plan['kind'], windrise.WINDRISE_ROUTE_SCOPED_SYMPTOM)
        self.assertEqual(plan['terminal_answer'], '本地命中')

    def test_streaming_general_knowledge_does_not_crash_on_scoped_preflight_guard(self):
        conv_id = 'conv-general-stream'
        history = [
            {'role': 'user', 'content': '什花道风场 SY27'},
            {'role': 'assistant', 'content': '【对象确认】\n什花道 / SY27# / 三一 / SE16033'},
        ]

        with ExitStack() as stack:
            stack.enter_context(patch.object(windrise, 'ensure_windrise_conversation_id', return_value=conv_id))
            stack.enter_context(patch.object(windrise, 'load_app_session_history', return_value=history))
            stack.enter_context(patch.object(windrise, 'get_conversation_history', return_value=history))
            stack.enter_context(patch.object(windrise, 'get_windrise_lightweight_history', return_value=[]))
            stack.enter_context(patch.object(windrise, 'merge_windrise_chat_histories', return_value=history))
            stack.enter_context(patch.object(windrise, 'iter_windrise_chat_answer', return_value=iter(['风力发电', '原理'])))
            stack.enter_context(patch.object(windrise, 'WINDRISE_SHOW_THINKING_STATUS', False))
            stack.enter_context(patch.object(windrise, 'WINDRISE_STREAM_CHUNK_DELAY', 0))
            stack.enter_context(patch.object(windrise, 'WINDRISE_PROGRESS_STEP_DELAY', 0))
            with windrise.app.test_request_context('/api/chat'):
                response = windrise.call_windrise_app('风力发电的原理是什么', conv_id, 'admin', 99, True)
                body = response.get_data(as_text=True)
        self.assertIn('风力发电', body)
        self.assertNotIn('Internal Server Error', body)

    def test_casual_chat_queries_use_deterministic_replies(self):
        with patch.object(windrise, 'call_windrise_semantic_router') as router:
            thank_answer, thank_route = windrise.build_windrise_response_payload('谢谢', [])
            who_answer, who_route = windrise.build_windrise_response_payload('你是谁', [])

        router.assert_not_called()
        self.assertEqual(thank_route.get('reason'), 'deterministic_direct_chat')
        self.assertIn('不客气', thank_answer)
        self.assertEqual(who_route.get('reason'), 'deterministic_direct_chat')
        self.assertIn('Windrise', who_answer)

    def test_farm_model_mapping_without_farm_suffix_is_detected(self):
        query = '同发有哪些风机机型'
        self.assertTrue(windrise.is_wind_farm_model_mapping_query(query))
        answer, route = windrise.build_windrise_response_payload(query, [])
        self.assertEqual(route.get('reason'), 'deterministic_device_mapping')
        self.assertIn('同发', answer)
        self.assertIn('机型', answer)

    def test_explicit_fault_code_falls_back_to_global_when_scoped_misses(self):
        history = [
            {'role': 'user', 'content': '什花道风场 SY27 风机'},
            {
                'role': 'assistant',
                'content': (
                    '**对象确认**\n'
                    '什花道风电场 SY27 → 三一 高速系列（SE16033）'
                ),
            },
        ]
        mock_records = [
            {
                'code': '700002',
                'name': '风轮转速比较故障',
                'site': '四平',
                'brand': '上海电气',
                'model': 'W2000系列',
                'standardModel': 'W2000C-93-80',
                'solution': '检查转速传感器线路。',
                'source': 'demo/global-700002.md',
                '_wr_compact_name': '风轮转速比较故障',
            },
        ]
        with patch.object(windrise, 'load_windrise_fault_index_records', return_value=mock_records), patch.object(
            windrise,
            'should_reset_windrise_scope_for_explicit_fault_code_query',
            return_value=False,
        ):
            answer, code = windrise.build_explicit_fault_code_exact_answer('700002', history)

        self.assertEqual(code, '700002')
        self.assertIn('【全局检索】', answer)
        self.assertIn('700002', answer)
        self.assertIn('风轮转速比较故障', answer)
        self.assertNotIn('未找到精确匹配', answer)

    def test_global_fault_search_request_strips_prefix_and_returns_records(self):
        mock_records = [
            {
                'code': '0700002',
                'name': '示例故障',
                'site': '良井子',
                'brand': '明阳',
                'model': 'MySE3.0、4.0、5.0',
                'standardModel': 'MySE3.2-156',
                'solution': '按厂家手册检查。',
                'source': 'demo/global-0700002.md',
                '_wr_compact_name': '示例故障',
            },
        ]
        with patch.object(windrise, 'load_windrise_fault_index_records', return_value=mock_records):
            answer, code = windrise.build_explicit_fault_code_exact_answer('搜索全局0700002', [])

        self.assertEqual(code, '0700002')
        self.assertIn('【全局检索】', answer)
        self.assertIn('0700002', answer)
        self.assertIn('示例故障', answer)

    def test_fault_code_lookup_preserves_leading_zeros(self):
        self.assertTrue(windrise.fault_code_lookup_keys_match('0700002', '0700002'))
        self.assertTrue(windrise.fault_code_lookup_keys_match('700002', '700002'))
        self.assertFalse(windrise.fault_code_lookup_keys_match('0700002', '700002'))

    def test_global_fallback_renders_records_after_scope_notice(self):
        """Regression: global hits must not be filtered away by converged scope."""
        history = [
            {'role': 'user', 'content': '什花道风场 SY27 风机'},
            {
                'role': 'assistant',
                'content': (
                    '**对象确认**\n'
                    '什花道风电场 SY27 → 三一 高速系列（SE16033）'
                ),
            },
        ]
        mock_records = [
            {
                'code': '0700002',
                'name': 'SC_液压系统压力低于限值',
                'site': '良井子',
                'brand': '明阳',
                'model': 'MySE3.0,4.0,5.0,6.25系列',
                'standardModel': 'MySE3.2-156',
                'solution': '检查液压系统压力。',
                'source': 'demo/global-0700002.md',
                '_wr_compact_name': 'SC_液压系统压力低于限值',
            },
        ]
        with patch.object(windrise, 'load_windrise_fault_index_records', return_value=mock_records), patch.object(
            windrise,
            'should_reset_windrise_scope_for_explicit_fault_code_query',
            return_value=False,
        ):
            answer, code = windrise.build_explicit_fault_code_exact_answer('0700002', history)

        self.assertEqual(code, '0700002')
        self.assertIn('【全局检索】', answer)
        self.assertIn('SC_液压系统压力低于限值', answer)
        self.assertIn('**知识库记录**', answer)
        self.assertNotIn('什花道风场 SY27 定位到对应机型记录', answer)

    def test_scoped_symptom_miss_falls_back_to_global_fault_index(self):
        history = [
            {'role': 'user', 'content': '什花道风场 SY27'},
            {
                'role': 'assistant',
                'content': '【对象确认】\n什花道 / SY27# / 三一 / SE16033',
            },
        ]
        mock_records = [
            {
                'code': '5123',
                'name': '轴1轴2变桨指令误差大',
                'site': '四平',
                'brand': '三一',
                'model': '高速系列',
                'standardModel': 'SE8215-L3',
                'solution': '检查变桨驱动器与反馈回路。',
                'source': 'demo/global-pitch-error.md',
                '_wr_compact_name': '轴1轴2变桨指令误差大',
            },
            {
                'code': '4171',
                'name': '变桨轴1硬件EFC信号丢失',
                'site': '什花道',
                'brand': '三一',
                'model': '高速系列',
                'standardModel': 'SE16033',
                'solution': '检查主控到变桨线路。',
                'source': 'demo/scoped-4171.md',
                '_wr_compact_name': '变桨轴1硬件EFC信号丢失',
            },
        ]
        query = '轴1轴2变桨指令误差大'
        with patch.object(windrise, 'load_windrise_fault_index_records', return_value=mock_records), patch.object(
            windrise,
            'collect_scoped_fault_index_candidates',
            return_value=([], {'farm': '什花道', 'turbine_id': 'SY27', 'brand': '三一'}, query, False),
        ):
            answer, reason = windrise.resolve_windrise_scoped_symptom_preflight(query, history)

        self.assertEqual(reason, 'in_process_global_symptom_fallback')
        self.assertIn('【全局检索】', answer)
        self.assertIn('轴1轴2变桨指令误差大', answer)
        self.assertIn('5123', answer)
        self.assertIn('四平', answer)
        self.assertNotIn('设备范围内未找到精确匹配', answer)

    def test_farm_switch_does_not_glue_previous_fault_code_into_lookup_query(self):
        history = [
            {'role': 'user', 'content': '什花道风场 SY27'},
            {'role': 'assistant', 'content': '【对象确认】\n什花道 / SY27# / 三一 / SE16033'},
            {'role': 'user', 'content': '轴1轴2变桨指令误差大'},
            {
                'role': 'assistant',
                'content': '**设备范围内未找到精确匹配**\n已在上述机型手册中检索报警「轴1轴2变桨指令误差大」',
            },
        ]
        contextual = windrise.build_windrise_contextual_fault_query('四平风场', history)
        self.assertEqual(contextual, '四平风场')
        switched, reason = windrise.detect_windrise_new_case_switch('四平风场', history)
        self.assertTrue(switched)
        self.assertEqual(reason, 'explicit_farm_switch')


    def test_weak_topic_match_returns_no_exact_match_before_similar_records(self):
        history = [
            {'role': 'user', 'content': '四平风场H01'},
            {
                'role': 'assistant',
                'content': '【对象确认】\n四平 / H01# / 华仪 / HW82/1500',
            },
        ]
        query = '偏航轴承润滑堵塞故障'
        with patch.object(windrise, 'call_windrise_semantic_router', side_effect=lambda q, h: windrise.build_windrise_semantic_router_fallback(q, h)):
            answer, route = windrise.build_windrise_response_payload(query, history)

        self.assertIn(
            route.get('reason'),
            {'in_process_scoped_fault_lookup_miss', 'in_process_global_symptom_fallback'},
        )
        self.assertIn('设备范围内未找到精确匹配', answer)
        self.assertIn('偏航轴承润滑堵塞', answer)
        self.assertIn('名称相近的记录', answer)
        self.assertNotIn('**证据命中**', answer)
        self.assertNotIn('发电机前轴承温度超限', answer.split('名称相近的记录')[0])
        self.assertIn('130018', answer)
        self.assertIn('【全局检索】', answer)

    def test_exact_topic_match_still_returns_evidence_hit(self):
        history = [
            {'role': 'user', 'content': '四平风场H01'},
            {
                'role': 'assistant',
                'content': '【对象确认】\n四平 / H01# / 华仪 / HW82/1500',
            },
        ]
        query = '桨叶2编码器不同步'
        with patch.object(windrise, 'call_windrise_semantic_router', side_effect=lambda q, h: windrise.build_windrise_semantic_router_fallback(q, h)):
            answer, route = windrise.build_windrise_response_payload(query, history)

        self.assertEqual(route.get('reason'), 'in_process_scoped_fault_lookup')
        self.assertIn('**证据命中**', answer)
        self.assertIn('303717', answer)
        self.assertIn('桨叶2编码器不同步', answer)


if __name__ == '__main__':
    import unittest

    unittest.main()
