import importlib.util
import unittest
from pathlib import Path
from unittest.mock import patch

import requests


def load_server_module():
    module_path = Path(__file__).resolve().parent / 'dify_web_server_.py'
    spec = importlib.util.spec_from_file_location('dify_web_server_test_module', module_path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class WebErrorDiagnosticsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = load_server_module()

    def test_collect_exception_causes_includes_chain(self):
        root = ValueError('root failure')
        wrapped = RuntimeError('wrapped failure')
        wrapped.__cause__ = root
        causes = self.server.collect_exception_causes(wrapped)
        self.assertEqual(len(causes), 2)
        self.assertIn('RuntimeError: wrapped failure', causes[0])
        self.assertIn('ValueError: root failure', causes[1])

    def test_build_web_error_payload_includes_hints_for_connection_error(self):
        exc = requests.exceptions.ConnectionError('connection refused')
        payload = self.server.build_web_error_payload(
            '无法连接模型服务',
            status_code=503,
            error_type='connection_error',
            exc=exc,
            diagnostics={'vllm_url': 'http://10.46.161.210:9527'},
        )
        self.assertEqual(payload['error'], '无法连接模型服务')
        self.assertIn('causes', payload)
        self.assertIn('hints', payload)
        self.assertTrue(any('vLLM' in hint for hint in payload['hints']))
        self.assertEqual(payload['diagnostics']['vllm_url'], 'http://10.46.161.210:9527')

    def test_format_windrise_stream_error_diagnostic_contains_sections(self):
        diagnostic = self.server.format_windrise_stream_error_diagnostic(
            TimeoutError('Windrise 流式回答超过时限')
        )
        self.assertIn('【系统诊断】', diagnostic)
        self.assertIn('TimeoutError', diagnostic)
        self.assertIn('建议', diagnostic)


if __name__ == '__main__':
    unittest.main()
