import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock


class WindriseDeployVersionTest(unittest.TestCase):
  def test_get_windrise_app_version_prefers_env_then_file_then_fingerprint(self):
    with tempfile.TemporaryDirectory() as tmp_dir:
      module_dir = Path(tmp_dir)
      html_path = module_dir / 'index_zhipu.html'
      html_path.write_text('<html></html>', encoding='utf-8')
      build_id_path = module_dir / '.windrise_build_id'
      build_id_path.write_text('deploy-123\n', encoding='utf-8')
      server_path = module_dir / 'dify_web_server_.py'
      server_path.write_text('# stub\n', encoding='utf-8')

      with mock.patch.dict(os.environ, {'WINDRISE_APP_VERSION': 'env-version'}, clear=False):
        with mock.patch('dify_web_server_.BASE_DIR', str(module_dir)):
          with mock.patch('dify_web_server_.HTML_FILE', str(html_path)):
            with mock.patch('dify_web_server_.WINDRISE_BUILD_ID_FILE', str(build_id_path)):
              import dify_web_server_ as server

              self.assertEqual(server.get_windrise_app_version(), 'env-version')

      with mock.patch.dict(os.environ, {}, clear=True):
        with mock.patch('dify_web_server_.BASE_DIR', str(module_dir)):
          with mock.patch('dify_web_server_.HTML_FILE', str(html_path)):
            with mock.patch('dify_web_server_.WINDRISE_BUILD_ID_FILE', str(build_id_path)):
              import dify_web_server_ as server

              self.assertEqual(server.get_windrise_app_version(), 'deploy-123')

      build_id_path.unlink()
      with mock.patch.dict(os.environ, {}, clear=True):
        with mock.patch('dify_web_server_.BASE_DIR', str(module_dir)):
          with mock.patch('dify_web_server_.HTML_FILE', str(html_path)):
            with mock.patch('dify_web_server_.WINDRISE_BUILD_ID_FILE', str(build_id_path)):
              import dify_web_server_ as server

              fingerprint = server.get_windrise_app_version()
              self.assertEqual(len(fingerprint), 16)


if __name__ == '__main__':
  unittest.main()
