from pathlib import Path
from unittest import TestCase


BASE_DIR = Path(__file__).resolve().parent
HTML_PATH = BASE_DIR / 'index_zhipu.html'
UBUNTU_RUNNERS = (
    BASE_DIR.parent / 'deploy/ubuntu-portable/run_web_portable.sh',
    BASE_DIR.parent / 'deploy/ubuntu-source/run_web_ubuntu.sh',
    BASE_DIR.parent / 'deploy/ubuntu-node-runtime/run_web_no_system_node.sh',
    BASE_DIR.parent / 'deploy/ubuntu-offline/run-web.sh',
)


class FrontendNetworkResilienceTest(TestCase):
    def test_active_chat_handler_translates_browser_network_errors(self):
        html = HTML_PATH.read_text(encoding='utf-8')
        active_handler_start = html.rfind('async function sendMessage()')
        active_handler_end = html.find('async function clearChat()', active_handler_start)
        active_handler = html[active_handler_start:active_handler_end]

        self.assertGreaterEqual(active_handler_start, 0)
        self.assertGreater(active_handler_end, active_handler_start)
        self.assertIn('await buildChatFailureText(error)', active_handler)
        self.assertIn("error.chatPhase = 'connect'", active_handler)
        self.assertNotIn("'抱歉，处理您的请求时出现问题：' + error.message", active_handler)

    def test_stream_requires_explicit_message_end(self):
        html = HTML_PATH.read_text(encoding='utf-8')
        active_stream_start = html.rfind('async function sendStreamMessage(')
        active_stream_end = html.find('async function clearChat()', active_stream_start)
        active_stream = html[active_stream_start:active_stream_end]

        self.assertIn("data.event === 'message_end'", active_stream)
        self.assertIn('if (!streamCompleted)', active_stream)
        self.assertIn("streamError.code = 'STREAM_INCOMPLETE'", active_stream)
        self.assertIn('streamError.partialText = fullText', active_stream)
        self.assertIn('if (streamCompleted)', active_stream)
        self.assertIn('await reader.cancel()', active_stream)

    def test_active_chat_handler_has_timeouts_and_stale_request_guard(self):
        html = HTML_PATH.read_text(encoding='utf-8')
        active_handler_start = html.rfind('async function sendMessage()')
        active_handler_end = html.find('async function clearChat()', active_handler_start)
        active_handler = html[active_handler_start:active_handler_end]

        self.assertIn('const requestGeneration = ++chatRequestGeneration', active_handler)
        self.assertIn('shouldUpdateRequestUi(requestGeneration, requestSessionId)', active_handler)
        self.assertIn('CHAT_RESPONSE_START_TIMEOUT_MS', active_handler)
        self.assertIn('CHAT_STREAM_IDLE_TIMEOUT_MS', active_handler)
        self.assertIn('CHAT_REQUEST_TIMEOUT_MS', active_handler)
        self.assertIn("timeoutError.code = 'STREAM_IDLE_TIMEOUT'", active_handler)

    def test_current_session_selection_is_browser_page_scoped(self):
        html = HTML_PATH.read_text(encoding='utf-8')

        self.assertIn("const BROWSER_PAGE_ID_STORAGE_KEY = 'windriseBrowserPageId'", html)
        self.assertIn('sessionStorage.getItem(BROWSER_PAGE_ID_STORAGE_KEY)', html)
        self.assertIn('sessionStorage.setItem(getSessionSelectionStorageKey(), String(currentSessionId))', html)
        self.assertIn('sessionStorage.getItem(getSessionSelectionStorageKey())', html)
        self.assertNotIn("localStorage.getItem('chatWindowId')", html)
        self.assertNotIn("localStorage.setItem('chatWindowId'", html)
        self.assertNotIn('localStorage.getItem(getSessionSelectionStorageKey())', html)
        self.assertNotIn('localStorage.setItem(getSessionSelectionStorageKey()', html)

    def test_chat_requests_are_bound_to_originating_page_and_session(self):
        html = HTML_PATH.read_text(encoding='utf-8')
        active_handler_start = html.rfind('async function sendMessage()')
        active_handler_end = html.find('async function clearChat()', active_handler_start)
        active_handler = html[active_handler_start:active_handler_end]

        self.assertIn('const requestSessionId = currentSessionId', active_handler)
        self.assertIn('const requestConversationId = difyConversationId', active_handler)
        self.assertIn('shouldUpdateRequestUi(requestGeneration, requestSessionId)', active_handler)
        self.assertIn('activeChatRequestToken = requestToken', active_handler)
        self.assertIn('page_context_id: browserPageId', active_handler)
        self.assertIn('sessionId: requestSessionId', active_handler)

    def test_session_switch_keeps_background_stream_completion(self):
        html = HTML_PATH.read_text(encoding='utf-8')
        switch_start = html.rfind('async function switchSession(')
        switch_end = html.find('async function deleteSession(', switch_start)
        switch_body = html[switch_start:switch_end]

        stream_start = html.rfind('async function sendStreamMessage(')
        stream_end = html.find('async function clearChat()', stream_start)
        stream_body = html[stream_start:stream_end]

        self.assertIn('detachGenerationUiForSessionSwitch', switch_body)
        self.assertNotIn('ensureGenerationStoppedBeforeSessionChange', switch_body)
        self.assertIn('backgroundGenerationsBySession', html)
        self.assertIn('registerBackgroundGeneration', stream_body)
        self.assertIn("await appendSessionMessageServerState('assistant', finalAssistantText", stream_body)
        self.assertNotIn(
            "if (!isRequestStillCurrent(requestGeneration, requestSessionId)) {\n                return;\n            }\n            await appendSessionMessageServerState('assistant', finalAssistantText",
            stream_body,
        )

    def test_ubuntu_runners_override_loopback_bind_addresses(self):
        for runner in UBUNTU_RUNNERS:
            content = runner.read_text(encoding='utf-8')
            with self.subTest(runner=runner.name):
                self.assertIn('127.0.0.1|localhost|::1)', content)
                self.assertIn('export APP_HOST="0.0.0.0"', content)

    def test_index_page_has_deploy_auto_reload_hooks(self):
        html = HTML_PATH.read_text(encoding='utf-8')

        self.assertIn('meta name="windrise-app-version"', html)
        self.assertIn('__WINDRISE_APP_VERSION__', html)
        self.assertIn('setupWindriseDeployAutoReload', html)
        self.assertIn('/api/app-version', html)
        self.assertIn('/static/logo.svg?v=__WINDRISE_APP_VERSION__', html)

    def test_start_runner_writes_build_id_before_launch(self):
        runner = BASE_DIR.parent / 'deploy/start-windrise-web.sh'
        content = runner.read_text(encoding='utf-8')
        self.assertIn('.windrise_build_id', content)
        self.assertIn('WINDRISE_APP_VERSION', content)

    def test_stop_generation_force_resets_ui_state(self):
        html = HTML_PATH.read_text(encoding='utf-8')
        self.assertIn('function forceStopSessionGeneration(', html)
        self.assertIn('function healGenerationUi()', html)
        self.assertIn('forceStopSessionGeneration(currentSessionId', html)
        self.assertIn('input.disabled = true', html)
        self.assertIn('healGenerationUi();', html)

    def test_chat_failure_reports_full_web_error_details(self):
        html = HTML_PATH.read_text(encoding='utf-8')
        self.assertIn('function formatWebErrorReport(', html)
        self.assertIn('function logWebError(', html)
        self.assertIn('function createChatHttpError(', html)
        self.assertIn('logWebError(\'chat\', error);', html)
        self.assertIn('错误原因：', html)
        self.assertIn('排查建议：', html)
        self.assertIn('attachStreamErrorDetails(streamError, data);', html)


if __name__ == '__main__':
    import unittest

    unittest.main()
