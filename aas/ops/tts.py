# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""AI 답 읽어 주기(TTS)의 서버 쪽 — 스펙 docs-plan/deploy/chat-reply-tts.md §3-8.

- 글 다듬기: Markdown 기호·코드 블록(「코드 생략」)·표·URL 을 지운다. Hermes `tools/tts_text_normalize.py`(MIT)의
  규칙을 옮겼다. 영어 단위·통화 읽기(°C → degrees Celsius 등)는 한국어 낭독에 맞지 않아 옮기지 않았다.
- 조각 나누기: 문장 하나씩(D15), 15자 미만은 다음과 합치고, 100자 넘으면 쉼표·띄어쓰기·100자에서 자르고,
  마지막이 15자 미만이면 앞 조각에 붙인다(2차 리뷰 A2-1). 같은 글은 늘 같은 조각이다(화면이 번호로 부른다).
- 목소리 목록: AAS_TTS_VOICES(JSON). 합성: LiteLLM `/v1/audio/speech` 를 바로 부른다(Hermes 를 거치지 않음, §3-1).
- 한도: 사람마다 AAS_SPEAK_PER_USER(기본 1), 서버마다 AAS_SPEAK_SLOTS(기본 2). 다 차면 기다리지 않고 바로 거절한다(D18).
소리는 디스크에 쓰지 않는다.
"""
from __future__ import annotations

import html
import json
import os
import re
import socket
import threading
import urllib.error
import urllib.request

from . import models

# ── 상수(서버 한 곳, §3-8) ──────────────────────────────────────────────
TEXT_MAX = 20_000          # 본문 답 전체 상한. 넘으면 400(R13)
READ_MAX = 6_000           # 다듬은 뒤 읽을 글 상한(약 15분). 넘으면 앞부분만 읽고 X-Speak-Truncated: 1(R13)
CHUNK_MIN = 15             # 이보다 짧은 문장은 다음 문장과 합친다(짧은 요청은 고정 비용으로 RTF 0.45~0.50, §8-5)
CHUNK_MAX = 100            # 이보다 긴 문장은 쉼표 → 띄어쓰기 → 100자에서 자른다(첫 소리 약 5.5초 이내, §8-5 ①)
SPEAK_TIMEOUT = 120        # LiteLLM 한 번의 대기. 엔진 talker max_model_len 1024 가 조각 하나를 약 1분 분량으로 묶는다(D22)
CODE_OMITTED = "코드 생략."   # i18n-ignore: 화면 문구가 아니라 소리로 읽는 글(스펙 §3-8)

# ── 글 다듬기(Hermes tts_text_normalize.py 를 옮김) ──────────────────────
_HEAD = "\x00"             # 제목 줄 표시 — 다음 줄과 「제목, 내용」으로 이어 읽는다(Hermes 와 같음)
_THINK_RE = re.compile(r"<think[\s>].*?</think>", re.DOTALL | re.IGNORECASE)
_THINK_OPEN_RE = re.compile(r"<think[\s>].*\Z", re.DOTALL | re.IGNORECASE)
_VERIFIER_RE = re.compile(r"^\s*⚠️?\s*File-mutation verifier:.*(?:\n[ \t]+•.*)*", re.MULTILINE)
# 코드 블록: 닫히지 않은 블록(답이 도중에 끊김)은 끝까지 코드로 본다. 자르기 전에 지워야 코드를 소리 내 읽지 않는다(리뷰 A1)
_CODE_BLOCK_RE = re.compile(r"^[ \t]*(```|~~~)[^\n]*\n[\s\S]*?(?:^[ \t]*\1[ \t]*$|\Z)", re.MULTILINE)
_CODE_INLINE_FENCE_RE = re.compile(r"```[\s\S]*?(?:```|\Z)")
# 표: 구분 줄(|---|:--:|)이 있는 연속된 | 줄 묶음은 통째로 지운다(칸을 하나씩 읽으면 듣기 어렵다)
_TABLE_SEP_RE = re.compile(r"^\s*(?:\|\s*)?:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)+(?:\|\s*)?$")   # \s*\|?\s* 를 묶어 되돌아가기를 없앴다(CodeQL #11)
_IMAGE_RE = re.compile(r"!\[([^\]]*)\]\((?:[^()]|\([^)]*\))*\)")
_LINK_RE = re.compile(r"\[([^\]]+)\]\((?:[^()]|\([^)]*\))*\)")
_URL_RE = re.compile(r"(?:https?|ftp)://\S+|www\.\S+")
_MEDIA_RE = re.compile(r"MEDIA:\S+?(?=[.,;:!?)\]]*(?:\s|$))")
_HTML_TAG_RE = re.compile(r"</?[A-Za-z][A-Za-z0-9-]*(?:\s[^<>]*)?/?>")
_INLINE_CODE_RE = re.compile(r"`([^`]+)`")
_BOLD_RE = re.compile(r"\*\*(.+?)\*\*", re.DOTALL)
_UBOLD_RE = re.compile(r"__(.+?)__", re.DOTALL)
_ITALIC_RE = re.compile(r"(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)", re.DOTALL)
_UITALIC_RE = re.compile(r"(?<![_\w])_(?!_)(.+?)(?<!_)_(?![_\w])", re.DOTALL)
_STRIKE_RE = re.compile(r"~~(.+?)~~", re.DOTALL)
_HEADING_RE = re.compile(r"^[ \t]{0,3}#{1,6}[ \t]+(.+)$", re.MULTILINE)   # 끝의 # 와 공백은 _heading_text 가 지운다(정규식으로 하면 세제곱 시간, CodeQL #16)
_QUOTE_RE = re.compile(r"^\s*>\s?", re.MULTILINE)
_LIST_RE = re.compile(r"^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?", re.MULTILINE)
_HR_RE = re.compile(r"^\s*[-*_=]{3,}\s*$", re.MULTILINE)
_PIPE_RE = re.compile(r"(?<!\s)\s*\|\s*|\|\s*")   # 공백 묶음의 맨 앞에서만 시작한다(CodeQL #17)
_EMOJI_RE = re.compile(r"[\U0001F1E6-\U0001F1FF\U0001F300-\U0001F64F\U0001F680-\U0001FAFF\u2600-\u27BF\u2B50\u2B55]+")   # 이스케이프로 적어 문자 범위 경고를 없앴다(CodeQL #64~71, 맞는 글자는 같다)
_VS_RE = re.compile("[︎️‍]")
# 식별자처럼 빽빽한 낱말(파일 이름·해시·UUID·경로·판 번호)은 한 글자씩 읽혀 소리가 깨진 것처럼 들린다 — 지운다(Hermes #119207)
_FILENAME_EXT_RE = re.compile(
    r"[\w.-]{0,60}\.(?:wav|ogg|mp3|flac|m4a|aac|py|pyc|ts|tsx|js|jsx|mjs|cjs|json|yaml|yml|toml|"
    r"md|mdx|txt|csv|xlsx|xls|pdf|png|jpg|jpeg|gif|webp|svg|log|sql|sh|bash|zsh|rs|go|java|rb|php|"
    r"html|css|lock|tar|gz|zip|db|sqlite|sqlite3|onnx|pt|bin|env|ini|conf|cfg|xml)\b", re.IGNORECASE)
_UUID_RE = re.compile(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")
_HASH_PREFIX_RE = re.compile(r"\b(?:sha(?:-?256|-?512|-?1|3)?|blake2[ab]?|md5|crc32?)[:\s]+[0-9a-fA-F]{7,64}", re.IGNORECASE)
_HEX_RUN_RE = re.compile(r"(?<![0-9a-fA-F])[0-9a-fA-F]{7,64}(?![0-9a-fA-F])")
_IDENT_RE = re.compile(r"[A-Za-z0-9_./~@-]+")
_DATE_RE = re.compile(r"\d{4}[-/]\d{1,2}(?:[-/]\d{1,2})?")


def _dense_identifier(token: str) -> bool:
    if "@" in token or _DATE_RE.fullmatch(token):
        return False
    if token.startswith(("~/", "./", "../", "/")) and len(token) > 1:
        return True
    if "/" in token and (_FILENAME_EXT_RE.search(token) or any(c.isdigit() for c in token)):
        return True
    if _FILENAME_EXT_RE.search(token) or _UUID_RE.search(token):
        return True
    if _HEX_RUN_RE.fullmatch(token) and re.search(r"\d", token):
        return True
    if not any(c.isdigit() for c in token):
        return False
    seps = sum(token.count(c) > 0 for c in "_./")
    hyphens = token.count("-")
    if seps >= 2 or hyphens >= 2:
        return True
    return "/" in token or (hyphens >= 1 and seps >= 1)


def _drop_tables(text: str) -> str:
    lines = text.split("\n")
    out: list[str] = []
    i = 0
    while i < len(lines):
        # 머리 줄 + 구분 줄로 시작하는 표: | 가 든 줄이 이어지는 데까지 지운다
        if "|" in lines[i] and i + 1 < len(lines) and _TABLE_SEP_RE.match(lines[i + 1]):
            j = i + 2
            while j < len(lines) and "|" in lines[j] and lines[j].strip():
                j += 1
            out.append("")
            i = j
            continue
        out.append(lines[i])
        i += 1
    return "\n".join(out)


def _smooth(text: str) -> str:
    """줄마다 문장 부호로 끝맺어 한 줄로 편다(Hermes smooth_whitespace_for_tts + flatten_newlines_for_payload)."""
    raw = text.splitlines()
    pauses = sum(1 for r in raw if r.replace(_HEAD, "").strip()) > 1
    lines: list[str] = []
    heading: str | None = None
    for r in raw:
        is_head = r.rstrip().endswith(_HEAD)
        line = r.replace(_HEAD, "").strip()
        if not line:
            continue
        if is_head:
            if heading is not None:
                lines.append(heading + ".")
            heading = line.rstrip(".:;,")
            continue
        if heading is not None:
            line = f"{heading}, {line}"
            heading = None
        if pauses:
            if line[-1] in ":;":
                line = line.rstrip(":;").rstrip() + "."
            elif line[-1] not in ".!?…。":
                line += "."
        lines.append(line)
    if heading is not None:
        lines.append(heading + ".")
    text = " ".join(lines)
    for pattern, repl in ((r"[ \t]{2,}", " "), (r"\s+([,.;:!?])", r"\1"), (r"\.{4,}", "..."),
                          (r"([.!?])(?:\s*\.)+", r"\1"), (r"(?:,\s*){2,}", ", ")):
        text = re.sub(pattern, repl, text)
    text = _close_trailing_colon(text)
    return text.strip(" ,;:")


def _close_trailing_colon(t: str) -> str:
    """끝의 쌍점·쌍반점 묶음을 마침표로 바꾼다(앞 글자가 숫자인 것은 건너뛴다). 정규식 ([^0-9])(?:[:;]\\s*)+$ 와 같은 결과를
    한 번 훑어 낸다 — 정규식은 시작 위치마다 끝까지 훑어 제곱 시간이 들었다(CodeQL #12)."""
    i = len(t)
    while i and (t[i - 1] in ":;" or t[i - 1].isspace()):
        i -= 1
    for p in range(max(i, 1), len(t)):
        if t[p] in ":;" and t[p - 1] not in "0123456789":
            return t[:p] + "."
    return t


def _heading_text(rest: str) -> str:
    """제목 줄 글에서 끝의 # 와 공백을 뗀다. 글이 # 뿐이면 첫 글자는 남긴다(예전 정규식 (.+?)[ \\t]*#*[ \\t]*$ 와 같다)."""
    core = rest.rstrip(" \t").rstrip("#").rstrip(" \t")
    return rest[:max(len(core), 1)].rstrip()


def normalize(text: str) -> str:
    """답(Markdown)을 소리로 읽을 글로 바꾼다. 결정적이다 — 같은 글이면 늘 같은 결과."""
    if not text:
        return ""
    text = html.unescape(str(text)).replace("\r\n", "\n").replace("\r", "\n")
    for pattern in (_THINK_RE, _THINK_OPEN_RE, _VERIFIER_RE):
        text = pattern.sub(" ", text)
    text = _CODE_BLOCK_RE.sub("\n" + CODE_OMITTED + "\n", text)
    text = _CODE_INLINE_FENCE_RE.sub(" " + CODE_OMITTED + " ", text)       # 줄 가운데 열린 ``` (드묾)
    text = _drop_tables(text)
    text = _IMAGE_RE.sub(lambda m: f" {m.group(1)} " if m.group(1) else " ", text)
    text = _LINK_RE.sub(r"\1", text)
    text = _URL_RE.sub(" ", text)
    text = _MEDIA_RE.sub(" ", text)
    text = _HTML_TAG_RE.sub(" ", text)
    text = _INLINE_CODE_RE.sub(r"\1", text)
    for pattern in (_BOLD_RE, _UBOLD_RE, _ITALIC_RE, _UITALIC_RE, _STRIKE_RE):
        text = pattern.sub(r"\1", text)
    text = _HEADING_RE.sub(lambda m: _heading_text(m.group(1)) + _HEAD, text)
    text = _QUOTE_RE.sub("", text)
    text = _LIST_RE.sub("", text)
    text = _HR_RE.sub("", text)
    text = _PIPE_RE.sub(", ", text)                                          # 표 밖에 남은 | 는 쉼
    text = re.sub("[   ]", " ", text).replace("−", "-").replace("…", "...")
    text = re.sub("[•◦▪▫]", " ", text)
    for sym, word in (("→", ", "), ("⇒", ", "), ("←", ", ")):
        text = text.replace(sym, word)
    text = _EMOJI_RE.sub("", _VS_RE.sub("", text))
    text = _HASH_PREFIX_RE.sub(" ", text)
    text = _IDENT_RE.sub(lambda m: " " if _dense_identifier(m.group(0)) else m.group(0), text)
    text = re.sub(r"[*_#`<>\[\]{}]+", " ", text)                            # 짝을 잃은 Markdown 기호(~ 는 「3~5개」처럼 쓰여 둔다)
    return _smooth(text)


# ── 조각 나누기(D15, A2-1) ──────────────────────────────────────────────
_SENTENCE_END_RE = re.compile(r"(?<=[.!?。…])\s+")
_COMMA_RE = re.compile(r"(?<=[,，、;])\s*")


def _split_long(sentence: str) -> list[str]:
    """CHUNK_MAX 를 넘는 문장: 쉼표 단위로 100자 안에서 묶고, 한 덩이가 100자를 넘으면 100자 앞 마지막 띄어쓰기, 없으면 100자에서."""
    if len(sentence) <= CHUNK_MAX:
        return [sentence]
    out: list[str] = []
    cur = ""
    for clause in (c.strip() for c in _COMMA_RE.split(sentence)):
        if not clause:
            continue
        joined = f"{cur} {clause}" if cur else clause
        if len(joined) <= CHUNK_MAX:
            cur = joined
            continue
        if cur:
            out.append(cur)
        cur = clause
        while len(cur) > CHUNK_MAX:
            cut = cur.rfind(" ", 0, CHUNK_MAX + 1)
            if cut <= 0:
                cut = CHUNK_MAX
            out.append(cur[:cut].rstrip())
            cur = cur[cut:].lstrip()
    if cur:
        out.append(cur)
    return out


def split(text: str) -> list[str]:
    """다듬은 글을 읽어 줄 조각으로 나눈다. 결정적이다."""
    pieces: list[str] = []
    for sentence in _SENTENCE_END_RE.split(text.strip()):
        if sentence.strip():
            pieces += _split_long(sentence.strip())
    chunks: list[str] = []
    buf = ""
    for p in pieces:
        buf = f"{buf} {p}" if buf else p
        if len(buf) >= CHUNK_MIN:
            chunks.append(buf)
            buf = ""
    if buf:                                                                  # 끝에 남은 15자 미만은 앞 조각에 붙인다(A2-1)
        if chunks:
            chunks[-1] = f"{chunks[-1]} {buf}"
        else:
            chunks.append(buf)
    return chunks


def _cap(text: str) -> tuple[str, bool]:
    """읽을 글을 READ_MAX 까지만. 넘으면 그 안의 마지막 문장 끝(없으면 띄어쓰기)에서 자른다."""
    if len(text) <= READ_MAX:
        return text, False
    head = text[:READ_MAX]
    cut = max(head.rfind(". "), head.rfind("? "), head.rfind("! "))
    if cut < READ_MAX // 2:
        cut = head.rfind(" ")
        return (head[:cut] if cut > 0 else head).rstrip(), True
    return head[:cut + 1], True


def plan(text: str) -> tuple[list[str], bool]:
    """답 전체 → (조각 목록, 잘렸는가). 다듬기를 먼저 하고 나눈다(코드 블록을 자르지 않게, 리뷰 A1)."""
    spoken, truncated = _cap(normalize(text))
    if not re.search(r"\w", spoken.replace(CODE_OMITTED, "")):              # 코드뿐인 답은 읽을 글이 없다(204, §7-1)
        return [], False
    return split(spoken), truncated


# ── 목소리 목록(AAS_TTS_VOICES) ────────────────────────────────────────
_warned: set[str] = set()
_warn_lock = threading.Lock()


def _warn_once(raw: str, why: str) -> None:
    with _warn_lock:
        if raw in _warned:
            return
        _warned.add(raw)
    print(f"경고: AAS_TTS_VOICES 를 읽을 수 없어 읽어 주기를 끕니다 — {why}", flush=True)   # i18n-ignore: 로그


def model() -> str:
    """차트 tts.model 이 넘긴 LiteLLM 별칭(AAS_TTS_MODEL, 예 cogentai-tts). 비면 읽어 주기를 쓰지 않는 설치다."""
    return os.environ.get("AAS_TTS_MODEL", "").strip()


def voices() -> list[dict]:
    """AAS_TTS_VOICES 의 목소리(id 가 있는 것만, 순서 그대로). 깨졌거나 비면 [] 와 경고 한 번. 예외를 내지 않는다(리뷰 C1)."""
    raw = os.environ.get("AAS_TTS_VOICES", "").strip()
    if not raw:
        if model():
            _warn_once(raw, "값이 비어 있습니다")   # i18n-ignore: 로그
        return []
    try:
        data = json.loads(raw)
    except ValueError as exc:
        _warn_once(raw, f"JSON 이 아닙니다 ({exc.msg})")   # i18n-ignore: 로그
        return []
    if not isinstance(data, list):
        _warn_once(raw, "목록([…])이 아닙니다")   # i18n-ignore: 로그
        return []
    out, seen = [], set()
    for v in data:
        vid = v.get("id") if isinstance(v, dict) else None
        if isinstance(vid, str) and vid.strip() and vid.strip() not in seen:
            seen.add(vid.strip())
            out.append({**v, "id": vid.strip()})
    if not out:
        _warn_once(raw, "id 가 있는 목소리가 없습니다")   # i18n-ignore: 로그
    return out


def public_voice(v: dict) -> dict:
    """화면에 보일 칸만(id·이름·성별). 이름은 {"ko","en"} 이거나 글 하나다."""
    name = v.get("name")
    return {"id": v["id"], "name": name if isinstance(name, (dict, str)) else v["id"], "gender": str(v.get("gender") or "")}


def info() -> dict:
    """{"tts": 켜졌는가, "voices": [id·이름·성별]}. /api/chat/status·/api/tts/voices 가 함께 쓴다(R11). 예외를 내지 않는다(C1)."""
    try:
        vs = voices()
        on = bool(model()) and bool(vs)
        return {"tts": on, "voices": [public_voice(v) for v in vs] if on else []}
    except Exception as exc:                                                 # 상태 응답이 막히면 채팅 화면 전체가 막힌다
        print(f"읽어 주기 상태를 만들지 못했습니다: {type(exc).__name__}", flush=True)   # i18n-ignore: 로그
        return {"tts": False, "voices": []}


def resolve_voice(wanted: str, vs: list[dict]) -> str:
    """목록에 있는 id 면 그대로, 아니면 첫 목소리(§3-8)."""
    ids = [v["id"] for v in vs]
    return wanted if wanted in ids else ids[0]


# ── 한도(R10·D16·D20) ─────────────────────────────────────────────────
def _env_int(key: str, default: int) -> int:
    try:
        return max(1, int(os.environ.get(key, str(default))))
    except ValueError:
        return default


class Limits:
    """사람마다 동시 합성 수와 서버마다 자리. 기다리지 않는다 — 다 차면 바로 거절(D18, 기다리는 동안 AAS 스레드를 잡지 않게).
    AAS_SPEAK_SLOTS 는 이 서버 한 대의 스레드를 지키는 값이다. 여러 서버·여러 호출자를 합친 실제 상한은
    엔진의 talker·code2wav max_num_seqs(2)가 지킨다(D20) — 서버를 여러 대 띄우면 여기서 센 값은 전역이 아니다."""

    def __init__(self):
        self.per_user = _env_int("AAS_SPEAK_PER_USER", 1)
        self.slots = threading.BoundedSemaphore(_env_int("AAS_SPEAK_SLOTS", 2))
        self._lock = threading.Lock()
        self._busy: dict[str, int] = {}

    def acquire(self, who: str) -> str:
        """빈 값이면 자리를 얻었다. 아니면 "user"(그 사람 한도) 또는 "slots"(서버 자리)."""
        with self._lock:
            if self._busy.get(who, 0) >= self.per_user:
                return "user"
            self._busy[who] = self._busy.get(who, 0) + 1
        if not self.slots.acquire(blocking=False):
            self._drop(who)
            return "slots"
        return ""

    def _drop(self, who: str) -> None:
        with self._lock:
            n = self._busy.get(who, 0) - 1
            if n > 0:
                self._busy[who] = n
            else:
                self._busy.pop(who, None)

    def release(self, who: str) -> None:
        self.slots.release()
        self._drop(who)


_limits: Limits | None = None
_limits_lock = threading.Lock()


def limits() -> Limits:
    global _limits
    with _limits_lock:
        if _limits is None:
            _limits = Limits()
        return _limits


def reset() -> None:
    """시험용: 한도를 환경변수에서 다시 읽는다."""
    global _limits
    with _limits_lock:
        _limits = None


# ── 합성(LiteLLM /v1/audio/speech) ─────────────────────────────────────
class SpeakError(Exception):
    """합성 실패. code 는 AAS 가 화면에 돌려줄 상태, reason 은 짧은 원인(로그용)."""

    def __init__(self, code: int, reason: str, upstream: int = 0):
        super().__init__(reason)
        self.code, self.reason, self.upstream = code, reason, upstream


def _post(url: str, key: str, payload: dict) -> bytes:
    req = urllib.request.Request(url, data=json.dumps(payload).encode(), method="POST",
                                 headers={"Content-Type": "application/json", "Accept": "audio/mpeg", **models._auth_headers(key)})
    with urllib.request.urlopen(req, timeout=SPEAK_TIMEOUT) as r:    # noqa: S310 — 주소는 설정값(AAS_LITELLM_URL·HERMES_LLM_BASE_URL)
        return r.read()


def synthesize(text: str, voice: str, first_voice: str) -> bytes:
    """조각 하나를 mp3 로. LiteLLM 1.104 는 language·max_new_tokens 를 엔진에 넘기지 않으므로 보내지 않는다(§8-5 ④).
    엔진에 없는 목소리로 400 이 오면 첫 목소리로 한 번 다시 부르고 경고를 남긴다(§3-3)."""
    base = models.api_base()
    if not base:
        raise SpeakError(503, "no LiteLLM address")
    key = models.server_llm_key()[0]
    url = base + "/audio/speech"
    tried = voice
    for attempt in (0, 1):
        try:
            return _post(url, key, {"model": model(), "input": text, "voice": tried, "response_format": "mp3"})
        except urllib.error.HTTPError as exc:
            exc.close()                                                      # 오류 본문(엔진 원문)은 읽지 않는다 — 화면에는 사용자 문구만
            if exc.code == 400 and attempt == 0 and tried != first_voice:
                print(f"경고: 읽어 주기 목소리 {tried!r} 를 엔진이 거절해(HTTP 400) 첫 목소리 {first_voice!r} 로 다시 부릅니다", flush=True)   # i18n-ignore: 로그
                tried = first_voice
                continue
            raise SpeakError(504 if exc.code == 504 else 502, f"HTTP {exc.code}", exc.code) from None
        except (socket.timeout, TimeoutError) as exc:
            raise SpeakError(504, type(exc).__name__) from None
        except urllib.error.URLError as exc:
            if isinstance(exc.reason, (socket.timeout, TimeoutError)):
                raise SpeakError(504, "timeout") from None
            raise SpeakError(503, type(exc.reason).__name__) from None
        except OSError as exc:
            raise SpeakError(503, type(exc).__name__) from None
    raise SpeakError(502, "retry exhausted")                                 # 닿지 않는다(두 번째 시도는 늘 돌려주거나 예외)
