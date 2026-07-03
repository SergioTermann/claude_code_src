import re
from dataclasses import dataclass
from typing import List, Tuple


@dataclass
class TopicSegment:
    keywords: List[str]
    started_at: float


class TopicShiftDetector:
    def __init__(self, similarity_threshold=0.3, time_gap_threshold=300.0, keyword_overlap_threshold=0.2):
        self.similarity_threshold = similarity_threshold
        self.time_gap_threshold = time_gap_threshold
        self.keyword_overlap_threshold = keyword_overlap_threshold

    def _keywords(self, text):
        terms = re.findall(r"[\u4e00-\u9fff]{2,}|[A-Za-z0-9_.#/-]{2,}", text or "")
        return {term.lower() for term in terms}

    def detect_shift(self, query, history=None, now=None) -> Tuple[bool, str]:
        history = history or []
        if len(history) < 4:
            return False, ""
        recent = " ".join(item.get("content", "") for item in history[-8:] if item.get("role") == "user")
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
