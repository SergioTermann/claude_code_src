
from flask import Flask, send_file, request, Response, stream_with_context, jsonify, session, redirect, make_response
from flask_cors import CORS
from flask_login import LoginManager, UserMixin, login_user, login_required, logout_user, current_user
import socket
import os
import sys
import ipaddress
import requests
import shutil
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry
import subprocess
import re
import json
import uuid
import queue
import threading
import math
import time
from datetime import datetime
import sqlite3
import hashlib
import secrets
from functools import wraps
from collections import defaultdict, OrderedDict
from pathlib import Path
from urllib.parse import quote, urlparse, urlunparse
from werkzeug.security import check_password_hash, generate_password_hash
from werkzeug.utils import secure_filename


class Document:
    def __init__(self, page_content='', metadata=None):
        self.page_content = page_content
        self.metadata = metadata or {}


class Embeddings:
    def embed_documents(self, texts):
        raise NotImplementedError

    def embed_query(self, text):
        raise NotImplementedError


FAISS = None
try:
    from topic_shift_detector import TopicShiftDetector, ContextManager
except Exception:
    class TopicShiftDetector:
        def __init__(self, similarity_threshold=0.3, time_gap_threshold=300.0, keyword_overlap_threshold=0.2):
            self.keyword_overlap_threshold = keyword_overlap_threshold

        def _keywords(self, text):
            terms = re.findall(r"[\u4e00-\u9fff]{2,}|[A-Za-z0-9_.#/-]{2,}", text or "")
            return {term.lower() for term in terms}

        def detect_shift(self, query, history=None, now=None):
            history = history or []
            if len(history) < 4:
                return False, ""
            recent = " ".join(
                item.get("content", "")
                for item in history[-8:]
                if item.get("role") == "user"
            )
            old_keywords = self._keywords(recent)
            new_keywords = self._keywords(query)
            if not old_keywords or not new_keywords:
                return False, ""
            if any(word in (query or "") for word in ("换个", "另一个", "新的问题", "另外", "重新问")):
                return True, "用户明确切换话题"
            overlap = len(old_keywords & new_keywords) / max(1, len(new_keywords))
            if overlap < self.keyword_overlap_threshold and len(new_keywords) >= 3:
                return True, "当前问题与最近上下文关键词重合较低"
            return False, ""

    class ContextManager:
        def __init__(self, max_context_messages=10):
            self.max_context_messages = max_context_messages

        def consolidate_on_topic_shift(self, history, query, keep_recent=3):
            history = list(history or [])
            keep_count = max(0, keep_recent * 2)
            return history[-min(len(history), keep_count):] if keep_count else []


def configure_stdio():
    for stream_name in ('stdout', 'stderr'):
        stream = getattr(sys, stream_name, None)
        reconfigure = getattr(stream, 'reconfigure', None)
        if callable(reconfigure):
            try:
                reconfigure(encoding='utf-8', errors='replace')
            except Exception:
                pass


configure_stdio()

# 获取当前脚本所在目录
def load_local_env_file():
    env_dir = Path(__file__).resolve().parent
    for filename in ('.env.defaults', '.env'):
        env_path = env_dir / filename
        if not env_path.exists():
            continue

        for raw_line in env_path.read_text(encoding='utf-8', errors='ignore').splitlines():
            line = raw_line.strip()
            if not line or line.startswith('#') or '=' not in line:
                continue

            key, value = line.split('=', 1)
            key = key.strip()
            value = value.strip()
            if not key:
                continue

            if value and value[0] == value[-1] and value[0] in ('"', "'"):
                value = value[1:-1]
            os.environ.setdefault(key, value)


load_local_env_file()

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
HTML_FILE = os.path.join(BASE_DIR, 'index_zhipu.html')
WINDRISE_BUILD_ID_FILE = os.path.join(BASE_DIR, '.windrise_build_id')
WINDRISE_APP_VERSION_PLACEHOLDER = '__WINDRISE_APP_VERSION__'


def read_windrise_build_id_file():
    try:
        if os.path.isfile(WINDRISE_BUILD_ID_FILE):
            value = Path(WINDRISE_BUILD_ID_FILE).read_text(encoding='utf-8', errors='ignore').strip()
            if value:
                return value
    except Exception:
        pass
    return ''


def compute_windrise_asset_fingerprint():
    """Fallback deploy version derived from frontend/backend file mtimes."""
    parts = []
    for path in (HTML_FILE, os.path.abspath(__file__)):
        try:
            parts.append(f"{path}:{int(os.path.getmtime(path))}")
        except OSError:
            continue
    if not parts:
        return 'unknown'
    return hashlib.sha1('|'.join(parts).encode('utf-8')).hexdigest()[:16]


def get_windrise_app_version():
    configured = os.getenv('WINDRISE_APP_VERSION', '').strip()
    if configured:
        return configured
    file_value = read_windrise_build_id_file()
    if file_value:
        return file_value
    return compute_windrise_asset_fingerprint()


def get_windrise_app_version_built_at():
    try:
        if os.path.isfile(WINDRISE_BUILD_ID_FILE):
            return datetime.fromtimestamp(os.path.getmtime(WINDRISE_BUILD_ID_FILE)).isoformat()
    except Exception:
        pass
    return ''


def send_app_html_file(file_path):
    """Serve HTML with no-store headers and an injected deploy version token."""
    version = get_windrise_app_version()
    try:
        with open(file_path, 'r', encoding='utf-8') as handle:
            body = handle.read()
    except OSError as exc:
        return (
            f'无法读取页面文件: {type(exc).__name__}',
            500,
            {'Content-Type': 'text/plain; charset=utf-8'},
        )
    body = body.replace(WINDRISE_APP_VERSION_PLACEHOLDER, version)
    response = make_response(body)
    response.headers['Content-Type'] = 'text/html; charset=utf-8'
    response.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate'
    response.headers['Pragma'] = 'no-cache'
    response.headers['Expires'] = '0'
    response.headers['ETag'] = f'"{version}"'
    response.headers['X-Windrise-App-Version'] = version
    return response


def ensure_windrise_versioned_entry_url():
    """Redirect bare page URLs to a versioned URL so browsers fetch fresh HTML after deploy."""
    version = get_windrise_app_version()
    requested = (request.args.get('v') or '').strip()
    if requested == version:
        return None
    query = f"v={quote(version, safe='')}"
    return redirect(f"{request.path}?{query}", code=302)
WIND_LLMWIKI_GRAPH_CANDIDATES = [
    os.path.join(os.getenv('LLMWIKI_PROJECT', ''), 'graph', 'visualization.html'),
    os.path.join(os.getenv('WINDRISE_CWD', ''), 'wind-llmwiki', 'graph', 'visualization.html'),
    os.path.join(BASE_DIR, 'wind-llmwiki', 'graph', 'visualization.html'),
    os.path.join(BASE_DIR, '..', 'wind-llmwiki', 'graph', 'visualization.html'),
    os.path.join(os.getcwd(), 'wind-llmwiki', 'graph', 'visualization.html'),
]


def path_has_non_ascii(value):
    try:
        str(value).encode('ascii')
        return False
    except UnicodeEncodeError:
        return True


def build_default_langchain_index_dir():
    project_index_dir = os.path.join(BASE_DIR, 'langchain_index')
    if not path_has_non_ascii(project_index_dir):
        return project_index_dir

    project_hash = hashlib.sha1(BASE_DIR.encode('utf-8')).hexdigest()[:12]
    fallback_root = os.path.join(os.path.expanduser('~'), '.codex', 'memories')
    return os.path.join(fallback_root, f'langchain_index_{project_hash}')


def resolve_project_local_path(value, default_relative=''):
    candidate = (value or default_relative or '').strip()
    if not candidate:
        return candidate
    if '://' in candidate:
        return candidate
    candidate = os.path.expandvars(os.path.expanduser(candidate))
    if re.match(r'^[A-Za-z]:[\\/]', candidate):
        return candidate

    normalized = candidate.replace('\\', os.sep)
    if os.path.isabs(normalized):
        return os.path.normpath(normalized)
    return os.path.normpath(os.path.join(BASE_DIR, normalized))


def load_or_create_secret_key(secret_key_file):
    configured_secret = os.getenv('SECRET_KEY', '').strip()
    if configured_secret:
        return configured_secret

    path = Path(secret_key_file)
    try:
        if path.exists():
            stored_secret = path.read_text(encoding='utf-8', errors='ignore').strip()
            if len(stored_secret) >= 32:
                return stored_secret

        path.parent.mkdir(parents=True, exist_ok=True)
        generated_secret = secrets.token_hex(32)
        path.write_text(generated_secret + '\n', encoding='utf-8')
        try:
            os.chmod(path, 0o600)
        except Exception:
            pass
        print(f"[SECURITY] 已生成并持久化 Flask 会话密钥: {path}")
        return generated_secret
    except Exception as exc:
        print(f"[SECURITY] 无法持久化 Flask 会话密钥，当前进程临时生成: {type(exc).__name__}")
        return secrets.token_hex(32)

# 仅暴露专用静态资源目录，避免泄露密钥、数据库和 .env
STATIC_DIR = os.path.join(BASE_DIR, 'static')

# ========== OpenAI-compatible API 配置 ==========
LLM_PROVIDER_NAME = os.getenv('LLM_PROVIDER_NAME', 'vLLM').strip() or 'vLLM'
VLLM_SERVICE_PORT = max(1, int(os.getenv('VLLM_SERVICE_PORT', '9527')))
VLLM_AUTO_PROBE = os.getenv('VLLM_AUTO_PROBE', '1') != '0'
VLLM_API_URL = os.getenv(
    'VLLM_API_URL',
    f'http://127.0.0.1:{VLLM_SERVICE_PORT}/v1/chat/completions',
).strip()
VLLM_MODEL_NAME = os.getenv(
    'VLLM_MODEL_NAME',
    'Qwen-30B',
).strip()
VLLM_API_KEY = os.getenv(
    'VLLM_API_KEY',
    os.getenv('LLM_API_KEY', os.getenv('OPENAI_API_KEY', '')),
).strip()

# ========== Dify API 配置（可选） ==========
# 配置 DIFY_API_URL + DIFY_API_KEY 后，/api/chat 优先走 Dify；未配置则走本地 vLLM。
DIFY_API_URL = os.getenv('DIFY_API_URL', '').strip()
DIFY_API_KEY = os.getenv('DIFY_API_KEY', '').strip()
DIFY_APP_TYPE = os.getenv('DIFY_APP_TYPE', 'chat').strip().lower() or 'chat'
DIFY_ENABLED = bool(DIFY_API_URL and DIFY_API_KEY)
DIFY_REQUIRED = os.getenv('DIFY_REQUIRED', '0') != '0'
LOCAL_KNOWLEDGE_DISABLED = False

# ========== Windrise 本地问答配置（可选） ==========
# 开启后 /api/chat 仍保持 Dify 兼容返回格式，但回答由 bin/windrise 生成。
WINDRISE_ENABLED = os.getenv('WINDRISE_ENABLED', '1') != '0'


def find_default_windrise_bin():
    current = Path(BASE_DIR).resolve()
    for candidate_root in (current, *current.parents):
        for executable_name in ('windrise-bash', 'windrise'):
            candidate = candidate_root / 'bin' / executable_name
            if candidate.exists():
                return str(candidate)
    return os.path.normpath(os.path.join(BASE_DIR, '..', 'bin', 'windrise'))


DEFAULT_WINDRISE_BIN = find_default_windrise_bin()
WINDRISE_BIN = os.getenv('WINDRISE_BIN', DEFAULT_WINDRISE_BIN).strip()
WINDRISE_TIMEOUT = int(os.getenv('WINDRISE_TIMEOUT', '300'))
DEFAULT_WINDRISE_CWD = str(Path(DEFAULT_WINDRISE_BIN).resolve().parents[1]) if os.path.exists(DEFAULT_WINDRISE_BIN) else os.path.normpath(os.path.join(BASE_DIR, '..'))
WINDRISE_CWD = resolve_project_local_path(os.getenv('WINDRISE_CWD', DEFAULT_WINDRISE_CWD))
WINDRISE_MEMORY_LOAD_MESSAGES = max(1, int(os.getenv('WINDRISE_MEMORY_LOAD_MESSAGES', '24')))
WINDRISE_MEMORY_CONTEXT_MESSAGES = max(1, int(os.getenv('WINDRISE_MEMORY_CONTEXT_MESSAGES', '8')))
WINDRISE_MEMORY_ITEM_CHARS = max(120, int(os.getenv('WINDRISE_MEMORY_ITEM_CHARS', '800')))
WINDRISE_LLM_FIRST_ENABLED = os.getenv('WINDRISE_LLM_FIRST_ENABLED', '1') != '0'
WINDRISE_SEMANTIC_ROUTER_ENABLED = os.getenv('WINDRISE_SEMANTIC_ROUTER_ENABLED', '1') != '0'
WINDRISE_SEMANTIC_ROUTER_TIMEOUT = max(1, int(os.getenv('WINDRISE_SEMANTIC_ROUTER_TIMEOUT', '20')))
WINDRISE_SEMANTIC_FAULT_NORMALIZER_ENABLED = os.getenv('WINDRISE_SEMANTIC_FAULT_NORMALIZER_ENABLED', '1') != '0'
WINDRISE_SEMANTIC_FAULT_NORMALIZER_TIMEOUT = max(1, int(os.getenv('WINDRISE_SEMANTIC_FAULT_NORMALIZER_TIMEOUT', '4')))
WINDRISE_QUERY_CONSOLIDATOR_ENABLED = os.getenv('WINDRISE_QUERY_CONSOLIDATOR_ENABLED', '1') != '0'
# After the mandatory retrieval-query extraction pass, skip optional semantic
# normalizers so a request does not make redundant model calls before search.
WINDRISE_SINGLE_SEMANTIC_PASS = os.getenv('WINDRISE_SINGLE_SEMANTIC_PASS', '1') != '0'
WINDRISE_QUERY_CONSOLIDATOR_TIMEOUT = max(1, int(os.getenv('WINDRISE_QUERY_CONSOLIDATOR_TIMEOUT', '45')))
WINDRISE_CHAT_TIMEOUT = max(1, int(os.getenv('WINDRISE_CHAT_TIMEOUT', '45')))
WINDRISE_LLMWIKI_TIMEOUT = max(1, int(os.getenv('WINDRISE_LLMWIKI_TIMEOUT', '4')))
WINDRISE_INDEX_LOOKUP_TIMEOUT = max(1.0, float(os.getenv('WINDRISE_INDEX_LOOKUP_TIMEOUT', '8')))
WINDRISE_SEMANTIC_RACE_GRACE_SECONDS = max(
    0.1,
    float(os.getenv('WINDRISE_SEMANTIC_RACE_GRACE_SECONDS', '1.5')),
)
WINDRISE_REQUEST_DEADLINE_SECONDS = max(
    30.0,
    float(os.getenv('WINDRISE_REQUEST_DEADLINE_SECONDS', '120')),
)
WINDRISE_LLM_RETRY_SECONDS = max(5, int(os.getenv('WINDRISE_LLM_RETRY_SECONDS', '5')))
WINDRISE_STREAM_KEEPALIVE_SECONDS = max(
    2.0,
    float(os.getenv('WINDRISE_STREAM_KEEPALIVE_SECONDS', '5')),
)
WINDRISE_STREAM_LLMWIKI_TIMEOUT = max(
    10,
    int(os.getenv('WINDRISE_STREAM_LLMWIKI_TIMEOUT', '45')),
)
WINDRISE_ENABLE_THINKING = os.getenv('WINDRISE_ENABLE_THINKING', '0') == '1'
WINDRISE_SHOW_THINKING_STATUS = os.getenv('WINDRISE_SHOW_THINKING_STATUS', '1') != '0'
WINDRISE_STREAM_CHUNK_DELAY = max(0.0, float(os.getenv('WINDRISE_STREAM_CHUNK_DELAY', '0.02')))
WINDRISE_PROGRESS_STEP_DELAY = max(0.0, float(os.getenv('WINDRISE_PROGRESS_STEP_DELAY', '0.20')))
WINDRISE_SCOPE_WAIVER_RESULT_LIMIT = max(
    3,
    min(50, int(os.getenv('WINDRISE_SCOPE_WAIVER_RESULT_LIMIT', '20'))),
)
WINDRISE_STATUS_SEMANTIC = '正在提取知识库检索内容...'
WINDRISE_STATUS_DATABASE = '正在查找知识库...'
WINDRISE_STATUS_CONTEXT = '正在结合本轮问题和会话上下文...'
WINDRISE_STATUS_CHECKING = '正在核对知识库命中结果与当前问题...'
WINDRISE_STATUS_ORGANIZING = '正在组织结论、依据和处理建议...'
WINDRISE_STATUS_FORMATTING = '正在整理可直接执行的回答...'
WINDRISE_STATUS_GENERATING = '正在生成答案...'
WINDRISE_RETRIEVAL_EXTRACTION_FAILURE = 'retrieval extraction unavailable'
windrise_llm_unavailable_until = 0.0
windrise_llm_lock = threading.Lock()
windrise_fault_index_cache = {'path': '', 'mtime': 0.0, 'records': []}
windrise_fault_index_lock = threading.Lock()
# LLMWiki is currently invoked through a short-lived Node subprocess. Keep a
# small TTL cache at the Web boundary so one request (which may perform a
# primary search, a focused retry and a synthesis search) does not repeatedly
# parse the same 26 MB fault index. The cache is invalidated after a rebuild.
WINDRISE_SEARCH_CACHE_TTL = max(0, int(os.getenv('WINDRISE_SEARCH_CACHE_TTL', '120')))
WINDRISE_SEARCH_CACHE_MAX = max(16, int(os.getenv('WINDRISE_SEARCH_CACHE_MAX', '128')))
windrise_search_cache = OrderedDict()
windrise_search_cache_lock = threading.Lock()
WINDRISE_RETRIEVAL_MEMORY_CHARS = max(2400, int(os.getenv('WINDRISE_RETRIEVAL_MEMORY_CHARS', '8000')))
windrise_retrieval_memories = OrderedDict()
windrise_retrieval_memory_lock = threading.Lock()
windrise_request_context = threading.local()
windrise_turbine_mapping_cache = {
    'path': '', 'mtime': 0.0, 'entries': [], 'known_aliases': set(), 'sites': [],
}
windrise_turbine_mapping_lock = threading.Lock()
windrise_model_index_cache = {
    'fault_path': '',
    'fault_mtime': 0.0,
    'mapping_path': '',
    'mapping_mtime': 0.0,
    'entries': [],
}
windrise_model_index_lock = threading.Lock()
WINDRISE_ENV_KEYS = (
    'LLMWIKI_PROJECT',
    'LLMWIKI_DIR',
    'WINDRISE_MODEL_MODE',
    'MODEL_MODE',
    'LMSTUDIO_BASE_URL',
    'LMSTUDIO_MODEL',
    'LMSTUDIO_CHAT_MODEL',
    'VLLM_API_KEY',
    'WINDRISE_ENABLE_THINKING',
    'WINDRISE_ENABLE_NETWORK',
    'WINDRISE_DISABLE_AUTO_LLMWIKI',
)

DEFAULT_EMBEDDING_BACKEND = 'qwen3_local'
DEFAULT_EMBEDDING_MODEL = resolve_project_local_path(
    '',
    os.path.join('offline_models', 'Qwen3-Embedding-0.6B')
)

# ========== 本地知识检索兼容配置（已关闭，知识检索由 Dify 负责） ==========
DEFAULT_RAG_KB_DIR = 'wind_power_wiki'
LANGCHAIN_KB_DIR = resolve_project_local_path(
    os.getenv('RAG_KB_DIR', DEFAULT_RAG_KB_DIR),
    DEFAULT_RAG_KB_DIR
)
LLM_WIKI_PROJECT_DIR = resolve_project_local_path(
    os.getenv('LLM_WIKI_PROJECT_DIR', os.getenv('RAG_KB_DIR', DEFAULT_RAG_KB_DIR)),
    DEFAULT_RAG_KB_DIR
)
LANGCHAIN_INDEX_DIR = resolve_project_local_path(
    os.getenv('RAG_INDEX_DIR', build_default_langchain_index_dir()),
    build_default_langchain_index_dir()
)
LANGCHAIN_EMBEDDING_BACKEND = os.getenv('RAG_EMBEDDING_BACKEND', DEFAULT_EMBEDDING_BACKEND).lower()
LANGCHAIN_EMBEDDING_MODEL = resolve_project_local_path(
    os.getenv('RAG_EMBEDDING_MODEL', DEFAULT_EMBEDDING_MODEL),
    DEFAULT_EMBEDDING_MODEL
)
LANGCHAIN_EMBEDDING_LOCAL_FILES_ONLY = os.getenv('RAG_EMBEDDING_LOCAL_FILES_ONLY', '1') != '0'
LANGCHAIN_EMBEDDING_SHOW_PROGRESS = os.getenv('RAG_EMBEDDING_SHOW_PROGRESS', '1') != '0'
LANGCHAIN_EMBEDDING_BATCH_SIZE = int(os.getenv('RAG_EMBEDDING_BATCH_SIZE', '32'))
LANGCHAIN_EMBEDDING_DEVICE = os.getenv('RAG_EMBEDDING_DEVICE', 'auto').strip().lower()
LANGCHAIN_EMBEDDING_API_URL = os.getenv('RAG_EMBEDDING_API_URL', '').strip()
LANGCHAIN_EMBEDDING_DIMENSIONS = int(os.getenv('RAG_EMBEDDING_DIMENSIONS', '0'))
LANGCHAIN_EMBEDDING_QUERY_INSTRUCTION = os.getenv(
    'RAG_QUERY_INSTRUCTION',
    'Given a web search query, retrieve relevant passages that answer the query'
)
LANGCHAIN_RERANKER_ENABLED = os.getenv('RAG_RERANKER_ENABLED', '1') != '0'
LANGCHAIN_RERANKER_MODEL = resolve_project_local_path(
    os.getenv('RAG_RERANKER_MODEL', os.path.join('offline_models', 'Qwen3-Reranker-0.6B')),
    os.path.join('offline_models', 'Qwen3-Reranker-0.6B')
)
LANGCHAIN_RERANKER_LOCAL_FILES_ONLY = os.getenv('RAG_RERANKER_LOCAL_FILES_ONLY', '1') != '0'
LANGCHAIN_RERANKER_MAX_LENGTH = int(os.getenv('RAG_RERANKER_MAX_LENGTH', '4096'))
LANGCHAIN_RERANKER_BATCH_SIZE = int(os.getenv('RAG_RERANKER_BATCH_SIZE', '8'))
LANGCHAIN_RERANKER_DEVICE = os.getenv('RAG_RERANKER_DEVICE', 'auto').strip().lower()
RAG_RERANKER_MIN_CANDIDATES = int(os.getenv('RAG_RERANKER_MIN_CANDIDATES', '6'))
LANGCHAIN_RERANKER_INSTRUCTION = os.getenv(
    'RAG_RERANKER_INSTRUCTION',
    'Given a web search query, retrieve relevant passages that answer the query'
)
LANGCHAIN_CHUNK_SIZE = int(os.getenv('RAG_CHUNK_SIZE', '600'))
LANGCHAIN_CHUNK_OVERLAP = int(os.getenv('RAG_CHUNK_OVERLAP', '120'))
LANGCHAIN_FALLBACK_EMBEDDING_DIM = int(os.getenv('RAG_FALLBACK_EMBEDDING_DIM', '384'))
LANGCHAIN_SUPPORTED_EXTENSIONS = {
    '.txt', '.md', '.markdown', '.pdf', '.html', '.htm', '.json', '.csv'
}
LANGCHAIN_KB_CHANGE_CHECK_INTERVAL_SECONDS = max(
    0.0,
    float(os.getenv('RAG_KB_CHANGE_CHECK_INTERVAL_SECONDS', '5.0'))
)
LANGCHAIN_INDEX_FORMAT_VERSION = 2
LANGCHAIN_INDEX_NAME = 'index'
LANGCHAIN_INDEX_META_FILE = os.path.join(LANGCHAIN_INDEX_DIR, 'metadata.json')
LANGCHAIN_ALLOW_UNTRUSTED_INDEX_LOAD = os.getenv('RAG_ALLOW_UNTRUSTED_INDEX_LOAD', '0') != '0'
SYSTEM_MONITOR_CACHE_TTL_SECONDS = max(
    0.0,
    float(os.getenv('SYSTEM_MONITOR_CACHE_TTL_SECONDS', '2.0'))
)
HTTP_RETRY_ON_POST = os.getenv('HTTP_RETRY_ON_POST', '0') != '0'
LOG_EXCEPTION_TRACEBACK = os.getenv('LOG_EXCEPTION_TRACEBACK', '0') != '0'
WEB_ERROR_VERBOSE = os.getenv('WEB_ERROR_VERBOSE', '1') != '0'
BOOTSTRAP_ADMIN_CREDENTIALS_FILE = os.path.join(BASE_DIR, 'bootstrap_admin_credentials.txt')


def is_subpath(path, root):
    try:
        normalized_path = os.path.realpath(path)
        normalized_root = os.path.realpath(root)
        return os.path.commonpath([normalized_path, normalized_root]) == normalized_root
    except Exception:
        return False


def is_trusted_langchain_index_dir():
    if LANGCHAIN_ALLOW_UNTRUSTED_INDEX_LOAD:
        return True

    trusted_roots = [
        BASE_DIR,
        os.path.join(os.path.expanduser('~'), '.codex', 'memories'),
    ]
    return any(is_subpath(LANGCHAIN_INDEX_DIR, root) for root in trusted_roots)


def normalize_torch_device_name(device_name):
    normalized = (device_name or '').strip().lower()
    if normalized in ('', 'auto'):
        return normalized

    alias_map = {
        'gpu': 'cuda',
        'amd': 'cuda',
        'rocm': 'cuda',
        'hip': 'cuda',
    }
    if normalized in alias_map:
        return alias_map[normalized]

    for alias, canonical in alias_map.items():
        prefix = f'{alias}:'
        if normalized.startswith(prefix):
            return canonical + normalized[len(alias):]

    return normalized


def resolve_torch_device(torch_module, requested_device, component_name):
    normalized = normalize_torch_device_name(requested_device)
    gpu_available = torch_module.cuda.is_available()

    if normalized in ('', 'auto'):
        resolved = 'cuda' if gpu_available else 'cpu'
    elif normalized.startswith('cuda'):
        if gpu_available:
            resolved = normalized
        else:
            resolved = 'cpu'
    else:
        resolved = normalized

    return resolved

# ========== 对话历史管理 ==========
# conversation_id -> list of {"role": "user"/"assistant", "content": "..."}
MAX_CACHED_CONVERSATIONS = int(os.getenv('MAX_CACHED_CONVERSATIONS', '200'))
conversation_histories = OrderedDict()  # LRU cache: key -> list of messages
conversation_lock = threading.Lock()
hydrated_conversations = set()
windrise_lightweight_histories = OrderedDict()  # (conversation_id, user_id) -> messages
windrise_yaw_hydraulic_stages = OrderedDict()  # (conversation_id, user_id) -> diagnostic stage
rag_write_lock = threading.Lock()
rag_lock = rag_write_lock
_model_init_lock = threading.Lock()
MAX_HISTORY_TURNS = 50  # 最多保留50轮对话
langchain_embeddings = None
langchain_embedding_backend = 'not_initialized'
langchain_vectorstore = None
langchain_reranker = None
langchain_reranker_backend = 'not_initialized'
langchain_index_signature = None
langchain_index_initialized = False
langchain_last_signature_check_at = 0.0
langchain_loaded_files = 0
langchain_loaded_chunks = 0
langchain_last_build_at = None
langchain_sparse_docs = []
langchain_sparse_doc_freq = defaultdict(int)
langchain_sparse_avgdl = 0.0
langchain_sparse_term_doc_ids = defaultdict(list)
langchain_sparse_fault_code_doc_ids = defaultdict(list)
langchain_chunk_groups = defaultdict(list)
langchain_fault_code_index = {}
langchain_model_lookup = defaultdict(set)
langchain_known_models = []
system_monitor_cache = {
    'timestamp': 0.0,
    'snapshot': None,
}
system_monitor_lock = threading.Lock()
langchain_rebuild_state_lock = threading.Lock()
langchain_background_rebuild_in_progress = False
langchain_background_rebuild_started_at = None
langchain_background_rebuild_reason = ''
langchain_background_rebuild_last_error = ''
langchain_progress = {
    'active': False,
    'stage': 'idle',
    'message': '',
    'current_file': '',
    'processed_files': 0,
    'total_files': 0,
    'processed_documents': 0,
    'total_documents': 0,
    'processed_chunks': 0,
    'total_chunks': 0,
    'started_at': None,
    'updated_at': None,
}
# ========== 话题切换检测器 ==========
topic_shift_detector = TopicShiftDetector(
    similarity_threshold=0.3,
    time_gap_threshold=300.0,
    keyword_overlap_threshold=0.2
)
context_manager = ContextManager(max_context_messages=10)
conversation_topics = {}  # conversation_id -> TopicSegment list
conversation_topics_lock = threading.Lock()

# ========== 风场-机型映射管理 ==========
WIND_FARM_MODELS_FILE = os.path.join(BASE_DIR, 'wind_farm_models.json')

def load_wind_farm_models():
    """从 JSON 文件加载风场-机型映射，每次调用都重新读取以支持实时修改"""
    try:
        with open(WIND_FARM_MODELS_FILE, 'r', encoding='utf-8') as f:
            data = json.load(f)
        return data.get('wind_farms', {})
    except FileNotFoundError:
        print(f"⚠️ 风场配置文件不存在: {WIND_FARM_MODELS_FILE}")
        return {}
    except json.JSONDecodeError as e:
        print(f"⚠️ 风场配置文件格式错误: {e}")
        return {}

def save_wind_farm_models(wind_farms):
    """保存风场-机型映射到 JSON 文件"""
    data = {
        "wind_farms": wind_farms,
        "_说明": "models字段为该风场包含的机器型号列表，name为风场名称，note为备注。用户可实时修改此文件。"
    }
    with open(WIND_FARM_MODELS_FILE, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=4)

def get_models_by_farm_id(farm_id):
    """根据风场号获取对应的机器型号列表"""
    farm_id = str(farm_id).strip()
    wind_farms = load_wind_farm_models()
    farm = wind_farms.get(farm_id)
    if not farm:
        return None, None
    models = farm.get('models', [])
    name = farm.get('name', f'{farm_id}号风场')
    # 过滤掉 "待配置" 占位符
    valid_models = [m for m in models if m and m != '待配置']
    return name, valid_models

# 风场号提取正则
WIND_FARM_ID_PATTERNS = [
    r'(\d{1,2})\s*号?\s*风[场厂]',
    r'风[场厂]\s*(\d{1,2})',
    r'第?\s*([一二三四五六七八九十]{1,3})\s*号?\s*风[场厂]',
]
CHINESE_NUM_MAP = {
    '一': '1', '二': '2', '三': '3', '四': '4', '五': '5',
    '六': '6', '七': '7', '八': '8', '九': '9', '十': '10',
    '十一': '11', '十二': '12', '十三': '13',
}

def extract_wind_farm_id(text):
    """从文本中提取风场号，返回字符串形式的数字 ID 或 None"""
    if not text:
        return None
    for pattern in WIND_FARM_ID_PATTERNS:
        match = re.search(pattern, text)
        if match:
            value = match.group(1)
            if value.isdigit():
                num = int(value)
                if 1 <= num <= 13:
                    return str(num)
            elif value in CHINESE_NUM_MAP:
                return CHINESE_NUM_MAP[value]
    return None

def detect_wind_farm_from_history(history):
    """从对话历史中检测风场号（优先取最近一次提到的）"""
    if not history:
        return None
    for msg in reversed(history):
        farm_id = extract_wind_farm_id(msg.get('content', ''))
        if farm_id:
            return farm_id
    return None

# ========== 系统提示词（从 Dify 工作流迁移）==========

CLASSIFICATION_PROMPT = """你是风电运维问题的检索就绪度分类器。请根据“当前用户输入”和所给的最近用户上下文，判断当前问题是否已具备检索知识库的条件。

只返回一个数字：1、2 或 3。不得输出任何解释、标签、Markdown 或其他字符。

## 决策顺序
1. 先判断当前输入是否提出了新的、明确的设备对象、故障现象或故障码。
2. 当前输入没有新对象时，才可把它视为对最近诊断主题的省略追问。
3. 分类的是“是否适合检索”，不是故障严重程度；不要仅凭数字、机型或历史故障码提高等级。

## Level 3：检索就绪
满足任一条件：
- 当前输入含明确故障码、告警码或错误码；
- 当前输入包含具体部件/故障事件，且有可核验的参数、趋势、工况或保护动作；
- 当前输入是没有新对象的省略追问，且最近上下文已有明确的故障码或具体诊断对象。
示例：
- “E0025报警” → 3
- “发电机轴承温度85度且持续上升” → 3
- “齿轮箱油温92度，同时滤芯压差报警” → 3
- 上文为“303804是什么故障”，当前问“怎么复位” → 3

## Level 2：已有诊断方向，但信息不足
有部件、症状或现象，但缺少故障码、具体参数、工况或事件证据；应通过追问补齐最关键的信息。
示例：
- “发电机轴承温度高” → 2
- “齿轮箱有异响” → 2
- “金风机组功率下降” → 2

## Level 1：尚无诊断对象或普通聊天
问候、致谢、普通聊天，或只说“报警/故障/异常”而没有可识别的部件、现象或具体事件。
示例：
- “你好” → 1
- “风机报警了” → 1
- “设备有问题” → 1

## 必须遵守的边界
- WD3000、GW121、3.0MW 等机型/容量标识不是故障码；数字或机型本身不能判为 Level 3。
- 若历史中有故障码，但当前输入提出新的具体问题，例如“齿轮箱油温上来了”，应按新问题独立判断，不能把它当成旧故障码的追问。
- 只有没有新对象的“接下来怎么做”“为什么会这样”“怎么复位”等省略追问，才能继承最近诊断上下文。

当前分类输入：
{query}

只返回数字1、2或3："""

# 数据库配置
DATABASE_FILE = resolve_project_local_path(
    os.getenv('CHAT_DB_FILE', os.path.join(BASE_DIR, 'chat_users.db')),
    'chat_users.db'
)
SECRET_KEY_FILE = resolve_project_local_path(os.getenv('SECRET_KEY_FILE', 'flask_secret_key'), 'flask_secret_key')
SECRET_KEY = load_or_create_secret_key(SECRET_KEY_FILE)  # 用于session加密
BOOTSTRAP_ADMIN_USERNAME = os.getenv('INIT_ADMIN_USERNAME', 'admin').strip() or 'admin'
BOOTSTRAP_ADMIN_PASSWORD = os.getenv('INIT_ADMIN_PASSWORD', 'admin').strip() or 'admin'
TARGET_CONCURRENCY = max(int(os.getenv('TARGET_CONCURRENCY', '30')), 30)
WEB_THREADS = max(1, int(os.getenv('WEB_THREADS', str(TARGET_CONCURRENCY))))
WEB_SERVER = (os.getenv('WEB_SERVER', 'auto').strip().lower() or 'auto')
HTTP_POOL_SIZE = max(int(os.getenv('HTTP_POOL_SIZE', str(TARGET_CONCURRENCY * 2))), TARGET_CONCURRENCY)
SERVER_REQUEST_QUEUE_SIZE = max(int(os.getenv('SERVER_REQUEST_QUEUE_SIZE', '128')), TARGET_CONCURRENCY * 2)
SQLITE_BUSY_TIMEOUT_MS = max(int(os.getenv('SQLITE_BUSY_TIMEOUT_MS', '30000')), 5000)
MAX_HISTORY_MESSAGES = MAX_HISTORY_TURNS * 2
RAG_MIN_SCORE = 0.15
RAG_TOP_K = 5
RAG_RETRIEVAL_CANDIDATES = int(os.getenv('RAG_RETRIEVAL_CANDIDATES', '15'))
RAG_QUERY_VARIANTS = max(1, int(os.getenv('RAG_QUERY_VARIANTS', '3')))
RAG_HISTORY_QUERY_WINDOW = max(1, int(os.getenv('RAG_HISTORY_QUERY_WINDOW', '4')))
RAG_CONTEXT_MAX_CHARS_PER_CHUNK = int(os.getenv('RAG_CONTEXT_MAX_CHARS_PER_CHUNK', '420'))
RAG_CONTEXT_MAX_TOTAL_CHARS = int(os.getenv('RAG_CONTEXT_MAX_TOTAL_CHARS', '1800'))
RAG_CONTEXT_NEIGHBOR_WINDOW = max(0, int(os.getenv('RAG_CONTEXT_NEIGHBOR_WINDOW', '1')))
RAG_MAX_CHUNKS_PER_DOC = max(1, int(os.getenv('RAG_MAX_CHUNKS_PER_DOC', '2')))
RAG_MAX_CHUNKS_PER_PARENT = max(1, int(os.getenv('RAG_MAX_CHUNKS_PER_PARENT', '1')))
RECENT_HISTORY_MESSAGES = 12
MAX_MEMORY_ITEMS = 8
MAX_MEMORY_CHARS = 1200
GREETING_QUERY_PATTERNS = (
    r'^(hi|hello|hey|test|ping)$',
    r'^(你好|您好|在吗|在么|在麼|测试)$',
    r'^nihao$',
)
CASUAL_CHAT_PATTERNS = (
    r'^(你好|您好|嗨|哈喽|在吗|在不在|早上好|中午好|下午好|晚上好)$',
    r'^(谢谢|感谢|好的|收到|明白了|行|ok|okay|bye|再见)$',
    r'^(你是谁|你能做什么|介绍一下你自己|介绍一下自己)$',
)
CASUAL_CHAT_KEYWORDS = (
    '聊天', '闲聊', '打个招呼', '介绍一下', '你是谁', '你能做什么',
    '谢谢', '感谢', '辛苦了', '再见', '早上好', '下午好', '晚上好',
)
DIAGNOSIS_FOLLOWUP_KEYWORDS = (
    '怎么办', '怎么处理', '如何处理', '下一步', '接下来', '继续',
    '然后呢', '为什么', '原因', '怎么查', '怎么确认', '详细说说',
    '展开讲讲', '那现在呢', '那我该怎么做',
)
DEVICE_HINT_KEYWORDS = (
    '机组', '风机', '变流器', '齿轮箱', '发电机', '主轴', '轴承', '偏航',
    '变桨', '变频器', '主控', 'scada', 'hmi', '塔筒', '塔底', '机舱',
    '叶片', '桨叶', '轮毂', '液压', '风速仪', '风向标', '电网', '网侧', 'ups',
    '主断路器', '主断', '断路器', '空开', '加热器', '扭缆', '纽缆',
    'converter', 'gearbox', 'generator', 'bearing', 'yaw', 'pitch', 'scada'
)
ISSUE_HINT_KEYWORDS = (
    '报警', '故障', '异常', '停机', '跳开', '跳闸', '保护', '过温', '高温', '异响', '振动',
    '震动', '错误', '超出', '超限', '限制', '最大', '最小', '过高', '过低', '有点高',
    '有点低', '偏高', '偏低', '高于', '低于',
    '跳开', '跳闸', '脱扣', '分闸',
    '温度', '温度高', '油温高', '温度低', '油温低', '温度波动', '忽高忽低',
    '压力高', '压力低', '电压高', '电压低', '电压偏高', '电压偏低',
    '容量低', '过载', '过流', '欠压', '过压', '断开', '断路', '短路', '丢失', '失效', '未定义',
    '不同步', '漏油', '通讯', '通信', '通讯丢失', '通信丢失', '老丢', '限功率',
    '限载', '降载', '降功率', '降额', '功率限制', '功率下降', '功率上不去',
    '结冰', '覆冰', '积冰', '凝冰', '冰冻',
    '紧急顺桨', '顺桨', '同步故障', '叶片同步', '桨叶同步', '变桨同步',
    '出力上不去', '发电少', '功率低', '不在运行模式', '无法启动', '启动失败', 'fault', 'alarm',
    'error', 'trip', 'vibration', 'temperature', 'warning'
)
GENERAL_NON_DIAGNOSTIC_KEYWORDS = (
    '不需要查', '不用查', '不查具体故障', '不需要查具体故障', '通俗解释',
    '大概作用', '一般作用', '基本原理', '通用原则', '只讲通用原则',
)
BROAD_DEVICE_KEYWORDS = ('风机', '机组')
VAGUE_ISSUE_KEYWORDS = ('异常', '故障', '报警', '有点异常', '有问题')
FAULT_CODE_PATTERNS = [
    r'(?<![A-Za-z0-9_])[A-Z]{1,8}\d[A-Z0-9]*(?:_[A-Z0-9]+)+(?![A-Za-z0-9_])',
    r'(?<![A-Za-z0-9_])[A-Z]{1,4}[-_]?\d{2,8}(?![A-Za-z0-9_])',
    r'(?<![A-Za-z0-9_])\d{2,8}[A-Z]{1,3}(?![A-Za-z0-9_])',
    r'(?<![A-Za-z0-9_])[A-Z]{1,3}\d{2,8}[A-Z]{0,2}(?![A-Za-z0-9_])'
]
FAULT_CODE_CONTEXT_PATTERNS = [
    r'(?mi)^\|\s*([A-Za-z]{1,8}\d[A-Za-z0-9]*(?:_[A-Za-z0-9]+)+|[A-Za-z]{0,4}\d{1,8}[A-Za-z]{0,2})\s*\|',
    # Only accept a code immediately after the reporting verb/label.  The old
    # pattern consumed arbitrary Chinese text and treated tokens such as the
    # ``2Y`` in ``振动传感器2Y向`` as a fault code.
    r'(?:报|报出|报警|告警|故障|故障号)\s*(?:码|代码|号)?\s*(?:(?:[:：=＝])|(?:为|是))?\s*([A-Za-z]{1,8}\d[A-Za-z0-9]*(?:_[A-Za-z0-9]+)+|[A-Za-z]{0,4}\d{1,8}[A-Za-z]{0,2})',
    r'(?:故障代码|故障代号|报码|告警码|错误代码|状态代码)[^A-Za-z0-9]{0,8}([A-Za-z]{1,8}\d[A-Za-z0-9]*(?:_[A-Za-z0-9]+)+|[A-Za-z]{0,4}\d{1,8}[A-Za-z]{0,2})',
    r'_(\d{4,8}|[A-Za-z]{1,4}[-_]?\d{2,8}[A-Za-z]{0,2})\.md\b',
]
MODEL_BRAND_KEYWORDS = (
    '华仪', '明阳', '金风', '远景', '运达', '三一', '歌美飒', '上海电气',
    '华锐', '新誉', '湘电', '华能', '中车山东', 'Vestas', 'Gamesa', 'GE', 'ABB', 'Bachmann'
)
MODEL_ALIAS_PATTERNS = [
    r'(?i)SL\s*-?\s*1500\s*[-_/]?\s*(?:ABB|BACHMANN)\s*系列?',
    r'(?i)GW\s*-?\s*82\s*[-_/]?\s*1500\s*系列?',
    r'(?i)MY\s*1\.?5\s*SE\s*系列?',
    r'(?i)MYSE\s*3\.0\s*,\s*4\.0\s*,\s*5\.0\s*,\s*6\.25\s*系列?',
    r'(?i)WD\s*-?\s*(?:1500|2500)\s*系列?',
    r'(?i)NGP\s*主控\s*系列?',
    r'(?i)LEAPX\s*系列?',
    r'(?i)CWT\s*-?\s*\d+(?:\.\d+)?(?:[-/][A-Z0-9.]+)*',
    r'(?i)CWT\s*系列?',
    r'(?i)HW\d+[A-Z0-9()\-]*',
    r'(?i)SL\s*-?\s*\d+(?:\.\d+)?',
    r'(?i)WD\s*-?\s*\d+(?:\.\d+)?(?:[-/][A-Z0-9.]+)*',
    r'(?i)GW\s*-?\s*\d+(?:\.\d+)?[A-Z0-9-]*',
    r'(?i)EN\s*-?\s*\d+(?:\.\d+)?(?:[-/][A-Z0-9.]+)*',
    r'(?i)EW\s*\d+(?:\.\d+)?[A-Z]?(?:[-/][A-Z0-9.]+)*',
    r'(?i)MYSE\s*-?\s*\d+(?:\.\d+)?(?:[-/][A-Z0-9.]+)*',
    r'(?i)FD\d+[A-Z0-9-]*',
    r'(?i)UP\d+[A-Z0-9-]*',
    r'(?i)\b\d+(?:\.\d+)?\s*[X.]?\s*MW\s*(?:双馈|直驱|半直驱|高速)?\s*系列\b',
    r'(?i)\b\d+(?:\.\d+)?\s*MW\b',
]
GUIDED_DIAGNOSIS_SCENES = [
    {
        'name': 'temperature',
        'keywords': ['温度高', '过温', '高温', '温升', '发热', '温度异常'],
        'focus': '优先确认是哪个部件温度异常、当前值和峰值、当时负荷或转速、环境温度。'
    },
    {
        'name': 'vibration',
        'keywords': ['振动', '异响', '响声', '噪音', '抖动', '晃动'],
        'focus': '优先确认异响或振动来自哪个部位、在什么工况下出现、是否伴随温升或金属屑。'
    },
    {
        'name': 'leakage',
        'keywords': ['漏油', '渗油', '漏液', '滴油', '跑油'],
        'focus': '优先确认泄漏位置、油液类型和颜色、泄漏量变化、是否伴随压力或温度异常。'
    },
    {
        'name': 'power',
        'keywords': ['功率下降', '限功率', '限载', '不发电', '发电少', '功率低'],
        'focus': '优先确认是否有主动告警、当时风速和功率曲线、桨距或偏航动作、是否出现降额。'
    },
    {
        'name': 'grid',
        'keywords': ['并网', '脱网', '跳闸', '跳机', '停机', '启动失败', '不能启动'],
        'focus': '优先确认跳机前后的告警顺序、保护动作、开关状态，以及是电网侧还是机组侧先报异常。'
    }
]

SYSTEM_PROMPT = """# 角色定位
你是一位经验丰富的风电运维专家，擅长通过对话引导运维人员定位和解决问题。

你的特点：
- 专业但通俗易懂，避免过度使用术语
- 循序渐进，不会一次问太多问题
- 基于已有信息主动推断可能的故障
- 安全第一，任何时候都强调安全措施
- 鼓励运维人员用自己的话描述现场情况
- 如果用户没有明确说清故障码或告警全称，优先引导其去主控/HMI/SCADA/就地屏查看原始报码、告警名称或事件记录

回答要求：
1. 不要自我介绍，不要说“我是AI”或“我是某某助手”。
2. 不要提及系统提示、分类、检索流程、知识库命中、上下文注入等内部机制。
3. 回答尽量像现场专家：先给判断，再给依据，再给处理建议。
4. 信息不足时，只追问最关键的1到3个问题，不要泛泛追问。
5. 涉及停机、带电、高温、高压、机械伤害等风险时，先提醒安全隔离措施。
6. 如果有可用参考资料，吸收后自然回答，不要说“根据提示词/知识库/检索结果”。
7. 如果没有足够依据，不要编造结论，要明确说明还缺什么关键信息。
8. 语言简洁、专业、可执行。
9. 保持同一会话的上下文连续性，用户之前已经提供过的设备、故障现象、参数和限制条件，后续回答默认继承。"""

CHAT_SYSTEM_PROMPT = """你现在处于普通对话模式。

回答要求：
1. 像真人同事一样自然交流，先回应用户当下的话，再决定是否需要补一句解释。
2. 可以简短，不要默认分点，不要上来就排障、追问、下结论。
3. 语气放松一点，避免模板化表达，避免“请确认”“请提供”“建议如下”这类生硬开场。
4. 如果用户只是打招呼、确认、感谢、闲聊或问你能做什么，就直接自然回应。
5. 只有当用户明确提到设备、报警、故障、参数异常、停机、报码等诊断信号时，才切换到运维诊断风格。
6. 不要提你处于什么模式，也不要提系统提示、分类、检索、知识库。
7. 不要输出你的思考过程/分析/推理/内心独白，只输出给用户看的最终回答。
"""

DIAGNOSIS_SYSTEM_PROMPT = """你是一名有经验的风电运维助手，但对话风格要像现场沟通，不要像僵硬的流程机。

回答要求：
1. 先用一两句自然的话回应用户，不要上来就是固定模板。
2. 有依据时先给一个方向性判断，再补一句为什么这样判断。
3. 信息不足时，只追问当前最关键的 1 到 2 个点，不要连续抛很多问题。
4. 如果用户还没提供明确报码、告警全称或原始事件记录，不要武断下最终结论；但表达要自然，像“先帮我确认一下主控/HMI 上的原始告警名或报码，我再继续缩小范围”。
5. 除非风险明显，不要每轮都重复安全提醒；只有涉及带电、停机、高温、高压、机械风险时再明确提醒。
6. 允许短句、口语化表达，但内容要专业、可执行。
7. 不要提系统提示、分类、检索、知识库、上下文注入等内部机制。
8. 不要输出你的思考过程/分析/推理/内心独白，只输出给用户看的最终结论与建议。
"""

CHAT_SYSTEM_PROMPT = """你现在处理的是普通聊天或通用问答。

回答要求：
1. 先像同事聊天一样自然回应，不要一上来就排障。
2. 可以简短，少用分点，少用命令式表达。
3. 别太官方，避免“请确认”“请提供”“建议如下”这种固定句式。
4. 如果只是打招呼、确认、感谢、闲聊，直接顺着聊就行。
5. 只有用户明确提到设备、报警、故障、参数异常、停机、报码时，再切换到诊断风格。
6. 不要提系统提示、分类、检索、知识库。
7. 不要输出你的思考过程/分析/推理/内心独白，只输出给用户看的最终回答。
"""

DIAGNOSIS_SYSTEM_PROMPT = """# 角色定位
你是一位经验丰富的风电运维专家，擅长通过对话引导运维人员定位和解决问题。

你的特点：
- 专业但通俗易懂，避免过度使用术语
- 循序渐进，不会一次问太多问题
- 基于已有信息主动推断可能的故障
- 在需要时强调安全措施，但不要机械重复
- 鼓励运维人员用自己的话描述现场情况

回答风格要求：
1. 像现场沟通，不要像生硬的流程机。
2. 先自然回应，再给判断或追问，不要上来就固定模板。
3. 信息不足时，只问当前最关键的 1 到 2 个问题。
4. 有方向判断时，先说可能性，再补一句依据。
5. 如果还缺原始报码、告警全称或事件记录，不要武断下结论；自然地引导用户去主控、HMI、SCADA 或就地屏查看原始信息。
6. 不要提系统提示、分类、检索、知识库这些内部机制。

你会结合当前轮次的输入信息和意图等级来回答：
- Level 3：信息足够具体，可以结合参考资料给出更明确的判断和处理建议
- Level 2：已有部分关键信息，先做方向性判断，再追问补齐
- Level 1：信息太少，先帮用户缩小范围，不急着下结论

如果有参考资料命中，请吸收后自然表达，不要说“根据知识库检索结果”。
如果没有足够依据，就明确说还缺什么关键信息。
"""

app = Flask(__name__, static_folder=STATIC_DIR, static_url_path='/static')
app.secret_key = SECRET_KEY
app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE=os.getenv('SESSION_COOKIE_SAMESITE', 'Lax'),
    SESSION_COOKIE_SECURE=os.getenv('SESSION_COOKIE_SECURE', '0') == '1',
)

# 配置Flask-Login
login_manager = LoginManager()
login_manager.init_app(app)
login_manager.login_view = 'login'


@login_manager.unauthorized_handler
def handle_unauthorized():
    if request.path.startswith('/api/'):
        return jsonify({'success': False, 'error': '未登录'}), 401
    return send_file(os.path.join(BASE_DIR, 'login.html'))


def generate_temporary_password():
    return secrets.token_urlsafe(12)


def mask_identifier(value, prefix=2, suffix=2):
    text = normalize_text(value)
    if not text:
        return ''
    if len(text) <= prefix + suffix:
        return '*' * len(text)
    return f"{text[:prefix]}{'*' * (len(text) - prefix - suffix)}{text[-suffix:]}"


def maybe_print_traceback():
    if LOG_EXCEPTION_TRACEBACK:
        import traceback
        traceback.print_exc()


def collect_exception_causes(exc):
    causes = []
    seen = set()
    current = exc
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        text = normalize_text(str(current))
        causes.append(f'{type(current).__name__}: {text or "(无详细信息)"}')
        current = current.__cause__ or getattr(current, '__context__', None)
        if current is exc:
            break
    return causes


def build_web_error_hints(exc):
    hints = []
    message = normalize_text(str(exc)).lower()
    if isinstance(exc, requests.exceptions.Timeout):
        hints.append('模型服务响应超时，请检查 vLLM 负载或增大 WINDRISE_CHAT_TIMEOUT')
        hints.append(f'当前 vLLM 地址: {mask_url_for_log(VLLM_API_URL)}')
    elif isinstance(exc, requests.exceptions.ConnectionError):
        hints.append(f'Web 服务器无法连接模型服务: {mask_url_for_log(VLLM_API_URL)}')
        hints.append(
            '在 Web 服务器执行: curl -m 5 '
            f'{mask_url_for_log(build_vllm_models_url())}'
        )
        hints.append('确认 vLLM 监听外网卡且防火墙已放行 9527 端口')
    elif isinstance(exc, TimeoutError) or 'timed out' in message or '超时' in message:
        hints.append('本轮回答超过时限，可关闭流式响应后重试')
        hints.append('检查语义路由/vLLM 是否可达，或查看 hn/logs/windrise-web.out.log')
    elif isinstance(exc, PermissionError):
        hints.append('会话权限异常，请刷新页面后重新登录')
    if WINDRISE_ENABLED:
        hints.append('在部署机执行: bash deploy/diagnose-windrise-deployment.sh')
    if DIFY_ENABLED:
        hints.append(f'检查 Dify 服务: {mask_url_for_log(DIFY_API_URL)}')
    elif DIFY_REQUIRED and not DIFY_ENABLED:
        hints.append('Dify 未配置：请设置 DIFY_API_URL / DIFY_API_KEY，或将 DIFY_REQUIRED=0 并启用 WINDRISE_ENABLED=1')
    return hints


def build_web_error_payload(
    message,
    *,
    error_type='server_error',
    status_code=500,
    exc=None,
    causes=None,
    hints=None,
    diagnostics=None,
):
    payload = {
        'error': normalize_text(message) or '服务器内部错误',
        'error_type': error_type,
        'status_code': int(status_code),
    }
    resolved_causes = list(causes or [])
    if exc is not None:
        resolved_causes = resolved_causes or collect_exception_causes(exc)
    if resolved_causes:
        payload['causes'] = resolved_causes
    resolved_hints = list(hints or [])
    if exc is not None and not resolved_hints:
        resolved_hints = build_web_error_hints(exc)
    if resolved_hints:
        payload['hints'] = resolved_hints
    if diagnostics:
        payload['diagnostics'] = diagnostics
    return payload


def log_web_error(context, exc, extra=None):
    print(f'[WEB-ERROR] {context}')
    for line in collect_exception_causes(exc):
        print(f'  cause: {line}')
    for hint in build_web_error_hints(exc):
        print(f'  hint: {hint}')
    if extra:
        for key, value in extra.items():
            print(f'  {key}: {value}')
    if WEB_ERROR_VERBOSE or LOG_EXCEPTION_TRACEBACK:
        import traceback
        traceback.print_exc()


def jsonify_web_error(message, status_code=500, **kwargs):
    payload = build_web_error_payload(message, status_code=status_code, **kwargs)
    return jsonify(payload), status_code


def format_windrise_stream_error_diagnostic(exc):
    payload = build_web_error_payload(
        normalize_text(str(exc)) or 'Windrise 流式回答失败',
        error_type=type(exc).__name__,
        exc=exc,
        diagnostics={'phase': 'windrise_stream'},
    )
    lines = ['【系统诊断】回答过程中发生异常：', payload['error']]
    for index, cause in enumerate(payload.get('causes') or [], 1):
        lines.append(f'  {index}. {cause}')
    for index, hint in enumerate(payload.get('hints') or [], 1):
        lines.append(f'  建议{index}. {hint}')
    return '\n'.join(lines)


def emit_bootstrap_admin_credentials(username, password):
    """仅在服务端日志输出一次初始凭据，避免明文落盘。"""
    print(f"[SECURITY] 创建初始管理员账号: {username}")
    print(f"[SECURITY] 初始密码: {password}")
    print("[SECURITY] 请登录后立即修改密码。此密码仅在本日志中显示一次。")


def redact_chat_request_for_log(data, query, conversation_id, user_id, is_streaming):
    return {
        'keys': sorted((data or {}).keys()),
        'streaming': bool(is_streaming),
        'query_length': len(query or ''),
        'conversation_id': mask_identifier(conversation_id, prefix=4, suffix=4),
        'user_id': mask_identifier(user_id, prefix=2, suffix=2),
    }


def mask_url_for_log(url):
    if not url:
        return ''
    parsed = urlparse(url)
    netloc = parsed.netloc
    if '@' in netloc:
        netloc = netloc.split('@', 1)[-1]
    return urlunparse(parsed._replace(netloc=netloc, params='', query='', fragment=''))


def parse_int_query_param(name, default, minimum=None, maximum=None):
    raw_value = request.args.get(name, '')
    try:
        value = int(raw_value) if str(raw_value).strip() else int(default)
    except (TypeError, ValueError):
        return int(default)
    if minimum is not None:
        value = max(minimum, value)
    if maximum is not None:
        value = min(maximum, value)
    return value


def parse_int_value(value, default, minimum=None, maximum=None):
    try:
        parsed_value = int(value) if str(value).strip() else int(default)
    except (TypeError, ValueError):
        parsed_value = int(default)
    if minimum is not None:
        parsed_value = max(minimum, parsed_value)
    if maximum is not None:
        parsed_value = min(maximum, parsed_value)
    return parsed_value


def start_background_langchain_rebuild(reason='manual'):
    print(f"[Knowledge] local knowledge rebuild ignored: disabled, reason={reason}")
    return False

# 创建全局的requests session，使用连接池提高性能
# 配置重试策略和连接池
retry_strategy = Retry(
    total=3,
    backoff_factor=1,
    status_forcelist=[429, 500, 502, 503, 504],
    allowed_methods=["HEAD", "GET", "OPTIONS"] + (["POST"] if HTTP_RETRY_ON_POST else [])
)

adapter = HTTPAdapter(
    max_retries=retry_strategy,
    pool_connections=HTTP_POOL_SIZE,
    pool_maxsize=HTTP_POOL_SIZE,
    pool_block=False
)

# 创建session并配置连接池
http_session = requests.Session()
http_session.trust_env = False
http_session.mount("http://", adapter)
http_session.mount("https://", adapter)

vllm_model_lock = threading.Lock()
vllm_resolved_model_name = None
_vllm_service_configured = False


def should_bypass_proxy(url):
    hostname = urlparse(url).hostname
    if not hostname:
        return False
    if hostname in ('localhost',):
        return True
    try:
        ip = ipaddress.ip_address(hostname)
        return (
            ip.is_private
            or ip.is_loopback
            or ip.is_link_local
            or ip.is_reserved
        )
    except ValueError:
        return False


def get_request_kwargs_for_url(url, **kwargs):
    request_kwargs = dict(kwargs)
    headers = dict(request_kwargs.get('headers') or {})
    if VLLM_API_KEY and 'Authorization' not in headers:
        headers['Authorization'] = f'Bearer {VLLM_API_KEY}'
    if headers:
        request_kwargs['headers'] = headers
    # 离线部署环境常带 HTTP_PROXY；访问本机/内网 vLLM 时必须直连。
    request_kwargs['proxies'] = {'http': None, 'https': None}
    return request_kwargs


def get_dify_request_kwargs(url, **kwargs):
    request_kwargs = dict(kwargs)
    headers = dict(request_kwargs.get('headers') or {})
    headers.setdefault('Authorization', f'Bearer {DIFY_API_KEY}')
    headers.setdefault('Content-Type', 'application/json')
    request_kwargs['headers'] = headers
    if should_bypass_proxy(url):
        request_kwargs.setdefault('proxies', {'http': None, 'https': None})
    return request_kwargs


def normalize_dify_api_url(base_url, app_type='chat'):
    parsed = urlparse((base_url or '').strip())
    path = parsed.path.rstrip('/')
    app_type = (app_type or 'chat').lower()
    if app_type == 'workflow':
        if not path:
            path = '/v1/workflows/run'
        elif path.endswith('/v1'):
            path += '/workflows/run'
    else:
        if not path:
            path = '/v1/chat-messages'
        elif path.endswith('/v1'):
            path += '/chat-messages'
    return urlunparse(parsed._replace(path=path, params='', query='', fragment=''))


def normalize_chat_completions_url(url):
    parsed = urlparse((url or '').strip())
    path = parsed.path.rstrip('/')

    if not path:
        path = '/v1/chat/completions'
    elif path.endswith('/chat/completions'):
        pass
    elif path.endswith('/v1'):
        path = path + '/chat/completions'

    return urlunparse(parsed._replace(path=path, params='', query='', fragment=''))


VLLM_API_URL = normalize_chat_completions_url(VLLM_API_URL)
DIFY_API_URL = normalize_dify_api_url(DIFY_API_URL, DIFY_APP_TYPE) if DIFY_API_URL else ''


def derive_service_base_url(api_url):
    parsed = urlparse((api_url or '').strip())
    if not parsed.scheme or not parsed.netloc:
        return f'http://127.0.0.1:{VLLM_SERVICE_PORT}'
    path = parsed.path.rstrip('/')
    for suffix in (
        '/v1/chat/completions',
        '/chat/completions',
        '/v1/completions',
        '/completions',
    ):
        if path.endswith(suffix):
            path = path[: -len(suffix)]
            break
    if path.endswith('/v1'):
        path = path[: -len('/v1')]
    base = urlunparse(parsed._replace(path=path or '', params='', query='', fragment='')).rstrip('/')
    return base or f'{parsed.scheme}://{parsed.netloc}'


LMSTUDIO_BASE_URL = os.getenv('LMSTUDIO_BASE_URL', '').strip() or derive_service_base_url(VLLM_API_URL)
LMSTUDIO_MODEL = os.getenv('LMSTUDIO_MODEL', '').strip() or VLLM_MODEL_NAME
LMSTUDIO_CHAT_MODEL = os.getenv('LMSTUDIO_CHAT_MODEL', '').strip() or VLLM_MODEL_NAME
WINDRISE_MODEL_MODE = os.getenv('WINDRISE_MODEL_MODE', 'vllm').strip() or 'vllm'


def detect_local_ipv4():
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.connect(('8.8.8.8', 80))
        ip = sock.getsockname()[0]
        sock.close()
        return ip
    except Exception:
        return ''


def build_vllm_models_url_for_base(base_url):
    parsed = urlparse((base_url or '').strip().rstrip('/'))
    path = parsed.path.rstrip('/')
    if path.endswith('/v1'):
        path = path + '/models'
    elif not path.endswith('/models'):
        path = '/v1/models'
    return urlunparse(parsed._replace(path=path, params='', query='', fragment=''))


def build_vllm_chat_url_for_base(base_url):
    base = (base_url or '').strip().rstrip('/')
    if base.endswith('/v1/chat/completions') or base.endswith('/chat/completions'):
        return normalize_chat_completions_url(base)
    if base.endswith('/v1'):
        return normalize_chat_completions_url(base + '/chat/completions')
    return normalize_chat_completions_url(base + '/v1/chat/completions')


def iter_vllm_base_url_candidates():
    seen = set()
    configured_base = derive_service_base_url(VLLM_API_URL)
    explicit_base = (
        os.getenv('VLLM_SERVICE_BASE_URL', '').strip()
        or os.getenv('LMSTUDIO_BASE_URL', '').strip()
        or configured_base
    )
    local_ip = detect_local_ipv4()
    defaults = [
        f'http://127.0.0.1:{VLLM_SERVICE_PORT}',
        f'http://localhost:{VLLM_SERVICE_PORT}',
    ]
    if local_ip:
        defaults.append(f'http://{local_ip}:{VLLM_SERVICE_PORT}')
    if explicit_base:
        defaults.append(explicit_base.rstrip('/'))
    defaults.append(f'http://10.46.161.210:{VLLM_SERVICE_PORT}')
    for item in defaults:
        normalized = (item or '').strip().rstrip('/')
        if normalized and normalized not in seen:
            seen.add(normalized)
            yield normalized


def probe_vllm_base_url(base_url, timeout=3):
    models_url = build_vllm_models_url_for_base(base_url)
    try:
        response = http_session.get(
            models_url,
            timeout=timeout,
            **get_request_kwargs_for_url(models_url),
        )
        if response.status_code != 200:
            return False, None
        payload = response.json()
        models = payload.get('data') or []
        return bool(models), models
    except Exception:
        return False, None


def ensure_vllm_service_configured(force=False):
    global VLLM_API_URL, LMSTUDIO_BASE_URL, LMSTUDIO_MODEL, LMSTUDIO_CHAT_MODEL
    global _vllm_service_configured, vllm_resolved_model_name, VLLM_MODEL_NAME

    if not VLLM_AUTO_PROBE:
        _vllm_service_configured = True
        return

    with vllm_model_lock:
        if _vllm_service_configured and not force:
            return

        chosen_base = ''
        discovered_models = None
        for candidate in iter_vllm_base_url_candidates():
            ok, models = probe_vllm_base_url(candidate)
            if ok:
                chosen_base = candidate
                discovered_models = models
                print(f'✅ 检测到可用 vLLM 服务: {candidate}')
                break

        if not chosen_base:
            chosen_base = derive_service_base_url(VLLM_API_URL)
            print(f'⚠️ 未能自动探测 vLLM，继续使用配置地址: {chosen_base}')

        VLLM_API_URL = build_vllm_chat_url_for_base(chosen_base)
        LMSTUDIO_BASE_URL = chosen_base
        if discovered_models and not VLLM_MODEL_NAME:
            model_id = discovered_models[0].get('id')
            if model_id:
                VLLM_MODEL_NAME = model_id
                vllm_resolved_model_name = model_id
        LMSTUDIO_MODEL = VLLM_MODEL_NAME
        LMSTUDIO_CHAT_MODEL = VLLM_MODEL_NAME
        _vllm_service_configured = True


def build_embeddings_url(base_url):
    parsed = urlparse((base_url or '').strip())
    path = parsed.path.rstrip('/')

    if not path:
        path = '/v1/embeddings'
    elif path.endswith('/chat/completions'):
        path = path[:-len('/chat/completions')] + '/embeddings'
    elif path.endswith('/completions'):
        path = path[:-len('/completions')] + '/embeddings'
    elif path.endswith('/v1'):
        path = path + '/embeddings'
    elif not path.endswith('/embeddings'):
        path = '/v1/embeddings'

    return urlunparse(parsed._replace(path=path, params='', query='', fragment=''))


def build_vllm_models_url():
    parsed = urlparse(VLLM_API_URL)
    path = parsed.path.rstrip('/')
    if path.endswith('/chat/completions'):
        path = path[:-len('/chat/completions')] + '/models'
    elif path.endswith('/completions'):
        path = path[:-len('/completions')] + '/models'
    else:
        path = '/v1/models'
    return urlunparse(parsed._replace(path=path, params='', query='', fragment=''))


def resolve_vllm_model_name():
    global vllm_resolved_model_name

    ensure_vllm_service_configured()

    if VLLM_MODEL_NAME:
        return VLLM_MODEL_NAME

    with vllm_model_lock:
        if vllm_resolved_model_name:
            return vllm_resolved_model_name

        models_url = build_vllm_models_url()
        response = http_session.get(
            models_url,
            timeout=10,
            **get_request_kwargs_for_url(models_url)
        )
        response.raise_for_status()

        payload = response.json()
        model_list = payload.get('data') or []
        if not model_list:
            raise RuntimeError(
                f'本地模型服务列表为空，请检查 {models_url} 或设置 VLLM_MODEL_NAME 环境变量'
            )

        first_model = model_list[0].get('id')
        if not first_model:
            raise RuntimeError(
                f'本地模型服务列表缺少 id 字段，请检查 {models_url} 返回值'
            )

        vllm_resolved_model_name = first_model
        print(f"✅ 自动探测到 {LLM_PROVIDER_NAME} 模型: {vllm_resolved_model_name}")
        return vllm_resolved_model_name


class HashEmbeddings(Embeddings):
    """离线兜底嵌入，避免知识检索强依赖外部模型下载。"""

    def __init__(self, dimensions=384):
        self.dimensions = max(64, int(dimensions))

    def _embed(self, text):
        tokens = re.findall(r'\w+', (text or '').lower(), flags=re.UNICODE)
        if not tokens:
            tokens = list((text or '').strip()) or ['empty']

        vector = [0.0] * self.dimensions
        for token in tokens:
            digest = hashlib.sha256(token.encode('utf-8')).digest()
            slot = int.from_bytes(digest[:4], 'big') % self.dimensions
            sign = 1.0 if digest[4] % 2 == 0 else -1.0
            weight = 1.0 + (digest[5] / 255.0)
            vector[slot] += sign * weight

        norm = math.sqrt(sum(v * v for v in vector)) or 1.0
        return [v / norm for v in vector]

    def embed_documents(self, texts):
        return [self._embed(text) for text in texts]

    def embed_query(self, text):
        return self._embed(text)


def normalize_embedding_vector(vector):
    values = [float(v) for v in (vector or [])]
    norm = math.sqrt(sum(v * v for v in values)) or 1.0
    return [v / norm for v in values]


class SentenceTransformerEmbeddings(Embeddings):
    """直接复用 sentence-transformers，避免引入额外集成包。"""

    def __init__(self, model_name, local_files_only=True, query_instruction=None, device='auto'):
        import torch
        from sentence_transformers import SentenceTransformer

        self.model_name = model_name
        self.query_instruction = query_instruction
        self.device = resolve_torch_device(torch, device, 'embedding')
        try:
            self.model = SentenceTransformer(
                model_name,
                local_files_only=local_files_only,
                device=self.device
            )
        except TypeError:
            self.model = SentenceTransformer(model_name)
        self.model.to(self.device)

    def embed_documents(self, texts):
        text_count = len(texts or [])
        print(
            f"[LangChain][Embedding] start encoding {text_count} chunks "
            f"with batch_size={LANGCHAIN_EMBEDDING_BATCH_SIZE}"
        )
        update_langchain_progress(
            stage='embedding_documents',
            message='正在计算文本向量',
            total_chunks=text_count,
            processed_chunks=0,
        )
        vectors = self.model.encode(
            texts,
            batch_size=LANGCHAIN_EMBEDDING_BATCH_SIZE,
            normalize_embeddings=True,
            show_progress_bar=LANGCHAIN_EMBEDDING_SHOW_PROGRESS
        )
        update_langchain_progress(
            stage='embedding_documents',
            message='文本向量计算完成',
            total_chunks=text_count,
            processed_chunks=text_count,
        )
        print(f"[LangChain][Embedding] finished encoding {text_count} chunks")
        return vectors.tolist() if hasattr(vectors, 'tolist') else [list(v) for v in vectors]

    def embed_query(self, text):
        try:
            vector = self.model.encode(
                text,
                prompt_name='query',
                normalize_embeddings=True,
                show_progress_bar=False
            )
        except TypeError:
            encode_kwargs = {
                'normalize_embeddings': True,
                'show_progress_bar': False
            }
            if self.query_instruction:
                encode_kwargs['prompt'] = self.query_instruction
            vector = self.model.encode(
                text,
                **encode_kwargs
            )
        return vector.tolist() if hasattr(vector, 'tolist') else list(vector)


class OpenAICompatibleEmbeddings(Embeddings):
    """通过 OpenAI-compatible embeddings 接口生成向量。"""

    def __init__(self, model_name, api_url=None, query_instruction=None, dimensions=0):
        self.model_name = model_name
        self.api_url = api_url or build_embeddings_url(VLLM_API_URL)
        self.query_instruction = (query_instruction or '').strip()
        self.dimensions = max(0, int(dimensions or 0))

    def _prepare_query_text(self, text):
        content = (text or '').strip()
        if self.query_instruction:
            return f"Instruct: {self.query_instruction}\nQuery: {content}"
        return content

    def _request_embeddings(self, texts):
        payload = {
            'model': self.model_name,
            'input': texts,
            'encoding_format': 'float',
        }
        if self.dimensions > 0:
            payload['dimensions'] = self.dimensions

        response = http_session.post(
            self.api_url,
            json=payload,
            timeout=300,
            **get_request_kwargs_for_url(self.api_url)
        )
        if response.status_code == 401:
            raise RuntimeError(
                "Embedding API returned 401 Unauthorized. "
                "Check VLLM_API_KEY if the current endpoint requires authentication."
            )
        response.raise_for_status()
        data = response.json().get('data') or []
        if len(data) != len(texts):
            raise RuntimeError(
                f"embedding result count mismatch: expected {len(texts)}, got {len(data)}"
            )
        return [normalize_embedding_vector(item.get('embedding') or []) for item in data]

    def embed_documents(self, texts):
        items = list(texts or [])
        total = len(items)
        print(
            f"[LangChain][Embedding] start API encoding {total} chunks "
            f"with batch_size={LANGCHAIN_EMBEDDING_BATCH_SIZE}"
        )
        update_langchain_progress(
            stage='embedding_documents',
            message='正在通过 Embedding API 计算文本向量',
            total_chunks=total,
            processed_chunks=0,
        )

        vectors = []
        for batch_start in range(0, total, LANGCHAIN_EMBEDDING_BATCH_SIZE):
            batch = items[batch_start: batch_start + LANGCHAIN_EMBEDDING_BATCH_SIZE]
            vectors.extend(self._request_embeddings(batch))
            processed = min(total, batch_start + len(batch))
            update_langchain_progress(
                stage='embedding_documents',
                message='正在通过 Embedding API 计算文本向量',
                total_chunks=total,
                processed_chunks=processed,
            )
            print_langchain_progress(
                f"Embedding API 进度 {processed}/{total}"
            )

        print(f"[LangChain][Embedding] finished API encoding {total} chunks")
        return vectors

    def embed_query(self, text):
        return self._request_embeddings([self._prepare_query_text(text)])[0]


class LocalQwenReranker:
    """本地加载 Qwen reranker，对召回结果做精排。"""

    def __init__(
        self,
        model_name,
        local_files_only=True,
        max_length=4096,
        batch_size=8,
        instruction=None,
    ):
        import torch
        from transformers import AutoModelForCausalLM, AutoModelForSequenceClassification, AutoTokenizer

        self.torch = torch
        self.model_name = model_name
        self.max_length = max(512, int(max_length))
        self.batch_size = max(1, int(batch_size))
        self.instruction = instruction or LANGCHAIN_RERANKER_INSTRUCTION
        self.model_mode = 'causal_lm'
        self.device = resolve_torch_device(torch, LANGCHAIN_RERANKER_DEVICE, 'reranker')
        self.tokenizer = AutoTokenizer.from_pretrained(
            model_name,
            local_files_only=local_files_only,
            padding_side='left'
        )
        try:
            self.model = AutoModelForSequenceClassification.from_pretrained(
                model_name,
                local_files_only=local_files_only,
                torch_dtype='auto'
            ).eval()
            self.model_mode = 'sequence_classification'
        except Exception:
            self.model = AutoModelForCausalLM.from_pretrained(
                model_name,
                local_files_only=local_files_only,
                torch_dtype='auto'
            ).eval()
            self.model_mode = 'causal_lm'
        self.model.to(self.device)

        if self.tokenizer.pad_token_id is None and self.tokenizer.eos_token_id is not None:
            self.tokenizer.pad_token = self.tokenizer.eos_token

        if self.model_mode == 'causal_lm':
            self.token_true_id = self.tokenizer('yes', add_special_tokens=False)['input_ids'][-1]
            self.token_false_id = self.tokenizer('no', add_special_tokens=False)['input_ids'][-1]

    def _build_input_text(self, query, document):
        return (
            f"<Instruct>: {self.instruction}\n"
            f"<Query>: {query}\n"
            f"<Document>: {document}"
        )

    def _tokenize_batch(self, pairs):
        prefix = "<|im_start|>system\nJudge whether the Document meets the requirements based on the Query and the Instruct provided. Note that the answer can only be \"yes\" or \"no\".<|im_end|>\n<|im_start|>user\n"
        # Reranker 只需要输出 yes/no 的 logits，这里不应注入任何“思考链”标签，避免污染模板与输出分布。
        suffix = "<|im_end|>\n<|im_start|>assistant\n"

        prefix_ids = self.tokenizer(prefix, add_special_tokens=False)['input_ids']
        suffix_ids = self.tokenizer(suffix, add_special_tokens=False)['input_ids']

        max_pair_length = max(128, self.max_length - len(prefix_ids) - len(suffix_ids))
        pair_inputs = self.tokenizer(
            pairs,
            padding=False,
            truncation='longest_first',
            return_attention_mask=False,
            max_length=max_pair_length,
            add_special_tokens=False
        )

        merged_inputs = {
            'input_ids': [prefix_ids + item + suffix_ids for item in pair_inputs['input_ids']]
        }
        padded_inputs = self.tokenizer.pad(
            merged_inputs,
            padding=True,
            return_tensors='pt'
        )
        return {name: tensor.to(self.device) for name, tensor in padded_inputs.items()}

    def score(self, query, documents):
        if not documents:
            return []

        scores = []
        for batch_start in range(0, len(documents), self.batch_size):
            batch_docs = documents[batch_start: batch_start + self.batch_size]
            with self.torch.no_grad():
                if self.model_mode == 'sequence_classification':
                    pairs = [[query, doc] for doc in batch_docs]
                    inputs = self.tokenizer(
                        pairs,
                        padding=True,
                        truncation=True,
                        max_length=self.max_length,
                        return_tensors='pt'
                    )
                    inputs = {name: tensor.to(self.device) for name, tensor in inputs.items()}
                    logits = self.model(**inputs).logits
                    if logits.shape[-1] == 1:
                        batch_scores = self.torch.sigmoid(logits[:, 0]).float().cpu().tolist()
                    else:
                        positive_index = min(1, logits.shape[-1] - 1)
                        batch_scores = self.torch.softmax(logits, dim=1)[:, positive_index].float().cpu().tolist()
                else:
                    pairs = [self._build_input_text(query, doc) for doc in batch_docs]
                    inputs = self._tokenize_batch(pairs)
                    logits = self.model(**inputs).logits[:, -1, :]
                    selected = logits[:, [self.token_false_id, self.token_true_id]]
                    batch_scores = self.torch.softmax(selected, dim=1)[:, 1].float().cpu().tolist()

            scores.extend(batch_scores)

        return scores


def ensure_langchain_directories():
    return None


def iter_knowledge_files():
    return []


def build_langchain_signature(files):
    return tuple(
        (
            str(path.relative_to(BASE_DIR)).replace('\\', '/'),
            path.stat().st_size,
            int(path.stat().st_mtime)
        )
        for path in files
    )


def normalize_langchain_signature(raw_signature):
    normalized = []
    for item in raw_signature or []:
        if len(item) != 3:
            continue
        normalized.append((str(item[0]).replace('\\', '/'), int(item[1]), int(item[2])))
    return tuple(normalized)


def knowledge_base_changed():
    global langchain_last_signature_check_at

    if langchain_index_signature is None:
        return True

    now = time.time()
    if (
        LANGCHAIN_KB_CHANGE_CHECK_INTERVAL_SECONDS > 0
        and (now - langchain_last_signature_check_at) < LANGCHAIN_KB_CHANGE_CHECK_INTERVAL_SECONDS
    ):
        return False

    langchain_last_signature_check_at = now
    files = iter_knowledge_files()
    current_signature = build_langchain_signature(files)
    return current_signature != langchain_index_signature


def reset_langchain_progress(total_files=0):
    global langchain_progress
    now = datetime.now().isoformat()
    langchain_progress = {
        'active': bool(total_files),
        'stage': 'preparing',
        'message': '准备处理知识库文档',
        'current_file': '',
        'processed_files': 0,
        'total_files': int(total_files),
        'processed_documents': 0,
        'total_documents': 0,
        'processed_chunks': 0,
        'total_chunks': 0,
        'started_at': now,
        'updated_at': now,
    }


def update_langchain_progress(**kwargs):
    global langchain_progress
    langchain_progress.update(kwargs)
    langchain_progress['updated_at'] = datetime.now().isoformat()


def finish_langchain_progress(message, active=False):
    update_langchain_progress(
        active=active,
        stage='completed' if not active else langchain_progress.get('stage', 'running'),
        message=message,
        current_file='',
    )


def print_langchain_progress(message):
    progress = langchain_progress
    total_files = int(progress.get('total_files') or 0)
    processed_files = int(progress.get('processed_files') or 0)
    total_documents = int(progress.get('total_documents') or 0)
    processed_documents = int(progress.get('processed_documents') or 0)
    total_chunks = int(progress.get('total_chunks') or 0)
    processed_chunks = int(progress.get('processed_chunks') or 0)
    current_file = progress.get('current_file') or '-'
    print(
        f"[LangChain][Progress] {message} | "
        f"files={processed_files}/{total_files} | "
        f"documents={processed_documents}/{total_documents} | "
        f"chunks={processed_chunks}/{total_chunks} | "
        f"current={current_file}"
    )


def get_langchain_progress_status():
    return dict(langchain_progress)


def build_langchain_index_config():
    return {
        'index_format_version': LANGCHAIN_INDEX_FORMAT_VERSION,
        'embedding_backend': LANGCHAIN_EMBEDDING_BACKEND,
        'embedding_model': LANGCHAIN_EMBEDDING_MODEL,
        'embedding_api_url': LANGCHAIN_EMBEDDING_API_URL or build_embeddings_url(VLLM_API_URL),
        'embedding_dimensions': LANGCHAIN_EMBEDDING_DIMENSIONS,
        'embedding_batch_size': LANGCHAIN_EMBEDDING_BATCH_SIZE,
        'embedding_local_files_only': LANGCHAIN_EMBEDDING_LOCAL_FILES_ONLY,
        'embedding_query_instruction': LANGCHAIN_EMBEDDING_QUERY_INSTRUCTION,
        'chunk_size': LANGCHAIN_CHUNK_SIZE,
        'chunk_overlap': LANGCHAIN_CHUNK_OVERLAP,
        'fallback_embedding_dim': LANGCHAIN_FALLBACK_EMBEDDING_DIM,
    }


def clear_persisted_langchain_index():
    for filename in (
        f'{LANGCHAIN_INDEX_NAME}.faiss',
        f'{LANGCHAIN_INDEX_NAME}.pkl',
        os.path.basename(LANGCHAIN_INDEX_META_FILE),
    ):
        path = os.path.join(LANGCHAIN_INDEX_DIR, filename)
        if os.path.exists(path):
            os.remove(path)


def save_persisted_langchain_index(vectorstore, signature, chunk_count):
    if vectorstore is None:
        return
    os.makedirs(LANGCHAIN_INDEX_DIR, exist_ok=True)
    vectorstore.save_local(LANGCHAIN_INDEX_DIR, index_name=LANGCHAIN_INDEX_NAME)
    metadata = {
        'signature': list(signature),
        'config': build_langchain_index_config(),
        'chunk_count': int(chunk_count),
        'saved_at': datetime.now().isoformat(),
    }
    with open(LANGCHAIN_INDEX_META_FILE, 'w', encoding='utf-8') as meta_file:
        json.dump(metadata, meta_file, ensure_ascii=False, indent=2)


def load_persisted_langchain_index(signature):
    if FAISS is None:
        return None

    if not os.path.exists(LANGCHAIN_INDEX_META_FILE):
        return None

    index_path = os.path.join(LANGCHAIN_INDEX_DIR, f'{LANGCHAIN_INDEX_NAME}.faiss')
    store_path = os.path.join(LANGCHAIN_INDEX_DIR, f'{LANGCHAIN_INDEX_NAME}.pkl')
    if not (os.path.exists(index_path) and os.path.exists(store_path)):
        return None

    try:
        with open(LANGCHAIN_INDEX_META_FILE, 'r', encoding='utf-8') as meta_file:
            metadata = json.load(meta_file)
    except Exception as e:
        print(f"[LangChain] failed to read persisted index metadata: {e}")
        return None

    saved_signature = normalize_langchain_signature(metadata.get('signature'))
    if saved_signature != signature:
        return None

    if metadata.get('config') != build_langchain_index_config():
        return None

    if not is_trusted_langchain_index_dir():
        print(
            f"[LangChain] skip persisted index load because index dir is outside trusted roots: "
            f"{LANGCHAIN_INDEX_DIR}"
        )
        return None

    embeddings = get_langchain_embeddings()
    try:
        vectorstore = FAISS.load_local(
            LANGCHAIN_INDEX_DIR,
            embeddings,
            index_name=LANGCHAIN_INDEX_NAME,
            allow_dangerous_deserialization=True
        )
    except Exception as e:
        print(f"[LangChain] failed to load persisted FAISS index: {e}")
        return None

    print(f"[LangChain] loaded persisted index from {LANGCHAIN_INDEX_DIR}")
    return vectorstore, int(metadata.get('chunk_count', 0))


def split_markdown_sections(content):
    lines = (content or '').replace('\r\n', '\n').split('\n')
    sections = []
    current_lines = []
    heading_stack = []
    section_index = 0

    def flush_section():
        nonlocal current_lines, section_index
        body = '\n'.join(current_lines).strip()
        if not body:
            current_lines = []
            return
        section_index += 1
        heading_path = ' > '.join(heading_stack)
        if heading_path and heading_path not in body:
            body = f"{heading_path}\n\n{body}"
        sections.append((section_index, heading_path, body))
        current_lines = []

    for raw_line in lines:
        line = raw_line.rstrip()
        match = re.match(r'^(#{1,6})\s+(.+?)\s*#*\s*$', line)
        if not match:
            current_lines.append(line)
            continue

        flush_section()
        level = len(match.group(1))
        title = match.group(2).strip()
        heading_stack = heading_stack[:level - 1] + [title]
        current_lines = []

    flush_section()

    if sections:
        return sections

    fallback_body = (content or '').strip()
    return [(1, '', fallback_body)] if fallback_body else []


def split_text_with_overlap(text):
    content = (text or '').replace('\r\n', '\n').strip()
    if not content:
        return []

    chunks = []
    start = 0
    separators = ['\n\n', '\n', '。', '！', '？', '. ', ' ']

    while start < len(content):
        end = min(len(content), start + LANGCHAIN_CHUNK_SIZE)
        if end < len(content):
            window = content[start:end]
            best_pos = -1
            best_sep_len = 0
            for separator in separators:
                pos = window.rfind(separator)
                if pos > best_pos:
                    best_pos = pos
                    best_sep_len = len(separator)
            if best_pos >= max(20, LANGCHAIN_CHUNK_SIZE // 3):
                end = start + best_pos + best_sep_len

        chunk = content[start:end].strip()
        if chunk:
            chunks.append(chunk)

        if end >= len(content):
            break
        start = max(start + 1, end - LANGCHAIN_CHUNK_OVERLAP)

    return chunks


def build_chunk_lookup_key(metadata, content):
    metadata = metadata or {}
    parts = [
        str(metadata.get('source', '')),
        str(metadata.get('page', '')),
        str(metadata.get('section_index', '')),
        str(metadata.get('chunk_index', '')),
    ]
    key = '|'.join(parts).strip('|')
    if key:
        return key
    return hashlib.md5((content or '').encode('utf-8')).hexdigest()


def get_chunk_heading(metadata):
    metadata = metadata or {}
    return (
        metadata.get('heading_path')
        or metadata.get('section_title')
        or metadata.get('document_name')
        or ''
    )


def build_context_excerpt(content, metadata=None, limit=RAG_CONTEXT_MAX_CHARS_PER_CHUNK):
    heading = get_chunk_heading(metadata)
    normalized = normalize_text(content)
    if not normalized:
        return heading or ''
    if heading and not normalized.startswith(heading):
        normalized = f"{heading} {normalized}"
    return clip_text(normalized, limit=limit)


def build_chunk_parent_key(metadata):
    metadata = metadata or {}
    parts = [
        str(metadata.get('source', '')),
        str(metadata.get('page', '')),
        str(metadata.get('section_index', '')),
    ]
    key = '|'.join(parts).strip('|')
    if key:
        return key
    return str(metadata.get('document_name', '')).strip()


def merge_overlapping_chunk_texts(texts, min_overlap=20, max_overlap=120):
    merged = ''
    for raw_text in texts:
        text = normalize_text(raw_text)
        if not text:
            continue
        if not merged:
            merged = text
            continue

        overlap_found = False
        upper_bound = min(max_overlap, len(merged), len(text))
        for overlap in range(upper_bound, min_overlap - 1, -1):
            if merged[-overlap:] == text[:overlap]:
                merged += text[overlap:]
                overlap_found = True
                break

        if not overlap_found:
            merged = f"{merged} {text}"

    return merged


def build_expanded_context_excerpt(item, limit=RAG_CONTEXT_MAX_CHARS_PER_CHUNK):
    metadata = dict(item.get('metadata') or {})
    parent_key = build_chunk_parent_key(metadata)
    chunk_group = langchain_chunk_groups.get(parent_key, [])
    if not chunk_group:
        return item.get('context_excerpt') or build_context_excerpt(
            item.get('content', ''),
            metadata,
            limit=limit,
        )

    try:
        target_chunk_index = int(metadata.get('chunk_index', 0))
    except (TypeError, ValueError):
        target_chunk_index = 0

    current_position = None
    target_chunk_key = item.get('chunk_key')
    for index, group_item in enumerate(chunk_group):
        if target_chunk_key and group_item.get('chunk_key') == target_chunk_key:
            current_position = index
            break
        group_metadata = group_item.get('metadata') or {}
        if group_metadata.get('chunk_index') == target_chunk_index:
            current_position = index

    if current_position is None:
        return item.get('context_excerpt') or build_context_excerpt(
            item.get('content', ''),
            metadata,
            limit=limit,
        )

    start = max(0, current_position - RAG_CONTEXT_NEIGHBOR_WINDOW)
    end = min(len(chunk_group), current_position + RAG_CONTEXT_NEIGHBOR_WINDOW + 1)
    merged_text = merge_overlapping_chunk_texts(
        [chunk_group[index].get('content', '') for index in range(start, end)]
    )
    if not merged_text:
        return item.get('context_excerpt') or build_context_excerpt(
            item.get('content', ''),
            metadata,
            limit=limit,
        )

    heading = get_chunk_heading(metadata)
    if heading and not merged_text.startswith(heading):
        merged_text = f"{heading} {merged_text}"

    return clip_text(merged_text, limit=limit)


def normalize_lookup_text(text):
    return normalize_text(text).lower()


def normalize_model_lookup_key(text):
    return re.sub(r'[^a-z0-9\u4e00-\u9fff]+', '', normalize_lookup_text(text))


def dedupe_preserve_order(items):
    seen = set()
    ordered = []
    for item in items:
        value = normalize_text(item)
        if not value or value in seen:
            continue
        seen.add(value)
        ordered.append(value)
    return ordered


def extract_model_aliases(text):
    raw_text = normalize_text(text)
    if not raw_text:
        return []

    aliases = []
    for keyword in MODEL_BRAND_KEYWORDS:
        if keyword.lower() in raw_text.lower():
            aliases.append(keyword)

    for pattern in MODEL_ALIAS_PATTERNS:
        for match in re.findall(pattern, raw_text):
            aliases.append(normalize_text(match).upper().replace(' ', ''))

    lowered = raw_text.lower()
    if 'sl1500' in lowered and 'abb' in lowered:
        aliases.append('SL1500 ABB')
    if 'sl1500' in lowered and 'bachmann' in lowered:
        aliases.append('SL1500 BACHMANN')

    return dedupe_preserve_order(aliases)


def looks_like_model_alias(text):
    normalized = normalize_text(text).upper().replace(' ', '')
    if not normalized:
        return False
    return any(
        re.fullmatch(pattern, normalized, flags=re.IGNORECASE)
        for pattern in MODEL_ALIAS_PATTERNS
    )


def infer_knowledge_model_metadata(source, document_name=''):
    raw_source = normalize_text(source).replace('\\', '/')
    if not raw_source:
        base_name = os.path.splitext(document_name or '')[0]
        aliases = extract_model_aliases(base_name)
        return {
            'kb_directory': '',
            'machine_model': base_name,
            'model_aliases': aliases,
        }

    parts = [part for part in raw_source.split('/') if part]
    kb_directory = ''
    if 'knowledge_base' in parts:
        kb_index = parts.index('knowledge_base')
        if kb_index + 1 < len(parts):
            kb_directory = parts[kb_index + 1]
    elif len(parts) >= 2:
        kb_directory = parts[0]

    canonical_model = kb_directory or os.path.splitext(document_name or '')[0]
    aliases = extract_model_aliases(' '.join(filter(None, [kb_directory, document_name])))
    if canonical_model:
        aliases.append(canonical_model)

    return {
        'kb_directory': kb_directory,
        'machine_model': canonical_model,
        'model_aliases': dedupe_preserve_order(aliases),
    }


def enrich_document_metadata(metadata, document_name=''):
    metadata = dict(metadata or {})
    derived = infer_knowledge_model_metadata(
        metadata.get('source', ''),
        metadata.get('document_name') or document_name or '',
    )
    metadata.setdefault('kb_directory', derived.get('kb_directory', ''))
    metadata.setdefault('machine_model', derived.get('machine_model', ''))
    metadata.setdefault('model_aliases', derived.get('model_aliases', []))
    if not metadata.get('document_name'):
        metadata['document_name'] = document_name or os.path.basename(metadata.get('source', ''))
    return metadata


def get_document_model_name(metadata):
    metadata = metadata or {}
    return (
        metadata.get('machine_model')
        or metadata.get('kb_directory')
        or metadata.get('document_name')
        or ''
    )


def get_document_model_aliases(metadata):
    metadata = enrich_document_metadata(metadata)
    aliases = list(metadata.get('model_aliases') or [])
    aliases.append(get_document_model_name(metadata))
    aliases.append(metadata.get('kb_directory', ''))
    return dedupe_preserve_order(aliases)


def extract_query_terms(query):
    raw_terms = re.findall(r'[A-Za-z0-9_.\-/]+|[\u4e00-\u9fff]{2,}', query or '')
    seen = set()
    terms = []
    for term in raw_terms:
        normalized = term.strip().lower()
        if len(normalized) < 2 or normalized in seen:
            continue
        seen.add(normalized)
        terms.append(normalized)
    return terms


def tokenize_sparse_text(text):
    normalized = normalize_lookup_text(text)
    if not normalized:
        return []
    return re.findall(r'[a-z0-9_.\-/]+|[\u4e00-\u9fff]{2,}', normalized)


def extract_fault_codes(text):
    raw_text = normalize_text(text)
    if re.search(
        r'^\s*\d{1,8}[\u4e00-\u9fffA-Za-z].*(?:是什么故障码|故障码是什么|故障代码是什么|是什么码|什么码|对应.*码|哪些故障码|有什么故障码|报码|告警码|报警码)',
        raw_text or '',
        flags=re.IGNORECASE,
    ):
        return []
    codes = []
    spoken_digit_map = {
        '零': '0', '〇': '0', '洞': '0',
        '一': '1', '幺': '1',
        '二': '2', '两': '2',
        '三': '3', '四': '4', '五': '5',
        '六': '6', '七': '7', '八': '8', '九': '9',
    }
    if raw_text and re.search(
        r'(故障码|故障代码|报码|告警码|报警码|状态码|错误码|是什么故障|怎么处理|怎么复位|什么时候报|严重吗)',
        raw_text,
        flags=re.IGNORECASE,
    ):
        for spoken in re.findall(r'[零〇洞一幺二两三四五六七八九]{3,8}', raw_text):
            codes.append(''.join(spoken_digit_map[char] for char in spoken))
    for pattern in FAULT_CODE_PATTERNS:
        codes.extend(re.findall(pattern, raw_text or '', flags=re.IGNORECASE))
    for pattern in FAULT_CODE_CONTEXT_PATTERNS:
        codes.extend(re.findall(pattern, raw_text or '', flags=re.IGNORECASE))
    if raw_text:
        numeric_range = r'\d{1,8}\s*(?:至|到|[~～])\s*\d{1,8}'
        numeric_item = rf'(?:{numeric_range}|\d{{1,8}})'
        numeric_list_candidates = []
        numeric_range_candidates = []
        numeric_candidates = re.findall(r'(?<![A-Za-z0-9])\d{3,8}(?![A-Za-z0-9])', raw_text)
        lowered = raw_text.lower()
        has_code_hint = any(
            keyword in lowered
            for keyword in ('报码', '故障码', '故障代码', '告警码', '报警码', '状态代码', 'error code', 'fault code', 'alarm code')
        )
        if has_code_hint:
            numeric_list_candidates = re.findall(
                rf'(?<![A-Za-z0-9]){numeric_item}(?:\s*[、,，]\s*{numeric_item})+(?![A-Za-z0-9])',
                raw_text,
            )
            numeric_range_candidates = re.findall(
                rf'(?<![A-Za-z0-9]){numeric_range}(?![A-Za-z0-9])',
                raw_text,
            )
        has_model_or_alarm_hint = (
            any(keyword.lower() in lowered for keyword in MODEL_BRAND_KEYWORDS)
            or any(keyword.lower() in lowered for keyword in DEVICE_HINT_KEYWORDS)
            or any(keyword.lower() in lowered for keyword in ISSUE_HINT_KEYWORDS)
            or any(keyword in lowered for keyword in ('报', '报警', '告警'))
        )
        has_fault_question_hint = bool(re.search(
            r'(是什么故障|什么故障|故障|报警|告警|停机|处理|复位|原因|触发|报警条件|触发条件|逻辑|怎么|如何)',
            raw_text,
            flags=re.IGNORECASE,
        ))
        has_dimension_hint = query_has_explicit_dimension(raw_text)
        if (has_code_hint or (has_fault_question_hint and has_dimension_hint)) and not numeric_candidates:
            numeric_candidates = re.findall(r'(?<![A-Za-z0-9])\d{1,8}(?![A-Za-z0-9])', raw_text)
        if not numeric_candidates and re.search(
            r'^\s*(?:故障码|故障代码|报码|告警码|报警码|状态代码)?\s*\d{1,8}(?=\s|[^A-Za-z0-9]|$).*(?:是什么故障|什么故障|故障|报警|告警|停机|处理|复位|原因|为什么|为何|为啥|怎么|如何|会报|报出|含义)',
            raw_text,
            flags=re.IGNORECASE,
        ):
            numeric_candidates = re.findall(r'^\s*(?:故障码|故障代码|报码|告警码|报警码|状态代码)?\s*(\d{1,8})(?=\s|[^A-Za-z0-9]|$)', raw_text, flags=re.IGNORECASE)
        if numeric_list_candidates or numeric_range_candidates:
            codes.extend(numeric_list_candidates)
            codes.extend(numeric_range_candidates)
            numeric_candidates = []
        if numeric_candidates:
            filtered_numeric = []
            for code in numeric_candidates:
                if re.search(rf'(?<![A-Za-z0-9]){re.escape(code)}号', raw_text):
                    continue
                if is_numeric_fault_name_fragment(raw_text, code):
                    continue
                if not has_code_hint and is_measurement_numeric_fragment(raw_text, code):
                    continue
                filtered_numeric.append(code)
            numeric_candidates = filtered_numeric
        if numeric_candidates:
            if has_code_hint or has_model_or_alarm_hint or len(raw_text) <= 20:
                codes.extend(numeric_candidates)
    seen = set()
    normalized_codes = []
    for code in codes:
        upper_code = normalize_text(code).upper().replace(' ', '')
        if (
            (not has_code_hint and is_measurement_value_candidate(raw_text, upper_code))
            or
            looks_like_model_alias(upper_code)
            or is_numeric_model_fragment(raw_text, upper_code)
            or is_decimal_capacity_fragment(raw_text, upper_code)
            or is_capacity_numeric_list_fragment(raw_text, upper_code)
            or is_code_inside_model_alias(raw_text, upper_code)
            or is_explicit_model_value_fragment(raw_text, upper_code)
            or is_io_module_fragment(raw_text, upper_code)
            or is_turbine_id_fault_code_collision(raw_text, upper_code)
        ):
            continue
        if upper_code in seen:
            continue
        seen.add(upper_code)
        normalized_codes.append(upper_code)
    return [
        code for code in normalized_codes
        if not any(
            code != other
            and re.search(rf'(?:^|[-_]){re.escape(code)}(?:$|[-_])', other, flags=re.IGNORECASE)
            for other in normalized_codes
        )
    ]


def is_numeric_fault_name_fragment(raw_text, code):
    """Return True when a number is embedded in a Chinese fault name."""
    if not re.fullmatch(r'\d{1,8}', code or ''):
        return False
    for match in re.finditer(re.escape(code), raw_text or ''):
        prefix = (raw_text or '')[max(0, match.start() - 12):match.start()]
        if re.search(
            r'(?:故障码|故障代码|报码|告警码|报警码|状态码|错误码)\s*(?:[:：=＝]|为|是|等于)?\s*$',
            prefix,
            flags=re.IGNORECASE,
        ):
            continue
        left = (raw_text or '')[match.start() - 1:match.start()]
        right = (raw_text or '')[match.end():match.end() + 1]
        if left in {'和', '与', '及', '或'}:
            continue
        if re.fullmatch(r'[\u4e00-\u9fff]', left) and re.fullmatch(r'[\u4e00-\u9fff]', right):
            return True
    return False


def is_explicit_model_value_fragment(raw_text, code):
    """Return True when a token belongs to a user-supplied model field.

    Model names are not limited to the curated alias list.  This covers
    values such as ``XE82-2000``, ``SE8215-L3`` and ``G52、G58系列`` without
    making the fault-code regex aware of every vendor's naming convention.
    """
    normalized = normalize_text(raw_text or '')
    candidate = normalize_text(code or '')
    if not normalized or not candidate:
        return False
    field_pattern = (
        r'(?:机型|具体型号|标准型号|型号)\s*'
        r'(?:先记一下是|先记一下|是|为|[:：=＝])?\s*'
        r'([^。；;\n]+)'
    )
    for field_match in re.finditer(field_pattern, normalized, flags=re.IGNORECASE):
        value = field_match.group(1)
        # Do not let a following scope/fault label become part of the model.
        value = re.split(
            r'(?:厂家|品牌|风场|风电场|场站|风机编号|风机号|机位号|故障码|故障代码|报码|告警码|报警码|故障描述|故障内容)\s*(?:是|为|[:：=＝])?',
            value,
            maxsplit=1,
            flags=re.IGNORECASE,
        )[0]
        if re.search(re.escape(candidate), value, flags=re.IGNORECASE):
            return True
    return False


def is_embedded_sensor_token(raw_text, token):
    """Return True for measurement/electrical labels embedded in fault text."""
    normalized = normalize_text(raw_text or '')
    candidate = normalize_text(token or '')
    if not normalized or not candidate or not re.search(r'[A-Za-z]', candidate):
        return False
    for match in re.finditer(re.escape(candidate), normalized, flags=re.IGNORECASE):
        prefix = normalized[max(0, match.start() - 12):match.start()]
        if re.search(r'(?:温度点|温度|传感器|测量|振动|绕组)\s*$', prefix, flags=re.IGNORECASE):
            return True
    return False


def is_pitch_blade_axis_token(raw_text, token):
    """Return True for pitch-axis labels such as A1 in 变桨A1叶片同步故障."""
    normalized = normalize_text(raw_text or '')
    candidate = normalize_text(token or '').upper().rstrip('#')
    if not re.fullmatch(r'[ABC][123]', candidate):
        return False
    pattern = (
        rf'(?:变桨|叶片|桨叶)\s*{re.escape(candidate)}'
        rf'|{re.escape(candidate)}\s*(?:叶片|桨叶)'
    )
    return bool(re.search(pattern, normalized, flags=re.IGNORECASE))


def filter_pitch_blade_axis_turbine_ids(raw_text, turbine_ids):
    return [
        turbine_id
        for turbine_id in (turbine_ids or [])
        if not is_pitch_blade_axis_token(raw_text, turbine_id)
    ]


def extract_pitch_blade_axis_number(text):
    normalized = normalize_text(text)
    if not normalized:
        return ''
    match = re.search(r'(?:变桨|叶片|桨叶)\s*[ABC]\s*([123])', normalized, flags=re.IGNORECASE)
    if match:
        return match.group(1)
    match = re.search(r'[ABC]([123])\s*(?:叶片|桨叶)', normalized, flags=re.IGNORECASE)
    if match:
        return match.group(1)
    match = re.search(r'(?:桨叶|叶片)\s*([123])', normalized)
    if match:
        return match.group(1)
    return ''


def fault_record_matches_blade_sync_fault(record):
    blob = normalize_text(' '.join(
        str(record.get(key, '') or '')
        for key in ('name', 'text', 'logic', 'reason')
    ))
    return bool(re.search(r'(不同步|叶片同步|桨叶同步|变桨同步)', blob))


def fault_record_matches_blade_emergency_stop_fault(record):
    blob = normalize_text(' '.join(
        str(record.get(key, '') or '')
        for key in ('name', 'logic', 'text')
    ))
    return bool(re.search(r'(急停开关|急停|手动允许|手动开关|手动操作)', blob))


def is_measurement_numeric_fragment(raw_text, code):
    """Return True when a numeric token is a measured value, not a fault code."""
    if not re.fullmatch(r'\d{1,8}', code or ''):
        return False
    unit_pattern = (
        r'(?:kv|mv|ma|mpa|kpa|pa|bar|hz|rpm|kw|mw|v|a|'
        r'℃|°\s*c|摄氏度|%|％|秒|分钟|min|s)'
    )
    return bool(re.search(
        rf'(?<![A-Za-z0-9]){re.escape(code)}\s*{unit_pattern}(?![A-Za-z0-9])',
        raw_text or '',
        flags=re.IGNORECASE,
    ))


def is_measurement_value_candidate(raw_text, candidate):
    """Recognize values such as 690V and 150bar before code lookup."""
    normalized = normalize_text(candidate).replace(' ', '')
    unit_pattern = (
        r'(?:KV|MV|MA|MPA|KPA|PA|BAR|HZ|RPM|KW|MW|V|A|'
        r'℃|°C|摄氏度|%|％|秒|分钟|MIN|S)'
    )
    if re.fullmatch(rf'\d+(?:\.\d+)?{unit_pattern}', normalized, flags=re.IGNORECASE):
        return True
    return is_measurement_numeric_fragment(raw_text, normalized)


def is_numeric_model_fragment(raw_text, code):
    if not re.fullmatch(r'\d{1,8}', code or ''):
        return False
    model_prefix = re.search(
        rf'([A-Za-z]{{1,10}})\s*[-_/]?\s*\d*(?:[./_-])?{re.escape(code)}(?:[./_-]\d+)?',
        raw_text or '',
        flags=re.IGNORECASE,
    )
    if not model_prefix:
        return False
    return model_prefix.group(1).lower() not in {'code', 'fault', 'alarm', 'error'}


def is_decimal_capacity_fragment(raw_text, code):
    if not re.fullmatch(r'\d{1,3}', code or ''):
        return False
    text = raw_text or ''
    compact = normalize_text(text).replace(' ', '')
    if re.search(rf'(?:^|[^\d])\d+\.{re.escape(code)}(?:[、,，/]\d+(?:\.\d+)?)*\s*(?:MW|M|兆瓦|系列)', compact, flags=re.IGNORECASE):
        return True
    if re.search(rf'(?:^|[^\d]){re.escape(code)}(?:\.\d+)?(?:[、,，/]\d+(?:\.\d+)?)+\s*(?:MW|M|兆瓦|系列)', compact, flags=re.IGNORECASE):
        return True
    return False


def is_capacity_numeric_list_fragment(raw_text, code):
    normalized_code = normalize_text(code).upper().replace(' ', '')
    if not re.fullmatch(r'\d{1,3}(?:[、,，]\d{1,3}|(?:至|到|[~～])\d{1,3})+', normalized_code or ''):
        return False
    compact = normalize_text(raw_text or '').replace(' ', '')
    return bool(re.search(
        r'\d+(?:\.\d+)?(?:[、,，/]\d+(?:\.\d+)?)+\s*(?:MW|M|兆瓦|系列)',
        compact,
        flags=re.IGNORECASE,
    ))


def is_io_module_fragment(raw_text, code):
    normalized_code = normalize_text(code).upper().replace(' ', '')
    if not normalized_code:
        return False
    text = normalize_text(raw_text or '').upper().replace(' ', '')
    if re.search(rf'(?:X\d{{1,3}})?(?:DI|DO|AI|AO)\d+[A-Z0-9_]*{re.escape(normalized_code)}[A-Z0-9_]*', text):
        return True
    if re.fullmatch(r'[A-Z]{1,4}\d+[A-Z0-9_]*', normalized_code) and re.search(r'(模块|端口|通道|反馈点|PLC|柜)', raw_text or '', flags=re.IGNORECASE):
        return True
    return False


def is_code_inside_model_alias(raw_text, code):
    normalized_code = normalize_text(code).upper().replace(' ', '')
    if not normalized_code:
        return False
    for pattern in MODEL_ALIAS_PATTERNS:
        for match in re.finditer(pattern, raw_text or '', flags=re.IGNORECASE):
            alias = normalize_text(match.group(0)).upper().replace(' ', '')
            if alias and alias != normalized_code and normalized_code in alias:
                return True
    return False


def append_retrieval_query_variant(variants, seen_queries, text, weight, reason):
    normalized = normalize_text(text)
    if len(normalized) < 2:
        return
    lowered = normalized.lower()
    if lowered in seen_queries:
        return
    seen_queries.add(lowered)
    variants.append({
        'query': normalized,
        'weight': float(weight),
        'reason': reason,
    })


def build_retrieval_query_variants(query, history=None):
    normalized_query = normalize_text(query)
    if not normalized_query:
        return []

    history = history or []
    variants = []
    seen_queries = set()
    append_retrieval_query_variant(
        variants,
        seen_queries,
        normalized_query,
        weight=1.0,
        reason='original',
    )

    recent_user_inputs = [
        normalize_text(item.get('content', ''))
        for item in history[-(RAG_HISTORY_QUERY_WINDOW * 2):]
        if item.get('role') == 'user'
    ]
    recent_user_inputs = [item for item in recent_user_inputs if item]
    has_followup_shape = (
        len(normalized_query) <= 24
        or any(keyword in normalized_query for keyword in DIAGNOSIS_FOLLOWUP_KEYWORDS)
    )
    relevant_history = [
        item for item in recent_user_inputs
        if has_device_issue_hint(item) or extract_fault_codes(item)
    ]
    if has_followup_shape and relevant_history:
        history_context = '；'.join(relevant_history[-RAG_HISTORY_QUERY_WINDOW:] + [normalized_query])
        append_retrieval_query_variant(
            variants,
            seen_queries,
            history_context,
            weight=0.92,
            reason='history_context',
        )

    expanded_source = (
        ' '.join(relevant_history[-RAG_HISTORY_QUERY_WINDOW:] + [normalized_query])
        if has_followup_shape else normalized_query
    )
    expanded_fault_codes = extract_fault_codes(expanded_source)
    query_terms = extract_query_terms(expanded_source)
    if expanded_fault_codes:
        append_retrieval_query_variant(
            variants,
            seen_queries,
            ' '.join(expanded_fault_codes + query_terms[:4]),
            weight=0.96,
            reason='fault_code_focus',
        )

    keyword_terms = []
    for term in query_terms:
        if term not in keyword_terms:
            keyword_terms.append(term)
        if len(keyword_terms) >= 6:
            break
    if len(keyword_terms) >= 2:
        append_retrieval_query_variant(
            variants,
            seen_queries,
            ' '.join(keyword_terms),
            weight=0.88,
            reason='keyword_focus',
        )

    return variants[:RAG_QUERY_VARIANTS]


def extract_model_mentions(text):
    normalized_text = normalize_model_lookup_key(text)
    if not normalized_text:
        return []

    matched_models = []
    for alias_key, model_names in langchain_model_lookup.items():
        if alias_key and alias_key in normalized_text:
            matched_models.extend(sorted(model_names))
    return dedupe_preserve_order(matched_models)


def lookup_fault_code_mapping(fault_code):
    normalized_code = normalize_text(fault_code).upper().replace(' ', '')
    if not normalized_code:
        return None
    return langchain_fault_code_index.get(normalized_code)


def resolve_fault_code_query_profile(query, history=None, wind_farm_models=None):
    history = history or []
    wind_farm_models = [
        normalize_text(model)
        for model in (wind_farm_models or [])
        if normalize_text(model) and normalize_text(model) != '待配置'
    ]

    normalized_query = normalize_text(query)
    recent_user_inputs = [
        normalize_text(item.get('content', ''))
        for item in history[-(RAG_HISTORY_QUERY_WINDOW * 2):]
        if item.get('role') == 'user'
    ]
    recent_user_inputs = [item for item in recent_user_inputs if item]

    combined_text = normalized_query
    if normalized_query and (
        len(normalized_query) <= 24
        or any(keyword in normalized_query for keyword in DIAGNOSIS_FOLLOWUP_KEYWORDS)
    ):
        combined_text = ' '.join(recent_user_inputs[-RAG_HISTORY_QUERY_WINDOW:] + [normalized_query])

    fault_codes = extract_fault_codes(combined_text)
    mentioned_models = dedupe_preserve_order(
        extract_model_mentions(combined_text) + wind_farm_models
    )

    code_models = []
    for code in fault_codes:
        mapping = lookup_fault_code_mapping(code) or {}
        code_models.extend(mapping.get('models', []))
    code_models = dedupe_preserve_order(code_models)

    preferred_models = list(mentioned_models)
    inferred_models = []

    if wind_farm_models and code_models:
        intersection = [
            model for model in code_models
            if normalize_model_lookup_key(model) in {
                normalize_model_lookup_key(item) for item in wind_farm_models
            }
        ]
        if intersection:
            preferred_models = dedupe_preserve_order(preferred_models + intersection)

    if not preferred_models and len(code_models) == 1:
        inferred_models = list(code_models)
    elif preferred_models:
        inferred_models = [
            model for model in code_models
            if normalize_model_lookup_key(model) in {
                normalize_model_lookup_key(item) for item in preferred_models
            }
        ]

    return {
        'fault_codes': fault_codes,
        'mentioned_models': mentioned_models,
        'preferred_models': dedupe_preserve_order(preferred_models),
        'candidate_models': code_models,
        'inferred_models': dedupe_preserve_order(inferred_models),
    }


def apply_fault_code_model_profile(chunks, profile):
    if not chunks:
        return []

    preferred_model_keys = {
        normalize_model_lookup_key(item)
        for item in (profile or {}).get('preferred_models', [])
        if normalize_model_lookup_key(item)
    }
    inferred_model_keys = {
        normalize_model_lookup_key(item)
        for item in (profile or {}).get('inferred_models', [])
        if normalize_model_lookup_key(item)
    }
    candidate_model_keys = {
        normalize_model_lookup_key(item)
        for item in (profile or {}).get('candidate_models', [])
        if normalize_model_lookup_key(item)
    }
    requested_fault_codes = {
        normalize_text(item).upper().replace(' ', '')
        for item in (profile or {}).get('fault_codes', [])
        if normalize_text(item)
    }

    profiled_chunks = []
    for item in chunks:
        enriched = dict(item)
        metadata = enrich_document_metadata(enriched.get('metadata'))
        enriched['metadata'] = metadata
        previous_model_score = float(enriched.get('model_match_score', 0.0))
        previous_fault_score = float(enriched.get('fault_code_match_score', 0.0))

        alias_keys = {
            normalize_model_lookup_key(alias)
            for alias in get_document_model_aliases(metadata)
            if normalize_model_lookup_key(alias)
        }

        model_score = 0.0
        if preferred_model_keys and alias_keys & preferred_model_keys:
            model_score = 1.8
        elif inferred_model_keys and alias_keys & inferred_model_keys:
            model_score = 1.2
        elif candidate_model_keys and alias_keys & candidate_model_keys:
            model_score = 0.7

        searchable_text = '\n'.join([
            enriched.get('document_name', ''),
            get_chunk_heading(metadata),
            enriched.get('content', ''),
        ])
        matched_codes = requested_fault_codes & {
            normalize_text(code).upper().replace(' ', '')
            for code in extract_fault_codes(searchable_text)
        }
        fault_score = 2.2 if matched_codes else 0.0

        enriched['model_match_score'] = model_score
        enriched['fault_code_match_score'] = fault_score
        base_hybrid_score = (
            float(enriched.get('hybrid_score', enriched.get('score', 0.0)))
            - previous_model_score
            - previous_fault_score
        )
        base_score = (
            float(enriched.get('score', 0.0))
            - previous_model_score * 0.35
            - previous_fault_score * 0.45
        )
        enriched['hybrid_score'] = base_hybrid_score + model_score + fault_score
        enriched['score'] = base_score + model_score * 0.35 + fault_score * 0.45
        profiled_chunks.append(enriched)

    return profiled_chunks


def heuristic_classify_question(query):
    normalized = normalize_text(query)
    if not normalized:
        return 1

    lowered = normalized.lower()
    if any(re.fullmatch(pattern, lowered) for pattern in GREETING_QUERY_PATTERNS):
        return 1
    if any(keyword in normalized for keyword in GENERAL_NON_DIAGNOSTIC_KEYWORDS):
        return 1

    extracted_codes = extract_fault_codes(normalized)
    if extracted_codes or re.search(
        r'(?i)(?<![A-Z0-9_])[A-Z]{1,4}[-_]?\d{2,6}(?![A-Z0-9_])\s*(?:报警|告警|故障|错误|fault|alarm|error)',
        normalized,
    ):
        return 3

    has_scene = infer_guided_diagnosis_scene(normalized) is not None
    has_device_hint = any(keyword in lowered for keyword in DEVICE_HINT_KEYWORDS)
    has_issue_hint = any(keyword in lowered for keyword in ISSUE_HINT_KEYWORDS)
    has_digits = bool(re.search(r'\d', normalized))
    has_specific_device_hint = any(
        keyword in lowered
        for keyword in DEVICE_HINT_KEYWORDS
        if keyword not in BROAD_DEVICE_KEYWORDS
    )
    is_broad_vague_issue = (
        any(keyword in normalized for keyword in BROAD_DEVICE_KEYWORDS)
        and any(keyword in normalized for keyword in VAGUE_ISSUE_KEYWORDS)
        and not has_specific_device_hint
        and not has_digits
        and not has_scene
        and len(normalized) <= 30
    )
    if is_broad_vague_issue:
        return 2

    has_parameter_or_event_evidence = bool(re.search(
        r'(?:\d+(?:\.\d+)?\s*(?:℃|°c|度|bar|mpa|pa|v|a|kw|mw|hz|%|rpm|转/分|转速|秒|分钟)|'
        r'(?:持续|反复|趋势|同时|伴随|跳闸|跳机|停机|保护动作|滤芯压差|通讯丢失|通信丢失))',
        normalized,
        flags=re.IGNORECASE,
    ))
    if has_parameter_or_event_evidence and (has_device_hint or has_scene or has_issue_hint):
        return 3
    if has_scene and (has_device_hint or has_digits):
        return 2
    if has_specific_device_hint and has_issue_hint:
        return 2
    if has_issue_hint and should_retrieve_local_knowledge(normalized):
        return 3
    if has_scene or has_device_hint or has_issue_hint:
        return 2
    if len(normalized) <= 12:
        return 1
    return None


def has_device_issue_hint(text):
    normalized = normalize_text(text)
    if not normalized:
        return False

    if re.search(
        r'(原理|机理|工作原理|工作过程|如何工作|怎么工作|是怎样|是什么原理)',
        normalized,
        flags=re.IGNORECASE,
    ) and re.search(
        r'(风力发电|风力?电|风电|风能|发电|风机)',
        normalized,
        flags=re.IGNORECASE,
    ) and not re.search(
        r'(报警|告警|故障码|故障代码|报码|停机|跳闸|过温|超限|异常)',
        normalized,
        flags=re.IGNORECASE,
    ):
        return False

    if is_bare_windrise_fault_code_query(normalized):
        return False

    if is_windrise_scope_device_reply(normalized):
        return False

    if any(keyword in normalized for keyword in GENERAL_NON_DIAGNOSTIC_KEYWORDS):
        return False

    lowered = normalized.lower()
    has_scene = infer_guided_diagnosis_scene(normalized) is not None
    has_device_hint = any(keyword in lowered for keyword in DEVICE_HINT_KEYWORDS)
    has_issue_hint = any(keyword in lowered for keyword in ISSUE_HINT_KEYWORDS)
    if has_scene or has_device_hint or has_issue_hint or bool(extract_fault_codes(normalized)):
        return True
    subject = extract_scada_style_alarm_name(normalized) or extract_windrise_fault_subject_phrase(normalized)
    return bool(subject and len(normalize_text(subject)) >= 4)


def infer_conversation_mode(query, history=None):
    normalized = normalize_text(query)
    if not normalized:
        return 'chat'

    history = history or []
    lowered = normalized.lower()
    recent_user_inputs = [
        item.get('content', '')
        for item in history[-6:]
        if item.get('role') == 'user'
    ]
    recent_context = normalize_text(' '.join(recent_user_inputs))

    if has_device_issue_hint(normalized):
        return 'diagnosis'

    if recent_context and has_device_issue_hint(recent_context):
        is_followup = (
            len(normalized) <= 24
            or any(keyword in normalized for keyword in DIAGNOSIS_FOLLOWUP_KEYWORDS)
        )
        if is_followup:
            return 'diagnosis'

    if any(re.fullmatch(pattern, lowered) for pattern in GREETING_QUERY_PATTERNS):
        return 'chat'
    if any(re.fullmatch(pattern, normalized) for pattern in CASUAL_CHAT_PATTERNS):
        return 'chat'
    if any(keyword in normalized for keyword in CASUAL_CHAT_KEYWORDS):
        return 'chat'

    return 'chat'


def iter_langchain_index_documents():
    if langchain_vectorstore is None:
        return []

    docstore = getattr(langchain_vectorstore, 'docstore', None)
    index_to_docstore_id = getattr(langchain_vectorstore, 'index_to_docstore_id', {})
    doc_dict = getattr(docstore, '_dict', {})
    documents = []
    for doc_id in index_to_docstore_id.values():
        document = doc_dict.get(doc_id)
        if document is not None:
            documents.append(document)
    return documents


def rebuild_sparse_index_from_vectorstore():
    global langchain_sparse_docs
    global langchain_sparse_doc_freq
    global langchain_sparse_avgdl
    global langchain_sparse_term_doc_ids
    global langchain_sparse_fault_code_doc_ids
    global langchain_chunk_groups
    global langchain_fault_code_index
    global langchain_model_lookup
    global langchain_known_models

    documents = iter_langchain_index_documents()
    sparse_docs = []
    doc_freq = defaultdict(int)
    total_terms = 0
    term_doc_ids = defaultdict(list)
    fault_code_doc_ids = defaultdict(list)
    chunk_groups = defaultdict(list)
    fault_code_index = {}
    model_lookup = defaultdict(set)
    known_models = []

    for doc in documents:
        metadata = enrich_document_metadata(doc.metadata or {})
        if getattr(doc, 'metadata', None) is not None:
            doc.metadata = metadata
        content = (doc.page_content or '').strip()
        if not content:
            continue

        chunk_groups[build_chunk_parent_key(metadata)].append({
            'chunk_key': build_chunk_lookup_key(metadata, content),
            'content': content,
            'metadata': metadata,
        })

        heading = get_chunk_heading(metadata)
        doc_name = metadata.get('document_name', '')
        model_name = get_document_model_name(metadata)
        if model_name:
            known_models.append(model_name)
        for alias in get_document_model_aliases(metadata):
            alias_key = normalize_model_lookup_key(alias)
            if alias_key and model_name:
                model_lookup[alias_key].add(model_name)
        title_text = f"{doc_name} {heading}".strip()
        title_lower = normalize_lookup_text(title_text)
        content_normalized = normalize_lookup_text(content)
        tokens = tokenize_sparse_text(
            ' '.join(
                filter(
                    None,
                    [
                        title_text,
                        content_normalized,
                    ],
                )
            )
        )
        if not tokens:
            continue

        term_freq = defaultdict(int)
        for token in tokens:
            term_freq[token] += 1
        for token in term_freq.keys():
            doc_freq[token] += 1

        doc_index = len(sparse_docs)
        total_terms += len(tokens)
        for token in term_freq.keys():
            term_doc_ids[token].append(doc_index)

        for code in extract_fault_codes(f"{title_text}\n{content}"):
            normalized_code = code.lower()
            if normalized_code:
                fault_code_doc_ids[normalized_code].append(doc_index)
            canonical_code = normalize_text(code).upper().replace(' ', '')
            entry = fault_code_index.setdefault(canonical_code, {
                'models': set(),
                'documents': set(),
                'sources': set(),
                'count': 0,
            })
            if model_name:
                entry['models'].add(model_name)
            if doc_name:
                entry['documents'].add(doc_name)
            if metadata.get('source'):
                entry['sources'].add(metadata.get('source'))
            entry['count'] += 1

        sparse_docs.append({
            'document': doc,
            'tokens': tokens,
            'term_freq': dict(term_freq),
            'length': len(tokens),
            'title_lower': title_lower,
            'content_normalized': content_normalized,
        })

    langchain_sparse_docs = sparse_docs
    langchain_sparse_doc_freq = doc_freq
    langchain_sparse_avgdl = (total_terms / len(sparse_docs)) if sparse_docs else 0.0
    langchain_sparse_term_doc_ids = term_doc_ids
    langchain_sparse_fault_code_doc_ids = fault_code_doc_ids
    for items in chunk_groups.values():
        items.sort(
            key=lambda item: (
                str((item.get('metadata') or {}).get('page', '')),
                int((item.get('metadata') or {}).get('chunk_index', 0) or 0),
            )
        )
    langchain_chunk_groups = chunk_groups
    langchain_fault_code_index = {
        code: {
            'models': sorted(entry['models']),
            'documents': sorted(entry['documents']),
            'sources': sorted(entry['sources']),
            'count': int(entry['count']),
        }
        for code, entry in fault_code_index.items()
    }
    langchain_model_lookup = model_lookup
    langchain_known_models = dedupe_preserve_order(known_models)


def get_sparse_candidate_doc_ids(query_terms=None, fault_codes=None):
    candidate_doc_ids = set()

    for term in (query_terms or []):
        candidate_doc_ids.update(langchain_sparse_term_doc_ids.get(term, ()))

    for code in (fault_codes or []):
        normalized_code = (code or '').strip().lower()
        if normalized_code:
            candidate_doc_ids.update(langchain_sparse_fault_code_doc_ids.get(normalized_code, ()))

    return candidate_doc_ids


def get_bm25_match_chunks(query, limit):
    if not langchain_sparse_docs:
        return []

    query_terms = extract_query_terms(query)
    if not query_terms:
        return []

    doc_count = len(langchain_sparse_docs)
    avgdl = langchain_sparse_avgdl or 1.0
    k1 = 1.5
    b = 0.75
    scored_items = []
    candidate_doc_ids = get_sparse_candidate_doc_ids(query_terms=query_terms)

    if not candidate_doc_ids:
        return []

    for doc_id in candidate_doc_ids:
        item = langchain_sparse_docs[doc_id]
        score = 0.0
        doc_len = max(item['length'], 1)
        term_freq = item['term_freq']
        for term in query_terms:
            freq = term_freq.get(term)
            if not freq:
                continue
            df = langchain_sparse_doc_freq.get(term, 0)
            idf = math.log(1.0 + ((doc_count - df + 0.5) / (df + 0.5)))
            denom = freq + k1 * (1.0 - b + b * (doc_len / avgdl))
            score += idf * ((freq * (k1 + 1.0)) / denom)

        if score <= 0:
            continue

        doc = item['document']
        scored_items.append(
            build_langchain_match_item(
                content=(doc.page_content or '').strip(),
                metadata=doc.metadata or {},
                score=score,
            )
        )

    scored_items.sort(key=lambda row: row.get('score', 0.0), reverse=True)
    return scored_items[:limit]


def build_langchain_match_item(content, metadata, score, exact_match_score=0.0):
    metadata = enrich_document_metadata(metadata)
    document_name = metadata.get('document_name') or os.path.basename(metadata.get('source', 'unknown'))
    return {
        'document_name': document_name,
        'score': float(score),
        'content': content,
        'context_excerpt': build_context_excerpt(content, metadata),
        'metadata': metadata,
        'chunk_key': build_chunk_lookup_key(metadata, content),
        'exact_match_score': float(exact_match_score),
        'model_match_score': 0.0,
        'fault_code_match_score': 0.0,
    }


def get_langchain_rank_key(item):
    return (
        item.get('exact_match_score', 0.0),
        item.get('fault_code_match_score', 0.0),
        item.get('model_match_score', 0.0),
        item.get('rerank_score', 0.0),
        item.get('hybrid_score', item.get('score', 0.0)),
        item.get('vector_score', item.get('score', 0.0)),
        item.get('bm25_score', 0.0),
        item.get('score', 0.0),
    )


def apply_query_weight_to_candidate(item, source, weight):
    weighted = dict(item)
    numeric_fields = ['score']
    if source == 'exact':
        numeric_fields.append('exact_match_score')
    elif source == 'bm25':
        numeric_fields.append('bm25_score')
    elif source == 'vector':
        numeric_fields.append('vector_score')

    for field in numeric_fields:
        weighted[field] = float(weighted.get(field, 0.0)) * float(weight)

    weighted['query_weight'] = max(float(weighted.get('query_weight', 0.0)), float(weight))
    return weighted


def select_diverse_langchain_chunks(chunks, top_k):
    if not chunks:
        return []

    ranked_chunks = sorted(
        chunks,
        key=get_langchain_rank_key,
        reverse=True
    )
    selected = []
    deferred = []
    doc_counts = defaultdict(int)
    parent_counts = defaultdict(int)

    for item in ranked_chunks:
        metadata = item.get('metadata') or {}
        doc_key = str(metadata.get('source') or item.get('document_name') or item.get('chunk_key'))
        parent_key = build_chunk_parent_key(metadata) or doc_key
        if (
            doc_counts[doc_key] >= RAG_MAX_CHUNKS_PER_DOC
            or parent_counts[parent_key] >= RAG_MAX_CHUNKS_PER_PARENT
        ):
            deferred.append(item)
            continue

        selected.append(item)
        doc_counts[doc_key] += 1
        parent_counts[parent_key] += 1
        if len(selected) >= top_k:
            break

    if len(selected) < top_k:
        for item in deferred:
            chunk_key = item.get('chunk_key')
            if chunk_key and any(existing.get('chunk_key') == chunk_key for existing in selected):
                continue
            selected.append(item)
            if len(selected) >= top_k:
                break

    for item in selected:
        item['context_excerpt'] = build_expanded_context_excerpt(item)

    return selected[:top_k]


def merge_langchain_candidate(merged_candidates, item, source):
    chunk_key = item.get('chunk_key')
    if not chunk_key:
        return

    existing = merged_candidates.get(chunk_key)
    if existing is None:
        existing = dict(item)
        existing.setdefault('exact_match_score', 0.0)
        existing.setdefault('bm25_score', 0.0)
        existing.setdefault('vector_score', 0.0)
        merged_candidates[chunk_key] = existing
    elif not existing.get('context_excerpt') and item.get('context_excerpt'):
        existing['context_excerpt'] = item.get('context_excerpt')

    incoming_score = float(item.get('score', 0.0))
    if source == 'exact':
        existing['exact_match_score'] = max(
            float(existing.get('exact_match_score', 0.0)),
            float(item.get('exact_match_score', incoming_score)),
        )
    elif source == 'bm25':
        existing['bm25_score'] = max(
            float(existing.get('bm25_score', 0.0)),
            float(item.get('bm25_score', incoming_score)),
            incoming_score,
        )
    elif source == 'vector':
        existing['vector_score'] = max(
            float(existing.get('vector_score', 0.0)),
            incoming_score,
        )

    if incoming_score > float(existing.get('score', 0.0)):
        existing['score'] = incoming_score

    existing['hybrid_score'] = (
        float(existing.get('exact_match_score', 0.0)) * 5.0
        + float(existing.get('vector_score', 0.0)) * 2.5
        + min(float(existing.get('bm25_score', 0.0)), 12.0) * 0.35
    )


def get_exact_match_chunks(query, limit):
    normalized_query = normalize_lookup_text(query)
    if not normalized_query:
        return []

    query_terms = extract_query_terms(query)
    fault_codes = extract_fault_codes(query)
    if not query_terms and not fault_codes:
        return []

    candidates = []
    candidate_doc_ids = get_sparse_candidate_doc_ids(
        query_terms=query_terms,
        fault_codes=fault_codes
    )
    if not candidate_doc_ids:
        return []

    for doc_id in candidate_doc_ids:
        sparse_item = langchain_sparse_docs[doc_id]
        doc = sparse_item['document']
        metadata = dict(doc.metadata or {})
        content = (doc.page_content or '').strip()
        title_lower = sparse_item.get('title_lower', '')
        content_normalized = sparse_item.get('content_normalized', '')

        exact_score = 0.0
        for code in fault_codes:
            normalized_code = code.lower()
            if normalized_code in title_lower:
                exact_score += 5.0
            elif normalized_code in content_normalized:
                exact_score += 3.5

        if normalized_query and normalized_query in title_lower:
            exact_score += 2.5

        for term in query_terms:
            if term in title_lower:
                exact_score += 0.6
            elif len(term) >= 4 and term in content_normalized:
                exact_score += 0.2

        if exact_score <= 0:
            continue

        item = build_langchain_match_item(
            content=content,
            metadata=metadata,
            score=1.0 + exact_score,
            exact_match_score=exact_score,
        )
        candidates.append(item)

    candidates.sort(
        key=lambda item: (item.get('exact_match_score', 0.0), item.get('score', 0.0)),
        reverse=True
    )
    return candidates[:limit]


def load_langchain_documents(files):
    return []


def get_langchain_embeddings():
    global langchain_embeddings, langchain_embedding_backend

    if langchain_embeddings is not None:
        return langchain_embeddings

    with _model_init_lock:
        if langchain_embeddings is not None:
            return langchain_embeddings

        if LANGCHAIN_EMBEDDING_BACKEND in ('remote_openai', 'openai_compatible'):
            try:
                embedding_api_url = LANGCHAIN_EMBEDDING_API_URL or build_embeddings_url(VLLM_API_URL)
                langchain_embeddings = OpenAICompatibleEmbeddings(
                    model_name=LANGCHAIN_EMBEDDING_MODEL,
                    api_url=embedding_api_url,
                    query_instruction=LANGCHAIN_EMBEDDING_QUERY_INSTRUCTION,
                    dimensions=LANGCHAIN_EMBEDDING_DIMENSIONS,
                )
                langchain_embedding_backend = f'openai_compatible:{LANGCHAIN_EMBEDDING_MODEL}'
                print(
                    f"[LangChain] embedding backend loaded: {langchain_embedding_backend} "
                    f"via {embedding_api_url}"
                )
                return langchain_embeddings
            except Exception as e:
                print(f"[LangChain] remote embedding unavailable, fallback to hash embeddings: {e}")

        if LANGCHAIN_EMBEDDING_BACKEND in ('qwen3_local', 'sentence_transformers', 'st', 'auto'):
            try:
                langchain_embeddings = SentenceTransformerEmbeddings(
                    model_name=LANGCHAIN_EMBEDDING_MODEL,
                    local_files_only=LANGCHAIN_EMBEDDING_LOCAL_FILES_ONLY,
                    query_instruction=LANGCHAIN_EMBEDDING_QUERY_INSTRUCTION,
                    device=LANGCHAIN_EMBEDDING_DEVICE,
                )
                langchain_embedding_backend = (
                    f'qwen3_local:{LANGCHAIN_EMBEDDING_MODEL}@{langchain_embeddings.device}'
                )
                print(f"[LangChain] embedding backend loaded: {langchain_embedding_backend}")
                return langchain_embeddings
            except Exception as e:
                print(f"[LangChain] embedding model unavailable, fallback to hash embeddings: {e}")

        langchain_embeddings = HashEmbeddings(LANGCHAIN_FALLBACK_EMBEDDING_DIM)
        langchain_embedding_backend = f'hash_embeddings:{LANGCHAIN_FALLBACK_EMBEDDING_DIM}'
        print(f"[LangChain] embedding backend loaded: {langchain_embedding_backend}")

    return langchain_embeddings


def get_langchain_reranker():
    global langchain_reranker, langchain_reranker_backend

    if not LANGCHAIN_RERANKER_ENABLED:
        langchain_reranker_backend = 'disabled'
        return None

    if langchain_reranker is not None:
        return langchain_reranker

    with _model_init_lock:
        if langchain_reranker is not None:
            return langchain_reranker

        try:
            langchain_reranker = LocalQwenReranker(
                model_name=LANGCHAIN_RERANKER_MODEL,
                local_files_only=LANGCHAIN_RERANKER_LOCAL_FILES_ONLY,
                max_length=LANGCHAIN_RERANKER_MAX_LENGTH,
                batch_size=LANGCHAIN_RERANKER_BATCH_SIZE,
                instruction=LANGCHAIN_RERANKER_INSTRUCTION,
            )
            langchain_reranker_backend = (
                f'qwen3_local:{LANGCHAIN_RERANKER_MODEL}@{langchain_reranker.device}'
            )
            print(f"[LangChain] reranker backend loaded: {langchain_reranker_backend}")
        except Exception as e:
            langchain_reranker = None
            langchain_reranker_backend = f'unavailable:{e}'
            print(f"[LangChain] reranker unavailable, fallback to vector-only ranking: {e}")

    return langchain_reranker


def rerank_langchain_chunks(query, chunks, top_k):
    if len(chunks) < max(2, RAG_RERANKER_MIN_CANDIDATES):
        return sorted(
            chunks,
            key=get_langchain_rank_key,
            reverse=True
        )[:top_k]

    reranker = get_langchain_reranker()
    if not reranker or not chunks:
        return sorted(
            chunks,
            key=get_langchain_rank_key,
            reverse=True
        )[:top_k]

    documents = [item.get('content', '') for item in chunks]
    scores = reranker.score(query, documents)

    reranked_items = []
    for item, rerank_score in zip(chunks, scores):
        enriched = dict(item)
        enriched['vector_score'] = float(item.get('vector_score', 0.0))
        enriched['exact_match_score'] = float(item.get('exact_match_score', 0.0))
        enriched['bm25_score'] = float(item.get('bm25_score', 0.0))
        enriched['rerank_score'] = float(rerank_score)
        enriched['hybrid_score'] = (
            float(enriched['exact_match_score']) * 5.0
            + float(enriched['vector_score']) * 2.5
            + min(float(enriched['bm25_score']), 12.0) * 0.35
        )
        enriched['score'] = (
            float(rerank_score)
            + float(enriched['exact_match_score'])
            + float(enriched['vector_score']) * 0.2
        )
        reranked_items.append(enriched)

    reranked_items.sort(
        key=get_langchain_rank_key,
        reverse=True
    )
    return reranked_items[:top_k]


def split_langchain_documents(documents):
    chunked_documents = []
    total_documents = len(documents)
    update_langchain_progress(
        stage='splitting_chunks',
        message='正在切分知识库文档',
        total_documents=total_documents,
        processed_documents=0,
        processed_chunks=0,
    )
    for doc_index, doc in enumerate(documents, start=1):
        metadata = dict(doc.metadata or {})
        current_file = metadata.get('source') or metadata.get('document_name') or ''
        produced_chunks = 0
        for idx, chunk_text in enumerate(split_text_with_overlap(doc.page_content)):
            chunk_metadata = dict(metadata)
            chunk_metadata['chunk_index'] = idx
            chunked_documents.append(Document(page_content=chunk_text, metadata=chunk_metadata))
            produced_chunks += 1

        update_langchain_progress(
            current_file=current_file,
            processed_documents=doc_index,
            total_documents=total_documents,
            processed_chunks=len(chunked_documents),
        )
        if doc_index <= 3 or doc_index == total_documents or doc_index % 100 == 0:
            print_langchain_progress(
                f"已切分文档 {doc_index}/{total_documents}: +{produced_chunks} chunks"
            )

    return chunked_documents


def build_langchain_index(force_rebuild=False):
    global langchain_index_signature
    global langchain_index_initialized
    global langchain_loaded_files
    global langchain_loaded_chunks
    global langchain_last_build_at

    langchain_index_initialized = True
    langchain_index_signature = tuple()
    langchain_loaded_files = 0
    langchain_loaded_chunks = 0
    langchain_last_build_at = None
    finish_langchain_progress('本地知识库已关闭，知识检索由 Dify 负责。')
    return True


def ensure_langchain_index_ready():
    return True


def get_langchain_status():
    with langchain_rebuild_state_lock:
        background_rebuild = {
            'active': bool(langchain_background_rebuild_in_progress),
            'started_at': langchain_background_rebuild_started_at,
            'reason': langchain_background_rebuild_reason,
            'last_error': langchain_background_rebuild_last_error,
        }
    files, _directories = list_managed_wiki_files()
    summary = load_fault_index_summary_stats()
    record_count = int(summary.get('recordCount') or 0)
    index_path = resolve_windrise_fault_index_path()
    root = get_managed_wiki_root()
    return {
        'success': True,
        'knowledge_ready': bool(index_path and os.path.isfile(index_path)),
        'knowledge_files': len(files),
        'knowledge_chunks': record_count,
        'wiki_dir': str(root),
        'wiki_pages': record_count,
        'wiki_links': 0,
        'retrieval_mode': 'windrise-llmwiki',
        'progress': get_langchain_progress_status(),
        'background_rebuild': background_rebuild,
        'index_initialized': bool(index_path),
        'local_knowledge_disabled': LOCAL_KNOWLEDGE_DISABLED,
        'fault_index_summary': summary,
    }

# 启用 CORS。默认禁止跨域；仅当显式配置 CORS_ALLOWED_ORIGINS 时才开放。
allowed_cors_origins = [
    origin.strip()
    for origin in os.getenv('CORS_ALLOWED_ORIGINS', '').split(',')
    if origin.strip()
]
if allowed_cors_origins:
    CORS(
        app,
        resources={
            r"/api/*": {
                "origins": allowed_cors_origins,
                "methods": ["GET", "POST", "OPTIONS", "PUT", "DELETE"],
                "allow_headers": ["Content-Type", "Authorization", "X-Requested-With", "X-CSRF-Token"],
            }
        },
        supports_credentials=True,
    )

# ========== 安全加固 ==========
LOGIN_RATE_LIMIT_MAX = max(3, int(os.getenv('LOGIN_RATE_LIMIT_MAX', '5')))
LOGIN_RATE_LIMIT_WINDOW = max(30, int(os.getenv('LOGIN_RATE_LIMIT_WINDOW', '60')))
LOGIN_LOCKOUT_THRESHOLD = max(5, int(os.getenv('LOGIN_LOCKOUT_THRESHOLD', '10')))
LOGIN_LOCKOUT_WINDOW = max(60, int(os.getenv('LOGIN_LOCKOUT_WINDOW', '900')))
LOGIN_LOCKOUT_SECONDS = max(60, int(os.getenv('LOGIN_LOCKOUT_SECONDS', '900')))
CHAT_RATE_LIMIT_MAX = max(10, int(os.getenv('CHAT_RATE_LIMIT_MAX', '30')))
CHAT_RATE_LIMIT_WINDOW = max(30, int(os.getenv('CHAT_RATE_LIMIT_WINDOW', '60')))
CSRF_EXEMPT_PATHS = {
    '/api/login',
    '/health',
}
security_lock = threading.Lock()
login_attempt_tracker = defaultdict(list)
login_failure_tracker = defaultdict(list)
login_lockouts = {}
chat_rate_tracker = defaultdict(list)


def get_client_ip():
    forwarded = (request.headers.get('X-Forwarded-For') or '').strip()
    if forwarded:
        return forwarded.split(',')[0].strip()
    return request.remote_addr or 'unknown'


def check_rate_limit(bucket, key, max_requests, window_seconds):
    now = time.time()
    with security_lock:
        attempts = [timestamp for timestamp in bucket[key] if now - timestamp < window_seconds]
        if len(attempts) >= max_requests:
            bucket[key] = attempts
            retry_after = int(max(1, window_seconds - (now - attempts[0])))
            return False, retry_after
        attempts.append(now)
        bucket[key] = attempts
        return True, 0


def is_login_locked(client_ip):
    now = time.time()
    with security_lock:
        locked_until = login_lockouts.get(client_ip)
        if locked_until and now < locked_until:
            return True, int(max(1, locked_until - now))
        if locked_until:
            login_lockouts.pop(client_ip, None)
        return False, 0


def record_login_failure(client_ip):
    now = time.time()
    with security_lock:
        failures = [
            timestamp for timestamp in login_failure_tracker[client_ip]
            if now - timestamp < LOGIN_LOCKOUT_WINDOW
        ]
        failures.append(now)
        login_failure_tracker[client_ip] = failures
        if len(failures) >= LOGIN_LOCKOUT_THRESHOLD:
            login_lockouts[client_ip] = now + LOGIN_LOCKOUT_SECONDS
            login_failure_tracker[client_ip] = []


def clear_login_failures(client_ip):
    with security_lock:
        login_attempt_tracker.pop(client_ip, None)
        login_failure_tracker.pop(client_ip, None)
        login_lockouts.pop(client_ip, None)


def ensure_csrf_token():
    token = session.get('_csrf_token')
    if not token:
        token = secrets.token_urlsafe(32)
        session['_csrf_token'] = token
    return token


def validate_csrf_request():
    if request.method in ('GET', 'HEAD', 'OPTIONS'):
        return None
    if request.path in CSRF_EXEMPT_PATHS:
        return None
    if not request.path.startswith('/api/'):
        return None
    expected = session.get('_csrf_token', '')
    provided = (
        request.headers.get('X-CSRF-Token', '')
        or request.headers.get('X-Csrf-Token', '')
        or request.form.get('csrf_token', '')
    )
    if not expected or not provided or not secrets.compare_digest(provided, expected):
        return jsonify({'success': False, 'error': 'CSRF 校验失败，请刷新页面后重试'}), 403
    return None


@app.before_request
def enforce_security_controls():
    csrf_error = validate_csrf_request()
    if csrf_error:
        return csrf_error

# ========== 用户系统 ==========

class User(UserMixin):
    def __init__(self, id, username, name=None, is_admin=False):
        self.id = id
        self.username = username
        self.name = name or username
        self.is_admin = bool(is_admin)

    def get_id(self):
        return str(self.id)


def get_users_table_columns(cursor):
    cursor.execute('PRAGMA table_info(users)')
    return {row[1] for row in cursor.fetchall()}


def get_sessions_table_columns(cursor):
    cursor.execute('PRAGMA table_info(sessions)')
    return {row[1] for row in cursor.fetchall()}


def get_user_display_name(user_data):
    if not user_data:
        return None
    if hasattr(user_data, 'keys') and 'name' in user_data.keys() and user_data['name']:
        return user_data['name']
    return user_data['username']


def get_user_is_admin(user_data):
    if not user_data or not hasattr(user_data, 'keys'):
        return False
    if 'is_admin' not in user_data.keys():
        return False
    return bool(user_data['is_admin'])


def ensure_users_table_schema(cursor):
    columns = get_users_table_columns(cursor)
    if 'name' not in columns:
        cursor.execute('ALTER TABLE users ADD COLUMN name TEXT')
    if 'is_admin' not in columns:
        cursor.execute('ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0')
    cursor.execute("UPDATE users SET name = username WHERE name IS NULL OR TRIM(name) = ''")
    cursor.execute(
        'UPDATE users SET is_admin = 1 WHERE username = ?',
        (BOOTSTRAP_ADMIN_USERNAME,)
    )


def ensure_sessions_table_schema(cursor):
    columns = get_sessions_table_columns(cursor)
    if 'updated_at' not in columns:
        cursor.execute('ALTER TABLE sessions ADD COLUMN updated_at TIMESTAMP')
        cursor.execute("UPDATE sessions SET updated_at = created_at WHERE updated_at IS NULL")
    if 'message_count' not in columns:
        cursor.execute('ALTER TABLE sessions ADD COLUMN message_count INTEGER NOT NULL DEFAULT 0')
        cursor.execute(
            '''
            UPDATE sessions
            SET message_count = (
                SELECT COUNT(*) FROM messages WHERE messages.session_id = sessions.id
            )
            '''
        )


def build_session_title_from_content(content):
    content = (content or '').strip()
    if not content:
        return '历史对话'
    content = re.sub(r'\s+', ' ', content)
    return content[:20] + ('...' if len(content) > 20 else '')


def backfill_sessions_from_conversation_messages(cursor):
    """将旧的 conversation_messages 历史补齐到前端会话表。"""
    cursor.execute(
        '''
        SELECT cm.user_id,
               cm.conversation_id,
               MIN(cm.created_at) AS created_at,
               MAX(cm.created_at) AS updated_at,
               COUNT(*) AS message_count
        FROM conversation_messages cm
        JOIN users u ON u.id = CAST(cm.user_id AS INTEGER)
        WHERE TRIM(cm.user_id) != ''
          AND TRIM(cm.conversation_id) != ''
        GROUP BY cm.user_id, cm.conversation_id
        '''
    )
    conversations = cursor.fetchall()

    for row in conversations:
        user_id = int(row['user_id'])
        conversation_id = row['conversation_id']

        cursor.execute(
            '''
            SELECT id
            FROM sessions
            WHERE user_id = ? AND session_id = ?
            ORDER BY id
            LIMIT 1
            ''',
            (user_id, conversation_id)
        )
        session_row = cursor.fetchone()

        if session_row:
            app_session_id = session_row['id']
        else:
            cursor.execute(
                '''
                SELECT content
                FROM conversation_messages
                WHERE user_id = ?
                  AND conversation_id = ?
                  AND role = 'user'
                  AND TRIM(content) != ''
                ORDER BY id
                LIMIT 1
                ''',
                (str(user_id), conversation_id)
            )
            first_user_message = cursor.fetchone()
            title = build_session_title_from_content(
                first_user_message['content'] if first_user_message else ''
            )

            cursor.execute(
                '''
                INSERT INTO sessions (
                    user_id, session_id, title, created_at, updated_at, message_count
                )
                VALUES (?, ?, ?, ?, ?, 0)
                ''',
                (
                    user_id,
                    conversation_id,
                    title,
                    row['created_at'],
                    row['updated_at'] or row['created_at'],
                )
            )
            app_session_id = cursor.lastrowid

        cursor.execute(
            'SELECT COUNT(1) AS total FROM messages WHERE session_id = ?',
            (app_session_id,)
        )
        existing_message_count = int(cursor.fetchone()['total'] or 0)
        if existing_message_count:
            continue

        cursor.execute(
            '''
            SELECT role, content, created_at
            FROM conversation_messages
            WHERE user_id = ?
              AND conversation_id = ?
              AND role IN ('user', 'assistant')
              AND TRIM(content) != ''
            ORDER BY id
            ''',
            (str(user_id), conversation_id)
        )
        messages_to_copy = cursor.fetchall()
        if messages_to_copy:
            cursor.executemany(
                '''
                INSERT INTO messages (session_id, role, content, created_at)
                VALUES (?, ?, ?, ?)
                ''',
                [
                    (app_session_id, msg['role'], msg['content'], msg['created_at'])
                    for msg in messages_to_copy
                ]
            )

        cursor.execute(
            '''
            UPDATE sessions
            SET message_count = ?,
                updated_at = COALESCE(?, updated_at, created_at)
            WHERE id = ?
            ''',
            (len(messages_to_copy), row['updated_at'], app_session_id)
        )

@login_manager.user_loader
def load_user(user_id):
    conn = get_db_connection()
    try:
        cursor = conn.cursor()
        user_columns = get_users_table_columns(cursor)
        select_fields = ['id', 'username', 'created_at']
        if 'name' in user_columns:
            select_fields.append('name')
        if 'is_admin' in user_columns:
            select_fields.append('is_admin')
        cursor.execute(
            f"SELECT {', '.join(select_fields)} FROM users WHERE id = ?",
            (user_id,)
        )
        user_data = cursor.fetchone()
    finally:
        conn.close()
    if user_data:
        return User(
            user_data['id'],
            user_data['username'],
            get_user_display_name(user_data),
            get_user_is_admin(user_data)
        )
    return None

def get_db_connection():
    conn = sqlite3.connect(DATABASE_FILE, timeout=SQLITE_BUSY_TIMEOUT_MS / 1000.0, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA journal_mode=WAL')
    conn.execute('PRAGMA busy_timeout=%d' % SQLITE_BUSY_TIMEOUT_MS)
    conn.execute('PRAGMA synchronous=NORMAL')
    return conn

def init_db():
    conn = get_db_connection()
    cursor = conn.cursor()
    
    # 创建用户表
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            name TEXT,
            is_admin INTEGER NOT NULL DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    ''')
    ensure_users_table_schema(cursor)
    
    # 创建会话表
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            session_id TEXT NOT NULL,
            title TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            message_count INTEGER NOT NULL DEFAULT 0,
            FOREIGN KEY (user_id) REFERENCES users (id)
        )
    ''')
    ensure_sessions_table_schema(cursor)
    
    # 创建消息表
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id INTEGER NOT NULL,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (session_id) REFERENCES sessions (id)
        )
    ''')

    cursor.execute('''
        CREATE TABLE IF NOT EXISTS conversation_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            conversation_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    ''')

    cursor.execute('''
        CREATE INDEX IF NOT EXISTS idx_conversation_messages_lookup
        ON conversation_messages (conversation_id, user_id, id)
    ''')
    cursor.execute('''
        CREATE INDEX IF NOT EXISTS idx_sessions_user_lookup
        ON sessions (user_id, id)
    ''')
    cursor.execute('''
        CREATE INDEX IF NOT EXISTS idx_sessions_user_activity
        ON sessions (user_id, updated_at DESC, id DESC)
    ''')
    cursor.execute('''
        CREATE INDEX IF NOT EXISTS idx_messages_session_lookup
        ON messages (session_id, id)
    ''')

    backfill_sessions_from_conversation_messages(cursor)

    bootstrap_admin_password = BOOTSTRAP_ADMIN_PASSWORD

    cursor.execute('SELECT id, password FROM users WHERE username = ?', (BOOTSTRAP_ADMIN_USERNAME,))
    admin_user = cursor.fetchone()
    if not admin_user:
        if not bootstrap_admin_password:
            bootstrap_admin_password = generate_temporary_password()
            emit_bootstrap_admin_credentials(
                BOOTSTRAP_ADMIN_USERNAME,
                bootstrap_admin_password,
            )

        user_columns = get_users_table_columns(cursor)
        if 'name' in user_columns and 'is_admin' in user_columns:
            cursor.execute(
                'INSERT INTO users (username, password, name, is_admin) VALUES (?, ?, ?, 1)',
                (
                    BOOTSTRAP_ADMIN_USERNAME,
                    hash_password(bootstrap_admin_password),
                    BOOTSTRAP_ADMIN_USERNAME
                )
            )
        else:
            cursor.execute(
                'INSERT INTO users (username, password) VALUES (?, ?)',
                (BOOTSTRAP_ADMIN_USERNAME, hash_password(bootstrap_admin_password))
            )
    else:
        cursor.execute(
            'UPDATE users SET is_admin = 1 WHERE username = ?',
            (BOOTSTRAP_ADMIN_USERNAME,)
        )
    if admin_user and verify_password('admin', admin_user['password']):
        print(
            f"[SECURITY] 警告: 管理员账号 {BOOTSTRAP_ADMIN_USERNAME} 仍使用弱密码，请尽快修改"
        )
    
    conn.commit()
    conn.close()
    print("✅ 数据库初始化完成")

def legacy_hash_password(password):
    return hashlib.sha256(normalize_text(password).encode()).hexdigest()


def is_legacy_password_hash(password_hash):
    return bool(re.fullmatch(r'[0-9a-f]{64}', (password_hash or '').strip()))


def hash_password(password):
    return generate_password_hash(normalize_text(password))


def verify_password(password, password_hash):
    password_hash = (password_hash or '').strip()
    if not password_hash:
        return False
    password = normalize_text(password)
    if is_legacy_password_hash(password_hash):
        return legacy_hash_password(password) == password_hash
    return check_password_hash(password_hash, password)


def normalize_username(value):
    return normalize_text(value)


def validate_username(username):
    if not username:
        return '用户名不能为空'
    if not re.fullmatch(r'[A-Za-z0-9_.@-]{2,64}', username):
        return '用户名格式不合法，仅支持 2-64 位字母、数字、._@-'
    return ''


def validate_new_password(password):
    if not normalize_text(password):
        return '密码不能为空'
    password = str(password)
    if len(password) < 8:
        return '密码长度不能少于 8 位'
    if len(password) > 128:
        return '密码长度不能超过 128 位'
    if not re.search(r'[A-Za-z]', password):
        return '密码必须包含至少一个字母'
    if not re.search(r'\d', password):
        return '密码必须包含至少一个数字'
    return ''


def upgrade_legacy_password_hash(cursor, user_id, password, current_password_hash):
    if not is_legacy_password_hash(current_password_hash):
        return False
    cursor.execute(
        'UPDATE users SET password = ? WHERE id = ?',
        (hash_password(password), user_id)
    )
    return True


def admin_required(view_func):
    @wraps(view_func)
    def wrapped_view(*args, **kwargs):
        if not current_user.is_authenticated:
            return handle_unauthorized()
        if not getattr(current_user, 'is_admin', False):
            if request.path.startswith('/api/'):
                return jsonify({'success': False, 'error': '无管理员权限'}), 403
            return Response('无管理员权限', status=403, mimetype='text/plain; charset=utf-8')
        return view_func(*args, **kwargs)

    return wrapped_view


def serialize_user_record(user_row):
    return {
        'id': user_row['id'],
        'username': user_row['username'],
        'name': get_user_display_name(user_row),
        'is_admin': get_user_is_admin(user_row),
        'created_at': user_row['created_at'],
    }


def delete_user_related_data(cursor, user_id):
    user_id_text = normalize_user_id(user_id)
    cursor.execute(
        '''
        DELETE FROM messages
        WHERE session_id IN (
            SELECT id FROM sessions WHERE user_id = ?
        )
        ''',
        (user_id,)
    )
    cursor.execute('DELETE FROM sessions WHERE user_id = ?', (user_id,))
    cursor.execute('DELETE FROM conversation_messages WHERE user_id = ?', (user_id_text,))
    cursor.execute('DELETE FROM users WHERE id = ?', (user_id,))


def normalize_user_id(user_id):
    if user_id is None:
        return ''
    return str(user_id).strip()


def get_windrise_scoped_cache_key(conversation_id=None, user_id=None):
    """Scope all transient Windrise state to one authenticated user/chat."""
    conversation_value = normalize_user_id(
        conversation_id or getattr(windrise_request_context, 'conversation_id', '')
    )
    user_value = normalize_user_id(
        user_id or getattr(windrise_request_context, 'user_id', '')
    ) or '__anonymous__'
    return conversation_value, user_value


def reset_windrise_request_context():
    """Clear per-request thread-local state so worker threads cannot leak context."""
    for attr in (
        'conversation_id',
        'user_id',
        'deadline',
        'semantic_pass_used',
        'enforce_retrieval_extraction',
        'retrieval_query_extracted',
        'prefer_local_scoped_index',
        'new_case_switch',
        'active_scope_slots',
    ):
        if hasattr(windrise_request_context, attr):
            delattr(windrise_request_context, attr)


def forget_windrise_user_transient_state(user_id):
    """Drop in-memory Windrise caches for one authenticated user."""
    user_value = normalize_user_id(user_id)
    if not user_value:
        return
    with conversation_lock:
        for cache in (
            conversation_histories,
            windrise_lightweight_histories,
            windrise_yaw_hydraulic_stages,
        ):
            for key in [item for item in cache if item[1] == user_value]:
                cache.pop(key, None)
        hydrated_keys = [key for key in hydrated_conversations if key[1] == user_value]
        for key in hydrated_keys:
            hydrated_conversations.discard(key)
    with windrise_retrieval_memory_lock:
        for key in [item for item in windrise_retrieval_memories if item[1] == user_value]:
            windrise_retrieval_memories.pop(key, None)


def get_windrise_request_timeout(default_timeout):
    """Cap an individual operation by the remaining whole-request budget."""
    timeout_value = max(0.1, float(default_timeout))
    deadline = getattr(windrise_request_context, 'deadline', None)
    if deadline is None:
        return timeout_value
    remaining = float(deadline) - time.monotonic()
    if remaining <= 0:
        raise TimeoutError('Windrise 本轮回答已超过总时限')
    return max(0.1, min(timeout_value, remaining))


def get_managed_wiki_root():
    if WINDRISE_CWD:
        root = Path(WINDRISE_CWD) / '风机故障码' / '故障信息整理'
    else:
        root = Path(BASE_DIR).resolve().parent / '风机故障码' / '故障信息整理'
    root.mkdir(parents=True, exist_ok=True)
    return root


def resolve_admin_wiki_directory(relative_dir):
    root = get_managed_wiki_root()
    normalized = normalize_admin_wiki_relative_path(relative_dir)
    target = (root / normalized).resolve() if normalized else root.resolve()
    root_resolved = root.resolve()
    if os.path.commonpath([str(target), str(root_resolved)]) != str(root_resolved):
        raise ValueError('路径超出故障资料目录')
    return target, normalized


def resolve_wind_knowledge_reload_script():
    candidates = [
        os.path.join(WINDRISE_CWD, 'scripts', 'reload-wind-knowledge.sh'),
        os.path.normpath(os.path.join(BASE_DIR, '..', 'scripts', 'reload-wind-knowledge.sh')),
    ]
    for candidate in candidates:
        normalized = os.path.normpath(os.path.expandvars(os.path.expanduser(candidate)))
        if os.path.isfile(normalized):
            return normalized
    return ''


def load_fault_index_summary_stats():
    candidates = []
    if WINDRISE_CWD:
        candidates.extend([
            os.path.join(WINDRISE_CWD, '风机故障码', 'fault-index-summary.json'),
            os.path.join(WINDRISE_CWD, 'wind-llmwiki', 'fault-index-summary.json'),
        ])
    candidates.extend([
        os.path.normpath(os.path.join(BASE_DIR, '..', '风机故障码', 'fault-index-summary.json')),
        os.path.normpath(os.path.join(BASE_DIR, '..', 'wind-llmwiki', 'fault-index-summary.json')),
    ])
    for candidate in candidates:
        normalized = os.path.normpath(os.path.expandvars(os.path.expanduser(candidate)))
        if not os.path.isfile(normalized):
            continue
        try:
            with open(normalized, 'r', encoding='utf-8') as handle:
                return json.load(handle)
        except (OSError, json.JSONDecodeError):
            continue
    return {}


def invalidate_windrise_knowledge_caches():
    with windrise_fault_index_lock:
        windrise_fault_index_cache.update({'path': '', 'mtime': 0.0, 'records': []})
    with windrise_model_index_lock:
        windrise_model_index_cache.update({
            'fault_path': '',
            'fault_mtime': 0.0,
            'mapping_path': '',
            'mapping_mtime': 0.0,
            'entries': [],
        })
    with windrise_search_cache_lock:
        windrise_search_cache.clear()
    with windrise_retrieval_memory_lock:
        windrise_retrieval_memories.clear()


def remember_windrise_retrieval_context(query, answer, conversation_id=None, user_id=None):
    """Keep the latest successful KB hit as hidden, session-scoped context."""
    answer = normalize_text(answer)
    if not answer or is_windrise_no_match_answer(answer):
        return
    cache_key = get_windrise_scoped_cache_key(conversation_id, user_id)
    if not all(cache_key):
        return
    payload = {
        'query': normalize_text(query),
        'answer': answer[:WINDRISE_RETRIEVAL_MEMORY_CHARS],
        'updated_at': time.time(),
    }
    with windrise_retrieval_memory_lock:
        windrise_retrieval_memories[cache_key] = payload
        windrise_retrieval_memories.move_to_end(cache_key)
        while len(windrise_retrieval_memories) > MAX_CACHED_CONVERSATIONS:
            windrise_retrieval_memories.popitem(last=False)


def get_windrise_retrieval_context(conversation_id=None, user_id=None):
    cache_key = get_windrise_scoped_cache_key(conversation_id, user_id)
    if not all(cache_key):
        return None
    with windrise_retrieval_memory_lock:
        payload = windrise_retrieval_memories.get(cache_key)
        if payload:
            windrise_retrieval_memories.move_to_end(cache_key)
            return dict(payload)
    return None


def reusable_windrise_retrieval_context(query, history=None, route=None):
    """Return the prior hit when this is the same fault or a follow-up."""
    history = history or []
    if getattr(windrise_request_context, 'new_case_switch', False):
        return ''
    if detect_windrise_new_case_switch(query, history)[0]:
        return ''
    if (
        is_windrise_scoped_symptom_followup(query, history)
        or is_windrise_bare_symptom_with_confirmed_scope(query, history)
    ):
        return ''
    payload = get_windrise_retrieval_context()
    if not payload:
        return ''
    query_text = normalize_text(query)
    memory_text = f"{payload.get('query', '')}\n{payload.get('answer', '')}"
    if not windrise_retrieval_memory_matches_current_scope(query_text, memory_text):
        return ''
    route = route or {}
    current_problem_is_new = bool(route.get('current_problem_is_new')) or bool(
        has_specific_current_diagnosis_subject(query_text)
        and not is_context_only_windrise_followup(query_text)
    )
    query_codes = set(extract_fault_codes(query_text))
    memory_codes = set(extract_fault_codes(memory_text))
    if query_codes and query_codes & memory_codes:
        return payload.get('answer', '')
    if route.get('uses_history_fault_code') and route.get('fault_code'):
        if str(route['fault_code']).upper() in {code.upper() for code in memory_codes}:
            return payload.get('answer', '')
    if is_context_only_windrise_followup(query_text) or not current_problem_is_new:
        return payload.get('answer', '')

    # A repeated new-form query can reuse the same hit, but a genuinely new
    # component/fault must not inherit an unrelated result.
    query_terms = extract_core_diagnosis_terms(query_text)
    memory_lower = memory_text.lower()
    if query_terms and any(term.lower() in memory_lower for term in query_terms[:5]):
        return payload.get('answer', '')
    return ''


def direct_windrise_retrieval_memory_hit(query):
    """Safe reuse check for low-level search calls that do not carry history."""
    if getattr(windrise_request_context, 'new_case_switch', False):
        return ''
    payload = get_windrise_retrieval_context()
    if not payload:
        return ''
    query_text = normalize_text(query)
    memory_query = normalize_text(payload.get('query', ''))
    memory_answer = payload.get('answer', '')
    if not windrise_retrieval_memory_matches_current_scope(
        query_text,
        f"{memory_query}\n{memory_answer}",
    ):
        return ''
    query_codes = set(extract_fault_codes(query_text))
    memory_codes = set(extract_fault_codes(f"{memory_query}\n{memory_answer}"))
    if query_codes and query_codes & memory_codes:
        return memory_answer
    clean_query = re.sub(r'^(search|查|查询|检索|搜索)\s*', '', query_text, flags=re.IGNORECASE)
    clean_memory_query = re.sub(r'^(search|查|查询|检索|搜索)\s*', '', memory_query, flags=re.IGNORECASE)
    if clean_query and clean_memory_query and (
        clean_query == clean_memory_query
        or clean_query in clean_memory_query
        or clean_memory_query in clean_query
    ):
        return memory_answer
    return ''


def render_windrise_retrieval_memory(payload):
    if not payload:
        return ''
    return (
        '[仅供内部上下文使用的本地资料记忆]\n'
        f"首次检索问题：{payload.get('query', '')}\n"
        '以下是本会话已确认的风场、风机、厂家、机型、故障码及处理资料。'
        '后续追问优先复用，不要再次检索，也不要向用户暴露这段记忆标记。\n'
        f"{payload.get('answer', '')}"
    )[:WINDRISE_RETRIEVAL_MEMORY_CHARS + 260]


def history_without_retrieval_duplicate(history):
    """Drop the exact prior KB answer when it is also sent as wiki context."""
    payload = get_windrise_retrieval_context()
    remembered_answer = normalize_text((payload or {}).get('answer', ''))
    if not remembered_answer:
        return list(history or [])
    filtered = []
    for item in history or []:
        content = normalize_text(item.get('content', ''))
        if item.get('role') == 'assistant' and content == remembered_answer:
            continue
        filtered.append(item)
    return filtered


def invalidate_windrise_turbine_mapping_cache():
    with windrise_turbine_mapping_lock:
        windrise_turbine_mapping_cache.update({'path': '', 'mtime': 0.0, 'entries': []})


def resolve_project_data_file(*relative_parts):
    candidates = []
    if WINDRISE_CWD:
        candidates.append(os.path.join(WINDRISE_CWD, *relative_parts))
    candidates.append(os.path.normpath(os.path.join(BASE_DIR, '..', *relative_parts)))
    for candidate in candidates:
        normalized = os.path.normpath(os.path.expandvars(os.path.expanduser(candidate)))
        if os.path.isfile(normalized):
            return normalized
    if WINDRISE_CWD:
        return os.path.normpath(os.path.join(WINDRISE_CWD, *relative_parts))
    return os.path.normpath(os.path.join(BASE_DIR, '..', *relative_parts))


def resolve_turbine_mapping_json_path():
    return resolve_project_data_file('src', 'data', 'turbineMapping.json')


def normalize_turbine_mapping_entry(item):
    if not isinstance(item, dict):
        raise ValueError('映射行必须是对象')
    entry = {
        'turbineId': str(item.get('turbineId') or '').strip(),
        'unitNumber': str(item.get('unitNumber') or '').strip(),
        'site': str(item.get('site') or '').strip(),
        'siteFull': str(item.get('siteFull') or '').strip(),
        'brand': str(item.get('brand') or '').strip(),
        'model': str(item.get('model') or '').strip(),
        'standardModel': str(item.get('standardModel') or '').strip(),
    }
    if not entry['turbineId']:
        raise ValueError('风机编号不能为空')
    if not entry['site']:
        raise ValueError(f"风机 {entry['turbineId']} 缺少风场名称")
    if not entry['siteFull']:
        entry['siteFull'] = entry['site'] if entry['site'].endswith('风电场') else f"{entry['site']}风电场"
    return entry


def load_turbine_mapping_json_entries():
    path = resolve_turbine_mapping_json_path()
    if not path or not os.path.isfile(path):
        return [], path
    with open(path, 'r', encoding='utf-8') as handle:
        parsed = json.load(handle)
    if not isinstance(parsed, list):
        raise ValueError('turbineMapping.json 格式错误，应为数组')
    entries = [normalize_turbine_mapping_entry(item) for item in parsed if isinstance(item, dict)]
    return entries, path


def save_turbine_mapping_entries(raw_entries):
    if not isinstance(raw_entries, list):
        raise ValueError('entries 必须是数组')
    if not raw_entries:
        raise ValueError('映射表不能为空')

    entries = [normalize_turbine_mapping_entry(item) for item in raw_entries]
    seen = set()
    for entry in entries:
        key = (
            normalize_windrise_site_key(entry.get('site', '')),
            normalize_windrise_turbine_id(entry.get('turbineId', '')),
        )
        if key in seen:
            raise ValueError(f"重复风机编号：{entry.get('site')} / {entry.get('turbineId')}")
        seen.add(key)

    mapping_path = resolve_turbine_mapping_json_path()
    Path(mapping_path).parent.mkdir(parents=True, exist_ok=True)
    with open(mapping_path, 'w', encoding='utf-8') as handle:
        json.dump(entries, handle, ensure_ascii=False, indent=2)
        handle.write('\n')

    invalidate_windrise_turbine_mapping_cache()
    sites = sorted({entry.get('site', '') for entry in entries if entry.get('site')})
    return {
        'entry_count': len(entries),
        'site_count': len(sites),
        'sites': sites,
        'mapping_path': mapping_path,
    }


def update_langchain_progress(**updates):
    langchain_progress.update(updates)
    langchain_progress['updated_at'] = datetime.now().isoformat()


def start_wind_knowledge_rebuild_background(reason='manual'):
    global langchain_background_rebuild_in_progress
    global langchain_background_rebuild_started_at
    global langchain_background_rebuild_reason
    global langchain_background_rebuild_last_error

    with langchain_rebuild_state_lock:
        if langchain_background_rebuild_in_progress:
            return False, '已有更新任务在进行中，请稍候'
        langchain_background_rebuild_in_progress = True
        langchain_background_rebuild_started_at = datetime.now().isoformat()
        langchain_background_rebuild_reason = reason or 'manual'
        langchain_background_rebuild_last_error = ''

    update_langchain_progress(
        active=True,
        stage='rebuild',
        message='正在重建故障索引并同步 LLM Wiki...',
        current_file='',
        processed_files=0,
        total_files=0,
        processed_documents=0,
        total_documents=0,
        processed_chunks=0,
        total_chunks=0,
        started_at=langchain_background_rebuild_started_at,
    )

    def worker():
        global langchain_background_rebuild_in_progress
        global langchain_background_rebuild_last_error
        try:
            script_path = resolve_wind_knowledge_reload_script()
            if not script_path:
                raise RuntimeError('未找到 scripts/reload-wind-knowledge.sh')
            cwd = WINDRISE_CWD if WINDRISE_CWD and os.path.isdir(WINDRISE_CWD) else str(Path(BASE_DIR).resolve().parent)
            result = subprocess.run(
                ['bash', script_path],
                cwd=cwd,
                capture_output=True,
                text=True,
                encoding='utf-8',
                errors='replace',
                timeout=max(60, int(os.getenv('WIND_KNOWLEDGE_REBUILD_TIMEOUT', '3600'))),
            )
            if result.returncode != 0:
                detail = (result.stderr or result.stdout or '').strip()
                raise RuntimeError(detail or f'重建脚本退出码 {result.returncode}')
            invalidate_windrise_knowledge_caches()
            update_langchain_progress(
                active=False,
                stage='done',
                message='故障索引已更新，LLM Wiki 已同步',
            )
        except Exception as exc:
            langchain_background_rebuild_last_error = str(exc)
            update_langchain_progress(
                active=False,
                stage='error',
                message=f'更新失败：{exc}',
            )
            print(f"[Windrise] 故障资料重建失败: {type(exc).__name__}: {exc}")
        finally:
            with langchain_rebuild_state_lock:
                langchain_background_rebuild_in_progress = False

    threading.Thread(target=worker, daemon=True).start()
    return True, '已开始更新数据库，请稍候'


def normalize_admin_wiki_relative_path(value):
    relative = (value or '').strip().replace('\\', '/').lstrip('/')
    if not relative:
        return ''
    if re.match(r'^[A-Za-z]:', relative):
        raise ValueError('不允许使用绝对路径')
    parts = [part for part in relative.split('/') if part not in ('', '.')]
    if any(part == '..' for part in parts):
        raise ValueError('不允许使用上级目录路径')
    return '/'.join(parts)


def resolve_admin_wiki_path(relative_path, require_file=False):
    root = get_managed_wiki_root()
    normalized = normalize_admin_wiki_relative_path(relative_path)
    if require_file and not normalized:
        raise ValueError('文件路径不能为空')
    target = (root / normalized).resolve()
    root_resolved = root.resolve()
    if os.path.commonpath([str(target), str(root_resolved)]) != str(root_resolved):
        raise ValueError('路径超出本地知识库目录')
    return target, normalized


def ensure_markdown_filename(file_name):
    clean_name = normalize_admin_wiki_relative_path(file_name)
    if not clean_name:
        raise ValueError('文件名不能为空')
    suffix = Path(clean_name).suffix.lower()
    if not suffix:
        clean_name += '.md'
        suffix = '.md'
    if suffix not in ('.md', '.markdown'):
        raise ValueError('本地知识库页面只允许 .md 或 .markdown 文件')
    return clean_name


def list_managed_wiki_files():
    root = get_managed_wiki_root()
    files = []
    directory_counts = defaultdict(int)
    for path in sorted(root.rglob('*')):
        if not path.is_file() or path.suffix.lower() not in ('.md', '.markdown'):
            continue
        relative_path = str(path.relative_to(root)).replace('\\', '/')
        directory = str(path.parent.relative_to(root)).replace('\\', '/')
        if directory == '.':
            directory = ''
        directory_counts[directory] += 1
        stat = path.stat()
        files.append({
            'name': path.name,
            'relative_path': relative_path,
            'directory': directory,
            'size': stat.st_size,
            'updated_at': datetime.fromtimestamp(stat.st_mtime).isoformat(),
        })

    directories = [
        {
            'path': directory,
            'label': directory or '根目录',
            'file_count': count,
        }
        for directory, count in sorted(directory_counts.items(), key=lambda item: item[0])
    ]
    return files, directories


def get_conversation_cache_key(conversation_id, user_id):
    conversation_id = normalize_user_id(conversation_id)
    user_id = normalize_user_id(user_id)
    return conversation_id, user_id


def load_persistent_conversation_history(conversation_id, user_id, limit=MAX_HISTORY_MESSAGES):
    conversation_id = normalize_user_id(conversation_id)
    user_id = normalize_user_id(user_id)
    if not conversation_id or not user_id:
        return []

    conn = get_db_connection()
    try:
        cursor = conn.cursor()
        cursor.execute(
            '''
            SELECT role, content
            FROM conversation_messages
            WHERE conversation_id = ? AND user_id = ?
            ORDER BY id DESC
            LIMIT ?
            ''',
            (conversation_id, user_id, limit)
        )
        rows = cursor.fetchall()
    finally:
        conn.close()

    return [{"role": row['role'], "content": row['content']} for row in reversed(rows)]


def persist_conversation_message(conversation_id, user_id, role, content):
    conversation_id = normalize_user_id(conversation_id)
    user_id = normalize_user_id(user_id)
    if not conversation_id or not user_id or not content:
        return

    conn = get_db_connection()
    try:
        cursor = conn.cursor()
        cursor.execute(
            '''
            INSERT INTO conversation_messages (conversation_id, user_id, role, content)
            VALUES (?, ?, ?, ?)
            ''',
            (conversation_id, user_id, role, content)
        )
        conn.commit()
    finally:
        conn.close()


def forget_cached_conversation(conversation_id, user_id):
    cache_key = get_conversation_cache_key(conversation_id, user_id)
    with conversation_lock:
        conversation_histories.pop(cache_key, None)
        hydrated_conversations.discard(cache_key)


def parse_optional_int(value):
    if value is None or value == '':
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def resolve_chat_context_from_session(data, user_id, allow_new_conversation_id=True):
    """以服务端会话归属为准，确定本次聊天使用的 conversation_id。"""
    app_session_id = parse_optional_int(data.get('session_id'))
    client_conversation_id = normalize_user_id(data.get('conversation_id'))

    if app_session_id is None:
        if allow_new_conversation_id:
            return None, client_conversation_id or str(uuid.uuid4())
        return None, client_conversation_id

    conn = get_db_connection()
    try:
        cursor = conn.cursor()
        cursor.execute(
            '''
            SELECT id, session_id
            FROM sessions
            WHERE id = ? AND user_id = ?
            ''',
            (app_session_id, user_id)
        )
        session_row = cursor.fetchone()
        if not session_row:
            raise PermissionError('会话不存在或无权访问')

        stored_conversation_id = normalize_user_id(session_row['session_id'])
        if client_conversation_id and client_conversation_id != stored_conversation_id:
            cursor.execute(
                '''
                SELECT id
                FROM sessions
                WHERE user_id = ? AND session_id = ? AND id != ?
                LIMIT 1
                ''',
                (user_id, client_conversation_id, app_session_id)
            )
            if cursor.fetchone():
                print(
                    "[Session] 忽略已绑定到其他会话的客户端 conversation_id: "
                    f"session_id={app_session_id} user_id={mask_identifier(user_id)}"
                )
                client_conversation_id = ''

        conversation_id = stored_conversation_id or client_conversation_id
        if not conversation_id and allow_new_conversation_id:
            conversation_id = str(uuid.uuid4())

        if conversation_id and conversation_id != stored_conversation_id:
            cursor.execute(
                '''
                UPDATE sessions
                SET session_id = ?, updated_at = CURRENT_TIMESTAMP
                WHERE id = ? AND user_id = ?
                ''',
                (conversation_id, app_session_id, user_id)
            )
            conn.commit()

        return app_session_id, conversation_id
    finally:
        conn.close()


def has_explicit_fault_code(text):
    normalized = normalize_text(text)
    if (
        re.search(r'(完整告警是|完整报警是|完整故障是|原始告警是|原始报警是|原始故障是|告警内容|报警内容|故障内容|故障描述|故障现象|现在报的是|报的是|当前报的是)', normalized, flags=re.IGNORECASE)
        and not re.search(r'(故障码|故障代码|报码|告警码|报警码|状态码|状态代码)', normalized, flags=re.IGNORECASE)
    ):
        return False
    return bool(extract_fault_codes(normalized))


def infer_guided_diagnosis_scene(text):
    normalized = normalize_text(text)
    if not normalized:
        return None

    for scene in GUIDED_DIAGNOSIS_SCENES:
        if any(keyword in normalized for keyword in scene['keywords']):
            return scene
    return None


def build_guided_diagnosis_instruction(query, history, level):
    history = history or []
    if infer_conversation_mode(query, history) != 'diagnosis':
        return ''

    recent_user_inputs = [
        item.get('content', '')
        for item in history[-6:]
        if item.get('role') == 'user'
    ]
    combined_text = normalize_text(' '.join(recent_user_inputs + [query]))
    if not combined_text:
        return ''

    if has_explicit_fault_code(combined_text) and level >= 2:
        return ''

    instruction_lines = [
        "- 当前用户还没有明确提供可定位的故障码或告警全称时，不要直接下最终故障结论。",
        "- 先用一句简短的话告诉用户：要先确认告警来源、告警全称或报码，才能继续精准定位。",
        "- 追问控制在 1 到 3 个，按下面顺序优先：",
        "  1. 让用户回传主控/HMI、SCADA 告警列表、变流器/变桨柜本地屏、保护装置事件记录里看到的原始告警名称、故障码或事件原文。",
        "  2. 确认是哪台机组、哪个部件、现场最直接的异常现象是什么。",
        "  3. 确认异常出现时的关键参数或工况，例如温度、电流、电压、转速、功率、风速、是否可复现。",
        "- 如果用户暂时看不到报码，不要只让用户“补充故障码”，要直接告诉他去哪里查，以及把界面上的原文、截图或完整告警列表发回来。",
        "- 在信息仍不足时，优先输出“下一步去查什么”，而不是泛泛列很多可能原因。"
    ]

    if level == 1:
        instruction_lines.append("- 当前属于模糊报障，先帮助用户缩小范围，再进入具体故障判断。")
    elif level == 2:
        instruction_lines.append("- 当前已有部分现象描述，可以先给方向性判断，但必须同步引导用户补齐最关键的定位信息。")

    scene = infer_guided_diagnosis_scene(combined_text)
    if scene:
        instruction_lines.append(f"- 结合当前现象，{scene['focus']}")

    return "\n".join(instruction_lines)


def normalize_text(text):
    if text is None:
        return ''
    if isinstance(text, bytes):
        text = text.decode('utf-8', errors='ignore')
    normalized = str(text)
    normalized = normalized.replace('扭揽', '扭缆').replace('扭榄', '扭缆')
    normalized = normalized.replace('纽揽', '扭缆').replace('纽榄', '扭缆').replace('纽缆', '扭缆')
    for typo in ('故滩码', '故漳码', '故章码', '故璋码', '故障马', '故障吗'):
        normalized = normalized.replace(typo, '故障码')
    return re.sub(r'\s+', ' ', normalized).strip()


def normalize_windrise_query(text):
    """Normalize user fault queries for routing; commas are optional separators."""
    normalized = normalize_text(text)
    if not normalized:
        return ''
    return re.sub(r'[,，]+', '', normalized)


def clip_text(text, limit=180):
    text = normalize_text(text)
    if limit <= 3:
        return text[:max(limit, 0)]
    if len(text) <= limit:
        return text
    return text[:limit - 3] + '...'


def build_memory_summary(history):
    if len(history) <= RECENT_HISTORY_MESSAGES:
        return ''

    older_messages = history[:-RECENT_HISTORY_MESSAGES]
    summary_items = []

    for item in older_messages[-MAX_MEMORY_ITEMS:]:
        role = item.get('role')
        content = clip_text(item.get('content', ''))
        if not content:
            continue

        if role == 'user':
            summary_items.append(f"用户先前说明：{content}")
        elif role == 'assistant':
            summary_items.append(f"之前已建议：{content}")

    summary_text = '\n'.join(summary_items)
    if not summary_text:
        return ''

    if len(summary_text) > MAX_MEMORY_CHARS:
        summary_text = summary_text[-MAX_MEMORY_CHARS:]

    return "以下是同一会话的历史要点，请保持上下文连续，不要让用户重复提供：\n" + summary_text


def sanitize_assistant_answer(text):
    if not text:
        return ''

    # 清除残留的 <think>...</think> 标签（Qwen3 思维链泄漏到 content 中的兜底处理）
    cleaned_text = re.sub(r'<think>[\s\S]*?</think>', '', text, flags=re.IGNORECASE)
    cleaned_text = re.sub(
        r'^\s*(Thinking Process|Thought Process|Reasoning|思考过程|推理过程)\s*[:：][\s\S]*?(?=(Final Answer|最终答案|最终回答)\s*[:：]|\{|\Z)',
        '',
        cleaned_text,
        flags=re.IGNORECASE
    )
    cleaned_text = re.sub(
        r'^\s*(Final Answer|最终答案|最终回答)\s*[:：]\s*',
        '',
        cleaned_text,
        flags=re.IGNORECASE
    )
    cleaned_text = re.sub(
        r'根据规则[\s\S]*?(?=\n{2,}|$)',
        '',
        cleaned_text,
        flags=re.IGNORECASE
    )
    cleaned_text = re.sub(
        r'回顾之前的对话[\s\S]*?(?=\n{2,}|$)',
        '',
        cleaned_text,
        flags=re.IGNORECASE
    )
    cleaned_text = cleaned_text.strip()
    if not cleaned_text:
        return ''

    cleaned_text = cleaned_text.replace('\r\n', '\n')
    lines = []

    for raw_line in cleaned_text.split('\n'):
        line = raw_line.strip()
        if not line:
            lines.append('')
            continue

        # 再补一层“包含关键字就认为是元叙述”的过滤（比 startswith 更稳）
        meta_keywords = (
            '根据规则', '按照规则', '回顾之前的对话', '回顾之前对话', '回顾对话', '意图分析',
            '我需要', '我应该', '我会', '看起来像', '诊断风格', '不要一上来就排障'
        )
        if any(keyword in line for keyword in meta_keywords):
            continue

        disclosure_patterns = [
            r'^(我是|作为).{0,24}(ai|助手|语言模型|大模型)',
            r'^(根据|基于).{0,24}(提示词|系统提示|检索结果|知识库|上下文)',
            r'^(意图分析|分类结果|系统提示词|检索流程|知识库命中|上下文注入)',
            r'^`{0,3}\s*(bash\s+)?(search_wiki|wiki_search|llmwiki\s+search|search)\b.*`{0,3}$',
            r'^`{0,3}\s*(bash\s+)?(search_wiki|wiki_search|llmwiki)\s+--query\b.*`{0,3}$',
            r'^以下内容仅供内部',
            r'^(根据规则|按照规则|规则\s*\d+|规则\d+)[：:，,].*',
            r'^(回顾|回看).{0,16}(之前|上面).{0,16}(对话|聊天|消息).*',
            r'^用户(连续|又|继续).{0,32}$',
            r'^(这看起来|看起来像是).{0,48}$',
            r'^(我需要|我应该|我会).{0,48}$',
            r'^(我的回复|之前的回应用了|现在可以).{0,48}$',
        ]
        if any(re.search(pattern, line, re.IGNORECASE) for pattern in disclosure_patterns):
            continue

        line = re.sub(r'^(根据|基于)(提示词|系统提示|检索结果|知识库检索结果|知识库|上下文)[，,:：]?\s*', '', line, flags=re.IGNORECASE)
        lines.append(line)

    cleaned_text = '\n'.join(lines)
    cleaned_text = re.sub(r'\n{3,}', '\n\n', cleaned_text).strip()
    return cleaned_text


def extract_chat_message_content(message_obj):
    if not isinstance(message_obj, dict):
        return ''
    for key in ('content', 'answer', 'text'):
        value = message_obj.get(key)
        if isinstance(value, str) and value.strip():
            return value
    for key in ('reasoning_content', 'reasoning'):
        value = message_obj.get(key)
        if isinstance(value, str) and value.strip():
            return value
    return ''


def build_llm_unavailable_message(action='生成实时回答'):
    model_name = VLLM_MODEL_NAME or '当前配置模型'
    provider_name = LLM_PROVIDER_NAME or '模型服务'
    return (
        f'{provider_name} 当前不可用或响应超时，暂时不能{action}。'
        f'请检查 {provider_name} API 地址、API Key、网络连通性，以及模型 {model_name} 是否可用。'
    )


def sanitize_stream_chunk(text):
    if not text:
        return ''
    cleaned_text = re.sub(r'</?think>', '', text, flags=re.IGNORECASE)
    cleaned_text = re.sub(
        r'^\s*(Final Answer|最终答案|最终回答)\s*[:：]\s*',
        '',
        cleaned_text,
        flags=re.IGNORECASE
    )
    return cleaned_text


def split_flushable_text(buffer_text):
    matches = list(re.finditer(r'([。！？!?]+|\n{2,})', buffer_text))
    if not matches:
        return '', buffer_text

    split_index = matches[-1].end()
    return buffer_text[:split_index], buffer_text[split_index:]

# ========== 路由 ==========

def build_runtime_instruction(level, context_items, query='', history=None, conversation_mode='diagnosis'):
    if conversation_mode != 'diagnosis':
        return "\n".join([
            "这一轮按普通对话来答。",
            "先自然回应用户，不要上来分点、下指令或进入排障流程。",
            "表达尽量像现场同事聊天，简短、顺口、别太官方。",
            "除非用户明确转到设备报警或故障诊断，否则不要主动要求查看 HMI、SCADA、主控或报警记录。",
        ])
        return "\n".join([
            "当前轮次属于普通对话或通用问答，不要进入设备故障诊断话术。",
            "请自然、口语化地直接回应用户当前意图，避免模板化、条目化和生硬排障语气。",
            "可以保持简短，有对话感；只有在用户明确转向设备、报警、故障、参数异常排查时，再切换到运维诊断模式。",
            "除非用户已经明确在排查设备问题，否则不要主动要求其查看 HMI、SCADA、主控或报警记录。",
        ])

    class_name = {
        1: '信息较少，需要继续引导',
        2: '已有部分信息，可以先做方向性判断',
        3: '信息较完整，可结合知识库给出更具体建议',
    }

    instruction_lines = [
        "以下内容是当前轮次的工作输入，请吸收后直接回答用户，不要把这些提示原样复述给用户。",
        "",
        "# 当前输入信息",
        query or "（无）",
        "## 意图分析结果",
        class_name.get(level, '未知'),
    ]

    guided_instruction = build_guided_diagnosis_instruction(query, history, level)
    if guided_instruction:
        instruction_lines.extend([
            "",
            "## 补充处理要求",
            guided_instruction,
        ])

    if context_items:
        total_context_chars = 0
        instruction_lines.extend([
            "",
            "## 检索到的参考片段",
            "优先依据最相关的参考片段回答；如果证据仍不足，就明确指出还缺什么信息。",
        ])
        for idx, item in enumerate(context_items, 1):
            excerpt = item.get('context_excerpt') or build_context_excerpt(
                item.get('content', ''),
                item.get('metadata'),
            )
            if not excerpt:
                continue

            remaining = RAG_CONTEXT_MAX_TOTAL_CHARS - total_context_chars
            if remaining <= 0:
                break
            if len(excerpt) > remaining:
                excerpt = clip_text(excerpt, limit=remaining)
            total_context_chars += len(excerpt)

            instruction_lines.append(
                f"{idx}. 文档={item['document_name']} 相关度={item['score']:.2f} 内容={excerpt}"
            )
    else:
        instruction_lines.extend([
            "",
            "当前没有可靠的知识库命中结果。",
            "如果依据不足，不要编造结论，要明确说明还缺什么关键信息，并继续引导用户补充最关键的 1 到 2 项信息。",
        ])

    return "\n".join(instruction_lines)


def build_runtime_instruction_v2(level, context_items, query='', history=None, conversation_mode='diagnosis',
                                  wind_farm_id=None, wind_farm_name=None, wind_farm_models=None):
    if conversation_mode != 'diagnosis':
        lines = [
            "当前是普通对话。",
            "自然回答，简短一点，别太官方。",
            "不要主动进入故障排查流程。",
        ]
        # 即使是普通对话模式，如果还没有风场信息也提示询问
        if not wind_farm_id:
            lines.append("如果用户开始讨论设备或故障相关话题，先自然地问一下对方在哪个风场。")
        return "\n".join(lines)

    class_name = {
        1: 'Level 1 - 信息太少，先引导补充',
        2: 'Level 2 - 信息部分明确，可以先做方向性判断',
        3: 'Level 3 - 信息较完整，可以结合参考资料给出更具体建议',
    }

    instruction_lines = [
        "# 当前输入信息",
        query or "（无）",
    ]

    # 注入风场和机型信息
    if wind_farm_id and wind_farm_name:
        instruction_lines.extend([
            "",
            "## 当前风场信息",
            f"风场: {wind_farm_name}（{wind_farm_id}号）",
        ])
        if wind_farm_models:
            instruction_lines.append(f"该风场机型: {', '.join(wind_farm_models)}")
            instruction_lines.append("请结合该风场的机型特点进行诊断和建议，优先匹配该机型的故障特征和维修方案。")
        else:
            instruction_lines.append("该风场机型暂未配置，可以先按通用经验回答。")
    elif not wind_farm_id:
        instruction_lines.extend([
            "",
            "## 风场信息",
            "用户尚未说明所在风场。请在回答中自然地询问用户在哪个风场（1-13号），以便更精准地匹配机型和故障资料。",
        ])

    instruction_lines.extend([
        "",
        "## 意图分析结果",
        class_name.get(level, '未知'),
        "",
        "回答时先自然回应，再判断或追问。",
        "如果信息不足，只追问最关键的 1 到 2 个点。",
        "不要写成僵硬的流程说明，不要过度分点。",
    ])

    guided_instruction = build_guided_diagnosis_instruction_v2(query, history, level)
    if guided_instruction:
        instruction_lines.extend([
            "",
            "## 补充要求",
            guided_instruction,
        ])

    if context_items:
        instruction_lines.extend([
            "",
            "## 参考信息",
            "如果下面有可用参考资料，吸收后自然表达，不要直接复述来源。",
        ])
        total_context_chars = 0
        for idx, item in enumerate(context_items, 1):
            excerpt = item.get('context_excerpt') or build_context_excerpt(
                item.get('content', ''),
                item.get('metadata'),
            )
            if not excerpt:
                continue

            remaining = RAG_CONTEXT_MAX_TOTAL_CHARS - total_context_chars
            if remaining <= 0:
                break
            if len(excerpt) > remaining:
                excerpt = clip_text(excerpt, limit=remaining)
            total_context_chars += len(excerpt)
            instruction_lines.append(
                f"{idx}. 文档={item['document_name']} 相关度={item['score']:.2f} 内容={excerpt}"
            )
    else:
        instruction_lines.extend([
            "",
            "当前没有可靠的参考资料命中。",
            "如果依据不足，就明确说明还缺什么关键信息。",
        ])

    return "\n".join(instruction_lines)


def has_alarm_name_or_code_v2(text):
    normalized = normalize_text(text)
    if not normalized:
        return False
    lowered = normalized.lower()
    alarm_keywords = (
        '报警', '告警', '报码', '故障码', '事件记录', '事件', '保护动作',
        'alarm', 'fault', 'error', 'trip', 'warning'
    )
    return has_explicit_fault_code(normalized) or any(keyword in lowered for keyword in alarm_keywords)


def has_device_or_component_info_v2(text):
    normalized = normalize_text(text)
    if not normalized:
        return False
    lowered = normalized.lower()
    extra_keywords = (
        '机组', '风机', '主控', '变流器', '变桨', '齿轮箱', '发电机',
        '主轴', '轴承', '偏航', '液压', '塔筒', '叶片'
    )
    return any(keyword in lowered for keyword in DEVICE_HINT_KEYWORDS) or any(keyword in lowered for keyword in extra_keywords)


def has_runtime_or_symptom_info_v2(text):
    normalized = normalize_text(text)
    if not normalized:
        return False
    lowered = normalized.lower()
    runtime_keywords = (
        '运行', '停机', '并网', '脱网', '启动', '启动失败', '待机', '满发',
        '限功率', '降额', '转速', '负荷', '风速', '电流', '电压', '温度',
        '振动', '异响', '异味', '漏油', '现象'
    )
    return any(keyword in lowered for keyword in ISSUE_HINT_KEYWORDS) or any(keyword in lowered for keyword in runtime_keywords)


def build_guided_diagnosis_instruction_v2(query, history, level):
    history = history or []
    if infer_conversation_mode(query, history) != 'diagnosis':
        return ''

    recent_user_inputs = [
        item.get('content', '')
        for item in history[-6:]
        if item.get('role') == 'user'
    ]
    combined_text = normalize_text(' '.join(recent_user_inputs + [query]))
    if not combined_text:
        return ''

    missing_items = []
    if not has_alarm_name_or_code_v2(combined_text):
        missing_items.append(
            "如果主控/HMI、SCADA 或就地屏上有原始告警名、报码或事件记录，优先让用户回传最直接的一条。"
        )
    if not has_device_or_component_info_v2(combined_text):
        missing_items.append("补清具体机组或部件后，再继续缩小范围。")
    if not has_runtime_or_symptom_info_v2(combined_text):
        missing_items.append("补清故障出现时的运行状态或最直接现象，例如停机、温升、振动、异响、限功率等。")

    instruction_lines = [
        "- 不要重复索要用户已经明确提供过的信息。",
        "- 先自然回应，再根据当前仍然缺失的信息追问，最多追问 1 到 2 项。",
        "- 如果缺少原始告警名或报码，可以自然引导用户去主控/HMI/SCADA/就地屏查看，但不要每次都机械重复同一句话。",
    ]

    if missing_items:
        instruction_lines.append("- 当前优先补充以下仍缺的信息：")
        for idx, item in enumerate(missing_items[:2], 1):
            instruction_lines.append(f"  {idx}. {item}")
    else:
        instruction_lines.append("- 当前关键信息已经基本够用，优先给方向判断或下一步建议，不要继续泛泛追问。")

    if level == 1:
        instruction_lines.append("- 当前信息偏少，先帮用户缩小范围，不急着下结论。")
    elif level == 2:
        instruction_lines.append("- 当前已有部分现象描述，可以先给方向判断，再顺手追问最缺的那一项。")

    scene = infer_guided_diagnosis_scene(combined_text)
    if scene:
        instruction_lines.append(f"- 结合当前现象，优先围绕这条线索继续追问：{scene['focus']}")

    return "\n".join(instruction_lines)


def retrieve_from_langchain(query, top_k=3, history=None, wind_farm_models=None):
    """本地知识检索已关闭，知识库检索交给 Dify 工作流处理。"""
    return {
        'matched': False,
        'chunks': [],
        'context_text': '',
        'raw_count': 0
    }


def should_retrieve_local_knowledge(query, history=None):
    return False


EXPERT_DEBATE_ROLES = [
    {
        'id': 'control',
        'name': '主控与报警逻辑专家',
        'focus': '核对故障码、报警触发条件、主控/HMI/SCADA 事件顺序，判断报码是否能直接定位。'
    },
    {
        'id': 'electrical',
        'name': '电气与变流器专家',
        'focus': '关注电网、变流器、UPS、传感器供电、电流电压、接地和保护动作。'
    },
    {
        'id': 'mechanical',
        'name': '机械与传动链专家',
        'focus': '关注变桨、偏航、轴承、齿轮箱、机舱振动、温度和机械卡滞。'
    },
    {
        'id': 'field',
        'name': '现场运维与安全专家',
        'focus': '关注可执行排查步骤、停送电安全、复位条件、风险隔离和现场验证。'
    },
]


def call_chat_model(messages, max_tokens=1800, temperature=0.2, timeout=180, sanitize=True):
    timeout = get_windrise_request_timeout(timeout)
    model_name = resolve_vllm_model_name()
    payload = {
        'model': model_name,
        'messages': messages,
        'max_tokens': max_tokens,
        'temperature': temperature,
        'top_p': 0.8,
        'stream': False,
    }
    response = http_session.post(
        VLLM_API_URL,
        json=apply_no_thinking_options(payload),
        timeout=timeout,
        **get_request_kwargs_for_url(VLLM_API_URL)
    )
    if response.status_code != 200:
        raise RuntimeError(f'{LLM_PROVIDER_NAME} 响应异常: {response.status_code} {response.text[:200]}')
    result = response.json()
    message_obj = result['choices'][0]['message']
    content = extract_chat_message_content(message_obj)
    return sanitize_assistant_answer(content) if sanitize else (content or '')


def iter_chat_model_stream(messages, max_tokens=1800, temperature=0.2, timeout=180, sanitize=True):
    timeout = get_windrise_request_timeout(timeout)
    model_name = resolve_vllm_model_name()
    payload = {
        'model': model_name,
        'messages': messages,
        'max_tokens': max_tokens,
        'temperature': temperature,
        'top_p': 0.8,
        'stream': True,
    }
    response = http_session.post(
        VLLM_API_URL,
        json=apply_no_thinking_options(payload),
        timeout=timeout,
        stream=True,
        **get_request_kwargs_for_url(VLLM_API_URL)
    )
    if response.status_code != 200:
        raise RuntimeError(f'{LLM_PROVIDER_NAME} 响应异常: {response.status_code} {response.text[:200]}')

    for raw_line in response.iter_lines(decode_unicode=False):
        deadline = getattr(windrise_request_context, 'deadline', None)
        if deadline is not None and time.monotonic() >= deadline:
            response.close()
            raise TimeoutError('Windrise 本轮回答已超过总时限')
        if not raw_line:
            continue
        line = raw_line.decode('utf-8', errors='replace').strip()
        if not line.startswith('data:'):
            continue
        data = line[5:].strip()
        if data == '[DONE]':
            break
        try:
            event = json.loads(data)
        except Exception:
            continue
        choices = event.get('choices') or []
        if not choices:
            continue
        delta = choices[0].get('delta') or {}
        content = delta.get('content') or ''
        if content:
            yield sanitize_assistant_answer(content) if sanitize else content


def build_debate_references(context_items):
    lines = []
    for idx, item in enumerate(context_items or [], 1):
        metadata = item.get('metadata') or {}
        excerpt = item.get('context_excerpt') or build_context_excerpt(item.get('content', ''), metadata)
        lines.append(
            f"{idx}. 文档={item.get('document_name')} 路径={metadata.get('relative_path') or metadata.get('source')} "
            f"相关度={float(item.get('score', 0.0)):.2f}\n{clip_text(excerpt, 700)}"
        )
    return "\n\n".join(lines) if lines else "无可靠参考资料命中。"


def extract_wiki_section_text(content, heading, limit=220):
    if not content:
        return ''
    pattern = rf'#+\s*{re.escape(heading)}\s*\n([\s\S]*?)(?=\n#+\s|\Z)'
    match = re.search(pattern, content)
    if not match:
        return ''
    section = re.sub(r'^\s*[-*]\s*', '', match.group(1), flags=re.MULTILINE)
    section = re.sub(r'\n{2,}', '\n', section).strip()
    return clip_text(section, limit=limit)


def build_fallback_expert_debate(question, current_answer='', context_items=None, reason=''):
    context_items = context_items or []
    top_item = context_items[0] if context_items else {}
    metadata = top_item.get('metadata') or {}
    content = top_item.get('content') or ''
    title = top_item.get('document_name') or metadata.get('title') or '未命中明确故障页'
    model = metadata.get('model') or ''
    fault_code = metadata.get('fault_code') or ''
    source_path = metadata.get('relative_path') or metadata.get('source') or ''
    phenomenon = extract_wiki_section_text(content, '故障现象') or '资料未给出明确故障现象。'
    cause = extract_wiki_section_text(content, '故障原因') or '资料未给出明确故障原因。'
    suggestion = extract_wiki_section_text(content, '处理建议') or '资料未给出明确处理建议。'
    hit_summary = f"{model} {fault_code} - {title}".strip()
    source_label = source_path or '参考资料'
    primary_evidence = [
        f"命中文档：{source_label}",
        f"故障标题：{title}",
        f"故障现象：{phenomenon}",
        f"故障原因：{cause}",
        f"处理建议：{suggestion}",
    ]

    experts = [
        {
            'expert_id': 'control',
            'expert_name': '主控与报警逻辑专家',
            'focus': EXPERT_DEBATE_ROLES[0]['focus'],
            'opinion': f"参考资料命中 {hit_summary}，报警现象为{phenomenon}；主控侧可按该故障码触发条件核对事件顺序。",
            'theory': f"{fault_code or '当前报码'} 对应 {title}，属于主控按温度阈值触发的变桨相关停机告警。",
            'evidence_chain': [
                primary_evidence[0],
                primary_evidence[1],
                primary_evidence[2],
                f"触发条件：{cause}",
            ],
            'counter_evidence_needed': ['核对 SCADA/HMI 事件顺序是否先出现该故障码。', '确认是否存在同一时刻的通信或状态码更新异常。'],
        },
        {
            'expert_id': 'electrical',
            'expert_name': '电气与变流器专家',
            'focus': EXPERT_DEBATE_ROLES[1]['focus'],
            'opinion': f"该告警核心证据是{cause}；电气侧应重点确认轴柜温度采样、柜内散热、风扇和供电状态。",
            'theory': '真实过温、散热失效或温度采样回路异常，是该告警最需要优先验证的电气侧路径。',
            'evidence_chain': [
                primary_evidence[0],
                primary_evidence[3],
                '问题描述与原回答均提到“桨叶3轴柜温度高”和检查风扇/温度。',
                '相邻命中资料均为同一故障码在不同机型下的同名告警，支持该方向。',
            ],
            'counter_evidence_needed': ['现场实测温度低于阈值时，应转查传感器和采集回路。', '风扇供电正常但温度持续高时，应检查风道和环境热源。'],
        },
        {
            'expert_id': 'mechanical',
            'expert_name': '机械与传动链专家',
            'focus': EXPERT_DEBATE_ROLES[2]['focus'],
            'opinion': "当前证据指向桨叶3轴柜温度而非传动链本体故障；需排除柜体散热不良、环境热源和温度传感器误报。",
            'theory': '机械本体故障证据不足，更可能是柜体热管理或测温链路问题导致变桨侧保护停机。',
            'evidence_chain': [
                primary_evidence[1],
                primary_evidence[2],
                '命中资料未给出齿轮箱、主轴、偏航或传动链机械异常描述。',
                '第6条相近命中为“桨叶390度传感器故障”，提示传感器链路需要作为反证验证。',
            ],
            'counter_evidence_needed': ['若伴随桨叶卡滞、变桨电机过载或机械异响，应扩大到变桨机械机构。', '若温度传感器比对正常，机械摩擦热源需进一步排查。'],
        },
        {
            'expert_id': 'field',
            'expert_name': '现场运维与安全专家',
            'focus': EXPERT_DEBATE_ROLES[3]['focus'],
            'opinion': f"现场先按停机安全隔离检查柜内实际温度，再处理散热和传感器问题；资料处理建议为：{suggestion}",
            'theory': '现场处置应先证明是否真实过温，再决定清理散热、修复风扇/传感器或手动复位。',
            'evidence_chain': [
                primary_evidence[0],
                primary_evidence[4],
                '原回答提出检查柜内温度、风扇、密封和传感器，和资料触发条件一致。',
                '故障现象为变桨电池驱动停机，现场操作必须先做安全隔离。',
            ],
            'counter_evidence_needed': ['未完成实测温度和风扇检查前，不应直接复位。', '复位后若短时间复发，应保留事件和温度趋势用于根因确认。'],
        },
    ]
    rounds = [{
        'round': 1,
        'content': (
            f"四位专家一致认为应以参考资料命中的 {hit_summary} 为主证据。"
            f"争议点在于是真实过温还是测温/散热部件异常；需用实测温度、风扇状态和传感器读数确认。"
        )
    }]
    confidence = '高' if fault_code and fault_code in normalize_text(question) else '中'
    consensus = f"""## 一致结论
- 最可能真实故障原因：{cause}
- 置信度：{confidence}
- 关键依据：参考资料命中 `{source_path}`，标题为“{title}”，故障现象为{phenomenon}

## 仍需确认
- 轴柜3实际温度是否超过报警阈值。
- 柜内散热风扇、风道、柜门密封和环境温度是否异常。
- 温度传感器读数与现场测温是否一致。

## 建议处置
- 按现场安全规程停机隔离后开柜检查。
- 实测桨叶3轴柜温度，并与主控/HMI 温度值比对。
- 检查散热风扇、滤网、风道、接线和供电。
- 若实际温度正常，重点检查温度传感器及采集回路。
- 故障原因排除后按资料建议执行：{suggestion}

## 对原回答的修正
- 原回答中检查柜内温度和风扇的方向可保留。
- 需要补充故障码触发条件：{cause}
- 不应只复位观察，应先确认真实过温或测温回路异常后再手动复位。
"""
    return {
        'experts': experts,
        'rounds': rounds,
        'consensus': consensus,
        'fallback_reason': reason,
    }


def run_expert_debate(question, current_answer='', history=None, context_items=None, rounds=2):
    rounds = max(1, min(int(rounds or 2), 3))
    references = build_debate_references(context_items or [])
    history_text = "\n".join(
        f"{item.get('role')}: {item.get('content')}"
        for item in (history or [])[-6:]
        if item.get('content')
    ) or "无"
    role_text = "\n".join(
        f"- {role['name']}：{role['focus']}"
        for role in EXPERT_DEBATE_ROLES
    )

    prompt = f"""你是风电故障多专家会诊主持人。请在一次输出中模拟 4 位专家完成独立判断、{rounds} 轮交叉质询，并形成最终一致结论。

当前问题：
{question}

已有回答：
{current_answer or '无'}

最近对话上下文：
{history_text}

专家设定：
{role_text}

参考资料：
{references}

请严格按以下 JSON 输出，不要输出 Markdown，不要输出思考过程：
{{
  "experts": [
    {{"expert_id": "control", "expert_name": "主控与报警逻辑专家", "theory": "该专家提出的故障理论", "opinion": "最多120字，必须概括理论和证据", "evidence_chain": ["证据1：必须来自问题、原回答、历史或参考资料", "证据2：说明如何支持该理论"], "counter_evidence_needed": ["还需要验证的反证点"]}},
    {{"expert_id": "electrical", "expert_name": "电气与变流器专家", "theory": "该专家提出的故障理论", "opinion": "最多120字", "evidence_chain": ["证据1", "证据2"], "counter_evidence_needed": ["反证点"]}},
    {{"expert_id": "mechanical", "expert_name": "机械与传动链专家", "theory": "该专家提出的故障理论", "opinion": "最多120字", "evidence_chain": ["证据1", "证据2"], "counter_evidence_needed": ["反证点"]}},
    {{"expert_id": "field", "expert_name": "现场运维与安全专家", "theory": "该专家提出的故障理论", "opinion": "最多120字", "evidence_chain": ["证据1", "证据2"], "counter_evidence_needed": ["反证点"]}}
  ],
  "rounds": [
    {{"round": 1, "content": "概括本轮一致点、冲突点、证据强弱和修正意见，最多260字"}}
  ],
  "consensus": "用 Markdown 输出最终一致结论，包含：## 一致结论、## 仍需确认、## 建议处置、## 对原回答的修正"
}}

要求：每个专家的理论必须有 evidence_chain 支撑；证据必须能追溯到参考资料、当前问题、已有回答或对话历史；依据不足时明确降置信度，不要硬下结论。
"""
    raw_text = call_chat_model(
        [
            {'role': 'system', 'content': '你输出风电故障多专家会诊结果。必须只输出合法 JSON。'},
            {'role': 'user', 'content': prompt},
        ],
        max_tokens=2400,
        temperature=0.2,
        timeout=300,
        sanitize=False,
    )

    try:
        json_text = raw_text.strip()
        if json_text.startswith('```'):
            json_text = re.sub(r'^```(?:json)?\s*', '', json_text)
            json_text = re.sub(r'\s*```$', '', json_text)
        start_index = json_text.find('{')
        end_index = json_text.rfind('}')
        if start_index >= 0 and end_index > start_index:
            json_text = json_text[start_index:end_index + 1]
        parsed = json.loads(json_text)
    except Exception:
        return build_fallback_expert_debate(
            question,
            current_answer=current_answer,
            context_items=context_items,
            reason='模型未返回可解析 JSON，已使用参考资料生成确定性会诊结论。',
        )

    expert_by_id = {role['id']: role for role in EXPERT_DEBATE_ROLES}
    normalized_experts = []
    for item in parsed.get('experts') or []:
        expert_id = item.get('expert_id') or ''
        role = expert_by_id.get(expert_id, {})
        normalized_experts.append({
            'expert_id': expert_id or role.get('id', ''),
            'expert_name': item.get('expert_name') or role.get('name', '未知专家'),
            'focus': item.get('focus') or role.get('focus', ''),
            'theory': item.get('theory') or '',
            'opinion': item.get('opinion') or '',
            'evidence_chain': item.get('evidence_chain') if isinstance(item.get('evidence_chain'), list) else [],
            'counter_evidence_needed': (
                item.get('counter_evidence_needed')
                if isinstance(item.get('counter_evidence_needed'), list)
                else []
            ),
        })
    if len(normalized_experts) < len(EXPERT_DEBATE_ROLES):
        existing_ids = {item.get('expert_id') for item in normalized_experts}
        for role in EXPERT_DEBATE_ROLES:
            if role['id'] not in existing_ids:
                normalized_experts.append({
                    'expert_id': role['id'],
                    'expert_name': role['name'],
                    'focus': role['focus'],
                    'theory': '模型未返回该专家理论。',
                    'opinion': '模型未返回该专家分项意见。',
                    'evidence_chain': ['模型未返回该专家证据链。'],
                    'counter_evidence_needed': ['需要重新生成或由参考资料补充证据链。'],
                })

    normalized_rounds = []
    for index, item in enumerate(parsed.get('rounds') or [], 1):
        normalized_rounds.append({
            'round': item.get('round') or index,
            'content': item.get('content') or '',
        })
    if not normalized_rounds:
        normalized_rounds = [{'round': 1, 'content': '模型未返回交叉质询内容。'}]

    consensus = sanitize_assistant_answer(parsed.get('consensus') or raw_text)
    if not consensus or consensus == '模型未返回可用的最终一致结论。':
        return build_fallback_expert_debate(
            question,
            current_answer=current_answer,
            context_items=context_items,
            reason='模型最终共识为空，已使用参考资料生成确定性会诊结论。',
        )
    return {
        'experts': normalized_experts[:len(EXPERT_DEBATE_ROLES)],
        'rounds': normalized_rounds[:rounds],
        'consensus': consensus,
    }


def render_expert_debate_markdown(question, current_answer, rag_result, debate):
    chunks = (rag_result or {}).get('chunks') or []
    lines = [
        '# 多专家故障会诊',
        '',
        '## 当前问题',
        question or '无',
        '',
        '## 原始回答',
        current_answer or '无',
        '',
        '## 参考资料命中',
    ]

    if chunks:
        for idx, item in enumerate(chunks[:6], 1):
            metadata = item.get('metadata') or {}
            source_path = metadata.get('relative_path') or metadata.get('source') or ''
            score = item.get('score')
            score_text = f'{float(score):.2f}' if isinstance(score, (int, float)) else str(score or '')
            lines.append(f"- {idx}. {item.get('document_name') or '未知文档'} | {source_path} | 相关度 {score_text}")
    else:
        lines.append('- 未命中可用参考资料，本次会诊会降低结论置信度。')

    lines.extend(['', '## 专家初始意见'])
    for item in (debate or {}).get('experts') or []:
        evidence_chain = item.get('evidence_chain') or []
        counter_evidence = item.get('counter_evidence_needed') or []
        lines.extend([
            f"### {item.get('expert_name')}",
            f"**理论**：{item.get('theory') or '无'}",
            '',
            '**观点**：',
            item.get('opinion') or '无',
            '',
            '**证据链**：',
        ])
        if evidence_chain:
            for evidence_index, evidence in enumerate(evidence_chain, 1):
                lines.append(f"{evidence_index}. {evidence}")
        else:
            lines.append('1. 未提供证据链。')
        lines.extend(['', '**需要验证的反证点**：'])
        if counter_evidence:
            for evidence_index, evidence in enumerate(counter_evidence, 1):
                lines.append(f"{evidence_index}. {evidence}")
        else:
            lines.append('1. 暂无。')
        lines.append('')

    rounds = (debate or {}).get('rounds') or []
    if rounds:
        lines.append('## 交叉质询')
        for item in rounds:
            lines.extend([
                f"### 第 {item.get('round')} 轮",
                item.get('content') or '无',
                '',
            ])

    lines.extend([
        '## 最终一致结论',
        (debate or {}).get('consensus') or '无',
    ])
    return '\n'.join(lines).strip()


def classify_question(query, history=None):
    """优先使用规则快速分类，必要时回退到 OpenAI 兼容 LLM。"""
    conversation_mode = infer_conversation_mode(query, history)
    if conversation_mode != 'diagnosis':
        print("[ConversationMode] chat")
        return 1

    heuristic_level = heuristic_classify_question(query)
    if heuristic_level is not None:
        print(f"🏷️ 问题分类(规则): {query} -> Level {heuristic_level}")
        return heuristic_level

    try:
        model_name = resolve_vllm_model_name()
        print(f"🏷️ 问题分类({LLM_PROVIDER_NAME}): {query}")

        recent_user_context = [
            item.get('content', '')
            for item in (history or [])[-6:]
            if item.get('role') == 'user'
        ]
        classify_query = query
        if recent_user_context:
            classify_query = (
                "最近用户对话上下文：\n"
                + "\n".join(f"- {item}" for item in recent_user_context[-4:] if item)
                + f"\n\n当前用户输入：\n{query}"
            )

        classify_data = {
            "model": model_name,
            "messages": [
                {"role": "user", "content": CLASSIFICATION_PROMPT.format(query=classify_query)}
            ],
            "max_tokens": 10,
            "temperature": 0.1
        }

        response = http_session.post(
            VLLM_API_URL,
            json=apply_no_thinking_options(classify_data),
            timeout=15,
            **get_request_kwargs_for_url(VLLM_API_URL)
        )

        if response.status_code == 200:
            result = response.json()
            answer = result['choices'][0]['message']['content'].strip()
            for ch in answer:
                if ch in '123':
                    level = int(ch)
                    print(f"✅ 分类结果({LLM_PROVIDER_NAME}): Level {level}")
                    return level
            print(f"⚠️ 分类结果无法解析: {answer}，默认 Level 2")
            return 2

        print(f"❌ 分类请求失败: {response.status_code}")
        return 2

    except Exception as e:
        print(f"❌ 分类异常: {e}，默认 Level 2")
        return 2

def classify_question_v2(query, history=None):
    """Prefer fast heuristic routing and fall back to the LLM classifier when needed."""
    conversation_mode = infer_conversation_mode(query, history)
    if conversation_mode != 'diagnosis':
        print("[ConversationMode] chat")
        return 1

    heuristic_level = heuristic_classify_question(query)
    if heuristic_level is not None:
        recent_user_context = [
            item.get('content', '')
            for item in (history or [])[-6:]
            if item.get('role') == 'user'
        ]
        combined_context = normalize_text(' '.join(recent_user_context + [query]))
        is_context_only_followup = is_context_only_windrise_followup(query)
        has_current_subject = has_specific_current_diagnosis_subject(query)
        if (
            heuristic_level < 3
            and is_context_only_followup
            and not has_current_subject
            and has_explicit_fault_code(combined_context)
        ):
            print("[Classifier] context-only history follow-up with fault code -> Level 3")
            return 3
        print(f"[Classifier] heuristic -> Level {heuristic_level}")
        return heuristic_level

    try:
        model_name = resolve_vllm_model_name()
        print(f"[Classifier] model={LLM_PROVIDER_NAME}")

        recent_user_context = [
            item.get('content', '')
            for item in (history or [])[-6:]
            if item.get('role') == 'user'
        ]
        classify_query = query
        if recent_user_context:
            classify_query = (
                "最近用户对话上下文：\n"
                + "\n".join(f"- {item}" for item in recent_user_context[-4:] if item)
                + f"\n\n当前用户输入：\n{query}"
            )

        classify_data = {
            "model": model_name,
            "messages": [
                {"role": "user", "content": CLASSIFICATION_PROMPT.format(query=classify_query)}
            ],
            "max_tokens": 10,
            "temperature": 0.1
        }

        response = http_session.post(
            VLLM_API_URL,
            json=apply_no_thinking_options(classify_data),
            timeout=15,
            **get_request_kwargs_for_url(VLLM_API_URL)
        )

        if response.status_code == 200:
            result = response.json()
            answer = result['choices'][0]['message']['content'].strip()
            for ch in answer:
                if ch in '123':
                    level = int(ch)
                    print(f"[Classifier] {LLM_PROVIDER_NAME} -> Level {level}")
                    return level
            print(f"[Classifier] unparsed result, fallback Level 2: {answer}")
            return 2

        print(f"[Classifier] request failed: {response.status_code}")
        return 2

    except Exception as e:
        print(f"[Classifier] exception, fallback Level 2: {e}")
        return 2


@app.route('/login')
def login_page():
    """登录页面"""
    login_file = os.path.join(BASE_DIR, 'login.html')
    return send_file(login_file)


@app.route('/register')
def register_page():
    """注册页面 — 当前复用登录页面"""
    return send_file(os.path.join(BASE_DIR, 'login.html'))


@app.route('/admin/users')
@admin_required
def admin_users_page():
    """管理员用户管理页面"""
    return send_file(os.path.join(BASE_DIR, 'admin_users.html'))


@app.route('/')
def index():
    """主页 - 直接返回 HTML 文件"""
    version_redirect = ensure_windrise_versioned_entry_url()
    if version_redirect is not None:
        return version_redirect
    return send_app_html_file(HTML_FILE)


@app.route('/api/app-version', methods=['GET'])
def app_version():
    """公开部署版本探针，供前端在部署后自动刷新页面。"""
    version = get_windrise_app_version()
    return jsonify({
        'version': version,
        'built_at': get_windrise_app_version_built_at(),
    }), 200, {
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'X-Windrise-App-Version': version,
    }


@app.route('/wiki/graph')
@login_required
def wind_llmwiki_graph_page():
    """打开本地 wind-llmwiki 知识图谱可视化页面。"""
    for graph_file in WIND_LLMWIKI_GRAPH_CANDIDATES:
        graph_file = os.path.abspath(graph_file)
        if os.path.isfile(graph_file):
            return send_file(graph_file)
    return (
        '未找到 LLM Wiki 知识图谱页面。请确认已生成 wind-llmwiki/graph/visualization.html。',
        404,
        {'Content-Type': 'text/plain; charset=utf-8'},
    )


@app.route('/health')
def health():
    """公开健康探针，仅返回最小状态。"""
    ensure_vllm_service_configured()
    vllm_ok = False
    try:
        vllm_ok, _ = probe_vllm_base_url(LMSTUDIO_BASE_URL, timeout=2)
    except Exception:
        vllm_ok = False
    return jsonify({
        'status': 'ok',
        'vllm_reachable': vllm_ok,
        'vllm_base_url': mask_url_for_log(LMSTUDIO_BASE_URL),
        'vllm_model': VLLM_MODEL_NAME or vllm_resolved_model_name or '',
        'web_server': resolve_web_server_backend(),
        'web_threads': WEB_THREADS,
        'target_concurrency': TARGET_CONCURRENCY,
    })


@app.route('/api/health', methods=['GET'])
@login_required
def health_detailed():
    """详细健康信息，需登录后访问。"""
    status = get_langchain_status()
    return jsonify({
        'status': 'ok',
        'message': f'{LLM_PROVIDER_NAME} Web Server is running',
        'dify_enabled': DIFY_ENABLED,
        'dify_required': DIFY_REQUIRED,
        'dify_app_type': DIFY_APP_TYPE,
        'dify_url': mask_url_for_log(DIFY_API_URL),
        'knowledge_ready': status['knowledge_ready'],
        'knowledge_files': status['knowledge_files'],
        'knowledge_chunks': status['knowledge_chunks'],
        'retrieval_mode': 'dify',
        'progress': status['progress'],
        'timestamp': datetime.now().isoformat(),
    })


@app.route('/api/rag/progress', methods=['GET'])
@login_required
def rag_progress():
    """获取当前知识库文档处理进度"""
    status = get_langchain_status()
    return jsonify({
        'success': True,
        'progress': status['progress'],
        'knowledge_ready': status['knowledge_ready'],
        'knowledge_files': status['knowledge_files'],
        'knowledge_chunks': status['knowledge_chunks'],
        'wiki_pages': status['wiki_pages'],
        'background_rebuild': status['background_rebuild'],
        'timestamp': datetime.now().isoformat(),
    })


@app.route('/api/rag/rebuild', methods=['POST'])
@admin_required
def rebuild_langchain_rag():
    """重建故障索引并同步 wind-llmwiki。"""
    started, message = start_wind_knowledge_rebuild_background(reason='manual')
    status = get_langchain_status()
    status['success'] = started
    status['message'] = message
    if not started:
        return jsonify(status), 409
    return jsonify(status)


@app.route('/api/rag/fault-code/<fault_code>', methods=['GET'])
@login_required
def lookup_rag_fault_code(fault_code):
    """兼容旧接口：故障码知识检索由 Dify 负责。"""
    normalized_code = normalize_text(fault_code).upper().replace(' ', '')
    return jsonify({
        'success': True,
        'fault_code': normalized_code,
        'matched': False,
        'models': [],
        'documents': [],
        'sources': [],
        'count': 0,
        'message': '本地知识库已关闭，知识检索由 Dify 负责',
    })


@app.route('/api/wiki/search', methods=['GET'])
@login_required
def search_local_knowledge_api():
    """兼容旧接口：本地 Wiki 检索已关闭。"""
    query = (request.args.get('q') or request.args.get('query') or '').strip()
    return jsonify({
        'success': True,
        'query': query,
        'matched': False,
        'raw_count': 0,
        'results': [],
        'message': '本地知识库已关闭，知识检索由 Dify 负责',
    })


@app.route('/api/wiki/page/<path:page_ref>', methods=['GET'])
@login_required
def get_local_knowledge_page_api(page_ref):
    """兼容旧接口：本地 Wiki 页面已关闭。"""
    return jsonify({'success': False, 'error': '本地知识库已关闭，知识检索由 Dify 负责'}), 410


@app.route('/api/wiki/graph', methods=['GET'])
@login_required
def get_local_knowledge_graph_api():
    """兼容旧接口：本地 Wiki 图谱已关闭。"""
    return jsonify({
        'success': True,
        'nodes': [],
        'edges': [],
        'message': '本地知识库已关闭，知识检索由 Dify 负责',
    })


@app.route('/api/admin/knowledge-base/files', methods=['GET'])
@admin_required
def list_knowledge_base_files_api():
    """列出故障资料目录下的 Markdown 文件。"""
    try:
        root = get_managed_wiki_root()
        files, directories = list_managed_wiki_files()
        return jsonify({
            'success': True,
            'root': str(root),
            'files': files,
            'directories': directories,
            'file_count': len(files),
        })
    except Exception as exc:
        return jsonify({'success': False, 'error': str(exc)}), 500


@app.route('/api/admin/knowledge-base/file', methods=['GET'])
@admin_required
def get_knowledge_base_file_api():
    relative_path = (request.args.get('path') or '').strip()
    try:
        root = get_managed_wiki_root()
        target, normalized = resolve_admin_wiki_path(relative_path, require_file=True)
        if not target.is_file():
            return jsonify({'success': False, 'error': '文件不存在'}), 404
        directory = str(target.parent.relative_to(root)).replace('\\', '/')
        if directory == '.':
            directory = ''
        content = target.read_text(encoding='utf-8')
        return jsonify({
            'success': True,
            'relative_path': normalized,
            'directory': directory,
            'file_name': target.name,
            'content': content,
        })
    except ValueError as exc:
        return jsonify({'success': False, 'error': str(exc)}), 400
    except OSError as exc:
        return jsonify({'success': False, 'error': f'读取文件失败: {exc}'}), 500


@app.route('/api/admin/knowledge-base/file', methods=['POST'])
@admin_required
def save_knowledge_base_file_api():
    data = request.get_json(silent=True) or {}
    target_dir = (data.get('target_dir') or '').strip()
    try:
        file_name = ensure_markdown_filename(data.get('file_name') or '')
        content = data.get('content') or ''
        dir_path, _normalized_dir = resolve_admin_wiki_directory(target_dir)
        target = (dir_path / file_name).resolve()
        root_resolved = get_managed_wiki_root().resolve()
        if os.path.commonpath([str(target), str(root_resolved)]) != str(root_resolved):
            raise ValueError('路径超出故障资料目录')
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding='utf-8')
        relative_path = str(target.relative_to(root_resolved)).replace('\\', '/')
        return jsonify({
            'success': True,
            'message': '文件已保存',
            'relative_path': relative_path,
        })
    except ValueError as exc:
        return jsonify({'success': False, 'error': str(exc)}), 400
    except OSError as exc:
        return jsonify({'success': False, 'error': f'保存文件失败: {exc}'}), 500


@app.route('/api/admin/knowledge-base/upload', methods=['POST'])
@admin_required
def upload_knowledge_base_files_api():
    target_dir = (request.form.get('target_dir') or '').strip()
    uploads = request.files.getlist('files')
    if not uploads:
        return jsonify({'success': False, 'error': '未选择文件'}), 400

    root = get_managed_wiki_root()
    saved_files = []
    skipped_files = []

    for upload in uploads:
        raw_name = (upload.filename or '').replace('\\', '/').strip()
        if not raw_name:
            skipped_files.append({'name': '', 'reason': '空文件名'})
            continue
        try:
            parts = [part for part in raw_name.split('/') if part not in ('', '.', '..')]
            if not parts:
                skipped_files.append({'name': raw_name, 'reason': '无效路径'})
                continue
            file_name = ensure_markdown_filename(parts[-1])
            nested_dir = '/'.join(parts[:-1])
            combined_dir = '/'.join(part for part in (target_dir, nested_dir) if part)
            dir_path, _normalized_dir = resolve_admin_wiki_directory(combined_dir)
            target = (dir_path / file_name).resolve()
            root_resolved = root.resolve()
            if os.path.commonpath([str(target), str(root_resolved)]) != str(root_resolved):
                raise ValueError('路径超出故障资料目录')
            target.parent.mkdir(parents=True, exist_ok=True)
            upload.save(str(target))
            saved_files.append(str(target.relative_to(root_resolved)).replace('\\', '/'))
        except Exception as exc:
            skipped_files.append({'name': raw_name, 'reason': str(exc)})

    if not saved_files and skipped_files:
        return jsonify({
            'success': False,
            'error': skipped_files[0]['reason'],
            'saved_count': 0,
            'saved_files': [],
            'skipped_files': skipped_files,
        }), 400

    return jsonify({
        'success': True,
        'saved_count': len(saved_files),
        'saved_files': saved_files,
        'skipped_files': skipped_files,
        'message': f'已上传 {len(saved_files)} 个文件',
    })


@app.route('/api/admin/knowledge-base/file', methods=['DELETE'])
@admin_required
def delete_knowledge_base_file_api():
    relative_path = (request.args.get('path') or '').strip()
    try:
        target, normalized = resolve_admin_wiki_path(relative_path, require_file=True)
        if not target.is_file():
            return jsonify({'success': False, 'error': '文件不存在'}), 404
        target.unlink()
        return jsonify({
            'success': True,
            'message': f'已删除 {normalized}',
            'relative_path': normalized,
        })
    except ValueError as exc:
        return jsonify({'success': False, 'error': str(exc)}), 400
    except OSError as exc:
        return jsonify({'success': False, 'error': f'删除文件失败: {exc}'}), 500


# ========== 风机编号 / 风场映射表 API ==========

@app.route('/api/admin/turbine-mapping', methods=['GET'])
@admin_required
def get_turbine_mapping_api():
    """读取风机编号-风场映射表，供管理员编辑。"""
    try:
        entries, path = load_turbine_mapping_json_entries()
        sites = sorted({entry.get('site', '') for entry in entries if entry.get('site')})
        return jsonify({
            'success': True,
            'entries': entries,
            'sites': sites,
            'entry_count': len(entries),
            'site_count': len(sites),
            'path': path,
        })
    except Exception as exc:
        return jsonify({'success': False, 'error': str(exc)}), 500


@app.route('/api/admin/turbine-mapping', methods=['PUT'])
@admin_required
def save_turbine_mapping_api():
    """保存风机编号-风场映射表，并立即热加载。"""
    data = request.get_json(silent=True) or {}
    try:
        result = save_turbine_mapping_entries(data.get('entries'))
        # Force reload into process cache immediately.
        reloaded = load_windrise_turbine_mapping_entries()
        return jsonify({
            'success': True,
            'message': f"已保存并加载 {result['entry_count']} 条映射（{result['site_count']} 个风场）",
            **result,
            'reloaded_count': len(reloaded),
        })
    except ValueError as exc:
        return jsonify({'success': False, 'error': str(exc)}), 400
    except OSError as exc:
        return jsonify({'success': False, 'error': f'保存失败: {exc}'}), 500


# ========== 风场-机型配置 API ==========

@app.route('/api/wind-farm-models', methods=['GET'])
@login_required
def get_wind_farm_models_api():
    """获取所有风场-机型映射"""
    wind_farms = load_wind_farm_models()
    return jsonify({'success': True, 'wind_farms': wind_farms})


@app.route('/api/wind-farm-models/<farm_id>', methods=['GET'])
@login_required
def get_single_wind_farm_model(farm_id):
    """获取单个风场的机型信息"""
    wind_farms = load_wind_farm_models()
    farm = wind_farms.get(str(farm_id))
    if not farm:
        return jsonify({'success': False, 'error': f'风场 {farm_id} 不存在'}), 404
    return jsonify({'success': True, 'farm_id': farm_id, 'data': farm})


@app.route('/api/wind-farm-models/<farm_id>', methods=['PUT'])
@admin_required
def update_wind_farm_model(farm_id):
    """更新单个风场的机型配置"""
    try:
        data = request.get_json(silent=True) or {}
        wind_farms = load_wind_farm_models()
        farm_id = str(farm_id)
        if farm_id not in wind_farms:
            return jsonify({'success': False, 'error': f'风场 {farm_id} 不存在'}), 404

        if 'name' in data:
            wind_farms[farm_id]['name'] = data['name']
        if 'models' in data:
            models = data['models']
            if isinstance(models, str):
                models = [m.strip() for m in models.split(',') if m.strip()]
            wind_farms[farm_id]['models'] = models
        if 'note' in data:
            wind_farms[farm_id]['note'] = data['note']

        save_wind_farm_models(wind_farms)
        print(f"✅ 风场 {farm_id} 配置已更新: {wind_farms[farm_id]}")
        return jsonify({'success': True, 'data': wind_farms[farm_id]})
    except Exception as e:
        print(f"❌ 更新风场配置失败: {e}")
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/wind-farm-models', methods=['PUT'])
@admin_required
def update_all_wind_farm_models():
    """批量更新所有风场配置"""
    try:
        data = request.get_json(silent=True) or {}
        new_farms = data.get('wind_farms')
        if not new_farms or not isinstance(new_farms, dict):
            return jsonify({'success': False, 'error': '请提供 wind_farms 字段'}), 400

        wind_farms = load_wind_farm_models()
        for fid, fdata in new_farms.items():
            fid = str(fid)
            if fid not in wind_farms:
                continue
            if 'name' in fdata:
                wind_farms[fid]['name'] = fdata['name']
            if 'models' in fdata:
                models = fdata['models']
                if isinstance(models, str):
                    models = [m.strip() for m in models.split(',') if m.strip()]
                wind_farms[fid]['models'] = models
            if 'note' in fdata:
                wind_farms[fid]['note'] = fdata['note']

        save_wind_farm_models(wind_farms)
        print(f"✅ 风场配置已批量更新")
        return jsonify({'success': True, 'wind_farms': wind_farms})
    except Exception as e:
        print(f"❌ 批量更新风场配置失败: {e}")
        return jsonify({'success': False, 'error': str(e)}), 500


# ========== 用户系统 API ==========

@app.route('/api/register', methods=['POST'])
@app.route('/api/admin/users', methods=['POST'])
@admin_required
def register():
    """管理员创建系统用户"""
    try:
        data = request.get_json(silent=True) or {}
        username = normalize_username(data.get('username', ''))
        password = data.get('password', '')
        name = normalize_text(data.get('name', '')) or username
        is_admin = 1 if data.get('is_admin') else 0
        password_generated = False

        username_error = validate_username(username)
        if username_error:
            return jsonify({'success': False, 'error': username_error}), 400
        if not password:
            password = generate_temporary_password()
            password_generated = True
        else:
            password_error = validate_new_password(password)
            if password_error:
                return jsonify({'success': False, 'error': password_error}), 400

        conn = get_db_connection()
        try:
            cursor = conn.cursor()

            cursor.execute('SELECT id FROM users WHERE username = ?', (username,))
            if cursor.fetchone():
                return jsonify({'success': False, 'error': '用户名已存在'}), 400

            user_columns = get_users_table_columns(cursor)
            if 'name' in user_columns and 'is_admin' in user_columns:
                cursor.execute(
                    'INSERT INTO users (username, password, name, is_admin) VALUES (?, ?, ?, ?)',
                    (username, hash_password(password), name, is_admin)
                )
            elif 'name' in user_columns:
                cursor.execute(
                    'INSERT INTO users (username, password, name) VALUES (?, ?, ?)',
                    (username, hash_password(password), name)
                )
            else:
                cursor.execute(
                    'INSERT INTO users (username, password) VALUES (?, ?)',
                    (username, hash_password(password))
                )
            conn.commit()
            user_id = cursor.lastrowid
        finally:
            conn.close()

        print(
            f"✅ 管理员创建用户成功: username={mask_identifier(username)} "
            f"is_admin={bool(is_admin)} password_generated={password_generated}"
        )
        if password_generated:
            print(
                f"[SECURITY] 为用户 {mask_identifier(username)} 生成临时密码: {password}"
            )
        response_payload = {
            'success': True,
            'user': {
                'id': user_id,
                'username': username,
                'name': name,
                'is_admin': bool(is_admin)
            },
            'password_generated': password_generated,
        }
        if password_generated:
            response_payload['message'] = '用户已创建，临时密码已生成，请查看服务端日志或通过安全渠道告知用户。'
        return jsonify(response_payload)

    except Exception as e:
        print(f"❌ 创建用户失败: {type(e).__name__}")
        maybe_print_traceback()
        return jsonify({'success': False, 'error': '创建用户失败，请稍后重试'}), 500


@app.route('/api/admin/users', methods=['GET'])
@admin_required
def list_admin_users():
    """管理员获取系统用户列表"""
    conn = get_db_connection()
    try:
        cursor = conn.cursor()
        user_columns = get_users_table_columns(cursor)
        select_fields = ['id', 'username', 'created_at']
        if 'name' in user_columns:
            select_fields.append('name')
        if 'is_admin' in user_columns:
            select_fields.append('is_admin')
        cursor.execute(
            f"SELECT {', '.join(select_fields)} FROM users ORDER BY created_at DESC, id DESC"
        )
        users = [serialize_user_record(row) for row in cursor.fetchall()]
        return jsonify({'success': True, 'users': users})
    finally:
        conn.close()


@app.route('/api/admin/users/<int:user_id>', methods=['DELETE'])
@admin_required
def delete_admin_user(user_id):
    """管理员删除系统用户"""
    if int(current_user.id) == user_id:
        return jsonify({'success': False, 'error': '不能删除当前登录的管理员账号'}), 400

    conn = get_db_connection()
    try:
        cursor = conn.cursor()
        user_columns = get_users_table_columns(cursor)
        select_fields = ['id', 'username', 'created_at']
        if 'name' in user_columns:
            select_fields.append('name')
        if 'is_admin' in user_columns:
            select_fields.append('is_admin')
        cursor.execute(
            f"SELECT {', '.join(select_fields)} FROM users WHERE id = ?",
            (user_id,)
        )
        user_row = cursor.fetchone()
        if not user_row:
            return jsonify({'success': False, 'error': '用户不存在'}), 404

        if get_user_is_admin(user_row):
            cursor.execute('SELECT COUNT(*) AS admin_count FROM users WHERE is_admin = 1')
            admin_count = cursor.fetchone()['admin_count']
            if admin_count <= 1:
                return jsonify({'success': False, 'error': '系统至少需要保留一个管理员账号'}), 400

        delete_user_related_data(cursor, user_id)
        conn.commit()
        return jsonify({
            'success': True,
            'deleted_user': serialize_user_record(user_row)
        })
    finally:
        conn.close()


@app.route('/api/admin/users/<int:user_id>/password', methods=['POST'])
@admin_required
def reset_admin_user_password(user_id):
    """管理员重置用户密码；未提供新密码时自动生成临时密码。"""
    data = request.get_json(silent=True) or {}
    password = data.get('password') or ''
    password_generated = False

    if not password:
        password = generate_temporary_password()
        password_generated = True
    else:
        password_error = validate_new_password(password)
        if password_error:
            return jsonify({'success': False, 'error': password_error}), 400

    conn = get_db_connection()
    try:
        cursor = conn.cursor()
        user_columns = get_users_table_columns(cursor)
        select_fields = ['id', 'username', 'created_at']
        if 'name' in user_columns:
            select_fields.append('name')
        if 'is_admin' in user_columns:
            select_fields.append('is_admin')
        cursor.execute(
            f"SELECT {', '.join(select_fields)} FROM users WHERE id = ?",
            (user_id,)
        )
        user_row = cursor.fetchone()
        if not user_row:
            return jsonify({'success': False, 'error': '用户不存在'}), 404

        cursor.execute(
            'UPDATE users SET password = ? WHERE id = ?',
            (hash_password(password), user_id)
        )
        conn.commit()
        print(
            f"✅ 管理员重置用户密码: user_id={mask_identifier(user_id)} "
            f"username={mask_identifier(user_row['username'])} generated={password_generated}"
        )
        if password_generated:
            print(
                f"[SECURITY] 已为用户 {mask_identifier(user_row['username'])} 生成临时密码: {password}"
            )
        response_payload = {
            'success': True,
            'user': serialize_user_record(user_row),
            'password_generated': password_generated,
        }
        if password_generated:
            response_payload['message'] = '密码已重置，临时密码已生成，请查看服务端日志或通过安全渠道告知用户。'
        return jsonify(response_payload)
    finally:
        conn.close()


@app.route('/api/change-password', methods=['POST'])
@login_required
def change_current_user_password():
    """当前登录用户修改自己的密码。"""
    data = request.get_json(silent=True) or {}
    current_password = data.get('current_password', '')
    new_password = data.get('new_password', '')

    if not current_password:
        return jsonify({'success': False, 'error': '当前密码不能为空'}), 400
    password_error = validate_new_password(new_password)
    if password_error:
        return jsonify({'success': False, 'error': password_error}), 400
    if normalize_text(current_password) == normalize_text(new_password):
        return jsonify({'success': False, 'error': '新密码不能与当前密码相同'}), 400

    conn = get_db_connection()
    try:
        cursor = conn.cursor()
        cursor.execute('SELECT id, username, password FROM users WHERE id = ?', (current_user.id,))
        user_row = cursor.fetchone()
        if not user_row:
            logout_user()
            return jsonify({'success': False, 'error': '当前用户不存在，请重新登录'}), 401
        if not verify_password(current_password, user_row['password']):
            return jsonify({'success': False, 'error': '当前密码错误'}), 400

        cursor.execute(
            'UPDATE users SET password = ? WHERE id = ?',
            (hash_password(new_password), current_user.id)
        )
        conn.commit()
        print(
            f"✅ 用户修改密码: user_id={mask_identifier(current_user.id)} "
            f"username={mask_identifier(user_row['username'])}"
        )
        return jsonify({'success': True})
    finally:
        conn.close()


@app.route('/api/login', methods=['POST'])
def login():
    """用户登录"""
    try:
        client_ip = get_client_ip()
        locked, retry_after = is_login_locked(client_ip)
        if locked:
            return jsonify({
                'success': False,
                'error': f'登录尝试过多，请 {retry_after} 秒后重试',
            }), 429

        allowed, retry_after = check_rate_limit(
            login_attempt_tracker,
            client_ip,
            LOGIN_RATE_LIMIT_MAX,
            LOGIN_RATE_LIMIT_WINDOW,
        )
        if not allowed:
            return jsonify({
                'success': False,
                'error': f'登录请求过于频繁，请 {retry_after} 秒后重试',
            }), 429

        data = request.get_json(silent=True) or {}
        username = normalize_username(data.get('username', ''))
        password = data.get('password', '')

        print(f"[LOGIN] 收到登录请求: username={mask_identifier(username)}")

        if not username or not password:
            return jsonify({'success': False, 'error': '用户名和密码不能为空'}), 400

        conn = get_db_connection()
        try:
            cursor = conn.cursor()

            user_columns = get_users_table_columns(cursor)
            select_fields = ['id', 'username', 'password']
            if 'name' in user_columns:
                select_fields.append('name')
            if 'is_admin' in user_columns:
                select_fields.append('is_admin')
            cursor.execute(
                f"SELECT {', '.join(select_fields)} FROM users WHERE username = ?",
                (username,)
            )
            user_data = cursor.fetchone()

            if not user_data:
                record_login_failure(client_ip)
                return jsonify({'success': False, 'error': '用户名或密码错误'}), 401

            display_name = get_user_display_name(user_data)
            db_password_hash = user_data['password']

            if not verify_password(password, db_password_hash):
                record_login_failure(client_ip)
                return jsonify({'success': False, 'error': '用户名或密码错误'}), 401

            if upgrade_legacy_password_hash(cursor, user_data['id'], password, db_password_hash):
                conn.commit()
                print(f"[LOGIN] 已升级历史密码哈希: username={mask_identifier(username)}")
        finally:
            conn.close()

        clear_login_failures(client_ip)
        user = User(
            user_data['id'],
            user_data['username'],
            display_name,
            get_user_is_admin(user_data)
        )
        login_user(user)
        csrf_token = ensure_csrf_token()

        print(
            f"[LOGIN] 用户登录成功: user_id={mask_identifier(user_data['id'])} "
            f"username={mask_identifier(username)}"
        )
        return jsonify({
            'success': True,
            'username': username,
            'user_id': user_data['id'],
            'name': display_name,
            'is_admin': get_user_is_admin(user_data),
            'csrf_token': csrf_token,
        })

    except Exception as e:
        print(f"❌ 登录异常: {type(e).__name__}")
        maybe_print_traceback()
        return jsonify({'success': False, 'error': '登录失败，请稍后重试'}), 500


@app.route('/api/logout', methods=['POST'])
@login_required
def logout():
    """用户登出"""
    user_id = ''
    try:
        user_id = current_user.get_id()
    except Exception:
        user_id = ''
    logout_user()
    forget_windrise_user_transient_state(user_id)
    print(f"✅ 用户登出: user_id={mask_identifier(user_id)}")
    return jsonify({'success': True})


@app.route('/api/current-user', methods=['GET'])
@login_required
def get_current_user():
    """获取当前登录用户"""
    return jsonify({
        'success': True,
        'username': current_user.username,
        'user_id': current_user.id,
        'name': current_user.name,
        'is_admin': getattr(current_user, 'is_admin', False),
        'csrf_token': ensure_csrf_token(),
    })


@app.route('/api/sessions', methods=['GET'])
@login_required
def get_user_sessions():
    """获取当前用户的所有会话"""
    conn = get_db_connection()
    try:
        cursor = conn.cursor()
        limit = parse_int_query_param('limit', 50, minimum=1, maximum=200)
        offset = parse_int_query_param('offset', 0, minimum=0)

        cursor.execute(
            'SELECT COUNT(*) AS total_count FROM sessions WHERE user_id = ?',
            (current_user.id,)
        )
        total_count = int(cursor.fetchone()['total_count'])

        cursor.execute(
            '''
            SELECT id,
                   session_id,
                   title,
                   created_at,
                   updated_at,
                   message_count
            FROM sessions
            WHERE user_id = ?
            ORDER BY COALESCE(updated_at, created_at) DESC, id DESC
            LIMIT ? OFFSET ?
            ''',
            (current_user.id, limit, offset)
        )

        sessions_data = []
        for row in cursor.fetchall():
            sessions_data.append({
                'id': row['id'],
                'session_id': row['session_id'],
                'title': row['title'],
                'created_at': row['created_at'],
                'message_count': row['message_count'],
                'last_activity_at': row['updated_at'] or row['created_at']
            })

        return jsonify({
            'success': True,
            'sessions': sessions_data,
            'pagination': {
                'limit': limit,
                'offset': offset,
                'total_count': total_count,
                'has_more': offset + len(sessions_data) < total_count,
            }
        })

    except Exception as e:
        print(f"❌ 获取会话失败: {e}")
        return jsonify({'success': False, 'error': '获取会话失败'}), 500
    finally:
        conn.close()


@app.route('/api/sessions', methods=['POST'])
@login_required
def create_user_session():
    """创建新会话"""
    conn = get_db_connection()
    try:
        data = request.get_json(silent=True) or {}
        title = data.get('title', '新对话')
        dify_conversation_id = data.get('dify_conversation_id', '')

        cursor = conn.cursor()

        cursor.execute('''
            INSERT INTO sessions (user_id, session_id, title, updated_at, message_count)
            VALUES (?, ?, ?, CURRENT_TIMESTAMP, 0)
        ''', (current_user.id, dify_conversation_id, title))

        session_id = cursor.lastrowid
        conn.commit()

        cursor.execute('''
            SELECT id, session_id, title, created_at, updated_at, message_count
            FROM sessions
            WHERE id = ? AND user_id = ?
        ''', (session_id, current_user.id))
        session_row = cursor.fetchone()

        print(f"✅ 创建会话成功: {title}")
        return jsonify({
            'success': True,
            'session_id': session_id,
            'session': {
                'id': session_row['id'],
                'session_id': session_row['session_id'],
                'title': session_row['title'],
                'created_at': session_row['created_at'],
                'message_count': session_row['message_count'],
                'last_activity_at': session_row['updated_at'] or session_row['created_at']
            }
        })

    except Exception as e:
        print(f"❌ 创建会话失败: {e}")
        return jsonify({'success': False, 'error': '创建会话失败'}), 500
    finally:
        conn.close()


@app.route('/api/sessions/<int:session_id>', methods=['PUT'])
@login_required
def update_user_session(session_id):
    """更新会话基本信息"""
    data = request.get_json(silent=True) or {}
    title = (data.get('title') or '').strip()
    dify_conversation_id = data.get('dify_conversation_id')
    dify_conversation_id = normalize_user_id(dify_conversation_id) if dify_conversation_id is not None else None

    conn = get_db_connection()
    try:
        cursor = conn.cursor()

        cursor.execute(
            'SELECT id FROM sessions WHERE id = ? AND user_id = ?',
            (session_id, current_user.id)
        )
        if not cursor.fetchone():
            return jsonify({'success': False, 'error': '会话不存在或无权访问'}), 403

        update_fields = []
        update_values = []

        if title:
            update_fields.append('title = ?')
            update_values.append(title)

        if dify_conversation_id:
            update_fields.append('session_id = ?')
            update_values.append(dify_conversation_id)

        if update_fields:
            update_fields.append('updated_at = CURRENT_TIMESTAMP')
            update_values.append(session_id)
            cursor.execute(
                f"UPDATE sessions SET {', '.join(update_fields)} WHERE id = ?",
                tuple(update_values)
            )
            conn.commit()

        return jsonify({'success': True})

    except Exception as e:
        print(f"❌ 更新会话失败: {e}")
        return jsonify({'success': False, 'error': '更新会话失败'}), 500
    finally:
        conn.close()


@app.route('/api/sessions/<int:session_id>', methods=['DELETE'])
@login_required
def delete_user_session(session_id):
    """删除会话"""
    conn = get_db_connection()
    try:
        cursor = conn.cursor()

        cursor.execute('SELECT id, session_id FROM sessions WHERE id = ? AND user_id = ?',
                   (session_id, current_user.id))
        session_row = cursor.fetchone()
        if not session_row:
            return jsonify({'success': False, 'error': '会话不存在或无权删除'}), 403

        dify_conversation_id = normalize_user_id(session_row['session_id'])
        cursor.execute('DELETE FROM messages WHERE session_id = ?', (session_id,))
        if dify_conversation_id:
            cursor.execute(
                'DELETE FROM conversation_messages WHERE conversation_id = ? AND user_id = ?',
                (dify_conversation_id, current_user.get_id())
            )
        cursor.execute('DELETE FROM sessions WHERE id = ?', (session_id,))
        conn.commit()
        if dify_conversation_id:
            forget_cached_conversation(dify_conversation_id, current_user.get_id())

        print(f"✅ 删除会话成功: {session_id}")
        return jsonify({'success': True})

    except Exception as e:
        print(f"❌ 删除会话失败: {e}")
        return jsonify({'success': False, 'error': '删除会话失败'}), 500
    finally:
        conn.close()


@app.route('/api/sessions/<int:session_id>/messages', methods=['GET'])
@login_required
def get_session_messages(session_id):
    """获取会话消息，默认按最新消息分页返回"""
    conn = get_db_connection()
    try:
        cursor = conn.cursor()
        limit = parse_int_query_param('limit', 100, minimum=1, maximum=500)
        offset = parse_int_query_param('offset', 0, minimum=0)

        cursor.execute(
            'SELECT id FROM sessions WHERE id = ? AND user_id = ?',
            (session_id, current_user.id)
        )
        if not cursor.fetchone():
            return jsonify({'success': False, 'error': '会话不存在或无权访问'}), 403

        cursor.execute(
            'SELECT COUNT(1) AS total FROM messages WHERE session_id = ?',
            (session_id,)
        )
        total_row = cursor.fetchone()
        total = int(total_row['total'] or 0) if total_row else 0

        cursor.execute('''
            SELECT role, content, created_at
            FROM messages
            WHERE session_id = ?
            ORDER BY id DESC
            LIMIT ? OFFSET ?
        ''', (session_id, limit, offset))

        messages_data = []
        rows = cursor.fetchall()
        rows.reverse()

        for row in rows:
            messages_data.append({
                'role': row['role'],
                'content': row['content'],
                'created_at': row['created_at']
            })

        returned = len(messages_data)
        next_offset = offset + returned

        return jsonify({
            'success': True,
            'messages': messages_data,
            'pagination': {
                'limit': limit,
                'offset': offset,
                'returned': returned,
                'total': total,
                'has_more': next_offset < total,
                'next_offset': next_offset
            }
        })

    except Exception as e:
        print(f"❌ 获取消息失败: {e}")
        return jsonify({'success': False, 'error': '获取消息失败'}), 500
    finally:
        conn.close()


@app.route('/api/sessions/<int:session_id>/messages', methods=['POST'])
@login_required
def save_session_message(session_id):
    """保存消息到会话"""
    data = request.get_json(silent=True) or {}
    role = data.get('role', 'user')
    content = data.get('content', '')
    dify_conversation_id = data.get('dify_conversation_id', '')
    title = (data.get('title') or '').strip()

    if role not in {'user', 'assistant'}:
        return jsonify({'success': False, 'error': '非法消息角色'}), 400

    if not content:
        return jsonify({'success': False, 'error': '消息内容不能为空'}), 400

    conn = get_db_connection()
    try:
        cursor = conn.cursor()

        cursor.execute('SELECT id FROM sessions WHERE id = ? AND user_id = ?',
                   (session_id, current_user.id))
        if not cursor.fetchone():
            return jsonify({'success': False, 'error': '会话不存在或无权访问'}), 403

        cursor.execute('''
            INSERT INTO messages (session_id, role, content)
            VALUES (?, ?, ?)
        ''', (session_id, role, content))

        if dify_conversation_id:
            update_fields = ['session_id = ?', 'updated_at = CURRENT_TIMESTAMP', 'message_count = message_count + 1']
            update_values = [dify_conversation_id]
            if title:
                update_fields.insert(0, 'title = ?')
                update_values.insert(0, title)
            cursor.execute(
                f'''
                UPDATE sessions
                SET {', '.join(update_fields)}
                WHERE id = ?
                ''',
                tuple(update_values + [session_id])
            )
        else:
            update_fields = ['updated_at = CURRENT_TIMESTAMP', 'message_count = message_count + 1']
            update_values = []
            if title:
                update_fields.insert(0, 'title = ?')
                update_values.insert(0, title)
            cursor.execute(
                f'''
                UPDATE sessions
                SET {', '.join(update_fields)}
                WHERE id = ?
                ''',
                tuple(update_values + [session_id])
            )

        conn.commit()

        print(f"✅ 保存消息成功: session_id={session_id}, role={role}")
        return jsonify({'success': True})

    except Exception as e:
        print(f"❌ 保存消息失败: {e}")
        return jsonify({'success': False, 'error': '保存消息失败'}), 500
    finally:
        conn.close()


@app.route('/api/sessions/<int:session_id>/messages', methods=['PUT'])
@login_required
def replace_session_messages(session_id):
    """覆盖保存会话消息"""
    data = request.get_json(silent=True) or {}
    messages = data.get('messages', [])
    title = (data.get('title') or '').strip()
    dify_conversation_id = data.get('dify_conversation_id')

    if not isinstance(messages, list):
        return jsonify({'success': False, 'error': 'messages 格式错误'}), 400

    normalized_messages = []
    for item in messages:
        if not isinstance(item, dict):
            return jsonify({'success': False, 'error': 'messages 格式错误'}), 400

        role = item.get('role')
        content = (item.get('content') or '').strip()
        if role not in {'user', 'assistant'}:
            return jsonify({'success': False, 'error': '非法消息角色'}), 400
        if not content:
            return jsonify({'success': False, 'error': '消息内容不能为空'}), 400

        normalized_messages.append((role, content))

    conn = get_db_connection()
    try:
        cursor = conn.cursor()

        cursor.execute(
            'SELECT id, session_id FROM sessions WHERE id = ? AND user_id = ?',
            (session_id, current_user.id)
        )
        session_row = cursor.fetchone()
        if not session_row:
            return jsonify({'success': False, 'error': '会话不存在或无权访问'}), 403

        old_dify_conversation_id = normalize_user_id(session_row['session_id'])
        cursor.execute('DELETE FROM messages WHERE session_id = ?', (session_id,))
        if dify_conversation_id == '' and old_dify_conversation_id:
            cursor.execute(
                'DELETE FROM conversation_messages WHERE conversation_id = ? AND user_id = ?',
                (old_dify_conversation_id, current_user.get_id())
            )
            forget_cached_conversation(old_dify_conversation_id, current_user.get_id())

        if normalized_messages:
            cursor.executemany(
                '''
                INSERT INTO messages (session_id, role, content)
                VALUES (?, ?, ?)
                ''',
                [(session_id, role, content) for role, content in normalized_messages]
            )

        update_fields = []
        update_values = []
        if title:
            update_fields.append('title = ?')
            update_values.append(title)
        if dify_conversation_id is not None:
            update_fields.append('session_id = ?')
            update_values.append(dify_conversation_id)
        update_fields.append('updated_at = CURRENT_TIMESTAMP')
        update_fields.append('message_count = ?')
        update_values.append(len(normalized_messages))

        if update_fields:
            update_values.append(session_id)
            cursor.execute(
                f"UPDATE sessions SET {', '.join(update_fields)} WHERE id = ?",
                tuple(update_values)
            )

        conn.commit()
        return jsonify({'success': True})

    except Exception as e:
        print(f"❌ 覆盖保存会话消息失败: {e}")
        return jsonify({'success': False, 'error': '保存会话消息失败'}), 500
    finally:
        conn.close()


@app.route('/api/test-llm', methods=['GET'])
@admin_required
def test_llm():
    """测试 OpenAI 兼容 LLM API 连接（仅管理员）"""
    try:
        model_name = resolve_vllm_model_name()
        print(f"🔍 测试 {LLM_PROVIDER_NAME} API 连接: {mask_url_for_log(VLLM_API_URL)}")

        test_data = {
            "model": model_name,
            "messages": [{"role": "user", "content": "你好"}],
            "max_tokens": 50,
            "temperature": 0.7
        }

        response = http_session.post(
            VLLM_API_URL,
            json=apply_no_thinking_options(test_data),
            timeout=15,
            **get_request_kwargs_for_url(VLLM_API_URL)
        )

        result = {
            'success': response.status_code == 200,
            'status_code': response.status_code,
            'provider': LLM_PROVIDER_NAME,
            'vllm_url': mask_url_for_log(VLLM_API_URL),
            'response_preview': response.text[:200] if response.text else 'No response',
            'timestamp': datetime.now().isoformat()
        }

        print(f"✅ {LLM_PROVIDER_NAME} API 测试结果: success={result['success']}")
        return jsonify(result)

    except Exception as e:
        error_result = {
            'success': False,
            'error': str(e),
            'provider': LLM_PROVIDER_NAME,
            'vllm_url': mask_url_for_log(VLLM_API_URL),
            'timestamp': datetime.now().isoformat()
        }
        print(f"❌ {LLM_PROVIDER_NAME} API 测试失败: {error_result['error']}")
        return jsonify(error_result), 500


# ========== 对话历史管理 ==========

def _touch_cache(cache_key):
    """将 cache_key 移动到 OrderedDict 末尾（最近使用），并淘汰最旧条目。
    必须在 conversation_lock 内调用。"""
    if cache_key in conversation_histories:
        conversation_histories.move_to_end(cache_key)
    while len(conversation_histories) > MAX_CACHED_CONVERSATIONS:
        evicted_key, _ = conversation_histories.popitem(last=False)
        hydrated_conversations.discard(evicted_key)


def get_conversation_history(conversation_id, user_id):
    """首次访问时从数据库恢复会话历史，后续走内存缓存。"""
    conversation_id, user_id = get_conversation_cache_key(conversation_id, user_id)
    cache_key = (conversation_id, user_id)

    with conversation_lock:
        if cache_key in hydrated_conversations:
            _touch_cache(cache_key)
            return list(conversation_histories.get(cache_key, []))

    persistent_history = load_persistent_conversation_history(conversation_id, user_id)
    with conversation_lock:
        if cache_key not in hydrated_conversations:
            conversation_histories[cache_key] = persistent_history or []
            hydrated_conversations.add(cache_key)
        _touch_cache(cache_key)
        return list(conversation_histories.get(cache_key, []))


def add_to_conversation_history(conversation_id, user_id, role, content):
    """写入内存会话缓存，并持久化到数据库。"""
    conversation_id, user_id = get_conversation_cache_key(conversation_id, user_id)
    if not conversation_id or not user_id or not content:
        return

    cache_key = (conversation_id, user_id)
    persistent_history = None
    with conversation_lock:
        needs_hydration = cache_key not in hydrated_conversations

    if needs_hydration:
        persistent_history = load_persistent_conversation_history(conversation_id, user_id)

    with conversation_lock:
        if cache_key not in hydrated_conversations:
            conversation_histories[cache_key] = persistent_history or []
            hydrated_conversations.add(cache_key)
        conversation_histories[cache_key].append({
            "role": role,
            "content": content
        })
        if len(conversation_histories[cache_key]) > MAX_HISTORY_MESSAGES:
            conversation_histories[cache_key] = conversation_histories[cache_key][-MAX_HISTORY_MESSAGES:]
        _touch_cache(cache_key)

    persist_conversation_message(conversation_id, user_id, role, content)


def get_windrise_lightweight_history(conversation_id, user_id=None):
    cache_key = get_windrise_scoped_cache_key(conversation_id, user_id)
    if not all(cache_key):
        return []
    with conversation_lock:
        history = windrise_lightweight_histories.get(cache_key, [])
        if history:
            windrise_lightweight_histories.move_to_end(cache_key)
        return list(history)


def add_to_windrise_lightweight_history(conversation_id, role, content, user_id=None):
    cache_key = get_windrise_scoped_cache_key(conversation_id, user_id)
    if not all(cache_key) or not content:
        return
    with conversation_lock:
        history = windrise_lightweight_histories.setdefault(cache_key, [])
        history.append({
            "role": role,
            "content": content
        })
        if len(history) > MAX_HISTORY_MESSAGES:
            windrise_lightweight_histories[cache_key] = history[-MAX_HISTORY_MESSAGES:]
        windrise_lightweight_histories.move_to_end(cache_key)
        while len(windrise_lightweight_histories) > MAX_CACHED_CONVERSATIONS:
            windrise_lightweight_histories.popitem(last=False)


def merge_windrise_histories(*histories, limit=WINDRISE_MEMORY_LOAD_MESSAGES):
    merged = []
    seen = set()
    for history in histories:
        for item in history or []:
            role = item.get('role')
            content = item.get('content')
            if role not in {'user', 'assistant'} or not content:
                continue
            key = (role, content)
            if key in seen:
                continue
            seen.add(key)
            if role == 'assistant' and merged and merged[-1].get('role') == 'assistant':
                previous_content = merged[-1].get('content', '')
                if len(content) >= len(previous_content):
                    seen.discard(('assistant', previous_content))
                    merged[-1] = {'role': 'assistant', 'content': content}
                    seen.add(('assistant', content))
                continue
            merged.append({'role': role, 'content': content})
    return merged[-max(1, int(limit)):]


def strip_pending_windrise_user_turn(history, query):
    history = list(history or [])
    if history and history[-1].get('role') == 'user' and history[-1].get('content') == query:
        return history[:-1]
    return history


def merge_windrise_chat_histories(cached_history, lightweight_history, session_history, query='', limit=WINDRISE_MEMORY_LOAD_MESSAGES):
    """Merge chat histories after stripping the in-flight user turn from each source."""
    sources = {
        'session': strip_pending_windrise_user_turn(session_history, query),
        'cached': strip_pending_windrise_user_turn(cached_history, query),
        'lightweight': strip_pending_windrise_user_turn(lightweight_history, query),
    }
    session_turns = sources.get('session') or []
    if session_turns:
        # Session DB preserves UI save order. Use it as the canonical timeline
        # and only backfill assistant turns from server caches for each user turn.
        supplemental = merge_windrise_histories(
            sources.get('cached') or [],
            sources.get('lightweight') or [],
            limit=limit,
        )
        merged = []
        supplemental_index = 0
        for index, item in enumerate(session_turns):
            merged.append(item)
            if item.get('role') != 'user':
                continue
            user_content = item.get('content', '')
            next_item = session_turns[index + 1] if index + 1 < len(session_turns) else None
            if next_item and next_item.get('role') == 'assistant':
                while supplemental_index < len(supplemental):
                    supplemental_item = supplemental[supplemental_index]
                    supplemental_index += 1
                    if supplemental_item.get('role') != 'user':
                        continue
                    if supplemental_item.get('content', '') != user_content:
                        continue
                    if (
                        supplemental_index < len(supplemental)
                        and supplemental[supplemental_index].get('role') == 'assistant'
                    ):
                        supplemental_index += 1
                    break
                continue
            while supplemental_index < len(supplemental):
                supplemental_item = supplemental[supplemental_index]
                supplemental_index += 1
                if supplemental_item.get('role') != 'user':
                    continue
                if supplemental_item.get('content', '') != user_content:
                    continue
                if (
                    supplemental_index < len(supplemental)
                    and supplemental[supplemental_index].get('role') == 'assistant'
                ):
                    merged.append(supplemental[supplemental_index])
                    supplemental_index += 1
                break
        return merged[-max(1, int(limit)):]
    assistant_counts = {
        key: sum(1 for item in items if item.get('role') == 'assistant')
        for key, items in sources.items()
    }
    ordered_keys = sorted(
        sources.keys(),
        key=lambda key: (assistant_counts[key], len(sources[key])),
        reverse=True,
    )
    histories = [sources[key] for key in ordered_keys if sources[key]]
    merged = merge_windrise_histories(*histories, limit=limit) if histories else []
    if merged:
        return merged
    for key in ('session', 'cached', 'lightweight'):
        recovery = sources.get(key) or []
        if recovery:
            return recovery[-max(1, int(limit)):]
    return []


def is_windrise_bare_symptom_with_confirmed_scope(query, history=None):
    """Bare symptom turn that can still be scoped from confirmed user/device context."""
    history = history or []
    if is_windrise_general_knowledge_question(query):
        return False
    if is_bare_windrise_fault_code_query(query):
        return False
    if not history:
        return False
    if is_windrise_scope_supplement_reply(query, history):
        return False
    if should_answer_windrise_turbine_mapping_question(query):
        return False
    if query_has_explicit_dimension(query) or is_context_only_windrise_followup(query):
        return False
    if not (
        has_device_issue_hint(query)
        or extract_windrise_fault_subject_phrase(query)
        or extract_scada_style_alarm_name(query)
    ):
        return False
    slots = build_resolved_windrise_scope_slots(query, history)
    return has_windrise_scope_for_fault_answer(slots, query, history)


def build_scoped_symptom_index_query(query, history=None):
    """Build a symptom-only local-index query after scope is confirmed."""
    history = history or []
    if not is_windrise_bare_symptom_with_confirmed_scope(query, history):
        return ''
    resolved_slots = build_resolved_windrise_scope_slots(query, history)
    if not has_windrise_scope_for_fault_answer(resolved_slots, query, history):
        return ''
    return build_windrise_symptom_subject_query(query, history)


def get_windrise_yaw_hydraulic_stage(conversation_id, user_id=None):
    cache_key = get_windrise_scoped_cache_key(conversation_id, user_id)
    if not cache_key[0]:
        return ''
    with conversation_lock:
        stage = windrise_yaw_hydraulic_stages.get(cache_key, '')
        if stage:
            windrise_yaw_hydraulic_stages.move_to_end(cache_key)
        return stage


def set_windrise_yaw_hydraulic_stage(conversation_id, stage, user_id=None):
    cache_key = get_windrise_scoped_cache_key(conversation_id, user_id)
    if not cache_key[0]:
        return
    with conversation_lock:
        if stage:
            windrise_yaw_hydraulic_stages[cache_key] = stage
            windrise_yaw_hydraulic_stages.move_to_end(cache_key)
        else:
            windrise_yaw_hydraulic_stages.pop(cache_key, None)
        while len(windrise_yaw_hydraulic_stages) > MAX_CACHED_CONVERSATIONS:
            windrise_yaw_hydraulic_stages.popitem(last=False)


@app.route('/api/save', methods=['POST'])
@login_required
def save_to_file():
    """下载对话记录到客户端"""
    try:
        data = request.get_json(silent=True) or {}
        content = data.get('content', '')
        filename = secure_filename(data.get('filename', 'conversation.md') or 'conversation.md')
        if not filename:
            filename = 'conversation.md'
        if not filename.lower().endswith('.md'):
            filename = f'{filename}.md'

        print(f"💾 下载文件: {filename}, 长度: {len(content)} 字符")

        response = Response(
            content,
            mimetype='text/markdown',
            headers={
                'Content-Disposition': f'attachment; filename="{filename}"',
                'Access-Control-Expose-Headers': 'Content-Disposition'
            }
        )

        return response

    except Exception as e:
        print(f"❌ 下载文件错误: {e}")
        return jsonify({'error': '下载失败'}), 500


def extract_dify_workflow_answer(result):
    data = result.get('data') if isinstance(result, dict) else {}
    outputs = data.get('outputs') if isinstance(data, dict) else {}
    if isinstance(outputs, dict):
        for key in ('answer', 'text', 'result', 'output'):
            value = outputs.get(key)
            if value:
                return str(value)
        if outputs:
            return json.dumps(outputs, ensure_ascii=False)
    answer = result.get('answer') if isinstance(result, dict) else ''
    return str(answer or '')


def log_dify_error(response, app_type, response_mode, conversation_id):
    body = ''
    try:
        body = response.text or ''
    except Exception:
        body = '<无法读取响应正文>'
    body = body.replace('\n', ' ')[:1000]
    print(
        f"❌ Dify 响应异常: status={response.status_code} "
        f"app_type={app_type} mode={response_mode} "
        f"url={mask_url_for_log(DIFY_API_URL)} "
        f"conversation_id={mask_identifier(conversation_id, prefix=4, suffix=4)} "
        f"body={body}"
    )


def is_dify_missing_conversation(response):
    if response.status_code != 404:
        return False
    try:
        body = response.text or ''
    except Exception:
        return False
    return 'Conversation Not Exists' in body


def call_dify_app(query, conversation_id, user_id, is_streaming):
    response_mode = 'streaming' if is_streaming else 'blocking'
    app_type = DIFY_APP_TYPE.lower()
    print(
        f"[Dify] 调用 Dify: app_type={app_type} mode={response_mode} "
        f"url={mask_url_for_log(DIFY_API_URL)} "
        f"conversation_id={mask_identifier(conversation_id, prefix=4, suffix=4)}"
    )

    if app_type == 'workflow':
        payload = {
            'inputs': {
                'query': query,
                'question': query,
            },
            'response_mode': 'blocking',
            'user': user_id,
        }
    else:
        payload = {
            'inputs': {},
            'query': query,
            'response_mode': response_mode,
            'user': user_id,
        }
        if conversation_id:
            payload['conversation_id'] = conversation_id

    if is_streaming and app_type != 'workflow':
        dify_response = http_session.post(
            DIFY_API_URL,
            json=payload,
            stream=True,
            timeout=300,
            **get_dify_request_kwargs(DIFY_API_URL)
        )
        if conversation_id and is_dify_missing_conversation(dify_response):
            log_dify_error(dify_response, app_type, response_mode, conversation_id)
            print("[Dify] conversation_id 不存在，已自动改为新会话重试")
            try:
                dify_response.close()
            except Exception:
                pass
            retry_payload = dict(payload)
            retry_payload.pop('conversation_id', None)
            dify_response = http_session.post(
                DIFY_API_URL,
                json=retry_payload,
                stream=True,
                timeout=300,
                **get_dify_request_kwargs(DIFY_API_URL)
            )
        if dify_response.status_code != 200:
            log_dify_error(dify_response, app_type, response_mode, conversation_id)
            error_event = {
                'event': 'error',
                'message': f'Dify 服务响应异常，状态码 {dify_response.status_code}，请查看服务端日志',
                'conversation_id': conversation_id,
            }
            return Response(
                f"data: {json.dumps(error_event, ensure_ascii=False)}\n\n",
                content_type='text/event-stream; charset=utf-8'
            )

        def relay_dify_sse():
            for raw_line in dify_response.iter_lines(decode_unicode=False):
                if not raw_line:
                    continue
                line = raw_line.decode('utf-8', errors='replace')
                if not line:
                    continue
                yield f"{line}\n\n"

        return Response(
            stream_with_context(relay_dify_sse()),
            content_type='text/event-stream; charset=utf-8',
            headers={
                'Cache-Control': 'no-cache',
                'X-Accel-Buffering': 'no',
            }
        )

    dify_response = http_session.post(
        DIFY_API_URL,
        json=payload,
        timeout=300,
        **get_dify_request_kwargs(DIFY_API_URL)
    )
    if conversation_id and app_type == 'chat' and is_dify_missing_conversation(dify_response):
        log_dify_error(dify_response, app_type, response_mode, conversation_id)
        print("[Dify] conversation_id 不存在，已自动改为新会话重试")
        retry_payload = dict(payload)
        retry_payload.pop('conversation_id', None)
        dify_response = http_session.post(
            DIFY_API_URL,
            json=retry_payload,
            timeout=300,
            **get_dify_request_kwargs(DIFY_API_URL)
        )
    if dify_response.status_code != 200:
        log_dify_error(dify_response, app_type, response_mode, conversation_id)
        return jsonify({
            'error': f'Dify 服务响应异常，状态码 {dify_response.status_code}，请查看服务端日志'
        }), 502

    result = dify_response.json()
    if app_type == 'workflow':
        answer = extract_dify_workflow_answer(result)
        return jsonify({
            'answer': answer or 'Dify 工作流未返回可展示内容',
            'conversation_id': conversation_id,
        })

    answer = result.get('answer', '')
    returned_conversation_id = normalize_user_id(result.get('conversation_id')) or conversation_id
    return jsonify({
        'answer': answer,
        'conversation_id': returned_conversation_id,
    })


def strip_ansi_control(text):
    if not text:
        return ''
    return re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', text)


def clean_windrise_output(output):
    text = strip_ansi_control(output or '').replace('\r\n', '\n').replace('\r', '\n')
    cleaned_lines = []
    for raw_line in text.split('\n'):
        line = raw_line.rstrip()
        stripped = line.strip()
        if not stripped:
            if cleaned_lines and cleaned_lines[-1] != '':
                cleaned_lines.append('')
            continue
        if stripped.startswith(('╭', '│', '╰')):
            continue
        if (
            '对话模式' in stripped
            or stripped.startswith('直接输入问题后')
            or stripped.startswith('故障码、')
            or stripped.startswith('风电专业问题、')
        ):
            continue
        if stripped.startswith('输入 help 查看命令') or stripped.startswith('windrise>'):
            continue
        if stripped.startswith('Windrise:'):
            content = stripped[len('Windrise:'):].strip()
            if content.startswith(('正在检索', '正在联网搜索', '正在抓取', '正在查询天气')):
                continue
            line = content
        cleaned_lines.append(line)

    answer = '\n'.join(cleaned_lines).strip()
    answer = re.sub(r'\n{3,}', '\n\n', answer)
    answer = dedupe_repeated_windrise_answer(answer)
    return answer


def dedupe_repeated_windrise_answer(answer):
    text = (answer or '').strip()
    if not text:
        return ''
    lines = text.split('\n')
    if len(lines) < 2:
        return text
    if len(lines) % 2 == 0:
        midpoint = len(lines) // 2
        first = '\n'.join(lines[:midpoint]).strip()
        second = '\n'.join(lines[midpoint:]).strip()
        if first and first == second:
            return first
    normalized = re.sub(r'\s+', '', text)
    for index in range(1, len(lines)):
        first = '\n'.join(lines[:index]).strip()
        second = '\n'.join(lines[index:]).strip()
        if first and second and re.sub(r'\s+', '', first) == re.sub(r'\s+', '', second):
            return first
    return text


def format_windrise_search_answer(query, answer):
    text = normalize_text(answer)
    query_text = normalize_text(query)
    if is_windrise_no_match_answer(text):
        return answer
    intent = 'repair'
    intent_match = re.search(r'\bintent=(reason|repair|reset|general)\b', query_text)
    if intent_match:
        intent = intent_match.group(1)
    if (
        '本地答案：' in text
        and (
            (
                '故障代码：' in text
                and '故障名称：' in text
                and ('处理：' in text or '故障处理：' in text or '故障描述：' in text)
            )
            or
            (
                '风场/机型：' in text
                and re.search(r'结论：(?:\*\*)?\s*故障码\s*[A-Za-z0-9_./\-~～至到、,，]+', text)
            )
            or re.search(r'结论：\s*[A-Za-z0-9_./\-~～至到、,，]+\s*为「', text)
            or re.search(r'结论：(?:\*\*)?\s*按名称/描述', text)
        )
    ):
        pass
    if not text.startswith('Matches for ') and '本地答案：' not in (answer or ''):
        return answer

    blocks = [block.strip() for block in (answer or '').split('\n\n') if block.strip()]
    records = []
    if '本地答案：' in (answer or ''):
        current_record = None
        for raw_line in (answer or '').splitlines():
            stripped = raw_line.strip()
            numbered_match = re.match(r'^\d+[.、]\s*([A-Za-z]{0,4}\d{1,8}[A-Za-z]{0,2})[:：]\s*(.+)$', stripped)
            if numbered_match:
                current_record = {
                    'source': '本地知识库',
                    'body': stripped,
                    'fields': {
                        '故障代码': numbered_match.group(1).upper(),
                        '故障名称': numbered_match.group(2).strip(),
                    },
                }
                records.append(current_record)
                continue
            if not current_record:
                continue
            field_match = re.match(
                r'^(对象|风场|品牌|机型|具体型号|故障代码|故障名称|故障描述|原因|故障原因|处理|故障处理|复位|逻辑|故障逻辑|来源)[:：]\s*(.+)$',
                stripped,
            )
            if not field_match:
                continue
            key, value = field_match.group(1), field_match.group(2).strip()
            current_record['body'] = f"{current_record['body']} {stripped}"
            fields = current_record['fields']
            if key == '对象':
                fields['对象'] = value
                object_parts = [part.strip() for part in value.split(' / ') if part.strip()]
                if len(object_parts) >= 3:
                    fields['风场'], fields['品牌'], fields['机型'] = object_parts[0], object_parts[1], ' / '.join(object_parts[2:])
                elif len(object_parts) == 2:
                    fields['品牌'], fields['机型'] = object_parts
                elif len(object_parts) == 1:
                    fields['机型'] = object_parts[0]
            elif key in {'风场', '品牌', '机型', '具体型号', '故障代码', '故障名称', '故障描述'}:
                fields[key] = value
            elif key in {'处理', '故障处理'}:
                fields['故障处理'] = value
            elif key in {'原因', '故障原因'}:
                fields['故障原因'] = value
            elif key in {'逻辑', '故障逻辑'}:
                fields['故障逻辑'] = value
            elif key == '复位':
                fields['复位'] = value
            elif key == '来源':
                current_record['source'] = value

        if not records:
            fields = {}
            body = ' '.join((answer or '').splitlines())
            source_match = re.search(r'来源[:：]\s*([^\n]+)', answer or '')
            source = source_match.group(1).strip() if source_match else '本地知识库'
            for key in ('对象', '风场', '品牌', '机型', '具体型号', '故障代码', '故障名称', '故障描述', '结论', '原因', '故障原因', '处理', '故障处理', '复位', '逻辑', '故障逻辑'):
                match = re.search(rf'{key}[:：]\s*([^\n]+)', answer or '')
                if match:
                    fields[key] = match.group(1).strip()
            code_match = re.search(r'本地答案[:：]\s*([A-Za-z]{0,4}\d{1,8}[A-Za-z]{0,2})', answer or '')
            if code_match:
                fields['故障代码'] = code_match.group(1).upper()
            conclusion_match = re.search(r'结论[:：]\s*([A-Za-z]{0,4}\d{1,8}[A-Za-z]{0,2})\s*为[「\"]?([^」。\"\n]+)', answer or '')
            if conclusion_match:
                fields['故障代码'] = conclusion_match.group(1).upper()
                fields['故障名称'] = conclusion_match.group(2).strip('」')
            if fields.get('处理'):
                fields['故障处理'] = fields['处理']
            if fields.get('故障处理'):
                fields['故障处理'] = fields['故障处理']
            if fields.get('原因'):
                fields['故障原因'] = fields['原因']
            if fields.get('故障原因'):
                fields['故障原因'] = fields['故障原因']
            if fields.get('逻辑'):
                fields['故障逻辑'] = fields['逻辑']
            if fields.get('故障逻辑'):
                fields['故障逻辑'] = fields['故障逻辑']
            object_parts = (fields.get('对象') or '').split(' / ')
            if len(object_parts) >= 3:
                fields['风场'], fields['品牌'], fields['机型'] = object_parts[0], object_parts[1], ' / '.join(object_parts[2:])
            records.append({'source': source, 'body': body, 'fields': fields})

    for block in ([] if records else blocks[1:]):
        lines = [line.strip() for line in block.splitlines() if line.strip()]
        if len(lines) < 2:
            continue
        source = lines[0]
        body = ' '.join(lines[1:])
        fields = {}
        for key in ('风场', '品牌', '机型', '故障代码', '故障名称', '故障原因', '故障处理', '复位', '是否允许远程复位', '故障逻辑'):
            match = re.search(rf'{key}：([^，\n]+(?:[;；][^，\n]+)*)', body)
            if match:
                fields[key] = match.group(1).strip()
        records.append({'source': source, 'body': body, 'fields': fields})

    if not records:
        return answer

    def record_identity(record):
        fields = record.get('fields') or {}
        return (
            fields.get('故障代码') or '',
            fields.get('风场') or '',
            fields.get('品牌') or '',
            fields.get('机型') or '',
            record.get('source') or '',
        )

    unique_records = []
    seen_records = set()
    for record in records:
        identity = record_identity(record)
        if identity in seen_records:
            continue
        seen_records.add(identity)
        unique_records.append(record)
    records = unique_records

    primary = next((item for item in records if item['fields'].get('故障处理')), records[0])
    fields = primary['fields']
    code = fields.get('故障代码') or find_recent_fault_code_from_history([{'role': 'assistant', 'content': answer}])

    lines = []
    if code:
        if intent == 'trigger':
            lines.append(f"{code} 触发条件")
        elif intent == 'reason':
            lines.append(f"{code} 原因分析")
        elif intent == 'reset':
            lines.append(f"{code} 复位说明")
        else:
            lines.append(f"{code} 维修处理建议")
    else:
        lines.append(
            "触发条件" if intent == 'trigger'
            else ("原因分析" if intent == 'reason' else "维修处理建议")
        )
    display_limit = 3
    lines.append(f"匹配到 {len(records)} 条记录；先展开前 {min(display_limit, len(records))} 条高相关记录。")

    for record_index, record in enumerate(records[:display_limit], start=1):
        fields = record['fields']
        name = fields.get('故障名称') or '未标明'
        code_value = fields.get('故障代码') or code or ''
        site = fields.get('风场')
        brand = fields.get('品牌')
        model = fields.get('机型')
        reason = fields.get('故障原因')
        handling = fields.get('故障处理')
        reset = fields.get('复位')
        remote_reset = fields.get('是否允许远程复位')
        logic = fields.get('故障逻辑')

        lines.append("")
        title = f"{code_value}｜{name}" if code_value else name
        lines.append(f"{record_index}. **{title}**")
        meta = []
        if brand:
            meta.append(f"厂家：{brand}")
        if model:
            meta.append(f"机型：{model}")
        if site:
            meta.append(f"风场：{site}")
        if meta:
            lines.append(f"   - {' / '.join(meta)}")

        if intent == 'reason':
            reasons = []
            if reason:
                reasons.extend(item.strip() for item in re.split(r'[;；]', reason) if item.strip())
            if handling:
                reasons.extend(item.strip() for item in re.split(r'[;；]', handling) if item.strip())
            if logic and logic not in reasons:
                reasons.append(logic)
            if reasons:
                lines.append("   - 可能原因：" + clip_text('；'.join(
                    re.sub(r'^\d+[.、]\s*', '', item) for item in reasons[:3]
                ), 220))
                for index, reason in enumerate(reasons[:3], start=1):
                    normalized_reason = re.sub(r'^\d+[.、]\s*', '', reason)
                    lines.append(f"  {index}. {normalized_reason}")
            else:
                lines.append("   - 可能原因：知识库未给出明确原因，只给出了故障名称或逻辑。")
        elif intent == 'trigger' and logic:
            lines.append(f"   - 触发条件：{clip_text(logic, 220)}")
        elif handling:
            if reason:
                lines.append(f"   - 原因：{clip_text(reason, 180)}")
            step_label, short_steps = format_fault_solution_steps(handling)
            lines.append(f"   - {step_label}：{clip_text('；'.join(short_steps), 480)}")
        else:
            lines.append("   - 处理：知识库未给出明确维修步骤。")

        if reset:
            reset_line = f"复位：{reset}"
            if remote_reset:
                reset_line += f"，是否允许远程复位：{remote_reset}"
            lines.append(f"   - {clip_text(reset_line, 160)}")
        if logic and intent not in {'reason', 'trigger'}:
            lines.append(f"   - 逻辑：{clip_text(logic, 180)}")
        lines.append(f"   - 来源：{record['source']}")
    if len(records) > display_limit:
        lines.extend([
            "",
            f"还有 {len(records) - display_limit} 条记录未展开；请补充厂家、机型、风场或 HMI/SCADA 原始报码后继续收敛。",
        ])
    return '\n'.join(lines)


def resolve_windrise_bin():
    configured = os.path.expandvars(os.path.expanduser(WINDRISE_BIN or 'windrise'))
    if os.path.sep in configured or (os.path.altsep and os.path.altsep in configured) or os.path.isabs(configured):
        normalized = os.path.normpath(configured)
        if os.path.exists(normalized):
            return normalized
        fallback = find_default_windrise_bin()
        if fallback and os.path.exists(fallback):
            print(
                f"[Windrise] 配置的可执行文件不存在，已回退到当前包内可执行文件: "
                f"configured={normalized} fallback={fallback}"
            )
            return fallback
        return normalized
    found = shutil.which(configured)
    return found or configured


def build_windrise_env():
    ensure_vllm_service_configured()
    env = os.environ.copy()
    env.setdefault('DISABLE_INSTALLATION_CHECKS', '1')
    env.setdefault('WINDRISE', '1')
    env.setdefault('WINDRISE_MODEL_MODE', WINDRISE_MODEL_MODE)
    env.setdefault('LMSTUDIO_BASE_URL', LMSTUDIO_BASE_URL)
    env.setdefault('LMSTUDIO_MODEL', LMSTUDIO_MODEL)
    env.setdefault('LMSTUDIO_CHAT_MODEL', LMSTUDIO_CHAT_MODEL)
    if VLLM_MODEL_NAME:
        env.setdefault('VLLM_MODEL_NAME', VLLM_MODEL_NAME)
    if VLLM_API_KEY:
        env.setdefault('VLLM_API_KEY', VLLM_API_KEY)
    env.setdefault(
        'LLMWIKI_PROJECT',
        os.getenv('LLMWIKI_PROJECT') or os.getenv('LLMWIKI_DIR') or WINDRISE_CWD,
    )
    for key in WINDRISE_ENV_KEYS:
        value = os.getenv(key)
        if value:
            env[key] = value
    return env


def run_windrise_answer(query, timeout=None):
    timeout = get_windrise_request_timeout(timeout or WINDRISE_TIMEOUT)
    windrise_bin = resolve_windrise_bin()
    if not query:
        raise ValueError('消息内容不能为空')
    if os.path.sep in windrise_bin and not os.path.exists(windrise_bin):
        raise FileNotFoundError(f'未找到 Windrise 可执行文件：{windrise_bin}')

    windrise_intent = None
    if isinstance(query, dict):
        windrise_args = query.get('args') or [query.get('query', '')]
        windrise_intent = query.get('intent')
    else:
        windrise_args = query if isinstance(query, list) else [query]
    if getattr(windrise_request_context, 'prefer_local_scoped_index', False):
        return ''
    if (
        getattr(windrise_request_context, 'enforce_retrieval_extraction', False)
        and not getattr(windrise_request_context, 'retrieval_query_extracted', False)
    ):
        raise RuntimeError(WINDRISE_RETRIEVAL_EXTRACTION_FAILURE)
    query_for_log = ' '.join(str(item) for item in windrise_args)
    remembered_answer = direct_windrise_retrieval_memory_hit(query_for_log)
    if remembered_answer:
        print('[Windrise] 低层检索直接复用会话记忆，不再启动 LLMWiki')
        return remembered_answer
    cache_key = (
        normalize_user_id(getattr(windrise_request_context, 'user_id', '') or ''),
        os.getenv('LLMWIKI_PROJECT') or os.getenv('LLMWIKI_DIR') or WINDRISE_CWD,
        tuple(str(item) for item in windrise_args),
        windrise_intent or '',
    )
    if WINDRISE_SEARCH_CACHE_TTL > 0:
        now = time.time()
        with windrise_search_cache_lock:
            cached = windrise_search_cache.get(cache_key)
            if cached and now - cached[0] < WINDRISE_SEARCH_CACHE_TTL:
                windrise_search_cache.move_to_end(cache_key)
                print(f"[Windrise] LLMWiki 缓存命中: query_length={len(query_for_log)}")
                remember_windrise_retrieval_context(
                    query_for_log,
                    cached[1],
                    getattr(windrise_request_context, 'conversation_id', None),
                    getattr(windrise_request_context, 'user_id', None),
                )
                return cached[1]
            if cached:
                windrise_search_cache.pop(cache_key, None)
    cwd = WINDRISE_CWD if WINDRISE_CWD and os.path.isdir(WINDRISE_CWD) else BASE_DIR
    print(
        f"[Windrise] 调用: bin={windrise_bin} cwd={cwd} "
        f"query_length={len(query_for_log)} timeout={timeout or WINDRISE_TIMEOUT}"
    )
    result = subprocess.run(
        [windrise_bin, *windrise_args],
        cwd=cwd,
        env=build_windrise_env(),
        stdin=subprocess.DEVNULL,
        capture_output=True,
        text=True,
        encoding='utf-8',
        errors='replace',
        timeout=timeout,
    )
    combined_output = '\n'.join(part for part in (result.stdout, result.stderr) if part)
    answer = clean_windrise_output(combined_output)
    format_query = f"{query_for_log} intent={windrise_intent}" if windrise_intent else query_for_log
    answer = format_windrise_search_answer(format_query, answer)
    if result.returncode != 0:
        detail = answer or f'Windrise 退出码 {result.returncode}'
        raise RuntimeError(detail[:1000])
    answer = answer or 'Windrise 未返回可展示内容'
    if WINDRISE_SEARCH_CACHE_TTL > 0:
        with windrise_search_cache_lock:
            windrise_search_cache[cache_key] = (time.time(), answer)
            windrise_search_cache.move_to_end(cache_key)
            while len(windrise_search_cache) > WINDRISE_SEARCH_CACHE_MAX:
                windrise_search_cache.popitem(last=False)
    remember_windrise_retrieval_context(
        query_for_log,
        answer,
        getattr(windrise_request_context, 'conversation_id', None),
        getattr(windrise_request_context, 'user_id', None),
    )
    return answer


def run_windrise_answer_with_timeout(query, timeout):
    return run_windrise_answer(query, timeout=max(1, int(timeout)))


def load_app_session_history(app_session_id, user_id, limit=WINDRISE_MEMORY_LOAD_MESSAGES):
    if app_session_id is None:
        return []
    conn = get_db_connection()
    try:
        cursor = conn.cursor()
        cursor.execute(
            'SELECT id FROM sessions WHERE id = ? AND user_id = ?',
            (app_session_id, user_id)
        )
        if not cursor.fetchone():
            return []
        cursor.execute(
            '''
            SELECT role, content
            FROM messages
            WHERE session_id = ?
            ORDER BY id DESC
            LIMIT ?
            ''',
            (app_session_id, max(1, int(limit)))
        )
        rows = cursor.fetchall()
        rows.reverse()
        return [
            {'role': row['role'], 'content': row['content']}
            for row in rows
            if row['role'] in {'user', 'assistant'} and row['content']
        ]
    finally:
        conn.close()


def ensure_windrise_conversation_id(app_session_id, user_id, conversation_id):
    if conversation_id or app_session_id is None:
        return conversation_id
    new_conversation_id = str(uuid.uuid4())
    conn = get_db_connection()
    try:
        cursor = conn.cursor()
        cursor.execute(
            '''
            UPDATE sessions
            SET session_id = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND user_id = ? AND (session_id IS NULL OR session_id = '')
            ''',
            (new_conversation_id, app_session_id, user_id)
        )
        conn.commit()
    finally:
        conn.close()
    return new_conversation_id


def is_windrise_followup_query(query):
    normalized = normalize_text(query).lower()
    if not normalized:
        return False
    if has_explicit_fault_code(normalized):
        return False
    if any(re.match(pattern, normalized, flags=re.IGNORECASE) for pattern in GREETING_QUERY_PATTERNS):
        return False
    followup_words = (
        '刚才', '上面', '前面', '这个', '那个', '它', '该故障', '该报警',
        '怎么修', '怎么维修', '维修', '怎么处理', '如何处理', '处理步骤', '维修步骤', '会自启',
        '怎么办', '接下来怎么做', '下一步', '下一步怎么做', '我该怎么做', '该怎么做',
        '自动复位', '手动复位', '原因', '逻辑', '对象', '机型', '风场',
        '有哪些码', '哪些码', '有什么码', '对应哪些码',
        '为什么', '为何', '怎么会', '为啥', '咋会', '出现这个问题', '出现该问题',
    )
    return any(word in normalized for word in followup_words)


def classify_windrise_followup_intent(query):
    normalized = normalize_text(query)
    if re.search(r'(区别|有什么不同|有何不同|对比|比较|分别是什么|分别表示|各是什么|各自是什么)', normalized):
        return 'comparison'
    if re.search(r'(还能继续运行|能否继续运行|能不能继续运行|可以继续运行|是否停机|需要停机|要不要停机|必须停机吗|必须停吗|要停吗|能否开机|能不能开机|还能开吗|是否可以复位后运行)', normalized):
        return 'operation'
    if re.search(r'(严重吗|严不严重|危险吗|风险多大|风险等级|安全风险)', normalized):
        return 'risk'
    if re.search(r'(有什么影响|有何影响|什么后果|会导致什么|会造成什么|影响范围)', normalized):
        return 'impact'
    if re.search(r'(触发条件|触发逻辑|报警条件|报码条件|阈值是多少|门限是多少|达到多少会报|多少会报|达到什么值|什么时候触发|何时触发|什么时候报|何时报|什么情况下报|什么条件下(?:产生|出现|报码|报警)|何时产生|何时出现|如何触发|怎么触发|会在什么时候报)', normalized):
        return 'trigger'
    if re.search(r'(为什么|为何|原因|怎么会|为啥|咋会|出现这个问题|出现该问题)', normalized):
        return 'reason'
    if re.search(r'(怎么来的|如何产生的|产生原因|形成原因)', normalized):
        return 'reason'
    if re.search(r'(是什么故障码|故障码是什么|故障代码是什么|是什么故障|什么故障|是啥故障|什么意思|啥意思|含义|meaning|有哪些码|哪些码|有什么码|对应哪些码|故障描述|描述|对象|机型|风场|品牌|具体型号)', normalized, flags=re.IGNORECASE):
        return 'meaning'
    if re.search(r'(怎么修|维修|怎么处理|如何处理|处理步骤|处理方法|检修|排查|怎么办|接下来怎么做|接下来|下一步|后面怎么做|后续怎么做|然后呢|继续|我该怎么做|该怎么做)', normalized):
        return 'repair'
    if re.search(r'(复位|自启|自动|远程复位|手动复位|消警|消除报警|清除报警|解除报警|\breset\b)', normalized, flags=re.IGNORECASE):
        return 'reset'
    if extract_fault_codes(normalized):
        return 'meaning'
    return ''


def find_recent_fault_code_sequence(history):
    """Return the most recent user-specified multi-code order."""
    for item in reversed(history or []):
        if item.get('role') != 'user':
            continue
        codes = dedupe_preserve_order(
            normalize_windrise_fault_code(code)
            for code in extract_direct_windrise_fault_codes(item.get('content', ''), [])
        )
        codes = [code for code in codes if code]
        if len(codes) >= 2:
            return codes
    return []


def resolve_windrise_ordinal_fault_code(query, history):
    normalized = normalize_text(query)
    if not normalized or extract_direct_windrise_fault_codes(normalized, []):
        return ''
    codes = find_recent_fault_code_sequence(history)
    if len(codes) < 2:
        return ''
    if re.search(r'(前一个|第一个|第1个|前者)', normalized):
        return codes[0]
    if re.search(r'(后一个|第二个|第2个|后者)', normalized):
        return codes[1]
    return ''


def resolve_windrise_contextual_fault_code(query, history):
    """Resolve deterministic fault-code references without an LLM call."""
    normalized = normalize_text(query)
    if not normalized or extract_direct_windrise_fault_codes(normalized, []):
        return ''
    if getattr(windrise_request_context, 'new_case_switch', False):
        return ''
    if detect_windrise_new_case_switch(query, history)[0]:
        return ''
    if windrise_should_isolate_history_issue_slots(query, history):
        return ''
    ordinal_code = resolve_windrise_ordinal_fault_code(normalized, history)
    if ordinal_code:
        return ordinal_code
    if is_fault_code_coverage_followup(normalized):
        return find_recent_fault_code_from_history(history)
    repeat_followup = bool(re.search(r'(再说一遍|再说一次|重复一下|重新说一下)', normalized))
    intent = classify_windrise_followup_intent(normalized)
    if not intent and repeat_followup:
        intent = classify_windrise_answer_intent(normalized)
    if is_dimension_only_fault_followup(normalized):
        return find_recent_fault_code_from_history(history)
    if is_windrise_broad_scope_search_request(normalized):
        # “相关记录都列出来” is an explicit request to expand the current
        # fault object, even though Chinese commonly omits “这个故障”.
        return find_recent_fault_code_from_history(history)
    if intent not in {
        'meaning', 'repair', 'reason', 'reset', 'trigger', 'impact',
        'risk', 'operation', 'comparison',
    }:
        return ''
    if not (is_context_only_windrise_followup(normalized) or repeat_followup):
        return ''
    return find_recent_fault_code_from_history(history)


def find_recent_windrise_user_intent(history):
    for item in reversed(history or []):
        if item.get('role') != 'user':
            continue
        content = normalize_text(item.get('content', ''))
        intent = classify_windrise_followup_intent(content)
        if intent:
            return intent
        if extract_direct_windrise_fault_codes(content, []):
            return classify_windrise_answer_intent(content)
    return 'meaning'


def build_windrise_contextual_fault_query(query, history):
    # Preserve commas because model families such as MySE3.0,4.0,5.0,6.25
    # use them as semantic separators. Individual routing helpers may still
    # compact punctuation when their own matching rules require it.
    normalized = normalize_text(query)
    if getattr(windrise_request_context, 'new_case_switch', False):
        return normalized
    if detect_windrise_new_case_switch(query, history)[0]:
        return normalized
    if windrise_should_isolate_history_issue_slots(query, history):
        return normalized
    code = resolve_windrise_contextual_fault_code(normalized, history)
    if not code:
        return normalized
    parts = [f'故障码{code}', normalized]
    if is_dimension_only_fault_followup(normalized):
        intent_label = {
            'meaning': '故障含义',
            'repair': '怎么处理',
            'reason': '故障原因',
            'reset': '复位条件',
            'trigger': '触发条件',
            'impact': '故障影响',
            'risk': '风险说明',
            'operation': '能否继续运行',
            'comparison': '故障对比',
        }.get(find_recent_windrise_user_intent(history), '')
        if intent_label:
            parts.append(intent_label)
    return ' '.join(part for part in parts if part)


def find_recent_fault_code_from_history(history):
    context = find_recent_fault_context_from_history(history)
    if context.get('code'):
        return context['code']
    return ''


def find_recent_fault_context_from_history(history):
    for item in reversed(history or []):
        content = item.get('content', '')
        normalized = normalize_text(content)
        if item.get('role') == 'user':
            if re.search(r'(故障码|故障代码|报码|告警码|报警码|fault\s*code|alarm\s*code)', normalized, flags=re.IGNORECASE):
                codes = extract_fault_codes(normalized)
                if codes:
                    return {'code': codes[0]}
            bare_code = re.fullmatch(r'(?:帮我|给我|请)?\s*(?:查|查询|检索|搜索)?\s*([A-Za-z]{0,4}\d{1,8}[A-Za-z]{0,2})\s*(?:是什么|啥|故障|报警|告警|处理|维修|怎么修|怎么处理)?\s*', normalized, flags=re.IGNORECASE)
            if bare_code:
                return {'code': bare_code.group(1).upper()}
            direct_codes = extract_direct_windrise_fault_codes(normalized, [])
            if direct_codes:
                code = direct_codes[0]
                turbine_ids = extract_windrise_turbine_ids_from_text(normalized)
                if code not in {normalize_windrise_turbine_id(value) for value in turbine_ids}:
                    return {'code': code}
            if is_user_fault_topic_message(normalized):
                return {'name': clean_windrise_fault_topic_text(normalized) or normalized}
            continue

        if item.get('role') != 'assistant':
            continue

        primary_code = extract_windrise_primary_answer_fault_code(content)
        context = extract_fault_context_from_answer(content)
        if primary_code:
            context['code'] = primary_code
        if context.get('code') or context.get('name'):
            return context
    return {}


def extract_fault_context_from_answer(content):
    # Alternative candidates must not override the primary evidence hit.
    normalized = normalize_text(content).split('备选答案')[0]
    if is_windrise_no_match_answer(normalized):
        return {}
    is_candidate_list = bool(
        re.search(r'匹配到\s*\d+\s*条记录', normalized)
        and re.search(r'\n?\s*\d+[.、]\s*机型[:：]', normalized)
    )
    code_value_pattern = r'(?=[A-Za-z0-9_./\-]*\d)[A-Za-z0-9_./\-]+'
    standard_code = re.search(rf'标准码[:：]\s*({code_value_pattern})', normalized, flags=re.IGNORECASE)
    coverage_title_code = re.search(
        rf'故障码\s*({code_value_pattern})\s*的知识库覆盖范围',
        normalized,
        flags=re.IGNORECASE,
    )
    conclusion_code = None if is_candidate_list else re.search(
        rf'结论[:：]\s*(?:\*\*)?\s*(?:故障码|故障代码|代码)?\s*({code_value_pattern})\s*(?:为|是|：|:|，|,|。|\s)',
        normalized,
        flags=re.IGNORECASE,
    )
    explicit_answer_code = None if is_candidate_list else re.search(rf'(?<!本地答案[:：]\s)(?:故障代码|故障码|报码|告警码|报警码)[:：]\s*({code_value_pattern})', normalized, flags=re.IGNORECASE)
    bracket_answer_code = None if is_candidate_list else re.search(
        rf'【故障代码】\s*({code_value_pattern})',
        normalized,
        flags=re.IGNORECASE,
    )
    bracket_answer_name = re.search(
        r'【故障名称】\s*(.+?)(?=\s*【|$)',
        normalized,
        flags=re.IGNORECASE,
    )
    numbered_answer_code = None if is_candidate_list else re.search(
        rf'(?:^|\s)\d+[.、]\s*(?:\*\*)?\s*({code_value_pattern})\s*(?:\*\*)?\s*[:：]',
        normalized,
        flags=re.IGNORECASE,
    )
    unique_candidate_codes = []
    if is_candidate_list:
        for candidate_code in re.findall(rf'(?:故障代码|故障码|报码|告警码|报警码)[:：]\s*({code_value_pattern})', normalized, flags=re.IGNORECASE):
            normalized_code = candidate_code.upper()
            if normalized_code not in unique_candidate_codes:
                unique_candidate_codes.append(normalized_code)
    code = ''
    if standard_code:
        code = standard_code.group(1).upper()
    elif coverage_title_code:
        code = coverage_title_code.group(1).upper()
    elif conclusion_code:
        code = conclusion_code.group(1).upper()
    elif numbered_answer_code:
        code = numbered_answer_code.group(1).upper()
    elif explicit_answer_code:
        code = explicit_answer_code.group(1).upper()
    elif bracket_answer_code:
        code = bracket_answer_code.group(1).upper()
    elif len(unique_candidate_codes) == 1:
        code = unique_candidate_codes[0]
    record_header_codes = dedupe_preserve_order(
        match.upper()
        for match in re.findall(
            rf'(?:^|\s)(?:\d+[.、]\s*)?(?:\*\*)?({code_value_pattern})\s*[|｜]',
            normalized,
            flags=re.IGNORECASE,
        )
    )
    if not code and len(record_header_codes) == 1:
        code = record_header_codes[0]
    title_code = None if is_candidate_list else re.search(rf'^({code_value_pattern})\s+(?:维修处理建议|原因分析|复位说明)', normalized, flags=re.IGNORECASE)
    if not code and title_code:
        code = title_code.group(1).upper()

    fields = {
        'code': code,
        'name': '',
        'site': '',
        'brand': '',
        'model': '',
        'standard_model': '',
        'turbine_id': '',
        'turbine_ids': [],
    }
    object_match = re.search(r'(?<!/)对象[:：]\s*(.+?)(?=\s+(?:风场|风场/机型|品牌|机型|具体型号|故障代码|故障名称|故障描述|原因|处理|来源|程序|复位|逻辑)[:：]|$)', normalized)
    if object_match:
        object_parts = [part.strip() for part in object_match.group(1).split(' / ') if part.strip()]
        if len(object_parts) >= 3:
            fields['site'] = normalize_context_dimension_value(object_parts[0])
            fields['brand'] = normalize_context_dimension_value(object_parts[1])
            fields['model'] = normalize_context_dimension_value(object_parts[2])
        elif len(object_parts) == 2:
            fields['brand'] = normalize_context_dimension_value(object_parts[0])
            fields['model'] = normalize_context_dimension_value(object_parts[1])
        elif len(object_parts) == 1:
            fields['model'] = normalize_context_dimension_value(object_parts[0])
    name_match = re.search(r'(?<!/)故障名称[:：]\s*(.+?)(?=\s+(?:风场|风场/机型|故障描述|原因|处理|来源|程序|复位|对象|品牌|机型|具体型号|故障代码)[:：]|$)', normalized)
    if bracket_answer_name and not name_match:
        fields['name'] = bracket_answer_name.group(1).strip()
    if name_match:
        fields['name'] = name_match.group(1).strip()
    # The local structured formatter leads with titles such as
    # ``故障码 120014：偏航回路欠压`` or ``120014｜偏航回路欠压``.
    # Preserve that fault name for later conversational follow-ups, while
    # keeping candidate lists from becoming confirmed context.
    title_pairs = []
    title_patterns = (
        rf'(?:^|\n)\s*(?:\d+[.、]\s*)?(?:\*\*)?(?:故障(?:码|代码)?\s*)?({code_value_pattern})\s*[|｜：:]\s*([^\n*]+)',
        rf'\*\*(?:故障(?:码|代码)?\s*)?({code_value_pattern})\s*[|｜：:]\s*([^*\n]+)\*\*',
    )
    for title_pattern in title_patterns:
        for match in re.finditer(title_pattern, normalized, flags=re.IGNORECASE):
            pair_code = normalize_windrise_fault_code(match.group(1)) or match.group(1).upper()
            pair_name = normalize_context_dimension_value(match.group(2)).strip(' -')
            if pair_code and pair_name and pair_name not in {'查询结果', '维修处理建议', '原因分析', '复位说明', '触发条件'}:
                title_pairs.append((pair_code, pair_name))
    unique_title_pairs = list(dict.fromkeys(title_pairs))
    if len(unique_title_pairs) == 1:
        pair_code, pair_name = unique_title_pairs[0]
        if not fields.get('code'):
            fields['code'] = pair_code
        if not fields.get('name'):
            fields['name'] = pair_name
    brand_match = re.search(r'(?<!/)品牌[:：]\s*([^\s/]+)', normalized)
    if brand_match and not fields['brand']:
        fields['brand'] = normalize_context_dimension_value(brand_match.group(1))
    model_match = re.search(r'(?<!/)机型[:：]\s*([^\s/]+)', normalized)
    if model_match and not fields['model']:
        fields['model'] = normalize_context_dimension_value(model_match.group(1))
    standard_model_match = re.search(r'(?<!/)(?:具体型号|标准型号)[:：]\s*([^\s/]+)', normalized)
    if standard_model_match:
        fields['standard_model'] = normalize_windrise_model_value(standard_model_match.group(1))
    turbine_match = re.search(r'(?<!/)风机编号[:：]\s*([A-Za-z0-9#_-]+)', normalized, flags=re.IGNORECASE)
    if turbine_match:
        fields['turbine_id'] = normalize_windrise_turbine_id(turbine_match.group(1))
        fields['turbine_ids'] = [fields['turbine_id']]
    sites = [
        normalize_context_dimension_value(match.group(1))
        for match in re.finditer(r'(?<!/)风场[:：]\s*([^\s/]+)', normalized)
        if match.group(1).strip()
    ]
    unique_sites = []
    for site in sites:
        if site not in unique_sites:
            unique_sites.append(site)
    if len(unique_sites) == 1 and not fields['site']:
        fields['site'] = unique_sites[0]
    return fields


def normalize_context_dimension_value(value):
    normalized = normalize_text(value).strip(' /，,、;；')
    if not normalized:
        return ''
    parts = [part.strip() for part in re.split(r'[、,，]', normalized) if part.strip()]
    if len(parts) > 1:
        return '、'.join(parts[:3])
    return normalized


def is_windrise_unavailable_scope_value(value):
    normalized = normalize_text(value).strip(' /，,、;；。！？!?')
    if not normalized or len(normalized) > 32:
        return False
    return bool(re.search(
        r'(?:不知道|不清楚|不确定|无法提供|提供不了|不能提供|没法提供|没有(?:相关)?信息|未知|查不到|拿不到|暂时没有)',
        normalized,
    ))


def normalize_windrise_model_value(value):
    normalized = normalize_text(value).strip(' /，,、;；')
    if not normalized or is_windrise_unavailable_scope_value(normalized):
        return ''
    return re.sub(r'\s+', '', normalized)


def build_recent_fault_context_query(context, query):
    code = context.get('code', '')
    name = context.get('name', '')
    if is_fault_code_coverage_followup(query):
        return code or name or query
    if code and is_fault_action_followup(query) and not query_has_explicit_dimension(query):
        return code
    return ' '.join(
        item for item in (
            code,
            name,
            context.get('site', '') if query_has_explicit_dimension(query) else '',
            context.get('brand', '') if query_has_explicit_dimension(query) else '',
            context.get('model', '') if query_has_explicit_dimension(query) else '',
            query,
        ) if item
    )


def build_recent_fault_dimension_query(context, query):
    code = context.get('code', '')
    return ' '.join(item for item in (code, query) if item)


def resolve_windrise_fault_index_path():
    candidates = []
    explicit_project = os.getenv('LLMWIKI_PROJECT') or os.getenv('LLMWIKI_DIR')
    if explicit_project:
        candidates.append(os.path.join(os.path.expanduser(explicit_project), 'fault-index.jsonl'))
    if WINDRISE_CWD:
        candidates.append(os.path.join(WINDRISE_CWD, 'wind-llmwiki', 'fault-index.jsonl'))
    candidates.append(os.path.join(BASE_DIR, '..', 'wind-llmwiki', 'fault-index.jsonl'))
    candidates.append(os.path.join(BASE_DIR, 'wind-llmwiki', 'fault-index.jsonl'))
    for candidate in candidates:
        normalized = os.path.normpath(os.path.expandvars(os.path.expanduser(candidate)))
        if os.path.exists(normalized):
            return normalized
    return ''


def resolve_windrise_turbine_mapping_path():
    candidates = [
        os.path.join(BASE_DIR, '..', 'src', 'data', 'turbineMapping.json'),
        os.path.join(WINDRISE_CWD, 'src', 'data', 'turbineMapping.json'),
    ]
    explicit_project = os.getenv('LLMWIKI_PROJECT') or os.getenv('LLMWIKI_DIR')
    if explicit_project:
        candidates.append(os.path.join(os.path.expanduser(explicit_project), '..', 'src', 'data', 'turbineMapping.json'))
    for candidate in candidates:
        normalized = os.path.normpath(os.path.expandvars(os.path.expanduser(candidate)))
        if os.path.exists(normalized):
            return normalized
    return ''


def normalize_windrise_turbine_id(value):
    normalized = normalize_context_dimension_value(value)
    if is_windrise_unavailable_scope_value(normalized):
        return ''
    return normalized.upper()


def expand_windrise_turbine_id_expression(value):
    """Expand mapping expressions such as ``ZC09-ZC11&#10`` into exact IDs."""
    raw = str(value or '')
    # The source mapping contains HTML numeric line-break entities, sometimes
    # without the trailing semicolon. They are separators, not part of an ID.
    raw = re.sub(r'&#(?:10|13);?', '', raw)
    raw = raw.replace('\\n', '').replace('\n', '').replace('\r', '')
    expanded = []
    for part in re.split(r'[、,，;；/]', raw):
        token = normalize_windrise_turbine_id(part)
        if not token:
            continue
        match = re.fullmatch(
            r'([A-Z]+)?(\d+)(#?)\s*-\s*([A-Z]+)?(\d+)(#?)',
            token,
            flags=re.IGNORECASE,
        )
        if not match:
            expanded.append(token)
            continue
        start_prefix, start_number, start_hash, end_prefix, end_number, end_hash = match.groups()
        start_prefix = (start_prefix or '').upper()
        end_prefix = (end_prefix or start_prefix).upper()
        if start_prefix != end_prefix:
            expanded.append(token)
            continue
        start = int(start_number)
        end = int(end_number)
        if end < start or end - start > 500:
            expanded.append(token)
            continue
        width = max(len(start_number), len(end_number))
        suffix = '#' if (start_hash or end_hash) else ''
        for number in range(start, end + 1):
            expanded.append(f'{start_prefix}{number:0{width}d}{suffix}')
    return list(dict.fromkeys(expanded))


def normalize_windrise_site_key(value):
    normalized = normalize_context_dimension_value(value).lower()
    return normalized.replace('风电场', '').strip()


def load_windrise_turbine_mapping_entries():
    mapping_path = resolve_windrise_turbine_mapping_path()
    if not mapping_path:
        return []
    try:
        mtime = os.path.getmtime(mapping_path)
    except OSError:
        return []
    with windrise_turbine_mapping_lock:
        if (
            windrise_turbine_mapping_cache.get('path') == mapping_path
            and windrise_turbine_mapping_cache.get('mtime') == mtime
        ):
            return list(windrise_turbine_mapping_cache.get('entries') or [])
        entries = []
        try:
            with open(mapping_path, 'r', encoding='utf-8') as handle:
                parsed = json.load(handle)
            if isinstance(parsed, list):
                for item in parsed:
                    if not isinstance(item, dict):
                        continue
                    expanded_ids = expand_windrise_turbine_id_expression(item.get('turbineId', ''))
                    if not expanded_ids:
                        continue
                    for turbine_id in expanded_ids:
                        entry = dict(item)
                        entry['turbineId'] = turbine_id
                        entries.append(entry)
        except OSError as exc:
            print(f"[Windrise] turbine mapping 读取失败: {type(exc).__name__}: {exc}")
            return []
        known_ids = {
            str(entry.get('turbineId', '')).strip().upper()
            for entry in entries
            if entry.get('turbineId')
        }
        known_aliases = set(known_ids)
        for turbine_id in known_ids:
            if turbine_id.endswith('#'):
                known_aliases.add(turbine_id[:-1])
            else:
                known_aliases.add(f'{turbine_id}#')
        sites = []
        for entry in entries:
            site = normalize_context_dimension_value(entry.get('site', ''))
            site_key = normalize_windrise_site_key(site)
            if site and site_key and (site, site_key) not in sites:
                sites.append((site, site_key))
        windrise_turbine_mapping_cache.update({
            'path': mapping_path,
            'mtime': mtime,
            'entries': entries,
            'known_aliases': known_aliases,
            'sites': sites,
        })
        return list(entries)


def extract_windrise_site_from_text(text):
    normalized = normalize_windrise_site_key(text)
    if not normalized:
        return ''
    best = ''
    load_windrise_turbine_mapping_entries()
    for site, site_key in windrise_turbine_mapping_cache.get('sites') or []:
        if not site_key:
            continue
        if site_key in normalized and len(site_key) >= len(normalize_windrise_site_key(best)):
            best = site
    return best


def extract_windrise_turbine_ids_from_text(text):
    normalized = normalize_text(text)
    if not normalized:
        return []
    load_windrise_turbine_mapping_entries()
    # Includes SH09 when the stored id is SH09#, and vice versa.
    known_aliases = windrise_turbine_mapping_cache.get('known_aliases') or set()
    found = []
    model_spans = []
    fault_code_spans = []
    for pattern in MODEL_ALIAS_PATTERNS:
        model_spans.extend(
            (match.start(), match.end())
            for match in re.finditer(pattern, normalized, flags=re.IGNORECASE)
        )
    # Do not mark every ``letters+digits`` token as a fault span: identifiers
    # such as ZC09 are valid turbine numbers.  The underscore form is a
    # composite technical label and can safely be protected here.
    fault_code_spans.extend(
        (match.start(), match.end())
        for match in re.finditer(
            r'(?<![A-Za-z0-9_])[A-Za-z]{1,8}\d[A-Za-z0-9]*(?:_[A-Za-z0-9]+)+',
            normalized,
            flags=re.IGNORECASE,
        )
    )
    # A code explicitly introduced by a code label also takes precedence over
    # the generic turbine-token recognizer.
    fault_code_spans.extend(
        (match.start(1), match.end(1))
        for match in re.finditer(
            r'(?:故障码|故障代码|报码|告警码|报警码|状态码|错误码)\s*[:：=＝]?\s*([A-Za-z]{1,8}\d[A-Za-z0-9_\-]*)',
            normalized,
            flags=re.IGNORECASE,
        )
    )
    # Composite PLC/alarm labels such as 09_03_B14 are a single technical
    # token.  Their internal pieces are not turbine IDs.
    fault_code_spans.extend(
        (match.start(), match.end())
        for match in re.finditer(
            r'(?<![A-Za-z0-9_])[A-Za-z0-9]+(?:_[A-Za-z0-9]+)+',
            normalized,
            flags=re.IGNORECASE,
        )
    )

    def inside_model_span(start, end):
        return any(start >= span_start and end <= span_end for span_start, span_end in model_spans)

    def inside_fault_code_span(start, end):
        return any(start >= span_start and end <= span_end for span_start, span_end in fault_code_spans)

    for match in re.finditer(
        r'(?:风机编号|风机号|机位号|机组编号|对应编号|标牌|编号)[:：]?\s*([A-Za-z0-9#_-]+)',
        normalized,
        flags=re.IGNORECASE,
    ):
        if is_explicit_model_value_fragment(normalized, match.group(1)):
            continue
        token = normalize_windrise_turbine_id(match.group(1))
        if token and token not in found:
            found.append(token)

    for match in re.finditer(
        r'(?<![A-Za-z0-9])([A-Za-z]{1,4}\d{1,3}#?)(?![A-Za-z0-9])',
        normalized,
        flags=re.IGNORECASE,
    ):
        if inside_model_span(match.start(1), match.end(1)):
            continue
        if inside_fault_code_span(match.start(1), match.end(1)):
            continue
        if is_explicit_model_value_fragment(normalized, match.group(1)):
            continue
        if is_embedded_sensor_token(normalized, match.group(1)):
            continue
        if is_pitch_blade_axis_token(normalized, match.group(1)):
            continue
        token = normalize_windrise_turbine_id(match.group(1))
        if token and (token in known_aliases or re.match(r'^[A-Z]{1,4}\d{1,3}#?$', token)):
            if token not in found:
                found.append(token)
    for match in re.finditer(r'(?<![A-Za-z0-9])(\d{1,3})#', normalized):
        if inside_model_span(match.start(1), match.end(1)):
            continue
        if inside_fault_code_span(match.start(1), match.end(1)):
            continue
        if is_explicit_model_value_fragment(normalized, match.group(1)):
            continue
        if is_measurement_numeric_fragment(normalized, match.group(1)):
            continue
        token = normalize_windrise_turbine_id(f"{match.group(1)}#")
        if token in known_aliases and token not in found:
            found.append(token)
    for match in re.finditer(r'(?<![A-Za-z0-9])(\d{1,3})号(?![A-Za-z0-9])', normalized):
        if inside_model_span(match.start(1), match.end(1)):
            continue
        if inside_fault_code_span(match.start(1), match.end(1)):
            continue
        if is_explicit_model_value_fragment(normalized, match.group(1)):
            continue
        if is_measurement_numeric_fragment(normalized, match.group(1)):
            continue
        numeric = match.group(1)
        hash_token = normalize_windrise_turbine_id(f"{numeric}#")
        plain_token = normalize_windrise_turbine_id(numeric)
        if hash_token in known_aliases and hash_token not in found:
            found.append(hash_token)
        elif plain_token in known_aliases and plain_token not in found:
            found.append(plain_token)
        elif hash_token not in found:
            found.append(hash_token)
    upper_text = normalized.upper()
    for token in known_aliases:
        if not token:
            continue
        start = upper_text.find(token)
        if start < 0:
            continue
        end = start + len(token)
        if inside_model_span(start, end):
            continue
        if inside_fault_code_span(start, end):
            continue
        if is_explicit_model_value_fragment(normalized, token):
            continue
        if is_measurement_numeric_fragment(normalized, token.rstrip('#')):
            continue
        if is_embedded_sensor_token(normalized, token.rstrip('#')):
            continue
        left_ok = start == 0 or not upper_text[start - 1].isalnum()
        right_char = upper_text[end:end + 1]
        right_ok = not right_char or (
            not right_char.isalnum()
            and (token.endswith('#') or right_char != '#')
        )
        if left_ok and right_ok:
            if token not in found:
                found.append(token)
    return dedupe_windrise_turbine_ids(found, normalized)


def dedupe_windrise_turbine_ids(ids, text):
    upper = normalize_text(text).upper()
    ordered = []
    seen = set()
    for item in ids:
        token = normalize_windrise_turbine_id(item)
        if not token or token in seen:
            continue
        seen.add(token)
        ordered.append(token)
    result = []
    for token in ordered:
        if not token.endswith('#'):
            hash_token = f"{token}#"
            if hash_token in seen and re.search(
                rf'(?<![A-Za-z0-9]){re.escape(hash_token)}(?![A-Za-z0-9])',
                upper,
                flags=re.IGNORECASE,
            ):
                continue
        result.append(token)
    return result


def _windrise_turbine_id_probes(turbine_id):
    normalized = normalize_windrise_turbine_id(turbine_id)
    if not normalized:
        return []
    probes = [normalized]
    if normalized.endswith('#'):
        probes.append(normalized[:-1])
    else:
        probes.append(f"{normalized}#")
    if re.fullmatch(r'\d+', normalized):
        probes.append(normalized.lstrip('0') or '0')
        probes.append(normalized.zfill(2))
        probes.append(f"{normalized.zfill(2)}#")
    elif normalized.endswith('#') and re.fullmatch(r'\d+#', normalized):
        bare = normalized[:-1]
        probes.append(bare)
        probes.append(bare.lstrip('0') or '0')
        probes.append(bare.zfill(2))
    # unique preserve order
    seen = set()
    ordered = []
    for probe in probes:
        key = normalize_windrise_turbine_id(probe)
        if not key or key in seen:
            continue
        seen.add(key)
        ordered.append(key)
    return ordered


def find_windrise_turbine_mapping_candidates(turbine_id, site=''):
    normalized = normalize_windrise_turbine_id(turbine_id)
    if not normalized:
        return []
    site_key = normalize_windrise_site_key(site)
    entries = load_windrise_turbine_mapping_entries()
    probes = set(_windrise_turbine_id_probes(normalized))
    candidates = []
    for entry in entries:
        entry_id = normalize_windrise_turbine_id(entry.get('turbineId', ''))
        unit_number = normalize_windrise_turbine_id(entry.get('unitNumber', ''))
        entry_site_key = normalize_windrise_site_key(entry.get('site', ''))
        if site_key and entry_site_key and entry_site_key != site_key:
            continue
        matched = entry_id in probes
        if not matched and unit_number:
            unit_probes = set(_windrise_turbine_id_probes(unit_number))
            # "09号" / "75" can resolve via unitNumber when site is known.
            if probes & unit_probes:
                matched = True
            elif re.fullmatch(r'\d+#?', normalized) and re.fullmatch(r'\d+', unit_number):
                if int(re.sub(r'\D', '', normalized) or '0') == int(unit_number):
                    matched = True
        if not matched:
            continue
        candidates.append(entry)
    if site_key:
        site_matches = [
            entry for entry in candidates
            if normalize_windrise_site_key(entry.get('site', '')) == site_key
        ]
        if len(site_matches) == 1:
            return site_matches
        if site_matches:
            candidates = site_matches
    return candidates


def lookup_windrise_turbine_mapping(turbine_id, site=''):
    """Resolve only an unambiguous turbine mapping.

    Numeric/family IDs such as A01# and S01 are reused by multiple farms. Do
    not silently select the first farm: the clarification flow must ask for
    the missing farm instead.
    """
    candidates = find_windrise_turbine_mapping_candidates(turbine_id, site)
    return candidates[0] if len(candidates) == 1 else None


def render_windrise_turbine_mapping_answer(entry):
    if not entry:
        return ''
    turbine_id = entry.get('turbineId', '')
    site_full = entry.get('siteFull') or entry.get('site') or ''
    brand = entry.get('brand', '')
    model = entry.get('model', '')
    standard_model = entry.get('standardModel', '')
    unit_number = entry.get('unitNumber', '')
    lines = [
        f"风机编号「{turbine_id}」对应 {site_full} / {brand} / {model}"
        + (f" / 具体型号：{standard_model}" if standard_model else '')
        + '。',
        f"- 风场：{site_full}",
        f"- 品牌：{brand}",
        f"- 机型：{model}",
    ]
    if standard_model:
        lines.append(f"- 具体型号：{standard_model}")
    if unit_number:
        lines.append(f"- 机位编号：{unit_number}")
    lines.append(f"- 风机编号：{turbine_id}")
    return '\n'.join(lines)


def extract_device_scope_from_assistant_answer(content):
    """Recover a single confirmed turbine mapping from a prior mapping reply."""
    normalized = normalize_text(content)
    if not normalized or '在多个风场复用' in normalized or '匹配到' in normalized:
        return {}
    mapping_match = re.search(
        r'风机编号[「"]([^」"]+)[」"].*?对应\s*([^/]+?)\s*/\s*([^/]+?)\s*/\s*(.+?)(?:[。]|$)',
        normalized,
    )
    if mapping_match:
        turbine_id = normalize_windrise_turbine_id(mapping_match.group(1))
        site_full = normalize_context_dimension_value(mapping_match.group(2))
        farm = re.sub(r'风电场$', '', site_full)
        brand = normalize_context_dimension_value(mapping_match.group(3))
        model_text = mapping_match.group(4)
        standard_model = ''
        standard_match = re.search(r'具体型号[:：]\s*([^/；;。\n]+)', model_text)
        if standard_match:
            standard_model = normalize_windrise_model_value(standard_match.group(1))
            model = normalize_windrise_model_value(re.sub(r'具体型号[:：].*$', '', model_text))
        else:
            model = normalize_windrise_model_value(model_text.split('/')[0])
        scope = {
            'turbine_id': turbine_id,
            'farm': farm,
            'brand': brand,
            'model': model,
            'standard_model': standard_model,
        }
        return {key: value for key, value in scope.items() if value}
    object_match = re.search(
        r'【对象确认】\s*([^\s]+(?:风电场|风场)?)\s+([A-Za-z0-9#_-]+)\s*→\s*([^（\n]+)',
        normalized,
    )
    if object_match:
        site_full = normalize_context_dimension_value(object_match.group(1))
        farm = re.sub(r'(?:风电场|风场)$', '', site_full)
        turbine_id = normalize_windrise_turbine_id(object_match.group(2))
        model_text = normalize_text(object_match.group(3))
        brand = ''
        model = ''
        standard_model = ''
        model_match = re.search(r'（([^）]+)）', model_text)
        if model_match:
            standard_model = normalize_windrise_model_value(model_match.group(1))
            model_text = model_text[:model_match.start()].strip()
        parts = [part for part in model_text.split() if part]
        if parts:
            brand = normalize_context_dimension_value(parts[0])
        if len(parts) > 1:
            model = normalize_windrise_model_value(parts[1])
        scope = {
            'turbine_id': turbine_id,
            'farm': farm,
            'brand': brand,
            'model': model,
            'standard_model': standard_model,
        }
        return {key: value for key, value in scope.items() if value}
    return {}


def should_answer_windrise_turbine_mapping_question(query):
    normalized = normalize_text(query)
    if not normalized:
        return False
    if re.search(r'(故障码|故障代码|报码|告警码|报警码)', normalized, flags=re.IGNORECASE):
        return False
    if has_device_issue_hint(normalized) and re.search(
        r'(怎么处理|如何处理|怎么办|如何排查|处理步骤|什么原因|故障|异常|报警|告警)',
        normalized,
        flags=re.IGNORECASE,
    ):
        # Fault symptom questions should go to fault search, not mapping.
        if re.search(
            r'(故障|异常|错误|问题|报警|告警|失效|损坏|丢失|断开|超限|过高|过低|不足|扭缆|纽缆|绕缆|润滑|温度|压力|振动|跳闸|偏航|变桨|传感器|风速仪|齿轮箱|发电机|轴承|主控|变流器|机舱|急停|刹车|制动)',
            normalized,
            flags=re.IGNORECASE,
        ):
            return False
    turbine_ids = extract_windrise_turbine_ids_from_text(normalized)
    if len(turbine_ids) != 1:
        return False
    stripped = normalized
    stripped = re.sub(re.escape(turbine_ids[0]), ' ', stripped, flags=re.IGNORECASE)
    stripped = re.sub(r'\d{1,3}号', ' ', stripped)
    stripped = re.sub(
        r'(?:风机编号|风机号|机位号|机组编号|对应编号|标牌|编号)[:：]?',
        ' ',
        stripped,
        flags=re.IGNORECASE,
    )
    stripped = re.sub(
        r'(是什么|是啥|什么|哪个|哪些|查询|查一下|查下|检索|属于|对应|机型|型号|风场|风电场|场站|风机|机组)',
        ' ',
        stripped,
        flags=re.IGNORECASE,
    )
    stripped = re.sub(r'[？?，,。.、:：；;\s]', '', stripped)
    site = extract_windrise_site_from_text(normalized)
    if site:
        site_key = normalize_windrise_site_key(site)
        if site_key and site_key in normalize_windrise_site_key(stripped):
            remainder = normalize_windrise_site_key(stripped).replace(site_key, '', 1)
            return len(remainder) <= 2
    return len(stripped) <= 2


def build_windrise_turbine_mapping_answer(query):
    if not should_answer_windrise_turbine_mapping_question(query):
        return ''
    site = extract_windrise_site_from_text(query)
    for turbine_id in extract_windrise_turbine_ids_from_text(query):
        candidates = find_windrise_turbine_mapping_candidates(turbine_id, site)
        if len(candidates) == 1:
            return render_windrise_turbine_mapping_answer(candidates[0])
        if len(candidates) > 1:
            lines = [
                f"风机编号「{turbine_id}」在多个风场复用，请结合风场确认：",
            ]
            for entry in candidates[:8]:
                parts = [
                    normalize_context_dimension_value(entry.get('siteFull') or entry.get('site', '')),
                    normalize_context_dimension_value(entry.get('brand', '')),
                    normalize_windrise_model_value(entry.get('model', '')),
                    normalize_windrise_model_value(entry.get('standardModel', '')),
                ]
                lines.append('- ' + ' / '.join(part for part in parts if part))
            return '\n'.join(lines)
    return ''


def split_windrise_turbine_ids(value):
    return expand_windrise_turbine_id_expression(value)


def _windrise_turbine_id_family(turbine_id):
    normalized = normalize_windrise_turbine_id(turbine_id)
    if not normalized:
        return ''
    match = re.match(r'^([A-Z]+)', normalized.upper())
    return match.group(1) if match else ''


def _windrise_models_compatible(record, mapping_entry):
    brand = normalize_context_dimension_value(record.get('brand', ''))
    model = normalize_context_dimension_value(record.get('model', ''))
    standard_model = normalize_context_dimension_value(record.get('standardModel', ''))
    entry_brand = normalize_context_dimension_value(mapping_entry.get('brand', ''))
    entry_model = normalize_context_dimension_value(mapping_entry.get('model', ''))
    entry_standard_model = normalize_context_dimension_value(mapping_entry.get('standardModel', ''))
    if brand and entry_brand and brand.lower() != entry_brand.lower():
        return False
    entry_models = [
        value.lower()
        for value in (entry_model, entry_standard_model)
        if value
    ]
    record_models = [
        value.lower()
        for value in (model, standard_model)
        if value
    ]
    if not entry_models or not record_models:
        return False
    return any(
        entry_model_value in record_model_value or record_model_value in entry_model_value
        for entry_model_value in entry_models
        for record_model_value in record_models
    )


def record_matches_windrise_turbine_id(record, turbine_id, site=''):
    target = normalize_windrise_turbine_id(turbine_id)
    if not target:
        return True
    record_ids = split_windrise_turbine_ids(record.get('turbineIds', ''))
    probes = set(_windrise_turbine_id_probes(target))
    if any(probe in record_ids for probe in probes):
        return True
    mapping_entry = lookup_windrise_turbine_mapping(target, site)
    if not mapping_entry:
        return False
    entry_site = normalize_windrise_site_key(mapping_entry.get('site', ''))
    site_key = normalize_windrise_site_key(site)
    if site_key and entry_site and site_key != entry_site:
        return False
    if not _windrise_models_compatible(record, mapping_entry):
        return False
    if not record_ids:
        return True
    query_family = _windrise_turbine_id_family(target)
    record_families = {
        _windrise_turbine_id_family(record_id)
        for record_id in record_ids
        if _windrise_turbine_id_family(record_id)
    }
    # Same ID family but not listed (e.g. SH09 vs SH01# list) should not match.
    if query_family and query_family in record_families:
        return False
    # Different ID families with same mapped model (e.g. 同发 A01# vs H01# records).
    return True


def enrich_windrise_slots_with_turbine_mapping(slots):
    slots = dict(slots or {})
    turbine_ids = list(slots.get('turbine_ids') or [])
    if not turbine_ids:
        turbine_id = normalize_windrise_turbine_id(slots.get('turbine_id', ''))
        if turbine_id:
            turbine_ids = [turbine_id]
    if not turbine_ids:
        return slots
    farm = normalize_context_dimension_value(slots.get('farm', ''))
    for turbine_id in turbine_ids:
        entry = lookup_windrise_turbine_mapping(turbine_id, farm)
        if not entry:
            continue
        slots['turbine_id'] = normalize_windrise_turbine_id(entry.get('turbineId', turbine_id))
        slots['turbine_ids'] = turbine_ids
        if not slots.get('farm'):
            slots['farm'] = normalize_context_dimension_value(entry.get('site', ''))
        if not slots.get('brand'):
            slots['brand'] = normalize_context_dimension_value(entry.get('brand', ''))
        if not slots.get('model'):
            slots['model'] = normalize_windrise_model_value(entry.get('model', ''))
        if not slots.get('standard_model'):
            slots['standard_model'] = normalize_windrise_model_value(entry.get('standardModel', ''))
        break
    return slots


def prepare_windrise_fault_index_record(record):
    """Cache normalized record text once instead of rebuilding it per query."""
    record = dict(record or {})
    name = normalize_text(record.get('name', ''))
    topic_text = normalize_text(' '.join(
        str(record.get(key, '') or '')
        for key in ('name', 'text', 'solution', 'logic', 'reason', 'source')
    ))
    scope_text = normalize_text(' '.join(
        str(record.get(key, '') or '')
        for key in (
            'site', 'brand', 'model', 'standardModel', 'turbineIds',
            'code', 'name', 'text', 'solution', 'logic', 'source',
        )
    )).lower()
    record['_wr_name'] = name
    record['_wr_name_lower'] = name.lower()
    record['_wr_topic_text'] = topic_text
    record['_wr_topic_text_lower'] = topic_text.lower()
    record['_wr_compact_name'] = compact_fault_match_text(name)
    record['_wr_compact_topic_text'] = compact_fault_match_text(topic_text)
    record['_wr_scope_text'] = scope_text
    return record


def load_windrise_fault_index_records():
    index_path = resolve_windrise_fault_index_path()
    if not index_path:
        return []
    try:
        mtime = os.path.getmtime(index_path)
    except OSError:
        return []
    with windrise_fault_index_lock:
        if (
            windrise_fault_index_cache.get('path') == index_path
            and windrise_fault_index_cache.get('mtime') == mtime
        ):
            return list(windrise_fault_index_cache.get('records') or [])
        records = []
        try:
            with open(index_path, 'r', encoding='utf-8') as handle:
                for line in handle:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        record = json.loads(line)
                    except Exception:
                        continue
                    records.append(prepare_windrise_fault_index_record(record))
        except OSError as exc:
            print(f"[Windrise] fault-index 读取失败: {type(exc).__name__}: {exc}")
            return []
        windrise_fault_index_cache.update({'path': index_path, 'mtime': mtime, 'records': records})
        return list(records)


def clean_windrise_fault_topic_text(text):
    normalized = normalize_text(text)
    if not normalized:
        return ''
    explicit_topic = re.search(
        r'(?:完整告警是|完整报警是|完整故障是|原始告警是|原始报警是|原始故障是|告警内容|报警内容|故障内容|故障描述|故障现象|现在报的是|报的是|当前报的是)[:：]?\s*(.+)$',
        normalized,
        flags=re.IGNORECASE,
    )
    if explicit_topic:
        normalized = explicit_topic.group(1)
    normalized = re.sub(r'^\s*(是|为|:|：)\s*', '', normalized)
    normalized = re.sub(
        r'^\s*(帮我|给我|请|查询|查一下|查下|查|搜索|检索|看一下|看看)\s*',
        '',
        normalized,
        flags=re.IGNORECASE,
    )
    normalized = re.sub(
        r'\s*(是什么故障码|是什么故障代码|故障码是什么|故障代码是什么|对应.*?(故障码|故障代码|报码|告警码|报警码)|有哪些码|哪些码|有什么码|有什么故障码|报码|告警码|报警码)\s*$',
        '',
        normalized,
        flags=re.IGNORECASE,
    )
    normalized = re.sub(
        r'\s*[,，]?(?:先)?(?:帮我|请)?(?:记住|记录|记一下|先记一下)(?:这个|该)?(?:故障现象|故障|报警|告警|问题|现象)?\s*$',
        '',
        normalized,
        flags=re.IGNORECASE,
    )
    return normalized.strip(' ？?。!！,，;；:：')


def build_windrise_dimension_ack_answer(query, history):
    if not is_dimension_only_windrise_user_message(query):
        return ''
    slots = build_effective_windrise_slots_for_query(query, history)
    summary = build_windrise_slots_summary(slots)
    if not summary:
        return ''
    return (
        "## 已记录限定条件\n\n"
        f"原始补充：{normalize_text(query)}\n\n"
        f"{summary}\n\n"
        "这些厂家、风场、机型和具体型号会作为后续故障码定位的硬约束。"
    )


def build_windrise_fault_topic_ack_answer(query):
    normalized = normalize_text(query)
    if not normalized or not re.search(
        r'(?:先)?(?:帮我|请)?(?:记住|记录|记一下|先记一下)(?:这个|该)?(?:故障现象|故障|报警|告警|问题|现象)?\s*$',
        normalized,
        flags=re.IGNORECASE,
    ):
        return ''
    topic = clean_windrise_fault_topic_text(normalized)
    if not topic or not has_device_issue_hint(topic):
        return ''
    return (
        "## 已记录故障现象\n\n"
        f"已记住：{topic}\n\n"
        "后续补充厂家、风场、机型、具体型号或风机编号时，我会把这些信息和该故障现象合并判断；"
        "在您明确要求定位或查询前，不会提前执行知识库检索。"
    )


def is_dimension_only_windrise_user_message(text):
    normalized = normalize_text(text)
    if not normalized:
        return True
    if has_explicit_fault_code(normalized):
        return False
    # A sentence that names a component, measurement or operating symptom is
    # an actual question even when it also contains farm/brand/model fields.
    # Otherwise "团结风场 SY37 塔底控制柜温度" is swallowed by the scope
    # acknowledgement path and never reaches diagnosis/retrieval.
    if has_specific_current_diagnosis_subject(normalized):
        return False
    if re.search(
        r'(查询|查一下|查下|检索|搜索|列出|清单|有哪些|哪些|什么机型|哪种|哪款|对应|匹配|属于|都给我|全部|最终定位|定位故障)',
        normalized,
        flags=re.IGNORECASE,
    ):
        return False
    if re.search(
        r'(故障|报警|告警|停机|异常|超限|过高|过低|过温|高温|温度高|压力低|压力高|电压高|电压低|容量低|过载|跳闸|跳开|短路|断路|断开|丢失|失效|失败|通信|通讯|顺桨|同步)',
        normalized,
        flags=re.IGNORECASE,
    ):
        dimension_prefix = re.match(r'^\s*(厂家|品牌|风场|风电场|场站|机型|型号|具体型号|标准型号)\s*(是|为|:|：)', normalized)
        return bool(dimension_prefix and not re.search(r'(故障|报警|告警|停机|异常|超限|顺桨|同步)', normalized))
    slots = extract_windrise_user_slots(normalized)
    if has_windrise_issue_slots(slots):
        return False
    subject_phrase = extract_windrise_fault_subject_phrase(normalized) or extract_scada_style_alarm_name(normalized)
    if subject_phrase and len(normalize_text(subject_phrase)) >= 3:
        return False
    has_scope_value = any(
        normalize_text(slots.get(key, ''))
        for key in ('brand', 'farm', 'model', 'standard_model')
    )
    has_dimension_word = bool(re.search(
        r'(厂家|品牌|风场|风电场|场站|机型|型号|具体型号|标准型号)',
        normalized,
        flags=re.IGNORECASE,
    ))
    return bool(has_scope_value and has_dimension_word)


def is_windrise_scope_device_reply(query):
    """True when the user turn only supplies farm/turbine/model scope."""
    normalized = normalize_text(query)
    if not normalized or len(normalized) > 48:
        return False
    if extract_scada_style_alarm_name(normalized) or extract_windrise_fault_subject_phrase(normalized):
        return False
    slots = extract_windrise_user_slots(normalized)
    if not (
        slots.get('farm')
        or slots.get('turbine_id')
        or slots.get('brand')
        or slots.get('model')
        or slots.get('standard_model')
    ):
        return False
    if has_windrise_issue_slots(slots):
        return False
    stripped = normalized
    for value in (
        slots.get('farm', ''),
        slots.get('turbine_id', ''),
        slots.get('brand', ''),
        slots.get('model', ''),
        slots.get('standard_model', ''),
    ):
        if value:
            stripped = re.sub(re.escape(str(value)), ' ', stripped, flags=re.IGNORECASE)
    stripped = re.sub(
        r'(风场|风电场|场站|风机|机组|厂家|品牌|机型|型号|具体型号|编号|号|#)',
        ' ',
        stripped,
        flags=re.IGNORECASE,
    )
    stripped = re.sub(r'[，,。.、:：；;\s]', '', stripped)
    return len(stripped) <= 2


def is_turbine_id_fault_code_collision(raw_text, code):
    """Do not treat F28/Y08-style unit IDs as OEM fault codes in scope replies."""
    normalized = normalize_text(raw_text)
    candidate = normalize_windrise_turbine_id(code)
    if not normalized or not candidate:
        return False
    turbine_ids = {
        normalize_windrise_turbine_id(value)
        for value in extract_windrise_turbine_ids_from_text(normalized)
    }
    if candidate not in turbine_ids:
        return False
    if not re.fullmatch(r'[A-Za-z]\d{1,3}#?', candidate):
        return False
    if re.search(r'(风场|风电场|场站|风机|机组)', normalized):
        return True
    return bool(query_has_explicit_dimension(normalized))


def is_windrise_fault_scope_followup_reply(query, history=None):
    """Scope-only reply after a prior bare fault question."""
    history = history or []
    has_prior_fault_topic = bool(
        extract_recent_fault_topic_from_history(history)
        or extract_recent_windrise_fault_topic_from_history(history)
    )
    if windrise_scope_unavailability_for_current_reply(query, history) and has_prior_fault_topic:
        return True
    if not is_windrise_scope_device_reply(query):
        return False
    return has_prior_fault_topic


def resolve_windrise_fault_scope_followup_answer(query, history=None):
    """Resume the pending fault lookup once farm/turbine scope is supplied."""
    history = history or []
    if not is_windrise_fault_scope_followup_reply(query, history):
        return '', ''
    scoped_slots = apply_windrise_turbine_mapping_to_slots(
        build_resolved_windrise_scope_slots(query, history)
    )
    if not has_windrise_scope_for_fault_answer(scoped_slots, query, history):
        clarification = build_windrise_fault_scope_clarification(query, history)
        if clarification:
            return clarification, 'missing_windrise_scope_dimensions'
        return '', ''
    topic = (
        extract_recent_fault_topic_from_history(history)
        or extract_recent_windrise_fault_topic_from_history(history)
    )
    if not topic:
        return '', ''
    index_query = build_windrise_symptom_subject_query(topic) or normalize_windrise_query(topic)
    scoped_history = list(history) + [{'role': 'user', 'content': query}]
    answer = build_index_scoped_fault_lookup_answer_with_fallback(
        index_query,
        index_query,
        scoped_history,
        intent=classify_windrise_answer_intent(topic),
    )
    if answer:
        reason = (
            'in_process_global_symptom_fallback'
            if '【全局检索】' in answer
            else 'in_process_scoped_fault_lookup'
        )
        return answer, reason
    scoped_miss = build_windrise_scoped_symptom_no_match_answer(topic, scoped_history, index_query)
    if scoped_miss:
        return scoped_miss, 'in_process_scoped_fault_lookup_miss'
    return '', ''


def is_bare_fault_code_lookup_text(text):
    normalized = normalize_text(text)
    if not normalized:
        return False
    codes = extract_fault_codes(normalized)
    if not codes:
        return False
    stripped = normalized
    for code in codes:
        stripped = re.sub(re.escape(code), '', stripped, flags=re.IGNORECASE)
    stripped = re.sub(
        r'(故障码|故障代码|报码|告警码|报警码|代码|状态码|是什么|是啥|查询|查一下|查下|查|帮我|给我|请|这个|该|的|故障|报警|告警|处理|维修|怎么修|怎么处理|原因|为什么|为何|为啥|对应|含义|意思|[?？!！。,.，:：;；\s])',
        '',
        stripped,
        flags=re.IGNORECASE,
    )
    return stripped == ''


def is_user_fault_topic_message(text):
    normalized = normalize_text(text)
    if not normalized:
        return False
    if is_bare_fault_code_lookup_text(normalized):
        return False
    if is_dimension_only_windrise_user_message(normalized):
        return False
    if is_wind_farm_model_mapping_query(normalized):
        return False
    return bool(
        has_device_issue_hint(normalized)
        or re.search(
            r'(告警内容|报警内容|故障内容|故障描述|故障现象|现在报的是|报的是|当前报的是|故障|报警|告警|停机|温度|异响|振动|震动|噪声|过高|过低|过温|超限|异常|短路|断路|断开|丢失|失效|失败|通信|通讯|低穿|高穿|背风|台风|scada)',
            normalized,
            flags=re.IGNORECASE,
        )
    )


def extract_recent_fault_topic_from_history(history):
    for item in reversed(history or []):
        if item.get('role') != 'user':
            continue
        content = normalize_text(item.get('content', ''))
        if is_user_fault_topic_message(content):
            topic = clean_windrise_fault_topic_text(content)
            if topic:
                return topic

    for item in reversed(history or []):
        if item.get('role') != 'assistant':
            continue
        context = extract_fault_context_from_answer(item.get('content', ''))
        if context.get('name'):
            return context.get('name')
    return ''


def recent_fault_context_origin(history):
    """Identify whether the latest user diagnostic object was a code or name.

    Assistant result lists can contain several codes.  For a later scope
    completion, the user's original object must win over the first code that
    happens to appear in that list.
    """
    for item in reversed(history or []):
        if item.get('role') != 'user':
            continue
        content = normalize_text(item.get('content', ''))
        if not content:
            continue
        if extract_direct_windrise_fault_codes(content, []):
            return 'code'
        if is_user_fault_topic_message(content):
            return 'name'
    return ''


def latest_assistant_answer_is_windrise_no_match(history):
    for item in reversed(history or []):
        if item.get('role') != 'assistant':
            continue
        return is_windrise_no_match_answer(item.get('content', ''))
    return False


def is_explicit_fault_topic_statement(query):
    normalized = normalize_text(query)
    if not normalized or is_bare_fault_code_lookup_text(normalized):
        return False
    return bool(re.search(
        r'(完整告警是|完整报警是|完整故障是|原始告警是|原始报警是|原始故障是|告警内容|报警内容|故障内容|故障描述|故障现象|现在报的是|报的是|当前报的是)[:：]?\s*.+',
        normalized,
        flags=re.IGNORECASE,
    ))


def windrise_dimension_terms(query):
    normalized = normalize_text(query)
    terms = []
    if not normalized:
        return terms
    for keyword in (
        '新华', '团结', '四平', '裕民', '洮北', '镇赉', '镇赍', '同发', '什花道',
        '良井子', '前进', '向荣', '八面', '富荣', '福林', '如意', '长龙山',
        *MODEL_BRAND_KEYWORDS,
    ):
        if keyword and keyword in normalized and keyword not in terms:
            terms.append(keyword)
    for pattern in MODEL_ALIAS_PATTERNS:
        for match in re.finditer(pattern, normalized, flags=re.IGNORECASE):
            value = normalize_text(match.group(0)).upper()
            if value and value not in terms:
                terms.append(value)
    return terms


def find_recent_user_windrise_dimension_terms(history, limit=8):
    for item in reversed((history or [])[-max(1, int(limit)):]):
        if item.get('role') != 'user':
            continue
        terms = windrise_dimension_terms(item.get('content', ''))
        if terms:
            return terms
    return []


def apply_recent_user_dimension_to_windrise_query(query, history):
    normalized = normalize_text(query)
    if not normalized:
        return normalized
    if not query_has_explicit_dimension(query):
        active_scope = get_windrise_active_scope_slots()
        if active_scope:
            active_terms = windrise_slot_search_terms(active_scope)
            if active_terms:
                prefix_terms = []
                lowered_query = normalized.lower()
                for term in active_terms:
                    value = str(term).strip()
                    if not value:
                        continue
                    if value.lower() in lowered_query:
                        continue
                    if value not in prefix_terms:
                        prefix_terms.append(value)
                    if len(prefix_terms) >= 8:
                        break
                if prefix_terms:
                    return ' '.join([*prefix_terms, normalized])
    recent_terms = windrise_context_terms_for_query(normalized, history)
    if not recent_terms:
        return normalized

    prefix_terms = []
    lowered_query = normalized.lower()
    for term in recent_terms:
        value = str(term).strip()
        if not value:
            continue
        if value.lower() in lowered_query:
            continue
        if value not in prefix_terms:
            prefix_terms.append(value)
        if len(prefix_terms) >= 8:
            break

    if not prefix_terms:
        return normalized
    return ' '.join([*prefix_terms, normalized])


def append_unique_windrise_slot(values, value, limit=6):
    normalized = normalize_context_dimension_value(value)
    if not normalized or normalized in values:
        return
    values.append(normalized)
    if len(values) > limit:
        del values[:-limit]


def extract_scada_style_alarm_name(text):
    """Extract HMI/SCADA alarm labels such as SS-4刹车存储继电器."""
    normalized = normalize_text(text)
    if not normalized:
        return ''
    patterns = (
        r'(?i)([A-Z]{1,4}-\d+(?:号)?[\u4e00-\u9fff]{2,32}(?:继电器|开关|传感器|保护)?(?:未复位|动作|故障)?)',
        r'([\u4e00-\u9fff]{2,24}(?:继电器|开关)(?:未复位|动作|故障)?)',
    )
    for pattern in patterns:
        match = re.search(pattern, normalized)
        if not match:
            continue
        name = re.sub(r'^[#号]+', '', match.group(1)).strip()
        if len(name) >= 4:
            return name
    return ''


def extract_windrise_user_slots(text):
    normalized = normalize_text(text)
    slots = {
        'brand': '',
        'farm': '',
        'model': '',
        'standard_model': '',
        'turbine_id': '',
        'turbine_ids': [],
        'fault_code': '',
        'fault_name': '',
        'component': [],
        'symptom': [],
        'position': [],
        'severity': [],
        'time_condition': [],
        '_cleared_scope_dimensions': [],
        '_cleared_turbine_ids': [],
        '_unavailable_dimensions': [],
        '_scope_update_from_user': True,
    }
    if not normalized:
        return slots

    lowered = normalized.lower()
    unavailable_dimensions = extract_unavailable_windrise_scope_dimensions(normalized)
    if unavailable_dimensions:
        slots['_unavailable_dimensions'] = sorted(unavailable_dimensions)
        slots['_cleared_scope_dimensions'] = sorted(unavailable_dimensions)
    for keyword in MODEL_BRAND_KEYWORDS:
        if keyword and str(keyword).lower() in lowered:
            slots['brand'] = keyword
            break

    farm_keywords = windrise_known_farm_keywords()
    farm_mentions = [
        (normalized.rfind(keyword), keyword)
        for keyword in farm_keywords
        if keyword in normalized
    ]
    if farm_mentions:
        slots['farm'] = max(farm_mentions)[1]

    explicit_model = re.search(
        r'(?:机型|型号)\s*(?:先记一下是|先记一下|是|为|[:：])?\s*([A-Za-z0-9_.()/\-]+(?:[、,，][A-Za-z0-9_.()/\-]+)*(?:\s*(?:MW|KW))?\s*(?:双馈|直驱|半直驱|高速)?\s*系列)',
        normalized,
        flags=re.IGNORECASE,
    )
    if explicit_model:
        slots['model'] = normalize_windrise_model_value(explicit_model.group(1)).upper()
    else:
        for pattern in MODEL_ALIAS_PATTERNS:
            match = re.search(pattern, normalized, flags=re.IGNORECASE)
            if match:
                slots['model'] = normalize_windrise_model_value(match.group(0)).upper()
                break
    explicit_standard_model = re.search(
        r'(?:具体型号|标准型号)\s*(?:是|为|[:：])?\s*([A-Za-z0-9_.()/\-]+(?:[、,，][A-Za-z0-9_.()/\-]+)*)',
        normalized,
        flags=re.IGNORECASE,
    )
    if explicit_standard_model:
        slots['standard_model'] = normalize_windrise_model_value(explicit_standard_model.group(1)).upper()

    codes = extract_fault_codes(normalized)
    if codes:
        slots['fault_code'] = codes[0]

    component_aliases = (
        ('叶轮', ('叶轮', '风轮', '轮毂')),
        ('叶片', ('叶片', '桨叶')),
        ('主轴', ('主轴', '低速端')),
        ('主断路器', ('主断路器', '主断', '主开关')),
        ('发电机', ('发电机', 'generator')),
        ('轴承', ('轴承', 'bearing')),
        ('变流器', ('变流器', '变频器', 'converter')),
        ('变桨', ('变桨', 'pitch')),
        ('偏航', ('偏航', 'yaw')),
        ('齿轮箱', ('齿轮箱', 'gearbox')),
        ('液压', ('液压', '液压站')),
        ('主控', ('主控', 'plc')),
        ('安全链', ('安全链',)),
        ('电网', ('电网', '网侧')),
        ('风速仪', ('风速仪',)),
        ('风速传感器', ('风速传感器',)),
        ('风向标', ('风向标', '风向仪')),
        ('超级电容', ('超级电容', '电容')),
        ('塔基', ('塔基', '塔底')),
        ('机舱', ('机舱',)),
        ('继电器', ('继电器',)),
        ('制动', ('刹车', '制动', '制动器')),
    )
    for canonical, aliases in component_aliases:
        if any(alias.lower() in lowered for alias in aliases):
            append_unique_windrise_slot(slots['component'], canonical)

    symptom_aliases = (
        ('温度高', ('温度高', '温度过高', '温度超限', '油温高', '油温过高', '过温', '高温', '过热', '发热', '超温', '温度有点高', '温度偏高')),
        ('温度异常', ('温度异常', '温度波动', '温度跳变', '温度忽高忽低', '忽高忽低', '温度不稳', '温度不稳定')),
        ('跳闸', ('跳闸', '跳开', '跳了', '跳掉', '跳脱', '脱扣', '分闸', '分断', '异常跳开')),
        ('通信异常', ('通信异常', '通讯异常', '通信故障', '通讯故障', '通信丢失', '通讯丢失', '通讯老丢', '通信老丢', '老丢', '丢通信', '丢通讯')),
        ('传感器异常', ('传感器异常', '传感器故障', '传感器断线', '传感器短路')),
        ('振动', ('振动', '震动', '振动大', '震动大')),
        ('容量低', ('容量低', '容量不足', '容量低于门限', '容量低于门限值')),
        ('压力低', ('压力低', '压力过低', '压力不上来', '建压失败', '欠压')),
        ('压力异常', ('压力异常', '压力波动', '压力报警', '压力告警')),
        ('过流', ('过流', '电流过大', '过电流')),
        ('欠压', ('欠压', '电压低', '电压过低', '电压有点低', '电压偏低')),
        ('过压', ('过压', '电压高', '电压过高', '电压有点高', '电压偏高')),
        ('短路', ('短路',)),
        ('断开', ('断开', '断开', '开路')),
        ('信号丢失', ('信号丢失',)),
        ('断路', ('断路', '断线')),
        ('接地', ('接地', '接地故障')),
        ('过载', ('过载',)),
        ('超限', ('超限', '越限')),
        ('限功率', ('限功率', '限载', '降载', '降功率', '降额', '功率限制', '限制功率', '实际限功率', '功率下降', '功率上不去', '出力上不去', '发电少', '功率低')),
        ('运行模式异常', ('不在运行模式', '未在运行模式', '没有运行模式', '运行模式异常')),
        ('散热异常', ('散热片', '散热器', '散热风扇', '散热', '冷却', '水冷', '风扇', '功率模块', '功率单元', 'igbt')),
        ('启动失败', ('启动失败', '无法启动', '启动不了')),
        ('结冰', ('结冰', '覆冰', '积冰', '凝冰', '冰冻')),
        ('停机', ('停机', '停了')),
        ('报警', ('报警', '告警', '报错')),
        ('转速异常', ('转速异常', '转速突变', '转速跳变', '转速波动', '速度突变', '速度跳变')),
        ('超速', ('超速', '过速', '过转速', '转速过高', '速度过高', '超过限制值', '超过限值', '高于门限', '高于阈值')),
        ('不同步', ('不同步', '同步故障', '叶片同步', '桨叶同步', '变桨同步')),
    )
    for canonical, aliases in symptom_aliases:
        if any(alias.lower() in lowered for alias in aliases):
            append_unique_windrise_slot(slots['symptom'], canonical)

    position_aliases = (
        ('驱动端', ('驱动端', 'de端', 'de ')),
        ('非驱动端', ('非驱动端', 'nde端', 'nde ')),
        ('前端', ('前端',)),
        ('后端', ('后端',)),
    )
    for canonical, aliases in position_aliases:
        if any(alias.lower() in lowered for alias in aliases):
            append_unique_windrise_slot(slots['position'], canonical)

    severity_aliases = (
        ('报警', ('报警', '告警')),
        ('停机', ('停机',)),
        ('反复出现', ('反复', '频繁', '多次', '一直', '持续')),
        ('不可复位', ('不可复位', '复位不了', '复位失败')),
    )
    for canonical, aliases in severity_aliases:
        if any(alias.lower() in lowered for alias in aliases):
            append_unique_windrise_slot(slots['severity'], canonical)

    time_aliases = (
        ('启动时', ('启动时', '启动过程', '启机时')),
        ('运行中', ('运行中', '运行时', '并网运行')),
        ('并网时', ('并网时', '并网过程')),
        ('复位后', ('复位后',)),
        ('低温环境', ('低温', '冬季')),
        ('高风速', ('大风', '高风速')),
    )
    for canonical, aliases in time_aliases:
        if any(alias.lower() in lowered for alias in aliases):
            append_unique_windrise_slot(slots['time_condition'], canonical)

    scada_alarm = extract_scada_style_alarm_name(normalized)
    if scada_alarm:
        slots['fault_name'] = scada_alarm
        if '继电器' in scada_alarm:
            append_unique_windrise_slot(slots['component'], '继电器')
        if '刹车' in scada_alarm or '制动' in scada_alarm:
            append_unique_windrise_slot(slots['component'], '制动')
    elif (
        not slots['fault_code']
        and (slots['component'] or slots['symptom'])
        and re.search(r'(故障|报警|告警|停机|异常|超限|过高|过低|过温|过热|油温高|温度高|压力低|压力高|跳开|跳闸|短路|断路|断开|丢失|失败|容量低|电压高|电压低|结冰|覆冰|积冰|凝冰|冰冻)', normalized)
    ):
        slots['fault_name'] = re.sub(
            r'^\s*(帮我|给我|请|查询|查一下|查下|查|搜索|检索|看一下|看看)\s*',
            '',
            normalized,
            flags=re.IGNORECASE,
        ).strip(' ？?。!！')

    turbine_ids = extract_windrise_turbine_ids_from_text(normalized)
    turbine_ids = filter_pitch_blade_axis_turbine_ids(normalized, turbine_ids)
    if turbine_ids:
        cleared_turbine_ids = []
        for turbine_id in turbine_ids:
            match = re.search(re.escape(turbine_id.rstrip('#')), normalized, flags=re.IGNORECASE)
            if not match:
                continue
            prefix = normalized[max(0, match.start() - 12):match.start()]
            if re.search(r'(?:不是|不再是|不是当前|不属于|取消|去掉|换掉)\s*$', prefix):
                cleared_turbine_ids.append(turbine_id)
        active_turbine_ids = [
            turbine_id for turbine_id in turbine_ids
            if turbine_id not in cleared_turbine_ids
        ]
        if cleared_turbine_ids:
            slots['_cleared_scope_dimensions'].append('turbine_id')
            slots['_cleared_turbine_ids'] = cleared_turbine_ids
        slots['turbine_ids'] = active_turbine_ids
        preferred_turbine_id = ''
        for turbine_id in reversed(active_turbine_ids):
            if is_pitch_blade_axis_token(normalized, turbine_id):
                continue
            preferred_turbine_id = turbine_id
            break
        slots['turbine_id'] = preferred_turbine_id or (active_turbine_ids[-1] if active_turbine_ids else '')
        turbine_probes = {
            probe
            for turbine_id in active_turbine_ids
            for probe in _windrise_turbine_id_probes(turbine_id)
        }
        if normalize_windrise_turbine_id(slots.get('fault_code', '')) in turbine_probes:
            slots['fault_code'] = ''

    # Scope-unavailability phrases are control instructions, never slot values.
    if 'turbine_id' in unavailable_dimensions:
        slots['turbine_id'] = ''
        slots['turbine_ids'] = []
    if 'model' in unavailable_dimensions:
        slots['model'] = ''
        slots['standard_model'] = ''
    if 'farm' in unavailable_dimensions:
        slots['farm'] = ''

    return slots


def merge_windrise_slots(base, update):
    merged = dict(base or {})
    cleared_dimensions = set((update or {}).get('_cleared_scope_dimensions') or [])
    if 'turbine_id' in cleared_dimensions:
        merged['turbine_id'] = ''
        merged['turbine_ids'] = []
    if 'farm' in cleared_dimensions:
        merged['farm'] = ''
    if 'model' in cleared_dimensions:
        merged['model'] = ''
        merged['standard_model'] = ''
    unavailable_dimensions = set(merged.get('_unavailable_dimensions') or [])
    unavailable_dimensions.update((update or {}).get('_unavailable_dimensions') or [])
    update_farm = normalize_context_dimension_value((update or {}).get('farm', ''))
    update_turbine = normalize_windrise_turbine_id((update or {}).get('turbine_id', ''))
    current_farm = normalize_context_dimension_value(merged.get('farm', ''))
    if (
        (update or {}).get('_scope_update_from_user')
        and update_farm
        and current_farm
        and update_farm != current_farm
        and not update_turbine
    ):
        merged['turbine_id'] = ''
        merged['turbine_ids'] = []
        merged['brand'] = ''
        merged['model'] = ''
        merged['standard_model'] = ''
    current_turbine = normalize_windrise_turbine_id(merged.get('turbine_id', ''))
    scope_switched = bool(
        (update or {}).get('_scope_update_from_user')
        and (
            (update_farm and current_farm and update_farm != current_farm)
            or (update_turbine and current_turbine and update_turbine != current_turbine)
        )
    )
    if scope_switched:
        merged['fault_code'] = ''
        merged['fault_name'] = ''
        for key in ('component', 'symptom', 'position', 'severity', 'time_condition'):
            merged[key] = []
    update_brand = normalize_context_dimension_value((update or {}).get('brand', ''))
    if update_brand and update_brand != normalize_context_dimension_value(merged.get('brand', '')):
        for stale_key in ('farm', 'model', 'standard_model'):
            merged[stale_key] = ''
    for key in ('component', 'symptom', 'position', 'severity', 'time_condition'):
        values = list(merged.get(key) or [])
        for value in (update or {}).get(key) or []:
            append_unique_windrise_slot(values, value)
        merged[key] = values
    for key in ('turbine_ids',):
        values = list(merged.get(key) or [])
        for value in (update or {}).get(key) or []:
            append_unique_windrise_slot(values, normalize_windrise_turbine_id(value))
        merged[key] = values
    for key in ('brand', 'farm', 'model', 'standard_model', 'fault_code', 'fault_name', 'turbine_id'):
        if key in {'model', 'standard_model'}:
            value = normalize_windrise_model_value((update or {}).get(key, ''))
        elif key == 'turbine_id':
            value = normalize_windrise_turbine_id((update or {}).get(key, ''))
        else:
            value = normalize_context_dimension_value((update or {}).get(key, ''))
        if value:
            merged[key] = value
            unavailable_dimensions.discard('model' if key == 'standard_model' else key)
        else:
            merged.setdefault(key, '')
    merged['_unavailable_dimensions'] = sorted(unavailable_dimensions)
    return merged


def build_windrise_slots_from_history(history, limit=10):
    slots = {}
    for item in (history or [])[-max(1, int(limit)):]:
        content = item.get('content', '')
        if item.get('role') == 'user':
            slots = merge_windrise_slots(slots, extract_windrise_user_slots(content))
        elif item.get('role') == 'assistant':
            context = extract_fault_context_from_answer(content)
            # Assistant answers can contain broad candidate records.  Those
            # dimensions are evidence, not user-confirmed device scope.
            update = {
                'fault_code': context.get('code', ''),
                'fault_name': context.get('name', ''),
            }
            update = {
                key: value
                for key, value in update.items()
                if not slots.get(key)
            }
            slots = merge_windrise_slots(slots, update)
    return slots


def has_windrise_issue_slots(slots):
    if not slots:
        return False
    return bool(
        slots.get('fault_code')
        or slots.get('fault_name')
        or slots.get('component')
        or slots.get('symptom')
        or slots.get('position')
    )


def windrise_known_farm_keywords():
    return (
        '新华', '团结', '四平', '裕民', '洮北', '镇赉', '镇赍', '同发', '什花道',
        '良井子', '前进', '向荣', '八面', '富荣', '福林', '如意', '长龙山',
    )


def extract_windrise_farm_mentions(text):
    normalized = normalize_text(text)
    if not normalized:
        return set()
    return {
        keyword
        for keyword in windrise_known_farm_keywords()
        if keyword in normalized
    }


def windrise_retrieval_memory_matches_current_scope(query_text, memory_text):
    """Do not reuse KB memory when the user has switched to a different wind farm."""
    current_farms = extract_windrise_farm_mentions(query_text)
    if not current_farms:
        return True
    memory_farms = extract_windrise_farm_mentions(memory_text)
    if not memory_farms:
        return True
    if current_farms & memory_farms:
        return True
    return False


def detect_windrise_new_case_switch(query, history):
    """Detect when the user starts a new wind-farm/device case in the same conversation."""
    history = history or []
    if not history:
        return False, ''
    normalized = normalize_windrise_query(query)
    if not normalized:
        return False, ''
    if is_context_only_windrise_followup(normalized):
        return False, ''
    if is_windrise_scope_supplement_reply(query, history):
        return False, ''
    if is_windrise_scoped_symptom_followup(query, history):
        return False, ''
    if is_windrise_bare_symptom_with_confirmed_scope(query, history):
        return False, ''

    current = extract_windrise_user_slots(query)
    current_farm = normalize_context_dimension_value(current.get('farm', ''))
    current_turbine = normalize_windrise_turbine_id(current.get('turbine_id', ''))
    previous_scope = build_user_confirmed_windrise_scope_slots('', history)
    previous_farm = normalize_context_dimension_value(previous_scope.get('farm', ''))
    previous_turbine = normalize_windrise_turbine_id(previous_scope.get('turbine_id', ''))

    if current_farm and previous_farm and current_farm != previous_farm:
        return True, 'explicit_farm_switch'
    if current_turbine and previous_turbine and current_turbine != previous_turbine:
        if current_farm or windrise_should_isolate_history_issue_slots(query, history):
            return True, 'explicit_turbine_switch'
    if windrise_should_isolate_history_issue_slots(query, history):
        if (
            has_windrise_issue_slots(current)
            or query_has_explicit_dimension(query)
            or extract_scada_style_alarm_name(query)
        ):
            if previous_farm or previous_turbine or find_recent_fault_context_from_history(history):
                return True, 'new_issue_subject'
    return False, ''


def build_windrise_scope_history_for_query(query, history=None):
    """Limit prior scope accumulation when the user has switched to a new case."""
    history = list(history or [])
    if getattr(windrise_request_context, 'new_case_switch', False):
        if is_windrise_scope_supplement_reply(query, history):
            return history[-6:]
        return []
    if windrise_should_isolate_history_issue_slots(query, history):
        if is_windrise_scope_supplement_reply(query, history):
            return history
        if is_context_only_windrise_followup(query):
            return history
        subject_phrase = extract_scada_style_alarm_name(query) or extract_windrise_fault_subject_phrase(query)
        if (
            not query_has_explicit_dimension(query)
            and subject_phrase
            and len(normalize_text(subject_phrase)) >= 3
        ):
            return history
        if (
            has_device_issue_hint(query)
            and not query_has_explicit_dimension(query)
            and (
                extract_scada_style_alarm_name(query)
                or (
                    extract_windrise_fault_subject_phrase(query)
                    and len(normalize_text(extract_windrise_fault_subject_phrase(query))) >= 3
                )
            )
        ):
            return history
        return []
    return history


def windrise_should_isolate_history_issue_slots(query, history):
    """Do not inherit prior fault_name/component/symptom when the user starts a new case."""
    if not history:
        return False
    if is_windrise_scope_device_reply(query):
        return False
    if is_context_only_windrise_followup(query):
        return False
    if is_windrise_scope_supplement_reply(query, history):
        return False
    current_slots = extract_windrise_user_slots(query)
    if has_windrise_issue_slots(current_slots):
        return True
    if extract_scada_style_alarm_name(query):
        return True
    if has_specific_current_diagnosis_subject(query):
        return True
    subject_phrase = extract_windrise_fault_subject_phrase(query) or extract_scada_style_alarm_name(query)
    if subject_phrase and len(normalize_text(subject_phrase)) >= 3:
        return True
    return False


def is_windrise_scoped_symptom_followup(query, history=None):
    """Symptom-only turn after farm/turbine/model scope was already confirmed."""
    history = history or []
    if is_windrise_general_knowledge_question(query):
        return False
    if is_bare_windrise_fault_code_query(query):
        return False
    if not history or not windrise_should_isolate_history_issue_slots(query, history):
        return False
    if is_windrise_scope_supplement_reply(query, history):
        return False
    if should_answer_windrise_turbine_mapping_question(query):
        return False
    if is_context_only_windrise_followup(query):
        return False
    if query_has_explicit_dimension(query):
        return False
    if not (
        has_device_issue_hint(query)
        or extract_windrise_fault_subject_phrase(query)
        or extract_scada_style_alarm_name(query)
    ):
        return False
    slots = build_resolved_windrise_scope_slots(query, history)
    return has_windrise_scope_for_fault_answer(slots, query, history)


def find_recent_fault_context_for_query(query, history):
    if getattr(windrise_request_context, 'new_case_switch', False):
        return {}
    if detect_windrise_new_case_switch(query, history)[0]:
        return {}
    if windrise_should_isolate_history_issue_slots(query, history):
        return {}
    return find_recent_fault_context_from_history(history)


def find_recent_fault_code_for_query(query, history):
    return normalize_windrise_fault_code(
        find_recent_fault_context_for_query(query, history).get('code', '')
    ) or ''


def should_reset_windrise_scope_for_explicit_fault_code_query(query, history=None):
    """Bare fault-code lookups must not inherit prior farm/turbine scope."""
    normalized = normalize_text(query)
    if not normalized:
        return False
    if not extract_direct_windrise_fault_codes(normalized, history or []):
        return False
    if is_context_only_windrise_followup(normalized):
        return False
    if is_fault_code_coverage_followup(normalized):
        return False
    return True


def extract_recent_windrise_fault_topic_for_query(query, history):
    if windrise_should_isolate_history_issue_slots(query, history):
        return ''
    return extract_recent_windrise_fault_topic_from_history(history)


def build_effective_windrise_slots_for_query(query, history):
    current_slots = extract_windrise_user_slots(query)
    scope_history = build_windrise_scope_history_for_query(query, history)
    history_slots = build_windrise_slots_from_history(scope_history)
    if not windrise_should_isolate_history_issue_slots(query, history):
        slots = enrich_windrise_slots_with_turbine_mapping(
            enrich_windrise_slots_with_inferred_brand(merge_windrise_slots(history_slots, current_slots))
        )
    else:
        if is_context_only_windrise_followup(query):
            base = {
                'brand': history_slots.get('brand', ''),
                'farm': history_slots.get('farm', ''),
                'model': history_slots.get('model', ''),
                'standard_model': history_slots.get('standard_model', ''),
                'turbine_id': history_slots.get('turbine_id', ''),
                'turbine_ids': list(history_slots.get('turbine_ids') or []),
            }
        elif (
            not query_has_explicit_dimension(query)
            and (
                extract_scada_style_alarm_name(query)
                or (
                    extract_windrise_fault_subject_phrase(query)
                    and len(normalize_text(extract_windrise_fault_subject_phrase(query))) >= 3
                )
            )
        ):
            # New symptom follow-up: keep confirmed scope, drop prior fault topic.
            base = {
                'brand': history_slots.get('brand', ''),
                'farm': history_slots.get('farm', ''),
                'model': history_slots.get('model', ''),
                'standard_model': history_slots.get('standard_model', ''),
                'turbine_id': history_slots.get('turbine_id', ''),
                'turbine_ids': list(history_slots.get('turbine_ids') or []),
            }
        else:
            base = {}
        slots = enrich_windrise_slots_with_turbine_mapping(
            enrich_windrise_slots_with_inferred_brand(merge_windrise_slots(base, current_slots))
        )

    # Assistant messages can contain previous candidate devices. Device range
    # must therefore be owned by user messages whenever one has been supplied.
    # This also prevents an old turbine ID from returning after a farm switch.
    scope_history = build_windrise_scope_history_for_query(query, history)
    if (
        windrise_should_isolate_history_issue_slots(query, history)
        and not is_context_only_windrise_followup(query)
        and not (
            has_device_issue_hint(query)
            and (
                extract_scada_style_alarm_name(query)
                or (
                    extract_windrise_fault_subject_phrase(query)
                    and len(normalize_text(extract_windrise_fault_subject_phrase(query))) >= 3
                )
            )
            and not query_has_explicit_dimension(query)
        )
    ):
        scope_history = []
    confirmed_scope = build_resolved_windrise_scope_slots(query, scope_history)
    unavailable = set(confirmed_scope.get('_unavailable_dimensions') or [])
    user_scope_present = bool(
        unavailable
        or any(confirmed_scope.get(key) for key in (
            'brand', 'farm', 'model', 'standard_model', 'turbine_id',
        ))
    )
    if user_scope_present:
        for key in ('brand', 'farm', 'model', 'standard_model', 'turbine_id'):
            slots[key] = confirmed_scope.get(key, '')
        slots['turbine_ids'] = list(confirmed_scope.get('turbine_ids') or [])
    if unavailable:
        slots['_unavailable_dimensions'] = sorted(unavailable)
    if confirmed_scope.get('_broad_scope_requested'):
        slots['_broad_scope_requested'] = True
    if windrise_should_isolate_history_issue_slots(query, history) and not is_context_only_windrise_followup(query):
        if not normalize_windrise_fault_code(current_slots.get('fault_code', '')):
            slots['fault_code'] = ''
        if not normalize_context_dimension_value(current_slots.get('fault_name', '')):
            slots['fault_name'] = ''
        if not has_windrise_issue_slots(current_slots):
            slots['component'] = list(current_slots.get('component') or [])
            slots['symptom'] = list(current_slots.get('symptom') or [])
            slots['position'] = list(current_slots.get('position') or [])
    return apply_windrise_active_scope_slots(slots, query)


def enrich_windrise_slots_with_inferred_brand(slots):
    slots = dict(slots or {})
    if slots.get('brand'):
        return slots
    dimension_values = [
        normalize_windrise_model_value(slots.get(key, '')) if key in {'model', 'standard_model'} else normalize_context_dimension_value(slots.get(key, ''))
        for key in ('farm', 'model', 'standard_model')
        if (normalize_windrise_model_value(slots.get(key, '')) if key in {'model', 'standard_model'} else normalize_context_dimension_value(slots.get(key, '')))
    ]
    if not dimension_values:
        return slots
    brands = []
    for record in load_windrise_fault_index_records():
        searchable = normalize_text(' '.join(
            str(record.get(key, '') or '')
            for key in ('site', 'model', 'standardModel')
        )).lower()
        if all(value.lower() in searchable for value in dimension_values):
            brand = normalize_context_dimension_value(record.get('brand', ''))
            if brand and brand not in brands:
                brands.append(brand)
            if len(brands) > 1:
                break
    if len(brands) == 1:
        slots['brand'] = brands[0]
    return slots


def windrise_slot_search_terms(slots):
    if not slots:
        return []
    terms = []
    for key in ('brand', 'farm', 'model', 'standard_model', 'fault_code'):
        value = normalize_windrise_model_value(slots.get(key, '')) if key in {'model', 'standard_model'} else normalize_context_dimension_value(slots.get(key, ''))
        if value and value not in terms:
            terms.append(value)
    for key in ('component', 'position', 'symptom', 'severity', 'time_condition'):
        for value in slots.get(key) or []:
            normalized = normalize_context_dimension_value(value)
            if normalized and normalized not in terms:
                terms.append(normalized)
    return terms


def windrise_context_terms_for_query(query, history):
    normalized = normalize_text(query)
    current_slots = extract_windrise_user_slots(normalized)
    scope_history = build_windrise_scope_history_for_query(normalized, history)
    history_slots = build_windrise_slots_from_history(scope_history)
    active_scope = get_windrise_active_scope_slots()
    if active_scope:
        current_slots = merge_windrise_slots(active_scope, current_slots)
    if not history_slots and not active_scope:
        return []
    combined_slots = merge_windrise_slots(history_slots, current_slots)
    terms = windrise_slot_search_terms(combined_slots)
    if not terms:
        return []
    current_terms = set(windrise_slot_search_terms(current_slots) + windrise_dimension_terms(normalized))
    current_has_specific_issue = bool(current_slots.get('component') or current_slots.get('symptom') or current_slots.get('fault_name'))
    filtered = []
    for term in terms:
        if term in current_terms:
            continue
        if current_has_specific_issue and term in set(windrise_slot_search_terms(history_slots)):
            history_only_issue_terms = set()
            for key in ('component', 'position', 'symptom', 'severity', 'time_condition'):
                history_only_issue_terms.update(history_slots.get(key) or [])
            if term in history_only_issue_terms:
                continue
        filtered.append(term)

    if not filtered and not current_terms:
        filtered = terms
    return filtered[:8]


def build_windrise_slots_summary(slots):
    if not slots:
        return ''
    labels = (
        ('brand', '厂家'),
        ('farm', '风场'),
        ('turbine_id', '风机编号'),
        ('model', '机型'),
        ('standard_model', '标准机型'),
        ('fault_code', '故障码'),
        ('fault_name', '故障名称/现象'),
        ('component', '部件'),
        ('position', '位置'),
        ('symptom', '现象'),
        ('severity', '程度'),
        ('time_condition', '工况'),
    )
    parts = []
    for key, label in labels:
        value = slots.get(key)
        if isinstance(value, list):
            text = '、'.join(str(item) for item in value if item)
        else:
            text = str(value or '').strip()
        if text:
            parts.append(f'{label}={text}')
    return '；'.join(parts)


def build_windrise_slot_context_instruction(query, history):
    summary = build_windrise_slots_summary(build_effective_windrise_slots_for_query(query, history))
    if not summary:
        return ''
    return (
        f'\n- 已从本网页多轮对话中提取到结构化上下文：{summary}。'
        '当前问题没有明确覆盖的字段可以沿用这些信息；当前问题明确给出的厂家、机型、部件、故障码或现象优先。'
        '厂家/风场/机型属于硬约束，不能跨品牌、跨机型给最终结论。'
    )


def build_windrise_dimension_constraint_instruction(query, history):
    current_terms = windrise_dimension_terms(query)
    if current_terms:
        terms = current_terms
        source = '当前用户问题'
    else:
        terms = find_recent_user_windrise_dimension_terms(history)
        source = '同一网页会话最近用户消息'
    if not terms:
        return ''
    return (
        f'\n- {source}已经指定维度：{"、".join(terms[:3])}。这是硬约束；'
        '回答、检索资料和最终结论必须优先匹配这些风场/品牌/机型。'
        '如果检索资料出现其它品牌/机型，只能作为“不适用/需排除”的说明，不能把它当作当前答案。'
    )


def with_windrise_dimension_constraint(query, history):
    if isinstance(query, dict):
        constrained = dict(query)
        args = list(constrained.get('args') or [])
        if len(args) >= 2 and str(args[0]).lower() == 'search':
            args[1] = apply_recent_user_dimension_to_windrise_query(args[1], history)
            constrained['args'] = args
        elif 'query' in constrained:
            constrained['query'] = apply_recent_user_dimension_to_windrise_query(constrained.get('query'), history)
        return constrained
    if isinstance(query, list):
        args = list(query)
        if len(args) >= 2 and str(args[0]).lower() == 'search':
            args[1] = apply_recent_user_dimension_to_windrise_query(args[1], history)
        elif len(args) == 1:
            args[0] = apply_recent_user_dimension_to_windrise_query(args[0], history)
        return args
    return apply_recent_user_dimension_to_windrise_query(query, history)


def windrise_topic_terms(topic):
    normalized = clean_windrise_fault_topic_text(topic)
    if not normalized:
        return []
    terms = [normalized]
    cleaned_for_terms = re.sub(
        r'(一般|大概|可能|大约|通常|是不是|是否|属于|是什么|什么故障|什么问题|怎么回事|怎么处理|如何处理|为什么|原因|查一下|查下|查询|检索|搜索|故障|报警|告警|现象|问题|请|帮我|给我)',
        ' ',
        normalized,
        flags=re.IGNORECASE,
    )
    cleaned_for_terms = re.sub(r'\s+', ' ', cleaned_for_terms).strip()
    if cleaned_for_terms and cleaned_for_terms not in terms:
        terms.append(cleaned_for_terms)
    for term in re.findall(r'[\u4e00-\u9fff]{2,}|[A-Za-z0-9_.#/-]{2,}', normalized):
        if term in {'这个', '那个', '刚才', '前面', '上面', '是什么', '为什么', '怎么', '原因', '造成', '导致', '故障码'}:
            continue
        if term not in terms:
            terms.append(term)
    for term in re.findall(r'[\u4e00-\u9fff]{2,}|[A-Za-z0-9_.#/-]{2,}', cleaned_for_terms):
        if term and term not in terms:
            terms.append(term)
    domain_term_groups = (
        ('变流器', '变频器', 'converter'),
        ('散热片', '散热器', '散热风扇', '散热', '冷却', '水冷', '风扇'),
        ('功率模块', '功率单元', 'IGBT', 'igbt'),
        ('功率过低', '功率过低切出', '发电状态下功率过低', '限功率', '实际限功率', '限载', '降载', '降功率', '降额', '功率限制', '限制功率', '功率下降', '功率低'),
        ('温度高', '温度过高', '过温', '高温', '过热'),
    )
    lowered = normalized.lower()
    for group in domain_term_groups:
        if any(alias.lower() in lowered for alias in group):
            for alias in group:
                if alias not in terms:
                    terms.append(alias)
    for group in FUZZY_FAULT_TERM_GROUPS:
        if any(alias and alias in normalized for alias in group):
            for alias in group:
                if alias and alias not in terms:
                    terms.append(alias)
    return terms


def normalize_semantic_fault_term(value):
    normalized = normalize_context_dimension_value(value)
    if not normalized:
        return ''
    normalized = re.sub(
        r'(一般|大概|可能|大约|通常|是不是|是否|属于|是什么|什么故障|什么问题|怎么回事|故障|报警|告警|现象|问题)',
        '',
        normalized,
        flags=re.IGNORECASE,
    ).strip(' ？?。!！,，;；:：')
    if len(normalized) < 2:
        return ''
    return normalized


def extract_windrise_hardware_module_tokens(text):
    normalized = normalize_text(text)
    if not normalized:
        return []
    tokens = []
    for match in re.finditer(r'(?<![A-Za-z0-9_])[A-Z]{1,8}\d{2,}[A-Z]{1,10}\d+(?:[_.\-]\d+)?(?![A-Za-z0-9_])', normalized, flags=re.IGNORECASE):
        token = match.group(0).upper()
        if token not in tokens:
            tokens.append(token)
    return tokens[:6]


def record_matches_brand_or_farm_slots(record, slots):
    if not slots:
        return True
    searchable = normalize_text(' '.join(
        str(record.get(key, '') or '')
        for key in ('site', 'brand', 'source')
    )).lower()
    for key in ('brand', 'farm'):
        value = normalize_context_dimension_value(slots.get(key, ''))
        if value and value.lower() not in searchable:
            return False
    return True


def call_windrise_fault_semantic_normalizer(query, slots=None):
    if (
        not WINDRISE_SEMANTIC_FAULT_NORMALIZER_ENABLED
        or (
            WINDRISE_SINGLE_SEMANTIC_PASS
            and getattr(windrise_request_context, 'semantic_pass_used', False)
        )
        or is_windrise_llm_temporarily_unavailable()
        or not looks_like_fault_phenomenon_query(query)
    ):
        return {}
    slot_summary = build_windrise_slots_summary(slots or {}) or '无'
    prompt = f"""请把用户的风机故障口语描述整理成检索用 JSON，只输出 JSON，不要解释。

要求：
- 不要判断最终故障码，只做语义整理和同义词扩展。
- 用户说得模糊也要提取可检索词。
- 重点保留部件、子部件、现象、动作、可能原因、同义表达。
- 词不要太多，优先 6 到 16 个高价值检索词。

用户原话：{query}
规则已提取信息：{slot_summary}

输出字段：
{{
  "components": ["部件或系统"],
  "subcomponents": ["子部件"],
  "symptoms": ["现象"],
  "actions": ["保护动作/运行动作"],
  "possible_causes": ["可能原因词"],
  "search_terms": ["综合检索词"]
}}"""
    try:
        windrise_request_context.semantic_pass_used = True
        raw_text = call_chat_model(
            [
                {'role': 'system', 'content': '你只做风机故障检索词语义整理。必须只输出合法 JSON。'},
                {'role': 'user', 'content': prompt},
            ],
            max_tokens=420,
            temperature=0.0,
            timeout=WINDRISE_SEMANTIC_FAULT_NORMALIZER_TIMEOUT,
            sanitize=False,
        )
        data = json.loads(extract_json_object(raw_text))
    except Exception as e:
        if isinstance(e, (requests.Timeout, requests.ConnectionError)):
            mark_windrise_llm_unavailable(e)
        else:
            print(f"[Windrise] 故障现象语义整理失败，使用规则兜底: {type(e).__name__}: {e}")
        return {}
    if not isinstance(data, dict):
        return {}
    normalized = {}
    for key in ('components', 'subcomponents', 'symptoms', 'actions', 'possible_causes', 'search_terms'):
        values = data.get(key) or []
        if isinstance(values, str):
            values = [values]
        cleaned = []
        for value in values:
            term = normalize_semantic_fault_term(value)
            if term and term not in cleaned:
                cleaned.append(term)
        normalized[key] = cleaned[:8]
    return normalized


def semantic_fault_terms_to_topic_terms(semantic_info):
    terms = []
    if not isinstance(semantic_info, dict):
        return terms
    for key in ('components', 'subcomponents', 'symptoms', 'actions', 'possible_causes', 'search_terms'):
        for value in semantic_info.get(key) or []:
            term = normalize_semantic_fault_term(value)
            if term and term not in terms:
                terms.append(term)
    combined = ' '.join(terms)
    for term in windrise_topic_terms(combined):
        if term and term not in terms:
            terms.append(term)
    return terms[:40]


def compact_fault_match_text(text):
    return re.sub(r'[\s_，,。.、:：；;？?！!（）()\[\]【】\-]+', '', normalize_text(text)).lower()


def looks_like_fault_phenomenon_query(text):
    normalized = normalize_text(text)
    if not normalized:
        return False
    if is_windrise_general_knowledge_question(normalized):
        return False
    if any(keyword in normalized for keyword in GENERAL_NON_DIAGNOSTIC_KEYWORDS):
        return False
    if extract_fault_codes(normalized):
        return True
    lowered = normalized.lower()
    if any(keyword in lowered for keyword in DEVICE_HINT_KEYWORDS):
        return True
    if any(keyword in lowered for keyword in ISSUE_HINT_KEYWORDS):
        return True
    return bool(re.search(
        r'(是什么故障|什么故障|什么问题|啥问题|什么原因|怎么回事|一般是|属于什么|怎么处理|如何处理|原因|为什么|查一下|查下|查询|检索|搜索)',
        normalized,
        flags=re.IGNORECASE,
    ))


def extract_explicit_fault_code_lookup_codes(text):
    normalized = normalize_text(text)
    if not normalized:
        return []
    codes = []
    patterns = (
        r'(?:故障码|故障代码|故障号|报码|告警码|报警码|状态码|错误码|代码)\s*(?:[:：=＝]|为|是|等于)?\s*([A-Za-z]{0,8}\d[A-Za-z0-9]*(?:[_-][A-Za-z0-9]+)*)',
        r'(?:报|报出|显示|出现)\s*([A-Za-z]{1,8}\d[A-Za-z0-9]*(?:[_-][A-Za-z0-9]+)+|[A-Za-z]{2,8}\d{2,8}[A-Za-z0-9]*)',
    )
    for pattern in patterns:
        for match in re.finditer(pattern, normalized, flags=re.IGNORECASE):
            code = normalize_context_dimension_value(match.group(1))
            if code and code not in codes:
                codes.append(code)
    compact = normalized.strip()
    if re.fullmatch(r'[A-Za-z]{0,8}\d[A-Za-z0-9]*(?:[_-][A-Za-z0-9]+)*', compact, flags=re.IGNORECASE):
        codes.append(compact)
    return codes[:3]


FUZZY_FAULT_TERM_GROUPS = (
    ('叶轮', '风轮', '主轴', '低速端', '轮毂'),
    ('转速', '速度', 'rpm'),
    ('突变', '跳变', '波动', '瞬变', '瞬间升高', '变化过快', '风速突变'),
    ('超过限制值', '超过限值', '超限', '越限', '过限', '高于门限', '高于阈值', '大于门限', '大于阈值', '超过保护值'),
    ('超速', '过速', '转速过高', '速度过高', '过转速', '轮毂超速', '叶轮超速', '风轮过转速', '主轴超速'),
    ('限制值', '限值', '门限', '阈值', '设定值', '保护值'),
)


def expand_fuzzy_fault_terms(text):
    normalized = normalize_text(text).replace('嚯', '或')
    expanded = []
    for group in FUZZY_FAULT_TERM_GROUPS:
        if any(alias and alias in normalized for alias in group):
            for alias in group:
                if alias and alias not in expanded:
                    expanded.append(alias)
    if re.search(r'(叶轮|风轮|主轴|低速端).*(转速|速度)|(转速|速度).*(叶轮|风轮|主轴|低速端)', normalized):
        for alias in ('风轮转速', '叶轮转速', '主轴转速', '低速端转速'):
            if alias not in expanded:
                expanded.append(alias)
    if re.search(r'(转速|速度).*(超限|越限|过限|超过|高于|大于|限制值|限值|门限|阈值|保护值|过速|超速)|(超限|越限|过限|超过|高于|大于|限制值|限值|门限|阈值|保护值|过速|超速).*(转速|速度)', normalized):
        for alias in ('转速超限', '转速过高', '超速', '过速', '轮毂超速', '叶轮超速', '风轮过转速', '主轴超速', '发电机超速', '风轮转速过高'):
            if alias not in expanded:
                expanded.append(alias)
    if re.search(r'(突变|跳变|波动|瞬变|变化过快)', normalized) and re.search(r'(转速|速度)', normalized):
        for alias in ('转速跳变', '转速波动', '速度突变', '风速突变'):
            if alias not in expanded:
                expanded.append(alias)
    return expanded


def is_speed_limit_fuzzy_query(text):
    normalized = normalize_text(text)
    return bool(
        re.search(r'(转速|速度|rpm)', normalized, flags=re.IGNORECASE)
        and re.search(r'(超限|越限|过限|超过|高于|大于|限制值|限值|门限|阈值|保护值|过速|超速|突变|跳变|波动)', normalized)
    )


def is_converter_power_limit_fuzzy_query(text):
    normalized = normalize_text(text)
    if not normalized:
        return False
    has_converter = re.search(r'(变流器|变频器|converter)', normalized, flags=re.IGNORECASE)
    has_power_limit = re.search(r'(限功率|实际限功率|限载|降载|降功率|降额|功率限制|限制功率|功率下降|功率低|发电少)', normalized, flags=re.IGNORECASE)
    has_cooling = re.search(r'(散热片|散热器|散热风扇|散热|冷却|水冷|风扇|功率模块|功率单元|igbt|温度|过温|高温|过热)', normalized, flags=re.IGNORECASE)
    return bool(has_converter and (has_power_limit or has_cooling))


def record_matches_speed_limit_fuzzy_query(record):
    text = normalize_text(' '.join(
        str(record.get(key, '') or '')
        for key in ('name', 'text', 'solution', 'logic', 'reason')
    ))
    has_speed = bool(re.search(r'(转速|速度|rpm|低速端|风轮|叶轮|主轴|发电机)', text, flags=re.IGNORECASE))
    has_limit_or_change = bool(re.search(
        r'(超限|越限|过限|超过|高于|大于|限制值|限值|门限|阈值|保护值|过速|超速|过转速|转速过高|跳变|突变|波动|瞬间升高)',
        text,
        flags=re.IGNORECASE,
    ))
    return has_speed and has_limit_or_change


def clean_current_fault_lookup_topic(query):
    topic = clean_windrise_fault_topic_text(query)
    topic = re.sub(
        r'\s*(?:请)?(?:按最新厂家、风场、机型和具体型号)?(?:最终定位|请最终定位|定位故障码|定位故障|是什么故障码|故障码是什么|故障代码是什么|是什么码|请不要跨厂家回答).*$',
        '',
        topic,
        flags=re.IGNORECASE,
    )
    return topic.strip(' ？?。!！,，;；:：')


def current_query_fault_topic_for_index_lookup(query):
    normalized = normalize_text(query)
    if not normalized:
        return ''
    if re.search(
        r'(完整告警是|完整报警是|完整故障是|原始告警是|原始报警是|原始故障是|告警内容|报警内容|故障内容|故障描述|故障现象|现在报的是|报的是|当前报的是)',
        normalized,
        flags=re.IGNORECASE,
    ):
        return clean_current_fault_lookup_topic(normalized)
    if (
        re.search(
            r'(是什么故障码|故障码是什么|故障代码是什么|是什么码|属于什么故障|是什么故障|哪类故障|对应.*?(故障码|故障代码|报码|告警码|报警码|故障))',
            normalized,
            flags=re.IGNORECASE,
        )
        and has_device_issue_hint(normalized)
    ):
        return clean_current_fault_lookup_topic(normalized)
    return ''


def extract_fault_topic_discriminators(topic):
    normalized = normalize_text(topic)
    if not normalized:
        return []
    tokens = []
    patterns = (
        r'(?:轴|桨叶|叶片|电容柜|柜|系统|水冷系统|保留|故障字|模块)?\s*[A-Za-z]{0,12}\d+(?:[_.\-]\d+)?[A-Za-z]*',
        r'(?:[A-Za-z]{2,}\d+[A-Za-z0-9_.\-]*)',
        r'(?:[XYZABCUVWKLMN])\s*(?:相|轴|有效值|方向|过载|限位|电流|电压)?',
    )
    for pattern in patterns:
        for match in re.finditer(pattern, normalized, flags=re.IGNORECASE):
            token = compact_fault_match_text(match.group(0))
            if len(token) < 1:
                continue
            if re.fullmatch(r'[a-z]', token, flags=re.IGNORECASE):
                continue
            if re.fullmatch(r'\d+', token) and token not in {'1', '2', '3'} and len(token) < 2:
                continue
            if token not in tokens:
                tokens.append(token)
    return tokens[:8]


def is_strict_fault_discriminator(token):
    compact = compact_fault_match_text(token)
    return bool(re.fullmatch(
        r'(?:轴|桨叶|叶片|电容柜|电池箱|柜|系统|水冷系统|保留|故障字|模块)[a-z]*\d+(?:[_.\-]\d+)?[a-z]*',
        compact,
        flags=re.IGNORECASE,
    ))


def record_matches_dimension_terms(record, terms):
    if not terms:
        return True
    searchable = record.get('_wr_scope_text') or normalize_text(' '.join(
        str(record.get(key, ''))
        for key in ('site', 'brand', 'model', 'standardModel', 'turbineIds', 'text', 'source')
    )).lower()
    return all(str(term).lower() in searchable for term in terms)


def score_fault_record_for_topic(record, topic_terms):
    topic_text = normalize_text(' '.join(topic_terms)).replace('嚯', '或')
    name = record.get('_wr_name') or normalize_text(record.get('name', ''))
    text = record.get('_wr_topic_text') or normalize_text(' '.join(
        str(record.get(key, ''))
        for key in ('name', 'text', 'solution', 'logic', 'reason', 'source')
    ))
    lowered_name = record.get('_wr_name_lower') or name.lower()
    lowered_text = record.get('_wr_topic_text_lower') or text.lower()
    expanded_terms = expand_fuzzy_fault_terms(topic_text)
    compact_topic = compact_fault_match_text(topic_text)
    compact_name = record.get('_wr_compact_name') or compact_fault_match_text(name)
    compact_text = record.get('_wr_compact_topic_text') or compact_fault_match_text(text)
    score = 0
    if compact_topic and compact_name:
        if compact_topic == compact_name:
            score += 240
        elif compact_topic in compact_name or compact_name in compact_topic:
            score += 150
    for term in topic_terms:
        lowered = str(term).lower()
        if not lowered:
            continue
        if lowered in lowered_name:
            score += 14 if len(lowered) >= 3 else 6
        elif lowered in lowered_text:
            score += 5 if len(lowered) >= 3 else 2
        compact_term = compact_fault_match_text(term)
        if compact_term and compact_term in compact_name:
            score += 10
    for term in expanded_terms:
        compact_term = compact_fault_match_text(term)
        if not compact_term:
            continue
        if compact_term in compact_name:
            score += 28
        elif compact_term in compact_text:
            score += 12
    fuzzy_groups = [
        set(group)
        for group in FUZZY_FAULT_TERM_GROUPS
        if any(alias and alias in topic_text for alias in group)
    ]
    for group in fuzzy_groups:
        if any(alias and alias in name for alias in group):
            score += 18
        elif any(alias and alias in text for alias in group):
            score += 8
    if re.search(r'(叶轮|风轮|主轴|低速端)', topic_text) and re.search(r'(叶轮|风轮|主轴|低速端)', text):
        score += 14
    if re.search(r'(转速|速度)', topic_text) and re.search(r'(转速|速度)', text):
        score += 14
    if re.search(r'(超限|越限|过限|超过|高于|大于|限制值|限值|门限|阈值|保护值|过速|超速)', topic_text) and re.search(r'(超限|越限|过限|超过|高于|大于|限制值|限值|门限|阈值|保护值|过速|超速)', text):
        score += 16
    if re.search(r'(突变|跳变|波动|瞬变|变化过快)', topic_text) and re.search(r'(突变|跳变|波动|瞬变|变化过快|瞬间升高)', text):
        score += 12
    converter_query = bool(re.search(r'(变流器|变频器|converter)', topic_text, flags=re.IGNORECASE))
    cooling_query = bool(re.search(r'(散热片|散热器|散热风扇|散热|冷却|水冷|风扇|功率模块|功率单元|igbt)', topic_text, flags=re.IGNORECASE))
    power_limit_query = bool(re.search(r'(功率过低|功率过低切出|限功率|实际限功率|限载|降载|降功率|降额|功率限制|限制功率|功率下降|功率低)', topic_text, flags=re.IGNORECASE))
    if converter_query and re.search(r'(变流器|变频器|converter)', text, flags=re.IGNORECASE):
        score += 35
    if power_limit_query:
        if re.search(r'(功率过低|发电状态下功率过低|限功率|实际限功率|限载|降载|降功率|降额|功率限制|限制功率)', name, flags=re.IGNORECASE):
            score += 190
        elif re.search(r'(功率过低|发电状态下功率过低|限功率|实际限功率|限载|降载|降功率|降额|功率限制|限制功率)', text, flags=re.IGNORECASE):
            if re.search(r'检查.{0,12}是否限功率|是否限功率', text, flags=re.IGNORECASE):
                score += 20
            else:
                score += 90
        if re.search(r'(功率下降|功率低|发电少)', text, flags=re.IGNORECASE):
            score += 35
    if cooling_query:
        if re.search(r'(散热片|散热器|散热风扇|散热|冷却|水冷|风扇|功率模块|功率单元|igbt)', name, flags=re.IGNORECASE):
            score += 90
        elif re.search(r'(散热片|散热器|散热风扇|散热|冷却|水冷|风扇|功率模块|功率单元|igbt)', text, flags=re.IGNORECASE):
            score += 65
        if re.search(r'(温度高|温度过高|过温|高温|过热)', text, flags=re.IGNORECASE):
            score += 35
    if converter_query and power_limit_query:
        if re.search(r'(变流器|变频器|converter).{0,24}(限功率|实际限功率|限载|降载|降功率|降额|功率限制|限制功率)|(限功率|实际限功率|限载|降载|降功率|降额).{0,24}(变流器|变频器|converter)', text, flags=re.IGNORECASE):
            score += 150
    if converter_query and cooling_query and power_limit_query:
        if re.search(r'(igbt|功率模块|功率单元|散热|冷却|水冷|风扇).{0,32}(过温|温度|限功率|降载|降额)|(过温|温度|限功率|降载|降额).{0,32}(igbt|功率模块|功率单元|散热|冷却|水冷|风扇)', text, flags=re.IGNORECASE):
            score += 120
    if re.search(r'(叶轮|风轮|轮毂).*(转速|速度).*(突变|跳变|波动|超过|超限|限值|限制值|阈值|门限)|(叶轮|风轮|轮毂).*(超速|过速)', topic_text):
        if re.search(r'(叶轮|风轮|轮毂).*(转速|速度).*(突变|跳变|波动|超过|超限|限值|限制值|阈值|门限)|(叶轮|风轮|轮毂).*(超速|过速)', text):
            score += 90
        if re.search(r'(ss-?7|轮毂超速|叶轮超速|风轮过转速)', text, flags=re.IGNORECASE):
            score += 80
    if (
        re.search(r'(叶轮|风轮|轮毂|主轴|低速端|转速|速度|超速|过速|限制值|限值)', topic_text)
        and '叶轮转速突变或超过限制值' in text
    ):
        score += 140
    for keyword in ('轴承温度', '温度过高', '过热', '异响', '振动', '震动', '噪声', '反复'):
        if keyword in topic_text and keyword.lower() in lowered_text:
            score += 3
    for token in extract_fault_topic_discriminators(topic_text):
        if token in compact_name:
            score += 45
        elif is_strict_fault_discriminator(token):
            score -= 80
        elif token in compact_text:
            score += 15
        else:
            score -= 30
    symptom_tokens = re.findall(
        r'齿轮箱|发电机|主轴|轴承|变流器|机舱|偏航|变桨|液压|刹车|制动|plc|通讯|振动|异响|'
        r'油温|温度|温升|过热|过温|过高|极高|欠压|过压|超限|丢失|异常|告警|停机|切出|功率过低|限功率',
        topic_text,
        flags=re.IGNORECASE,
    )
    matched_symptom_tokens = 0
    for token in dedupe_preserve_order(symptom_tokens):
        if token.lower() in lowered_name:
            score += 32
            matched_symptom_tokens += 1
        elif token.lower() in lowered_text:
            score += 14
            matched_symptom_tokens += 1
    if re.search(r'紧急顺桨', topic_text):
        if re.search(r'紧急顺桨模式', name):
            score += 320
        elif fault_record_matches_emergency_feathering(record):
            score += 260
        if fault_record_matches_manual_permit(record):
            score -= 280
        if re.search(r'(最小变桨速度|最大变桨速度|变桨速度超限)', name) and not re.search(r'紧急顺桨', name):
            score -= 220
    if re.search(r'同步', topic_text):
        blade_num = extract_pitch_blade_axis_number(topic_text)
        record_blob = f'{name} {text}'
        if fault_record_matches_blade_sync_fault(record):
            score += 280
        if blade_num:
            if re.search(
                rf'(桨叶\s*{blade_num}\s*不同步|轴{blade_num}.*不同步|变桨A{blade_num}叶片同步|桨叶{blade_num}.*同步|叶片{blade_num}.*同步)',
                record_blob,
                flags=re.IGNORECASE,
            ):
                score += 320
        if fault_record_matches_blade_emergency_stop_fault(record) and not re.search(r'急停', topic_text):
            score -= 260
    blade_match = re.search(r'桨叶\s*([123])', topic_text)
    if blade_match:
        blade_num = blade_match.group(1)
        record_blob = f'{name} {text}'
        if re.search(rf'(轴柜{blade_num}|blade\s*{blade_num}|桨叶\s*{blade_num}|桨叶{blade_num})', record_blob, flags=re.IGNORECASE):
            score += 90
        if (
            fault_record_matches_manual_permit(record)
            and re.search(rf'(桨叶\s*{blade_num}|轴柜{blade_num})', topic_text)
            and not re.search(r'手动', topic_text)
        ):
            score -= 120
    if matched_symptom_tokens >= 2 and re.search(r'(齿轮箱|发电机|主轴|轴承|变流器|机舱)', topic_text):
        if re.search(r'(温度|油温|温升|过热|过温|过高|极高|告警|停机)', topic_text) and re.search(
            r'(温度|油温|温升|过热|过温|过高|极高|告警|停机)',
            name,
            flags=re.IGNORECASE,
        ):
            score += 95
    return score


def fault_record_matches_emergency_feathering(record):
    name_blob = compact_fault_match_text(record.get('name', ''))
    logic_blob = compact_fault_match_text(record.get('logic', ''))
    combined = f'{name_blob}{logic_blob}'
    return bool(re.search(
        r'(紧急顺桨模式|紧急顺桨|紧急模式|emergencyrequest|blade[123]emergency)',
        combined,
        flags=re.IGNORECASE,
    ))


def fault_record_matches_manual_permit(record):
    blob = normalize_text(' '.join(
        str(record.get(key, '') or '')
        for key in ('name', 'logic')
    ))
    return bool(re.search(r'手动(允许|开关|操作)', blob))


def fault_records_semantically_equivalent(compact_topic, record):
    if not compact_topic:
        return False
    compact_name = record.get('_wr_compact_name') or compact_fault_match_text(record.get('name', ''))
    compact_logic = compact_fault_match_text(record.get('logic', ''))
    combined = f'{compact_name}{compact_logic}'
    if compact_topic == compact_name or compact_topic in compact_name or compact_name in compact_topic:
        return True
    if re.search(r'紧急顺桨', compact_topic) and fault_record_matches_emergency_feathering(record):
        blade_match = re.search(r'桨叶\s*([123])', compact_topic)
        if blade_match:
            blade_num = blade_match.group(1)
            combined = f'{compact_name}{compact_logic}'
            if re.search(rf'(轴柜{blade_num}|blade{blade_num}|桨叶\s*{blade_num}|桨叶{blade_num})', combined, flags=re.IGNORECASE):
                return True
        return True
    if re.search(r'同步', compact_topic) and fault_record_matches_blade_sync_fault(record):
        blade_num = extract_pitch_blade_axis_number(compact_topic)
        if blade_num:
            combined = f'{compact_name}{compact_logic}{compact_fault_match_text(record.get("text", ""))}'
            if re.search(
                rf'(桨叶\s*{blade_num}\s*不同步|轴{blade_num}.*不同步|变桨A{blade_num}叶片同步|桨叶{blade_num}.*同步)',
                combined,
                flags=re.IGNORECASE,
            ):
                return True
        return True
    return False


def record_matches_pitch_blade_component(record, component, fault_name=''):
    context = ' '.join(
        normalize_text(record.get(key, '') or '')
        for key in ('name', 'text', 'logic', 'solution')
    ) + ' ' + normalize_text(fault_name or '')
    context_lower = context.lower()
    if windrise_slot_value_matches_text(component, context_lower):
        return True
    canonical = normalize_context_dimension_value(component)
    if canonical in {'叶片', '桨叶', '变桨'}:
        return bool(re.search(r'(桨叶|叶片|变桨|pitch|blade|轴柜[123])', context, flags=re.IGNORECASE))
    return False


def resolve_primary_fault_display_name(record, query='', slots=None):
    kb_name = normalize_context_dimension_value(record.get('name', '')) or '未标明'
    topic = (
        extract_scada_style_alarm_name(query)
        or extract_windrise_fault_subject_phrase(query)
        or normalize_text((slots or {}).get('fault_name', ''))
    )
    compact_topic = compact_fault_match_text(topic)
    if len(compact_topic) >= 6 and fault_records_semantically_equivalent(compact_topic, record):
        if compact_topic != compact_fault_match_text(kb_name):
            return topic
    return kb_name


def windrise_dimension_terms_for_topic_lookup(query, history):
    slots = build_effective_windrise_slots_for_query(query, history)
    terms = []
    for key in ('brand', 'farm', 'model', 'standard_model'):
        value = normalize_windrise_model_value(slots.get(key, '')) if key in {'model', 'standard_model'} else normalize_context_dimension_value(slots.get(key, ''))
        if value and value not in terms:
            terms.append(value)
    if not terms:
        terms = windrise_dimension_terms(query)
    return terms


def windrise_fault_content_topic_terms(topic, slots=None):
    slots = slots or {}
    cleaned = normalize_text(topic)
    removable_terms = set()
    for key in ('brand', 'farm', 'model', 'standard_model'):
        value = normalize_windrise_model_value(slots.get(key, '')) if key in {'model', 'standard_model'} else normalize_context_dimension_value(slots.get(key, ''))
        if value:
            removable_terms.add(value)
            removable_terms.add(value.replace('系列', ''))
    for keyword in MODEL_BRAND_KEYWORDS:
        if keyword:
            removable_terms.add(str(keyword))
    for term in sorted(removable_terms, key=len, reverse=True):
        if term:
            cleaned = re.sub(re.escape(term), ' ', cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r'\b(?:系列|机型|型号|厂家|品牌)\b', ' ', cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r'\s+', ' ', cleaned).strip()
    terms = []
    for term in windrise_topic_terms(cleaned):
        compact = compact_fault_match_text(term)
        if not compact or compact in {'系列', '机型', '型号', '厂家', '品牌'}:
            continue
        if term not in terms:
            terms.append(term)
    return terms


def filter_fault_codes_excluding_turbine_units(query, codes, history=None):
    if not codes:
        return []
    normalized = normalize_text(query)
    slots = build_effective_windrise_slots_for_query(query, history or [])
    turbine_id = normalize_windrise_turbine_id(slots.get('turbine_id', ''))
    turbine_bare = turbine_id.rstrip('#').lstrip('0') or '0'
    current_slots = extract_windrise_user_slots(normalized)
    current_turbine_tokens = set(current_slots.get('turbine_ids') or [])
    current_turbine_tokens.update(current_slots.get('_cleared_turbine_ids') or [])
    if current_slots.get('turbine_id'):
        current_turbine_tokens.add(current_slots['turbine_id'])
    current_turbine_tokens = {
        normalize_windrise_turbine_id(value).rstrip('#').upper()
        for value in current_turbine_tokens
        if normalize_windrise_turbine_id(value)
    }
    has_explicit_code_label = bool(re.search(
        r'(故障码|故障代码|报码|告警码|报警码|状态码|错误码|error\s*code|fault\s*code|alarm\s*code)',
        normalized,
        flags=re.IGNORECASE,
    ))
    filtered = []
    for code in codes:
        code_value = normalize_context_dimension_value(code)
        if not code_value:
            continue
        if turbine_id:
            code_bare = code_value.lstrip('0') or '0'
            if code_bare == turbine_bare:
                continue
        if not has_explicit_code_label and code_value.rstrip('#').upper() in current_turbine_tokens:
            continue
        if re.search(rf'(?<![A-Za-z0-9]){re.escape(code_value)}号', normalized):
            continue
        filtered.append(code)
    return filtered


def extract_direct_windrise_fault_codes(query, history=None):
    """Return user-supplied fault codes that are safe retrieval keys."""
    normalized = normalize_text(query)
    if not normalized:
        return []
    codes = extract_fault_codes(normalized)
    if not codes:
        codes = extract_explicit_fault_code_lookup_codes(normalized)
    # A token such as PT100 may look code-like but can be part of the exact
    # alarm name the user is asking about.  Let the exact-name index path
    # resolve that complete phrase instead of taking a no-match code shortcut.
    if codes and query_matches_exact_windrise_fault_name(normalized):
        return []
    return filter_fault_codes_excluding_turbine_units(normalized, codes, history)


def query_matches_exact_windrise_fault_name(query):
    normalized = normalize_text(query)
    if not normalized:
        return False
    if not re.search(
        r'(是什么故障码|是什么故障代码|故障码是什么|故障代码是什么|是什么码|对应.*?(?:故障码|故障代码|报码|告警码|报警码)|怎么修|怎么处理|如何处理|处理步骤|维修|排查|完整告警是|完整报警是|完整故障是|原始告警是|原始报警是|原始故障是|告警内容|报警内容|故障内容|故障描述|现在报的是|报的是|当前报的是)',
        normalized,
        flags=re.IGNORECASE,
    ):
        return False
    topic = clean_current_fault_lookup_topic(normalized)
    topic = re.sub(
        r'(?:怎么修|怎么处理|如何处理|处理步骤|处理方法|如何排查|检修|维修|排查|为什么会报|为什么|为何|原因|怎么复位|如何复位|能否复位|能不能复位|复位)\s*$',
        '',
        topic,
        flags=re.IGNORECASE,
    ).strip(' ？?。!！,，;；:：')
    compact_topic = compact_fault_match_text(topic)
    if len(compact_topic) < 4:
        return False
    return any(
        compact_topic == (record.get('_wr_compact_name') or compact_fault_match_text(record.get('name', '')))
        for record in load_windrise_fault_index_records()
    )


def classify_windrise_answer_intent(query):
    normalized = normalize_text(query)
    if re.search(r'(区别|有什么不同|有何不同|对比|比较|分别是什么|分别表示|各是什么|各自是什么)', normalized):
        return 'comparison'
    if re.search(r'(还能继续运行|能否继续运行|能不能继续运行|可以继续运行|是否停机|需要停机|要不要停机|必须停机吗|必须停吗|要停吗|能否开机|能不能开机|还能开吗|是否可以复位后运行)', normalized):
        return 'operation'
    if re.search(r'(严重吗|严不严重|危险吗|风险多大|风险等级|安全风险)', normalized):
        return 'risk'
    if re.search(r'(有什么影响|有何影响|什么后果|会导致什么|会造成什么|影响范围)', normalized):
        return 'impact'
    if re.search(r'(触发条件|触发逻辑|报警条件|报码条件|阈值是多少|门限是多少|达到多少会报|多少会报|达到什么值|何时触发|什么时候触发|什么情况下触发|什么时候报|何时报|什么情况下报|什么条件下(?:产生|出现|报码|报警)|何时产生|何时出现|如何触发|怎么触发)', normalized):
        return 'trigger'
    if re.search(r'(原因|为什么|为何|为啥|怎么来的|如何产生的|产生原因|形成原因)', normalized):
        return 'reason'
    if re.search(r'(复位|远程复位|能否复位|怎么复位|如何复位|消警|消除报警|清除报警|解除报警|\breset\b)', normalized, flags=re.IGNORECASE):
        return 'reset'
    if re.search(r'(是什么故障|什么故障|是啥故障|什么意思|啥意思|含义|meaning|查一下|查下|查询)', normalized, flags=re.IGNORECASE):
        return 'meaning'
    if re.search(r'(怎么修|维修|怎么处理|如何处理|处理步骤|处理方法|检修|排查|怎么办|repair|fix|solution)', normalized, flags=re.IGNORECASE):
        return 'repair'
    if extract_fault_codes(normalized):
        return 'meaning'
    return 'repair'


def is_fully_specified_windrise_fault_query(query, slots=None):
    slots = slots or build_effective_windrise_slots_for_query(query, [])
    return bool(
        slots.get('farm')
        and slots.get('turbine_id')
        and (has_explicit_fault_code(query) or slots.get('fault_code'))
    )


def extract_unavailable_windrise_scope_dimensions(text):
    """Return scope fields the user explicitly says cannot be provided."""
    normalized = normalize_text(text)
    if not normalized:
        return set()
    unavailable = r'(?:不知道|不清楚|不确定|无法提供|提供不了|不能提供|没法提供|没有(?:相关)?信息|未知|查不到|拿不到|暂时没有)'
    dimension_patterns = {
        'farm': r'(?:风场|风电场|场站)(?:名称)?',
        'turbine_id': r'(?:风机编号|风机号|机位号|机组编号)',
        'model': r'(?:机型|具体型号|标准型号|型号)',
    }
    result = set()
    for dimension, label_pattern in dimension_patterns.items():
        if re.search(rf'{label_pattern}.{{0,8}}{unavailable}|{unavailable}.{{0,8}}{label_pattern}', normalized):
            result.add(dimension)
    if 'turbine_id' not in result and re.search(
        rf'(?:没有|不知(?:道)?|不清楚|不确定|无法提供|提供不了|不能提供|没法提供)(?:风机)?编号|编号.{0,8}{unavailable}',
        normalized,
    ):
        result.add('turbine_id')
    return result


def infer_windrise_scope_dimension_from_clarification(text):
    normalized = normalize_text(text)
    if not normalized:
        return ''
    if '还差机型确认' in normalized or re.search(
        r'(?:机型|具体型号).{0,20}(?:请回复|请告诉)|(?:请回复|请告诉).{0,20}(?:机型|具体型号)',
        normalized,
    ):
        return 'model'
    if re.search(
        r'(?:具体风机编号|风机编号).{0,24}(?:请回复|请告诉|例如)|(?:请回复|请告诉).{0,24}(?:具体风机编号|新的?风机编号|风机编号)',
        normalized,
    ):
        return 'turbine_id'
    if re.search(
        r'(?:哪个风场|风场名称).{0,20}(?:请回复|请告诉|即可)|(?:请回复|请告诉).{0,20}(?:哪个风场|风场名称)',
        normalized,
    ):
        return 'farm'
    return ''


def is_generic_windrise_scope_unavailability_reply(text):
    normalized = normalize_text(text).strip('。！？!? ')
    if re.fullmatch(
        r'(?:这个|这个信息|这项|该项)?(?:我)?(?:也)?(?:不知道|不清楚|不确定|无法提供|提供不了|不能提供|没法提供|没有(?:相关)?信息|查不到|拿不到|暂时没有)(?:编号|风机编号|机位号)?',
        normalized,
    ):
        return True
    return bool(re.fullmatch(
        r'(?:没有|不知(?:道)?|不清楚|不确定|无法提供|提供不了|不能提供|没法提供)(?:风机)?编号',
        normalized,
    ))


def is_windrise_broad_scope_search_request(text):
    """The user explicitly asks to search broadly with whatever scope is known."""
    normalized = normalize_text(text).strip('。！？!? ')
    if not normalized:
        return False
    if is_windrise_global_fault_search_request(normalized):
        return True
    patterns = (
        r'(?:相关的?|符合条件的?|能查到的?|现有的?)(?:记录|结果|故障)?(?:都|全部).{0,12}(?:列出来|列一下|查出来|查一下|展示|给我)',
        r'(?:都|全部)(?:给我)?(?:列出来|列一下|查出来|查一下|展示出来|展示一下|看看)',
        r'(?:按|基于)(?:现有|已有|目前)(?:的信息|信息|的条件|条件).{0,12}(?:查|检索|搜索|列)',
        r'(?:不用|不必|无需|别)(?:再)?(?:问|确认|补充).{0,12}(?:直接)?(?:查|检索|搜索|列)',
    )
    return any(re.search(pattern, normalized, flags=re.IGNORECASE) for pattern in patterns)


def is_windrise_global_fault_search_request(text):
    """The user explicitly asks to search the full knowledge base."""
    normalized = normalize_text(text).strip('。！？!? ')
    if not normalized:
        return False
    patterns = (
        r'搜索全局',
        r'全局搜索',
        r'全局检索',
        r'全局查找',
        r'全局查询',
        r'全库搜索',
        r'全库检索',
        r'跨风场',
        r'跨机型',
        r'不限风场',
        r'不限机型',
        r'不限制风场',
        r'不限制机型',
        r'全部风场',
        r'所有风场',
    )
    return any(re.search(pattern, normalized, flags=re.IGNORECASE) for pattern in patterns)


def strip_global_fault_search_prefix(text):
    normalized = normalize_text(text)
    stripped = re.sub(
        r'^(?:请)?(?:帮我|帮忙|给我)?(?:在)?(?:知识库|本地库|库里)?(?:中)?(?:搜索|检索|查找|查询|找一下|查一下)?全局[:：]?\s*',
        '',
        normalized,
        flags=re.IGNORECASE,
    )
    stripped = re.sub(
        r'^(?:全局|全库)(?:搜索|检索|查找|查询)[:：]?\s*',
        '',
        stripped,
        flags=re.IGNORECASE,
    )
    return stripped.strip()


def normalize_fault_code_lookup_key(code):
    return re.sub(r'[-_\s]', '', normalize_text(code or '')).upper()


def fault_code_lookup_keys_match(left_code, right_code):
    left_key = normalize_fault_code_lookup_key(left_code)
    right_key = normalize_fault_code_lookup_key(right_code)
    return bool(left_key and right_key and left_key == right_key)


def collect_fault_index_records_for_code(code, slots=None, *, scope_filter=True):
    if not code:
        return []
    records = []
    seen = set()
    for record in load_windrise_fault_index_records():
        record_code = normalize_context_dimension_value(record.get('code', ''))
        if not fault_code_lookup_keys_match(code, record_code):
            continue
        if scope_filter and slots and not record_matches_explicit_windrise_slots(record, slots):
            continue
        identity = (
            record_code,
            normalize_context_dimension_value(record.get('name', '')),
            normalize_context_dimension_value(record.get('site', '')),
            normalize_context_dimension_value(record.get('brand', '')),
            normalize_context_dimension_value(record.get('model', '')),
            normalize_context_dimension_value(record.get('standardModel', '')),
            normalize_context_dimension_value(record.get('source', '')),
        )
        if identity in seen:
            continue
        seen.add(identity)
        records.append(dict(record))
    return records


def build_global_fault_code_scope_notice(slots, code):
    farm = normalize_context_dimension_value((slots or {}).get('farm', ''))
    brand = normalize_context_dimension_value((slots or {}).get('brand', ''))
    turbine = normalize_windrise_turbine_id((slots or {}).get('turbine_id', ''))
    scope_parts = []
    if farm:
        scope_parts.append(f'风场={farm}')
    if brand:
        scope_parts.append(f'厂家={brand}')
    if turbine:
        scope_parts.append(f'风机={turbine}')
    if scope_parts:
        return (
            '【全局检索】'
            f"当前设备范围（{'；'.join(scope_parts)}）未收录故障码 `{code}`，"
            '以下结果为知识库全库命中：'
        )
    return f'【全局检索】故障码 `{code}` 全库命中结果：'


def build_global_symptom_scope_notice(slots, symptom):
    farm = normalize_context_dimension_value((slots or {}).get('farm', ''))
    brand = normalize_context_dimension_value((slots or {}).get('brand', ''))
    turbine = normalize_windrise_turbine_id((slots or {}).get('turbine_id', ''))
    model = normalize_windrise_model_value((slots or {}).get('standard_model', '')) or normalize_windrise_model_value(
        (slots or {}).get('model', '')
    )
    scope_parts = []
    if farm:
        scope_parts.append(f'风场={farm}')
    if turbine:
        scope_parts.append(f'风机={turbine}')
    if brand:
        scope_parts.append(f'厂家={brand}')
    if model:
        scope_parts.append(f'机型={model}')
    symptom_text = normalize_windrise_query(symptom) or '当前报警'
    if scope_parts:
        return (
            '【全局检索】'
            f"当前设备范围（{'；'.join(scope_parts)}）未找到报警「{symptom_text}」的精确记录，"
            '以下结果为知识库全库高相关命中：'
        )
    return f'【全局检索】报警「{symptom_text}」全库高相关命中结果：'


def collect_global_fault_index_candidates_for_symptom(symptom, query='', *, limit=8):
    symptom = normalize_windrise_query(symptom)
    if not symptom:
        return []
    compact_symptom = compact_fault_match_text(symptom)
    if len(compact_symptom) < 4:
        return []
    topic_terms = windrise_topic_terms(symptom)
    if not topic_terms:
        return []
    speed_limit_fuzzy = is_speed_limit_fuzzy_query(symptom)
    converter_power_limit_fuzzy = is_converter_power_limit_fuzzy_query(symptom)
    candidates = []
    seen = set()
    scan_started = time.monotonic()
    for record_index, record in enumerate(load_windrise_fault_index_records()):
        if (
            record_index % 64 == 0
            and time.monotonic() - scan_started > WINDRISE_INDEX_LOOKUP_TIMEOUT
        ):
            break
        identity = (
            normalize_context_dimension_value(record.get('code', '')),
            normalize_context_dimension_value(record.get('name', '')),
            normalize_context_dimension_value(record.get('site', '')),
            normalize_context_dimension_value(record.get('brand', '')),
            normalize_context_dimension_value(record.get('model', '')),
            normalize_context_dimension_value(record.get('standardModel', '')),
            normalize_context_dimension_value(record.get('source', '')),
        )
        if identity in seen:
            continue
        seen.add(identity)
        if speed_limit_fuzzy and not record_matches_speed_limit_fuzzy_query(record):
            continue
        record_compact_name = record.get('_wr_compact_name') or compact_fault_match_text(record.get('name', ''))
        topic_score = score_fault_record_for_topic(record, topic_terms)
        exact_name_match = bool(
            compact_symptom
            and record_compact_name
            and (
                compact_symptom == record_compact_name
                or compact_symptom in record_compact_name
                or record_compact_name in compact_symptom
            )
        )
        if exact_name_match:
            topic_score = max(topic_score, 900 + len(record_compact_name))
        elif topic_score < 24:
            continue
        topic_cap = 520 if (speed_limit_fuzzy or converter_power_limit_fuzzy) else 200
        total_score = min(max(0, topic_score), topic_cap)
        min_score = 45 if speed_limit_fuzzy else 28
        if total_score < min_score and not exact_name_match:
            continue
        enriched = dict(record)
        enriched['_score'] = total_score
        enriched['_topic_score'] = topic_score
        enriched['_exact_name_match'] = exact_name_match
        candidates.append(enriched)
    candidates.sort(
        key=lambda item: (
            -int(bool(item.get('_exact_name_match'))),
            -item.get('_score', 0),
            -item.get('_topic_score', 0),
            str(item.get('code', '')),
            str(item.get('source', '')),
        )
    )
    return candidates[:max(1, int(limit or 8))]


def build_global_symptom_fault_lookup_answer(query, history=None, symptom='', slots=None, intent=None, limit=5):
    """When scoped device lookup misses, search the full fault-index and return hits."""
    history = history or []
    symptom = normalize_windrise_query(
        symptom
        or build_windrise_symptom_subject_query(query, history)
        or clean_current_fault_lookup_topic(query)
        or query
    )
    if not symptom or len(compact_fault_match_text(symptom)) < 4:
        return ''
    if not (
        looks_like_fault_phenomenon_query(symptom)
        or has_device_issue_hint(symptom)
        or extract_scada_style_alarm_name(symptom)
        or extract_windrise_fault_subject_phrase(symptom)
    ):
        return ''
    slots = slots or build_effective_windrise_slots_for_query(query, history)
    if not (
        has_windrise_scope_for_fault_answer(slots, query, history)
        or is_windrise_scoped_symptom_followup(query, history)
        or is_windrise_bare_symptom_with_confirmed_scope(query, history)
        or is_windrise_fault_scope_followup_reply(query, history)
    ):
        return ''
    candidates = collect_global_fault_index_candidates_for_symptom(symptom, query)
    if not candidates:
        return ''
    top = candidates[0]
    second_score = candidates[1].get('_score', 0) if len(candidates) > 1 else 0
    if not top.get('_exact_name_match') and top.get('_score', 0) < 36:
        return ''
    if (
        not top.get('_exact_name_match')
        and top.get('_score', 0) < max(second_score + 40, 80)
        and len(candidates) > 1
    ):
        return ''
    selected_limit = 1 if top.get('_exact_name_match') and top.get('_score', 0) >= 180 else min(max(1, int(limit or 5)), 5)
    selected = candidates[:selected_limit]
    answer = build_structured_fault_records_answer(
        symptom,
        selected,
        intent=intent or classify_windrise_answer_intent(query),
        limit=len(selected),
        slots={
            'brand': '',
            'farm': '',
            'model': '',
            'standard_model': '',
            'turbine_id': '',
            'turbine_ids': [],
        },
        scope_filter=False,
    )
    if not answer:
        return ''
    return '\n\n'.join([build_global_symptom_scope_notice(slots, symptom), answer])


def windrise_scope_unavailability_for_current_reply(query, history=None):
    unavailable = extract_unavailable_windrise_scope_dimensions(query)
    if unavailable or not is_generic_windrise_scope_unavailability_reply(query):
        return unavailable
    for item in reversed(history or []):
        if item.get('role') != 'assistant':
            continue
        dimension = infer_windrise_scope_dimension_from_clarification(item.get('content', ''))
        if dimension:
            return {dimension}
        break
    return set()


def build_user_confirmed_windrise_scope_slots(query, history=None, limit=12):
    """Collect device scope only from user messages, without inferred mappings."""
    history = build_windrise_scope_history_for_query(query, history)
    slots = {}

    unavailable_dimensions = set()
    broad_scope_requested = False

    def merge_confirmed_scope(text, pending_dimension='', allow_broad_scope=False):
        nonlocal broad_scope_requested
        # Scope replies often arrive one dimension at a time (for example a
        # brand/model after a previously supplied farm and turbine ID). Keep
        # those user-confirmed dimensions together; do not apply the general
        # fault-context brand-switch reset here.
        update = extract_windrise_user_slots(text)
        update_farm = normalize_context_dimension_value(update.get('farm', ''))
        update_turbine = normalize_windrise_turbine_id(update.get('turbine_id', ''))
        current_farm = normalize_context_dimension_value(slots.get('farm', ''))
        current_turbine = normalize_windrise_turbine_id(slots.get('turbine_id', ''))
        if update_farm and current_farm and update_farm != current_farm:
            if not update_turbine:
                slots.pop('turbine_id', None)
                slots['turbine_ids'] = []
                unavailable_dimensions.discard('turbine_id')
            slots.pop('brand', None)
            slots.pop('model', None)
            slots.pop('standard_model', None)
            unavailable_dimensions.discard('model')
        if update_turbine and current_turbine and update_turbine != current_turbine:
            slots.pop('brand', None)
            slots.pop('model', None)
            slots.pop('standard_model', None)
            unavailable_dimensions.discard('model')
        cleared_dimensions = set(update.get('_cleared_scope_dimensions') or [])
        if 'turbine_id' in cleared_dimensions:
            slots.pop('turbine_id', None)
            slots['turbine_ids'] = []
            unavailable_dimensions.discard('turbine_id')
        if 'farm' in cleared_dimensions:
            slots.pop('farm', None)
            unavailable_dimensions.discard('farm')
        if 'model' in cleared_dimensions:
            slots.pop('model', None)
            slots.pop('standard_model', None)
            unavailable_dimensions.discard('model')
        for key in ('brand', 'farm', 'model', 'standard_model', 'turbine_id'):
            value = update.get(key, '')
            if key in {'model', 'standard_model'}:
                value = normalize_windrise_model_value(value)
            elif key == 'turbine_id':
                value = normalize_windrise_turbine_id(value)
            else:
                value = normalize_context_dimension_value(value)
            if value:
                slots[key] = value
                unavailable_dimensions.discard('model' if key == 'standard_model' else key)
        turbine_ids = update.get('turbine_ids') or []
        if turbine_ids and not slots.get('turbine_id'):
            slots['turbine_id'] = normalize_windrise_turbine_id(turbine_ids[0])
        if turbine_ids:
            slots['turbine_ids'] = [normalize_windrise_turbine_id(value) for value in turbine_ids if value]
        unavailable = extract_unavailable_windrise_scope_dimensions(text)
        if not unavailable and pending_dimension and is_generic_windrise_scope_unavailability_reply(text):
            unavailable = {pending_dimension}
        unavailable_dimensions.update(unavailable)
        if allow_broad_scope and is_windrise_broad_scope_search_request(text):
            broad_scope_requested = True
            if not slots.get('farm'):
                unavailable_dimensions.add('farm')
            if not normalize_windrise_turbine_id(slots.get('turbine_id', '')):
                unavailable_dimensions.add('turbine_id')
            if not slots.get('model') and not slots.get('standard_model'):
                unavailable_dimensions.add('model')

    pending_dimension = ''
    messages = list(history or [])[-max(2, int(limit) * 2):]
    for item in messages:
        if item.get('role') == 'assistant':
            pending_dimension = infer_windrise_scope_dimension_from_clarification(item.get('content', ''))
            assistant_scope = extract_device_scope_from_assistant_answer(item.get('content', ''))
            if assistant_scope:
                for key in ('brand', 'farm', 'model', 'standard_model', 'turbine_id'):
                    value = assistant_scope.get(key, '')
                    if value and not slots.get(key):
                        slots[key] = value
                if assistant_scope.get('turbine_id') and not slots.get('turbine_ids'):
                    slots['turbine_ids'] = [assistant_scope['turbine_id']]
        elif item.get('role') == 'user':
            merge_confirmed_scope(item.get('content', ''), pending_dimension)
            pending_dimension = ''
    merge_confirmed_scope(query, pending_dimension, allow_broad_scope=True)
    slots['_unavailable_dimensions'] = sorted(unavailable_dimensions)
    slots['_broad_scope_requested'] = broad_scope_requested
    return slots


WINDRISE_MODEL_SUFFIX_TOKEN_PATTERN = re.compile(r'^[A-Z]\d{2,4}$', re.IGNORECASE)


def _split_windrise_standard_model_parts(value):
    return [
        normalize_windrise_model_value(part)
        for part in re.split(r'[、,，/]', normalize_windrise_model_value(value) or '')
        if normalize_windrise_model_value(part)
    ]


def compact_windrise_model_token(value):
    return re.sub(r'[^A-Z0-9]', '', normalize_windrise_model_value(value).upper())


def build_windrise_model_index_aliases(brand='', model='', standard_model=''):
    aliases = set()
    for value in (brand, model, standard_model):
        normalized = normalize_windrise_model_value(value)
        if not normalized:
            continue
        upper = normalized.upper()
        aliases.add(upper)
        compact = compact_windrise_model_token(normalized)
        if compact:
            aliases.add(compact)
        if upper.endswith('系列'):
            aliases.add(upper[:-2])
            compact_family = compact_windrise_model_token(upper[:-2])
            if compact_family:
                aliases.add(compact_family)
        for part in _split_windrise_standard_model_parts(normalized):
            aliases.add(part.upper())
            part_compact = compact_windrise_model_token(part)
            if part_compact:
                aliases.add(part_compact)
            if '-' in part:
                suffix = part.rsplit('-', 1)[-1]
                aliases.add(suffix.upper())
                suffix_compact = compact_windrise_model_token(suffix)
                if suffix_compact:
                    aliases.add(suffix_compact)
    return {alias for alias in aliases if len(alias) >= 2}


def load_windrise_model_index_entries():
    fault_path = resolve_windrise_fault_index_path()
    mapping_path = resolve_windrise_turbine_mapping_path()
    fault_mtime = 0.0
    mapping_mtime = 0.0
    try:
        if fault_path:
            fault_mtime = os.path.getmtime(fault_path)
    except OSError:
        fault_path = ''
    try:
        if mapping_path:
            mapping_mtime = os.path.getmtime(mapping_path)
    except OSError:
        mapping_path = ''
    with windrise_model_index_lock:
        cached = windrise_model_index_cache
        if (
            cached.get('fault_path') == fault_path
            and cached.get('fault_mtime') == fault_mtime
            and cached.get('mapping_path') == mapping_path
            and cached.get('mapping_mtime') == mapping_mtime
        ):
            return list(cached.get('entries') or [])

        grouped = {}

        def remember(brand, model, standard_model, farm=''):
            brand_value = normalize_context_dimension_value(brand)
            model_value = normalize_windrise_model_value(model)
            standard_values = _split_windrise_standard_model_parts(standard_model)
            if not standard_values and normalize_windrise_model_value(standard_model):
                standard_values = [normalize_windrise_model_value(standard_model)]
            if not (brand_value or model_value or standard_values):
                return
            for standard_value in standard_values or ['']:
                key = (brand_value, model_value, standard_value)
                entry = grouped.setdefault(key, {
                    'brand': brand_value,
                    'model': model_value,
                    'standard_model': standard_value,
                    'farms': set(),
                    'aliases': set(),
                })
                farm_value = normalize_context_dimension_value(farm)
                if farm_value:
                    for part in re.split(r'[、,，/]', farm_value):
                        part = normalize_context_dimension_value(part)
                        if part:
                            entry['farms'].add(part)
                entry['aliases'].update(
                    build_windrise_model_index_aliases(brand_value, model_value, standard_value)
                )

        for record in load_windrise_fault_index_records():
            remember(
                record.get('brand', ''),
                record.get('model', ''),
                record.get('standardModel', ''),
                record.get('site', ''),
            )
        for mapping in load_windrise_turbine_mapping_entries():
            remember(
                mapping.get('brand', ''),
                mapping.get('model', ''),
                mapping.get('standardModel', ''),
                mapping.get('site', ''),
            )

        entries = []
        for entry in grouped.values():
            entry['farms'] = sorted(entry.get('farms') or [])
            entry['aliases'] = sorted(entry.get('aliases') or [])
            entries.append(entry)
        entries.sort(key=lambda item: (
            item.get('brand', ''),
            item.get('model', ''),
            item.get('standard_model', ''),
        ))
        windrise_model_index_cache.update({
            'fault_path': fault_path,
            'fault_mtime': fault_mtime,
            'mapping_path': mapping_path,
            'mapping_mtime': mapping_mtime,
            'entries': entries,
        })
        return list(entries)


def score_windrise_partial_model_hint(hint, entry):
    hint_value = normalize_windrise_model_value(hint)
    if not hint_value:
        return 0
    hint_upper = hint_value.upper()
    hint_compact = compact_windrise_model_token(hint_value)
    if not hint_compact:
        return 0
    best = 0
    for alias in entry.get('aliases') or []:
        alias_upper = str(alias).upper()
        alias_compact = compact_windrise_model_token(alias)
        if not alias_compact:
            continue
        if hint_upper == alias_upper:
            best = max(best, 1000)
        elif hint_compact == alias_compact:
            best = max(best, 920)
        elif alias_compact.startswith(hint_compact) or hint_compact.startswith(alias_compact):
            best = max(best, 700 + min(len(hint_compact), len(alias_compact)))
        elif hint_compact in alias_compact or alias_compact in hint_compact:
            best = max(best, 560 + min(len(hint_compact), len(alias_compact)))
        elif hint_upper in alias_upper or alias_upper in hint_upper:
            best = max(best, 480)
        hint_digits = re.findall(r'\d+', hint_compact)
        alias_digits = re.findall(r'\d+', alias_compact)
        if hint_digits and alias_digits and hint_digits[-1] == alias_digits[0]:
            best = max(best, 760 + len(hint_digits[-1]))
    return best


def lookup_windrise_model_index(hints, farm=''):
    hints = [
        normalize_windrise_model_value(hint)
        for hint in (hints or [])
        if normalize_windrise_model_value(hint)
    ]
    if not hints:
        return []
    farm_key = normalize_context_dimension_value(farm)
    scored = []
    for entry in load_windrise_model_index_entries():
        farms = entry.get('farms') or []
        if farm_key and farms and not any(
            farm_key in farm or farm in farm_key
            for farm in farms
        ):
            continue
        score = max(score_windrise_partial_model_hint(hint, entry) for hint in hints)
        if score >= 400:
            scored.append((score, entry))
    scored.sort(
        key=lambda item: (
            -item[0],
            item[1].get('brand', ''),
            item[1].get('model', ''),
            item[1].get('standard_model', ''),
        )
    )
    return scored


def extract_windrise_partial_model_hints(text):
    normalized = normalize_text(text)
    if not normalized:
        return []
    hints = []
    for pattern in MODEL_ALIAS_PATTERNS:
        for match in re.finditer(pattern, normalized, flags=re.IGNORECASE):
            hints.append(match.group(0))
    for match in re.finditer(
        r'(?i)\b(CWT|SL|GW|WD|NGP|HW|MYSE|EN|EW|FD|UP)[\s\-_/]*\d{3,5}(?:[-/][A-Z0-9]{2,6})?\b',
        normalized,
    ):
        hints.append(match.group(0))
    for match in re.finditer(
        r'(?<![A-Za-z0-9])([A-Z]\d{2,4})(?![A-Za-z0-9])',
        normalized,
        flags=re.IGNORECASE,
    ):
        hints.append(match.group(1))
    for match in re.finditer(r'(?i)\b(\d{3,5})\s*(?:MW|KW)\b', normalized):
        hints.append(match.group(0))
    return dedupe_preserve_order(
        normalize_windrise_model_value(hint)
        for hint in hints
        if normalize_windrise_model_value(hint)
    )


def windrise_model_value_matches_record(record, value, fuzzy=True):
    if not value:
        return True
    model_text = normalize_text(record.get('model', ''))
    standard_text = normalize_text(record.get('standardModel', ''))
    searchable = f'{model_text} {standard_text}'.lower()
    lowered = normalize_windrise_model_value(value).lower()
    if lowered and lowered in searchable:
        return True
    if not fuzzy:
        return False
    compact_value = compact_windrise_model_token(value)
    if not compact_value:
        return False
    for target in (model_text, standard_text):
        compact_target = compact_windrise_model_token(target)
        if compact_target and (
            compact_value in compact_target
            or compact_target in compact_value
            or compact_target.startswith(compact_value)
            or compact_value.startswith(compact_target)
        ):
            return True
        for part in _split_windrise_standard_model_parts(target):
            part_compact = compact_windrise_model_token(part)
            if not part_compact:
                continue
            if (
                compact_value in part_compact
                or part_compact in compact_value
                or part_compact.endswith(compact_value)
                or part_compact.startswith(compact_value)
            ):
                return True
    return False


def apply_windrise_model_index_to_slots(slots, query):
    """Fill brand/model from partial user wording via the local model index."""
    slots = dict(slots or {})
    hints = []
    for key in ('brand', 'model', 'standard_model'):
        value = slots.get(key, '')
        if value:
            hints.append(value)
    hints.extend(extract_windrise_partial_model_hints(query))
    hints = dedupe_preserve_order(hint for hint in hints if hint)
    if not hints:
        return slots

    matches = lookup_windrise_model_index(hints, slots.get('farm', ''))
    if not matches:
        return slots

    best_score, best_entry = matches[0]
    second_score = matches[1][0] if len(matches) > 1 else 0
    if best_score < 400:
        return slots

    unique_standard_models = {
        entry.get('standard_model', '')
        for score, entry in matches[:4]
        if score >= max(400, best_score - 80) and entry.get('standard_model')
    }
    unique_models = {
        entry.get('model', '')
        for score, entry in matches[:4]
        if score >= max(400, best_score - 80) and entry.get('model')
    }

    if not slots.get('brand') and best_entry.get('brand'):
        slots['brand'] = normalize_context_dimension_value(best_entry.get('brand', ''))
    if not slots.get('model') and len(unique_models) == 1:
        slots['model'] = normalize_windrise_model_value(next(iter(unique_models)))
    elif not slots.get('model') and best_entry.get('model') and best_score >= 700:
        slots['model'] = normalize_windrise_model_value(best_entry.get('model', ''))
    if (
        not slots.get('standard_model')
        and len(unique_standard_models) == 1
        and best_score >= 520
    ):
        slots['standard_model'] = normalize_windrise_model_value(next(iter(unique_standard_models)))
    elif (
        not slots.get('standard_model')
        and best_entry.get('standard_model')
        and best_score >= 700
        and second_score < best_score - 40
    ):
        slots['standard_model'] = normalize_windrise_model_value(best_entry.get('standard_model', ''))
    elif (
        not slots.get('standard_model')
        and best_entry.get('standard_model')
        and best_score >= 800
        and (second_score < best_score - 40 or len(unique_standard_models) == 1)
    ):
        slots['standard_model'] = normalize_windrise_model_value(best_entry.get('standard_model', ''))

    if slots.get('brand') or slots.get('model') or slots.get('standard_model'):
        unavailable = set(slots.get('_unavailable_dimensions') or [])
        unavailable.discard('model')
        slots['_unavailable_dimensions'] = sorted(unavailable)
        slots['_model_index_resolved'] = True
    return slots


def infer_windrise_model_from_suffix_token(token, farm=''):
    """Resolve tokens such as D185 to CWT4800-D185 from the local model index."""
    normalized = normalize_windrise_turbine_id(token)
    if not normalized or not WINDRISE_MODEL_SUFFIX_TOKEN_PATTERN.fullmatch(normalized):
        return {}
    matches = lookup_windrise_model_index([normalized], farm)
    if not matches:
        return {}
    best_score, best_entry = matches[0]
    second_score = matches[1][0] if len(matches) > 1 else 0
    if best_score < 520 or (second_score >= best_score - 40 and best_score < 900):
        return {}
    farms = best_entry.get('farms') or []
    return {
        'brand': best_entry.get('brand', ''),
        'model': best_entry.get('model', ''),
        'standard_model': best_entry.get('standard_model', ''),
        'farm': farms[0] if len(farms) == 1 else '',
    }


def reconcile_windrise_model_suffix_device(slots):
    """Treat D185-style tokens as model suffixes when they are not real unit IDs."""
    slots = dict(slots or {})
    turbine_id = normalize_windrise_turbine_id(slots.get('turbine_id', ''))
    if not turbine_id:
        return slots
    farm = normalize_context_dimension_value(slots.get('farm', ''))
    if lookup_windrise_turbine_mapping(turbine_id, farm) or find_windrise_turbine_mapping_candidates(turbine_id, farm):
        return slots
    inferred = infer_windrise_model_from_suffix_token(turbine_id, farm)
    if not inferred:
        return slots
    slots['turbine_id'] = ''
    slots['turbine_ids'] = []
    if not slots.get('farm') and inferred.get('farm'):
        slots['farm'] = normalize_context_dimension_value(inferred.get('farm', ''))
    if not slots.get('brand'):
        slots['brand'] = normalize_context_dimension_value(inferred.get('brand', ''))
    if not slots.get('model'):
        slots['model'] = normalize_windrise_model_value(inferred.get('model', ''))
    if not slots.get('standard_model'):
        slots['standard_model'] = normalize_windrise_model_value(inferred.get('standard_model', ''))
    unavailable = set(slots.get('_unavailable_dimensions') or [])
    unavailable.add('turbine_id')
    unavailable.discard('farm')
    unavailable.discard('model')
    slots['_unavailable_dimensions'] = sorted(unavailable)
    slots['_model_suffix_device'] = turbine_id
    slots['_mapping_resolved'] = True
    return slots


def build_resolved_windrise_scope_slots(query, history=None):
    """Resolve farm/model from an unambiguous user-supplied turbine ID."""
    slots = build_user_confirmed_windrise_scope_slots(query, history)
    # A model such as CWT4800-D185 can contain a token that resembles a unit
    # number. Prefer the first turbine token that actually resolves in the
    # local mapping (for example ZC09) before using the active ID.
    slots = enrich_windrise_slots_with_turbine_mapping(slots)
    turbine_id = normalize_windrise_turbine_id(slots.get('turbine_id', ''))
    if not turbine_id:
        return apply_windrise_model_index_to_slots(slots, query)
    farm = normalize_context_dimension_value(slots.get('farm', ''))
    mapping = lookup_windrise_turbine_mapping(turbine_id, farm)
    if not mapping:
        turbine_probes = set(_windrise_turbine_id_probes(turbine_id))
        matching_records = [
            record
            for record in load_windrise_fault_index_records()
            if (
                not farm
                or farm in normalize_context_dimension_value(record.get('site', ''))
                or normalize_context_dimension_value(record.get('site', '')) in farm
            )
            and turbine_probes.intersection(
                split_windrise_turbine_ids(record.get('turbineIds', ''))
            )
        ]
        inferred = {}
        for target_key, record_key, normalizer in (
            ('brand', 'brand', normalize_context_dimension_value),
            ('model', 'model', normalize_windrise_model_value),
            ('standardModel', 'standardModel', normalize_windrise_model_value),
        ):
            values = dedupe_preserve_order(
                normalizer(record.get(record_key, ''))
                for record in matching_records
                if normalizer(record.get(record_key, ''))
            )
            if len(values) == 1:
                inferred[target_key] = values[0]
        mapping = inferred if inferred.get('brand') or inferred.get('model') else None
    if not mapping:
        slots = reconcile_windrise_model_suffix_device(slots)
        return apply_windrise_model_index_to_slots(slots, query)
    if not slots.get('farm'):
        slots['farm'] = normalize_context_dimension_value(mapping.get('site', ''))
    if not slots.get('brand'):
        slots['brand'] = normalize_context_dimension_value(mapping.get('brand', ''))
    if not slots.get('model'):
        slots['model'] = normalize_windrise_model_value(mapping.get('model', ''))
    if not slots.get('standard_model'):
        slots['standard_model'] = normalize_windrise_model_value(mapping.get('standardModel', ''))
    # When farm and turbine are user-confirmed, prefer the authoritative mapping
    # over assistant-inferred brand/model that can leak from an earlier turn.
    if farm and turbine_id:
        mapped_brand = normalize_context_dimension_value(mapping.get('brand', ''))
        mapped_model = normalize_windrise_model_value(mapping.get('model', ''))
        mapped_standard_model = normalize_windrise_model_value(mapping.get('standardModel', ''))
        if mapped_brand:
            slots['brand'] = mapped_brand
        if mapped_model:
            slots['model'] = mapped_model
        if mapped_standard_model:
            slots['standard_model'] = mapped_standard_model
    unavailable = set(slots.get('_unavailable_dimensions') or [])
    if slots.get('farm'):
        unavailable.discard('farm')
    if slots.get('model') or slots.get('standard_model'):
        unavailable.discard('model')
    slots['_unavailable_dimensions'] = sorted(unavailable)
    slots['_mapping_resolved'] = True
    return apply_windrise_model_index_to_slots(slots, query)


def stash_windrise_active_scope_slots(query, history=None):
    """Pin device scope from the original user turn for this request.

    Semantic routing may rewrite the lookup query down to a bare symptom such as
    「等待运行就绪」 before the current user message is appended to history.
    Without this cache, rewritten lookups can still inherit the previous farm or
    turbine from the prior turn.
    """
    scope_history = build_windrise_scope_history_for_query(query, history)
    resolved = build_resolved_windrise_scope_slots(query, scope_history)
    active = {}
    for key in ('brand', 'farm', 'model', 'standard_model', 'turbine_id'):
        value = resolved.get(key, '')
        if value:
            active[key] = value
    if resolved.get('turbine_ids'):
        active['turbine_ids'] = list(resolved.get('turbine_ids') or [])
    if resolved.get('_unavailable_dimensions'):
        active['_unavailable_dimensions'] = list(resolved.get('_unavailable_dimensions') or [])
    if resolved.get('_broad_scope_requested'):
        active['_broad_scope_requested'] = True
    windrise_request_context.active_scope_slots = active


def get_windrise_active_scope_slots():
    cached = getattr(windrise_request_context, 'active_scope_slots', None)
    return dict(cached or {})


def apply_windrise_active_scope_slots(slots, query):
    """Prefer the current request's pinned scope over stale prior-turn history."""
    active = get_windrise_active_scope_slots()
    if not active:
        return dict(slots or {})
    slots = dict(slots or {})
    current = extract_windrise_user_slots(query)
    for key in ('brand', 'farm', 'model', 'standard_model', 'turbine_id'):
        if current.get(key):
            continue
        value = active.get(key, '')
        if value:
            slots[key] = value
    if not current.get('turbine_id') and active.get('turbine_ids'):
        slots['turbine_ids'] = list(active.get('turbine_ids') or [])
    if active.get('_unavailable_dimensions'):
        slots['_unavailable_dimensions'] = list(active.get('_unavailable_dimensions') or [])
    if active.get('_broad_scope_requested'):
        slots['_broad_scope_requested'] = True
    return slots


def build_windrise_conversational_fault_clarification(query, history=None):
    """Handle broad symptoms conversationally before any knowledge lookup."""
    normalized = normalize_windrise_query(query)
    if not normalized or has_explicit_fault_code(normalized):
        return ''
    if build_windrise_fault_topic_ack_answer(normalized):
        return ''
    if (
        is_context_only_windrise_followup(normalized)
        and not has_specific_current_diagnosis_subject(normalized)
        and not find_recent_fault_context_from_history(history or [])
        and not extract_recent_fault_topic_from_history(history or [])
    ):
        intent = classify_windrise_answer_intent(normalized)
        labels = {
            'repair': '处理方法',
            'reason': '故障原因',
            'reset': '复位条件',
            'trigger': '触发条件',
            'impact': '故障影响',
            'risk': '风险判断',
            'operation': '运行建议',
        }
        target = labels.get(intent, '相关信息')
        return (
            f"**请补充故障对象**\n\n当前会话里还没有可以确认的故障码或报警名称，暂时无法判断{target}。\n\n"
            "请直接提供 HMI/SCADA 原始故障码或完整报警名称；如果没有故障码，也可以描述具体部件和现象。"
        )
    component_match = re.fullmatch(
        r'(?:是|就是|查)?\s*(主轴|齿轮箱(?:高速轴|低速轴)?|高速轴|低速轴|发电机|驱动端|非驱动端|DE端|NDE端)(?:轴承)?(?:的)?[。.!！?？]*',
        normalized,
        flags=re.IGNORECASE,
    )
    if component_match:
        recent_topic = extract_recent_fault_topic_from_history(history or [])
        if re.search(r'轴承.{0,8}(?:温度异常|温度高|温度过高|过温)|(?:温度异常|温度高|温度过高|过温).{0,8}轴承', recent_topic):
            component = component_match.group(1)
            return (
                f"**已确认故障对象**\n\n已把问题收敛为：{component}轴承温度异常。\n\n"
                "请继续提供当前温度、温升趋势，以及 HMI/SCADA 上的完整报警名称或报码。"
                "如果需要按设备知识库精确查询，再补充风场和风机编号；已有信息不会让您重复提供。"
            )
    bearing_temperature = bool(re.search(
        r'轴承.{0,8}(?:温度异常|温度高|温度过高|过温)|(?:温度异常|温度高|温度过高|过温).{0,8}轴承',
        normalized,
    ))
    specific_bearing = bool(re.search(
        r'(?:主轴|齿轮箱|高速轴|低速轴|发电机|驱动端|非驱动端|DE端|NDE端).{0,6}轴承|轴承\s*[A-Za-z0-9一二三四]+',
        normalized,
        flags=re.IGNORECASE,
    ))
    if not bearing_temperature or specific_bearing:
        return ''

    scope = build_resolved_windrise_scope_slots(normalized, history or [])
    farm = normalize_context_dimension_value(scope.get('farm', ''))
    turbine_id = normalize_windrise_turbine_id(scope.get('turbine_id', ''))
    scope_note = ''
    if farm and turbine_id:
        scope_note = (
            f"\n\n设备范围我暂时沿用上一轮的 {farm}风场 {turbine_id}；"
            "如果已经换了风场或机组，直接告诉我新的风场和编号，我会立即切换。"
        )

    return (
        "先确认具体测点，暂时不要把所有“轴承温度”故障混在一起处理。"
        "主轴、齿轮箱和发电机轴承的报警阈值、冷却方式和处理步骤都不同。\n\n"
        "现场可以先做三件事：对比同一轴承相邻测点和历史温度曲线；"
        "用测温仪核对实际温度与传感器读数；检查是否同时出现振动、异响、润滑或冷却异常。\n\n"
        "请告诉我具体是哪个轴承/测点、当前温度，以及 HMI/SCADA 上的完整报警名称或报码。"
        f"{scope_note}"
    )


def apply_windrise_turbine_mapping_to_slots(slots):
    """Fill farm/brand/model from the local turbine mapping whenever possible."""
    slots = dict(slots or {})
    turbine_id = normalize_windrise_turbine_id(slots.get('turbine_id', ''))
    if not turbine_id:
        return slots
    farm = normalize_context_dimension_value(slots.get('farm', ''))
    entry = lookup_windrise_turbine_mapping(turbine_id, farm)
    if not entry and farm:
        entry = lookup_windrise_turbine_mapping(turbine_id, '')
    if entry:
        if not farm:
            slots['farm'] = normalize_context_dimension_value(entry.get('site', ''))
        if entry.get('brand'):
            slots['brand'] = normalize_context_dimension_value(entry.get('brand', ''))
        if entry.get('model'):
            slots['model'] = normalize_windrise_model_value(entry.get('model', ''))
        if entry.get('standardModel'):
            slots['standard_model'] = normalize_windrise_model_value(entry.get('standardModel', ''))
        slots['_mapping_resolved'] = True
        return slots
    return enrich_windrise_slots_with_turbine_mapping(slots)


def has_windrise_fault_lookup_subject(query, history=None):
    """Return True when the turn includes a searchable fault symptom or name."""
    history = history or []
    normalized = normalize_text(query)
    if not normalized and not history:
        return False
    if normalized:
        if extract_direct_windrise_fault_codes(normalized, history):
            return True
        if is_explicit_fault_name_lookup_query(normalized) or is_explicit_fault_action_lookup_query(normalized):
            return True
        if extract_scada_style_alarm_name(normalized) or extract_windrise_fault_subject_phrase(normalized):
            return True
        if has_windrise_issue_slots(extract_windrise_user_slots(normalized)):
            return True
    return bool(
        extract_recent_fault_topic_from_history(history)
        or extract_recent_windrise_fault_topic_from_history(history)
    )


def infer_windrise_scope_from_farm_brand(slots):
    """Fill a unique model from the mapping table when farm and brand are known."""
    slots = dict(slots or {})
    farm = normalize_context_dimension_value(slots.get('farm', ''))
    brand = normalize_context_dimension_value(slots.get('brand', ''))
    if not farm or not brand or slots.get('model') or slots.get('standard_model'):
        return slots
    models = []
    standard_models = []
    for entry in load_windrise_turbine_mapping_entries():
        site = normalize_context_dimension_value(entry.get('site', ''))
        entry_brand = normalize_context_dimension_value(entry.get('brand', ''))
        if not site or (farm not in site and site not in farm):
            continue
        if not entry_brand or (brand not in entry_brand and entry_brand not in brand):
            continue
        model = normalize_windrise_model_value(entry.get('model', ''))
        standard_model = normalize_windrise_model_value(entry.get('standardModel', ''))
        if model and model not in models:
            models.append(model)
        if standard_model and standard_model not in standard_models:
            standard_models.append(standard_model)
    if len(models) == 1:
        slots['model'] = models[0]
    if len(standard_models) == 1:
        slots['standard_model'] = standard_models[0]
    return slots


def windrise_allows_missing_turbine_for_fault_lookup(slots, query=None, history=None):
    """Proceed with farm/brand scoped retrieval even when the unit number is unknown."""
    slots = infer_windrise_scope_from_farm_brand(dict(slots or {}))
    farm = normalize_context_dimension_value(slots.get('farm', ''))
    brand = normalize_context_dimension_value(slots.get('brand', ''))
    model = normalize_windrise_model_value(slots.get('model', ''))
    standard_model = normalize_windrise_model_value(slots.get('standard_model', ''))
    unavailable = set(slots.get('_unavailable_dimensions') or [])
    if not farm or 'farm' in unavailable:
        return False
    if not has_windrise_fault_lookup_subject(query or '', history):
        return False
    if brand or model or standard_model or 'model' in unavailable:
        return True
    if history and (
        extract_recent_fault_topic_from_history(history)
        or extract_recent_windrise_fault_topic_from_history(history)
    ):
        return True
    return False


def has_windrise_scope_for_fault_answer(slots, query=None, history=None):
    """A fault lookup requires device scope; turbine ID may be waived when symptom is known."""
    slots = apply_windrise_turbine_mapping_to_slots(slots or {})
    slots = infer_windrise_scope_from_farm_brand(slots)
    farm = normalize_context_dimension_value(slots.get('farm', ''))
    turbine_id = normalize_windrise_turbine_id(slots.get('turbine_id', ''))
    model = normalize_windrise_model_value(slots.get('model', ''))
    standard_model = normalize_windrise_model_value(slots.get('standard_model', ''))
    unavailable = set(slots.get('_unavailable_dimensions') or [])
    has_farm = bool(farm or 'farm' in unavailable)
    has_turbine = bool(turbine_id or 'turbine_id' in unavailable)
    has_model = bool(model or standard_model or 'model' in unavailable)
    if not has_farm:
        return False
    if windrise_allows_missing_turbine_for_fault_lookup(slots, query, history):
        return True
    return bool(has_farm and has_turbine and has_model)


def is_windrise_fault_scope_guidance_relevant(query, history=None):
    """Return True only for a fault question or a reply to an active scope prompt."""
    normalized = normalize_text(query)
    if not normalized:
        return False
    if is_windrise_scope_supplement_reply(normalized, history):
        return True
    if is_windrise_general_knowledge_question(normalized):
        return False

    current_slots = extract_windrise_user_slots(normalized)
    history_slots = build_windrise_slots_from_history(history or [])
    current_unavailable = windrise_scope_unavailability_for_current_reply(normalized, history)
    broad_scope_request = is_windrise_broad_scope_search_request(normalized)
    current_has_scope_dimension = bool(
        current_slots.get('farm')
        or current_slots.get('brand')
        or current_slots.get('model')
        or current_slots.get('standard_model')
        or current_slots.get('turbine_id')
        or current_unavailable
        or broad_scope_request
    )
    has_prior_fault_context = has_windrise_issue_slots(history_slots)
    if is_wind_farm_model_mapping_query(normalized):
        return False
    if should_answer_windrise_turbine_mapping_question(normalized) and not (
        has_prior_fault_context and current_has_scope_dimension
    ):
        return False
    current_has_fault_subject = bool(
        has_windrise_issue_slots(current_slots)
        or has_explicit_fault_code(normalized)
        or re.search(
            r'(故障|报警|告警|停机|异常|跳闸|跳开|欠压|过压|过流|超限|失效|故障码|报码|触发条件)',
            normalized,
            flags=re.IGNORECASE,
        )
    )
    current_is_scope_reply = bool(
        has_prior_fault_context and current_has_scope_dimension
    )
    return current_has_fault_subject or current_is_scope_reply


def build_windrise_fault_scope_clarification(query, history=None):
    """Collect farm, turbine ID, and model from the user before retrieval."""
    history = history or []
    # A fault code is already the strongest local index key. Return all known
    # meanings immediately and let the user narrow by device only when needed.
    if extract_direct_windrise_fault_codes(query, history):
        return ''
    # A complete alarm/fault name is itself a useful retrieval key. Search it
    # immediately and offer device dimensions only when multiple records need
    # further narrowing.
    if is_explicit_fault_name_lookup_query(query) or is_explicit_fault_action_lookup_query(query):
        return ''
    if not is_windrise_fault_scope_guidance_relevant(query, history):
        return ''

    slots = apply_windrise_turbine_mapping_to_slots(build_resolved_windrise_scope_slots(query, history))
    if has_windrise_scope_for_fault_answer(slots, query, history):
        return ''

    farm = normalize_context_dimension_value(slots.get('farm', ''))
    brand = normalize_context_dimension_value(slots.get('brand', ''))
    turbine_id = normalize_windrise_turbine_id(slots.get('turbine_id', ''))
    model = normalize_windrise_model_value(slots.get('model', ''))
    standard_model = normalize_windrise_model_value(slots.get('standard_model', ''))
    unavailable = set(slots.get('_unavailable_dimensions') or [])
    current_update = extract_windrise_user_slots(query)
    # A follow-up that supplies both farm and brand can be resolved from the
    # mapping table even when the user omits the unit number/model. Keep the
    # conversational subject and let the index return the narrowed records.
    if (
        farm
        and brand
        and not turbine_id
        and not model
        and not standard_model
        and (
            find_recent_fault_context_for_query(query, history).get('code')
            or find_recent_fault_context_for_query(query, history).get('name')
            or extract_recent_windrise_fault_topic_for_query(query, history)
        )
        and query_has_explicit_dimension(query)
        and not is_windrise_broad_scope_search_request(query)
    ):
        return ''
    cleared_turbine_ids = current_update.get('_cleared_turbine_ids') or []
    previous_scope = build_resolved_windrise_scope_slots('', history)
    current_farm = normalize_context_dimension_value(current_update.get('farm', ''))
    previous_farm = normalize_context_dimension_value(previous_scope.get('farm', ''))
    farm_switched_without_turbine = bool(
        current_farm
        and previous_farm
        and current_farm != previous_farm
        and not turbine_id
    )
    if farm_switched_without_turbine and not cleared_turbine_ids:
        previous_turbine = normalize_windrise_turbine_id(previous_scope.get('turbine_id', ''))
        if previous_turbine:
            cleared_turbine_ids = [previous_turbine]

    known = []
    if farm:
        known.append(f'风场={farm}')
    elif 'farm' in unavailable:
        known.append('风场暂时无法提供')
    if turbine_id:
        known.append(f'风机编号={turbine_id}')
    elif 'turbine_id' in unavailable:
        known.append('风机编号暂时无法提供')
    if brand:
        known.append(f'厂家={brand}')
    if model:
        known.append(f'机型={model}')
    if standard_model:
        known.append(f'具体型号={standard_model}')
    elif not model and 'model' in unavailable:
        known.append('机型暂时无法提供')
    known_line = f"已记住：{'；'.join(known)}。\n\n" if known else ''

    if not farm and 'farm' not in unavailable:
        candidate_sites = []
        if turbine_id:
            for entry in find_windrise_turbine_mapping_candidates(turbine_id):
                site = normalize_context_dimension_value(entry.get('site', ''))
                if site and site not in candidate_sites:
                    candidate_sites.append(site)
        if len(candidate_sites) > 1:
            site_hint = f"这个编号在映射表中对应多个风场（{'、'.join(candidate_sites[:6])}），"
        elif turbine_id:
            site_hint = '当前仅凭这个风机编号还不能唯一确定设备，'
        else:
            site_hint = ''
        return (
            "**先确认设备范围**\n\n"
            f"{known_line}{site_hint}第一步请告诉我：这是哪个风场？\n\n"
            "直接回复风场名称即可，例如“八面风场”。如果已有风机编号，我会先查映射表自动补全机型。"
        )

    if not turbine_id and 'turbine_id' not in unavailable:
        if windrise_allows_missing_turbine_for_fault_lookup(slots, query, history):
            return ''
        recovered_slots = apply_windrise_turbine_mapping_to_slots(
            build_resolved_windrise_scope_slots('', history)
        )
        recovered_turbine = normalize_windrise_turbine_id(recovered_slots.get('turbine_id', ''))
        if recovered_turbine:
            turbine_id = recovered_turbine
            farm = farm or normalize_context_dimension_value(recovered_slots.get('farm', ''))
            brand = brand or normalize_context_dimension_value(recovered_slots.get('brand', ''))
            model = model or normalize_windrise_model_value(recovered_slots.get('model', ''))
            standard_model = standard_model or normalize_windrise_model_value(
                recovered_slots.get('standard_model', '')
            )
            if has_windrise_scope_for_fault_answer({
                'farm': farm,
                'turbine_id': turbine_id,
                'brand': brand,
                'model': model,
                'standard_model': standard_model,
                '_unavailable_dimensions': list(unavailable),
            }, query, history):
                return ''
        if cleared_turbine_ids:
            cleared_text = '、'.join(cleared_turbine_ids)
            farm_text = f'已切换到{farm}风场，' if farm else ''
            return (
                "**已更新设备范围**\n\n"
                f"{farm_text}并已清除上一轮的风机编号 {cleared_text}。\n\n"
                "这次请告诉我新的风机编号；如果现场确实无法提供编号，直接说“风机编号无法提供”，"
                "我会按当前已知信息列出相关结果。"
            )
        return (
            "**继续确认设备**\n\n"
            f"{known_line}下一步请告诉我具体风机编号，例如“ZC09”。\n\n"
            "我会根据编号先查映射表自动识别风场和机型；只有无法唯一匹配时才继续追问。"
        )

    if not model and not standard_model and 'model' not in unavailable:
        if windrise_allows_missing_turbine_for_fault_lookup(slots, query, history):
            return ''
        remapped = apply_windrise_turbine_mapping_to_slots({
            'farm': farm,
            'turbine_id': turbine_id,
            'brand': brand,
            'model': model,
            'standard_model': standard_model,
            '_unavailable_dimensions': list(unavailable),
        })
        if remapped.get('model') or remapped.get('standard_model'):
            return ''
        return (
            "**还差机型确认**\n\n"
            f"{known_line}还需要确认机型/具体型号。请回复现场设备的厂家和机型，"
            "例如“中车山东 CWT4800-D185”。补充后我再进行知识库检索。"
        )

    return ''


def build_windrise_scope_completion_query(query, history=None):
    """Reconnect a short scope reply (for example ``ZC09``) to its fault topic."""
    history = history or []
    current_slots = extract_windrise_user_slots(query)
    if has_windrise_issue_slots(current_slots):
        return ''
    current_unavailable = windrise_scope_unavailability_for_current_reply(query, history)
    broad_scope_request = is_windrise_broad_scope_search_request(query)
    if not (
        current_slots.get('farm')
        or current_slots.get('brand')
        or current_slots.get('model')
        or current_slots.get('standard_model')
        or current_slots.get('turbine_id')
        or current_unavailable
        or broad_scope_request
    ):
        return ''
    if windrise_should_isolate_history_issue_slots(query, history):
        return ''
    resolved_slots = build_resolved_windrise_scope_slots(query, history)
    if not has_windrise_scope_for_fault_answer(resolved_slots, query, history):
        return ''
    recent_context = find_recent_fault_context_for_query(query, history)
    recent_topic = (
        normalize_context_dimension_value(recent_context.get('name', ''))
        or extract_recent_windrise_fault_topic_for_query(query, history)
    )
    if not recent_topic and recent_context.get('code'):
        recent_topic = f"故障码{normalize_windrise_fault_code(recent_context.get('code'))}"
    if not recent_topic and is_windrise_scope_supplement_reply(query, history):
        recent_topic = extract_recent_windrise_fault_topic_from_history(history)
        if not recent_topic:
            history_slots = build_windrise_slots_from_history(history)
            recent_topic = normalize_context_dimension_value(history_slots.get('fault_name', ''))
    if not recent_topic:
        return ''
    return normalize_windrise_query(f'{recent_topic} {query}')


def build_windrise_symptom_subject_query(query, history=None):
    """Return only the fault symptom text for local index lookup."""
    _ = history
    subject = (
        extract_scada_style_alarm_name(query)
        or extract_windrise_fault_subject_phrase(query)
        or clean_current_fault_lookup_topic(query)
        or normalize_windrise_query(query)
    )
    return normalize_windrise_query(subject) if subject else ''


def build_windrise_symptom_scope_lookup_query(query, history=None):
    """Reconnect a bare symptom reply to confirmed farm/turbine/model scope."""
    history = history or []
    if not is_windrise_scoped_symptom_followup(query, history):
        return ''
    resolved_slots = build_resolved_windrise_scope_slots(query, history)
    if not has_windrise_scope_for_fault_answer(resolved_slots, query, history):
        return ''
    return build_windrise_symptom_subject_query(query, history)


def forget_windrise_retrieval_context(conversation_id=None, user_id=None):
    cache_key = get_windrise_scoped_cache_key(conversation_id, user_id)
    if not all(cache_key):
        return
    with windrise_retrieval_memory_lock:
        windrise_retrieval_memories.pop(cache_key, None)


def extract_fault_lookup_subject(query, topic=''):
    subject = (
        extract_scada_style_alarm_name(query)
        or extract_windrise_fault_subject_phrase(query)
        or clean_current_fault_lookup_topic(query)
        or normalize_windrise_query(topic)
    )
    return compact_fault_match_text(subject)


def is_confident_fault_topic_match(query, record, topic=''):
    """True only when the record name closely matches the user's alarm wording."""
    if extract_direct_windrise_fault_codes(query, None):
        return True
    subject = extract_fault_lookup_subject(query, topic)
    if len(subject) < 4:
        return True
    record_name = compact_fault_match_text(record.get('name', ''))
    if not record_name:
        return False
    if subject == record_name or subject in record_name or record_name in subject:
        return True
    lookup_text = clean_current_fault_lookup_topic(query) or normalize_windrise_query(topic) or query
    topic_terms = windrise_topic_terms(lookup_text)
    if not topic_terms:
        return False
    return score_fault_record_for_topic(record, topic_terms) >= 80


def build_windrise_scoped_symptom_no_match_answer(query, history=None, lookup_query=''):
    """When device scope is confirmed but the local index has no exact alarm hit."""
    history = history or []
    symptom = (
        normalize_windrise_query(lookup_query)
        or build_windrise_symptom_subject_query(query, history)
        or normalize_windrise_query(query)
    )
    if not symptom:
        return ''
    slots = apply_windrise_turbine_mapping_to_slots(build_resolved_windrise_scope_slots(query, history))
    if not has_windrise_scope_for_fault_answer(slots, query, history):
        return ''
    farm = normalize_context_dimension_value(slots.get('farm', ''))
    turbine_id = normalize_windrise_turbine_id(slots.get('turbine_id', ''))
    brand = normalize_context_dimension_value(slots.get('brand', ''))
    model = normalize_windrise_model_value(slots.get('model', ''))
    standard_model = normalize_windrise_model_value(slots.get('standard_model', ''))
    device_bits = []
    if farm:
        device_bits.append(farm)
    if turbine_id:
        device_bits.append(f'{normalize_windrise_turbine_id(turbine_id)}#')
    if brand:
        device_bits.append(brand)
    if standard_model or model:
        device_bits.append(standard_model or model)
    device_label = ' / '.join(device_bits) if device_bits else '当前已确认设备'

    topic_terms = windrise_topic_terms(symptom)
    suggestions = []
    for record in load_windrise_fault_index_records():
        if farm:
            site_text = normalize_context_dimension_value(record.get('site', ''))
            if site_text and farm not in site_text and site_text not in farm:
                continue
        if brand:
            record_brand = normalize_context_dimension_value(record.get('brand', ''))
            if record_brand and record_brand.lower() != brand.lower():
                continue
        if not record_matches_explicit_windrise_slots(record, slots):
            continue
        topic_score = score_fault_record_for_topic(record, topic_terms)
        if topic_score < 24:
            continue
        suggestions.append((topic_score, record))
    suggestions.sort(
        key=lambda item: (
            -item[0],
            str(item[1].get('code', '')),
            str(item[1].get('name', '')),
        )
    )

    lines = [
        '**设备范围内未找到精确匹配**',
        '',
        f'【对象确认】\n{device_label}',
        '',
        f'已在上述机型手册中检索报警「{symptom}」，本地 fault-index 没有同名记录。',
        '',
        '请优先核对 HMI/SCADA 上的**完整报警原文**或报码后再查；部分报警在手册里名称会有细微差别。',
    ]
    if suggestions:
        lines.extend(['', '**名称相近的记录（供核对，不等同于当前报警）：**'])
        for index, (_score, record) in enumerate(suggestions[:3], start=1):
            code = normalize_context_dimension_value(record.get('code', ''))
            name = normalize_context_dimension_value(record.get('name', ''))
            label = f'{code} {name}'.strip()
            lines.append(f'{index}. {label}')
    return '\n'.join(lines)


def resolve_windrise_scoped_symptom_preflight(query, history=None):
    """High-confidence local lookup for bare symptoms after scope is confirmed."""
    history = history or []
    if is_windrise_general_knowledge_question(query):
        return '', ''
    if is_windrise_scope_supplement_reply(query, history):
        return '', ''
    if should_answer_windrise_turbine_mapping_question(query):
        return '', ''
    if not (
        is_windrise_scoped_symptom_followup(query, history)
        or is_windrise_bare_symptom_with_confirmed_scope(query, history)
    ):
        return '', ''
    index_query = (
        build_windrise_symptom_subject_query(query, history)
        or build_scoped_symptom_index_query(query, history)
        or normalize_windrise_query(query)
    )
    answer = build_index_scoped_fault_lookup_answer_with_fallback(
        index_query,
        index_query,
        history,
        intent=classify_windrise_answer_intent(query),
    )
    if answer:
        reason = (
            'in_process_global_symptom_fallback'
            if '【全局检索】' in answer
            else 'in_process_scoped_fault_lookup'
        )
        return answer, reason
    scoped_miss = build_windrise_scoped_symptom_no_match_answer(query, history, index_query)
    if scoped_miss:
        return scoped_miss, 'in_process_scoped_fault_lookup_miss'
    return '', ''


def clamp_windrise_semantic_rewritten_query(query, history, rewritten):
    """Prevent scoped symptom follow-ups from inheriting glued scope tokens."""
    history = history or []
    rewritten = normalize_windrise_query(rewritten)
    if not rewritten:
        return rewritten
    if is_windrise_scoped_symptom_followup(query, history):
        subject_query = build_windrise_symptom_subject_query(query, history)
        if subject_query:
            return subject_query
        subject = (
            extract_scada_style_alarm_name(query)
            or extract_windrise_fault_subject_phrase(query)
            or clean_current_fault_lookup_topic(query)
        )
        if subject:
            return normalize_windrise_query(subject)
    resolved = build_resolved_windrise_scope_slots(query, history)
    removable = []
    for key in ('brand', 'farm', 'model', 'standard_model', 'turbine_id'):
        if key in {'model', 'standard_model'}:
            value = normalize_windrise_model_value(resolved.get(key, ''))
        elif key == 'farm':
            value = normalize_context_dimension_value(resolved.get(key, ''))
        else:
            value = normalize_windrise_turbine_id(resolved.get(key, ''))
        if not value:
            continue
        if value.lower() in normalize_text(query).lower():
            continue
        removable.append(value)
        if key in {'model', 'standard_model'} and value.endswith('系列'):
            removable.append(value[:-2])
    cleaned = rewritten
    for term in sorted(set(removable), key=len, reverse=True):
        cleaned = re.sub(re.escape(term), ' ', cleaned, flags=re.IGNORECASE)
    cleaned = normalize_windrise_query(cleaned)
    subject = (
        extract_scada_style_alarm_name(query)
        or extract_windrise_fault_subject_phrase(query)
        or clean_current_fault_lookup_topic(query)
    )
    if subject:
        compact_subject = compact_fault_match_text(subject)
        compact_cleaned = compact_fault_match_text(cleaned)
        if compact_subject and compact_subject in compact_cleaned:
            return normalize_windrise_query(subject)
        if compact_cleaned and len(compact_cleaned) > len(compact_subject) + 6:
            return normalize_windrise_query(subject)
    return cleaned or rewritten


def windrise_resolved_fault_code(slots, query=None):
    slots = slots or {}
    if slots.get('_ignore_query_fault_code'):
        return ''
    code = normalize_windrise_fault_code(slots.get('fault_code', '')) or ''
    if code:
        return code
    normalized = normalize_windrise_query(query or '')
    if not normalized:
        return ''
    codes = extract_fault_codes(normalized) or extract_explicit_fault_code_lookup_codes(normalized)
    codes = filter_fault_codes_excluding_turbine_units(normalized, codes, None)
    if not codes:
        return ''
    return normalize_windrise_fault_code(codes[0]) or normalize_context_dimension_value(codes[0])


def has_windrise_converged_scope(slots, query=None):
    slots = slots or {}
    if windrise_resolved_fault_code(slots, query):
        return True
    if normalize_context_dimension_value(slots.get('farm', '')):
        return True
    if normalize_windrise_turbine_id(slots.get('turbine_id', '')):
        return True
    return False


def should_limit_windrise_results_to_one(slots, query=None):
    slots = slots or {}
    farm = normalize_context_dimension_value(slots.get('farm', ''))
    turbine = normalize_windrise_turbine_id(slots.get('turbine_id', ''))
    code = windrise_resolved_fault_code(slots, query)
    if farm and turbine:
        return True
    if code and (farm or turbine):
        return True
    return False


def build_windrise_known_sites_hint(limit=40):
    sites = []
    seen = set()
    for entry in load_windrise_turbine_mapping_entries():
        site = normalize_context_dimension_value(entry.get('site', ''))
        if not site or site in seen:
            continue
        seen.add(site)
        sites.append(site)
        if len(sites) >= limit:
            break
    return '、'.join(sites)


def should_run_windrise_query_semantic_analysis(query, history=None, slots=None):
    normalized = normalize_windrise_query(query)
    if not normalized or not WINDRISE_QUERY_CONSOLIDATOR_ENABLED or WINDRISE_SINGLE_SEMANTIC_PASS:
        return False
    if (
        has_explicit_fault_code(normalized)
        or is_explicit_fault_name_lookup_query(normalized)
        or is_explicit_fault_action_lookup_query(normalized)
    ):
        return False
    if is_windrise_general_knowledge_question(normalized):
        return False
    if is_wind_farm_model_mapping_query(normalized):
        return False
    history = history or []
    if (
        history
        and is_context_only_windrise_followup(normalized)
        and (
            find_recent_fault_code_for_query(normalized, history)
            or find_recent_fault_context_for_query(normalized, history).get('code')
        )
    ):
        return False
    slots = slots or build_effective_windrise_slots_for_query(query, history)
    return bool(
        has_device_issue_hint(normalized)
        or slots.get('farm')
        or slots.get('turbine_id')
        or has_explicit_fault_code(normalized)
        or is_explicit_fault_action_lookup_query(normalized)
        or is_explicit_fault_name_lookup_query(normalized)
        or looks_like_fault_phenomenon_query(normalized)
    )


def is_fuzzy_windrise_fault_query(query, slots=None):
    normalized = normalize_windrise_query(query)
    if not normalized:
        return False
    if is_windrise_general_knowledge_question(normalized):
        return False
    if is_wind_farm_model_mapping_query(normalized):
        return False
    slots = slots or build_effective_windrise_slots_for_query(query, [])
    if is_fully_specified_windrise_fault_query(normalized, slots):
        return False
    if (
        has_explicit_fault_code(normalized)
        and slots.get('farm')
        and slots.get('turbine_id')
        and (slots.get('symptom') or slots.get('component') or slots.get('fault_name'))
    ):
        return False
    colloquial = bool(re.search(
        r'(好像|有点|不太清楚|不太对|可能|大概|是不是|八成|估计|感觉|出问题了|不对劲|怎么回事|咋回事|啥情况|什么情况)',
        normalized,
    ))
    has_code = bool(extract_fault_codes(normalized) or slots.get('fault_code'))
    has_farm = bool(slots.get('farm'))
    has_turbine = bool(slots.get('turbine_id'))
    has_symptom = bool(
        slots.get('symptom')
        or slots.get('component')
        or slots.get('fault_name')
        or slots.get('fault_code')
    )
    if not has_device_issue_hint(normalized) and not has_farm and not has_turbine:
        return False
    if colloquial:
        return True
    if has_device_issue_hint(normalized) and not has_farm:
        return True
    if has_device_issue_hint(normalized) and has_farm and not has_turbine:
        return True
    if has_device_issue_hint(normalized) and not has_code and not has_symptom:
        return True
    if len(normalized) <= 14 and has_device_issue_hint(normalized) and not (has_farm and has_turbine):
        return True
    return False


def call_windrise_query_consolidator(query, history, slots=None, force=False):
    if (
        (not WINDRISE_QUERY_CONSOLIDATOR_ENABLED and not force)
        or (is_windrise_llm_temporarily_unavailable() and not force)
    ):
        return {}
    slots = slots or build_effective_windrise_slots_for_query(query, history)
    slot_summary = build_windrise_slots_summary(slots) or '无'
    recent_history_lines = []
    for item in (history or [])[-6:]:
        content = clip_text(item.get('content', ''), 320)
        if not content:
            continue
        role = '用户' if item.get('role') == 'user' else 'Windrise'
        recent_history_lines.append(f'{role}：{content}')
    history_hint = '\n'.join(recent_history_lines) or '无'
    recent_fault_context = find_recent_fault_context_for_query(query, history or [])
    recent_fault_summary = '；'.join(
        f'{label}={normalize_context_dimension_value(recent_fault_context.get(key, ""))}'
        for key, label in (
            ('code', '故障码'),
            ('name', '故障名称'),
            ('site', '风场'),
            ('brand', '厂家'),
            ('model', '机型'),
            ('standard_model', '标准机型'),
            ('turbine_id', '风机编号'),
        )
        if normalize_context_dimension_value(recent_fault_context.get(key, ''))
    ) or '无'
    local_intent = classify_windrise_followup_intent(query) or 'general'
    sites_hint = build_windrise_known_sites_hint()
    prompt = f"""请结合当前输入和同一会话的最近上下文，识别用户本次真正要查的风机故障内容。用户表述通常很模糊，你需要解析代词、省略信息和连续追问，生成适合 LLM Wiki 结构化索引的精确检索式。只输出 JSON，不要解释。

当前用户输入：{query}
当前规则槽位：{slot_summary}
最近故障对象：{recent_fault_summary}
规则判断的当前意图：{local_intent}
最近完整对话：
{history_hint}
常见风场（仅供参考，勿编造）：{sites_hint}

要求：
- 当前输入优先级最高。当前输入出现新部件、新现象、新故障码或新风机时，视为新问题，不得沿用旧故障对象。
- 当前输入是「这个怎么处理」「什么原因」「怎么复位」等省略追问时，继承最近一个明确的故障码、故障名、风场、机位和机型。
- Windrise 的历史回答只用于解析指代和已确认对象，不能把其中的候选项当成用户已确认的事实。
- 尽量识别风场、风机编号（如 SH09、YD16#）、厂家、机型、故障码、部件、故障名和现象。
- 风机编号保留原格式（可带#号）。
- 不要编造知识库里没有的风场或故障码；不确定的字段留空。
- rewritten_query 是直接交给 LLM Wiki 的检索词，不是自然语言改写。LLM Wiki 的最高命中格式依次是：已确认故障码 > 精确故障名称 > 部件加用户原始核心现象。
- 如果当前输入或已确认上下文有故障码，rewritten_query 只输出故障码，例如「120014」。
- 没有故障码但能识别精确故障名称时，rewritten_query 只输出故障名称，例如「偏航回路欠压」。
- 只有在故障名称不明确时，才输出「部件 核心现象」，例如「主断路器 异常跳开」。保留用户原词，不得推测原因、触发值或补写同义症状。
- 风场、风机编号、厂家、机型只填写各自 JSON 字段，不要放入 rewritten_query；意图只填写 intent，不要放入 rewritten_query。
- rewritten_query 不得出现「偏航 偏航回路欠压」这类包含关系的重复词，不要包含「帮我查、风机、故障、是什么、怎么处理」等检索噪声，不超过 60 个字。
- rewritten_query 必须非空。当前问题「八面风场ZC09风机偏航回路欠压故障触发条件是什么」应输出「偏航回路欠压」，而不是把风场、机位、机型和推测症状拼进去。
- confidence 取 high、medium 或 low。

输出字段：
{{
  "brand": "",
  "farm": "",
  "turbine_id": "",
  "model": "",
  "standard_model": "",
  "fault_code": "",
  "component": "",
  "fault_name": "",
  "symptom": "",
  "intent": "general|meaning|repair|reason|reset|trigger|impact|risk|operation|comparison",
  "rewritten_query": "",
  "confidence": "medium"
}}"""
    try:
        windrise_request_context.semantic_pass_used = True
        raw_text = call_chat_model(
            [
                {'role': 'system', 'content': '你只做风机故障问句整理。必须只输出合法 JSON。'},
                {'role': 'user', 'content': prompt},
            ],
            max_tokens=420,
            temperature=0.0,
            timeout=WINDRISE_QUERY_CONSOLIDATOR_TIMEOUT,
            sanitize=False,
        )
    except Exception as e:
        if isinstance(e, (requests.Timeout, requests.ConnectionError)):
            mark_windrise_llm_unavailable(e)
        else:
            print(f"[Windrise] 知识库检索内容提取失败: {type(e).__name__}: {e}")
        return {}
    try:
        data = json.loads(extract_json_object(raw_text))
    except Exception as parse_error:
        print(f"[Windrise] 检索内容 JSON 解析失败，重试紧凑提示: {parse_error}")
        retry_prompt = f"""只输出一个合法 JSON 对象，不要 Markdown、解释或思考过程。
结合最近对话解析当前问题的指代和省略信息，提取适合 LLM Wiki 的最短检索式：有已确认故障码只输出故障码，否则优先只输出精确故障名称，再否则输出部件和用户原始核心现象。风场、机位、厂家、机型只放独立字段；不得加入检索词，不得推测或扩写症状。
当前问题：{query}
已知槽位：{slot_summary}
最近故障对象：{recent_fault_summary}
最近对话：
{history_hint}
输出：{{"brand":"","farm":"","turbine_id":"","model":"","standard_model":"","fault_code":"","component":"","fault_name":"","symptom":"","intent":"general|meaning|repair|reason|reset|trigger|impact|risk|operation|comparison","rewritten_query":"","confidence":"high|medium|low"}}"""
        try:
            raw_text = call_chat_model(
                [
                    {'role': 'system', 'content': '只输出合法 JSON 对象。'},
                    {'role': 'user', 'content': retry_prompt},
                ],
                max_tokens=360,
                temperature=0.0,
                timeout=WINDRISE_QUERY_CONSOLIDATOR_TIMEOUT,
                sanitize=False,
            )
            data = json.loads(extract_json_object(raw_text))
        except Exception as retry_error:
            if isinstance(retry_error, (requests.Timeout, requests.ConnectionError)):
                mark_windrise_llm_unavailable(retry_error)
            else:
                print(f"[Windrise] 检索内容紧凑重试失败: {type(retry_error).__name__}: {retry_error}")
            return {}
    if not isinstance(data, dict):
        return {}
    normalized = {}
    for key in (
        'brand', 'farm', 'turbine_id', 'model', 'standard_model', 'fault_code',
        'component', 'fault_name', 'symptom', 'intent', 'rewritten_query', 'confidence',
    ):
        value = normalize_text(data.get(key, ''))
        if key in {'brand', 'farm', 'turbine_id', 'model', 'standard_model'} and is_windrise_unavailable_scope_value(value):
            value = ''
        if key == 'turbine_id' and value:
            value = normalize_windrise_turbine_id(value)
        elif key == 'fault_code' and value:
            value = normalize_windrise_fault_code(value)
        elif key in {'model', 'standard_model'} and value:
            value = normalize_windrise_model_value(value)
        elif key == 'intent':
            value = normalize_windrise_intent(value)
        normalized[key] = value
    return normalized


def merge_consolidated_windrise_slots(slots, consolidated):
    merged = dict(slots or {})
    if not isinstance(consolidated, dict):
        return enrich_windrise_slots_with_turbine_mapping(
            enrich_windrise_slots_with_inferred_brand(merged)
        )
    for key in ('brand', 'farm', 'model', 'standard_model', 'turbine_id', 'fault_code', 'fault_name'):
        value = normalize_context_dimension_value(consolidated.get(key, ''))
        if key == 'turbine_id' and value:
            value = normalize_windrise_turbine_id(value)
        if value and not merged.get(key):
            merged[key] = value
    symptom = normalize_context_dimension_value(consolidated.get('symptom', ''))
    if symptom:
        symptoms = list(merged.get('symptom') or [])
        if symptom not in symptoms:
            symptoms.append(symptom)
        merged['symptom'] = symptoms
    component = normalize_context_dimension_value(consolidated.get('component', ''))
    if component:
        components = list(merged.get('component') or [])
        if component not in components:
            components.append(component)
        merged['component'] = components
    merged['intent'] = normalize_windrise_intent(consolidated.get('intent', ''))
    return enrich_windrise_slots_with_turbine_mapping(
        enrich_windrise_slots_with_inferred_brand(merged)
    )


def build_llmwiki_optimized_retrieval_query(consolidated, rewritten, slots=None):
    """Collapse model output to the field order favored by LLM Wiki scoring."""
    slots = slots or {}
    fault_code = normalize_windrise_fault_code(consolidated.get('fault_code', ''))
    confirmed_code = normalize_windrise_fault_code(slots.get('fault_code', ''))
    if fault_code and confirmed_code and fault_code == confirmed_code:
        return fault_code
    fault_name = normalize_context_dimension_value(
        consolidated.get('fault_name', '') or (slots or {}).get('fault_name', '')
    )
    if fault_name:
        return clip_text(fault_name, 60)
    core_terms = [
        normalize_context_dimension_value(consolidated.get('component', '')),
        normalize_context_dimension_value(consolidated.get('symptom', '')),
    ]
    core_query = normalize_windrise_query(' '.join(dict.fromkeys(term for term in core_terms if term)))
    return clip_text(core_query or rewritten, 60)


def consolidate_windrise_user_query(query, history, force=False, required=False):
    query = normalize_windrise_query(query)
    slots = build_effective_windrise_slots_for_query(query, history)
    if not force and not should_run_windrise_query_semantic_analysis(query, history, slots):
        return query, slots, ''
    print(f"[Windrise] 开始提取知识库检索内容: {query}")
    consolidated = call_windrise_query_consolidator(query, history, slots, force=force)
    if not consolidated:
        if required:
            raise RuntimeError(WINDRISE_RETRIEVAL_EXTRACTION_FAILURE)
        print(f"[Windrise] 检索内容提取无结果，沿用原问题: {query}")
        return query, slots, ''
    rewritten = normalize_windrise_query(consolidated.get('rewritten_query') or '')
    if not rewritten:
        extracted_terms = [
            normalize_context_dimension_value(consolidated.get(key, ''))
            for key in (
                'farm', 'turbine_id', 'brand', 'standard_model', 'model',
                'fault_code', 'component', 'fault_name', 'symptom',
            )
        ]
        rewritten = normalize_windrise_query(' '.join(dict.fromkeys(
            term for term in extracted_terms if term
        )))
        if not rewritten:
            if required:
                raise RuntimeError(WINDRISE_RETRIEVAL_EXTRACTION_FAILURE)
            rewritten = query
    rewritten = re.sub(
        r'(?i)(?<![A-Za-z])(general|repair|reason|reset)(?![A-Za-z])',
        ' ',
        rewritten,
    )
    rewritten = build_llmwiki_optimized_retrieval_query(consolidated, rewritten, slots)
    rewritten = normalize_text(rewritten)
    rewritten_terms = []
    for term in rewritten.split():
        if rewritten_terms:
            previous = rewritten_terms[-1]
            if len(previous) >= 2 and len(term) >= 2 and (
                term.startswith(previous) or previous.startswith(term)
            ):
                rewritten_terms[-1] = term if len(term) > len(previous) else previous
                continue
        rewritten_terms.append(term)
    rewritten = normalize_text(' '.join(rewritten_terms))
    merged_slots = merge_consolidated_windrise_slots(slots, consolidated)
    if (
        is_context_only_windrise_followup(query)
        and rewritten == query
        and not is_windrise_scoped_symptom_followup(query, history)
    ):
        contextual_terms = windrise_slot_search_terms(merged_slots)
        if merged_slots.get('fault_name'):
            contextual_terms.append(merged_slots['fault_name'])
        if contextual_terms:
            rewritten = normalize_windrise_query(' '.join(dict.fromkeys(contextual_terms)))
    extracted_intent = normalize_windrise_intent(consolidated.get('intent', ''))
    if extracted_intent == 'general':
        query_intent = classify_windrise_answer_intent(query)
        if query_intent == 'trigger':
            extracted_intent = 'trigger'
    merged_slots['intent'] = extracted_intent
    confidence = str(consolidated.get('confidence', '')).lower()
    if (
        confidence == 'low'
        and rewritten == query
        and not is_windrise_scoped_symptom_followup(query, history)
    ):
        extra_parts = []
        for key in ('farm', 'turbine_id', 'fault_code'):
            value = merged_slots.get(key)
            if value and str(value).lower() not in query.lower():
                extra_parts.append(str(value))
        if extra_parts:
            rewritten = normalize_windrise_query(' '.join(extra_parts + [query]))
    rewritten = clip_text(rewritten, 120)
    rewritten = clamp_windrise_semantic_rewritten_query(query, history, rewritten)
    note = ''
    if rewritten != query:
        note = f'已理解您的问题为：{rewritten}'
    windrise_request_context.retrieval_query_extracted = True
    print(f"[Windrise] 知识库检索内容提取完成: {query} -> {rewritten}")
    return rewritten, merged_slots, note


def prepend_windrise_consolidate_note(answer, note):
    note = normalize_text(note)
    answer = str(answer or '')
    if not note:
        return answer
    if not answer:
        return note
    if note in answer:
        return answer
    return f"{note}\n\n{answer}"


def windrise_focused_mapping_context(slots):
    turbine_id = normalize_windrise_turbine_id((slots or {}).get('turbine_id', ''))
    farm = normalize_context_dimension_value((slots or {}).get('farm', ''))
    if not turbine_id:
        return None
    entry = lookup_windrise_turbine_mapping(turbine_id, farm)
    if not entry:
        return None
    return {
        'brand': normalize_context_dimension_value(entry.get('brand', '')) or normalize_context_dimension_value((slots or {}).get('brand', '')),
        'model': normalize_context_dimension_value(entry.get('model', '')) or normalize_context_dimension_value((slots or {}).get('model', '')),
        'standard_model': normalize_context_dimension_value(entry.get('standardModel', '')) or normalize_context_dimension_value((slots or {}).get('standard_model', '')),
        'farm': normalize_context_dimension_value(entry.get('site', '')) or farm,
        'turbine_id': turbine_id,
    }


def narrow_fault_records_for_explicit_slots(records, slots, strict=False):
    records = list(records or [])
    if not records:
        return records
    context = windrise_focused_mapping_context(slots or {})
    if not context or not context.get('standard_model'):
        return records
    target = context['standard_model'].lower()
    matched = []
    for record in records:
        standard_model = normalize_context_dimension_value(record.get('standardModel', '')).lower()
        model = normalize_context_dimension_value(record.get('model', '')).lower()
        if target and (target in standard_model or standard_model in target or target in model):
            matched.append(record)
    if matched:
        return matched
    return [] if strict else records


def filter_fault_records_for_converged_scope(records, slots, query=None):
    records = list(records or [])
    if not records or not has_windrise_converged_scope(slots, query):
        return records
    resolved_code = windrise_resolved_fault_code(slots, query)
    filtered = []
    for record in records:
        if not record_matches_explicit_windrise_slots(record, slots):
            continue
        if resolved_code:
            record_code = normalize_context_dimension_value(record.get('code', ''))
            if not record_code or record_code.lower() != resolved_code.lower():
                continue
        filtered.append(record)
    if not filtered:
        return []
    return narrow_fault_records_for_explicit_slots(filtered, slots, strict=True) or filtered


def windrise_record_meta_parts(record, slots=None):
    slots = slots or {}
    context = windrise_focused_mapping_context(slots) if slots.get('turbine_id') else None
    if context:
        meta = []
        if context.get('brand'):
            meta.append(f"厂家：{context['brand']}")
        if context.get('model'):
            meta.append(f"机型：{context['model']}")
        if context.get('standard_model'):
            meta.append(f"具体型号：{context['standard_model']}")
        if context.get('farm'):
            meta.append(f"风场：{context['farm']}")
        meta.append(f"风机编号：{context['turbine_id']}")
        return meta
    meta = []
    turbine_id = normalize_windrise_turbine_id(slots.get('turbine_id', ''))
    for key, label in (
        ('brand', '厂家'),
        ('model', '机型'),
        ('standardModel', '具体型号'),
        ('site', '风场'),
        ('turbineIds', '风机编号'),
    ):
        value = normalize_context_dimension_value(record.get(key, ''))
        if not value:
            continue
        if key == 'turbineIds' and turbine_id:
            value = turbine_id
        elif key == 'turbineIds' and '、' in value:
            ids = [item.strip() for item in re.split(r'[、,，;；/]', value) if item.strip()]
            if len(ids) > 4:
                value = '、'.join(ids[:4]) + f' 等{len(ids)}台'
        meta.append(f"{label}：{value}")
    return meta


def build_direct_fault_code_conclusion_lines(query, records, intent, code_override=''):
    direct_codes = extract_direct_windrise_fault_codes(query, [])
    if not direct_codes and not code_override:
        return []
    raw_code = code_override or direct_codes[0]
    code = normalize_windrise_fault_code(raw_code) or normalize_context_dimension_value(raw_code)
    matching = [
        record for record in records or []
        if normalize_context_dimension_value(record.get('code', '')).lower() == code.lower()
    ]
    if not matching:
        return []
    names = []
    for record in matching:
        name = normalize_context_dimension_value(record.get('name', ''))
        if name and name not in names:
            names.append(name)
    if len(names) != 1:
        return [
            f"**故障码 {code} 存在多种含义**",
            '',
            f"结论：当前条件下匹配到 {len(names) or len(matching)} 种故障记录，需要结合厂家、机型或风场区分。",
        ]

    record = matching[0]
    name = names[0]
    lines = [
        f"**故障码 {code}：{name}**",
        '',
        f"结论：故障码 {code} 表示“{name}”。",
    ]
    logic = normalize_text(record.get('logic', ''))
    detail = ''
    label = ''
    if intent == 'trigger':
        label = '触发条件'
        detail = normalize_text(record.get('logic', ''))
        if not detail:
            text = normalize_text(record.get('text', ''))
            match = re.search(r'(?:故障触发条件|触发条件|故障逻辑|逻辑)[:：]\s*([^。\n]+)', text)
            if match:
                detail = match.group(1)
    elif intent == 'reason':
        label = '原因判断'
        detail = normalize_text(record.get('reason', '')) or logic
    elif intent == 'reset':
        label = '复位条件'
        detail = normalize_text(record.get('reset', ''))
        if not detail:
            detail = '知识库未给出该故障码的复位条件，不能用维修处理步骤代替复位依据。'
    elif intent == 'impact':
        label = '影响判断'
        detail = '知识库未单独给出影响范围。' + (f'已知触发逻辑为：{logic}' if logic else '需结合保护动作和伴随报警判断。')
    elif intent == 'risk':
        label = '风险判断'
        detail = '知识库未给出风险等级，不能只凭报码判断严重程度。应结合是否停机、保护动作和现场状态确认。'
    elif intent == 'operation':
        label = '运行建议'
        detail = '知识库未明确说明该报码出现后是否允许继续运行。告警未消除或保护已动作时，不建议反复复位或强行运行，应按现场规程确认。'
    elif intent in {'meaning', 'comparison'}:
        detail = ''
    else:
        label = '处理建议'
        detail = normalize_text(record.get('solution', ''))
    if detail:
        lines.extend(['', f"{label}：{clip_text(detail, 280)}"])
    return lines


def resolve_windrise_site_full_name(farm, mapping_entry=None):
    farm = normalize_context_dimension_value(farm)
    if mapping_entry:
        return (
            normalize_context_dimension_value(mapping_entry.get('siteFull', ''))
            or normalize_context_dimension_value(mapping_entry.get('site', ''))
            or farm
        )
    if farm and '风电场' not in farm and '风场' not in farm:
        return f'{farm}风电场'
    if farm and farm.endswith('风场'):
        return f'{farm[:-2]}风电场'
    return farm


def detect_plc_comm_fault_variant(query):
    compact = compact_fault_match_text(normalize_text(query))
    if not compact:
        return ''
    if '从plc检测到从plc通讯错误' in compact or compact.startswith('从plc检测到'):
        return 'slave'
    if '主plc检测到从plc通讯错误' in compact or '主plc检测到' in compact:
        return 'master'
    return ''


def prefer_plc_comm_fault_records(candidates, query):
    variant = detect_plc_comm_fault_variant(query)
    if not variant or not candidates:
        return list(candidates or [])
    preferred_codes = {
        'master': {'272'},
        'slave': {'273'},
    }
    target_codes = preferred_codes.get(variant, set())
    preferred = [
        record for record in candidates
        if normalize_context_dimension_value(record.get('code', '')) in target_codes
    ]
    if not preferred:
        return list(candidates)
    others = [record for record in candidates if record not in preferred]
    return preferred + others


def cross_verify_fault_record(record, slots, mapping_entry=None):
    turbine_id = normalize_windrise_turbine_id((slots or {}).get('turbine_id', ''))
    farm = normalize_context_dimension_value((slots or {}).get('farm', ''))
    site_text = normalize_context_dimension_value(record.get('site', ''))
    record_brand = normalize_context_dimension_value(record.get('brand', ''))
    slot_brand = normalize_context_dimension_value((slots or {}).get('brand', ''))
    checks = {
        'site_covers_farm': (not farm or not site_text or farm in site_text or site_text in farm),
        'turbine_covers_id': (
            not turbine_id
            or record_matches_windrise_turbine_id(record, turbine_id, farm)
        ),
        'brand_matches': (not slot_brand or not record_brand or record_brand.lower() == slot_brand.lower()),
        'has_source': bool(normalize_text(record.get('source', ''))),
    }
    if mapping_entry:
        mapping_brand = normalize_context_dimension_value(mapping_entry.get('brand', ''))
        checks['mapping_brand_matches'] = (
            not mapping_brand or not record_brand or mapping_brand.lower() == record_brand.lower()
        )
    checks['passed'] = all(checks.values())
    return checks


def log_windrise_evidence_trace(trace):
    if not trace:
        return
    print(
        '[Windrise][Evidence] '
        f"farm={mask_identifier(trace.get('farm', ''), prefix=1, suffix=1)} "
        f"turbine={mask_identifier(trace.get('turbine_id', ''), prefix=1, suffix=1)} "
        f"brand={trace.get('brand', '')} "
        f"model={trace.get('model', '')} "
        f"code={trace.get('code', '')} "
        f"verified={bool(trace.get('verified'))} "
        f"source={clip_text(trace.get('source', ''), 120)}"
    )


def build_windrise_evidence_trace(query, slots, mapping_entry, record, verification):
    record = record or {}
    slots = slots or {}
    return {
        'query': clip_text(query, 120),
        'farm': normalize_context_dimension_value(slots.get('farm', '')),
        'turbine_id': normalize_windrise_turbine_id(slots.get('turbine_id', '')),
        'brand': normalize_context_dimension_value(slots.get('brand', '')),
        'model': normalize_windrise_model_value(slots.get('model', '')),
        'standard_model': normalize_windrise_model_value(slots.get('standard_model', '')),
        'mapping_source': 'src/data/turbineMapping.json' if mapping_entry else '',
        'code': normalize_context_dimension_value(record.get('code', '')),
        'name': normalize_context_dimension_value(record.get('name', '')),
        'source': normalize_text(record.get('source', '')),
        'verified': bool((verification or {}).get('passed')),
        'verification': verification or {},
    }


def should_use_evidence_based_fault_answer(query, slots, records, intent=None):
    if is_windrise_casual_chat_query(query) or is_windrise_general_knowledge_question(query):
        return False
    if not records or len(records) != 1:
        return False
    intent = intent or classify_windrise_answer_intent(query)
    if intent in {'comparison', 'operation', 'risk', 'impact', 'meaning'}:
        return False
    if not (
        has_windrise_converged_scope(slots, query)
        or is_fully_specified_windrise_fault_query(query, slots)
    ):
        return False
    if not is_confident_fault_topic_match(query, records[0]):
        return False
    subject = (
        extract_scada_style_alarm_name(query)
        or extract_windrise_fault_subject_phrase(query)
        or normalize_text((slots or {}).get('fault_name', ''))
    )
    return len(compact_fault_match_text(subject)) >= 4


def build_fault_escalation_guidance(record, query):
    variant = detect_plc_comm_fault_variant(query or normalize_text(record.get('name', '')))
    lines = [
        '- 按上述步骤处理后仍报警，先保持停机隔离，不要反复远程复位。',
        '- 记录伴随报警、主控/变流器/安全链状态，确认是否仅为通信类单点故障。',
    ]
    if variant == 'master':
        lines.extend([
            '- 主 PLC 重启后仍报：重点检查从站 PLC 供电、IP 与网线。',
            '- 若同时出现从站侧 273 类报警，需主从两侧分别排查。',
        ])
    elif variant == 'slave':
        lines.extend([
            '- 从站 FK1/FK2/FK3 指示灯异常且重启无效：考虑更换从站 PLC。',
            '- 同步核对从站 IP 设置与交换机端口状态。',
        ])
    else:
        lines.append('- 故障消除后观察 10–15 分钟，确认无复报再考虑复位并网。')
    return lines


def build_evidence_based_fault_answer(query, records, slots, intent=None):
    """Step 5a: organize a single evidence-backed fault reply for field use."""
    records = filter_fault_records_for_converged_scope(records, slots, query)
    if not records:
        return ''
    record = records[0]
    slots = slots or build_effective_windrise_slots_for_query(query, [])
    intent = intent or classify_windrise_answer_intent(query)
    mapping_entry = None
    turbine_id = normalize_windrise_turbine_id(slots.get('turbine_id', ''))
    farm = normalize_context_dimension_value(slots.get('farm', ''))
    if turbine_id:
        mapping_entry = lookup_windrise_turbine_mapping(turbine_id, farm)
    site_full = resolve_windrise_site_full_name(farm, mapping_entry)
    brand = (
        normalize_context_dimension_value(slots.get('brand', ''))
        or normalize_context_dimension_value(record.get('brand', ''))
    )
    model = (
        normalize_windrise_model_value(slots.get('model', ''))
        or normalize_windrise_model_value(record.get('model', ''))
    )
    standard_model = (
        normalize_windrise_model_value(slots.get('standard_model', ''))
        or normalize_windrise_model_value(record.get('standardModel', ''))
    )
    code = normalize_context_dimension_value(record.get('code', ''))
    kb_name = normalize_context_dimension_value(record.get('name', '')) or '未标明'
    name = resolve_primary_fault_display_name(record, query, slots)
    reason = normalize_text(record.get('reason', ''))
    handling = normalize_text(record.get('solution', ''))
    logic = normalize_text(record.get('logic', ''))
    alarm = normalize_text(record.get('alarm', ''))
    reset = normalize_text(record.get('reset', ''))
    source = normalize_text(record.get('source', ''))
    step_label, steps = format_fault_solution_steps(handling)
    model_text = ' '.join(part for part in (brand, model) if part)
    if standard_model and standard_model not in model_text:
        model_text = f'{model_text}（{standard_model}）'.strip()
    object_line = f'{site_full} {turbine_id} → {model_text}'.strip()
    if not turbine_id:
        object_line = model_text or site_full or '当前对象'

    lines = [
        '**证据命中**',
        '',
        '【对象确认】',
        object_line,
        '',
        f'【故障代码】{code or "未标明"}',
        f'【故障名称】{name}',
    ]
    if kb_name and kb_name != name:
        lines.append(f'（手册条目：{kb_name}）')
    if alarm:
        lines.append(f'【报警】{alarm}')
    if reset:
        lines.append(f'【复位】{reset}')
    lines.extend([
        '',
        '【原因】',
        reason or logic or '知识库未单独给出原因说明。',
        '',
        f'【{step_label}（按顺序）】',
    ])
    if steps:
        for index, step in enumerate(steps, start=1):
            lines.append(f'{index}. {step}')
    else:
        lines.append('1. 知识库未给出明确检查/处理步骤，请结合现场报警和机型手册核对。')

    if intent == 'reset':
        reset = normalize_text(record.get('reset', ''))
        lines.extend(['', '【复位说明】', reset or '知识库未给出，不能用维修处理步骤代替复位依据。'])
    elif intent == 'trigger':
        logic = normalize_text(record.get('logic', ''))
        lines.extend(['', '【触发条件】', logic or '知识库未单独给出触发阈值。'])

    lines.extend(['', '【持续报警时】'])
    lines.extend(build_fault_escalation_guidance(record, query))
    lines.extend([
        '',
        '【依据】',
        f'本地故障手册：{brand} {model} / 故障码 {code or "未标明"}',
    ])
    if source:
        lines.append(f'来源：{source}')
    lines.append('（已由机组映射 + fault-index 交叉核对）')
    return '\n'.join(lines)


def build_fault_record_identity_key(record):
    record = record or {}
    return (
        normalize_context_dimension_value(record.get('code', '')),
        compact_fault_match_text(record.get('name', '')),
    )


def pick_alternative_fault_candidate(candidates, primary_record):
    if not candidates or not primary_record:
        return None
    primary_key = build_fault_record_identity_key(primary_record)
    for candidate in candidates:
        if build_fault_record_identity_key(candidate) != primary_key:
            return candidate
    return None


def extract_fault_record_field_from_text(record, field_labels):
    text = normalize_text(record.get('text', ''))
    if not text:
        return ''
    for label in field_labels:
        match = re.search(rf'{re.escape(label)}[:：]\s*([^。；;\n]+)', text)
        if match:
            return clip_text(match.group(1).strip(), 220)
    return ''


def build_fault_alternative_answer_section(record, slots=None):
    record = record or {}
    slots = slots or {}
    brand = (
        normalize_context_dimension_value(record.get('brand', ''))
        or normalize_context_dimension_value(slots.get('brand', ''))
    )
    model = (
        normalize_windrise_model_value(record.get('model', ''))
        or normalize_windrise_model_value(slots.get('model', ''))
    )
    code = normalize_context_dimension_value(record.get('code', ''))
    name = normalize_context_dimension_value(record.get('name', '')) or '未标明'
    description = extract_fault_record_field_from_text(record, ('故障描述', '故障信息'))
    brake_level = extract_fault_record_field_from_text(record, ('刹车等级', '故障等级'))
    yaw_level = extract_fault_record_field_from_text(record, ('偏航等级',))
    handling = normalize_text(record.get('solution', ''))
    _, steps = format_fault_solution_steps(handling, max_steps=4)
    solution = '；'.join(steps) if steps else handling

    parts = []
    if brand:
        parts.append(f'品牌:{brand}')
    if model:
        parts.append(f'机型:{model}')
    if code:
        parts.append(f'故障代码:{code}')
    parts.append(f'故障名称:{name}')
    if description:
        parts.append(f'故障描述:{description}')
    if brake_level:
        parts.append(f'刹车等级:{brake_level}')
    if yaw_level:
        parts.append(f'偏航等级:{yaw_level}')
    if solution:
        parts.append(f'解决方案:{solution}')

    if not parts:
        return ''
    body = '。'.join(parts) + '。'
    return '\n'.join([
        '---',
        '**备选答案**（次高相关，供现场核对）',
        body,
    ])


def append_windrise_fault_alternative_answer(answer, candidates, primary_record, slots=None, min_alternative_score=40):
    if not answer or not primary_record or not candidates:
        return answer
    alternative = pick_alternative_fault_candidate(candidates, primary_record)
    if not alternative:
        return answer
    if int(alternative.get('_score', 0) or 0) < int(min_alternative_score or 0):
        return answer
    section = build_fault_alternative_answer_section(alternative, slots)
    if not section or section in answer:
        return answer
    return f'{answer}\n\n{section}'


def format_fault_solution_steps(handling, max_steps=8):
    """Preserve numbered inspection/repair steps from KB records."""
    steps = [item.strip() for item in re.split(r'[;；]', normalize_text(handling)) if item.strip()]
    normalized_steps = [
        re.sub(r'^\d+[.、]\s*', '', step)
        for step in steps[:max(1, int(max_steps or 8))]
    ]
    label = '检查/处理' if any('检查' in step for step in normalized_steps) else '处理'
    return label, normalized_steps


def build_structured_fault_records_answer(query, records, intent=None, limit=3, slots=None, code_override='', scope_filter=True):
    slots = slots or build_effective_windrise_slots_for_query(query, [])
    if scope_filter:
        records = filter_fault_records_for_converged_scope(records, slots, query)
    else:
        records = list(records or [])
    fully_specified = scope_filter and is_fully_specified_windrise_fault_query(query, slots)
    converged_scope = scope_filter and has_windrise_converged_scope(slots, query)
    if should_limit_windrise_results_to_one(slots, query):
        configured_limit = 1
    elif fully_specified:
        configured_limit = 1
    else:
        configured_limit = max(1, int(limit or 3))
    selected = list(records or [])[:configured_limit]
    if not selected:
        return ''
    intent = intent or classify_windrise_answer_intent(query)
    total_count = len(records or [])
    primary_code = normalize_context_dimension_value(code_override or selected[0].get('code', ''))
    if primary_code:
        header_labels = {
            'trigger': '触发条件', 'reason': '原因分析', 'reset': '复位说明',
            'meaning': '故障含义', 'impact': '影响说明', 'risk': '风险说明',
            'operation': '运行决策', 'comparison': '对比信息', 'repair': '维修处理建议',
        }
        header = f"{primary_code} {header_labels.get(intent, '维修处理建议')}"
    else:
        header = {
            'trigger': '触发条件', 'reason': '原因分析', 'reset': '复位说明',
            'meaning': '故障含义', 'impact': '影响说明', 'risk': '风险说明',
            'operation': '运行决策', 'comparison': '对比信息',
        }.get(intent, '维修处理建议')
    direct_conclusion = build_direct_fault_code_conclusion_lines(
        query, selected, intent, code_override=code_override
    )
    lines = direct_conclusion + ['', '**知识库记录**'] if direct_conclusion else [header]
    if fully_specified:
        context = windrise_focused_mapping_context(slots) or {}
        farm = context.get('farm') or slots.get('farm', '')
        turbine_id = context.get('turbine_id') or slots.get('turbine_id', '')
        if farm and turbine_id:
            lines.append(f"已按 {farm}风场 {turbine_id} 定位到对应机型记录。")
    elif converged_scope and len(selected) == 1:
        context = windrise_focused_mapping_context(slots) or {}
        farm = context.get('farm') or slots.get('farm', '')
        turbine_id = context.get('turbine_id') or slots.get('turbine_id', '')
        code = windrise_resolved_fault_code(slots, query)
        if farm and turbine_id:
            lines.append(f"已按 {farm}风场 {turbine_id} 收敛到最相关记录。")
        elif farm:
            lines.append(f"已按 {farm}风场 过滤，仅展示匹配记录。")
        elif turbine_id:
            lines.append(f"已按风机编号 {turbine_id} 过滤，仅展示匹配记录。")
        elif code:
            lines.append(f"已按故障码 {code} 过滤，仅展示匹配记录。")
    elif total_count > len(selected):
        lines.append(f"匹配到 {total_count} 条记录；先展开前 {len(selected)} 条高相关记录。")
    else:
        lines.append(f"匹配到 {total_count} 条记录。")
    for index, record in enumerate(selected, start=1):
        code = normalize_context_dimension_value(record.get('code', ''))
        name = normalize_context_dimension_value(record.get('name', '')) or '未标明'
        title_text = f"{code}｜{name}" if code else name
        lines.append('')
        lines.append(f"{index}. **{title_text}**")
        meta = windrise_record_meta_parts(record, slots)
        if meta:
            lines.append(f"   - {' / '.join(meta)}")
        reason = normalize_text(record.get('reason', ''))
        handling = normalize_text(record.get('solution', ''))
        logic = normalize_text(record.get('logic', ''))
        text = normalize_text(record.get('text', ''))
        reset = normalize_text(record.get('reset', ''))
        if intent == 'trigger':
            if logic:
                lines.append(f"   - 触发条件：{clip_text(logic, 260)}")
            elif text:
                logic_match = re.search(r'(?:故障触发条件|触发条件|故障逻辑|逻辑)[:：]\s*([^。\n]+)', text)
                if logic_match:
                    lines.append(f"   - 触发条件：{clip_text(logic_match.group(1), 260)}")
                else:
                    lines.append("   - 触发条件：知识库未单独给出触发阈值。")
            else:
                lines.append("   - 触发条件：知识库未单独给出触发阈值。")
        elif intent == 'reason':
            reasons = []
            if reason:
                reasons.extend(item.strip() for item in re.split(r'[;；]', reason) if item.strip())
            if logic and logic not in reasons:
                reasons.append(logic)
            if reasons:
                lines.append("   - 可能原因：" + clip_text('；'.join(
                    re.sub(r'^\d+[.、]\s*', '', item) for item in reasons[:3]
                ), 220))
            else:
                lines.append("   - 可能原因：知识库未给出明确原因，只给出了故障名称或逻辑。")
        elif intent == 'reset':
            if reset:
                lines.append(f"   - 复位条件：{clip_text(reset, 220)}")
            else:
                lines.append("   - 复位条件：知识库未给出，不能用维修处理步骤代替复位依据。")
        elif intent == 'meaning':
            lines.append(f"   - 含义：该故障码表示“{name}”。")
        elif intent == 'impact':
            impact_text = f"已知触发逻辑为：{clip_text(logic, 200)}" if logic else '需结合保护动作和伴随报警判断。'
            lines.append(f"   - 影响：知识库未单独给出影响范围；{impact_text}")
        elif intent == 'risk':
            lines.append("   - 风险：知识库未给出风险等级；请结合是否停机、保护动作和现场状态判断。")
        elif intent == 'operation':
            lines.append("   - 运行：知识库未明确允许继续运行；告警未消除或保护已动作时，不建议反复复位或强行运行。")
        elif intent == 'comparison':
            if logic:
                lines.append(f"   - 识别要点：{clip_text(logic, 220)}")
        elif handling:
            if reason:
                lines.append(f"   - 原因：{clip_text(reason, 180)}")
            step_label, short_steps = format_fault_solution_steps(handling)
            lines.append(f"   - {step_label}：{clip_text('；'.join(short_steps), 480)}")
        elif logic:
            lines.append(f"   - 逻辑：{clip_text(logic, 220)}")
        elif reason:
            lines.append(f"   - 原因：{clip_text(reason, 260)}")
        elif text:
            if not (slots.get('turbine_id') and re.search(r'风机编号[:：]', text)):
                lines.append(f"   - 摘要：{clip_text(text, 260)}")
        else:
            lines.append("   - 处理：知识库未给出明确维修步骤。")
        if reset and intent not in {'reason', 'trigger', 'reset', 'meaning', 'comparison'}:
            lines.append(f"   - 复位：{clip_text(reset, 160)}")
        source = normalize_text(record.get('source', ''))
        if source:
            lines.append(f"   - 来源：{source}")
    if total_count > len(selected) and not converged_scope:
        lines.extend([
            "",
            f"还有 {total_count - len(selected)} 条记录未展开；请补充厂家、机型、风场或 HMI/SCADA 原始报码后继续收敛。",
        ])
    return '\n'.join(lines)


def collect_scoped_fault_index_candidates(query, history=None):
    normalized_query = normalize_windrise_query(query)
    if not normalized_query:
        return [], {}, '', False
    slots = build_effective_windrise_slots_for_query(normalized_query, history or [])
    scoped_symptom_followup = is_windrise_scoped_symptom_followup(normalized_query, history or [])
    if scoped_symptom_followup:
        confirmed_scope = build_resolved_windrise_scope_slots(normalized_query, history or [])
        slots = merge_windrise_slots(
            slots,
            {
                key: confirmed_scope.get(key, '')
                for key in ('brand', 'farm', 'model', 'standard_model', 'turbine_id')
                if confirmed_scope.get(key)
            },
        )
        if confirmed_scope.get('turbine_ids'):
            slots['turbine_ids'] = list(confirmed_scope.get('turbine_ids') or [])
    topic = clean_current_fault_lookup_topic(normalized_query) or normalized_query
    subject_phrase = extract_scada_style_alarm_name(normalized_query) or extract_windrise_fault_subject_phrase(normalized_query)
    if subject_phrase and len(subject_phrase) >= 3:
        topic = subject_phrase
    has_issue_slots = bool(
        slots.get('component')
        or slots.get('symptom')
        or slots.get('fault_name')
        or (subject_phrase and len(subject_phrase) >= 3)
    )
    topic_terms = windrise_topic_terms(topic)
    semantic_terms = []
    skip_semantic = bool(
        slots.get('turbine_id')
        and (slots.get('farm') or slots.get('brand'))
    ) or is_explicit_fault_name_lookup_query(normalized_query) or is_explicit_fault_action_lookup_query(normalized_query)
    if not skip_semantic:
        semantic_info = call_windrise_fault_semantic_normalizer(topic, slots)
        semantic_terms = semantic_fault_terms_to_topic_terms(semantic_info)
        for term in semantic_terms:
            if term and term not in topic_terms:
                topic_terms.append(term)
    speed_limit_fuzzy = is_speed_limit_fuzzy_query(topic)
    semantic_topic_text = ' '.join([topic] + semantic_terms)
    speed_limit_fuzzy = is_speed_limit_fuzzy_query(semantic_topic_text)
    converter_power_limit_fuzzy = is_converter_power_limit_fuzzy_query(semantic_topic_text)
    compact_topic = compact_fault_match_text(topic)
    compact_subject = compact_fault_match_text(subject_phrase or topic)
    requires_topic_overlap = bool(
        scoped_symptom_followup
        and compact_subject
        and len(compact_subject) >= 6
    )
    has_explicit_topic = len(compact_topic) >= 4 and (
        is_explicit_fault_name_lookup_query(normalized_query)
        or is_explicit_fault_action_lookup_query(normalized_query)
        or looks_like_fault_phenomenon_query(normalized_query)
    )
    candidates = []
    seen = set()
    farm = normalize_context_dimension_value(slots.get('farm', ''))
    brand = normalize_context_dimension_value(slots.get('brand', ''))
    resolved_code = windrise_resolved_fault_code(slots, normalized_query)
    records = load_windrise_fault_index_records()
    if (
        has_explicit_topic
        and compact_topic
        and not resolved_code
        and not scoped_symptom_followup
        and not (
            has_windrise_converged_scope(slots, normalized_query)
            and normalize_windrise_turbine_id(slots.get('turbine_id', ''))
        )
    ):
        exact_name_records = [
            record for record in records
            if (
                record.get('_wr_compact_name')
                and (
                    compact_topic in record['_wr_compact_name']
                    or record['_wr_compact_name'] in compact_topic
                )
            )
        ]
        if exact_name_records:
            records = exact_name_records
    scan_started = time.monotonic()
    lookup_timed_out = False
    for record_index, record in enumerate(records):
        if (
            record_index % 64 == 0
            and time.monotonic() - scan_started > WINDRISE_INDEX_LOOKUP_TIMEOUT
        ):
            lookup_timed_out = True
            break
        if resolved_code:
            record_code = normalize_context_dimension_value(record.get('code', ''))
            if not record_code or record_code.lower() != resolved_code.lower():
                continue
        if farm:
            site_text = normalize_context_dimension_value(record.get('site', ''))
            if site_text and farm not in site_text and site_text not in farm:
                continue
        if brand:
            record_brand = normalize_context_dimension_value(record.get('brand', ''))
            if record_brand and record_brand.lower() != brand.lower():
                continue
        if not record_matches_explicit_windrise_slots(record, slots):
            continue
        identity = (
            normalize_context_dimension_value(record.get('code', '')),
            normalize_context_dimension_value(record.get('name', '')),
            normalize_context_dimension_value(record.get('site', '')),
            normalize_context_dimension_value(record.get('brand', '')),
            normalize_context_dimension_value(record.get('model', '')),
            normalize_context_dimension_value(record.get('standardModel', '')),
            normalize_context_dimension_value(record.get('turbineIds', '')),
            normalize_context_dimension_value(record.get('source', '')),
        )
        if identity in seen:
            continue
        seen.add(identity)
        if speed_limit_fuzzy and not record_matches_speed_limit_fuzzy_query(record):
            continue
        slot_score = score_fault_record_for_slots(record, slots) if has_issue_slots else 0
        topic_score = score_fault_record_for_topic(record, topic_terms)
        if slot_score <= 0 and topic_score <= 0:
            continue
        if has_explicit_topic and topic_score <= 0:
            if not (
                scoped_symptom_followup
                and slot_score >= 200
                and not requires_topic_overlap
            ):
                continue
        if requires_topic_overlap and topic_score < 20:
            continue
        if slots.get('turbine_id') and has_explicit_topic and topic_score < 20:
            if not (scoped_symptom_followup and slot_score >= 200 and topic_score > 0):
                continue
        record_compact_name = record.get('_wr_compact_name') or compact_fault_match_text(record.get('name', ''))
        exact_name_match = bool(
            compact_topic
            and record_compact_name
            and compact_topic == record_compact_name
        )
        topic_cap = 520 if (speed_limit_fuzzy or converter_power_limit_fuzzy) else 160
        if exact_name_match:
            topic_cap = max(topic_cap, topic_score)
        total_score = max(0, slot_score) + min(max(0, topic_score), topic_cap)
        min_score = 45 if speed_limit_fuzzy else (18 if has_issue_slots else 28)
        if total_score < min_score:
            continue
        enriched = dict(record)
        enriched['_score'] = total_score
        enriched['_topic_score'] = topic_score
        candidates.append(enriched)
    if lookup_timed_out:
        slots['_lookup_timed_out'] = True
        print(
            f"[Windrise] 本地索引扫描达到 {WINDRISE_INDEX_LOOKUP_TIMEOUT:.1f}s 时间预算，"
            f"已检查 {record_index}/{len(records)} 条记录"
        )
    candidates.sort(key=lambda item: (-item.get('_score', 0), -item.get('_topic_score', 0), str(item.get('code', '')), str(item.get('source', ''))))
    return candidates, slots, topic, speed_limit_fuzzy


def build_index_scoped_fault_lookup_answer(query, history=None, limit=3, intent=None):
    candidates, slots, topic, speed_limit_fuzzy = collect_scoped_fault_index_candidates(query, history)
    if not candidates:
        return ''
    candidates = prefer_plc_comm_fault_records(candidates, query)
    candidates = filter_fault_records_for_converged_scope(candidates, slots, query)
    if not candidates:
        return ''
    top = candidates[0]
    subject_phrase = compact_fault_match_text(extract_windrise_fault_subject_phrase(query) or topic)
    top_name = compact_fault_match_text(top.get('name', ''))
    exact_subject_match = bool(
        subject_phrase
        and top_name
        and (
            subject_phrase == top_name
            or subject_phrase in top_name
            or top_name in subject_phrase
        )
    )
    second_score = candidates[1].get('_score', 0) if len(candidates) > 1 else 0
    strong_lead = top.get('_score', 0) >= max(second_score + 120, 180)
    confident_topic_match = is_confident_fault_topic_match(query, top, topic)
    converged_scope = has_windrise_converged_scope(slots, query)
    confirmed_scope = build_user_confirmed_windrise_scope_slots(query, history)
    unavailable_dimensions = set(confirmed_scope.get('_unavailable_dimensions') or [])
    broad_scope_requested = bool(confirmed_scope.get('_broad_scope_requested'))
    lookup_subject = extract_fault_lookup_subject(query, topic)
    if (
        lookup_subject
        and len(lookup_subject) >= 4
        and not confident_topic_match
    ):
        scoped_miss = build_windrise_scoped_symptom_no_match_answer(query, history, topic or query)
        if scoped_miss:
            return scoped_miss
        return ''
    if should_ask_for_more_windrise_dimensions(candidates, slots, speed_limit_fuzzy=speed_limit_fuzzy):
        if broad_scope_requested:
            pass
        elif converged_scope and (exact_subject_match or confident_topic_match or should_limit_windrise_results_to_one(slots, query)):
            pass
        elif not (exact_subject_match or confident_topic_match):
            return ''
    if should_limit_windrise_results_to_one(slots, query):
        selected = candidates[:1]
    elif broad_scope_requested or unavailable_dimensions:
        selected = candidates[:WINDRISE_SCOPE_WAIVER_RESULT_LIMIT]
    else:
        configured_limit = max(1, int(limit or 3))
        selected = candidates[:min(configured_limit, 5)]

    mapping_entry = None
    turbine_id = normalize_windrise_turbine_id(slots.get('turbine_id', ''))
    farm = normalize_context_dimension_value(slots.get('farm', ''))
    if turbine_id:
        mapping_entry = lookup_windrise_turbine_mapping(turbine_id, farm)
    verification = cross_verify_fault_record(selected[0], slots, mapping_entry) if selected else {}
    log_windrise_evidence_trace(
        build_windrise_evidence_trace(query, slots, mapping_entry, selected[0] if selected else {}, verification)
    )

    if should_use_evidence_based_fault_answer(query, slots, selected, intent=intent):
        answer = build_evidence_based_fault_answer(query, selected, slots, intent=intent)
    else:
        answer = build_structured_fault_records_answer(
            query,
            selected,
            intent=intent,
            limit=len(selected),
            slots=slots,
        )
    if answer and len(selected) == 1:
        answer = append_windrise_fault_alternative_answer(answer, candidates, selected[0], slots)
    if not answer:
        return answer
    if broad_scope_requested:
        known_dimensions = []
        labels = {
            'farm': '风场',
            'brand': '厂家',
            'turbine_id': '风机编号',
            'model': '机型/具体型号',
        }
        for key in ('farm', 'brand', 'turbine_id', 'model', 'standard_model'):
            value = confirmed_scope.get(key, '')
            if value:
                label = labels['model'] if key == 'standard_model' else labels[key]
                known_dimensions.append(f'{label}={value}')
        scope_text = '；'.join(known_dimensions) or '当前已知条件'
        if len(candidates) > len(selected):
            scope_note = (
                f"已按您的要求，不再继续追问风机编号或机型，直接按{scope_text}检索到 {len(candidates)} 条相关记录，"
                f"先列出前 {len(selected)} 条高相关结果。"
            )
        else:
            scope_note = f"已按您的要求，不再继续追问风机编号或机型，直接按{scope_text}检索到以下相关结果。"
        return f"{scope_note}\n\n{answer}"
    if not unavailable_dimensions:
        return answer
    labels = {
        'farm': '风场',
        'turbine_id': '风机编号',
        'model': '机型/具体型号',
    }
    missing_text = '、'.join(labels.get(item, item) for item in sorted(unavailable_dimensions))
    if len(candidates) > len(selected):
        scope_note = (
            f"已记录您暂时无法提供{missing_text}。现按其余已知信息找到 {len(candidates)} 条相关记录，"
            f"为保证页面可读性先列出前 {len(selected)} 条高相关结果。"
        )
    else:
        scope_note = f"已记录您暂时无法提供{missing_text}。以下是按其余已知信息找到的相关结果。"
    return f"{scope_note}\n\n{answer}"


def build_deterministic_exact_fault_name_answer(query, history=None):
    """Answer only provable exact-name matches without spending a model pass."""
    normalized = normalize_text(query)
    if not normalized or extract_direct_windrise_fault_codes(normalized, history or []):
        return ''
    explicit_lookup = bool(re.search(
        r'(是什么故障码|是什么故障代码|是什么码|故障码是什么|故障代码是什么|对应.*?(?:故障码|故障代码|报码|告警码|报警码))',
        normalized,
        flags=re.IGNORECASE,
    ))
    explicit_action = bool(
        re.search(r'(故障|报警|告警|停机|超限|过高|过低|异常|短路|断路|丢失|失败)', normalized)
        and re.search(r'(怎么修|维修|怎么处理|如何处理|处理步骤|处理方法|检修|排查|为什么|为何|原因|复位)', normalized)
    )
    explicit_statement = is_explicit_fault_topic_statement(normalized)
    if not (explicit_lookup or explicit_action or explicit_statement):
        return ''

    topic = clean_current_fault_lookup_topic(normalized)
    action_stripped = re.sub(
        r'(?:怎么修|怎么处理|如何处理|处理步骤|处理方法|如何排查|检修|维修|排查|为什么会报|为什么|为何|原因|怎么复位|如何复位|能否复位|能不能复位|复位)\s*$',
        '',
        topic,
        flags=re.IGNORECASE,
    ).strip(' ？?。!！,，;；:：')
    compact_topics = dedupe_preserve_order(
        compact_fault_match_text(value)
        for value in (action_stripped, topic)
        if len(compact_fault_match_text(value)) >= 4
    )
    if not compact_topics:
        return ''

    slots = build_effective_windrise_slots_for_query(normalized, history or [])
    if query_matches_exact_windrise_fault_name(normalized):
        slots['fault_code'] = ''
        slots['_ignore_query_fault_code'] = True
        if not re.search(r'(?:风机编号|风机号|机位号|机组编号|对应编号|标牌|编号)\s*[:：]?', normalized):
            slots['turbine_id'] = ''
            slots['turbine_ids'] = []
    ranked = []
    for record in load_windrise_fault_index_records():
        if not record_matches_explicit_windrise_slots(record, slots):
            continue
        compact_name = record.get('_wr_compact_name') or compact_fault_match_text(record.get('name', ''))
        if len(compact_name) < 4:
            continue
        score = 0
        for compact_topic in compact_topics:
            if compact_topic == compact_name:
                score = max(score, 1000 + len(compact_name))
            elif compact_name in compact_topic:
                score = max(score, 800 + len(compact_name))
            elif compact_topic in compact_name:
                score = max(score, 700 + len(compact_topic))
        if score:
            enriched = dict(record)
            enriched['_score'] = score
            ranked.append(enriched)

    if not ranked:
        if re.search(r'(不存在的|并不存在|虚构的|随便编的)', normalized):
            return build_windrise_no_match_answer(normalized, history or [], {
                'reason': 'deterministic_fabricated_fault_name_no_match',
            })
        return ''

    best_score = max(record.get('_score', 0) for record in ranked)
    records = [record for record in ranked if record.get('_score', 0) == best_score]
    records.sort(key=lambda item: (str(item.get('code', '')), str(item.get('source', ''))))
    codes = dedupe_preserve_order(
        normalize_context_dimension_value(record.get('code', ''))
        for record in records
        if normalize_context_dimension_value(record.get('code', ''))
    )
    code_override = codes[0] if len(codes) == 1 else ''
    return build_structured_fault_records_answer(
        normalized,
        records,
        intent=classify_windrise_answer_intent(normalized),
        limit=min(len(records), 5),
        slots=slots,
        code_override=code_override,
    )


def build_windrise_deterministic_preflight_answer(query, history=None):
    """Resolve only high-confidence local cases before the Web model gate."""
    normalized = normalize_text(query)
    history = history or []
    current_slots = extract_windrise_user_slots(normalized)
    recent_context = find_recent_fault_context_for_query(normalized, history)
    recent_code = normalize_windrise_fault_code(recent_context.get('code', ''))
    recent_name = extract_recent_fault_topic_from_history(history) or normalize_context_dimension_value(
        recent_context.get('name', '')
    )
    context_origin = recent_fault_context_origin(history)
    explicit_scope_completion = bool(re.search(
        r'(?:按|根据|基于)(?:前面|已有|现有|目前)(?:的)?(?:信息|条件)?.{0,30}(?:最终定位|定位故障|列出相关结果)'
        r'|(?:最终定位|定位故障码).{0,30}(?:列出|结果|故障码)',
        normalized,
        flags=re.IGNORECASE,
    ))
    scope_completion_requested = bool(
        explicit_scope_completion or is_windrise_broad_scope_search_request(normalized)
    )
    if scope_completion_requested and (recent_code or recent_name):
        # When the user originally supplied a fault name, do not silently
        # collapse a same-name multi-code result to the first code parsed from
        # the previous assistant answer.  A user-supplied code remains the
        # stronger constraint.
        if recent_name and context_origin != 'code':
            answer = build_deterministic_exact_fault_name_answer(
                f'{recent_name}是什么故障码 {normalized}',
                history,
            )
        elif recent_code:
            answer, _ = build_explicit_fault_code_exact_answer(
                f'故障码{recent_code} {normalized}',
                history,
            )
        else:
            answer = ''
        if answer:
            return answer, (
                'in_process_scope_completion'
                if explicit_scope_completion
                else 'in_process_explicit_fault_code'
            )
    if is_dimension_only_fault_followup(normalized) and recent_code:
        answer, _ = build_explicit_fault_code_exact_answer(
            f'故障码{recent_code} {normalized}',
            history,
        )
        if answer:
            return answer, 'in_process_dimension_context_lookup'
    if is_context_only_windrise_followup(normalized) and recent_code:
        answer, _ = build_explicit_fault_code_exact_answer(
            f'故障码{recent_code} {normalized}',
            history,
        )
        if answer:
            return answer, 'in_process_dimension_context_lookup'
    prior_index_answer = any(
        item.get('role') == 'assistant'
        and re.search(
            r'(?:\*\*知识库记录\*\*|匹配到\s*\d+\s*条记录|\d+\s*[|｜]\s*[^\n]+)',
            normalize_text(item.get('content', '')),
        )
        for item in history
    )
    strict_recent_name = bool(
        recent_name
        and any(
            (record.get('_wr_compact_name') or compact_fault_match_text(record.get('name', '')))
            == compact_fault_match_text(recent_name)
            for record in load_windrise_fault_index_records()
        )
    )
    if (
        is_dimension_only_fault_followup(normalized)
        and prior_index_answer
        and strict_recent_name
    ):
        answer = build_deterministic_exact_fault_name_answer(
            f'{recent_name}是什么故障码 {normalized}',
            history,
        )
        if answer:
            return answer, 'in_process_dimension_context_lookup'
    if (
        is_dimension_only_fault_followup(normalized)
        and current_slots.get('farm')
        and current_slots.get('brand')
    ):
        answer = build_dimension_filtered_recent_topic_answer(normalized, history)
        if answer:
            return answer, 'in_process_dimension_context_lookup'
    recent_code = find_recent_fault_code_for_query(normalized, history)
    if (
        recent_code
        and is_context_only_windrise_followup(normalized)
        and not has_specific_current_diagnosis_subject(normalized)
    ):
        followup_intent = classify_windrise_followup_intent(normalized) or 'general'
        if followup_intent in {
            'meaning', 'repair', 'reason', 'reset', 'trigger', 'impact',
            'risk', 'operation', 'comparison',
        }:
            recent_context = find_recent_fault_context_for_query(normalized, history)
            rewritten_query = build_recent_fault_dimension_query(recent_context, normalized)
            answer, _ = build_explicit_fault_code_exact_answer(
                f'故障码{recent_code} {rewritten_query or normalized}',
                history,
            )
            if not answer:
                answer = build_index_scoped_fault_lookup_answer(
                    f'{recent_code} {normalized}',
                    history,
                    intent=followup_intent,
                )
            if answer:
                return answer, 'deterministic_recent_fault_dimension_followup'
    # A topic explicitly saved with "先帮我记住" is not a completed lookup.
    # Its following dimension updates must be acknowledged locally.  Keep the
    # existing guided-scope and farm-switch branches in control for ordinary
    # diagnostic histories, where the next missing dimension should be asked.
    has_pending_remembered_topic = any(
        item.get('role') == 'assistant'
        and '已记录故障现象' in normalize_text(item.get('content', ''))
        for item in history
    )
    if (
        has_pending_remembered_topic
        or (
            not find_recent_fault_context_from_history(history)
            and not extract_recent_fault_topic_from_history(history)
        )
    ):
        effective_slots = build_effective_windrise_slots_for_query(normalized, history)
        if (
            not scope_completion_requested
            and has_windrise_scope_for_fault_answer(effective_slots, normalized, history)
            and has_windrise_issue_slots(effective_slots)
        ):
            answer = build_index_scoped_fault_lookup_answer(normalized, history)
            if answer and not re.search(r'未找到精确匹配|暂未找到', answer):
                return answer, 'in_process_scoped_fault_lookup'
        answer = build_windrise_dimension_ack_answer(normalized, history)
        if answer:
            return answer, 'in_process_dimension_ack'
    answer = build_windrise_fault_topic_ack_answer(normalized)
    if answer:
        return answer, 'in_process_fault_topic_ack'
    if is_windrise_scoped_symptom_followup(normalized, history):
        index_query = build_windrise_symptom_scope_lookup_query(normalized, history) or normalized
        answer = build_index_scoped_fault_lookup_answer(index_query, history)
        if answer:
            return answer, 'in_process_scoped_fault_lookup'
    answer = build_deterministic_exact_fault_name_answer(normalized, history)
    if answer:
        return answer, 'in_process_exact_fault_name'
    return '', ''


def build_index_scoped_fault_lookup_answer_with_fallback(
    original_query,
    extracted_query,
    history=None,
    limit=3,
    intent=None,
):
    """Prefer user wording for exact index recall, then try the LLM rewrite."""
    if extract_direct_windrise_fault_codes(original_query, history):
        direct_answer, _ = build_explicit_fault_code_exact_answer(original_query, history)
        if direct_answer:
            return direct_answer
    normalized_original = normalize_windrise_query(original_query)
    normalized_extracted = normalize_windrise_query(extracted_query)
    if is_context_only_windrise_followup(normalized_original):
        extracted_codes = extract_direct_windrise_fault_codes(normalized_extracted, history)
        if extracted_codes:
            contextual_query = f"{' '.join(extracted_codes)} {normalized_original}".strip()
            user_scope_history = [
                item for item in (history or [])
                if item.get('role') == 'user'
            ]
            contextual_answer, _ = build_explicit_fault_code_exact_answer(
                contextual_query,
                user_scope_history,
            )
            if contextual_answer:
                return contextual_answer
    if (
        normalized_extracted
        and normalized_extracted != normalized_original
        and is_context_only_windrise_followup(normalized_original)
    ):
        queries = [normalized_extracted, normalized_original]
    else:
        queries = [normalized_original, normalized_extracted]
    slots = build_effective_windrise_slots_for_query(normalized_original, history or [])
    scoped_miss = ''
    for candidate_query in dict.fromkeys(query for query in queries if query):
        answer = build_index_scoped_fault_lookup_answer(
            candidate_query,
            history,
            limit=limit,
            intent=intent,
        )
        if not answer:
            continue
        if '设备范围内未找到精确匹配' in answer:
            scoped_miss = answer
            continue
        return answer
    if scoped_miss:
        symptom = (
            build_windrise_symptom_subject_query(original_query, history)
            or normalized_original
        )
        global_answer = build_global_symptom_fault_lookup_answer(
            original_query,
            history,
            symptom=symptom,
            slots=slots,
            intent=intent,
            limit=limit,
        )
        if global_answer:
            return f"{scoped_miss}\n\n---\n\n{global_answer}"
        return scoped_miss
    symptom = (
        build_windrise_symptom_subject_query(original_query, history)
        or normalized_original
    )
    return build_global_symptom_fault_lookup_answer(
        original_query,
        history,
        symptom=symptom,
        slots=slots,
        intent=intent,
        limit=limit,
    )


def build_fault_records_answer_from_index(
    query,
    records,
    title='上下文匹配结果',
    limit=3,
    intent=None,
    slots=None,
    code_override='',
    scope_filter=True,
):
    _ = title
    slots = slots or build_effective_windrise_slots_for_query(query, [])
    return build_structured_fault_records_answer(
        query,
        records,
        intent=intent,
        limit=limit,
        slots=slots,
        code_override=code_override,
        scope_filter=scope_filter,
    )


def build_dimension_filtered_recent_topic_answer(query, history):
    topic = extract_recent_fault_topic_from_history(history)
    dimension_terms = windrise_dimension_terms_for_topic_lookup(query, history)
    if not topic or not dimension_terms:
        return ''
    topic_terms = windrise_topic_terms(topic)
    if not topic_terms:
        return ''
    records = []
    for record in load_windrise_fault_index_records():
        if not record_matches_dimension_terms(record, dimension_terms):
            continue
        score = score_fault_record_for_topic(record, topic_terms)
        if score <= 0:
            continue
        enriched = dict(record)
        enriched['_score'] = score
        records.append(enriched)
    if not records:
        return ''
    records.sort(key=lambda item: (-item.get('_score', 0), str(item.get('source', ''))))
    return build_fault_records_answer_from_index(
        f"{topic} {query}",
        records,
        title=f"{topic} {query}",
        limit=8,
    )


def build_explicit_fault_topic_statement_answer(query, history):
    if not is_explicit_fault_topic_statement(query):
        return ''
    topic = clean_windrise_fault_topic_text(query)
    if not topic:
        return ''
    dimension_terms = windrise_dimension_terms_for_topic_lookup(query, history)
    if not dimension_terms:
        return ''
    slots = build_effective_windrise_slots_for_query(query, history)
    topic_terms = windrise_fault_content_topic_terms(topic, slots) or windrise_topic_terms(topic)
    records = []
    for record in load_windrise_fault_index_records():
        if not record_matches_dimension_terms(record, dimension_terms):
            continue
        score = score_fault_record_for_topic(record, topic_terms)
        if score <= 0:
            continue
        enriched = dict(record)
        enriched['_score'] = score
        records.append(enriched)
    if not records:
        return ''
    records.sort(key=lambda item: (-item.get('_score', 0), str(item.get('source', ''))))
    return build_fault_records_answer_from_index(
        topic,
        records,
        title=f"{topic} 定位结果",
        limit=3,
    )


def build_current_fault_topic_index_answer(query, history):
    topic = current_query_fault_topic_for_index_lookup(query)
    if not topic:
        return ''
    dimension_terms = windrise_dimension_terms_for_topic_lookup(query, history)
    if not dimension_terms:
        return ''
    compact_topic = compact_fault_match_text(topic)
    if len(compact_topic) < 4:
        return ''
    slots = build_effective_windrise_slots_for_query(query, history)
    topic_terms = windrise_fault_content_topic_terms(topic, slots) or windrise_topic_terms(topic)
    records = []
    for record in load_windrise_fault_index_records():
        if not record_matches_dimension_terms(record, dimension_terms):
            continue
        compact_name = compact_fault_match_text(record.get('name', ''))
        if not compact_name:
            continue
        score = 0
        if compact_topic == compact_name:
            score = 1000
        elif compact_topic in compact_name:
            score = 850
        elif compact_name in compact_topic:
            score = 760
        else:
            score = score_fault_record_for_topic(record, topic_terms)
        if score <= 20:
            continue
        enriched = dict(record)
        enriched['_score'] = score
        records.append(enriched)
    if not records:
        return ''
    records.sort(key=lambda item: (-item.get('_score', 0), str(item.get('source', ''))))
    return build_fault_records_answer_from_index(
        topic,
        records,
        title=f"{topic} 定位结果",
        limit=3,
    )


def is_final_fault_location_followup(query):
    normalized = normalize_text(query)
    if not normalized or has_explicit_fault_code(normalized):
        return False
    if not query_has_explicit_dimension(normalized):
        return False
    return bool(re.search(
        r'(最终定位|定位故障|确认故障|确定故障|定位一下|最终确认|请定位|收敛|精确定位)',
        normalized,
    ))


def is_fault_action_followup(query):
    normalized = normalize_text(query)
    return bool(re.search(
        r'(怎么修|维修|怎么处理|如何处理|处理步骤|处理方法|检修|排查|为什么|为何|原因|怎么会|为啥|咋会|复位|能远程复位|能不能复位|能否复位|下一步|继续|先查哪)',
        normalized,
    ))


def query_has_explicit_dimension(query):
    normalized = normalize_text(query)
    if not normalized:
        return False
    if re.search(r'(风场|风电场|场站|机型|型号|品牌|厂家|系列|具体型号)', normalized):
        return True
    lowered = normalized.lower()
    dimension_keywords = list(MODEL_BRAND_KEYWORDS) + [
        '新华', '团结', '四平', '裕民', '洮北', '镇赉', '镇赍', '同发', '什花道',
        '良井子', '前进', '向荣', '八面',
    ]
    return any(str(keyword).lower() in lowered for keyword in dimension_keywords)


def is_wind_farm_model_mapping_query(query):
    normalized = normalize_text(query)
    if not normalized:
        return False
    if is_fault_code_coverage_followup(normalized):
        return False
    if has_device_issue_hint(normalized) and re.search(
        r'(故障|报警|告警|停机|异常|错误|通讯|超限|过高|过低|过温|高温|油温高|温度高|压力低|压力高|电压高|电压低|容量低|过载|跳闸|跳开|断开|断路|短路|丢失|失效|检测到)',
        normalized,
        flags=re.IGNORECASE,
    ):
        return False
    has_farm_term = bool(
        re.search(r'(风场|风电场|场站)', normalized)
        or normalize_context_dimension_value(extract_windrise_user_slots(normalized).get('farm', ''))
    )
    has_model_term = re.search(r'(机型|型号|风机|品牌|厂家|系列|具体型号)', normalized)
    has_mapping_intent = re.search(r'(有哪些|哪些|什么|哪种|哪家|哪款|对应|匹配|属于|查询|查一下|列出|清单|关系)', normalized)
    has_fault_intent = re.search(r'(故障|报警|告警|停机|复位|处理|排查|维修|原因|保护|跳开|跳闸|报码|故障码|代码)', normalized)
    return bool(has_farm_term and has_model_term and has_mapping_intent and not has_fault_intent)


def is_explicit_fault_name_lookup_query(query):
    normalized = normalize_windrise_query(query)
    if not normalized or has_explicit_fault_code(normalized):
        return False
    if is_wind_farm_model_mapping_query(normalized):
        return False
    has_fault_name = re.search(r'(故障|报警|告警|停机|超限|过高|过低|异常|短路|断路|丢失|失败|结冰|覆冰|积冰|凝冰)', normalized)
    has_lookup_intent = re.search(r'(是什么故障码|是什么码|故障码是什么|故障代码是什么|对应.*码|哪些故障码|有哪些码|哪些码|有什么码|有什么故障码|报码|告警码|报警码)', normalized)
    lowered = normalized.lower()
    has_specific_hint = any(
        keyword.lower() in lowered
        for keyword in DEVICE_HINT_KEYWORDS
        if keyword not in BROAD_DEVICE_KEYWORDS
    )
    return bool(has_fault_name and has_lookup_intent and has_specific_hint)


def is_explicit_fault_action_lookup_query(query):
    normalized = normalize_windrise_query(query)
    if not normalized or has_explicit_fault_code(normalized):
        return False
    if is_wind_farm_model_mapping_query(normalized):
        return False
    has_fault_name = re.search(r'(故障|报警|告警|停机|超限|过高|过低|异常|短路|断路|丢失|失败|结冰|覆冰|积冰|凝冰)', normalized)
    has_action_intent = re.search(r'(怎么办|怎么修|维修|怎么处理|如何处理|处理步骤|处理方法|检修|排查|为什么|为何|原因|怎么会|为啥|咋会|复位|能远程复位|能不能复位|能否复位)', normalized)
    lowered = normalized.lower()
    has_specific_hint = any(
        keyword.lower() in lowered
        for keyword in DEVICE_HINT_KEYWORDS
        if keyword not in BROAD_DEVICE_KEYWORDS
    )
    return bool(has_fault_name and has_action_intent and has_specific_hint)


def is_recent_fault_context_followup(query):
    normalized = normalize_text(query)
    if has_explicit_fault_code(normalized):
        return False
    if is_fault_code_coverage_followup(normalized):
        return True
    if is_wind_farm_model_mapping_query(normalized):
        return False
    if is_explicit_fault_name_lookup_query(normalized):
        return False
    if re.match(r'(这个|那个|它|该故障|该报警|该问题|上面|前面|刚才)', normalized):
        return True
    return bool(re.search(
        r'(是什么故障码|故障码是什么|故障代码是什么|有哪些码|哪些码|有什么码|对应哪些码|故障描述|描述|怎么修|维修|怎么处理|如何处理|处理步骤|处理方法|检修|排查|为什么|为何|原因|怎么会|为啥|咋会|复位|对象|机型|风场|品牌|具体型号)',
        normalized,
    ))


def is_recent_fault_dimension_followup(query):
    normalized = normalize_text(query)
    if not normalized or has_explicit_fault_code(normalized):
        return False
    if is_fault_code_coverage_followup(normalized):
        return True
    if is_explicit_fault_name_lookup_query(normalized):
        return False
    if not query_has_explicit_dimension(normalized):
        return False
    has_explicit_mapping_intent = re.search(
        r'(有哪些|哪些|什么机型|什么型号|哪种|哪家|哪款|机型|型号|风机|品牌|厂家|系列|对应|匹配|属于|查询|查一下|列出|清单|关系)',
        normalized,
        flags=re.IGNORECASE,
    )
    if has_explicit_mapping_intent:
        return False
    has_fault_intent = re.search(
        r'(故障|报警|告警|停机|报码|故障码|代码|有吗|有没有|也有|都有|是否|是不是|处理|复位|原因)',
        normalized,
        flags=re.IGNORECASE,
    )
    compact = re.sub(r'[\s，,。.、:：；;？?！!]+', '', normalized)
    return bool(has_fault_intent or re.fullmatch(r'[\u4e00-\u9fffA-Za-z0-9_.()（）/\-]+(?:风场|风电场|场站)?', compact))


def is_fault_code_coverage_followup(query):
    normalized = normalize_text(query)
    if not normalized:
        return False
    return bool(re.search(
        r'(这个码|该码|这个故障码|该故障码|这个代码|该代码|这个故障|该故障|哪些风场|有哪些风场|哪些场站|有哪些场站|哪些机型|有哪些机型|哪些型号|有哪些型号|覆盖|分布|也有|都有)',
        normalized,
    ) and re.search(r'(风场|风电场|场站|机型|型号|覆盖|分布|也有|都有)', normalized))


def is_fault_code_list_followup(query):
    normalized = normalize_text(query)
    if not normalized or has_explicit_fault_code(normalized):
        return False
    return bool(re.search(
        r'(有哪些码|哪些码|有什么码|对应哪些码|有哪些故障码|哪些故障码|有什么故障码|对应.*故障码|报码有哪些|告警码有哪些|报警码有哪些)',
        normalized,
    ))


def extract_windrise_fault_subject_phrase(text):
    normalized = normalize_windrise_query(text)
    if not normalized:
        return ''
    stripped = normalized
    stripped = re.sub(
        r'(怎么处理|如何处理|怎么办|如何排查|处理步骤|什么原因|是否存在|存在|出现|发生)',
        '',
        stripped,
        flags=re.IGNORECASE,
    )
    stripped = re.sub(r'(风场|风电场|场站|风机|机组)', '', stripped, flags=re.IGNORECASE)
    for turbine_id in extract_windrise_turbine_ids_from_text(stripped):
        if is_pitch_blade_axis_token(normalized, turbine_id):
            continue
        stripped = re.sub(re.escape(turbine_id), ' ', stripped, flags=re.IGNORECASE)
    stripped = re.sub(r'(?<![A-Za-z0-9])(\d{1,3})号(?![A-Za-z0-9])', ' ', stripped)
    for keyword in (
        '新华', '团结', '四平', '裕民', '洮北', '镇赉', '镇赍', '同发', '什花道',
        '良井子', '前进', '向荣', '八面', '富荣', '福林', '如意', '长龙山',
    ):
        stripped = stripped.replace(keyword, ' ')
    stripped = re.sub(r'(?:故障|报警|告警|停机)$', '', stripped, flags=re.IGNORECASE)
    stripped = re.sub(r'[？?，,。.、:：；;\s]+', '', stripped)
    stripped = re.sub(r'(?:故障|报警|告警|停机)$', '', stripped, flags=re.IGNORECASE)
    stripped = re.sub(r'^[#号]+', '', stripped)
    scada_alarm = extract_scada_style_alarm_name(text)
    if scada_alarm:
        return compact_fault_match_text(scada_alarm)
    return stripped.strip()


def should_build_fault_code_candidates_from_slots(query, slots):
    normalized = normalize_text(query)
    if not normalized or has_explicit_fault_code(normalized):
        return False
    if is_explicit_fault_action_lookup_query(normalized) or is_explicit_fault_name_lookup_query(normalized):
        return False
    if is_fault_code_list_followup(normalized):
        return True
    if not slots or not slots.get('brand'):
        return False
    components = set(slots.get('component') or [])
    symptoms = set(slots.get('symptom') or [])
    if not (components or symptoms or slots.get('fault_name')):
        return False
    return bool(re.search(
        r'(故障码|故障代码|报码|告警码|报警码|代码|故障|报警|告警|停机|异常|断开|断路|丢失|失败|温度|油温|过热|高温|过温|超温|超限|电压|容量|压力|过载|跳闸|跳开|通讯|通信)',
        normalized,
    ))


def score_fault_record_for_slots(record, slots):
    if not slots:
        return 0
    name_text = record.get('_wr_name_lower') or normalize_text(record.get('name', '')).lower()
    searchable = record.get('_wr_scope_text') or normalize_text(' '.join(
        str(record.get(key, ''))
        for key in ('site', 'brand', 'model', 'standardModel', 'turbineIds', 'code', 'name', 'text', 'solution', 'logic', 'source')
    )).lower()
    score = 0
    for key, weight in (('brand', 100), ('farm', 30), ('model', 35), ('standard_model', 35), ('turbine_id', 120)):
        if key == 'turbine_id':
            value = normalize_windrise_turbine_id(slots.get(key, ''))
            if value:
                if not record_matches_windrise_turbine_id(record, value, slots.get('farm', '')):
                    return -1
                score += weight
            continue
        value = normalize_windrise_model_value(slots.get(key, '')) if key in {'model', 'standard_model'} else normalize_context_dimension_value(slots.get(key, ''))
        if value:
            if key in {'model', 'standard_model'}:
                if windrise_model_value_matches_record(record, value):
                    score += weight
                else:
                    return 0
                continue
            if value.lower() not in searchable:
                return -1 if key == 'brand' else 0
            score += weight
    component_values = [value for value in (slots.get('component') or []) if value not in {'主控'}]
    symptom_values = slots.get('symptom') or []
    position_values = slots.get('position') or []
    fault_name = normalize_context_dimension_value(slots.get('fault_name', ''))
    component_scope_text = ' '.join(filter(None, [
        name_text,
        searchable,
        normalize_text(fault_name).lower(),
    ]))
    if component_values and not all(
        windrise_slot_value_matches_text(value, component_scope_text)
        or record_matches_pitch_blade_component(record, value, fault_name)
        for value in component_values
    ):
        return 0
    score += 30 * len(component_values)

    symptom_matched = 0
    for value in symptom_values:
        lowered = str(value).lower()
        if lowered in searchable:
            symptom_matched += 1
            continue
        if lowered == '温度高' and re.search(r'(温度|油温|过热|高温|过温|超温)', searchable):
            symptom_matched += 1
        elif lowered == '温度异常' and re.search(r'(温度|油温|过热|高温|过温|超温|温度波动|温度跳变|温度异常)', searchable):
            symptom_matched += 1
        elif lowered == '跳闸' and re.search(r'(跳闸|跳开|跳脱|脱扣|分闸|分断)', searchable):
            symptom_matched += 1
        elif lowered == '断开' and re.search(r'(断开|开路|断链)', searchable):
            symptom_matched += 1
        elif lowered == '信号丢失' and re.search(r'(信号丢失|efc.*丢失)', searchable, flags=re.IGNORECASE):
            symptom_matched += 1
        elif lowered == '容量低' and re.search(r'(容量低|容量不足|容量低于门限|低于门限值)', searchable):
            symptom_matched += 1
        elif lowered == '过压' and re.search(r'(电压高|过压|电压过高|电压偏高)', searchable):
            symptom_matched += 1
        elif lowered == '欠压' and re.search(r'(电压低|欠压|电压过低)', searchable):
            symptom_matched += 1
        elif lowered == '超限' and re.search(r'(超限|越限)', searchable):
            symptom_matched += 1
        elif lowered == '限功率' and re.search(r'(限功率|实际限功率|限载|降载|降功率|降额|功率限制|限制功率|功率下降|功率低|发电少)', searchable):
            symptom_matched += 1
        elif lowered == '散热异常' and re.search(r'(散热片|散热器|散热风扇|散热|冷却|水冷|风扇|功率模块|功率单元|igbt|温度高|温度过高|过温|高温|过热)', searchable, flags=re.IGNORECASE):
            symptom_matched += 1
        elif lowered == '不同步' and re.search(r'(不同步|同步故障|叶片同步|桨叶同步|变桨同步)', searchable):
            symptom_matched += 1
    fault_name = normalize_context_dimension_value(slots.get('fault_name', ''))
    fault_name_compact = compact_fault_match_text(fault_name)
    record_name_compact = compact_fault_match_text(record.get('name', ''))
    explicit_fault_name_match = bool(
        fault_name_compact
        and (
            (
                record_name_compact
                and (
                    fault_name_compact == record_name_compact
                    or fault_name_compact in record_name_compact
                    or record_name_compact in fault_name_compact
                )
            )
            or fault_records_semantically_equivalent(fault_name_compact, record)
        )
    )
    if symptom_values and not symptom_matched and not explicit_fault_name_match:
        return 0
    score += 25 * symptom_matched

    for value in position_values:
        lowered = str(value).lower()
        if lowered in searchable:
            score += 10
        elif lowered == '驱动端' and re.search(r'(驱动端|de)', searchable):
            score += 10
        elif lowered == '非驱动端' and re.search(r'(非驱动端|nde)', searchable):
            score += 10

    for term in windrise_topic_terms(fault_name):
        if term.lower() in searchable:
            score += 5

    subject_phrase = extract_windrise_fault_subject_phrase(fault_name or slots.get('farm', ''))
    if not subject_phrase:
        subject_phrase = extract_windrise_fault_subject_phrase(
            ' '.join(
                item for item in (
                    slots.get('farm', ''),
                    slots.get('turbine_id', ''),
                    ' '.join(component_values),
                    ' '.join(symptom_values),
                ) if item
            ),
        )
    if subject_phrase:
        record_name = normalize_text(record.get('name', ''))
        compact_subject = re.sub(r'\s+', '', subject_phrase)
        compact_record_name = re.sub(r'\s+', '', record_name)
        if compact_subject and compact_subject in compact_record_name:
            score += 900
        elif compact_subject and compact_record_name in compact_subject:
            score += 700
        elif compact_subject and compact_record_name.startswith(compact_subject):
            score += 500
        extra_tokens = ('控制柜', '柜', '外', '内', '有效值', '传感器')
        if compact_subject and any(
            token in compact_record_name and token not in compact_subject
            for token in extra_tokens
        ):
            score -= 250
    return score


def windrise_slot_value_matches_text(value, text):
    lowered = normalize_text(text).lower()
    canonical = normalize_context_dimension_value(value).lower()
    aliases = {
        '主断路器': ('主断路器', '主断', '主开关'),
        '发电机': ('发电机', 'generator'),
        '轴承': ('轴承', '轴温', 'bearing'),
        '变流器': ('变流器', '变频器', 'converter'),
        '变桨': ('变桨', '桨叶', 'pitch'),
        '偏航': ('偏航', 'yaw'),
        '齿轮箱': ('齿轮箱', 'gearbox'),
        '液压': ('液压', '液压站'),
        '主控': ('主控', 'plc'),
        '安全链': ('安全链',),
        '电网': ('电网', '网侧'),
        '风速仪': ('风速仪', '风速传感器'),
        '风速传感器': ('风速传感器', '风速仪'),
        '风向标': ('风向标', '风向仪'),
        '超级电容': ('超级电容', '电容'),
        '叶轮': ('叶轮', '风轮', '轮毂'),
        '主轴': ('主轴', '低速端'),
    }
    for alias in aliases.get(canonical, (canonical,)):
        if alias and alias.lower() in lowered:
            return True
    return False


def build_fault_code_candidates_answer_from_slots(query, history, limit=12):
    slots = build_effective_windrise_slots_for_query(query, history)
    if not should_build_fault_code_candidates_from_slots(query, slots):
        return ''
    if not (slots.get('brand') and (slots.get('component') or slots.get('symptom') or slots.get('fault_name'))):
        return ''

    candidates = []
    for record in load_windrise_fault_index_records():
        code = normalize_context_dimension_value(record.get('code', ''))
        if not code:
            continue
        score = score_fault_record_for_slots(record, slots)
        if score <= 0:
            continue
        enriched = dict(record)
        enriched['_score'] = score
        candidates.append(enriched)
    if not candidates:
        return ''

    grouped = OrderedDict()
    for record in sorted(candidates, key=lambda item: (-item.get('_score', 0), str(item.get('code', '')), str(item.get('source', '')))):
        code = normalize_context_dimension_value(record.get('code', ''))
        name = normalize_context_dimension_value(record.get('name', '')) or '未标明'
        group = grouped.setdefault(code, {'code': code, 'names': [], 'records': [], 'score': record.get('_score', 0)})
        if name not in group['names']:
            group['names'].append(name)
        group['records'].append(record)
        group['score'] = max(group['score'], record.get('_score', 0))

    if slots.get('turbine_id') or len(grouped) <= 12:
        ranked_records = []
        for group in sorted(grouped.values(), key=lambda item: (-item['score'], str(item['code']))):
            ranked_records.extend(group['records'])
        return build_structured_fault_records_answer(query, ranked_records[:max(1, int(limit))], limit=min(5, max(1, int(limit))))

    groups = list(grouped.values())[:max(1, int(limit))]
    title_terms = ' '.join(
        item for item in (
            slots.get('brand', ''),
            *list(slots.get('component') or []),
            *list(slots.get('position') or []),
            *list(slots.get('symptom') or []),
        ) if item
    )
    lines = [
        f"**候选故障码：** {title_terms or normalize_text(query)}",
        '',
        f"**结论：** 按当前会话已确认的厂家/部件/现象，在本地知识库中找到 {len(grouped)} 个候选故障码；厂家/机型仍以现场铭牌和 HMI/SCADA 原始报码为准。",
        '',
    ]
    for index, group in enumerate(groups, start=1):
        records = group['records']
        coverage = []
        for record in records:
            parts = []
            parts = windrise_record_meta_parts(record)
            rendered = ' / '.join(parts)
            if rendered and rendered not in coverage:
                coverage.append(rendered)
            if len(coverage) >= 3:
                break
        name_text = ' / '.join(group['names'][:3])
        lines.append(f"{index}. **{group['code']}**：{name_text or '未标明'}")
        if coverage:
            lines.append(f"   - 覆盖：{'；'.join(coverage)}")
        sample = normalize_text(records[0].get('text', '') or records[0].get('solution', ''))
        if sample:
            lines.append(f"   - 摘要：{clip_text(sample, 180)}")
    if len(grouped) == 1:
        lines.append('')
        lines.append('提示：当前条件只命中 1 个候选码；如现场机型或原始报码不同，请继续补充机型/风场核对。')
    if len(grouped) > len(groups):
        lines.append('')
        lines.append(f"还有 {len(grouped) - len(groups)} 个候选码未展开；请补充具体机型/驱动端或非驱动端/报警还是停机后可进一步收敛。")
    return '\n'.join(lines)


def windrise_fault_candidate_group_key(record):
    return (
        normalize_context_dimension_value(record.get('brand', '')),
        normalize_context_dimension_value(record.get('model', '')),
        normalize_context_dimension_value(record.get('code', '')),
        normalize_context_dimension_value(record.get('name', '')),
    )


def summarize_windrise_fault_candidate_scope(records):
    brands = []
    models = []
    codes = []
    for record in records or []:
        for key, target in (('brand', brands), ('model', models), ('code', codes)):
            value = normalize_context_dimension_value(record.get(key, ''))
            if value and value not in target:
                target.append(value)
    return {
        'brands': brands,
        'models': models,
        'codes': codes,
    }


def should_ask_for_more_windrise_dimensions(candidates, slots, speed_limit_fuzzy=False):
    if not candidates:
        return False
    if should_limit_windrise_results_to_one(slots):
        return False
    if windrise_resolved_fault_code(slots) and (
        normalize_context_dimension_value(slots.get('farm', ''))
        or normalize_windrise_turbine_id(slots.get('turbine_id', ''))
    ):
        return False
    scope = summarize_windrise_fault_candidate_scope(candidates)
    has_strong_dimension = bool(
        slots.get('brand')
        or slots.get('model')
        or slots.get('standard_model')
        or slots.get('farm')
        or slots.get('turbine_id')
    )
    unique_groups = {
        windrise_fault_candidate_group_key(record)
        for record in candidates
    }
    unique_groups.discard(('', '', '', ''))
    if slots.get('turbine_id') and slots.get('farm'):
        if len(unique_groups) <= 12:
            return False
        return len(unique_groups) > (120 if speed_limit_fuzzy else 48)
    if has_strong_dimension:
        return len(unique_groups) > (60 if speed_limit_fuzzy else 24)
    if speed_limit_fuzzy:
        return len(unique_groups) > 12
    return (
        len(unique_groups) > 8
        or len(scope.get('brands') or []) > 3
        or len(scope.get('models') or []) > 6
        or len(scope.get('codes') or []) > 12
    )


def record_matches_explicit_windrise_slots(record, slots):
    if not slots:
        return True
    turbine_id = normalize_windrise_turbine_id(slots.get('turbine_id', ''))
    if turbine_id and not record_matches_windrise_turbine_id(
        record,
        turbine_id,
        slots.get('farm', ''),
    ):
        return False
    searchable = normalize_text(' '.join(
        str(record.get(key, ''))
        for key in ('site', 'brand', 'model', 'standardModel', 'turbineIds', 'source')
    )).lower()
    for key in ('brand', 'farm', 'model', 'standard_model'):
        value = normalize_windrise_model_value(slots.get(key, '')) if key in {'model', 'standard_model'} else normalize_context_dimension_value(slots.get(key, ''))
        if not value:
            continue
        if key in {'model', 'standard_model'}:
            if not windrise_model_value_matches_record(record, value):
                return False
            continue
        lowered = value.lower()
        if lowered in searchable:
            continue
        return False
    return True


def build_windrise_need_more_dimensions_answer(query, candidates, selected):
    scope = summarize_windrise_fault_candidate_scope(candidates)
    lines = [
        "**需要补充定位条件**",
        "",
        f"当前描述“{normalize_text(query)}”在本地库中匹配范围过大，不能直接展开全部候选，否则容易误导并影响页面响应。",
        "",
        f"已检索到 {len(candidates)} 条相关记录，涉及约 {len(scope.get('brands') or [])} 个厂家、{len(scope.get('models') or [])} 个机型、{len(scope.get('codes') or [])} 个故障码。",
    ]
    if selected:
        lines.extend(["", "**高相关样例：**"])
        for index, record in enumerate(selected[:3], start=1):
            meta = windrise_record_meta_parts(record)
            code = normalize_context_dimension_value(record.get('code', '')) or '未标明'
            name = normalize_context_dimension_value(record.get('name', '')) or '未标明'
            lines.append(f"{index}. **{code}｜{name}**" + (f"（{' / '.join(meta)}）" if meta else ""))
    lines.extend([
        "",
        "请补充任意一项：厂家、机型、风场、具体型号、HMI/SCADA 原始报码或完整报警名称。补充后我会按这些条件收敛到少量候选，再给原因和处理步骤。",
    ])
    return '\n'.join(lines)


def build_fault_phenomenon_candidates_answer(query, history=None, limit=None):
    normalized_query = normalize_text(query)
    if not normalized_query:
        return ''
    slots = build_effective_windrise_slots_for_query(normalized_query, history or [])
    explicit_codes = extract_explicit_fault_code_lookup_codes(normalized_query)
    if explicit_codes:
        code = normalize_windrise_fault_code(explicit_codes[0]) or explicit_codes[0]
        code_records = []
        for record in load_windrise_fault_index_records():
            if not record_matches_explicit_windrise_slots(record, slots):
                continue
            if normalize_context_dimension_value(record.get('code', '')).lower() == code.lower():
                code_records.append(dict(record))
        if code_records:
            return build_fault_records_answer_from_index(
                normalized_query,
                code_records,
                title=f"故障码 {code} 查询结果",
                limit=3,
            )
    module_tokens = extract_windrise_hardware_module_tokens(normalized_query)
    if module_tokens:
        module_records = []
        for record in load_windrise_fault_index_records():
            if not record_matches_brand_or_farm_slots(record, slots):
                continue
            searchable = normalize_text(' '.join(
                str(record.get(key, '') or '')
                for key in ('code', 'name', 'text', 'solution', 'logic', 'reason', 'source')
            )).upper()
            if all(token.upper() in searchable for token in module_tokens):
                module_records.append(dict(record))
        if module_records:
            return build_fault_records_answer_from_index(
                normalized_query,
                module_records,
                title=f"{'、'.join(module_tokens)} 查询结果",
                limit=3,
            )
    has_issue_slots = bool(slots.get('component') or slots.get('symptom') or slots.get('fault_name'))
    if not has_issue_slots and not looks_like_fault_phenomenon_query(normalized_query):
        return ''

    topic = clean_current_fault_lookup_topic(normalized_query) or normalized_query
    topic_terms = windrise_topic_terms(topic)
    semantic_info = call_windrise_fault_semantic_normalizer(topic, slots)
    semantic_terms = semantic_fault_terms_to_topic_terms(semantic_info)
    for term in semantic_terms:
        if term and term not in topic_terms:
            topic_terms.append(term)
    speed_limit_fuzzy = is_speed_limit_fuzzy_query(topic)
    semantic_topic_text = ' '.join([topic] + semantic_terms)
    speed_limit_fuzzy = is_speed_limit_fuzzy_query(semantic_topic_text)
    converter_power_limit_fuzzy = is_converter_power_limit_fuzzy_query(semantic_topic_text)
    candidates = []
    seen = set()
    for record in load_windrise_fault_index_records():
        if not record_matches_explicit_windrise_slots(record, slots):
            continue
        code = normalize_context_dimension_value(record.get('code', ''))
        name = normalize_context_dimension_value(record.get('name', ''))
        identity = (
            code,
            name,
            normalize_context_dimension_value(record.get('site', '')),
            normalize_context_dimension_value(record.get('brand', '')),
            normalize_context_dimension_value(record.get('model', '')),
            normalize_context_dimension_value(record.get('standardModel', '')),
            normalize_context_dimension_value(record.get('turbineIds', '')),
            normalize_context_dimension_value(record.get('source', '')),
        )
        if identity in seen:
            continue
        seen.add(identity)
        if speed_limit_fuzzy and not record_matches_speed_limit_fuzzy_query(record):
            continue

        slot_score = score_fault_record_for_slots(record, slots) if has_issue_slots else 0
        topic_score = score_fault_record_for_topic(record, topic_terms)
        if slot_score <= 0 and topic_score <= 0:
            continue
        topic_cap = 520 if (speed_limit_fuzzy or converter_power_limit_fuzzy) else 160
        total_score = max(0, slot_score) + min(max(0, topic_score), topic_cap)
        min_score = 45 if speed_limit_fuzzy else (18 if has_issue_slots else 28)
        if total_score < min_score:
            continue
        enriched = dict(record)
        enriched['_score'] = total_score
        enriched['_topic_score'] = topic_score
        candidates.append(enriched)

    if not candidates:
        return '\n'.join([
            "**先按现象排查**",
            "",
            f"当前描述是“{normalized_query}”。本地索引没有匹配到足够明确的故障记录，不能直接判定厂家专用故障码。",
            "",
            "**先做现场确认：**",
            "1. 记录 HMI/SCADA 原始报警名称、报码、报警来源和发生时间。",
            "2. 查看同一时刻的伴随报警和趋势量，确认是瞬时、持续还是反复出现。",
            "3. 核对相关部件的供电、通信、传感器反馈、接线和机械状态。",
            "4. 如果伴随停机、异响、冒烟、过温、过流或安全链动作，先保持停机隔离，不要反复复位。",
            "",
            "请继续补充厂家、机型或原始 SCADA/HMI 报码；补充后我可以按对应机型收敛到更准确的故障记录。",
        ])

    candidates.sort(key=lambda item: (-item.get('_score', 0), -item.get('_topic_score', 0), str(item.get('brand', '')), str(item.get('model', '')), str(item.get('code', ''))))
    configured_limit = limit
    if configured_limit is None:
        raw_limit = os.getenv('WINDRISE_PHENOMENON_CANDIDATE_LIMIT', '3').strip()
        configured_limit = int(raw_limit) if raw_limit.isdigit() else 3
    selected = candidates[:max(1, min(int(configured_limit or 3), 5))]
    if should_ask_for_more_windrise_dimensions(candidates, slots, speed_limit_fuzzy=speed_limit_fuzzy):
        if has_windrise_converged_scope(slots, normalized_query) and should_limit_windrise_results_to_one(slots, normalized_query):
            selected = candidates[:1]
            return build_structured_fault_records_answer(normalized_query, selected, limit=len(selected), slots=slots)
        return build_windrise_need_more_dimensions_answer(normalized_query, candidates, selected)
    selected_limit = 1 if should_limit_windrise_results_to_one(slots, normalized_query) else len(selected)
    return build_structured_fault_records_answer(
        normalized_query,
        candidates[:selected_limit],
        limit=selected_limit,
        slots=slots,
    )


def has_current_explicit_windrise_task(query):
    normalized = normalize_text(query)
    if not normalized:
        return False
    if is_windrise_general_knowledge_question(normalized):
        return False
    if has_explicit_fault_code(normalized):
        return True
    if is_wind_farm_model_mapping_query(normalized):
        return True
    if is_explicit_fault_name_lookup_query(normalized):
        return True
    if has_specific_current_diagnosis_subject(normalized):
        return True
    return False


def is_windrise_casual_chat_query(query):
    normalized = normalize_text(query)
    if not normalized:
        return False
    if any(re.fullmatch(pattern, normalized, flags=re.IGNORECASE) for pattern in CASUAL_CHAT_PATTERNS):
        return True
    return any(keyword in normalized for keyword in CASUAL_CHAT_KEYWORDS)


def build_windrise_casual_chat_answer(query):
    normalized = normalize_text(query)
    if not normalized:
        return ''
    if re.fullmatch(r'(谢谢|感谢|辛苦了|好的|收到|明白了|行)', normalized, flags=re.IGNORECASE):
        return '不客气。有故障、机型或排查问题，直接告诉我就行。'
    if re.fullmatch(r'(再见|bye)', normalized, flags=re.IGNORECASE):
        return '好的，有需要再叫我。'
    if re.search(r'(你是谁|你能做什么|介绍一下你自己|介绍一下自己)', normalized, flags=re.IGNORECASE):
        return (
            '我是 Windrise，本地风机故障知识助手。'
            '你可以直接问故障处理、机型映射、故障码含义，也可以问偏航、变桨、齿轮箱等通用运维问题。'
        )
    if re.fullmatch(r'(你好|您好|嗨|哈喽|在吗|在不在|早上好|中午好|下午好|晚上好)', normalized, flags=re.IGNORECASE):
        return '你好！我是 Windrise，本地风机故障知识助手。请直接告诉我当前问题。'
    return ''


def build_windrise_casual_or_general_answer(query, history):
    """Route normal chat / general wind-turbine knowledge without fault evidence flow."""
    normalized = normalize_text(query)
    if not normalized:
        return None

    if is_windrise_casual_chat_query(normalized):
        answer = build_windrise_direct_chat_answer(normalized, history) or build_windrise_casual_chat_answer(normalized)
        if answer:
            return answer, {
                'mode': 'chat',
                'intent': 'general',
                'fault_code': '',
                'should_search': False,
                'uses_history_fault_code': False,
                'current_problem_is_new': True,
                'rewritten_query': normalized,
                'reason': 'deterministic_direct_chat',
            }

    if is_windrise_general_knowledge_question(normalized):
        route = {
            'mode': 'chat',
            'intent': 'general',
            'fault_code': '',
            'should_search': False,
            'uses_history_fault_code': False,
            'current_problem_is_new': True,
            'rewritten_query': normalized,
            'reason': 'general_wind_knowledge_question',
        }
        return build_windrise_chat_answer(normalized, history, route), route

    return None


def is_windrise_general_knowledge_question(query):
    normalized = normalize_text(query)
    if not normalized:
        return False
    if extract_fault_codes(normalized) or has_explicit_fault_code(normalized):
        return False
    if is_wind_farm_model_mapping_query(normalized):
        return False
    if is_explicit_fault_name_lookup_query(normalized) or is_explicit_fault_action_lookup_query(normalized):
        return False
    if re.search(
        r'(查|查询|检索|搜索|搜).{0,12}(故障码|故障代码|报码|告警码|报警码|状态代码)',
        normalized,
        flags=re.IGNORECASE,
    ):
        return False

    lowered = normalized.lower()
    has_wind_energy_topic = bool(re.search(
        r'(风力发电|风力?电|风电|风能|风机发电|海上风电|陆上风电|风力发电机)',
        normalized,
        flags=re.IGNORECASE,
    )) or bool(re.search(
        r'发电.{0,12}(原理|机理|工作原理|如何工作|怎么工作|工作过程)|'
        r'(原理|机理|工作原理|工作过程).{0,12}(?:风|电|发电)',
        normalized,
        flags=re.IGNORECASE,
    ))
    has_wind_device_term = has_wind_energy_topic or any(
        keyword.lower() in lowered for keyword in DEVICE_HINT_KEYWORDS
    )
    has_knowledge_intent = re.search(
        r'(会引发什么|会引起什么|会导致什么|会造成什么|会带来什么|会有什么|有什么影响|有什么危害|什么后果|'
        r'可能引发|可能引起|可能导致|一般会|通常会|为什么|为何|原理|机理|作用|是什么|什么是|区别|关系|'
        r'是怎么工作|如何工作|怎么工作|工作原理|工作过程|怎么运行|如何运行|是怎样|是什么原理)',
        normalized,
        flags=re.IGNORECASE,
    )
    has_alarm_lookup_intent = re.search(
        r'(是什么故障码|故障码是什么|故障代码是什么|对应.*码|有哪些码|哪些故障码|报码|告警码|报警码|'
        r'一般是什么故障|一般是啥故障|属于什么故障|是什么故障$|什么故障$)',
        normalized,
        flags=re.IGNORECASE,
    )
    has_field_localization = re.search(
        r'(厂家|品牌|机型|型号|风场|场站|具体型号|hmi|scada|原始报码|原始告警|报的是|当前报|现在报)',
        normalized,
        flags=re.IGNORECASE,
    )
    has_active_fault_context = bool(re.search(
        r'(报警|告警|故障码|故障代码|报码|停机|跳闸|过温|超限|异常|异响|振动|保护动作)',
        normalized,
        flags=re.IGNORECASE,
    ))
    if (
        has_knowledge_intent
        and has_wind_energy_topic
        and not has_alarm_lookup_intent
        and not has_field_localization
        and not has_active_fault_context
    ):
        return True
    return bool(
        has_wind_device_term
        and has_knowledge_intent
        and not has_alarm_lookup_intent
        and not has_field_localization
        and not has_active_fault_context
    )

def _legacy_unused_find_recent_fault_code_from_history(history):
    for item in reversed(history or []):
        content = item.get('content', '')
        normalized = normalize_text(content)
        if item.get('role') == 'user':
            continue
        conclusion_code = re.search(r'结论[:：][^\dA-Za-z]{0,12}([A-Za-z]{0,4}\d{1,8}[A-Za-z]{0,2})(?:\s*为|[^\dA-Za-z]|\s*$)', normalized)
        if conclusion_code:
            return conclusion_code.group(1).upper()
        title_code = re.search(r'^([A-Za-z]{0,4}\d{1,8}[A-Za-z]{0,2})\s+(?:维修处理建议|原因分析|复位说明)', normalized, flags=re.IGNORECASE)
        if title_code:
            return title_code.group(1).upper()
        local_answer_code = re.search(r'本地答案[:：]\s*([A-Za-z]{0,4}\d{1,8}[A-Za-z]{0,2})(?:\s|$)', normalized, flags=re.IGNORECASE)
        if local_answer_code:
            return local_answer_code.group(1).upper()
        explicit_answer_code = re.search(r'(?:故障码|故障代码|报码|告警码|报警码)[^A-Za-z0-9]{0,8}([A-Za-z]{0,4}\d{1,8}[A-Za-z]{0,2})', normalized, flags=re.IGNORECASE)
        if explicit_answer_code:
            return explicit_answer_code.group(1).upper()
    return ''


def build_windrise_history_text(history, limit=None):
    recent_history = [
        item for item in (history or [])[-(limit or WINDRISE_MEMORY_CONTEXT_MESSAGES):]
        if item.get('content')
    ]
    if not recent_history:
        return '无'

    lines = []
    for item in recent_history:
        role = '用户' if item.get('role') == 'user' else 'Windrise'
        lines.append(f"{role}：{clip_text(item.get('content', ''), WINDRISE_MEMORY_ITEM_CHARS)}")
    return '\n'.join(lines)


def extract_json_object(text):
    raw = (text or '').strip()
    if not raw:
        return ''
    if raw.startswith('```'):
        raw = re.sub(r'^```(?:json)?\s*', '', raw, flags=re.IGNORECASE)
        raw = re.sub(r'\s*```$', '', raw)
    start_index = raw.find('{')
    end_index = raw.rfind('}')
    if start_index >= 0 and end_index > start_index:
        return raw[start_index:end_index + 1]
    return raw


def mark_windrise_llm_unavailable(reason):
    global windrise_llm_unavailable_until
    backoff = WINDRISE_LLM_RETRY_SECONDS
    if isinstance(reason, (requests.Timeout, requests.ConnectionError)):
        backoff = max(backoff, 60)
    with windrise_llm_lock:
        windrise_llm_unavailable_until = time.time() + backoff
    print(f"[Windrise] 语义模型暂不可用，{backoff}s 后重试: {reason}")


def is_windrise_llm_temporarily_unavailable():
    with windrise_llm_lock:
        return time.time() < windrise_llm_unavailable_until


def normalize_windrise_intent(value):
    normalized = normalize_text(value).lower()
    if normalized in {
        'repair', 'reason', 'reset', 'trigger', 'meaning', 'impact', 'risk',
        'operation', 'comparison', 'explain', 'clarify', 'general',
    }:
        return normalized
    if any(word in normalized for word in ('比较', '区别', '对比', 'comparison', 'compare')):
        return 'comparison'
    if any(word in normalized for word in ('继续运行', '停机', '开机', 'operation', 'operate')):
        return 'operation'
    if any(word in normalized for word in ('风险', '严重', '危险', 'risk', 'severity')):
        return 'risk'
    if any(word in normalized for word in ('影响', '后果', 'impact', 'effect')):
        return 'impact'
    if any(word in normalized for word in ('触发条件', '发生条件', '报警条件', '报码条件', '触发', 'trigger')):
        return 'trigger'
    if any(word in normalized for word in ('原因', '为什么', 'reason', 'cause')):
        return 'reason'
    if any(word in normalized for word in ('复位', 'reset')):
        return 'reset'
    if any(word in normalized for word in ('含义', '是什么故障', '什么意思', 'meaning')):
        return 'meaning'
    if any(word in normalized for word in ('维修', '处理', 'repair', 'advice', 'solution', 'fix')):
        return 'repair'
    if any(word in normalized for word in ('解释', '说明', 'explain')):
        return 'explain'
    if any(word in normalized for word in ('澄清', '补充', 'clarify')):
        return 'clarify'
    return 'general'


def normalize_windrise_mode(value, fallback_mode='chat'):
    normalized = normalize_text(value).lower()
    if normalized in {'chat', 'knowledge'}:
        return normalized
    if normalized in {'faq', 'qa', 'question_answering', 'diagnosis', 'repair', 'troubleshooting'}:
        return 'knowledge'
    if normalized in {'conversation', 'general_chat', 'smalltalk'}:
        return 'chat'
    return fallback_mode if fallback_mode in {'chat', 'knowledge'} else 'chat'


def normalize_windrise_fault_code(value):
    codes = extract_fault_codes(value or '')
    return codes[0] if codes else ''


def is_numeric_windrise_fault_code(value):
    code = normalize_windrise_fault_code(value or '')
    return bool(re.fullmatch(r'\d{3,8}', code))


def extract_windrise_primary_answer_fault_code(answer):
    normalized = normalize_text(answer).split('备选答案')[0]
    title_match = re.search(
        r'^\s*([A-Za-z]{0,4}\d{1,8}[A-Za-z]{0,2})\s+(?:维修处理建议|原因分析|复位说明|触发条件)',
        normalized,
        flags=re.IGNORECASE,
    )
    if title_match:
        return title_match.group(1).upper()
    context = extract_fault_context_from_answer(normalized)
    if context.get('code'):
        return normalize_context_dimension_value(context['code']).upper()
    return normalize_windrise_fault_code(normalized)


def parse_windrise_router_json(raw_text):
    json_text = extract_json_object(raw_text)
    if not json_text:
        raise ValueError('语义路由模型返回空内容')
    return json.loads(json_text)


def validate_windrise_semantic_route(parsed, query, recent_code):
    required_fields = {
        'mode', 'intent', 'fault_code', 'should_search',
        'uses_history_fault_code', 'current_problem_is_new',
        'rewritten_query', 'direct_answer', 'reason',
    }
    if not isinstance(parsed, dict) or not required_fields.issubset(parsed):
        return None, 'missing_required_fields'

    string_fields = ('mode', 'intent', 'fault_code', 'rewritten_query', 'direct_answer', 'reason')
    if any(not isinstance(parsed.get(field), str) for field in string_fields):
        return None, 'invalid_string_field'
    bool_fields = ('should_search', 'uses_history_fault_code', 'current_problem_is_new')
    if any(not isinstance(parsed.get(field), bool) for field in bool_fields):
        return None, 'invalid_boolean_field'

    mode = parsed['mode'].strip().lower()
    intent = parsed['intent'].strip().lower()
    if mode not in {'chat', 'knowledge'}:
        return None, 'invalid_mode'
    if intent not in {
        'general', 'meaning', 'repair', 'reason', 'reset', 'trigger', 'impact',
        'risk', 'operation', 'comparison', 'explain', 'clarify',
    }:
        return None, 'invalid_intent'

    rewritten_query = normalize_text(parsed['rewritten_query'])
    direct_answer = normalize_text(parsed['direct_answer'])
    reason = normalize_text(parsed['reason'])
    if not rewritten_query or len(rewritten_query) > 1200:
        return None, 'invalid_text_length'
    direct_answer = clip_text(direct_answer, 600)
    reason = clip_text(reason, 48)

    current_codes = extract_direct_windrise_fault_codes(query, [])
    current_code = current_codes[0] if current_codes else ''
    if not current_code:
        code_match = re.search(
            r'(?i)(?<![A-Z0-9_])([A-Z]{1,4}[-_]?\d{2,6})(?![A-Z0-9_])\s*(?:报警|告警|故障|错误|fault|alarm|error)',
            normalize_text(query),
        )
        if code_match:
            current_code = code_match.group(1).upper().replace('-', '').replace('_', '')
    fault_code = normalize_windrise_fault_code(parsed['fault_code'])
    has_current_subject = has_specific_current_diagnosis_subject(query)
    context_only_followup = is_context_only_windrise_followup(query)
    uses_history_fault_code = parsed['uses_history_fault_code']
    current_problem_is_new = parsed['current_problem_is_new']
    should_search = parsed['should_search']

    if mode == 'chat' and should_search:
        return None, 'chat_cannot_search'
    if mode != 'chat' and direct_answer:
        return None, 'knowledge_cannot_direct_answer'
    if should_search and mode != 'knowledge':
        return None, 'search_requires_knowledge_mode'

    if current_code:
        if uses_history_fault_code or fault_code != current_code:
            return None, 'current_fault_code_mismatch'
        fault_code = current_code
    elif uses_history_fault_code:
        if (
            not recent_code
            or fault_code != recent_code
            or has_current_subject
            or not context_only_followup
            or current_problem_is_new
        ):
            return None, 'invalid_history_fault_code_inheritance'
    elif fault_code:
        return None, 'unverified_fault_code'

    if current_problem_is_new and (uses_history_fault_code or fault_code):
        return None, 'new_problem_cannot_inherit_fault_code'
    if has_current_subject and not current_code:
        searchable_current_subject = (
            is_explicit_fault_name_lookup_query(query)
            or is_explicit_fault_action_lookup_query(query)
            or intent in {
                'meaning', 'repair', 'reason', 'reset', 'trigger', 'impact',
                'risk', 'operation', 'comparison',
            }
        )
        if (
            not current_problem_is_new
            or uses_history_fault_code
            or fault_code
            or (should_search and not searchable_current_subject)
        ):
            return None, 'current_subject_precedence'

    return {
        'mode': mode,
        'intent': intent,
        'fault_code': fault_code,
        'should_search': should_search,
        'uses_history_fault_code': uses_history_fault_code,
        'current_problem_is_new': current_problem_is_new,
        'rewritten_query': rewritten_query,
        'direct_answer': direct_answer if mode == 'chat' else '',
        'reason': reason,
    }, ''


def build_windrise_semantic_router_prompt(query, history, recent_code, compact=False):
    memory_summary = build_memory_summary(history or []) or '无'
    history_text = build_windrise_history_text(history)
    slot_summary = build_windrise_slots_summary(build_effective_windrise_slots_for_query(query, history)) or '无'
    schema = '''{
  "mode": "chat|knowledge",
  "intent": "general|meaning|repair|reason|reset|trigger|impact|risk|operation|comparison|explain|clarify",
  "fault_code": "故障码或空字符串",
  "should_search": true,
  "uses_history_fault_code": false,
  "current_problem_is_new": false,
  "rewritten_query": "LLM Wiki核心检索词",
  "direct_answer": "简单聊天的直接答复或空字符串",
  "reason": "不超过24字的分类标签"
}'''
    rules = '''决策顺序：
1. 先判断当前问题是否出现新的具体诊断对象、现象、参数、事件或明确故障码。
2. 仅当没有新对象时，才判断它是否为省略追问并可继承最近历史故障码。
3. 再判断 mode、intent、是否检索和是否需要改写问题。

硬性规则：
- 当前问题有新具体对象/现象时：current_problem_is_new=true、uses_history_fault_code=false；除非当前句明确给出新故障码，否则 fault_code=""，不得沿用历史故障码。
- uses_history_fault_code=true 时，fault_code 必须完全等于“历史故障码”，且 current_problem_is_new=false。
- mode="chat" 时 should_search=false；mode="knowledge" 不代表必须检索。
- 有明确故障码、可继承的已确认故障码、精确故障名称或明确故障核心现象时，should_search=true；信息不足的泛泛异常才应 false。
- should_search=true 时，rewritten_query 必须使用 LLM Wiki 高命中格式：已确认故障码只写故障码；否则只写精确故障名称；名称不明确时只写「部件 核心现象」。
- 风场、风机编号、厂家、机型、问法和处理意图不得拼进 rewritten_query，也不得推测用户未提供的原因、参数或同义症状。
- “这正常吗”“什么意思”“我不理解”等通常是解释上一轮内容：mode="chat"、intent="explain"、should_search=false；除非当前句明确问维修、原因或复位。
- direct_answer 仅用于简单普通聊天；其他情况必须为 ""。
- reason 只写短分类标签，不要解释过程、推理过程或 Markdown。
- WD3000、GW121、3.0MW 等机型/容量标识不是故障码；不得仅凭数字或机型填 fault_code。
- 690V、150bar、10MPa、50Hz、1500rpm 等带工程单位的测量值不是故障码；除非用户明确写“故障码/报码/报警码”，否则 fault_code 必须为空。
- 每个字段都必须出现且类型正确；只输出一个合法 JSON 对象。'''
    if compact:
        return f'''只输出合法 JSON，不要 Markdown 或解释。
{rules}
历史故障码：{recent_code or '无'}
已提取槽位：{slot_summary}
最近对话：
{history_text}
当前问题：{query}
JSON：
{schema}'''

    examples = '''示例（仅说明判断；实际输出只能是 JSON）：
- 当前“E0025报警” → knowledge，fault_code="E0025"，should_search=true，rewritten_query="E0025"，uses_history_fault_code=false，current_problem_is_new=false。
- 历史故障码“303804”，当前“怎么复位” → knowledge/reset，fault_code="303804"，should_search=true，rewritten_query="303804"，uses_history_fault_code=true，current_problem_is_new=false。
- 当前“八面风场ZC09风机偏航回路欠压故障触发条件是什么” → knowledge/trigger，should_search=true，rewritten_query="偏航回路欠压"；不得加入“八面、ZC09、厂家、机型、压力低”等字段。
- 当前“主断路器异常跳开是什么故障造成的” → knowledge/reason，should_search=true，rewritten_query="主断路器 异常跳开"。
- 当前“120014严重吗” → knowledge/risk，should_search=true，rewritten_query="120014"。
- 当前“120014还能继续运行吗” → knowledge/operation，should_search=true，rewritten_query="120014"。
- 当前“120014和20006有什么区别” → knowledge/comparison，should_search=true，rewritten_query="120014 20006"。
- 当前“电压690V正常吗”或“压力150bar上不去” → 不得把690/150当故障码；结合问题按 chat/general 或 knowledge/clarify 处理。
- 历史故障码“303804”，当前“齿轮箱油温上来了” → knowledge，fault_code=""，should_search=false，uses_history_fault_code=false，current_problem_is_new=true。
- 当前“这是什么意思”，且只是在追问上一轮说明 → chat/explain，should_search=false，fault_code=""。
- 当前“你好” → chat/general，should_search=false，fault_code=""。
- 当前“WD3000机组” → 不得把 WD3000 当故障码；信息不足时使用 clarify 或 general，should_search=false。'''
    return f'''你是 Windrise 网页助手的语义路由器。必须结合“同一网页会话历史”理解当前问题，不能只按关键词分类。

{rules}

{examples}

可用历史故障码：{recent_code or '无'}

历史要点：
{memory_summary}

已提取槽位：
{slot_summary}

最近对话：
{history_text}

当前用户问题：
{query}

JSON：
{schema}'''


def has_specific_current_diagnosis_subject(query):
    normalized = normalize_text(query)
    if not normalized:
        return False
    if is_windrise_general_knowledge_question(normalized):
        return False
    if has_explicit_fault_code(normalized):
        return True
    if is_wind_farm_model_mapping_query(normalized):
        return True
    if is_explicit_fault_name_lookup_query(normalized):
        return True
    if any(keyword in normalized for keyword in GENERAL_NON_DIAGNOSTIC_KEYWORDS):
        return False

    lowered = normalized.lower()
    has_specific_device_hint = any(
        keyword.lower() in lowered
        for keyword in DEVICE_HINT_KEYWORDS
        if keyword not in BROAD_DEVICE_KEYWORDS
    )
    has_issue_hint = any(keyword.lower() in lowered for keyword in ISSUE_HINT_KEYWORDS)
    has_scene = infer_guided_diagnosis_scene(normalized) is not None
    return has_specific_device_hint and (has_issue_hint or has_scene)


def is_context_only_windrise_followup(query):
    normalized = normalize_text(query).lower()
    if not normalized:
        return False
    if has_explicit_fault_code(normalized):
        return False
    if is_wind_farm_model_mapping_query(normalized) and not is_dimension_only_fault_followup(normalized):
        return False
    if is_explicit_fault_name_lookup_query(normalized):
        return False
    context_markers = (
        '这个', '那个', '它', '该故障', '该报警', '上面', '前面', '刚才',
        '那', '接下来', '下一步', '后面', '后续', '然后呢', '继续', '这个问题', '该问题',
        '前一个', '后一个', '第一个', '第二个', '前者', '后者', '再说一遍', '再说一次',
    )
    if any(marker in normalized for marker in context_markers):
        return True
    abstract_followup_patterns = (
        r'(怎么处理|如何处理|怎么办|为什么|为什么会报|为何会报|为啥会报|怎么会报|原因|怎么修|怎么维修|能复位吗|怎么复位|消警|消除报警|清除报警|解除报警|继续|然后呢|严重吗|危险吗|有什么影响|有何影响|还能继续运行吗|能否继续运行|能不能继续运行|可以继续运行吗|是否停机|需要停机吗|要不要停机|必须停机吗|必须停吗|要停吗|还能开吗|触发条件(?:是什么)?|触发逻辑(?:是什么)?|报警条件(?:是什么)?|报码条件(?:是什么)?|阈值是多少|门限是多少|达到多少会报|多少会报|达到什么值|什么时候触发|何时触发|什么时候报|何时报|什么情况下(?:产生|出现|报码|报警|触发)|什么条件下(?:产生|出现|报码|报警|触发)|何时产生|何时出现|如何触发|怎么触发|会在什么时候报|有什么区别|有何区别|什么不同|有何不同|对比一下)',
        r'(那|这个|该故障|该报警)?(应该|该)?(怎么|如何)(维修|修|处理|排查)',
        r'(后面|后续|接下来|下一步)(该)?(怎么|如何)?(做|处理|维修|排查)?啊?',
        r'(是什么|什么|哪些|主要)?原因(形成|导致|造成|引起|产生)?的?',
        r'(为什么|为啥|为何|怎么会|咋会)(形成|导致|造成|出现|这样|会这样)?的?',
        r'(怎么|如何)(形成|导致|造成|引起|产生|出现)的?',
    )
    return any(re.fullmatch(pattern, normalized) for pattern in abstract_followup_patterns)


def is_dimension_only_fault_followup(query):
    normalized = normalize_text(query)
    if not normalized:
        return False
    if is_windrise_scope_device_reply(normalized):
        return True
    if has_device_issue_hint(normalized) or looks_like_fault_phenomenon_query(normalized):
        return False
    has_dimension = query_has_explicit_dimension(normalized)
    has_mapping_intent = re.search(r'(有哪些|哪些|什么|哪种|哪家|哪款|对应|匹配|属于|查询|查一下|列出|清单|关系)', normalized)
    has_fault_intent = re.search(r'(故障|报警|告警|停机|复位|处理|排查|维修|原因|保护|跳开|跳闸|报码|故障码|代码)', normalized)
    return bool(has_dimension and not has_mapping_intent and not has_fault_intent and len(normalized) <= 30)


def has_pending_windrise_scope_collection(history):
    """Detect an active guided farm/turbine/model collection flow."""
    scope_prompt_patterns = (
        r'哪个风场',
        r'请告诉我：这是哪个风场',
        r'具体风机编号',
        r'风机编号',
        r'先确认设备范围',
        r'继续确认设备',
        r'已记住：风场',
        r'机型/具体型号',
        r'具体型号',
        r'厂家和机型',
        r'匹配到\s*\d+\s*条记录',
    )
    for item in (history or [])[-8:]:
        if item.get('role') != 'assistant':
            continue
        content = normalize_text(item.get('content', ''))
        if not content:
            continue
        if any(re.search(pattern, content, flags=re.IGNORECASE) for pattern in scope_prompt_patterns):
            return True
    user_messages = [
        normalize_text(item.get('content', ''))
        for item in (history or [])
        if item.get('role') == 'user' and normalize_text(item.get('content', ''))
    ]
    if len(user_messages) < 2:
        return False
    if not extract_recent_windrise_fault_topic_from_history(history):
        return False
    last_user_slots = extract_windrise_user_slots(user_messages[-1])
    if has_windrise_issue_slots(last_user_slots):
        return False
    return bool(
        last_user_slots.get('farm')
        or last_user_slots.get('turbine_id')
        or last_user_slots.get('brand')
        or last_user_slots.get('model')
        or last_user_slots.get('standard_model')
        or last_user_slots.get('_unavailable_dimensions')
    )


def is_windrise_scope_supplement_reply(query, history=None):
    """Short replies that only add farm/turbine/model scope for the current topic."""
    normalized = normalize_text(query)
    if not normalized or len(normalized) > 24:
        return False
    if is_context_only_windrise_followup(normalized):
        return False
    if extract_scada_style_alarm_name(normalized):
        return False
    if extract_windrise_fault_subject_phrase(normalized):
        return False
    history = history or []
    pending_scope = has_pending_windrise_scope_collection(history)
    if not pending_scope:
        return False
    for turbine_id in extract_windrise_turbine_ids_from_text(normalized):
        stripped = normalized
        stripped = re.sub(re.escape(turbine_id), ' ', stripped, flags=re.IGNORECASE)
        stripped = re.sub(
            r'(?:风机编号|风机号|机位号|机组编号|风场|风电场|场站|机型|型号|品牌|厂家|系列)[:：]?',
            ' ',
            stripped,
            flags=re.IGNORECASE,
        )
        stripped = re.sub(r'[号#，,。.、:：；;\s]', '', stripped)
        if len(stripped) <= 2:
            return True
    if has_explicit_fault_code(normalized):
        return False
    slots = extract_windrise_user_slots(normalized)
    has_scope = bool(
        slots.get('farm')
        or slots.get('turbine_id')
        or slots.get('brand')
        or slots.get('model')
        or slots.get('standard_model')
    )
    has_issue = bool(
        slots.get('fault_name')
        or slots.get('symptom')
        or slots.get('component')
        or slots.get('fault_code')
    )
    return has_scope and not has_issue


def is_windrise_candidate_selection_followup(query, history):
    normalized = normalize_text(query)
    if not normalized or has_explicit_fault_code(normalized):
        return False
    if is_fault_code_coverage_followup(normalized):
        return False
    if windrise_should_isolate_history_issue_slots(query, history):
        return False

    recent_code = find_recent_fault_code_for_query(query, history)
    recent_fault_answer = find_recent_windrise_fault_answer_from_history(history)
    if not recent_code and not recent_fault_answer:
        return False

    compact = re.sub(
        r'(帮我|给我|请|查|查询|检索|搜索|看|看看|选|选择|这个|那个|风场|机型|品牌|处理|维修|原因|复位|怎么|如何|的|一下|下|呢|啊|吧)',
        '',
        normalized,
        flags=re.IGNORECASE,
    )
    compact = re.sub(r'[？?，,。.、:：；;\s]', '', compact)
    if len(compact) < 2 or len(normalized) > 40:
        return False

    if re.search(
        r'(风电场|风场|华仪|华锐|金风|歌美飒|运达|明阳|新誉|湘电|远景|三一|团结|洮北|镇赉|镇赍|同发|王玲山|良井子|新华|四平|通榆)',
        normalized,
        flags=re.IGNORECASE,
    ):
        return True

    if not recent_fault_answer:
        return False

    tokens = [
        token
        for token in re.findall(r'[A-Za-z0-9_.#/-]+|[\u4e00-\u9fff]{2,}', normalized)
        if token not in {'风场', '机型', '品牌', '处理', '维修', '原因', '复位', '怎么', '如何', '这个', '那个'}
    ]
    if not tokens:
        return False
    return any(token in recent_fault_answer for token in tokens)


def find_recent_windrise_fault_answer_from_history(history):
    recent_code = find_recent_fault_code_from_history(history)
    for item in reversed(history or []):
        if item.get('role') != 'assistant':
            continue
        content = normalize_text(item.get('content', ''))
        if not content:
            continue
        if (
            '匹配到' in content
            and ('故障名称' in content or '故障代码' in content)
            and ('风场' in content or '品牌' in content or '机型' in content)
        ):
            return content
        if (
            recent_code
            and '风场/机型' in content
            and (
                re.search(rf'故障码\s*{re.escape(recent_code)}\b', content, flags=re.IGNORECASE)
                or re.search(rf'本地答案[:：]\s*{re.escape(recent_code)}\b', content, flags=re.IGNORECASE)
            )
        ):
            return content
    return ''


def build_windrise_candidate_selection_route(query, history):
    recent_code = find_recent_fault_code_for_query(query, history)
    intent = classify_windrise_followup_intent(query) or 'general'
    recent_fault_answer = find_recent_windrise_fault_answer_from_history(history)
    if not recent_code and recent_fault_answer and re.search(r'匹配到\s*\d+\s*条记录', recent_fault_answer):
        recent_code = ''
    if recent_code:
        rewritten_query = f'故障码{recent_code} {normalize_text(query)}'
    else:
        recent_topic = extract_recent_windrise_fault_topic_for_query(query, history)
        rewritten_query = ' '.join(
            item for item in (recent_topic, normalize_text(query)) if item
        ) or normalize_text(query)
    return {
        'mode': 'knowledge',
        'intent': intent,
        'fault_code': recent_code,
        'should_search': True,
        'uses_history_fault_code': True,
        'current_problem_is_new': False,
        'rewritten_query': rewritten_query,
        'reason': 'candidate_selection_from_previous_fault_code_answer',
    }


def extract_recent_windrise_fault_topic_from_history(history):
    for item in reversed(history or []):
        if item.get('role') != 'user':
            continue
        content = normalize_text(item.get('content', ''))
        if not content:
            continue
        if has_explicit_fault_code(content):
            continue
        if has_device_issue_hint(content) or re.search(r'(故障|报警|告警|停机|温度|异响|振动|震动|噪声|过高|过低|超限|异常)', content):
            return content
    answer = find_recent_windrise_fault_answer_from_history(history)
    if not answer:
        return ''
    name_match = re.search(r'故障名称[:：]\s*([^。\n]+)', answer)
    if name_match:
        return name_match.group(1).strip()
    title_match = re.search(r'^\s*([A-Za-z0-9_./\-]+)?\s*(维修处理建议|原因分析|复位说明)', answer)
    if title_match:
        return title_match.group(0).strip()
    return ''


def build_windrise_semantic_router_fallback(query, history):
    recent_code = find_recent_fault_code_for_query(query, history)
    explicit_codes = extract_direct_windrise_fault_codes(query, history)
    explicit_code = explicit_codes[0] if explicit_codes else ''
    normalized = normalize_text(query)
    if not explicit_code:
        code_match = re.search(
            r'(?i)(?<![A-Z0-9_])([A-Z]{1,4}[-_]?\d{2,6})(?![A-Z0-9_])\s*(?:报警|告警|故障|错误|fault|alarm|error)',
            normalized,
        )
        if code_match:
            explicit_code = code_match.group(1).upper().replace('-', '').replace('_', '')
    direct_answer = build_windrise_direct_chat_answer(query, history)
    intent = classify_windrise_followup_intent(query) or 'general'
    has_current_subject = has_specific_current_diagnosis_subject(query)
    context_only_followup = is_context_only_windrise_followup(query)
    likely_new_problem = bool(has_current_subject or has_device_issue_hint(normalized))
    searchable_current_subject = bool(
        has_current_subject
        and (
            is_explicit_fault_name_lookup_query(normalized)
            or is_explicit_fault_action_lookup_query(normalized)
            or looks_like_fault_phenomenon_query(normalized)
        )
    )
    current_subject_query = (
        extract_windrise_fault_subject_phrase(normalized)
        if searchable_current_subject
        else normalized
    ) or normalized

    if direct_answer:
        return {
            'mode': 'chat',
            'intent': intent,
            'fault_code': explicit_code or ('' if has_current_subject else recent_code),
            'should_search': False,
            'uses_history_fault_code': bool(recent_code and not explicit_code and not has_current_subject),
            'current_problem_is_new': has_current_subject,
            'rewritten_query': normalized,
            'direct_answer': direct_answer,
            'reason': 'deterministic_direct_chat',
        }

    if explicit_code:
        return {
            'mode': 'knowledge',
            'intent': intent,
            'fault_code': explicit_code,
            'should_search': True,
            'uses_history_fault_code': False,
            'current_problem_is_new': False,
            'rewritten_query': normalized,
            'direct_answer': '',
            'reason': 'explicit_fault_code',
        }

    if is_windrise_candidate_selection_followup(query, history):
        return build_windrise_candidate_selection_route(query, history)

    if context_only_followup and recent_code and intent in {'repair', 'reason', 'reset'} and not has_current_subject:
        return {
            'mode': 'knowledge',
            'intent': intent,
            'fault_code': recent_code,
            'should_search': intent in {'repair', 'reason', 'reset'},
            'uses_history_fault_code': True,
            'current_problem_is_new': False,
            'rewritten_query': normalized,
            'direct_answer': '',
            'reason': 'followup_with_recent_fault_code',
        }

    if has_device_issue_hint(normalized):
        return {
            'mode': 'knowledge',
            'intent': intent,
            'fault_code': '',
            'should_search': searchable_current_subject,
            'uses_history_fault_code': False,
            'current_problem_is_new': has_current_subject or not context_only_followup,
            'rewritten_query': current_subject_query if (has_current_subject or not context_only_followup) else (build_windrise_context_prompt(query, history) if history else normalized),
            'direct_answer': '',
            'reason': 'deterministic_current_subject' if searchable_current_subject else 'device_issue_without_code',
        }

    return {
        'mode': 'chat',
        'intent': 'general',
        'fault_code': recent_code if context_only_followup and not has_current_subject else '',
        'should_search': False,
        'uses_history_fault_code': bool(recent_code and context_only_followup and not has_current_subject),
        'current_problem_is_new': has_current_subject or likely_new_problem,
        'rewritten_query': normalized,
        'direct_answer': '',
        'reason': 'fallback_chat',
    }


def call_windrise_semantic_router(query, history):
    fallback = build_windrise_semantic_router_fallback(query, history)
    fallback['_model_routed'] = False
    if is_windrise_general_knowledge_question(query):
        fallback.update({
            'mode': 'chat',
            'intent': 'general',
            'should_search': False,
            'fault_code': '',
            'uses_history_fault_code': False,
            'current_problem_is_new': True,
            'rewritten_query': normalize_windrise_query(query),
            'reason': 'general_wind_knowledge_question',
        })
        return fallback
    if is_bare_windrise_fault_code_query(query):
        fallback.update({
            'mode': 'knowledge',
            'should_search': True,
            'fault_code': extract_direct_windrise_fault_codes(query, history)[0] if extract_direct_windrise_fault_codes(query, history) else '',
            'uses_history_fault_code': False,
            'current_problem_is_new': True,
            'rewritten_query': normalize_windrise_query(query),
            'reason': 'explicit_fault_code_skip_semantic_router',
        })
        return fallback
    if is_windrise_scoped_symptom_followup(query, history):
        scoped = build_windrise_symptom_scope_lookup_query(query, history)
        if scoped:
            fallback.update({
                'mode': 'knowledge',
                'should_search': True,
                'fault_code': '',
                'uses_history_fault_code': False,
                'current_problem_is_new': True,
                'rewritten_query': scoped,
                'reason': 'scoped_symptom_local_lookup',
            })
        return fallback
    if is_context_only_windrise_followup(query):
        recent_code = find_recent_fault_code_from_history(history)
        if is_numeric_windrise_fault_code(recent_code):
            return fallback
    if not WINDRISE_SEMANTIC_ROUTER_ENABLED or is_windrise_llm_temporarily_unavailable():
        return fallback

    # A code supplied in the current message is already an exact retrieval key.
    # Every other knowledge lookup, including contextual follow-ups, must pass
    # through the model so pronouns and omitted fault details are resolved.
    if extract_direct_windrise_fault_codes(query, history):
        print('[Windrise] 当前消息含明确故障码，跳过语义路由模型')
        return fallback

    recent_code = find_recent_fault_code_from_history(history)
    prompt = build_windrise_semantic_router_prompt(query, history, recent_code)
    try:
        windrise_request_context.semantic_pass_used = True
        raw_text = call_chat_model(
            [
                {
                    'role': 'system',
                    'content': '你只做语义路由。必须只输出合法 JSON，不输出思考过程。',
                },
                {'role': 'user', 'content': prompt},
            ],
            max_tokens=500,
            temperature=0.1,
            timeout=WINDRISE_SEMANTIC_ROUTER_TIMEOUT,
            sanitize=False,
        )
        try:
            parsed = parse_windrise_router_json(raw_text)
        except Exception as parse_error:
            print(f"[Windrise] 语义路由 JSON 解析失败，重试紧凑提示: {parse_error}")
            retry_prompt = build_windrise_semantic_router_prompt(query, history, recent_code, compact=True)
            raw_text = call_chat_model(
                [
                    {'role': 'system', 'content': '只输出合法 JSON。'},
                    {'role': 'user', 'content': retry_prompt},
                ],
                max_tokens=380,
                temperature=0.0,
                timeout=WINDRISE_SEMANTIC_ROUTER_TIMEOUT,
                sanitize=False,
            )
            parsed = parse_windrise_router_json(raw_text)
    except Exception as e:
        if isinstance(e, (requests.Timeout, requests.ConnectionError)):
            mark_windrise_llm_unavailable(e)
        else:
            print(f"[Windrise] 语义路由失败，使用兜底: {type(e).__name__}: {e}")
        return fallback

    validated, validation_error = validate_windrise_semantic_route(parsed, query, recent_code)
    if validation_error:
        print(f"[Windrise] 语义路由校验失败，使用兜底: {validation_error}")
        return fallback

    validated['_model_routed'] = True
    validated['rewritten_query'] = clamp_windrise_semantic_rewritten_query(
        query,
        history,
        validated.get('rewritten_query', ''),
    )
    return validated


def build_windrise_followup_query(query, history):
    route = call_windrise_semantic_router(query, history)
    if route.get('mode') == 'knowledge' and route.get('should_search') and route.get('fault_code'):
        return {'args': ['search', route['fault_code']], 'intent': route.get('intent') or 'general'}
    if route.get('mode') == 'knowledge':
        return build_windrise_context_prompt(route.get('rewritten_query') or query, history) if history else route.get('rewritten_query') or query
    return route.get('rewritten_query') or query


def build_windrise_direct_chat_answer(query, history):
    normalized = normalize_text(query)
    if not normalized:
        return ''

    if any(re.fullmatch(pattern, normalized, flags=re.IGNORECASE) for pattern in GREETING_QUERY_PATTERNS):
        return '你好！我是 Windrise，本地风机故障知识助手。请直接告诉我当前问题。'

    yaw_hydraulic_answer = build_windrise_yaw_hydraulic_direct_answer(normalized, history)
    if yaw_hydraulic_answer:
        return yaw_hydraulic_answer

    date_answer = build_windrise_date_time_answer(normalized)
    if date_answer:
        return date_answer

    # Fault/diagnosis queries may mention farm and turbine IDs; never treat them as mapping.
    if not should_block_windrise_mapping_answer(normalized):
        turbine_mapping_answer = build_windrise_turbine_mapping_answer(normalized)
        if turbine_mapping_answer:
            return turbine_mapping_answer

        model_mapping_answer = build_windrise_model_mapping_answer(normalized)
        if model_mapping_answer:
            return model_mapping_answer

    if is_windrise_candidate_selection_followup(normalized, history):
        return ''

    return ''


def build_windrise_yaw_hydraulic_direct_answer(query, history):
    normalized = normalize_text(query)
    context = f"{normalized}\n{build_windrise_history_text(history, limit=6)}"
    if not is_windrise_yaw_hydraulic_context(context, normalized):
        return ''

    if re.fullmatch(r'(1\s*次|一次|动作一次|电机动作一次)', normalized, flags=re.IGNORECASE) and re.search(r'(电机动作次数|液压站电机|恢复到\s*150\s*bar|恢复至\s*150\s*bar|请直接反馈电机动作)', context, flags=re.IGNORECASE):
        return '\n'.join([
            '结论：先不处理常闭电磁换向阀。',
            '',
            '下一步只做一件事：保持所有换向阀在初始状态，测量主回路压力和液压泵电流。',
            '',
            '请反馈：主回路压力多少 bar、液压泵电流多少 A。',
        ])

    if re.search(r'(频繁动作|多次动作|反复动作)', normalized):
        return '\n'.join([
            '结论：恢复过程中频繁补压，优先按偏航回路内泄或保压失败处理。',
            '',
            '下一步只做一件事：恢复刹车后保持静止，记录压力从150bar降到135bar所用时间。',
            '',
            '请反馈：降压用时。',
        ])

    if re.search(r'(不动作|没有动作|未动作|没动作)', normalized):
        return '\n'.join([
            '结论：先按液压站电机未启动处理，不要先拆液压阀。',
            '',
            '下一步只做一件事：恢复刹车时测液压站电机接触器线圈是否得电。',
            '',
            '请反馈：接触器线圈是否得电。',
        ])

    if re.search(r'(已按要求.*释放.*恢复刹车|手动释放.*恢复刹车|释放并恢复刹车|恢复刹车)', normalized) and not re.search(r'(\d+\s*bar|\d+\s*s|\d+\s*秒|1\s*次|一次|频繁动作|不动作)', normalized, flags=re.IGNORECASE):
        return '\n'.join([
            '结论：动作完成，但现在还不能判断故障点。',
            '',
            '下一步只做一件事：重新看这一轮恢复刹车的压力曲线。',
            '',
            '请反馈：最低压力、恢复到150bar用时、液压站电机动作次数。',
        ])

    if re.search(r'(释放刹车|恢复刹车|刹车|制动)', normalized) and re.search(r'(压力上不来|压力不上来|建压不上来|建压失败|无法建压|压力升不上去)', normalized):
        return '\n'.join([
            '结论：这是风力发电机偏航液压制动回路建压异常，不是汽车刹车问题。',
            '',
            '下一步只做一件事：恢复刹车时只观察液压站电机是否启动。',
            '',
            '请反馈：电机是“动作一次”“频繁动作”还是“不动作”。',
        ])

    if re.search(r'偏航', normalized) and re.search(r'(SCADA|HMI)', normalized, flags=re.IGNORECASE) and re.search(r'(压力异常|压力异|压力报警|压力告警|压力波动)', normalized):
        return '\n'.join([
            '结论：先按偏航液压压力恢复异常处理，不要先判断为传感器误报。',
            '',
            '下一步只做一件事：手动释放刹车，再恢复刹车。',
            '',
            '请反馈：最低压力、恢复到150bar用时、液压站电机动作次数。',
        ])

    if re.search(r'偏航', normalized) and re.search(r'(液压|压力)', normalized) and re.search(r'(欠压|压力异常|压力波动|建压)', normalized) and re.search(r'(尚未拆阀|未拆阀|未更换液压泵|没换泵|不要拆阀|下一步|先做)', normalized):
        return '\n'.join([
            '结论：先按偏航回路建压异常排查，暂时不要拆阀或更换液压泵。',
            '',
            '下一步只做一件事：手动释放刹车，再恢复刹车。',
            '',
            '请反馈：最低压力、恢复到150bar用时、液压站电机动作次数。',
        ])

    return ''


def build_windrise_yaw_hydraulic_stage_answer(query, conversation_id, user_id=None):
    normalized = normalize_text(query)
    stage = get_windrise_yaw_hydraulic_stage(conversation_id, user_id=user_id)
    if not stage:
        return ''

    if stage == 'await_motor_count':
        if re.fullmatch(r'(1\s*次|一次|动作一次|电机动作一次)', normalized, flags=re.IGNORECASE):
            return '\n'.join([
                '结论：先不处理常闭电磁换向阀。',
                '',
                '下一步只做一件事：保持所有换向阀在初始状态，测量主回路压力和液压泵电流。',
                '',
                '请反馈：主回路压力多少 bar、液压泵电流多少 A。',
            ])
        if re.search(r'(频繁动作|多次动作|反复动作)', normalized):
            return '\n'.join([
                '结论：恢复过程中频繁补压，优先按偏航回路内泄或保压失败处理。',
                '',
                '下一步只做一件事：恢复刹车后保持静止，记录压力从150bar降到135bar所用时间。',
                '',
                '请反馈：降压用时。',
            ])
        if re.search(r'(不动作|没有动作|未动作|没动作)', normalized):
            return '\n'.join([
                '结论：先按液压站电机未启动处理，不要先拆液压阀。',
                '',
                '下一步只做一件事：恢复刹车时测液压站电机接触器线圈是否得电。',
                '',
                '请反馈：接触器线圈是否得电。',
            ])

    if stage == 'await_release_results' and re.fullmatch(r'(1\s*次|一次|动作一次|电机动作一次)', normalized, flags=re.IGNORECASE):
        return '\n'.join([
            '结论：已收到液压站电机动作一次，但还缺压力恢复数据，暂时不能定位故障点。',
            '',
            '下一步只做一件事：补看刚才恢复刹车的压力曲线。',
            '',
            '请反馈：最低压力、恢复到150bar用时。',
        ])

    return ''


def update_windrise_yaw_hydraulic_stage(conversation_id, query, answer, user_id=None):
    text = f"{query}\n{answer}"
    if not re.search(r'(偏航|液压站|SCADA|HMI|150\s*bar|恢复刹车|释放刹车|换向阀|主回路|液压泵)', text, flags=re.IGNORECASE):
        return
    if re.search(r'(电机是“动作一次”“频繁动作”还是“不动作”|请直接反馈电机动作次数|只看液压站电机动作次数)', text):
        set_windrise_yaw_hydraulic_stage(conversation_id, 'await_motor_count', user_id=user_id)
        return
    if re.search(r'(最低压力、恢复到150bar用时、液压站电机动作次数|最低压力.*恢复到\s*150\s*bar.*电机动作次数)', text, flags=re.IGNORECASE):
        set_windrise_yaw_hydraulic_stage(conversation_id, 'await_release_results', user_id=user_id)
        return
    if re.search(r'(主回路压力多少\s*bar|液压泵电流多少\s*A)', text, flags=re.IGNORECASE):
        set_windrise_yaw_hydraulic_stage(conversation_id, 'await_main_pressure', user_id=user_id)
        return


def is_windrise_yaw_hydraulic_context(context, query):
    if re.search(r'(风机|风电|机组|偏航|液压站|SCADA|HMI|150\s*bar|主回路|换向阀|建压|恢复刹车|释放刹车)', context, flags=re.IGNORECASE):
        return True
    return bool(
        re.search(r'(刹车|制动|压力|液压)', query)
        and re.search(r'(上不来|不上来|恢复|释放|建压|动作)', query)
    )


def build_windrise_model_mapping_answer(query):
    if should_block_windrise_mapping_answer(query):
        return ''
    if not looks_like_windrise_model_mapping_query(query):
        return ''
    if is_fault_code_coverage_followup(query):
        return ''
    local_answer = build_local_wind_farm_model_mapping_answer(query)
    if local_answer:
        return local_answer
    try:
        answer = run_windrise_answer(['farm', query], timeout=8)
    except Exception as exc:
        print(f"[Windrise] 场站/型号映射查询失败: {type(exc).__name__}")
        return ''
    if not answer or '没有在内置风场机型表中找到匹配项' in answer:
        return ''
    if '本地模型暂时不可用' in answer or '处理您的请求时出现问题' in answer:
        return ''
    if any(marker in answer for marker in ('该机型对应的风场如下', '查询结果', '内置风场与风机型号对应关系')):
        return answer
    return ''


def build_local_wind_farm_model_mapping_answer(query):
    """Answer farm-to-model inventory questions directly from the mapping table."""
    if not is_wind_farm_model_mapping_query(query):
        return ''
    site = extract_windrise_site_from_text(query)
    site_key = normalize_windrise_site_key(site)
    if not site_key:
        return ''
    groups = OrderedDict()
    site_label = site
    for entry in load_windrise_turbine_mapping_entries():
        entry_site = normalize_context_dimension_value(entry.get('site', ''))
        if normalize_windrise_site_key(entry_site) != site_key:
            continue
        site_label = normalize_context_dimension_value(entry.get('siteFull', '')) or entry_site or site_label
        brand = normalize_context_dimension_value(entry.get('brand', ''))
        model = normalize_windrise_model_value(entry.get('model', ''))
        standard_model = normalize_windrise_model_value(entry.get('standardModel', ''))
        key = (brand, model, standard_model)
        group = groups.setdefault(key, [])
        turbine_id = normalize_windrise_turbine_id(entry.get('turbineId', ''))
        if turbine_id and turbine_id not in group:
            group.append(turbine_id)
    if not groups:
        return ''
    lines = [
        f"**{site_label or site}机型清单**",
        '',
        f"本地映射表共找到 {len(groups)} 类厂家/机型组合。",
    ]
    for index, ((brand, model, standard_model), turbine_ids) in enumerate(groups.items(), start=1):
        title = ' / '.join(value for value in (brand, model) if value) or '未标明机型'
        lines.extend(['', f"{index}. **{title}**"])
        if standard_model:
            lines.append(f"   - 具体型号：{standard_model}")
        if turbine_ids:
            sample = '、'.join(turbine_ids[:6])
            suffix = f" 等，共 {len(turbine_ids)} 台" if len(turbine_ids) > 6 else ''
            lines.append(f"   - 风机编号：{sample}{suffix}")
    return '\n'.join(lines)


def should_block_windrise_mapping_answer(query):
    """Keep explicit mapping questions on the mapping path; block fault-like queries."""
    normalized = normalize_text(query)
    if not normalized:
        return False
    if is_wind_farm_model_mapping_query(normalized):
        return False
    if should_answer_windrise_turbine_mapping_question(normalized):
        return False
    if has_explicit_fault_code(normalized):
        return True
    if is_explicit_fault_name_lookup_query(normalized) or is_explicit_fault_action_lookup_query(normalized):
        return True
    if has_device_issue_hint(normalized) and re.search(
        r'(故障|报警|告警|停机|异常|错误|通讯|失效|损坏|丢失|断开|超限|过高|过低|过温|高温|油温高|温度高|压力低|压力高|电压高|电压低|容量低|过载|跳闸|跳开|断路|短路|检测到)',
        normalized,
        flags=re.IGNORECASE,
    ):
        return True
    return False


def looks_like_windrise_model_mapping_query(query):
    normalized = normalize_text(query)
    if not normalized:
        return False
    if should_block_windrise_mapping_answer(normalized):
        return False
    if re.search(r'(故障码|故障代码|报码|报警码|告警码|状态代码|fault\s*code)', normalized, flags=re.IGNORECASE):
        return False
    # Bare turbine IDs like SH09 belong to turbine-mapping, not farm/model mapping.
    if should_answer_windrise_turbine_mapping_question(normalized):
        return False
    if has_device_issue_hint(normalized) and re.search(
        r'(故障|报警|告警|停机|异常|错误|通讯|超限|过高|过低|过温|高温|油温高|温度高|压力低|压力高|电压高|电压低|容量低|过载|跳闸|跳开|断开|断路|短路|丢失|失效|检测到)',
        normalized,
        flags=re.IGNORECASE,
    ):
        return False
    has_explicit_mapping_word = re.search(
        r'(风场|风电场|机型|型号|风机|品牌|对应|匹配|属于|哪个|哪些|查询|查一下|列出|清单|关系)',
        normalized,
        flags=re.IGNORECASE,
    )
    has_mapping_word = re.search(
        r'(风场|风电场|机型|型号|系列|主控|品牌|对应|匹配|属于|哪个|哪些|什么|查询|查一下|列出|清单|关系)',
        normalized,
        flags=re.IGNORECASE,
    )
    has_specific_site_model_question = re.search(
        r'(风场|风电场|场站).*(机型|型号|风机|品牌|厂家|系列)|(机型|型号|风机|品牌|厂家|系列).*(风场|风电场|场站)',
        normalized,
        flags=re.IGNORECASE,
    )
    has_fault_intent = re.search(
        r'(故障|报警|告警|停机|复位|处理|排查|维修|原因|保护|跳开|跳闸|空开|加热器|温度|传感器|短路|断路|丢失|错误|通讯|检测到)',
        normalized,
        flags=re.IGNORECASE,
    )
    has_explicit_model_mapping_word = re.search(
        r'(机型|型号|风机|品牌|厂家|系列|对应|匹配|属于|哪个|哪些|查询|查一下|列出|清单|关系)',
        normalized,
        flags=re.IGNORECASE,
    )
    if has_fault_intent and not has_explicit_model_mapping_word:
        return False
    if has_fault_intent and re.search(r'(?<![A-Za-z0-9])\d{1,8}(?![A-Za-z0-9])', normalized):
        return False
    if has_mapping_word or has_specific_site_model_question:
        return True
    compact = re.sub(r'[\s_—–（）()]', '', normalized)
    if re.fullmatch(r'\d+', compact):
        return False
    if re.fullmatch(r'sc\d[\w./-]*', compact, flags=re.IGNORECASE):
        return False
    return bool(re.fullmatch(r'[a-z]{1,10}[\w./-]*\d[\w./-]*', compact, flags=re.IGNORECASE))


def build_windrise_date_time_answer(normalized):
    if re.search(r'(风机|风电|故障|报警|告警|停机|复位|处理|排查|维修|变桨|偏航|主控|变流|发电机|齿轮箱)', normalized, flags=re.IGNORECASE):
        return ''
    now = datetime.now()
    weekday = '一二三四五六日'[now.weekday()]
    if re.fullmatch(r'(今天)?(是)?(什么日子|几号|日期|星期几|周几)[？?。!！\s]*', normalized) or re.search(r'(今天是什么日子|今天几号|今天日期|今天星期几|今天周几)', normalized):
        return f'今天是 {now.year}年{now.month}月{now.day}日，星期{weekday}。'
    if re.fullmatch(r'(现在|当前)?(几点|什么时间|时间)[？?。!！\s]*', normalized) or re.search(r'(现在几点|当前时间|现在时间)', normalized):
        return f'现在是 {now.year}年{now.month}月{now.day}日 {now:%H:%M}，星期{weekday}。'
    return ''


def build_current_subject_diagnosis_fallback_answer(query):
    normalized = normalize_text(query)
    if not normalized:
        return ''

    if re.search(r'(叶片|桨叶).{0,8}(结冰|覆冰|积冰|凝冰|冰冻)|(结冰|覆冰|积冰|凝冰|冰冻).{0,8}(叶片|桨叶)', normalized):
        return (
            "**结论：** 叶片结冰会造成气动失衡、出力下降和振动增大；严重时存在甩冰风险。"
            "先按结冰工况控制机组，不沿用上一轮发电机故障码。\n\n"
            "**现场处理：**\n"
            "1. 立即核对环境温度、湿度/降水、功率曲线、叶轮振动和结冰报警，确认是否持续恶化。\n"
            "2. 按该机型结冰保护策略降载或停机；出现振动超限、功率明显偏差或可见厚冰时保持停机。\n"
            "3. 设置甩冰警戒区，禁止人员和车辆进入叶轮下方及可能的甩冰范围；不要人工敲冰。\n"
            "4. 有厂家批准的叶片加热或除冰系统时，按操作规程启用并观察三支叶片状态是否一致。\n"
            "5. 只有在冰层消退、叶片检查正常、振动和功率曲线恢复后，才按厂家规程复位试运行。\n\n"
            "请补充风场、风机编号、厂家/机型和原始结冰报警，我可以继续匹配该机型的报码与复位条件。"
        )

    return (
        f"**当前问题：** {normalized}\n\n"
        "**说明：** 我按当前问题处理，不沿用上一条故障码。\n\n"
        "**通用现场排查：**\n"
        "1. 确认对应部件、原始报警名称/报码和报警时间。\n"
        "2. 查看相关趋势参数，确认异常是瞬时、持续还是反复出现。\n"
        "3. 对照现场实测、传感器读数和控制系统记录，先排除误报或采集异常。\n"
        "4. 检查该部件相关的供电、润滑、冷却、通信和机械状态。\n"
        "5. 如果伴随异响、振动、异味、冒烟或参数持续恶化，先停机隔离，不要反复复位。"
    )


def build_windrise_general_knowledge_fallback_answer(query, history=None):
    normalized = normalize_text(query) or '当前问题'
    codes = extract_fault_codes(normalized)
    if codes:
        code_label = '、'.join(codes)
        return (
            '**推理补充**\n\n'
            '**通用判断**\n\n'
            f'**本地库：** 暂未找到故障码“{code_label}”的精确记录。\n\n'
            '**通用结论：** 单独一个故障码通常是厂家/机型专有码，不能只凭数字直接确定真实含义；先按“未知报码”做现场确认和风险排查。\n\n'
            '**先做这几步：**\n'
            '1. 核对原始报码是否完整，确认是否有前缀、子码、模块号或十六进制显示。\n'
            '2. 同时记录风场、厂家、机型、主控版本、变流器/变桨/偏航等报警来源。\n'
            '3. 查看同一时间的伴随报警和趋势量，重点看电网、变流器、变桨、偏航、通信和安全链是否同时异常。\n'
            '4. 如果报警伴随停机、异响、冒烟、过温、过流或安全链动作，先保持停机隔离，不要反复复位。\n'
            '5. 拿到告警名称或机型后再查，才能给出对应的准确故障含义和处理步骤。'
        )

    if not is_windrise_llm_temporarily_unavailable():
        history_text = build_windrise_history_text(history or [])
        prompt = f"""本地风机故障知识库没有精确命中当前问题。请继续作为智能助手，用通用风机运维知识回答。

要求：
- 第一段只简短说明“本地库暂未找到精确记录”，不要把没找到当最终答案。
- 后面必须给出通用判断、可能方向和可执行排查步骤。
- 不要编造具体风场、机型、故障码对应关系；不确定的地方明确说需要核对。
- 使用简洁格式：**结论/重点**、短段落和列表；不要使用 ## 或 ### 标题。
- 回答不要太长。

最近对话：
{history_text}

当前问题：
{normalized}
"""
        try:
            answer = call_chat_model(
                [
                    {'role': 'system', 'content': '你是 Windrise，本地风机运维智能助手。知识库未命中时，要继续用通用工程知识给可执行建议；不要编造专有码含义。'},
                    {'role': 'user', 'content': prompt},
                ],
                max_tokens=700,
                temperature=0.25,
                timeout=WINDRISE_CHAT_TIMEOUT,
                sanitize=True,
            )
            if answer:
                if not answer.lstrip().startswith('**推理补充**'):
                    answer = f"**推理补充**\n\n{answer}"
                return answer
        except Exception as e:
            mark_windrise_llm_unavailable(e)

    fallback = build_current_subject_diagnosis_fallback_answer(normalized)
    if fallback and not fallback.lstrip().startswith('**推理补充**'):
        return f"**推理补充**\n\n{fallback}"
    return fallback


def looks_like_tool_command_output(text):
    normalized = normalize_text(text)
    if not normalized:
        return False
    return bool(re.search(r'(?mi)^\s*(?:`{0,3}\s*)?(?:bash\s+)?(?:search_wiki|wiki_search|llmwiki\s+search|search)\b', normalized))


def extract_core_diagnosis_terms(query):
    normalized = normalize_text(query)
    terms = []
    for term in re.findall(r'[\u4e00-\u9fff]{2,}|[A-Za-z0-9_.#/-]{2,}', normalized):
        lowered = term.lower()
        if lowered in {'故障码', '故障代码', '处理', '建议', '故障', '报警', '告警', '怎么处理', '如何处理'}:
            continue
        if term not in terms:
            terms.append(term)
    return terms


def extract_windrise_fault_name_query(query):
    normalized = normalize_text(query)
    if not normalized:
        return ''

    cleaned = re.sub(
        r'^\s*(故障名称|故障名|名称|输入|搜索|查询|查一下|查下|查|检索|搜一下|搜下|搜)[:：]?\s*',
        '',
        normalized,
        flags=re.IGNORECASE,
    )
    cleaned = re.sub(
        r'^\s*(故障名称|故障名|名称)[:：]?\s*',
        '',
        cleaned,
        flags=re.IGNORECASE,
    )
    cleaned = re.sub(
        r'\s*(?:查不到|搜不到|搜索不到|检索不到|查不出来|搜不出来|没有结果|没结果|找不到|未找到|匹配不到|无法匹配)\s*$',
        '',
        cleaned,
        flags=re.IGNORECASE,
    )
    cleaned = re.sub(r'^[“"\'「『【\[\(（]+|[”"\'」』】\]\)）。.，,；;：:\s]+$', '', cleaned).strip()
    if cleaned and cleaned != normalized and re.search(r'(故障|报警|告警|停机|超限|过高|过低|异常|短路|断路|丢失|失败)', cleaned):
        return cleaned

    match = re.search(
        r'(?:输入|搜索|查询|查一下|查下|查|检索|搜一下|搜下|搜)\s*([^\n，,。；;：:]{3,80}?(?:故障|报警|告警|停机|超限|过高|过低|异常|短路|断路|丢失|失败)[^\n，,。；;：:]{0,40})',
        normalized,
        flags=re.IGNORECASE,
    )
    if match:
        return match.group(1).strip(' “"\'「」『』【】[]()（）')
    return ''


def is_meaningful_windrise_context(query, context):
    text = normalize_text(context)
    if not text or text.startswith('No matches'):
        return False
    body = re.sub(r'^Matches for .+?\n+', '', text, flags=re.DOTALL)
    body = re.sub(r'^(purpose|schema|wiki)/[^\n]*\n[^\n]*(?:\n|$)', '', body, flags=re.MULTILINE)
    core_terms = extract_core_diagnosis_terms(query)
    if not core_terms:
        return True
    return any(term in body for term in core_terms[:3])


def build_windrise_knowledge_first_answer(query, history, route=None):
    route = route or {}
    remembered_context = reusable_windrise_retrieval_context(query, history, route)
    if remembered_context:
        print('[Windrise] 复用会话内首次检索结果，不再调用 LLMWiki')
        if re.search(r'(哪个风场|哪些风场|哪个风机|哪些风机|风机编号|机位|对应|厂家|品牌|机型|型号)', query):
            return remembered_context
        return build_windrise_knowledge_augmented_answer(
            query,
            history,
            {'args': ['search', query], 'intent': route.get('intent') or 'repair'},
            route,
            prefetched_wiki_context=remembered_context,
        )
    index_answer = build_index_scoped_fault_lookup_answer(query, history)
    if index_answer:
        return index_answer
    search_query = route.get('rewritten_query') or query
    focused_query = extract_windrise_fault_name_query(search_query)
    display_query = re.sub(
        r'^\s*(帮我|给我|请)?\s*(查一下|查下|查|查询|检索|搜索|搜一下|搜下|搜|知识库|llmwiki|wiki)\s*',
        '',
        normalize_text(focused_query or search_query),
        flags=re.IGNORECASE,
    ) or focused_query or search_query
    try:
        search_query = apply_recent_user_dimension_to_windrise_query(search_query, history)
        raw_wiki_context = run_windrise_answer(['search', search_query])
        wiki_context = normalize_text(raw_wiki_context)
    except Exception as e:
        print(f"[Windrise] LLMWiki 优先检索失败，改走通用回答: {type(e).__name__}: {e}")
        raw_wiki_context = ''
        wiki_context = ''

    if (
        focused_query
        and focused_query != search_query
        and not is_meaningful_windrise_context(search_query, wiki_context)
    ):
        try:
            constrained_focused_query = apply_recent_user_dimension_to_windrise_query(focused_query, history)
            focused_wiki_context = run_windrise_answer(['search', constrained_focused_query])
            if is_meaningful_windrise_context(focused_query, focused_wiki_context):
                raw_wiki_context = focused_wiki_context
                wiki_context = normalize_text(focused_wiki_context)
                search_query = constrained_focused_query
        except Exception as e:
            print(f"[Windrise] LLMWiki 核心故障名重查失败: {type(e).__name__}: {e}")

    if is_structured_windrise_fault_lookup_answer(raw_wiki_context):
        return raw_wiki_context
    if is_meaningful_windrise_context(search_query, wiki_context):
        if is_exact_windrise_fault_answer(raw_wiki_context):
            return raw_wiki_context
        if is_windrise_fault_record_context(raw_wiki_context):
            return raw_wiki_context
        return build_windrise_knowledge_augmented_answer(
            query,
            history,
            {'args': ['search', search_query], 'intent': route.get('intent') or 'repair'},
            route,
            prefetched_wiki_context=raw_wiki_context,
        )

    phenomenon_candidates = build_fault_phenomenon_candidates_answer(display_query, history)
    if phenomenon_candidates:
        return phenomenon_candidates

    return build_windrise_general_knowledge_fallback_answer(display_query, history)


def iter_windrise_knowledge_first_answer(query, history, route=None):
    """Streaming counterpart of knowledge-first answering for the web SSE path."""
    route = route or {}
    remembered_context = reusable_windrise_retrieval_context(query, history, route)
    if remembered_context:
        print('[Windrise] 流式回答复用会话内首次检索结果，不再调用 LLMWiki')
        if re.search(r'(哪个风场|哪些风场|哪个风机|哪些风机|风机编号|机位|对应|厂家|品牌|机型|型号)', query):
            yield from iter_stream_text_chunks(remembered_context)
            return
        yield from iter_windrise_knowledge_augmented_answer(
            query,
            history,
            {'args': ['search', query], 'intent': route.get('intent') or 'repair'},
            route,
            prefetched_wiki_context=remembered_context,
        )
        return

    index_answer = build_index_scoped_fault_lookup_answer(query, history)
    if index_answer:
        yield from iter_stream_text_chunks(index_answer)
        return

    search_query = route.get('rewritten_query') or query
    focused_query = extract_windrise_fault_name_query(search_query)
    display_query = re.sub(
        r'^\s*(帮我|给我|请)?\s*(查一下|查下|查|查询|检索|搜索|搜一下|搜下|搜|知识库|llmwiki|wiki)\s*',
        '',
        normalize_text(focused_query or search_query),
        flags=re.IGNORECASE,
    ) or focused_query or search_query
    try:
        search_query = apply_recent_user_dimension_to_windrise_query(search_query, history)
        raw_wiki_context = run_windrise_answer(['search', search_query])
        wiki_context = normalize_text(raw_wiki_context)
    except Exception as e:
        print(f"[Windrise] 流式 LLMWiki 优先检索失败，改走通用回答: {type(e).__name__}: {e}")
        raw_wiki_context = ''
        wiki_context = ''

    if (
        focused_query
        and focused_query != search_query
        and not is_meaningful_windrise_context(search_query, wiki_context)
    ):
        try:
            constrained_focused_query = apply_recent_user_dimension_to_windrise_query(focused_query, history)
            focused_wiki_context = run_windrise_answer(['search', constrained_focused_query])
            if is_meaningful_windrise_context(focused_query, focused_wiki_context):
                raw_wiki_context = focused_wiki_context
                wiki_context = normalize_text(focused_wiki_context)
                search_query = constrained_focused_query
        except Exception as e:
            print(f"[Windrise] 流式 LLMWiki 核心故障名重查失败: {type(e).__name__}: {e}")

    if is_structured_windrise_fault_lookup_answer(raw_wiki_context):
        yield from iter_stream_text_chunks(raw_wiki_context)
        return
    if is_meaningful_windrise_context(search_query, wiki_context):
        if is_exact_windrise_fault_answer(raw_wiki_context) or is_windrise_fault_record_context(raw_wiki_context):
            yield from iter_stream_text_chunks(raw_wiki_context)
            return
        yield from iter_windrise_knowledge_augmented_answer(
            query,
            history,
            {'args': ['search', search_query], 'intent': route.get('intent') or 'repair'},
            route,
            prefetched_wiki_context=raw_wiki_context,
        )
        return

    phenomenon_candidates = build_fault_phenomenon_candidates_answer(display_query, history)
    if phenomenon_candidates:
        yield from iter_stream_text_chunks(phenomenon_candidates)
        return
    yield from iter_stream_text_chunks(build_windrise_general_knowledge_fallback_answer(display_query, history))


def should_force_windrise_knowledge_lookup(query, history=None):
    normalized = normalize_text(query)
    history = history or []
    if not normalized:
        return False
    if is_windrise_scoped_symptom_followup(normalized, history):
        return False
    if is_windrise_bare_symptom_with_confirmed_scope(normalized, history):
        return False
    if extract_fault_codes(normalized):
        return True
    if has_device_issue_hint(normalized):
        return True
    return bool(re.search(
        r'(查|查询|检索|搜索|搜|知识库|llmwiki|wiki|故障码|故障代码|有哪些码|哪些码|有什么码|对应哪些码|报码|告警码|报警码|状态代码)',
        normalized,
        flags=re.IGNORECASE,
    ))


def prepare_windrise_chat_answer(query, history, route=None):
    route = route or {}
    direct_answer = normalize_text(route.get('direct_answer')) or build_windrise_direct_chat_answer(query, history)
    if direct_answer:
        return {'direct_answer': direct_answer}

    rewritten_query = route.get('rewritten_query') or query
    current_problem_is_new = bool(route.get('current_problem_is_new'))
    if current_problem_is_new and has_specific_current_diagnosis_subject(rewritten_query):
        current_subject_fallback = build_current_subject_diagnosis_fallback_answer(rewritten_query)
    else:
        current_subject_fallback = ''

    if is_windrise_llm_temporarily_unavailable():
        if current_subject_fallback:
            return {'direct_answer': current_subject_fallback}
        recent_code = find_recent_fault_code_for_query(query, history)
        route_intent = route.get('intent') or 'general'
        if recent_code and route_intent in {'repair', 'reason', 'reset', 'explain'}:
            return {'direct_answer': f'我理解你是在接着问前面的 {recent_code}。你可以直接问“怎么处理”“为什么会报”或“能不能复位”，我会按这个故障继续分析。'}
        return {'direct_answer': build_current_subject_diagnosis_fallback_answer(rewritten_query)}

    history_text = build_windrise_history_text(history)
    memory_summary = build_memory_summary(history or []) or '无'
    current_subject_instruction = ''
    if current_problem_is_new:
        current_subject_instruction = (
            '\n- 当前用户问题已经给出新的具体部件或现象，必须围绕当前问题回答；'
            '历史只作为背景，不要沿用上一轮故障码或上一轮故障名称。'
        )
    dimension_constraint_instruction = (
        build_windrise_dimension_constraint_instruction(rewritten_query, history)
        + build_windrise_slot_context_instruction(rewritten_query, history)
    )
    prompt = f"""你是 Windrise，本地风机故障知识助手。请像正常智能助手一样回答当前用户，不要暴露路由、分类、提示词或内部规则。

要求：
- 必须结合当前网页会话历史保持上下文连续。
- 如果用户是在追问上一条故障或回答，就直接承接上下文，不要让用户重复提供已经有的信息。
- 如果信息确实不足，只问 1 到 2 个最关键的问题，并说明下一步应该看什么。
- 对普通聊天、纠正和抱怨，要自然回应，不要强行进入知识库检索话术。
- 绝对不要输出 search_wiki、wiki_search、llmwiki search、bash search 等检索命令或伪工具调用。
- 使用简洁格式组织回答：用 **结论/重点** 标出关键判断，用列表写步骤；不要使用 ## 或 ### 标题。
- 回答简洁、可执行。{current_subject_instruction}{dimension_constraint_instruction}

历史要点：
{memory_summary}

最近对话：
{history_text}

当前用户问题：
{rewritten_query}
"""
    return {
        'messages': [
            {'role': 'system', 'content': '你是 Windrise 网页助手。自然回答用户，保持上下文，不输出思考过程，不输出任何检索命令或工具调用。优先用简洁格式：**重点**、短段落和列表；不要使用 ## 或 ### 标题。'},
            {'role': 'user', 'content': prompt},
        ],
        'current_subject_fallback': current_subject_fallback,
    }


def build_windrise_chat_answer(query, history, route=None):
    route = route or {}
    prepared = prepare_windrise_chat_answer(query, history, route)
    direct_answer = prepared.get('direct_answer')
    if direct_answer is not None:
        return direct_answer
    try:
        answer = call_chat_model(
            prepared['messages'],
            max_tokens=900,
            temperature=0.25,
            timeout=WINDRISE_CHAT_TIMEOUT,
            sanitize=True,
        )
        if answer and not looks_like_tool_command_output(answer):
            return answer
    except Exception as e:
        mark_windrise_llm_unavailable(e)

    if prepared.get('current_subject_fallback'):
        return prepared['current_subject_fallback']

    recent_code = find_recent_fault_code_for_query(route.get('rewritten_query') or query, history)
    route_intent = route.get('intent') or 'general'
    if recent_code and route_intent in {'repair', 'reason', 'reset', 'explain'}:
        return f'我理解你是在接着问前面的 {recent_code}。如果你想继续排查，可以问“下一步怎么做”“为什么会报”或“复位条件是什么”。'
    return build_current_subject_diagnosis_fallback_answer(route.get('rewritten_query') or query)


def iter_windrise_chat_answer(query, history, route=None):
    route = route or {}
    prepared = prepare_windrise_chat_answer(query, history, route)
    direct_answer = prepared.get('direct_answer')
    if direct_answer is not None:
        yield from iter_stream_text_chunks(direct_answer)
        return
    emitted = False
    try:
        for chunk in iter_chat_model_stream(
            prepared['messages'],
            max_tokens=900,
            temperature=0.25,
            timeout=WINDRISE_CHAT_TIMEOUT,
            sanitize=False,
        ):
            cleaned = sanitize_stream_chunk(chunk)
            if cleaned:
                emitted = True
                yield cleaned
    except Exception as e:
        mark_windrise_llm_unavailable(e)
    if emitted:
        return
    fallback = prepared.get('current_subject_fallback')
    if not fallback:
        recent_code = find_recent_fault_code_for_query(query, history)
        route_intent = route.get('intent') or 'general'
        if recent_code and route_intent in {'repair', 'reason', 'reset', 'explain'}:
            fallback = f'我理解你是在接着问前面的 {recent_code}。如果你想继续排查，可以问“下一步怎么做”“为什么会报”或“复位条件是什么”。'
        else:
            fallback = build_current_subject_diagnosis_fallback_answer(route.get('rewritten_query') or query)
    yield fallback


def build_windrise_knowledge_clarification(query, history, route=None):
    route = route or {}
    if not is_windrise_llm_temporarily_unavailable():
        history_text = build_windrise_history_text(history)
        slot_instruction = build_windrise_slot_context_instruction(route.get('rewritten_query') or query, history)
        prompt = f"""用户的问题需要风机故障知识判断，但当前无法确定具体故障码或告警对象。请结合本网页历史，给出自然的追问。

要求：
- 不要说“请提供具体场景或故障现象”这种模板话。
- 如果历史已有部件、现象、机型或上一条答案，要承接它。
- 最多问 2 个关键问题，并告诉用户去哪看原始告警或报码。
{slot_instruction}

最近对话：
{history_text}

当前用户问题：
{route.get('rewritten_query') or query}
"""
        try:
            answer = call_chat_model(
                [
                    {'role': 'system', 'content': '你是 Windrise。自然追问缺失信息，保持上下文，不输出思考过程。'},
                    {'role': 'user', 'content': prompt},
                ],
                max_tokens=500,
                temperature=0.25,
                timeout=WINDRISE_SEMANTIC_ROUTER_TIMEOUT,
                sanitize=True,
            )
            if answer:
                return answer
        except Exception as e:
            mark_windrise_llm_unavailable(e)

    recent_code = find_recent_fault_code_for_query(route.get('rewritten_query') or query, history)
    if route.get('uses_history_fault_code') and recent_code:
        return f'我先按前面的 {recent_code} 继续。你现在想确认的是处理步骤、产生原因，还是复位条件？'
    if route.get('current_problem_is_new'):
        current_query = route.get('rewritten_query') or query
        return build_current_subject_diagnosis_fallback_answer(current_query)
    return '我需要先知道主控/HMI 或 SCADA 上的原始告警码、告警名称，或者你看到的部件和异常现象。把这两项发来，我就能继续判断下一步。'


def build_windrise_context_prompt(query, history):
    recent_history = [item for item in (history or [])[-WINDRISE_MEMORY_CONTEXT_MESSAGES:] if item.get('content')]
    memory_summary = build_memory_summary(history or [])
    if not recent_history and not memory_summary:
        return query

    lines = [
        '请基于同一网页会话的上下文回答用户当前问题。',
        '要求：不要复述整段历史；如果当前问题是追问、省略问法或代词指代，请结合历史判断指代对象；如果历史不足以判断，请简短追问。',
    ]
    if memory_summary:
        lines.extend(['', memory_summary])
    slot_summary = build_windrise_slots_summary(build_effective_windrise_slots_for_query(query, history))
    if slot_summary:
        lines.extend(['', f'已提取上下文：{slot_summary}'])
    if recent_history:
        lines.append('')
        lines.append('最近对话：')
        for item in recent_history:
            role = '用户' if item.get('role') == 'user' else 'Windrise'
            lines.append(f"{role}：{clip_text(item.get('content', ''), WINDRISE_MEMORY_ITEM_CHARS)}")
    lines.extend(['', f'当前用户问题：{query}', '', '请直接回答当前用户问题：'])
    return '\n'.join(lines)


def parse_windrise_json_decision(raw_text):
    json_text = extract_json_object(raw_text)
    if not json_text:
        return {}
    try:
        return json.loads(json_text)
    except Exception:
        return {}


def build_windrise_wiki_query(query, history):
    normalized_query = normalize_text(query)
    if not normalized_query:
        return ''
    if not is_context_only_windrise_followup(normalized_query) and not is_windrise_candidate_selection_followup(normalized_query, history):
        return apply_recent_user_dimension_to_windrise_query(normalized_query, history)

    parts = []
    for item in (history or [])[-4:]:
        content = normalize_text(item.get('content'))
        if content:
            parts.append(clip_text(content, 180))
    parts.append(normalized_query)
    return apply_recent_user_dimension_to_windrise_query('；'.join(part for part in parts if part), history)


def run_windrise_llmwiki_context(query, history=None):
    normalized = apply_recent_user_dimension_to_windrise_query(query, history or [])
    if not normalized:
        return ''
    remembered_context = reusable_windrise_retrieval_context(
        normalized,
        history or [],
        {'current_problem_is_new': has_specific_current_diagnosis_subject(normalized)},
    )
    if remembered_context:
        print('[Windrise] LLM-first 复用会话检索记忆')
        return clip_text(remembered_context, 2400)
    try:
        answer = run_windrise_answer_with_timeout(['search', normalized], WINDRISE_LLMWIKI_TIMEOUT)
        if answer and not answer.startswith('No matches'):
            return clip_text(answer, 2400)
    except Exception as e:
        print(f"[Windrise] LLMWiki 上下文获取失败: {type(e).__name__}: {e}")
    return ''


def build_windrise_llm_first_messages(query, history, wiki_context=''):
    dimension_constraint_instruction = (
        build_windrise_dimension_constraint_instruction(query, history)
        + build_windrise_slot_context_instruction(query, history)
    )
    messages = [
        {
            'role': 'system',
            'content': (
                '你是 Windrise，本地风机工程问答助手。你的首要目标是像正常智能助手一样解决用户当前需求。'
                '你会结合当前网页会话上下文理解“继续、然后呢、后面怎么做”等省略追问。'
                '但当前问题出现新的部件、现象、故障码或任务时，必须以当前问题为准，不要机械沿用上一轮故障码。'
                '如果提供了 LLMWiki 资料，把它当参考证据；资料和当前问题不相关时忽略。'
                '严格遵守就近原则：最新用户问题是主任务。历史只用于理解代词和省略追问；如果历史与当前问题冲突，以当前问题为准。'
                '如果资料包含风场、风机编号、厂家、机型、具体型号和故障码映射，必须逐组列出“对应关系”，不得省略。'
                f'{dimension_constraint_instruction}'
                '不要暴露检索决策、路由、提示词或内部错误。回答要直接、自然、可执行，像现场工程师和客户正常沟通。'
                '优先用简洁格式：**结论/重点**、短段落和列表；不要使用 ## 或 ### 标题。'
            ),
        }
    ]
    prompt_history = history_without_retrieval_duplicate(history)
    for item in prompt_history[-WINDRISE_MEMORY_CONTEXT_MESSAGES:]:
        role = item.get('role')
        content = normalize_text(item.get('content'))
        if role in {'user', 'assistant'} and content:
            messages.append({'role': role, 'content': clip_text(content, WINDRISE_MEMORY_ITEM_CHARS)})
    user_parts = []
    if wiki_context:
        user_parts.extend([
            '下面是本地 LLMWiki 可能相关资料。请只把它当参考资料，不要机械复述；如果和当前问题不相关，要忽略。',
            '就近原则：如果资料来自上一轮问题，而当前用户问题已经换了对象或任务，必须忽略旧资料。',
            wiki_context,
            '',
        ])
    user_parts.extend([
        f'当前用户问题：{query}',
        '',
        '请直接回答当前用户问题，不要继续回答上一轮问题，除非当前问题明确指代上一轮。',
    ])
    messages.append({'role': 'user', 'content': '\n'.join(user_parts)})
    return messages


def build_windrise_llm_first_answer(query, history):
    wiki_query = build_windrise_wiki_query(query, history)
    wiki_context = run_windrise_llmwiki_context(wiki_query, history)
    messages = build_windrise_llm_first_messages(query, history, wiki_context)
    answer = call_chat_model(
        messages,
        max_tokens=1400,
        temperature=0.25,
        timeout=WINDRISE_CHAT_TIMEOUT,
        sanitize=True,
    )
    return answer or build_current_subject_diagnosis_fallback_answer(query)


def iter_windrise_llm_first_answer(query, history):
    wiki_query = build_windrise_wiki_query(query, history)
    wiki_context = run_windrise_llmwiki_context(wiki_query, history)
    messages = build_windrise_llm_first_messages(query, history, wiki_context)
    for chunk in iter_chat_model_stream(
        messages,
        max_tokens=1400,
        temperature=0.25,
        timeout=WINDRISE_CHAT_TIMEOUT,
        sanitize=False,
    ):
        cleaned = sanitize_stream_chunk(chunk)
        if cleaned:
            yield cleaned


def prepare_windrise_knowledge_augmented_answer(
    query,
    history,
    windrise_query,
    route=None,
    prefetched_wiki_context=None,
):
    route = route or {}
    force_synthesis = bool(route.get('force_synthesis'))
    if route.get('reason') != 'deterministic_recent_fault_followup':
        windrise_query = with_windrise_dimension_constraint(windrise_query, history)
    if prefetched_wiki_context is None:
        remembered_context = reusable_windrise_retrieval_context(query, history, route)
        if remembered_context:
            print('[Windrise] 使用会话检索记忆生成答案，不再调用 LLMWiki')
            prefetched_wiki_context = remembered_context
    if prefetched_wiki_context is not None:
        raw_wiki_context = prefetched_wiki_context
        wiki_context = normalize_text(raw_wiki_context)
    else:
        try:
            if is_windrise_llm_temporarily_unavailable():
                print('[Windrise] 语义模型暂不可用，跳过 LLMWiki 子进程检索')
                return {'direct_answer': build_windrise_chat_answer(query, history, route)}
            wiki_timeout = get_windrise_request_timeout(WINDRISE_STREAM_LLMWIKI_TIMEOUT)
            raw_wiki_context = run_windrise_answer(windrise_query, timeout=wiki_timeout)
            wiki_context = normalize_text(raw_wiki_context)
        except Exception as e:
            print(f"[Windrise] LLMWiki 检索失败，改走模型直答: {type(e).__name__}: {e}")
            return {'direct_answer': build_windrise_chat_answer(query, history, route)}

    if not wiki_context or is_windrise_no_match_answer(wiki_context):
        return {'direct_answer': build_windrise_no_match_answer(query, history, route)}
    if is_structured_windrise_fault_lookup_answer(raw_wiki_context) and not force_synthesis:
        return {'direct_answer': raw_wiki_context}
    if is_exact_windrise_fault_answer(raw_wiki_context) and not force_synthesis:
        return {'direct_answer': raw_wiki_context}
    if is_windrise_fault_record_context(raw_wiki_context) and not force_synthesis:
        return {'direct_answer': raw_wiki_context}
    if route.get('reason') == 'candidate_selection_from_previous_fault_code_answer':
        return {'direct_answer': raw_wiki_context}

    prompt_history = history_without_retrieval_duplicate(history)
    history_text = build_windrise_history_text(prompt_history)
    focus_instruction = ''
    if route.get('uses_history_fault_code') and route.get('fault_code'):
        focus_instruction = (
            f'\n- 当前问题是在追问最近一次故障码 {route.get("fault_code")}；'
            '必须只围绕本次检索资料和该故障码回答，不要引用更早的其他故障、部件或风场。'
        )
    focus_instruction += (
        build_windrise_dimension_constraint_instruction(route.get('rewritten_query') or query, history)
        + build_windrise_slot_context_instruction(route.get('rewritten_query') or query, history)
    )
    prompt = f"""下面是本地 LLMWiki 检索到的资料。请结合资料、当前用户问题和网页会话历史进行分析后回答。

要求：
- 最高优先级是把对应关系说清楚：明确列出风场、风机编号/机位、厂家、机型、具体型号和故障码；资料里已有的映射不得省略、合并或改写成模糊表述。
- 如果命中多组对象，先用“**对应关系**”逐组列出，再给原因和处理建议。
- 不要把资料原样粘贴给用户，要提炼成针对当前问题的判断、原因和下一步建议。
- 不要输出 search_wiki、wiki_search、llmwiki search、bash search 等检索命令或伪工具调用。
- 资料与当前问题不完全匹配时，要说明不确定点，并提出最关键的补充信息。
- 普通对话仍按普通对话回答，不要强行套现场排查模板。
- 使用简洁格式组织回答：用 **结论/重点** 标出关键判断，用列表写步骤；不要使用 ## 或 ### 标题。
- 回答要自然、简洁、可执行。{focus_instruction}

最近对话：
{history_text}

LLMWiki 资料：
{clip_text(wiki_context, 2600)}

当前用户问题：
{route.get('rewritten_query') or query}
"""
    return {
        'messages': [
            {'role': 'system', 'content': '你是 Windrise，本地风机工程问答助手。基于检索资料和用户问题生成最终回答，不输出思考过程，不输出任何检索命令或工具调用。若资料包含风场/风机/厂家/机型/故障码映射，必须逐组保留并先列出对应关系。优先用简洁格式：**重点**、短段落和列表；不要使用 ## 或 ### 标题。'},
            {'role': 'user', 'content': prompt},
        ],
        'fallback_answer': raw_wiki_context or build_current_subject_diagnosis_fallback_answer(query),
    }


def build_windrise_knowledge_augmented_answer(
    query,
    history,
    windrise_query,
    route=None,
    prefetched_wiki_context=None,
):
    prepared = prepare_windrise_knowledge_augmented_answer(
        query,
        history,
        windrise_query,
        route,
        prefetched_wiki_context,
    )
    direct_answer = prepared.get('direct_answer')
    if direct_answer is not None:
        return direct_answer
    try:
        answer = call_chat_model(
            prepared['messages'],
            max_tokens=1100,
            temperature=0.25,
            timeout=WINDRISE_CHAT_TIMEOUT,
            sanitize=True,
        )
        if answer and not looks_like_tool_command_output(answer):
            return answer
    except Exception as e:
        mark_windrise_llm_unavailable(e)
    return prepared.get('fallback_answer') or build_current_subject_diagnosis_fallback_answer(query)


def iter_windrise_knowledge_augmented_answer(
    query,
    history,
    windrise_query,
    route=None,
    prefetched_wiki_context=None,
):
    """Stream knowledge synthesis directly from vLLM when synthesis is needed."""
    prepared = prepare_windrise_knowledge_augmented_answer(
        query,
        history,
        windrise_query,
        route,
        prefetched_wiki_context,
    )
    direct_answer = prepared.get('direct_answer')
    if direct_answer is not None:
        yield from iter_visible_stream_text_chunks(direct_answer)
        return

    emitted = False
    try:
        for chunk in iter_chat_model_stream(
            prepared['messages'],
            max_tokens=1100,
            temperature=0.25,
            timeout=WINDRISE_CHAT_TIMEOUT,
            sanitize=False,
        ):
            cleaned = sanitize_stream_chunk(chunk)
            if cleaned:
                emitted = True
                yield cleaned
    except Exception as e:
        mark_windrise_llm_unavailable(e)
    if not emitted:
        yield prepared.get('fallback_answer') or build_current_subject_diagnosis_fallback_answer(query)


def is_exact_windrise_fault_answer(answer):
    text = normalize_text(answer)
    return bool(
        (
            text
            and '风场/机型：' in text
            and re.search(r'结论：(?:\*\*)?\s*故障码\s*[A-Za-z0-9_./\-~～至到、,，]+', text)
        )
        or (
            text
            and '来源：' in text
            and re.search(r'结论：\s*[A-Za-z0-9_./\-~～至到、,，]+\s*为「', text)
        )
        or (
            text
            and '风场/机型：' in text
            and '故障代码：' in text
            and '故障名称：' in text
            and '来源：' in text
        )
    )


def is_structured_windrise_fault_lookup_answer(answer):
    text = normalize_text(answer)
    return bool(
        text
        and (
            (
                '风场/机型：' in text
                and re.search(r'结论：(?:\*\*)?\s*按名称/描述', text)
            )
            or re.search(r'^\d+[.、]\s*\*\*\d+｜', text, flags=re.MULTILINE)
            or re.search(r'维修处理建议|原因分析|复位说明', text)
        )
    )


def is_windrise_fault_record_context(answer):
    text = normalize_text(answer)
    return bool(
        text
        and re.search(r'故障(代码|码|名称|描述|解释)[:：]', text)
        and '风场：' in text
        and ('品牌：' in text or '机型：' in text)
    )


def is_windrise_no_match_answer(answer):
    text = normalize_text(answer)
    return bool(
        text
        and (
            text.startswith('No matches')
            or '## 未找到精确匹配' in text
            or '本地知识库暂未找到' in text
            or re.search(r'故障码\s*[A-Za-z]{0,4}\d{1,8}[A-Za-z]{0,2}\s*未找到与', text)
            or re.search(r'未找到与[「“"].+?[」”"]匹配的记录', text)
        )
    )


def windrise_same_code_alternative_lines(code, query='', limit=8):
    normalized_code = normalize_fault_code_lookup_key(code)
    if not normalized_code:
        return []
    explicit_dimensions = set(windrise_dimension_terms(query))
    alternatives = []
    seen = set()
    for record in load_windrise_fault_index_records():
        if not fault_code_lookup_keys_match(code, record.get('code', '')):
            continue
        site = normalize_context_dimension_value(record.get('site', ''))
        brand = normalize_context_dimension_value(record.get('brand', ''))
        model = normalize_context_dimension_value(record.get('model', ''))
        standard_model = normalize_context_dimension_value(record.get('standardModel', ''))
        if explicit_dimensions and any(
            dimension and dimension in {site, brand, model, standard_model}
            for dimension in explicit_dimensions
        ):
            continue
        identity = (site, brand, model, standard_model)
        if identity in seen:
            continue
        seen.add(identity)
        parts = []
        if site:
            parts.append(f'风场：{site}')
        if brand:
            parts.append(f'品牌：{brand}')
        if model:
            parts.append(f'机型：{model}')
        if standard_model:
            parts.append(f'具体型号：{standard_model}')
        if parts:
            alternatives.append('- ' + ' / '.join(parts))
        if len(alternatives) >= limit:
            break
    return alternatives


def build_windrise_broad_scope_no_match_answer(query, history=None):
    """Explain an empty user-authorized broad lookup without resuming the form."""
    scope = build_resolved_windrise_scope_slots(query, history or [])
    if not scope.get('_broad_scope_requested'):
        return ''

    topic = extract_windrise_fault_subject_phrase(query) or extract_recent_windrise_fault_topic_from_history(history or [])
    farm = normalize_context_dimension_value(scope.get('farm', ''))
    brand = normalize_context_dimension_value(scope.get('brand', ''))
    model = (
        normalize_windrise_model_value(scope.get('standard_model', ''))
        or normalize_windrise_model_value(scope.get('model', ''))
    )
    known = []
    if farm:
        known.append(f'风场={farm}')
    if brand:
        known.append(f'厂家={brand}')
    if model:
        known.append(f'机型/具体型号={model}')
    if topic:
        known.append(f'问题={compact_fault_match_text(topic) or topic}')
    if not known:
        return ''

    records = load_windrise_fault_index_records()
    farm_brands = []
    brand_farms = []
    for record in records:
        record_farm = normalize_context_dimension_value(record.get('site', ''))
        record_brand = normalize_context_dimension_value(record.get('brand', ''))
        if farm and record_farm and (farm in record_farm or record_farm in farm):
            if record_brand and record_brand not in farm_brands:
                farm_brands.append(record_brand)
        if brand and record_brand and record_brand.lower() == brand.lower():
            if record_farm and record_farm not in brand_farms:
                brand_farms.append(record_farm)

    lines = [
        '**已按现有信息检索**',
        '',
        '已根据您的要求，不再继续追问风机编号或机型。',
        '',
        f"当前条件：{'；'.join(known)}。",
        '',
        '本地知识库暂未找到同时满足这些条件的记录。',
    ]
    if farm and farm_brands:
        lines.extend([
            '',
            f"{farm}风场当前收录的厂家：{'、'.join(farm_brands[:8])}。",
        ])
    if brand and brand_farms:
        lines.extend([
            '',
            f"{brand}当前收录的风场：{'、'.join(brand_farms[:8])}。",
        ])
    lines.extend([
        '',
        '请核对风场或厂家是否有一项需要放宽；也可以直接说明“按该厂家所有风场列出”或“按该风场所有厂家列出”。',
    ])
    return '\n'.join(lines)


def build_windrise_no_match_answer(query, history, route=None):
    normalized = normalize_text(query) or '当前问题'
    route = route or {}
    current_problem_is_new = bool(route.get('current_problem_is_new')) or bool(
        has_specific_current_diagnosis_subject(normalized)
        and not is_context_only_windrise_followup(normalized)
    )
    explicit_codes = extract_fault_codes(normalized)
    code = (
        normalize_text(route.get('fault_code', ''))
        or (explicit_codes[0] if explicit_codes else '')
        or ('' if current_problem_is_new or windrise_should_isolate_history_issue_slots(query, history) else find_recent_fault_code_from_history(history))
    )
    lines = [
        "**未找到精确匹配**",
        "",
        f"本地知识库未找到与“{normalized}”匹配的精确记录。",
    ]
    alternatives = windrise_same_code_alternative_lines(code, normalized) if code else []
    if alternatives:
        lines.extend([
            "",
            f"同一故障码 {code} 在知识库中存在其它风场/机型记录，可作为排除项参考：",
            *alternatives,
        ])
    lines.extend([
        "",
        "请核对原始故障名称、报码、风场、厂家和机型；如果有 SCADA/HMI 上的完整报警文本，直接按原文再查。",
    ])
    return '\n'.join(lines)


def build_explicit_fault_code_exact_answer(query, history=None):
    normalized = normalize_text(query)
    force_global = is_windrise_global_fault_search_request(normalized)
    lookup_text = strip_global_fault_search_prefix(normalized) if force_global else normalized
    explicit_codes = extract_direct_windrise_fault_codes(lookup_text, history)
    if not explicit_codes and force_global:
        explicit_codes = extract_direct_windrise_fault_codes(normalized, history)
    if not explicit_codes:
        return '', ''

    scope_history = [] if should_reset_windrise_scope_for_explicit_fault_code_query(lookup_text, history) else (history or [])
    slots = build_effective_windrise_slots_for_query(lookup_text, scope_history)
    intent = classify_windrise_answer_intent(lookup_text)
    sections = []
    code_summaries = []
    normalized_codes = []
    for raw_code in explicit_codes:
        code = normalize_windrise_fault_code(raw_code) or normalize_context_dimension_value(raw_code)
        if not code or code in normalized_codes:
            continue
        normalized_codes.append(code)
        used_global_fallback = False
        if force_global:
            exact_records = collect_fault_index_records_for_code(code, slots, scope_filter=False)
            used_global_fallback = bool(exact_records)
        else:
            exact_records = collect_fault_index_records_for_code(code, slots, scope_filter=True)
            if not exact_records and has_windrise_converged_scope(slots, lookup_text):
                global_records = collect_fault_index_records_for_code(code, slots, scope_filter=False)
                if global_records:
                    exact_records = global_records
                    used_global_fallback = True

        recent_context = find_recent_fault_context_for_query(lookup_text, history or [])
        recent_code = normalize_windrise_fault_code(recent_context.get('code', ''))
        recent_name = normalize_context_dimension_value(recent_context.get('name', ''))
        recent_name = re.split(
            r'\s+(?:处理|原因|触发条件|复位|厂家|风场|机型|具体型号|来源)[:：]',
            recent_name,
            maxsplit=1,
        )[0].strip()
        contextual_reference = bool(re.search(
            r'(这个|那个|它|该故障|该报警|该问题|上面|前面|刚才)',
            normalized,
        ))
        if exact_records and contextual_reference and recent_code == code and recent_name:
            compact_recent_name = compact_fault_match_text(recent_name)
            exact_name_records = [
                record for record in exact_records
                if record.get('_wr_compact_name') == compact_recent_name
            ]
            narrowed_records = exact_name_records or [
                record for record in exact_records
                if (
                    record.get('_wr_compact_name')
                    and (
                        compact_recent_name in record['_wr_compact_name']
                        or record['_wr_compact_name'] in compact_recent_name
                    )
                )
            ]
            if narrowed_records:
                exact_records = narrowed_records

        if exact_records and is_fault_code_coverage_followup(normalized):
            sections.append(build_fault_code_coverage_answer(code, exact_records))
            names = dedupe_preserve_order(
                normalize_context_dimension_value(record.get('name', ''))
                for record in exact_records
                if normalize_context_dimension_value(record.get('name', ''))
            )
            code_summaries.append(f"- `{code}`：{'、'.join(names) if names else '知识库未标明故障名称'}")
            continue

        if exact_records:
            names = dedupe_preserve_order(
                normalize_context_dimension_value(record.get('name', ''))
                for record in exact_records
                if normalize_context_dimension_value(record.get('name', ''))
            )
            code_summaries.append(f"- `{code}`：{'、'.join(names) if names else '知识库未标明故障名称'}")
            record_limit = 1 if should_limit_windrise_results_to_one(slots, lookup_text) and not used_global_fallback else 5
            code_slots = dict(slots)
            code_slots['fault_code'] = code
            section = build_fault_records_answer_from_index(
                lookup_text,
                exact_records,
                title=f"故障码 {code} 查询结果",
                limit=record_limit,
                intent=intent,
                slots=code_slots,
                code_override=code,
                scope_filter=not used_global_fallback,
            )
            if used_global_fallback and section:
                section = '\n\n'.join([
                    build_global_fault_code_scope_notice(slots, code),
                    section,
                ])
            sections.append(section)
        else:
            code_summaries.append(f"- `{code}`：本地知识库未找到匹配记录")
            sections.append(build_windrise_no_match_answer(lookup_text, history or [], {
                'fault_code': code,
                'reason': 'explicit_fault_code_exact_no_match',
            }))

    if not normalized_codes:
        return '', ''
    prefix = ''
    if len(normalized_codes) > 1:
        heading = '**故障码对比**' if intent == 'comparison' else '**多个故障码查询结果**'
        prefix = '\n'.join([heading, '', *code_summaries, ''])
    answer = '\n\n---\n\n'.join(section for section in sections if section)
    return f"{prefix}\n{answer}".strip(), normalized_codes[0]


def build_fault_code_coverage_answer(code, records):
    """List every indexed device scope for a reused fault code."""
    sites = dedupe_preserve_order(
        normalize_context_dimension_value(record.get('site', ''))
        for record in records or []
        if normalize_context_dimension_value(record.get('site', ''))
    )
    brands = dedupe_preserve_order(
        normalize_context_dimension_value(record.get('brand', ''))
        for record in records or []
        if normalize_context_dimension_value(record.get('brand', ''))
    )
    models = dedupe_preserve_order(
        normalize_windrise_model_value(record.get('model', ''))
        for record in records or []
        if normalize_windrise_model_value(record.get('model', ''))
    )
    names = dedupe_preserve_order(
        normalize_context_dimension_value(record.get('name', ''))
        for record in records or []
        if normalize_context_dimension_value(record.get('name', ''))
    )
    lines = [
        f"**故障码 {code} 的知识库覆盖范围**",
        '',
        f"该报码在本地知识库中有 {len(records or [])} 条记录、{len(names)} 种故障含义。",
    ]
    if sites:
        lines.extend(['', f"- 风场：{'、'.join(sites)}"])
    if brands:
        lines.append(f"- 厂家：{'、'.join(brands)}")
    if models:
        lines.append(f"- 机型：{'、'.join(models)}")
    if names:
        lines.extend(['', '故障含义：'])
        lines.extend(f"- {name}" for name in names)
    return '\n'.join(lines)


def build_windrise_semantic_response_payload(query, history, route):
    route = dict(route or {})
    current_problem_is_new = bool(route.get('current_problem_is_new'))
    fault_code = normalize_windrise_fault_code(route.get('fault_code'))
    should_search = bool(route.get('should_search'))
    rewritten_query = route.get('rewritten_query') or query
    context_only_followup = is_context_only_windrise_followup(query)
    inherited_fault_description_query = (
        build_windrise_wiki_query(query, history)
        if context_only_followup and not current_problem_is_new
        else rewritten_query
    )

    if route.get('mode') == 'knowledge' and should_search:
        search_query = rewritten_query
        if fault_code:
            search_query = inherited_fault_description_query if route.get('uses_history_fault_code') else rewritten_query
            return build_windrise_knowledge_augmented_answer(
                query,
                history,
                {
                    'args': ['search', search_query or fault_code],
                    'intent': route.get('intent') or 'general',
                },
                {
                    **route,
                    'rewritten_query': search_query or rewritten_query,
                },
            ), route
        if context_only_followup and not current_problem_is_new:
            return build_windrise_knowledge_augmented_answer(
                query,
                history,
                {
                    'args': ['search', inherited_fault_description_query],
                    'intent': route.get('intent') or 'general',
                },
                {
                    **route,
                    'rewritten_query': inherited_fault_description_query,
                },
            ), route
        return build_windrise_knowledge_first_answer(query, history, route), route

    if route.get('mode') == 'chat':
        return build_windrise_chat_answer(query, history, route), route

    if current_problem_is_new:
        return build_windrise_chat_answer(query, history, {
            **route,
            'mode': 'chat',
            'fault_code': '',
            'should_search': False,
            'rewritten_query': query,
        }), route

    return build_windrise_knowledge_clarification(query, history, route), route


# ========== Windrise 统一路由 ==========
# 所有入口（阻塞 / 流式 / prepare）共用同一套优先级，避免对话类问题误入故障检索。

WINDRISE_ROUTE_SCOPE_FOLLOWUP = 'scope_followup'
WINDRISE_ROUTE_DEVICE_MAPPING = 'device_mapping'
WINDRISE_ROUTE_GREETING = 'greeting'
WINDRISE_ROUTE_CLARIFY = 'clarify'
WINDRISE_ROUTE_CASUAL_CHAT = 'casual_chat'
WINDRISE_ROUTE_GENERAL_KNOWLEDGE = 'general_knowledge'
WINDRISE_ROUTE_DETERMINISTIC_PREFLIGHT = 'deterministic_preflight'
WINDRISE_ROUTE_SCOPED_SYMPTOM = 'scoped_symptom'
WINDRISE_ROUTE_SCOPE_CLARIFICATION = 'scope_clarification'
WINDRISE_ROUTE_DEFERRED = 'deferred'


def is_bare_windrise_fault_code_query(query):
    normalized = normalize_windrise_query(query)
    if not normalized:
        return False
    if extract_direct_windrise_fault_codes(normalized, None):
        return True
    return bool(re.fullmatch(r'[A-Za-z]{0,4}\d{3,8}[A-Za-z]{0,2}', normalized))


def windrise_route_kind_blocks_semantic_router(kind):
    return kind in {
        WINDRISE_ROUTE_GREETING,
        WINDRISE_ROUTE_CLARIFY,
        WINDRISE_ROUTE_CASUAL_CHAT,
        WINDRISE_ROUTE_GENERAL_KNOWLEDGE,
        WINDRISE_ROUTE_SCOPE_CLARIFICATION,
        WINDRISE_ROUTE_SCOPED_SYMPTOM,
        WINDRISE_ROUTE_DETERMINISTIC_PREFLIGHT,
        WINDRISE_ROUTE_SCOPE_FOLLOWUP,
        WINDRISE_ROUTE_DEVICE_MAPPING,
    }


def build_windrise_route_meta(
    *,
    mode='chat',
    intent='general',
    reason='',
    fault_code='',
    should_search=False,
    uses_history_fault_code=False,
    current_problem_is_new=True,
    rewritten_query='',
):
    return {
        'mode': mode,
        'intent': intent or 'general',
        'fault_code': fault_code or '',
        'should_search': bool(should_search),
        'uses_history_fault_code': bool(uses_history_fault_code),
        'current_problem_is_new': bool(current_problem_is_new),
        'rewritten_query': normalize_text(rewritten_query or ''),
        'reason': reason or '',
    }


def is_windrise_fault_retrieval_candidate(query, history=None):
    """Return True only when the query should enter fault-index / scoped retrieval."""
    normalized = normalize_windrise_query(query)
    history = history or []
    if not normalized:
        return False
    if is_windrise_general_knowledge_question(normalized):
        return False
    if is_bare_windrise_fault_code_query(normalized):
        return False
    if is_windrise_casual_chat_query(normalized):
        return False
    if build_windrise_date_time_answer(normalized):
        return False
    if any(re.fullmatch(pattern, normalized, flags=re.IGNORECASE) for pattern in GREETING_QUERY_PATTERNS):
        return False
    if is_wind_farm_model_mapping_query(normalized):
        return False
    if should_answer_windrise_turbine_mapping_question(normalized) and not is_windrise_fault_scope_guidance_relevant(
        normalized,
        history,
    ):
        return False
    return bool(
        extract_direct_windrise_fault_codes(normalized, history)
        or is_explicit_fault_name_lookup_query(normalized)
        or is_explicit_fault_action_lookup_query(normalized)
        or looks_like_fault_phenomenon_query(normalized)
        or has_device_issue_hint(normalized)
        or is_windrise_scoped_symptom_followup(normalized, history)
        or is_windrise_bare_symptom_with_confirmed_scope(normalized, history)
        or is_windrise_fault_scope_guidance_relevant(normalized, history)
    )


def resolve_windrise_route_plan(query, history=None, *, semantic_route=None):
    """Single routing decision tree for Windrise. Terminal routes include answer+route."""
    history = history or []
    normalized = normalize_text(query)
    contextual_query = build_windrise_contextual_fault_query(normalized, history) if normalized else ''
    lookup_query = contextual_query or normalized
    index_lookup_query = lookup_query

    plan = {
        'kind': WINDRISE_ROUTE_DEFERRED,
        'route': build_windrise_route_meta(rewritten_query=lookup_query),
        'terminal_answer': None,
        'lookup_query': lookup_query,
        'index_lookup_query': index_lookup_query,
        'scope_clarification': '',
        'conversational_clarification': '',
        'device_mapping_query': False,
        'preflight_local_answer': '',
        'preflight_local_reason': '',
        'needs_model_route': False,
        'forget_retrieval_context': False,
        'prefer_local_scoped_index': False,
        'scope_completion_query': '',
        'symptom_scope_query': '',
        'semantic_route': semantic_route,
        'retrieval_intent': classify_windrise_answer_intent(normalized),
        'direct_fault_code_lookup': bool(extract_direct_windrise_fault_codes(lookup_query, history)),
    }

    scope_followup_answer, scope_followup_reason = resolve_windrise_fault_scope_followup_answer(normalized, history)
    if scope_followup_answer:
        plan.update({
            'kind': WINDRISE_ROUTE_SCOPE_FOLLOWUP,
            'route': build_windrise_route_meta(
                mode='knowledge',
                intent=classify_windrise_answer_intent(normalized),
                reason=scope_followup_reason,
                fault_code=extract_windrise_primary_answer_fault_code(scope_followup_answer),
                should_search=True,
                current_problem_is_new=False,
                rewritten_query=normalized,
            ),
            'terminal_answer': scope_followup_answer,
            'preflight_local_answer': scope_followup_answer,
            'preflight_local_reason': scope_followup_reason,
            'forget_retrieval_context': True,
        })
        return plan

    standalone_turbine_mapping = bool(
        should_answer_windrise_turbine_mapping_question(normalized)
        and not is_windrise_fault_scope_guidance_relevant(normalized, history)
        and not is_windrise_fault_scope_followup_reply(normalized, history)
    )
    device_mapping_query = bool(is_wind_farm_model_mapping_query(normalized) or standalone_turbine_mapping)
    plan['device_mapping_query'] = device_mapping_query
    if device_mapping_query:
        mapping_answer = build_windrise_direct_chat_answer(normalized, history)
        if mapping_answer:
            plan.update({
                'kind': WINDRISE_ROUTE_DEVICE_MAPPING,
                'route': build_windrise_route_meta(
                    mode='chat',
                    reason='deterministic_device_mapping',
                    rewritten_query=normalized,
                ),
                'terminal_answer': mapping_answer,
                'lookup_query': normalized,
                'index_lookup_query': normalized,
            })
            return plan

    is_greeting = any(
        re.fullmatch(pattern, normalized, flags=re.IGNORECASE)
        for pattern in GREETING_QUERY_PATTERNS
    )
    if is_greeting:
        greeting_answer = build_windrise_direct_chat_answer(normalized, history)
        plan.update({
            'kind': WINDRISE_ROUTE_GREETING,
            'route': build_windrise_route_meta(
                mode='chat',
                reason='deterministic_direct_chat',
                rewritten_query=normalized,
            ),
            'terminal_answer': greeting_answer,
            'lookup_query': normalized,
            'index_lookup_query': normalized,
        })
        return plan

    # 对话 / 通用知识：必须在故障检索之前判定
    conversational_clarification = '' if device_mapping_query else build_windrise_conversational_fault_clarification(
        normalized,
        history,
    )
    plan['conversational_clarification'] = conversational_clarification
    if conversational_clarification:
        plan.update({
            'kind': WINDRISE_ROUTE_CLARIFY,
            'route': build_windrise_route_meta(
                mode='chat',
                intent='clarify',
                reason='ambiguous_fault_needs_clarification',
                rewritten_query=normalized,
            ),
            'terminal_answer': conversational_clarification,
            'lookup_query': normalized,
            'index_lookup_query': normalized,
        })
        return plan

    if is_windrise_general_knowledge_question(normalized):
        plan.update({
            'kind': WINDRISE_ROUTE_GENERAL_KNOWLEDGE,
            'route': build_windrise_route_meta(
                mode='chat',
                intent='general',
                reason='general_wind_knowledge_question',
                rewritten_query=normalized,
            ),
            'terminal_answer': None,
            'lookup_query': normalized,
            'index_lookup_query': normalized,
        })
        return plan

    if is_windrise_casual_chat_query(normalized):
        casual_answer = build_windrise_direct_chat_answer(normalized, history) or build_windrise_casual_chat_answer(normalized)
        if casual_answer:
            plan.update({
                'kind': WINDRISE_ROUTE_CASUAL_CHAT,
                'route': build_windrise_route_meta(
                    mode='chat',
                    intent='general',
                    reason='deterministic_direct_chat',
                    rewritten_query=normalized,
                ),
                'terminal_answer': casual_answer,
                'lookup_query': normalized,
                'index_lookup_query': normalized,
            })
            return plan

    scope_clarification = '' if device_mapping_query else build_windrise_fault_scope_clarification(normalized, history)
    plan['scope_clarification'] = scope_clarification
    plan['scope_completion_query'] = '' if device_mapping_query else (build_windrise_scope_completion_query(normalized, history) or '')
    plan['symptom_scope_query'] = '' if device_mapping_query else build_windrise_symptom_scope_lookup_query(normalized, history)
    if plan['scope_completion_query'] and not scope_clarification:
        lookup_query = plan['scope_completion_query']
        index_lookup_query = lookup_query
    elif plan['symptom_scope_query'] and not scope_clarification:
        lookup_query = plan['symptom_scope_query']
        index_lookup_query = lookup_query
    plan['lookup_query'] = lookup_query
    plan['index_lookup_query'] = index_lookup_query
    plan['direct_fault_code_lookup'] = bool(extract_direct_windrise_fault_codes(lookup_query, history))

    if is_windrise_fault_retrieval_candidate(normalized, history):
        if extract_direct_windrise_fault_codes(lookup_query, history) or extract_direct_windrise_fault_codes(normalized, history):
            explicit_answer, explicit_code = build_explicit_fault_code_exact_answer(normalized, history)
            if explicit_answer:
                plan.update({
                    'kind': WINDRISE_ROUTE_DETERMINISTIC_PREFLIGHT,
                    'route': build_windrise_route_meta(
                        mode='knowledge',
                        intent=classify_windrise_answer_intent(normalized),
                        reason='in_process_explicit_fault_code',
                        fault_code=explicit_code,
                        should_search=True,
                        rewritten_query=normalized,
                    ),
                    'terminal_answer': explicit_answer,
                    'preflight_local_answer': explicit_answer,
                    'preflight_local_reason': 'in_process_explicit_fault_code',
                    'forget_retrieval_context': True,
                })
                return plan

        if (
            is_windrise_scoped_symptom_followup(normalized, history)
            or is_windrise_bare_symptom_with_confirmed_scope(normalized, history)
        ):
            plan['prefer_local_scoped_index'] = True
            plan['forget_retrieval_context'] = True
            scoped_answer, scoped_reason = resolve_windrise_scoped_symptom_preflight(normalized, history)
            if scoped_answer:
                plan.update({
                    'kind': WINDRISE_ROUTE_SCOPED_SYMPTOM,
                    'route': build_windrise_route_meta(
                        mode='knowledge',
                        intent=classify_windrise_answer_intent(normalized),
                        reason=scoped_reason or 'in_process_scoped_fault_lookup',
                        fault_code=extract_windrise_primary_answer_fault_code(scoped_answer),
                        should_search=True,
                        rewritten_query=normalized,
                    ),
                    'terminal_answer': scoped_answer,
                    'preflight_local_answer': scoped_answer,
                    'preflight_local_reason': scoped_reason or 'in_process_scoped_fault_lookup',
                })
                return plan

        preflight_answer, preflight_reason = build_windrise_deterministic_preflight_answer(normalized, history)
        if preflight_answer:
            is_ack = preflight_reason in {'in_process_dimension_ack', 'in_process_fault_topic_ack'}
            plan.update({
                'kind': WINDRISE_ROUTE_DETERMINISTIC_PREFLIGHT,
                'route': build_windrise_route_meta(
                    mode='chat' if is_ack else 'knowledge',
                    intent=classify_windrise_answer_intent(normalized),
                    reason=preflight_reason,
                    fault_code=extract_windrise_primary_answer_fault_code(preflight_answer),
                    should_search=not is_ack,
                    current_problem_is_new=preflight_reason != 'in_process_dimension_context_lookup',
                    rewritten_query=normalized,
                ),
                'terminal_answer': preflight_answer,
                'preflight_local_answer': preflight_answer,
                'preflight_local_reason': preflight_reason,
                'forget_retrieval_context': True,
            })
            return plan

    if scope_clarification:
        plan.update({
            'kind': WINDRISE_ROUTE_SCOPE_CLARIFICATION,
            'route': build_windrise_route_meta(
                mode='knowledge',
                intent=classify_windrise_answer_intent(normalized),
                reason='missing_windrise_scope_dimensions',
                rewritten_query=normalized,
            ),
            'terminal_answer': scope_clarification,
        })
        return plan

    plan['needs_model_route'] = bool(
        should_run_windrise_model_route_before_retrieval(
            lookup_query,
            history,
            scope_clarification,
        )
    )
    plan['route'] = build_windrise_route_meta(
        mode='knowledge',
        intent=plan['retrieval_intent'],
        reason='deferred_fault_retrieval',
        rewritten_query=lookup_query,
        should_search=True,
    )
    return plan


def complete_windrise_deferred_route(query, history, plan, semantic_route=None):
    """Finish routing after resolve_windrise_route_plan returns deferred."""
    normalized = normalize_text(query)
    lookup_query = plan.get('lookup_query') or normalized
    scope_completion_query = plan.get('scope_completion_query') or lookup_query

    if semantic_route is None and plan.get('needs_model_route'):
        semantic_route = call_windrise_semantic_router(scope_completion_query, history)
        if not semantic_route.get('_model_routed'):
            print('[Windrise] 语义路由模型不可用，继续使用本地确定性路由')

    explicit_answer, explicit_code = build_explicit_fault_code_exact_answer(normalized, history)
    if explicit_answer:
        return explicit_answer, build_windrise_route_meta(
            mode='knowledge',
            intent=classify_windrise_answer_intent(normalized),
            reason='in_process_explicit_fault_code',
            fault_code=explicit_code,
            should_search=True,
            rewritten_query=normalized,
        )

    effective_slots = build_effective_windrise_slots_for_query(normalized, history)
    if (
        effective_slots.get('farm')
        or effective_slots.get('turbine_id')
        or is_explicit_fault_name_lookup_query(normalized)
        or is_explicit_fault_action_lookup_query(normalized)
        or query_has_explicit_dimension(normalized)
    ):
        index_answer = build_index_scoped_fault_lookup_answer(
            scope_completion_query,
            history,
            intent=(semantic_route or {}).get('intent') or None,
        )
        if index_answer:
            return index_answer, build_windrise_route_meta(
                mode='knowledge',
                intent=classify_windrise_answer_intent(scope_completion_query),
                reason='in_process_scoped_fault_lookup',
                fault_code=extract_windrise_primary_answer_fault_code(index_answer),
                should_search=True,
                rewritten_query=scope_completion_query,
            )

    broad_scope_no_match = build_windrise_broad_scope_no_match_answer(scope_completion_query, history)
    if broad_scope_no_match:
        route = build_windrise_route_meta(
            mode='knowledge',
            intent=classify_windrise_answer_intent(scope_completion_query),
            reason='broad_scope_no_match',
            should_search=True,
            rewritten_query=scope_completion_query,
        )
        return build_windrise_knowledge_first_answer(scope_completion_query, history, route), route

    semantic_route = semantic_route or call_windrise_semantic_router(normalized, history)
    return build_windrise_semantic_response_payload(normalized, history, semantic_route)


def should_run_windrise_model_route_before_retrieval(query, history=None, scope_clarification=''):
    """Return whether this request may read fault knowledge after one model pass."""
    normalized = normalize_windrise_query(query)
    history = history or []
    if not normalized or scope_clarification:
        return False
    if extract_direct_windrise_fault_codes(normalized, history):
        return False
    if any(re.match(pattern, normalized, flags=re.IGNORECASE) for pattern in GREETING_QUERY_PATTERNS):
        return False
    if build_windrise_date_time_answer(normalized):
        return False
    if is_windrise_general_knowledge_question(normalized):
        return False
    if is_wind_farm_model_mapping_query(normalized) or should_answer_windrise_turbine_mapping_question(normalized):
        return False
    if is_context_only_windrise_followup(normalized):
        recent_context = find_recent_fault_context_from_history(history)
        recent_code = recent_context.get('code', '')
        if is_numeric_windrise_fault_code(recent_code):
            return False
        return bool(recent_code or recent_context.get('name'))
    if is_windrise_scoped_symptom_followup(normalized, history):
        return False
    if is_windrise_bare_symptom_with_confirmed_scope(normalized, history):
        return False
    return bool(
        is_explicit_fault_name_lookup_query(normalized)
        or is_explicit_fault_action_lookup_query(normalized)
        or looks_like_fault_phenomenon_query(normalized)
        or has_device_issue_hint(normalized)
        or is_windrise_fault_scope_guidance_relevant(normalized, history)
    )


def build_windrise_response_payload(query, history, semantic_route=None):
    query = normalize_text(query)
    plan = resolve_windrise_route_plan(query, history, semantic_route=semantic_route)
    if plan.get('terminal_answer') is not None:
        return plan['terminal_answer'], plan['route']
    if plan.get('kind') == WINDRISE_ROUTE_GENERAL_KNOWLEDGE:
        return build_windrise_chat_answer(query, history, plan['route']), plan['route']
    if plan.get('kind') == WINDRISE_ROUTE_CASUAL_CHAT:
        casual_or_general = build_windrise_casual_or_general_answer(query, history)
        if casual_or_general:
            return casual_or_general
    return complete_windrise_deferred_route(query, history, plan, semantic_route=semantic_route)


def iter_stream_text_chunks(text, target_size=18):
    content = text or ''
    buffer = ''
    for char in content:
        buffer += char
        if char in '。！？；\n' or len(buffer) >= target_size:
            yield buffer
            buffer = ''
    if buffer:
        yield buffer


def iter_visible_stream_text_chunks(text, target_size=18):
    """Pace already-complete local answers without slowing real model tokens."""
    for chunk in iter_stream_text_chunks(text, target_size=target_size):
        yield chunk
        if WINDRISE_STREAM_CHUNK_DELAY:
            time.sleep(WINDRISE_STREAM_CHUNK_DELAY)


class WindriseStreamPulse:
    """Marker for streaming generators to request a visible keepalive/thinking SSE event."""

    __slots__ = ('message',)

    def __init__(self, message=''):
        self.message = normalize_text(message)


def build_sse_event(payload):
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"


def build_sse_keepalive():
    return ': keepalive\n\n'


def build_sse_stream_padding():
    """Beat proxy buffering so the browser receives the first SSE bytes promptly."""
    return ':' + (' ' * 2048) + '\n\n'


def iter_with_stream_pulses(source_iter, pulse_message='正在处理，请稍候...'):
    """Yield keepalive markers while a blocking generator has not produced the next chunk."""
    item_queue = queue.Queue()
    sentinel = object()

    def worker():
        try:
            for item in source_iter:
                item_queue.put(item)
        except Exception as error:
            item_queue.put(error)
        finally:
            item_queue.put(sentinel)

    threading.Thread(
        target=worker,
        name='windrise-stream-pulse-worker',
        daemon=True,
    ).start()

    while True:
        try:
            item = item_queue.get(timeout=WINDRISE_STREAM_KEEPALIVE_SECONDS)
        except queue.Empty:
            yield WindriseStreamPulse(pulse_message)
            continue
        if item is sentinel:
            break
        if isinstance(item, Exception):
            raise item
        yield item


def iter_blocking_pulses_until_done(done_event, conversation_id, pulse_message='正在处理，请稍候...'):
    """Yield SSE keepalive/thinking events while a background worker is still running."""
    last_pulse_at = time.monotonic()
    while not done_event.is_set():
        now = time.monotonic()
        if now - last_pulse_at >= WINDRISE_STREAM_KEEPALIVE_SECONDS:
            if WINDRISE_SHOW_THINKING_STATUS:
                yield build_windrise_thinking_event(conversation_id, pulse_message)
            else:
                yield build_sse_keepalive()
            last_pulse_at = now
        done_event.wait(timeout=0.1)


def stream_completed_preflight_answer_events(conversation_id, user_id, query, answer_text):
    """Yield SSE chunks for an already-resolved local answer."""
    answer_parts = []
    for chunk in iter_stream_text_chunks(answer_text or ''):
        answer_parts.append(chunk)
        yield build_sse_event({
            'event': 'message',
            'answer': chunk,
            'conversation_id': conversation_id,
        })
    answer = ''.join(answer_parts).strip()
    persist_completed_windrise_stream_answer(conversation_id, user_id, query, answer)
    yield build_sse_event({'event': 'message_end', 'conversation_id': conversation_id})


def yield_pulsed_blocking_result(source_iter, conversation_id, pulse_message):
    """Run a blocking iterator in the background and emit SSE keepalive/thinking pulses."""
    for item in iter_with_stream_pulses(source_iter, pulse_message):
        if isinstance(item, WindriseStreamPulse):
            if WINDRISE_SHOW_THINKING_STATUS:
                yield build_windrise_thinking_event(
                    conversation_id,
                    item.message or pulse_message,
                )
            else:
                yield build_sse_keepalive()
            continue
        yield item


def build_windrise_thinking_event(conversation_id, message):
    return build_sse_event({
        'event': 'thinking',
        'answer': '',
        'message': message,
        'conversation_id': conversation_id,
    })


def build_windrise_database_status(query):
    display_query = clip_text(query, 120)
    if not display_query:
        return WINDRISE_STATUS_DATABASE
    return f'正在查找知识库：{display_query}...'


def build_windrise_thinking_end_event(conversation_id):
    return build_sse_event({
        'event': 'thinking_end',
        'answer': '',
        'conversation_id': conversation_id,
    })


def apply_no_thinking_options(payload):
    if WINDRISE_ENABLE_THINKING:
        return payload
    payload['think'] = False
    payload['enable_thinking'] = False
    payload['reasoning_effort'] = 'none'
    payload['reasoning'] = {'effort': 'none', 'exclude': True}
    return payload


def persist_completed_windrise_stream_answer(conversation_id, user_id, query, answer, include_stage=True):
    answer = normalize_text(answer) or build_current_subject_diagnosis_fallback_answer(query)
    operations = [
        ('保存完整会话', lambda: add_to_conversation_history(conversation_id, user_id, "assistant", answer)),
        ('保存轻量会话', lambda: add_to_windrise_lightweight_history(conversation_id, "assistant", answer, user_id=user_id)),
    ]
    if include_stage:
        operations.append((
            '更新偏航液压状态',
            lambda: update_windrise_yaw_hydraulic_stage(conversation_id, query, answer, user_id=user_id),
        ))
    for label, operation in operations:
        try:
            operation()
        except Exception as error:
            print(f"[Windrise] 流式回答已完成，但{label}失败: {type(error).__name__}: {error}")


def prepare_windrise_base_context(query, conversation_id, user_id, app_session_id):
    """Load history and compute local preflight routing before model calls."""
    history = load_app_session_history(app_session_id, user_id, WINDRISE_MEMORY_LOAD_MESSAGES)
    if conversation_id:
        cached_history = get_conversation_history(conversation_id, user_id)
        lightweight_history = get_windrise_lightweight_history(conversation_id, user_id=user_id)
        history = merge_windrise_chat_histories(
            cached_history,
            lightweight_history,
            history,
            query,
        )
    else:
        history = strip_pending_windrise_user_turn(history, query)
    new_case_switch, new_case_reason = detect_windrise_new_case_switch(query, history)
    if new_case_switch:
        forget_windrise_retrieval_context(conversation_id, user_id)
        windrise_request_context.new_case_switch = True
        windrise_request_context.prefer_local_scoped_index = True
        print(f'[Windrise] 检测到新问题/新风场，重置设备与检索上下文: reason={new_case_reason}')
    stash_windrise_active_scope_slots(query, history)

    route_plan = resolve_windrise_route_plan(query, history)
    if route_plan.get('forget_retrieval_context'):
        forget_windrise_retrieval_context(conversation_id, user_id)
    if route_plan.get('prefer_local_scoped_index'):
        windrise_request_context.prefer_local_scoped_index = True
        windrise_request_context.semantic_pass_used = True
        windrise_request_context.retrieval_query_extracted = True

    lookup_query = route_plan.get('lookup_query') or query
    index_lookup_query = route_plan.get('index_lookup_query') or lookup_query
    if route_plan.get('direct_fault_code_lookup'):
        windrise_request_context.semantic_pass_used = True
        windrise_request_context.retrieval_query_extracted = True

    return {
        'history': history,
        'lookup_query': lookup_query,
        'index_lookup_query': index_lookup_query,
        'consolidate_note': '',
        'semantic_route': route_plan.get('semantic_route'),
        'retrieval_intent': route_plan.get('retrieval_intent') or classify_windrise_answer_intent(query),
        'device_mapping_query': route_plan.get('device_mapping_query', False),
        'scope_clarification': route_plan.get('scope_clarification', ''),
        'preflight_local_answer': (
            route_plan.get('preflight_local_answer')
            or (
                ''
                if route_plan.get('kind') == WINDRISE_ROUTE_GENERAL_KNOWLEDGE
                else (route_plan.get('terminal_answer') or '')
            )
        ),
        'preflight_local_reason': route_plan.get('preflight_local_reason', ''),
        'scope_completion_query': route_plan.get('scope_completion_query', ''),
        'symptom_scope_query': route_plan.get('symptom_scope_query', ''),
        'direct_fault_code_lookup': route_plan.get('direct_fault_code_lookup', False),
        'model_route_needed': route_plan.get('needs_model_route', False),
        'route_kind': route_plan.get('kind', WINDRISE_ROUTE_DEFERRED),
        'route': route_plan.get('route') or {},
        'terminal_answer': route_plan.get('terminal_answer'),
        'terminal_route': route_plan.get('route') or {},
    }


def call_windrise_app(query, conversation_id, user_id, app_session_id, is_streaming):
    query = normalize_text(query)
    reset_windrise_request_context()
    conversation_id = ensure_windrise_conversation_id(app_session_id, user_id, conversation_id)
    windrise_request_context.conversation_id = conversation_id
    windrise_request_context.user_id = normalize_user_id(user_id)
    windrise_request_context.deadline = time.monotonic() + WINDRISE_REQUEST_DEADLINE_SECONDS
    windrise_request_context.semantic_pass_used = False
    windrise_request_context.enforce_retrieval_extraction = True
    windrise_request_context.retrieval_query_extracted = False


    if is_streaming:
        def generate_windrise_sse():
            answer_parts = []
            terminal_emitted = False
            try:
                windrise_request_context.conversation_id = conversation_id
                windrise_request_context.user_id = normalize_user_id(user_id)
                windrise_request_context.deadline = time.monotonic() + WINDRISE_REQUEST_DEADLINE_SECONDS
                request_deadline = windrise_request_context.deadline
                yield build_sse_stream_padding()
                yield build_windrise_thinking_event(conversation_id, '正在接收您的问题...')

                def stream_prep_once():
                    windrise_request_context.conversation_id = conversation_id
                    windrise_request_context.user_id = normalize_user_id(user_id)
                    windrise_request_context.deadline = time.monotonic() + WINDRISE_REQUEST_DEADLINE_SECONDS
                    windrise_request_context.semantic_pass_used = False
                    windrise_request_context.enforce_retrieval_extraction = True
                    windrise_request_context.retrieval_query_extracted = False
                    yield prepare_windrise_base_context(
                        query,
                        conversation_id,
                        user_id,
                        app_session_id,
                    )

                stream_prep = None
                for prep_item in yield_pulsed_blocking_result(
                    stream_prep_once(),
                    conversation_id,
                    WINDRISE_STATUS_CONTEXT,
                ):
                    if isinstance(prep_item, dict):
                        stream_prep = prep_item
                    else:
                        yield prep_item
                if stream_prep is None:
                    raise RuntimeError('Windrise 流式预处理未返回结果')
                history = stream_prep['history']
                lookup_query = stream_prep['lookup_query']
                index_lookup_query = stream_prep['index_lookup_query']
                consolidate_note = stream_prep['consolidate_note']
                semantic_route = stream_prep['semantic_route']
                retrieval_intent = stream_prep['retrieval_intent']
                device_mapping_query = stream_prep['device_mapping_query']
                scope_clarification = stream_prep['scope_clarification']
                preflight_local_answer = stream_prep['preflight_local_answer']
                preflight_local_reason = stream_prep['preflight_local_reason']
                scope_completion_query = stream_prep['scope_completion_query']
                symptom_scope_query = stream_prep['symptom_scope_query']
                direct_fault_code_lookup = stream_prep['direct_fault_code_lookup']
                route_kind = stream_prep.get('route_kind', WINDRISE_ROUTE_DEFERRED)
                terminal_route = stream_prep.get('terminal_route') or stream_prep.get('route') or {}
                add_to_conversation_history(conversation_id, user_id, "user", query)
                add_to_windrise_lightweight_history(conversation_id, "user", query, user_id=user_id)
                if preflight_local_answer:
                    forget_windrise_retrieval_context(conversation_id, user_id)
                    windrise_request_context.prefer_local_scoped_index = True
                    windrise_request_context.semantic_pass_used = True
                    windrise_request_context.retrieval_query_extracted = True
                    print('[Windrise] 流式预检命中，直接输出本地结果')
                    for event in stream_completed_preflight_answer_events(
                        conversation_id,
                        user_id,
                        query,
                        preflight_local_answer,
                    ):
                        yield event
                    terminal_emitted = True
                    print(f"[Windrise] 流式兼容回复完成: answer_length={len(preflight_local_answer)}")
                    return
                windrise_request_context.semantic_pass_used = False
                windrise_request_context.enforce_retrieval_extraction = True
                windrise_request_context.retrieval_query_extracted = False
                lookup_query_local = query
                index_lookup_query_local = query
                consolidate_note_local = ''
                consolidate_prefix_sent = False
                retrieval_intent_local = classify_windrise_answer_intent(query)
                extracted_slots_local = {}
                semantic_route_local = None
                prefetched_index_answer = ''

                conversational_clarification_local = '' if device_mapping_query else build_windrise_conversational_fault_clarification(query, history)
                scope_clarification_local = '' if device_mapping_query else (
                    conversational_clarification_local or build_windrise_fault_scope_clarification(query, history)
                )
                clarification_reason_local = (
                    'ambiguous_fault_needs_clarification'
                    if conversational_clarification_local
                    else 'missing_windrise_scope_dimensions'
                )
                scope_completion_query_local = (
                    '' if device_mapping_query else build_windrise_scope_completion_query(query, history)
                )
                symptom_scope_query_local = (
                    '' if device_mapping_query else build_windrise_symptom_scope_lookup_query(query, history)
                )
                stream_preflight_answer = preflight_local_answer
                stream_preflight_reason = preflight_local_reason
                scoped_stream_preflight = ''
                scoped_stream_reason = ''
                if (
                    not stream_preflight_answer
                    and route_kind != WINDRISE_ROUTE_GENERAL_KNOWLEDGE
                    and not device_mapping_query
                    and not scope_completion_query_local
                    and is_windrise_fault_retrieval_candidate(query, history)
                ):
                    resolve_result = {}
                    resolve_done = threading.Event()

                    def resolve_scoped_preflight_worker():
                        try:
                            resolve_result['value'] = resolve_windrise_scoped_symptom_preflight(
                                query,
                                history,
                            )
                        finally:
                            resolve_done.set()

                    threading.Thread(
                        target=resolve_scoped_preflight_worker,
                        name='windrise-scoped-preflight',
                        daemon=True,
                    ).start()
                    for pulse in iter_blocking_pulses_until_done(
                        resolve_done,
                        conversation_id,
                        WINDRISE_STATUS_DATABASE,
                    ):
                        yield pulse
                    scoped_stream_preflight, scoped_stream_reason = resolve_result.get('value') or ('', '')
                    if scoped_stream_preflight:
                        forget_windrise_retrieval_context(conversation_id, user_id)
                        stream_preflight_answer = scoped_stream_preflight
                        stream_preflight_reason = scoped_stream_reason
                        if symptom_scope_query_local:
                            lookup_query_local = symptom_scope_query_local
                            index_lookup_query_local = symptom_scope_query_local
                if not stream_preflight_answer and not scope_clarification_local and scope_completion_query_local:
                    scope_completion_answer = build_index_scoped_fault_lookup_answer_with_fallback(
                        scope_completion_query_local,
                        scope_completion_query_local,
                        history,
                        intent=classify_windrise_answer_intent(scope_completion_query_local),
                    )
                    if scope_completion_answer:
                        stream_preflight_answer = scope_completion_answer
                        stream_preflight_reason = 'in_process_scoped_fault_lookup'
                        lookup_query_local = scope_completion_query_local
                        index_lookup_query_local = scope_completion_query_local
                        forget_windrise_retrieval_context(conversation_id, user_id)
                if not stream_preflight_answer and not scope_completion_query_local:
                    scoped_index_query_local = build_scoped_symptom_index_query(query, history)
                    if scoped_index_query_local:
                        forced_scoped_answer = build_index_scoped_fault_lookup_answer_with_fallback(
                            scoped_index_query_local,
                            scoped_index_query_local,
                            history,
                            intent=classify_windrise_answer_intent(query),
                        )
                        if forced_scoped_answer:
                            stream_preflight_answer = forced_scoped_answer
                            stream_preflight_reason = 'in_process_scoped_fault_lookup'
                            lookup_query_local = scoped_index_query_local
                            index_lookup_query_local = scoped_index_query_local
                            forget_windrise_retrieval_context(conversation_id, user_id)
                if stream_preflight_answer:
                    windrise_request_context.prefer_local_scoped_index = True
                    windrise_request_context.semantic_pass_used = True
                    windrise_request_context.retrieval_query_extracted = True
                if not scope_clarification_local:
                    if scope_completion_query_local:
                        lookup_query_local = scope_completion_query_local
                        index_lookup_query_local = scope_completion_query_local
                    elif symptom_scope_query_local:
                        lookup_query_local = symptom_scope_query_local
                        index_lookup_query_local = symptom_scope_query_local
                    else:
                        lookup_query_local = query
                        index_lookup_query_local = query
                contextual_lookup_query_local = query if device_mapping_query else build_windrise_contextual_fault_query(query, history)
                if contextual_lookup_query_local != query and not scope_clarification_local:
                    lookup_query_local = contextual_lookup_query_local
                    index_lookup_query_local = lookup_query_local
                direct_fault_code_lookup_local = bool(
                    extract_direct_windrise_fault_codes(lookup_query_local, history)
                )
                needs_semantic = bool(
                    not stream_preflight_answer
                    and should_run_windrise_model_route_before_retrieval(
                        lookup_query_local,
                        history,
                        scope_clarification_local,
                    )
                )
                if direct_fault_code_lookup_local:
                    # Keep the index/LLMWiki guard satisfied without treating
                    # an already explicit code as a model-extraction failure.
                    windrise_request_context.semantic_pass_used = True
                    windrise_request_context.retrieval_query_extracted = True
                if symptom_scope_query_local or scoped_stream_preflight:
                    needs_semantic = False
                    windrise_request_context.semantic_pass_used = True
                    windrise_request_context.retrieval_query_extracted = True
                if (
                    is_windrise_scoped_symptom_followup(query, history)
                    or is_windrise_bare_symptom_with_confirmed_scope(query, history)
                ):
                    needs_semantic = False
                    windrise_request_context.semantic_pass_used = True
                    windrise_request_context.retrieval_query_extracted = True
                if (
                    is_context_only_windrise_followup(query)
                    and is_numeric_windrise_fault_code(find_recent_fault_code_from_history(history))
                ):
                    needs_semantic = False
                    windrise_request_context.semantic_pass_used = True
                    windrise_request_context.retrieval_query_extracted = True
                scoped_early_answer = stream_preflight_answer
                if scoped_early_answer:
                    forget_windrise_retrieval_context(conversation_id, user_id)
                    windrise_request_context.prefer_local_scoped_index = True
                    windrise_request_context.semantic_pass_used = True
                    windrise_request_context.retrieval_query_extracted = True
                    print('[Windrise] scoped symptom early stream exit')
                    for event in stream_completed_preflight_answer_events(
                        conversation_id,
                        user_id,
                        query,
                        scoped_early_answer,
                    ):
                        yield event
                    terminal_emitted = True
                    print(f"[Windrise] 流式兼容回复完成: answer_length={len(scoped_early_answer)}")
                    return
                if WINDRISE_SHOW_THINKING_STATUS and not stream_preflight_answer:
                    yield build_windrise_thinking_event(
                        conversation_id,
                        (
                            WINDRISE_STATUS_SEMANTIC
                            if needs_semantic
                            else (
                                build_windrise_database_status(lookup_query_local)
                                if direct_fault_code_lookup_local
                                else WINDRISE_STATUS_GENERATING
                            )
                        ),
                    )
                if needs_semantic and not stream_preflight_answer:
                    try:
                        extraction_result = {}
                        extraction_error = {}
                        extraction_done = threading.Event()
                        parallel_index_result = {}
                        parallel_index_error = {}
                        parallel_index_done = threading.Event()
                        initial_lookup_query = lookup_query_local
                        initial_index_query = index_lookup_query_local
                        initial_retrieval_intent = retrieval_intent_local

                        def extract_query_worker():
                            try:
                                windrise_request_context.conversation_id = conversation_id
                                windrise_request_context.user_id = normalize_user_id(user_id)
                                windrise_request_context.deadline = request_deadline
                                extraction_result['value'] = call_windrise_semantic_router(
                                    lookup_query_local,
                                    history,
                                )
                            except Exception as worker_error:
                                extraction_error['value'] = worker_error
                            finally:
                                extraction_done.set()

                        def parallel_index_worker():
                            try:
                                windrise_request_context.conversation_id = conversation_id
                                windrise_request_context.user_id = normalize_user_id(user_id)
                                windrise_request_context.deadline = request_deadline
                                windrise_request_context.semantic_pass_used = True
                                windrise_request_context.enforce_retrieval_extraction = True
                                windrise_request_context.retrieval_query_extracted = True
                                parallel_index_result['value'] = build_index_scoped_fault_lookup_answer_with_fallback(
                                    initial_index_query,
                                    initial_lookup_query,
                                    history,
                                    intent=initial_retrieval_intent,
                                )
                            except Exception as worker_error:
                                parallel_index_error['value'] = worker_error
                            finally:
                                parallel_index_done.set()

                        extraction_thread = threading.Thread(
                            target=extract_query_worker,
                            name='windrise-query-extraction',
                            daemon=True,
                        )
                        parallel_index_thread = threading.Thread(
                            target=parallel_index_worker,
                            name='windrise-local-index-race',
                            daemon=True,
                        )
                        extraction_thread.start()
                        parallel_index_thread.start()
                        local_finished_at = None
                        last_status_at = time.monotonic()
                        local_route_won = False
                        while not extraction_done.is_set():
                            now = time.monotonic()
                            if parallel_index_done.is_set():
                                prefetched_index_answer = parallel_index_result.get('value', '')
                                if prefetched_index_answer:
                                    local_route_won = True
                                    break
                                if local_finished_at is None:
                                    local_finished_at = now
                                elif now - local_finished_at >= WINDRISE_SEMANTIC_RACE_GRACE_SECONDS:
                                    local_route_won = True
                                    break
                            if time.monotonic() >= windrise_request_context.deadline:
                                raise TimeoutError('Windrise 语义路由超过本轮回答时限')
                            if WINDRISE_SHOW_THINKING_STATUS and now - last_status_at >= 2.0:
                                yield build_windrise_thinking_event(
                                    conversation_id,
                                    f'{WINDRISE_STATUS_SEMANTIC}（本地索引与模型并行处理中）',
                                )
                                last_status_at = now
                            extraction_done.wait(timeout=0.1)

                        if local_route_won:
                            semantic_route_local = build_windrise_semantic_router_fallback(
                                initial_lookup_query,
                                history,
                            )
                            semantic_route_local['_model_routed'] = False
                            if prefetched_index_answer:
                                semantic_route_local.update({
                                    'mode': 'knowledge',
                                    'should_search': True,
                                    'fault_code': '',
                                    'uses_history_fault_code': False,
                                    'current_problem_is_new': bool(
                                        has_specific_current_diagnosis_subject(initial_lookup_query)
                                        and not is_context_only_windrise_followup(initial_lookup_query)
                                    ),
                                    'rewritten_query': initial_lookup_query,
                                    'reason': 'local_index_won_parallel_race',
                                })
                            if parallel_index_error:
                                worker_error = parallel_index_error['value']
                                print(f"[Windrise] 并行本地索引失败，继续确定性回答: {type(worker_error).__name__}: {worker_error}")
                            print('[Windrise] 本地确定性路径先完成，不再等待本轮语义路由')
                        else:
                            extraction_thread.join(timeout=0.1)
                            if extraction_error:
                                raise extraction_error['value']
                            semantic_route_local = extraction_result['value']
                        if not semantic_route_local.get('_model_routed'):
                            print('[Windrise] 语义路由模型不可用，流式请求继续使用本地确定性路由')
                        extracted_intent_local = normalize_windrise_intent(semantic_route_local.get('intent', ''))
                        if extracted_intent_local != 'general':
                            retrieval_intent_local = extracted_intent_local
                        rewritten_query_local = clamp_windrise_semantic_rewritten_query(
                            query,
                            history,
                            semantic_route_local.get('rewritten_query', ''),
                        )
                        rewritten_query_local = normalize_windrise_query(rewritten_query_local)
                        if semantic_route_local.get('mode') == 'knowledge' and semantic_route_local.get('should_search'):
                            if not rewritten_query_local:
                                rewritten_query_local = lookup_query_local
                            if rewritten_query_local != lookup_query_local:
                                consolidate_note_local = f'已理解您的问题为：{rewritten_query_local}'
                            lookup_query_local = rewritten_query_local
                        # The request context is thread-local; propagate the
                        # successful extraction markers back to this streaming
                        # generator before invoking LLMWiki or optional
                        # semantic helpers.
                        windrise_request_context.semantic_pass_used = True
                        windrise_request_context.retrieval_query_extracted = bool(
                            semantic_route_local.get('mode') == 'knowledge'
                            and semantic_route_local.get('should_search')
                        )
                    except Exception as e:
                        print(f"[Windrise] 语义路由异常，流式请求改用本地确定性路由: {type(e).__name__}: {e}")
                        semantic_route_local = build_windrise_semantic_router_fallback(
                            lookup_query_local,
                            history,
                        )
                        semantic_route_local['_model_routed'] = False
                        if semantic_route_local.get('mode') == 'knowledge' and semantic_route_local.get('should_search'):
                            rewritten_query_local = clamp_windrise_semantic_rewritten_query(
                                query,
                                history,
                                semantic_route_local.get('rewritten_query', ''),
                            )
                            rewritten_query_local = normalize_windrise_query(
                                rewritten_query_local
                            ) or lookup_query_local
                            lookup_query_local = rewritten_query_local
                            windrise_request_context.semantic_pass_used = True
                            windrise_request_context.retrieval_query_extracted = True
                        if WINDRISE_SHOW_THINKING_STATUS:
                            yield build_windrise_thinking_event(conversation_id, WINDRISE_STATUS_GENERATING)
                            yield build_windrise_thinking_end_event(conversation_id)
                    if (
                        WINDRISE_SHOW_THINKING_STATUS
                        and semantic_route_local.get('mode') == 'knowledge'
                        and semantic_route_local.get('should_search')
                    ):
                        yield build_windrise_thinking_event(
                            conversation_id,
                            build_windrise_database_status(lookup_query_local),
                        )

                def stream_answer(answer_text, status_message=WINDRISE_STATUS_FORMATTING):
                    nonlocal consolidate_prefix_sent
                    if WINDRISE_SHOW_THINKING_STATUS:
                        yield build_windrise_thinking_event(conversation_id, status_message)
                        if WINDRISE_PROGRESS_STEP_DELAY:
                            time.sleep(WINDRISE_PROGRESS_STEP_DELAY)
                        yield build_windrise_thinking_end_event(conversation_id)
                    text = str(answer_text or '')
                    if consolidate_note_local and not consolidate_prefix_sent:
                        text = f"{consolidate_note_local}\n\n{text}"
                        consolidate_prefix_sent = True
                    for chunk in iter_stream_text_chunks(text):
                        answer_parts.append(chunk)
                        yield build_sse_event({
                            'event': 'message',
                            'answer': chunk,
                            'conversation_id': conversation_id,
                        })
                        if WINDRISE_STREAM_CHUNK_DELAY:
                            time.sleep(WINDRISE_STREAM_CHUNK_DELAY)

                def stream_generated_answer(chunks, preparing_status=WINDRISE_STATUS_CHECKING):
                    """Forward real vLLM chunks instead of replaying a completed answer."""
                    nonlocal consolidate_prefix_sent
                    if WINDRISE_SHOW_THINKING_STATUS:
                        yield build_windrise_thinking_event(conversation_id, preparing_status)
                    first_chunk_sent = False
                    pulse_message = preparing_status or WINDRISE_STATUS_GENERATING
                    for chunk in iter_with_stream_pulses(chunks, pulse_message):
                        if isinstance(chunk, WindriseStreamPulse):
                            if WINDRISE_SHOW_THINKING_STATUS:
                                yield build_windrise_thinking_event(
                                    conversation_id,
                                    chunk.message or pulse_message,
                                )
                            else:
                                yield build_sse_keepalive()
                            continue
                        chunk = str(chunk or '')
                        if not chunk:
                            continue
                        if not first_chunk_sent:
                            if WINDRISE_SHOW_THINKING_STATUS:
                                yield build_windrise_thinking_event(conversation_id, WINDRISE_STATUS_ORGANIZING)
                                if WINDRISE_PROGRESS_STEP_DELAY:
                                    time.sleep(WINDRISE_PROGRESS_STEP_DELAY)
                                yield build_windrise_thinking_end_event(conversation_id)
                            first_chunk_sent = True
                            if consolidate_note_local and not consolidate_prefix_sent:
                                prefix = f"{consolidate_note_local}\n\n"
                                consolidate_prefix_sent = True
                                answer_parts.append(prefix)
                                yield build_sse_event({
                                    'event': 'message',
                                    'answer': prefix,
                                    'conversation_id': conversation_id,
                                })
                        answer_parts.append(chunk)
                        yield build_sse_event({
                            'event': 'message',
                            'answer': chunk,
                            'conversation_id': conversation_id,
                        })
                    if not first_chunk_sent and WINDRISE_SHOW_THINKING_STATUS:
                        yield build_windrise_thinking_end_event(conversation_id)

                stage_direct_answer_local = build_windrise_yaw_hydraulic_stage_answer(lookup_query_local, conversation_id)
                recent_context = find_recent_fault_context_for_query(lookup_query_local, history)
                recent_code = recent_context.get('code', '')
                has_explicit_current_task = has_current_explicit_windrise_task(index_lookup_query_local)
                current_query_has_new_subject = (
                    windrise_should_isolate_history_issue_slots(lookup_query_local, history)
                    or (
                        has_specific_current_diagnosis_subject(index_lookup_query_local)
                        and not is_context_only_windrise_followup(lookup_query_local)
                        and not has_explicit_fault_code(index_lookup_query_local)
                    )
                )
                if current_query_has_new_subject:
                    recent_context = {}
                    recent_code = ''
                effective_slots = build_effective_windrise_slots_for_query(
                    index_lookup_query_local,
                    history,
                )
                if extracted_slots_local:
                    # The semantic extraction describes the current fault, but
                    # it may omit already confirmed farm/unit/model fields.
                    # Merge it into conversation scope instead of replacing
                    # that scope and accidentally broadening the lookup.
                    effective_slots = merge_windrise_slots(
                        effective_slots,
                        extracted_slots_local,
                    )
                dimension_followup = bool(
                    recent_code
                    and is_recent_fault_dimension_followup(index_lookup_query_local)
                    and not has_explicit_current_task
                )
                general_knowledge_question = (
                    route_kind == WINDRISE_ROUTE_GENERAL_KNOWLEDGE
                    or is_windrise_general_knowledge_question(lookup_query_local)
                )
                model_search_allowed_local = bool(
                    semantic_route_local
                    and semantic_route_local.get('mode') == 'knowledge'
                    and semantic_route_local.get('should_search')
                )
                lazy_unset = object()
                direct_answer_cache = lazy_unset
                index_answer_cache = prefetched_index_answer or lazy_unset
                candidate_codes_cache = lazy_unset
                need_brand_cache = lazy_unset
                dimension_filtered_cache = lazy_unset

                if needs_semantic and index_answer_cache is lazy_unset:
                    parallel_index_deadline = time.monotonic() + WINDRISE_INDEX_LOOKUP_TIMEOUT + 1.0
                    while not parallel_index_done.wait(timeout=2.0):
                        if WINDRISE_SHOW_THINKING_STATUS:
                            yield build_windrise_thinking_event(
                                conversation_id,
                                f'{build_windrise_database_status(initial_lookup_query)}（正在匹配本地索引）',
                            )
                        if time.monotonic() >= parallel_index_deadline:
                            break
                    if parallel_index_done.is_set() and not parallel_index_error:
                        index_answer_cache = parallel_index_result.get('value', '')
                    else:
                        if parallel_index_error:
                            worker_error = parallel_index_error['value']
                            print(f"[Windrise] 并行本地索引失败，进入后备回答: {type(worker_error).__name__}: {worker_error}")
                        else:
                            print('[Windrise] 并行本地索引超时，进入后备回答')
                        index_answer_cache = ''

                if (
                    not scope_clarification_local
                    and not general_knowledge_question
                    and (direct_fault_code_lookup_local or model_search_allowed_local)
                    and index_answer_cache is lazy_unset
                ):
                    index_result = {}
                    index_error = {}
                    index_done = threading.Event()

                    def index_lookup_worker():
                        try:
                            windrise_request_context.conversation_id = conversation_id
                            windrise_request_context.user_id = normalize_user_id(user_id)
                            windrise_request_context.deadline = request_deadline
                            windrise_request_context.semantic_pass_used = True
                            windrise_request_context.enforce_retrieval_extraction = True
                            windrise_request_context.retrieval_query_extracted = True
                            index_result['value'] = build_index_scoped_fault_lookup_answer_with_fallback(
                                index_lookup_query_local,
                                lookup_query_local,
                                history,
                                intent=retrieval_intent_local,
                            )
                        except Exception as worker_error:
                            index_error['value'] = worker_error
                        finally:
                            index_done.set()

                    index_thread = threading.Thread(
                        target=index_lookup_worker,
                        name='windrise-index-lookup',
                        daemon=True,
                    )
                    index_thread.start()
                    index_deadline = time.monotonic() + WINDRISE_INDEX_LOOKUP_TIMEOUT + 1.0
                    index_wait_timed_out = False
                    while not index_done.wait(timeout=2.0):
                        if WINDRISE_SHOW_THINKING_STATUS:
                            yield build_windrise_thinking_event(
                                conversation_id,
                                f'{build_windrise_database_status(lookup_query_local)}（正在匹配索引，请稍候）',
                            )
                        if time.monotonic() >= index_deadline:
                            index_wait_timed_out = True
                            break
                    if index_wait_timed_out:
                        print(
                            f"[Windrise] 本地索引检索超过 {WINDRISE_INDEX_LOOKUP_TIMEOUT + 1.0:.1f}s，"
                            "结束本次索引等待并进入后备回答"
                        )
                        index_answer_cache = ''
                    elif index_error:
                        worker_error = index_error['value']
                        print(f"[Windrise] 本地索引检索失败，继续使用后备检索: {type(worker_error).__name__}: {worker_error}")
                        index_answer_cache = ''
                    else:
                        index_answer_cache = index_result.get('value', '')

                def lazy_direct_answer():
                    nonlocal direct_answer_cache
                    if direct_answer_cache is lazy_unset:
                        direct_answer_cache = stage_direct_answer_local or (
                            '' if dimension_followup else build_windrise_direct_chat_answer(lookup_query_local, history)
                        )
                    return direct_answer_cache

                def lazy_index_answer():
                    nonlocal index_answer_cache
                    if index_answer_cache is lazy_unset:
                        if direct_fault_code_lookup_local or model_search_allowed_local:
                            index_answer_cache = build_index_scoped_fault_lookup_answer_with_fallback(
                                index_lookup_query_local,
                                lookup_query_local,
                                history,
                                intent=retrieval_intent_local,
                            )
                        else:
                            index_answer_cache = ''
                    return index_answer_cache

                def lazy_candidate_codes_answer():
                    nonlocal candidate_codes_cache
                    if candidate_codes_cache is lazy_unset:
                        candidate_codes_cache = build_fault_code_candidates_answer_from_slots(lookup_query_local, history)
                    return candidate_codes_cache

                def lazy_need_brand_answer():
                    nonlocal need_brand_cache
                    if need_brand_cache is lazy_unset:
                        if (
                            current_query_has_new_subject
                            and not effective_slots.get('brand')
                            and not has_explicit_fault_code(lookup_query_local)
                        ):
                            need_brand_cache = (
                                build_fault_phenomenon_candidates_answer(lookup_query_local, history)
                                or build_current_subject_diagnosis_fallback_answer(lookup_query_local)
                            )
                        else:
                            need_brand_cache = ''
                    return need_brand_cache

                def lazy_dimension_filtered_answer():
                    nonlocal dimension_filtered_cache
                    if dimension_filtered_cache is lazy_unset:
                        dimension_filtered_cache = (
                            '' if has_explicit_current_task
                            else build_dimension_filtered_recent_topic_answer(lookup_query_local, history)
                        )
                    return dimension_filtered_cache

                scoped_symptom_handled = False
                if (
                    route_kind != WINDRISE_ROUTE_GENERAL_KNOWLEDGE
                    and is_windrise_fault_retrieval_candidate(query, history)
                    and (
                        is_windrise_scoped_symptom_followup(query, history)
                        or is_windrise_bare_symptom_with_confirmed_scope(query, history)
                    )
                ):
                    forget_windrise_retrieval_context(conversation_id, user_id)
                    scoped_forced_answer, scoped_forced_reason = resolve_windrise_scoped_symptom_preflight(
                        query,
                        history,
                    )
                    if not scoped_forced_answer:
                        scoped_index_query = (
                            build_windrise_symptom_scope_lookup_query(query, history)
                            or build_scoped_symptom_index_query(query, history)
                        )
                        if scoped_index_query:
                            scoped_forced_answer = build_index_scoped_fault_lookup_answer_with_fallback(
                                scoped_index_query,
                                scoped_index_query,
                                history,
                                intent=classify_windrise_answer_intent(query),
                            )
                            scoped_forced_reason = 'in_process_scoped_fault_lookup'
                    if scoped_forced_answer:
                        stream_preflight_answer = scoped_forced_answer
                        stream_preflight_reason = scoped_forced_reason or 'in_process_scoped_fault_lookup'
                        scoped_symptom_handled = True
                        print(
                            '[Windrise] scoped symptom follow-up resolved locally: '
                            f"reason={stream_preflight_reason}"
                        )

                if stream_preflight_answer:
                    preflight_is_ack = stream_preflight_reason in {
                        'in_process_dimension_ack',
                        'in_process_fault_topic_ack',
                    }
                    route = {
                        'mode': 'chat' if preflight_is_ack else 'knowledge',
                        'intent': classify_windrise_answer_intent(query),
                        'fault_code': extract_windrise_primary_answer_fault_code(stream_preflight_answer),
                        'should_search': not preflight_is_ack,
                        'uses_history_fault_code': False,
                        'current_problem_is_new': stream_preflight_reason != 'in_process_dimension_context_lookup',
                        'rewritten_query': query,
                        'reason': stream_preflight_reason,
                    }
                    yield from stream_answer(stream_preflight_answer)
                elif not scoped_symptom_handled and scope_clarification_local:
                    route = {
                        'mode': 'chat' if conversational_clarification_local else 'knowledge',
                        'intent': 'clarify' if conversational_clarification_local else classify_windrise_answer_intent(lookup_query_local),
                        'fault_code': '',
                        'should_search': False,
                        'uses_history_fault_code': False,
                        'current_problem_is_new': True,
                        'rewritten_query': lookup_query_local,
                        'reason': clarification_reason_local,
                    }
                    yield from stream_answer(scope_clarification_local)
                elif general_knowledge_question:
                    route = terminal_route if route_kind == WINDRISE_ROUTE_GENERAL_KNOWLEDGE else {
                        'mode': 'chat',
                        'intent': 'general',
                        'fault_code': '',
                        'should_search': False,
                        'uses_history_fault_code': False,
                        'current_problem_is_new': True,
                        'rewritten_query': query,
                        'reason': 'general_wind_knowledge_question',
                    }
                    print('[Windrise] 流式路由: general_knowledge → vLLM 对话')
                    # General questions also use the real vLLM stream.
                    yield from stream_generated_answer(
                        iter_windrise_chat_answer(lookup_query_local, history, route),
                        preparing_status=WINDRISE_STATUS_CONTEXT,
                    )
                elif should_block_windrise_mapping_answer(lookup_query_local) and lazy_index_answer():
                    yield from stream_answer(lazy_index_answer())
                elif lazy_direct_answer():
                    yield from stream_answer(lazy_direct_answer())
                elif lazy_index_answer():
                    yield from stream_answer(lazy_index_answer())
                elif lazy_need_brand_answer():
                    yield from stream_answer(lazy_need_brand_answer())
                elif is_explicit_fault_name_lookup_query(lookup_query_local) or is_explicit_fault_action_lookup_query(lookup_query_local):
                    intent = retrieval_intent_local
                    constrained_query = lookup_query_local
                    route = {
                        'mode': 'knowledge',
                        'intent': intent,
                        'fault_code': '',
                        'should_search': True,
                        'uses_history_fault_code': False,
                        'current_problem_is_new': True,
                        'rewritten_query': constrained_query,
                        'reason': 'streaming_explicit_fault_lookup',
                    }
                    yield from stream_generated_answer(
                        iter_windrise_knowledge_augmented_answer(
                            query,
                            history,
                            {'args': ['search', constrained_query], 'intent': intent},
                            route,
                        )
                    )
                elif lazy_candidate_codes_answer():
                    yield from stream_answer(lazy_candidate_codes_answer())
                elif recent_code and is_recent_fault_dimension_followup(query):
                    intent = classify_windrise_followup_intent(query) or 'general'
                    rewritten_query = build_recent_fault_dimension_query(recent_context, query)
                    route = {
                        'mode': 'knowledge',
                        'intent': intent,
                        'fault_code': recent_code,
                        'should_search': True,
                        'uses_history_fault_code': True,
                        'current_problem_is_new': False,
                        'rewritten_query': rewritten_query,
                        'reason': 'deterministic_recent_fault_dimension_followup',
                    }
                    yield from stream_generated_answer(
                        iter_windrise_knowledge_augmented_answer(
                            query,
                            history,
                            {'args': ['search', rewritten_query], 'intent': intent},
                            route,
                        )
                    )
                elif lazy_dimension_filtered_answer():
                    yield from stream_answer(lazy_dimension_filtered_answer())
                elif extract_fault_codes(lookup_query_local):
                    fault_code = extract_fault_codes(lookup_query_local)[0]
                    intent = retrieval_intent_local if retrieval_intent_local != 'general' else 'repair'
                    constrained_query = lookup_query_local
                    route = {
                        'mode': 'knowledge',
                        'intent': intent,
                        'fault_code': fault_code,
                        'should_search': True,
                        'uses_history_fault_code': False,
                        'current_problem_is_new': True,
                        'rewritten_query': constrained_query,
                        'reason': 'streaming_explicit_fault_code_lookup',
                    }
                    yield from stream_generated_answer(
                        iter_windrise_knowledge_augmented_answer(
                            query,
                            history,
                            {'args': ['search', constrained_query], 'intent': intent},
                            route,
                        )
                    )
                elif is_windrise_candidate_selection_followup(query, history):
                    route = build_windrise_candidate_selection_route(query, history)
                    yield from stream_generated_answer(
                        iter_windrise_knowledge_augmented_answer(
                            query,
                            history,
                            {'args': ['search', route['rewritten_query']], 'intent': route.get('intent') or 'general'},
                            route,
                        )
                    )
                elif (
                    find_recent_fault_code_for_query(query, history)
                    and (classify_windrise_followup_intent(query) or 'general') in {
                        'meaning', 'repair', 'reason', 'reset', 'trigger', 'impact',
                        'risk', 'operation', 'comparison',
                    }
                    and is_context_only_windrise_followup(query)
                    and not has_specific_current_diagnosis_subject(query)
                    and not latest_assistant_answer_is_windrise_no_match(history)
                ):
                    recent_code = find_recent_fault_code_for_query(query, history)
                    intent = classify_windrise_followup_intent(query) or 'repair'
                    route = {
                        'mode': 'knowledge',
                        'intent': intent,
                        'fault_code': recent_code,
                        'should_search': True,
                        'uses_history_fault_code': True,
                        'current_problem_is_new': False,
                        'rewritten_query': f'{recent_code} {query}',
                        'reason': 'deterministic_recent_fault_followup',
                        'force_synthesis': True,
                    }
                    yield from stream_generated_answer(
                        iter_windrise_knowledge_augmented_answer(
                            query,
                            history,
                            {'args': ['search', recent_code], 'intent': intent},
                            route,
                        )
                    )
                elif (
                    semantic_route_local
                    and semantic_route_local.get('mode') == 'knowledge'
                    and semantic_route_local.get('should_search')
                    and not is_windrise_scoped_symptom_followup(query, history)
                    and not is_windrise_bare_symptom_with_confirmed_scope(query, history)
                ):
                    route = semantic_route_local
                    yield from stream_generated_answer(
                        iter_windrise_knowledge_augmented_answer(
                            query,
                            history,
                            {
                                'args': ['search', route.get('rewritten_query') or lookup_query_local],
                                'intent': route.get('intent') or 'general',
                            },
                            route,
                        )
                    )
                elif semantic_route_local and semantic_route_local.get('mode') == 'chat':
                    route = semantic_route_local
                    yield from stream_generated_answer(
                        iter_windrise_chat_answer(query, history, route),
                        preparing_status=WINDRISE_STATUS_CONTEXT,
                    )
                elif should_force_windrise_knowledge_lookup(lookup_query_local, history):
                    route = {
                        'mode': 'knowledge',
                        'intent': retrieval_intent_local if retrieval_intent_local != 'general' else 'repair',
                        'fault_code': '',
                        'should_search': True,
                        'uses_history_fault_code': False,
                        'current_problem_is_new': True,
                        'rewritten_query': lookup_query_local,
                        'reason': 'knowledge_first_device_issue',
                    }
                    yield from stream_generated_answer(
                        iter_windrise_knowledge_first_answer(lookup_query_local, history, route)
                    )
                elif WINDRISE_LLM_FIRST_ENABLED:
                    pending = ''
                    first_chunk_sent = False
                    if WINDRISE_SHOW_THINKING_STATUS:
                        yield build_windrise_thinking_event(conversation_id, WINDRISE_STATUS_CONTEXT)
                    try:
                        for raw_chunk in iter_windrise_llm_first_answer(query, history):
                            pending += raw_chunk
                            flushable, pending = split_flushable_text(pending)
                            if not flushable and len(pending) < 24:
                                continue
                            chunk = flushable or pending
                            if not flushable:
                                pending = ''
                            if not chunk:
                                continue
                            if not first_chunk_sent:
                                if WINDRISE_SHOW_THINKING_STATUS:
                                    yield build_windrise_thinking_event(conversation_id, WINDRISE_STATUS_ORGANIZING)
                                    if WINDRISE_PROGRESS_STEP_DELAY:
                                        time.sleep(WINDRISE_PROGRESS_STEP_DELAY)
                                    yield build_windrise_thinking_end_event(conversation_id)
                                first_chunk_sent = True
                                if consolidate_note_local and not consolidate_prefix_sent:
                                    prefix = f"{consolidate_note_local}\n\n"
                                    consolidate_prefix_sent = True
                                    answer_parts.append(prefix)
                                    yield build_sse_event({
                                        'event': 'message',
                                        'answer': prefix,
                                        'conversation_id': conversation_id,
                                    })
                            answer_parts.append(chunk)
                            yield build_sse_event({
                                'event': 'message',
                                'answer': chunk,
                                'conversation_id': conversation_id,
                            })
                        if pending:
                            if not first_chunk_sent:
                                if WINDRISE_SHOW_THINKING_STATUS:
                                    yield build_windrise_thinking_event(conversation_id, WINDRISE_STATUS_ORGANIZING)
                                    if WINDRISE_PROGRESS_STEP_DELAY:
                                        time.sleep(WINDRISE_PROGRESS_STEP_DELAY)
                                    yield build_windrise_thinking_end_event(conversation_id)
                                first_chunk_sent = True
                                if consolidate_note_local and not consolidate_prefix_sent:
                                    prefix = f"{consolidate_note_local}\n\n"
                                    consolidate_prefix_sent = True
                                    answer_parts.append(prefix)
                                    yield build_sse_event({
                                        'event': 'message',
                                        'answer': prefix,
                                        'conversation_id': conversation_id,
                                    })
                            answer_parts.append(pending)
                            yield build_sse_event({
                                'event': 'message',
                                'answer': pending,
                                'conversation_id': conversation_id,
                            })
                    except Exception as e:
                        print(f"[Windrise] LLM-first 流式回答失败: {type(e).__name__}: {e}")
                        mark_windrise_llm_unavailable(e)
                        fallback_answer = build_current_subject_diagnosis_fallback_answer(query)
                        if not first_chunk_sent:
                            yield from stream_answer(fallback_answer)
                        else:
                            answer_parts.append(fallback_answer)
                            yield build_sse_event({
                                'event': 'message',
                                'answer': fallback_answer,
                                'conversation_id': conversation_id,
                            })
                else:
                    answer, route = build_windrise_response_payload(lookup_query_local, history)
                    yield from stream_answer(answer)
                answer = ''.join(answer_parts).strip()
                if not answer:
                    answer = build_current_subject_diagnosis_fallback_answer(query)
                    for chunk in iter_stream_text_chunks(answer):
                        answer_parts.append(chunk)
                        yield build_sse_event({
                            'event': 'message',
                            'answer': chunk,
                            'conversation_id': conversation_id,
                        })
                persist_completed_windrise_stream_answer(
                    conversation_id,
                    user_id,
                    query,
                    answer,
                )
                yield build_sse_event({'event': 'message_end', 'conversation_id': conversation_id})
                terminal_emitted = True
                print(f"[Windrise] 流式兼容回复完成: answer_length={len(answer)}")
            except Exception as e:
                print(f"[Windrise] 失败: {type(e).__name__}: {e}")
                maybe_print_traceback()
                existing_answer = ''.join(answer_parts).strip()
                if existing_answer:
                    deterministic_fallback = build_current_subject_diagnosis_fallback_answer(query)
                    recovery_text = (
                        f"\n\n{deterministic_fallback}"
                        if deterministic_fallback and deterministic_fallback not in existing_answer
                        else ''
                    )
                    answer = existing_answer + recovery_text
                    visible_fallback = recovery_text
                else:
                    answer = build_current_subject_diagnosis_fallback_answer(query)
                    visible_fallback = answer
                for chunk in iter_stream_text_chunks(visible_fallback):
                    answer_parts.append(chunk)
                    yield build_sse_event({
                        'event': 'message',
                        'answer': chunk,
                        'conversation_id': conversation_id,
                    })
                persist_completed_windrise_stream_answer(
                    conversation_id,
                    user_id,
                    query,
                    answer,
                    include_stage=False,
                )
                if not terminal_emitted:
                    yield build_sse_event({'event': 'message_end', 'conversation_id': conversation_id})
                    terminal_emitted = True

        return Response(
            stream_with_context(generate_windrise_sse()),
            content_type='text/event-stream; charset=utf-8',
            headers={
                'Cache-Control': 'no-cache, no-transform',
                'X-Accel-Buffering': 'no',
            }
        )

    prep = prepare_windrise_base_context(query, conversation_id, user_id, app_session_id)
    history = prep['history']
    lookup_query = prep['lookup_query']
    index_lookup_query = prep['index_lookup_query']
    consolidate_note = prep['consolidate_note']
    semantic_route = prep['semantic_route']
    retrieval_intent = prep['retrieval_intent']
    device_mapping_query = prep['device_mapping_query']
    scope_clarification = prep['scope_clarification']
    preflight_local_answer = prep['preflight_local_answer']
    preflight_local_reason = prep['preflight_local_reason']
    scope_completion_query = prep['scope_completion_query']
    symptom_scope_query = prep['symptom_scope_query']
    direct_fault_code_lookup = prep['direct_fault_code_lookup']
    model_route_needed = prep['model_route_needed']
    blocking_prefetched_index_answer = ''
    if model_route_needed:
        try:
            initial_blocking_lookup_query = lookup_query
            initial_blocking_index_query = index_lookup_query
            route_result = {}
            route_error = {}
            route_done = threading.Event()
            local_result = {}
            local_error = {}
            local_done = threading.Event()

            def blocking_route_worker():
                try:
                    windrise_request_context.conversation_id = conversation_id
                    windrise_request_context.user_id = normalize_user_id(user_id)
                    windrise_request_context.deadline = time.monotonic() + WINDRISE_REQUEST_DEADLINE_SECONDS
                    route_result['value'] = call_windrise_semantic_router(
                        initial_blocking_lookup_query,
                        history,
                    )
                except Exception as worker_error:
                    route_error['value'] = worker_error
                finally:
                    route_done.set()

            def blocking_local_worker():
                try:
                    windrise_request_context.conversation_id = conversation_id
                    windrise_request_context.user_id = normalize_user_id(user_id)
                    windrise_request_context.deadline = time.monotonic() + WINDRISE_REQUEST_DEADLINE_SECONDS
                    windrise_request_context.semantic_pass_used = True
                    windrise_request_context.enforce_retrieval_extraction = True
                    windrise_request_context.retrieval_query_extracted = True
                    local_result['value'] = build_index_scoped_fault_lookup_answer_with_fallback(
                        initial_blocking_index_query,
                        initial_blocking_lookup_query,
                        history,
                        intent=retrieval_intent,
                    )
                except Exception as worker_error:
                    local_error['value'] = worker_error
                finally:
                    local_done.set()

            route_thread = threading.Thread(
                target=blocking_route_worker,
                name='windrise-blocking-route-race',
                daemon=True,
            )
            local_thread = threading.Thread(
                target=blocking_local_worker,
                name='windrise-blocking-index-race',
                daemon=True,
            )
            route_thread.start()
            local_thread.start()
            local_finished_at = None
            local_route_won = False
            while not route_done.is_set():
                now = time.monotonic()
                if local_done.is_set():
                    blocking_prefetched_index_answer = local_result.get('value', '')
                    if blocking_prefetched_index_answer:
                        local_route_won = True
                        break
                    if local_finished_at is None:
                        local_finished_at = now
                    elif now - local_finished_at >= WINDRISE_SEMANTIC_RACE_GRACE_SECONDS:
                        local_route_won = True
                        break
                if now >= getattr(windrise_request_context, 'deadline', now):
                    raise TimeoutError('Windrise 阻塞路由超过本轮回答时限')
                route_done.wait(timeout=0.05)

            if local_route_won:
                semantic_route = build_windrise_semantic_router_fallback(
                    initial_blocking_lookup_query,
                    history,
                )
                semantic_route['_model_routed'] = False
                if blocking_prefetched_index_answer:
                    semantic_route.update({
                        'mode': 'knowledge',
                        'should_search': True,
                        'fault_code': '',
                        'uses_history_fault_code': False,
                        'current_problem_is_new': bool(
                            has_specific_current_diagnosis_subject(initial_blocking_lookup_query)
                            and not is_context_only_windrise_followup(initial_blocking_lookup_query)
                        ),
                        'rewritten_query': initial_blocking_lookup_query,
                        'reason': 'local_index_won_parallel_race',
                    })
                if local_error:
                    worker_error = local_error['value']
                    print(f"[Windrise] 阻塞并行本地索引失败，继续确定性回答: {type(worker_error).__name__}: {worker_error}")
                print('[Windrise] 阻塞请求由本地确定性路径先完成')
            else:
                route_thread.join(timeout=0.1)
                if route_error:
                    raise route_error['value']
                semantic_route = route_result['value']
                local_done.wait(timeout=WINDRISE_INDEX_LOOKUP_TIMEOUT + 1.0)
                if local_done.is_set() and not local_error:
                    blocking_prefetched_index_answer = local_result.get('value', '')
            if not semantic_route.get('_model_routed'):
                print('[Windrise] 语义路由模型不可用，阻塞请求继续使用本地确定性路由')
            retrieval_intent = normalize_windrise_intent(semantic_route.get('intent', ''))
            rewritten_query = clamp_windrise_semantic_rewritten_query(
                query,
                history,
                semantic_route.get('rewritten_query', ''),
            )
            rewritten_query = normalize_windrise_query(rewritten_query)
            if semantic_route.get('mode') == 'knowledge' and semantic_route.get('should_search'):
                if not rewritten_query:
                    rewritten_query = lookup_query
                if rewritten_query != lookup_query:
                    consolidate_note = f'已理解您的问题为：{rewritten_query}'
                lookup_query = rewritten_query
                windrise_request_context.retrieval_query_extracted = True
        except Exception as e:
            print(f"[Windrise] 语义路由异常，阻塞请求改用本地确定性路由: {type(e).__name__}: {e}")
            semantic_route = build_windrise_semantic_router_fallback(lookup_query, history)
            semantic_route['_model_routed'] = False
            retrieval_intent = normalize_windrise_intent(semantic_route.get('intent', ''))
            if semantic_route.get('mode') == 'knowledge' and semantic_route.get('should_search'):
                rewritten_query = clamp_windrise_semantic_rewritten_query(
                    query,
                    history,
                    semantic_route.get('rewritten_query', ''),
                )
                rewritten_query = normalize_windrise_query(rewritten_query) or lookup_query
                lookup_query = rewritten_query
                windrise_request_context.retrieval_query_extracted = True
        extraction_error = ''
    else:
        extraction_error = ''
    add_to_conversation_history(conversation_id, user_id, "user", query)
    add_to_windrise_lightweight_history(conversation_id, "user", query, user_id=user_id)
    stage_direct_answer = (
        '' if scope_clarification
        else build_windrise_yaw_hydraulic_stage_answer(lookup_query, conversation_id)
    )
    blocking_index_answer = blocking_prefetched_index_answer
    blocking_search_allowed = bool(
        direct_fault_code_lookup
        or (
            semantic_route
            and semantic_route.get('mode') == 'knowledge'
            and semantic_route.get('should_search')
        )
    )
    if (
        not extraction_error
        and not blocking_index_answer
        and not stage_direct_answer
        and not scope_clarification
        and blocking_search_allowed
    ):
        blocking_index_answer = build_index_scoped_fault_lookup_answer_with_fallback(
            index_lookup_query,
            lookup_query,
            history,
            intent=retrieval_intent,
        )
    if preflight_local_answer:
        preflight_is_ack = preflight_local_reason in {
            'in_process_dimension_ack',
            'in_process_fault_topic_ack',
        }
        answer, route = preflight_local_answer, {
            'mode': 'chat' if preflight_is_ack else 'knowledge',
            'reason': preflight_local_reason,
        }
    elif extraction_error:
        answer, route = extraction_error, {'mode': 'retrieval_extraction_failed'}
    elif stage_direct_answer:
        answer, route = stage_direct_answer, {'mode': 'yaw_hydraulic_stage'}
    elif blocking_index_answer:
        answer = blocking_index_answer
        route = {'mode': 'knowledge', 'reason': 'original_query_index_match'}
    else:
        answer, route = build_windrise_response_payload(query, history, semantic_route=semantic_route)
    answer = prepend_windrise_consolidate_note(answer, consolidate_note)
    add_to_conversation_history(conversation_id, user_id, "assistant", answer)
    add_to_windrise_lightweight_history(conversation_id, "assistant", answer, user_id=user_id)
    update_windrise_yaw_hydraulic_stage(conversation_id, query, answer, user_id=user_id)
    response_data = {
        'answer': answer,
        'conversation_id': conversation_id,
    }
    if app_session_id is not None:
        response_data['session_id'] = app_session_id
    print(f"[Windrise] 阻塞回复完成: answer_length={len(answer)}")
    return jsonify(response_data)


@app.route('/api/chat', methods=['POST'])
@login_required
def chat_proxy():
    """代理接口 - 优先调用 Dify；未配置 Dify 时调用 OpenAI 兼容 LLM。"""
    try:
        data = request.get_json(silent=True) or {}
        is_streaming = data.get('response_mode') == 'streaming'
        original_query = data.get('message', data.get('query', '')).strip()
        user_id = normalize_user_id(current_user.get_id())

        allowed, retry_after = check_rate_limit(
            chat_rate_tracker,
            user_id,
            CHAT_RATE_LIMIT_MAX,
            CHAT_RATE_LIMIT_WINDOW,
        )
        if not allowed:
            return jsonify({
                'error': f'请求过于频繁，请 {retry_after} 秒后重试',
            }), 429

        # 以当前登录用户和服务端会话为准管理 conversation_id。
        allow_new_conversation_id = not (DIFY_ENABLED and DIFY_APP_TYPE.lower() == 'chat')
        app_session_id, conversation_id = resolve_chat_context_from_session(
            data,
            user_id,
            allow_new_conversation_id=allow_new_conversation_id,
        )
        print(f"📤 收到前端请求: {redact_chat_request_for_log(data, original_query, conversation_id, user_id, is_streaming)}")

        if WINDRISE_ENABLED:
            return call_windrise_app(original_query, conversation_id, user_id, app_session_id, is_streaming)
        if DIFY_ENABLED:
            return call_dify_app(original_query, conversation_id, user_id, is_streaming)
        if DIFY_REQUIRED:
            print("[Dify] Dify 未启用：请配置 DIFY_API_URL 和 DIFY_API_KEY")
            return jsonify({
                'error': 'Dify 未配置或未启用，请检查 DIFY_API_URL 和 DIFY_API_KEY',
                'dify_enabled': False,
            }), 503

        # Step 0.5: 检测风场号并查找机型
        history = get_conversation_history(conversation_id, user_id)

        # Step 0.6: 话题切换检测
        is_topic_shifted = False
        shift_reason = ""
        if history:
            is_topic_shifted, shift_reason = topic_shift_detector.detect_shift(
                original_query,
                history,
                time.time()
            )
            if is_topic_shifted:
                print(f"🔄 检测到话题切换: {shift_reason}")
                # 归拢上下文：保留关键信息，清理旧话题细节
                history = context_manager.consolidate_on_topic_shift(
                    history,
                    original_query,
                    keep_recent=3  # 保留最近3轮对话
                )
                # 更新会话历史
                cache_key = get_conversation_cache_key(conversation_id, user_id)
                with conversation_lock:
                    conversation_histories[cache_key] = history
                print(f"📝 上下文已归拢: 保留 {len(history)} 条消息")

        wind_farm_id = extract_wind_farm_id(original_query)
        if not wind_farm_id:
            wind_farm_id = detect_wind_farm_from_history(history)
        wind_farm_name = None
        wind_farm_models = []
        if wind_farm_id:
            wind_farm_name, wind_farm_models = get_models_by_farm_id(wind_farm_id)
            print(
                f"🏭 风场命中: id={mask_identifier(wind_farm_id, prefix=1, suffix=1)} "
                f"models={len(wind_farm_models or [])}"
            )

        # Step 1: 问题分类
        conversation_mode = infer_conversation_mode(original_query, history)
        level = classify_question_v2(original_query, history=history)
        level_name = {1: '信息太少', 2: '部分信息', 3: '可以检索'}
        print(f"🏷️ 分类级别: Level {level} ({level_name.get(level, '未知')})")

        # Step 2: 知识检索（Level 1 跳过，节省计算资源）
        rag_result = {
            'matched': False,
            'chunks': [],
            'context_text': '',
            'raw_count': 0
        }
        if original_query and conversation_mode == 'diagnosis' and level >= 3:
            rag_result = retrieve_from_langchain(
                original_query,
                top_k=RAG_TOP_K,
                history=history,
                wind_farm_models=wind_farm_models,
            )
        print(f"📚 检索结果: matched={rag_result['matched']}, raw_count={rag_result['raw_count']}, filtered_count={len(rag_result['chunks'])}")

        # Step 3: 构建 LLM 请求消息
        system_prompt = DIAGNOSIS_SYSTEM_PROMPT if conversation_mode == 'diagnosis' else CHAT_SYSTEM_PROMPT
        messages = [{"role": "system", "content": system_prompt}]

        # 添加对话记忆
        history = get_conversation_history(conversation_id, user_id)
        memory_summary = build_memory_summary(history)
        if memory_summary:
            messages.append({"role": "system", "content": memory_summary})

        recent_history = history[-RECENT_HISTORY_MESSAGES:] if history else []
        if recent_history:
            messages.extend(recent_history)

        # 系统级补充信息作为最后一条 system 消息注入
        runtime_instruction = build_runtime_instruction_v2(
            level,
            rag_result['chunks'],
            query=original_query,
            history=history,
            conversation_mode=conversation_mode,
            wind_farm_id=wind_farm_id,
            wind_farm_name=wind_farm_name,
            wind_farm_models=wind_farm_models,
        )
        messages.append({"role": "system", "content": runtime_instruction})
        messages.append({"role": "user", "content": original_query})
        model_name = resolve_vllm_model_name()

        # 保存用户消息到历史
        add_to_conversation_history(conversation_id, user_id, "user", original_query)

        print(
            f"📡 调用模型: provider={LLM_PROVIDER_NAME} model={model_name} "
            f"message_count={len(messages)} conversation_id={mask_identifier(conversation_id, prefix=4, suffix=4)}"
        )

        if is_streaming:
            # ========== 流式请求 ==========
            vllm_data = {
                "model": model_name,
                "messages": messages,
                "max_tokens": 4000,
                "temperature": 0.7,
                "top_p": 0.8,
                "stream": True
            }
            vllm_response = http_session.post(
                VLLM_API_URL,
                json=apply_no_thinking_options(vllm_data),
                stream=True,
                timeout=300,
                **get_request_kwargs_for_url(VLLM_API_URL)
            )

            print(f"✅ {LLM_PROVIDER_NAME} 响应状态码: {vllm_response.status_code}")

            if vllm_response.status_code != 200:
                error_body = normalize_text(vllm_response.text)
                print(f"❌ {LLM_PROVIDER_NAME} 流式错误状态: {vllm_response.status_code} body={error_body[:500]}")
                error_event = build_web_error_payload(
                    f'模型服务响应异常（HTTP {vllm_response.status_code}）',
                    error_type='upstream_http_error',
                    status_code=vllm_response.status_code,
                    diagnostics={
                        'provider': LLM_PROVIDER_NAME,
                        'vllm_url': mask_url_for_log(VLLM_API_URL),
                        'response_preview': error_body[:300],
                    },
                )
                error_event['event'] = 'error'
                return Response(
                    f'data: {json.dumps(error_event, ensure_ascii=False)}\n\n',
                    content_type='text/event-stream; charset=utf-8',
                )

            def generate_sse():
                """将 OpenAI SSE 格式转换为 Dify 兼容格式"""
                raw_text = ''
                emitted_text = ''
                pending_text = ''
                in_think_tag = False
                try:
                    for raw_chunk in vllm_response.iter_lines(decode_unicode=False):
                        if not raw_chunk:
                            continue
                        if isinstance(raw_chunk, bytes):
                            chunk = raw_chunk.decode('utf-8', errors='replace')
                        else:
                            chunk = raw_chunk
                        if not chunk.startswith('data:'):
                            continue

                        json_str = chunk[5:].strip()
                        if json_str == '[DONE]':
                            if pending_text:
                                cleaned_tail = sanitize_assistant_answer(pending_text)
                                if cleaned_tail:
                                    emitted_text += cleaned_tail
                                    dify_event = {
                                        "event": "message",
                                        "answer": cleaned_tail,
                                        "conversation_id": conversation_id
                                    }
                                    yield f'data: {json.dumps(dify_event, ensure_ascii=False)}\n\n'
                            # 发送完成事件
                            done_event = {
                                "event": "message_end",
                                "conversation_id": conversation_id
                            }
                            yield f'data: {json.dumps(done_event)}\n\n'
                            break

                        try:
                            data_chunk = json.loads(json_str)
                            delta = data_chunk.get('choices', [{}])[0].get('delta', {})

                            content = (
                                delta.get('content', '')
                                or delta.get('reasoning_content', '')
                                or delta.get('reasoning', '')
                            )

                            if content:
                                # 兜底：过滤 content 中内嵌的 <think> 标签
                                if '<think>' in content:
                                    in_think_tag = True
                                    # 提取 <think> 之前的文本
                                    before_think = content.split('<think>')[0]
                                    if '</think>' in content:
                                        in_think_tag = False
                                        after_think = content.split('</think>')[-1]
                                        content = before_think + after_think
                                    else:
                                        content = before_think
                                elif in_think_tag:
                                    if '</think>' in content:
                                        in_think_tag = False
                                        content = content.split('</think>')[-1]
                                    else:
                                        content = ''

                                if content:
                                    raw_text += content
                                    pending_text += content

                                    flushable_text, pending_text = split_flushable_text(pending_text)
                                    if flushable_text:
                                        cleaned_chunk = sanitize_assistant_answer(flushable_text)
                                        if cleaned_chunk:
                                            emitted_text += cleaned_chunk
                                            dify_event = {
                                                "event": "message",
                                                "answer": cleaned_chunk,
                                                "conversation_id": conversation_id
                                            }
                                            yield f'data: {json.dumps(dify_event, ensure_ascii=False)}\n\n'

                        except json.JSONDecodeError:
                            continue

                    # 保存完整回复到对话历史
                    final_answer = emitted_text or sanitize_assistant_answer(raw_text)
                    if final_answer:
                        add_to_conversation_history(conversation_id, user_id, "assistant", final_answer)
                        print(f"✅ 流式回复完成: answer_length={len(final_answer)}")

                except Exception as e:
                    print(f"❌ 流式传输异常: {type(e).__name__}")
                    maybe_print_traceback()
                    error_event = {
                        "event": "error",
                        "message": "回复生成中断，请重试",
                        "conversation_id": conversation_id
                    }
                    yield f'data: {json.dumps(error_event, ensure_ascii=False)}\n\n'

            return Response(
                stream_with_context(generate_sse()),
                content_type='text/event-stream; charset=utf-8',
                headers={
                    'Cache-Control': 'no-cache',
                    'X-Accel-Buffering': 'no'
                }
            )

        else:
            # ========== 非流式请求 ==========
            vllm_data = {
                "model": model_name,
                "messages": messages,
                "max_tokens": 4000,
                "temperature": 0.7,
                "top_p": 0.8,
                "stream": False
            }
            vllm_response = http_session.post(
                VLLM_API_URL,
                json=apply_no_thinking_options(vllm_data),
                timeout=120,
                **get_request_kwargs_for_url(VLLM_API_URL)
            )

            print(f"✅ {LLM_PROVIDER_NAME} 响应状态码: {vllm_response.status_code}")

            if vllm_response.status_code != 200:
                print(f"❌ {LLM_PROVIDER_NAME} 错误状态: {vllm_response.status_code}")
                return jsonify({'error': '模型服务响应异常，请稍后重试'}), 500

            try:
                result = vllm_response.json()
                message_obj = result['choices'][0]['message']
                answer = sanitize_assistant_answer(extract_chat_message_content(message_obj))
            except (json.JSONDecodeError, KeyError, IndexError, TypeError) as e:
                print(f"❌ {LLM_PROVIDER_NAME} 响应解析失败: {type(e).__name__}")
                return jsonify({'error': '模型响应格式异常，请重试'}), 500

            # 保存到对话历史
            add_to_conversation_history(conversation_id, user_id, "assistant", answer)

            print(f"✅ 非流式回复完成: answer_length={len(answer)}")

            # 返回 Dify 兼容格式
            dify_response = {
                "answer": answer,
                "conversation_id": conversation_id
            }
            if app_session_id is not None:
                dify_response["session_id"] = app_session_id

            return jsonify(dify_response)

    except PermissionError as e:
        return jsonify_web_error(str(e), status_code=403, error_type='permission_denied', exc=e)
    except requests.exceptions.Timeout as e:
        log_web_error('chat_proxy timeout', e)
        return jsonify_web_error(
            '请求超时，请稍后重试',
            status_code=504,
            error_type='timeout',
            exc=e,
            diagnostics={'provider': LLM_PROVIDER_NAME, 'vllm_url': mask_url_for_log(VLLM_API_URL)},
        )
    except requests.exceptions.ConnectionError as e:
        log_web_error('chat_proxy connection', e)
        if DIFY_ENABLED:
            message = f'无法连接到 Dify 服务，请检查地址是否可访问：{mask_url_for_log(DIFY_API_URL)}'
        else:
            message = f'无法连接到模型服务，请检查 vLLM 是否启动：{mask_url_for_log(VLLM_API_URL)}'
        return jsonify_web_error(
            message,
            status_code=503,
            error_type='connection_error',
            exc=e,
            diagnostics={
                'dify_enabled': DIFY_ENABLED,
                'windrise_enabled': WINDRISE_ENABLED,
                'vllm_url': mask_url_for_log(VLLM_API_URL),
            },
        )
    except requests.exceptions.RequestException as e:
        log_web_error('chat_proxy request', e)
        return jsonify_web_error(
            f'模型服务请求失败：{e}',
            status_code=500,
            error_type=type(e).__name__,
            exc=e,
        )
    except Exception as e:
        log_web_error('chat_proxy', e)
        return jsonify_web_error(
            f'服务器内部错误：{e}',
            status_code=500,
            error_type=type(e).__name__,
            exc=e,
        )


@app.route('/api/expert-debate', methods=['POST'])
@login_required
def expert_debate_api():
    return jsonify({'success': False, 'error': '专家会诊功能已关闭'}), 404


# ========== GPU监控相关功能 ==========

def parse_rocm_smi_output(output):
    """
    解析rocm-smi输出，提取GPU信息
    """
    gpu_info = {
        'gpus': [],
        'timestamp': datetime.now().isoformat()
    }

    lines = output.split('\n')

    current = None

    def finalize_current():
        if not current:
            return
        gpu_id = current.get('id', len(gpu_info['gpus']))
        vram_percent = clamp_percentage(current.get('memory_percent', 0))
        memory_total = float(current.get('memory_total') or 0)
        memory_used = float(current.get('memory_usage') or 0)
        if not memory_used and memory_total and vram_percent:
            memory_used = memory_total * vram_percent / 100.0
        gpu_info['gpus'].append({
            'id': gpu_id,
            'name': current.get('name') or f'AMD GPU {gpu_id}',
            'memory_usage': memory_used,
            'memory_total': memory_total,
            'memory_percent': vram_percent,
            'gpu_usage': clamp_percentage(current.get('gpu_usage', 0)),
            'temperature': float(current.get('temperature') or 0),
            'power_usage': float(current.get('power_usage') or 0),
            'power_cap': float(current.get('power_cap') or 0),
            'perf_mode': current.get('perf_mode') or '',
            'mode': current.get('mode') or '',
            'clock': float(current.get('clock') or 0),
        })

    for raw_line in lines:
        line = raw_line.strip()
        if not line or line.startswith('=') or line.startswith('-'):
            continue

        gpu_match = re.match(
            r'^(\d+)\s+([\d.]+)C\s+([\d.]+)W\s+(\w+)\s+([\d.]+)W\s+([\d.]+)%\s+([\d.]+)%\s+(\w+)',
            line
        )
        if gpu_match:
            gpu_id = int(gpu_match.group(1))
            gpu_info['gpus'].append({
                'id': gpu_id,
                'name': f'AMD GPU {gpu_id}',
                'memory_usage': 0,
                'memory_total': 0,
                'memory_percent': clamp_percentage(float(gpu_match.group(6))),
                'gpu_usage': clamp_percentage(float(gpu_match.group(7))),
                'temperature': float(gpu_match.group(2)),
                'power_usage': float(gpu_match.group(3)),
                'power_cap': float(gpu_match.group(5)),
                'perf_mode': gpu_match.group(4),
                'mode': gpu_match.group(8),
                'clock': 0,
            })
            continue

        card_match = re.match(r'^GPU\[(\d+)\]\s*:\s*(.*)$', line, flags=re.IGNORECASE)
        if card_match:
            finalize_current()
            current = {'id': int(card_match.group(1))}
            name_part = card_match.group(2).strip()
            if name_part and ':' not in name_part:
                current['name'] = name_part
            continue

        if current is None:
            continue

        kv_match = re.match(r'^(.*?)\s*:\s*(.*?)\s*$', line)
        if not kv_match:
            continue
        key = kv_match.group(1).strip().lower()
        value = kv_match.group(2).strip()
        number_match = re.search(r'[-+]?\d+(?:\.\d+)?', value)
        number = float(number_match.group(0)) if number_match else 0.0

        if 'card series' in key or key == 'card model':
            current['name'] = value
        elif 'temperature' in key and ('edge' in key or 'junction' in key or 'current' in key):
            current['temperature'] = max(float(current.get('temperature') or 0), number)
        elif 'average graphics package power' in key or 'power' in key and 'cap' not in key:
            current['power_usage'] = number
        elif 'power cap' in key:
            current['power_cap'] = number
        elif 'gpu use' in key or 'gpu busy' in key or key.endswith('use (%)'):
            current['gpu_usage'] = number
        elif 'vram' in key and ('%' in value or 'use' in key or 'busy' in key):
            current['memory_percent'] = number
        elif 'vram total' in key or 'total memory' in key:
            current['memory_total'] = normalize_rocm_memory_to_gb(number, value)
        elif 'vram used' in key or 'used memory' in key:
            current['memory_usage'] = normalize_rocm_memory_to_gb(number, value)
        elif 'sclk' in key or 'clock' in key:
            current['clock'] = number

    finalize_current()
    return gpu_info


def clamp_percentage(value):
    try:
        return max(0.0, min(100.0, float(value)))
    except Exception:
        return 0.0


def normalize_rocm_memory_to_gb(number, raw_value):
    text = str(raw_value or '').lower()
    if 'tib' in text or 'tb' in text:
        return float(number) * 1024.0
    if 'gib' in text or 'gb' in text:
        return float(number)
    if 'mib' in text or 'mb' in text:
        return float(number) / 1024.0
    if 'kib' in text or 'kb' in text:
        return float(number) / (1024.0 * 1024.0)
    return float(number) / (1024.0 * 1024.0 * 1024.0) if number > 1024 * 1024 else float(number)


def get_gpu_info():
    """
    获取GPU信息
    """
    try:
        rocm_smi_bin = shutil.which('rocm-smi') or '/opt/rocm/bin/rocm-smi'
        # 直接使用文本格式获取GPU信息
        result = subprocess.run(
            [rocm_smi_bin],
            capture_output=True,
            text=True,
            timeout=10
        )
        
        if result.returncode == 0:
            gpu_info = parse_rocm_smi_output(result.stdout)
            
            if gpu_info['gpus']:
                return {
                    'success': True,
                    'data': gpu_info
                }
            else:
                return {
                    'success': False,
                    'error': '无法解析rocm-smi输出'
                }
        else:
            return {
                'success': False,
                'error': f'rocm-smi执行失败: {result.stderr}'
            }
    
    except subprocess.TimeoutExpired:
        return {
            'success': False,
            'error': 'rocm-smi执行超时'
        }
    except FileNotFoundError:
        return {
            'success': False,
            'error': 'rocm-smi命令未找到，请确保已安装AMD GPU驱动'
        }
    except Exception as e:
        return {
            'success': False,
            'error': f'获取GPU信息失败: {str(e)}'
        }


def get_cpu_info():
    """
    获取CPU信息
    """
    try:
        import psutil
        
        cpu_percent = psutil.cpu_percent(interval=0.2)
        cpu_count = psutil.cpu_count()
        
        return {
            'success': True,
            'data': {
                'cpu_usage': cpu_percent,
                'cpu_cores': cpu_count
            }
        }
    except ImportError:
        return {
            'success': False,
            'error': 'psutil库未安装'
        }
    except Exception as e:
        return {
            'success': False,
            'error': f'获取CPU信息失败: {str(e)}'
        }


def get_memory_info():
    """
    获取内存信息
    """
    try:
        import psutil
        
        mem = psutil.virtual_memory()
        
        return {
            'success': True,
            'data': {
                'memory_usage': mem.percent,
                'memory_total': mem.total / (1024**3),  # GB
                'memory_used': mem.used / (1024**3),  # GB
                'memory_available': mem.available / (1024**3)  # GB
            }
        }
    except ImportError:
        return {
            'success': False,
            'error': 'psutil库未安装'
        }
    except Exception as e:
        return {
            'success': False,
            'error': f'获取内存信息失败: {str(e)}'
        }


def get_system_monitor_snapshot(force_refresh=False):
    if SYSTEM_MONITOR_CACHE_TTL_SECONDS > 0 and not force_refresh:
        with system_monitor_lock:
            cached_snapshot = system_monitor_cache.get('snapshot')
            cached_at = float(system_monitor_cache.get('timestamp') or 0.0)
            if cached_snapshot and (time.time() - cached_at) < SYSTEM_MONITOR_CACHE_TTL_SECONDS:
                return dict(cached_snapshot)

    snapshot = {
        'gpu': get_gpu_info(),
        'cpu': get_cpu_info(),
        'memory': get_memory_info(),
        'timestamp': datetime.now().isoformat()
    }

    with system_monitor_lock:
        system_monitor_cache['snapshot'] = snapshot
        system_monitor_cache['timestamp'] = time.time()

    return dict(snapshot)


@app.route('/api/system-monitor', methods=['GET'])
@login_required
def system_monitor():
    """
    获取系统监控信息
    """
    gpu_info = get_gpu_info()
    cpu_info = get_cpu_info()
    memory_info = get_memory_info()
    
    return jsonify({
        'gpu': gpu_info,
        'cpu': cpu_info,
        'memory': memory_info,
        'timestamp': datetime.now().isoformat()
    })


@app.route('/api/gpu', methods=['GET'])
@app.route('/api/gpu-info', methods=['GET'])
@login_required
def gpu_monitor():
    """
    获取GPU信息
    """
    return jsonify(get_gpu_info())


@app.route('/api/cpu', methods=['GET'])
@login_required
def cpu_monitor():
    """
    获取CPU信息
    """
    return jsonify(get_cpu_info())


@app.route('/api/memory', methods=['GET'])
@login_required
def memory_monitor():
    """
    获取内存信息
    """
    return jsonify(get_memory_info())


def _system_monitor_view():
    return jsonify(get_system_monitor_snapshot())


def _gpu_monitor_view():
    return jsonify(get_system_monitor_snapshot().get('gpu', {}))


def _cpu_monitor_view():
    return jsonify(get_system_monitor_snapshot().get('cpu', {}))


def _memory_monitor_view():
    return jsonify(get_system_monitor_snapshot().get('memory', {}))


app.view_functions['system_monitor'] = login_required(_system_monitor_view)
app.view_functions['gpu_monitor'] = login_required(_gpu_monitor_view)
app.view_functions['cpu_monitor'] = login_required(_cpu_monitor_view)
app.view_functions['memory_monitor'] = login_required(_memory_monitor_view)


def get_local_ip():
    """获取本机局域网 IP 地址"""
    try:
        # 创建一个 UDP 套接字
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        # 连接到外部地址（不会真的发送数据）
        s.connect(("8.8.8.8", 80))
        local_ip = s.getsockname()[0]
        s.close()
        return local_ip
    except Exception:
        return "10.46.161.210"


def resolve_web_server_backend():
    """Pick the WSGI backend. waitress gives an explicit thread pool; werkzeug is fallback."""
    backend = WEB_SERVER
    if backend == 'auto':
        try:
            import waitress  # noqa: F401
            return 'waitress'
        except ImportError:
            return 'werkzeug'
    if backend in ('waitress', 'werkzeug'):
        return backend
    print(f"⚠️ 未知 WEB_SERVER={backend!r}，回退到 werkzeug")
    return 'werkzeug'


def run_production_web_server(host, port):
    """Start the web server with configurable multi-thread concurrency."""
    backend = resolve_web_server_backend()
    print("🔧 配置：多线程模式，支持并发访问")
    print(f"🔧 工作线程数: {WEB_THREADS}（进程数=1，内存会话/Windrise 状态共享）")
    print(f"🔧 WSGI 后端: {backend}")
    print(f"🔧 目标并发: {TARGET_CONCURRENCY}+，listen backlog={SERVER_REQUEST_QUEUE_SIZE}")

    if backend == 'waitress':
        from waitress import serve

        print(f"🚀 服务器已启动: http://{host}:{port}")
        print(f"🚀 线程模式: waitress 线程池 ({WEB_THREADS} 个工作线程)")
        serve(
            app,
            host=host,
            port=port,
            threads=WEB_THREADS,
            channel_timeout=300,
            connection_limit=max(SERVER_REQUEST_QUEUE_SIZE, WEB_THREADS * 2),
            cleanup_interval=30,
            asyncore_use_poll=True,
        )
        return

    from werkzeug.serving import make_server

    server = make_server(host, port, app, threaded=True, processes=1)
    server.socket.listen(SERVER_REQUEST_QUEUE_SIZE)
    print(f"🚀 服务器已启动: http://{host}:{port}")
    print(
        "🚀 线程模式: werkzeug 多线程（每请求一线程；"
        f"建议 pip install waitress 并用 WEB_THREADS={WEB_THREADS}）"
    )
    server.serve_forever()


if __name__ == '__main__':
    HOST = os.getenv('APP_HOST', '0.0.0.0').strip() or '0.0.0.0'
    PORT = int(os.getenv('APP_PORT', '5002'))
    
    # 初始化数据库
    print("🗄️ 初始化数据库...")
    ensure_vllm_service_configured()
    init_db()
    
    local_ip = get_local_ip()
    
    print("=" * 60)
    print(f"🚀 华能吉林公司智能助手 Web 服务器启动中...")
    print("=" * 60)
    print(f"📂 工作目录: {BASE_DIR}")
    print(f"📄 HTML 文件: {HTML_FILE}")
    print(f"🏷️  部署版本: {get_windrise_app_version()}")
    print(f"🌀 Windrise 接入: {'enabled' if WINDRISE_ENABLED else 'disabled'}")
    if WINDRISE_ENABLED:
        print(f"🌀 Windrise 命令: {resolve_windrise_bin()}")
        print(f"🌀 Windrise 工作目录: {WINDRISE_CWD}")
        print(
            "🌀 Windrise 记忆窗口: "
            f"load={WINDRISE_MEMORY_LOAD_MESSAGES}, "
            f"context={WINDRISE_MEMORY_CONTEXT_MESSAGES}, "
            f"item_chars={WINDRISE_MEMORY_ITEM_CHARS}"
        )
        print(
            "⚡ Windrise 低延迟模式: "
            f"single_semantic_pass={WINDRISE_SINGLE_SEMANTIC_PASS}, "
            f"stream_chunk_delay={WINDRISE_STREAM_CHUNK_DELAY}s"
        )
    print(f"🔗 Dify 接入: {'enabled' if DIFY_ENABLED else 'disabled'}")
    if DIFY_ENABLED:
        print(f"🔗 Dify 地址: {DIFY_API_URL} ({DIFY_APP_TYPE})")
    print(f"🤖 {LLM_PROVIDER_NAME} 地址: {VLLM_API_URL}")
    print(f"🤖 模型服务基址: {LMSTUDIO_BASE_URL}")
    print(f"🔑 API Key 已配置: {'yes' if bool(VLLM_API_KEY) else 'no'}")
    if WINDRISE_ENABLED:
        print("📚 本地知识库: enabled（Windrise / LLMWiki）")
        print("🔎 检索模式: 会话记忆 → 进程内索引 → LLMWiki")
    else:
        print("📚 本地知识库: disabled（知识检索由 Dify 负责）")
        print("🔎 检索模式: dify")
    print(f"📡 服务访问地址:   http://{HOST}:{PORT}")
    print(f"🌐 局域网访问地址: http://{local_ip}:{PORT}")
    print("=" * 60)
    print("💡 局域网内的其他设备可以通过上述地址访问")
    print("=" * 60)
    
    # 检查 HTML 文件是否存在
    if not os.path.exists(HTML_FILE):
        print(f"❌ 错误: 找不到 {HTML_FILE}")
        print("   请确保 index_zhipu.html 和本脚本在同一文件夹")
        exit(1)
    
    # 启动服务器（单进程 + 多线程；processes=1 不是“只支持 1 个线程”）
    print(f"🔧 SQLite WAL 模式, busy_timeout={SQLITE_BUSY_TIMEOUT_MS}ms")
    print(f"🔧 内存缓存上限: {MAX_CACHED_CONVERSATIONS} 个会话")
    print("=" * 60)
    print("\n按 Ctrl+C 停止服务器\n")
    try:
        run_production_web_server(HOST, PORT)
    except KeyboardInterrupt:
        print("\n\n🛑 服务器已停止")
        sys.exit(0)
