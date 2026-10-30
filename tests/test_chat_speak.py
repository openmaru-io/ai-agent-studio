# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""AI 답 읽어 주기의 서버 쪽 — 스펙 docs-plan/deploy/chat-reply-tts.md §3-8·§7-1.

- 글 다듬기(Markdown·코드 블록 → 「코드 생략」·표·URL)와 조각 나누기(D15, 2차 리뷰 A2-1), 같은 글은 같은 조각
- POST /api/chat/speak: 204·part 범위 밖 400·20,000자 초과 400·6,000자 잘림 헤더·꺼짐 404·목소리 고르기와 400 다시 부르기·
  LiteLLM 오류는 사용자 문구·사용 기록에 글 없음·사람별/서버별 429·남의 에이전트 403
- GET /api/tts/voices·POST /api/tts/preview, /api/chat/status 의 tts·tts_voices(깨진 JSON 은 tts:false)
LiteLLM 은 대역(tts._post)으로 바꾼다."""
import aasserver  # 실제 uvicorn 앱을 띄우는 시험 하네스(OMAI-1100)
import http.client
import io
import json
import os
import tempfile
import threading
import unittest
import urllib.error
from contextlib import redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))

from aas.fleet import primary  # noqa: E402
from aas.ops import tts  # noqa: E402
from aas.web import server  # noqa: E402

VOICES = [{"id": "ko-female-calm-a", "name": {"ko": "차분한 여성", "en": "Calm female"}, "gender": "female", "ref_text": "참조",
           "sample": "안녕하세요. 저는 차분한 여성 목소리입니다."},
          {"id": "ko-male-calm-b", "name": {"ko": "차분한 남성", "en": "Calm male"}, "gender": "male", "ref_text": "참조",
           "sample": "안녕하세요. 저는 차분한 남성 목소리입니다."}]
ENV = {"AAS_TTS_MODEL": "cogentai-tts", "AAS_TTS_VOICES": json.dumps(VOICES, ensure_ascii=False)}
MP3 = b"ID3\x04fake-mp3"


class FakeLiteLLM:
    """tts._post 대역. 받은 본문을 기록하고, reject 에 든 목소리는 400 으로 거절한다."""

    def __init__(self, reject=(), error=None, gate=None):
        self.reject, self.error, self.gate = set(reject), error, gate
        self.calls = []

    def __call__(self, url, key, payload):
        self.calls.append((url, key, payload))
        if self.gate:
            self.gate.wait(5)
        if self.error:
            raise self.error
        if payload["voice"] in self.reject:
            raise urllib.error.HTTPError(url, 400, "unknown voice", {}, None)
        return MP3


class NormalizeTest(unittest.TestCase):
    def test_Markdown_기호와_URL_을_지우고_글은_남긴다(self):
        out = tts.normalize("## 요약\n\n**굵게** 쓴 _기울임_ 글과 ~~지운~~ 글. [문서](https://example.com/a?b=1) 참고, https://x.io/y 도 보세요.\n"
                            "> 인용입니다\n- 항목 하나\n1. 번호 항목\n---\n`make test` 를 돌립니다")
        for gone in ("#", "**", "~~", "](", "https", "x.io", ">", "---", "`"):
            self.assertNotIn(gone, out)
        for kept in ("요약, 굵게 쓴 기울임 글과 지운 글.", "문서 참고", "인용입니다.", "항목 하나.", "번호 항목.", "make test 를 돌립니다"):
            self.assertIn(kept, out)

    def test_코드_블록은_코드_생략으로_바꾸고_닫히지_않은_블록도_읽지_않는다(self):
        out = tts.normalize("설치합니다.\n\n```bash\npip install secret-pkg\necho 'hello'\n```\n\n끝났습니다.")
        self.assertEqual(out, "설치합니다. 코드 생략. 끝났습니다.")
        cut = tts.normalize("고친 코드입니다.\n```python\ndef f():\n    return 1\n")      # 답이 도중에 끊긴 경우
        self.assertEqual(cut, "고친 코드입니다. 코드 생략.")
        self.assertEqual(tts.normalize("~~~\nx = 1\n~~~\n다음."), "코드 생략. 다음.")

    def test_표는_통째로_지운다(self):
        out = tts.normalize("결과입니다.\n\n| 이름 | 값 |\n|---|:---:|\n| alpha | 1 |\n| beta | 2 |\n\n이상입니다.")
        self.assertEqual(out, "결과입니다. 이상입니다.")
        self.assertNotIn("alpha", out)

    def test_생각_블록_이모지_식별자는_읽지_않는다(self):
        out = tts.normalize("<think>속으로 한 생각</think>완료 ✅ 했습니다 🎉. 파일 /opt/aas/x.py 와 e3b0c44298fc 를 봤습니다.")
        for gone in ("생각", "✅", "🎉", "/opt", "x.py", "e3b0c44298fc"):
            self.assertNotIn(gone, out)
        self.assertIn("완료", out)

    def test_빈_글(self):
        self.assertEqual(tts.normalize(""), "")
        self.assertEqual(tts.plan("   \n\n"), ([], False))


class SplitTest(unittest.TestCase):
    def test_조각은_문장_하나씩(self):
        self.assertEqual(tts.split("오늘은 회의가 세 개 있습니다. 내일은 출장이 잡혀 있습니다! 모레는 정말 쉬는 날인가요?"),
                         ["오늘은 회의가 세 개 있습니다.", "내일은 출장이 잡혀 있습니다!", "모레는 정말 쉬는 날인가요?"])

    def test_15자_미만_문장은_다음_문장과_합친다(self):
        chunks = tts.split("네. 알겠습니다. 지금 바로 보고서를 정리해서 보내 드리겠습니다.")
        self.assertEqual(chunks, ["네. 알겠습니다. 지금 바로 보고서를 정리해서 보내 드리겠습니다."])
        chunks = tts.split("짧은 첫 문장. 둘째 문장도 짧다. 셋째 문장은 열다섯 자를 넘습니다.")
        self.assertEqual(chunks, ["짧은 첫 문장. 둘째 문장도 짧다.", "셋째 문장은 열다섯 자를 넘습니다."])

    def test_마지막_문장이_15자_미만이면_앞_조각에_붙인다(self):
        chunks = tts.split("첫 문장은 충분히 길게 써 둔 문장입니다. 끝.")
        self.assertEqual(chunks, ["첫 문장은 충분히 길게 써 둔 문장입니다. 끝."])
        self.assertEqual(tts.split("아주 짧음."), ["아주 짧음."])                       # 앞 조각이 없으면 그대로 하나

    def test_100자를_넘는_문장은_쉼표에서_자른다(self):
        a, b, c = "가" * 40, "나" * 40, "다" * 40
        chunks = tts.split(f"{a}, {b}, {c}.")
        self.assertEqual(chunks, [f"{a}, {b},", f"{c}."])
        self.assertTrue(all(len(x) <= tts.CHUNK_MAX for x in chunks))

    def test_쉼표가_없으면_100자_앞_마지막_띄어쓰기에서_자른다(self):
        words = " ".join(["낱말여섯자임"] * 20) + "."                                  # 7자 단위 140자
        chunks = tts.split(words)
        self.assertEqual(len(chunks), 2)
        self.assertLessEqual(len(chunks[0]), tts.CHUNK_MAX)
        self.assertFalse(chunks[0].endswith(" "))
        self.assertEqual(" ".join(chunks), words)                                       # 글자를 잃지 않는다

    def test_띄어쓰기도_없으면_100자에서_자른다(self):
        chunks = tts.split("가" * 250 + ".")
        self.assertEqual([len(x) for x in chunks], [100, 100, 51])

    def test_같은_글은_늘_같은_조각(self):
        text = ("# 보고\n\n오늘 할 일은 다음과 같습니다.\n\n- 회의 준비, 자료 정리, 발표 연습\n- 고객 전화\n\n```\ncode\n```\n\n"
                + "아주 긴 문장입니다 " * 30 + "끝. 네.")
        first = tts.plan(text)
        for _ in range(5):
            self.assertEqual(tts.plan(text), first)

    def test_코드_블록이_조각_경계를_넘어도_코드는_읽히지_않는다(self):
        code = "\n".join(f"print('비밀 코드 줄 {i}')  # 설명 문장도 들어 있습니다." for i in range(40))
        chunks, _ = tts.plan(f"앞 설명 문장이 여기 있습니다.\n```python\n{code}\n```\n뒤 설명 문장이 여기 있습니다.")
        self.assertEqual(chunks, ["앞 설명 문장이 여기 있습니다.", "코드 생략. 뒤 설명 문장이 여기 있습니다."])   # 「코드 생략.」(6자)은 다음 문장과 합친다

    def test_읽을_글은_6000자까지만(self):
        long = "이 문장은 잘림 시험을 위한 문장입니다. " * 600                           # 다듬은 뒤 약 13,000자
        chunks, truncated = tts.plan(long)
        self.assertTrue(truncated)
        self.assertLessEqual(sum(len(c) for c in chunks) + len(chunks), tts.READ_MAX + 1)
        self.assertTrue(chunks[-1].endswith("."))                                        # 문장 끝에서 자른다
        self.assertEqual(tts.plan("짧은 답은 자르지 않습니다.")[1], False)

    def test_코드만_있는_답은_읽을_글이_없다(self):
        self.assertEqual(tts.plan("```\nls -al\n```"), ([], False))


class SpeakBase(unittest.TestCase):
    def setUp(self):
        self.env = mock.patch.dict(os.environ, ENV)
        self.env.start()
        tts.reset()
        self.logs = []
        self.patches = [mock.patch.object(server.store, "log_usage", side_effect=lambda kind, note, **kw: self.logs.append((kind, note))),
                        mock.patch.object(tts.models, "api_base", return_value="http://litellm.test/v1"),
                        mock.patch.object(tts.models, "server_llm_key", return_value=("sk-test", "AAS_LITELLM_KEY"))]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()
        self.env.stop()
        tts.reset()

    def speak(self, fake, body, who="u@x.com"):
        with mock.patch.object(tts, "_post", fake), redirect_stdout(io.StringIO()) as out:
            code, data, headers = server._speak("tp", "main", body, who)
        self.stdout = out.getvalue()
        return code, data, headers


TEXT = "첫째 문장은 충분히 길게 씁니다. 둘째 문장도 충분히 길게 씁니다. 셋째 문장도 마찬가지로 길게 씁니다."


class SpeakTest(SpeakBase):
    def test_조각_하나를_LiteLLM_으로_합성해_mp3_와_조각_수를_돌려준다(self):
        fake = FakeLiteLLM()
        code, data, headers = self.speak(fake, {"text": TEXT, "voice": "ko-male-calm-b", "part": 1})
        self.assertEqual((code, data, headers), (200, MP3, {"X-Speak-Parts": "3"}))
        url, key, payload = fake.calls[0]
        self.assertEqual((url, key), ("http://litellm.test/v1/audio/speech", "sk-test"))
        # LiteLLM 1.104 는 language·max_new_tokens 를 버리므로 보내지 않는다(§8-5 ④)
        self.assertEqual(payload, {"model": "cogentai-tts", "input": "둘째 문장도 충분히 길게 씁니다.", "voice": "ko-male-calm-b", "response_format": "mp3"})
        self.assertEqual([k for k, _ in self.logs], ["chat_speak"])
        self.assertIn("u@x.com", self.logs[0][1])
        self.assertNotIn("둘째", self.logs[0][1])                                           # 글은 남기지 않는다
        self.assertIn(str(len("둘째 문장도 충분히 길게 씁니다.")), self.logs[0][1])

    def test_part_를_주지_않으면_첫_조각(self):
        fake = FakeLiteLLM()
        self.assertEqual(self.speak(fake, {"text": TEXT, "voice": "ko-female-calm-a"})[0], 200)
        self.assertEqual(fake.calls[0][2]["input"], "첫째 문장은 충분히 길게 씁니다.")

    def test_읽을_글이_없으면_204_와_조각_수_0(self):
        fake = FakeLiteLLM()
        code, data, headers = self.speak(fake, {"text": "```\nrm -rf /tmp/x\n```", "voice": "ko-female-calm-a", "part": 0})
        self.assertEqual((code, data, headers), (204, b"", {"X-Speak-Parts": "0"}))
        self.assertEqual(fake.calls, [])

    def test_part_가_범위_밖이거나_숫자가_아니면_400(self):
        fake = FakeLiteLLM()
        for part in (3, -1, "1", 1.0, True, None):
            code, data, headers = self.speak(fake, {"text": TEXT, "voice": "ko-female-calm-a", "part": part})
            self.assertEqual(code, 400, part)
        self.assertEqual(fake.calls, [])
        self.assertEqual(self.speak(fake, {"text": TEXT, "part": 3})[2], {"X-Speak-Parts": "3"})   # 범위 밖이어도 조각 수는 알린다

    def test_답이_20000자를_넘거나_글이_아니면_400(self):
        fake = FakeLiteLLM()
        self.assertEqual(self.speak(fake, {"text": "가" * (tts.TEXT_MAX + 1), "part": 0})[0], 400)
        self.assertEqual(self.speak(fake, {"text": ["x"], "part": 0})[0], 400)
        self.assertEqual(self.speak(fake, {"part": 0})[0], 400)
        self.assertEqual(self.speak(fake, {"text": "이 답은 상한에 딱 맞는 길이입니다. " * 10 + "가" * 10, "part": 0})[0], 200)
        self.assertEqual(len(fake.calls), 1)

    def test_읽을_글이_6000자를_넘으면_잘림_헤더(self):
        fake = FakeLiteLLM()
        code, _, headers = self.speak(fake, {"text": "이 문장은 잘림 시험을 위한 문장입니다. " * 600, "part": 0})
        self.assertEqual((code, headers.get("X-Speak-Truncated")), (200, "1"))
        self.assertNotIn("X-Speak-Truncated", self.speak(fake, {"text": TEXT, "part": 0})[2])

    def test_모르는_목소리는_첫_목소리로(self):
        fake = FakeLiteLLM()
        for voice in ("nope", "", None, 3):
            self.speak(fake, {"text": TEXT, "voice": voice, "part": 0})
        self.assertEqual({c[2]["voice"] for c in fake.calls}, {"ko-female-calm-a"})

    def test_엔진이_목소리를_거절하면_첫_목소리로_한_번만_다시_부르고_경고(self):
        fake = FakeLiteLLM(reject={"ko-male-calm-b"})
        code, data, _ = self.speak(fake, {"text": TEXT, "voice": "ko-male-calm-b", "part": 0})
        self.assertEqual((code, data), (200, MP3))
        self.assertEqual([c[2]["voice"] for c in fake.calls], ["ko-male-calm-b", "ko-female-calm-a"])
        self.assertIn("ko-male-calm-b", self.stdout)                                         # 경고 로그

    def test_첫_목소리도_거절되면_다시_부르지_않고_사용자_문구(self):
        fake = FakeLiteLLM(reject={"ko-female-calm-a", "ko-male-calm-b"})
        code, data, _ = self.speak(fake, {"text": TEXT, "voice": "ko-female-calm-a", "part": 0})
        self.assertEqual(code, 502)
        self.assertEqual(len(fake.calls), 1)
        self.assertEqual(self.logs, [])
        fake2 = FakeLiteLLM(reject={"ko-female-calm-a", "ko-male-calm-b"})
        self.assertEqual(self.speak(fake2, {"text": TEXT, "voice": "ko-male-calm-b", "part": 0})[0], 502)
        self.assertEqual(len(fake2.calls), 2)                                                # 다시 부르기는 한 번뿐

    def test_LiteLLM_오류는_원문_대신_사용자_문구(self):
        cases = [(urllib.error.HTTPError("u", 500, "boom secret", {}, None), 502),
                 (urllib.error.HTTPError("u", 401, "bad key", {}, None), 502),
                 (urllib.error.URLError(ConnectionRefusedError("refused")), 503),
                 (urllib.error.URLError(TimeoutError("slow")), 504),
                 (TimeoutError("slow"), 504)]
        seen = set()
        for err, want in cases:
            code, data, _ = self.speak(FakeLiteLLM(error=err), {"text": TEXT, "part": 0})
            self.assertEqual(code, want, err)
            self.assertNotIn("secret", data["error"])
            seen.add(data["error"])
        self.assertEqual(len(seen), 3)                                                       # 502·503·504 는 다른 문구
        self.assertEqual(self.logs, [])

    def test_주소가_없으면_503(self):
        with mock.patch.object(tts.models, "api_base", return_value=""):
            code, _, _ = self.speak(FakeLiteLLM(), {"text": TEXT, "part": 0})
        self.assertEqual(code, 503)

    def test_읽어_주기가_꺼져_있으면_404(self):
        for env in ({"AAS_TTS_MODEL": ""}, {"AAS_TTS_VOICES": ""}, {"AAS_TTS_VOICES": "{broken"}):
            with mock.patch.dict(os.environ, env):
                fake = FakeLiteLLM()
                self.assertEqual(self.speak(fake, {"text": TEXT, "part": 0})[0], 404, env)
                self.assertEqual(fake.calls, [])


class LimitTest(SpeakBase):
    def _hold(self, who="u@x.com"):
        """첫 요청을 합성 도중에 붙잡아 둔다."""
        gate = threading.Event()
        first = FakeLiteLLM(gate=gate)
        t = threading.Thread(target=lambda: server._speak("tp", "main", {"text": TEXT, "part": 0}, who))
        with mock.patch.object(tts, "_post", first):
            t.start()
            for _ in range(200):
                if first.calls:
                    break
                threading.Event().wait(0.01)
        return gate, t, first

    def test_같은_사람의_두_번째_요청은_429_이전_읽기를_마무리하는_중(self):
        gate, t, first = self._hold()
        try:
            code, data, _ = self.speak(FakeLiteLLM(), {"text": TEXT, "part": 1})
            self.assertEqual((code, data["error"], data["busy"]), (429, "이전 읽기를 마무리하는 중입니다", "user"))
            self.assertEqual(self.speak(FakeLiteLLM(), {"text": TEXT, "part": 1}, who="v@x.com")[0], 200)   # 다른 사람은 된다
        finally:
            gate.set()
            t.join(5)
        self.assertEqual(self.speak(FakeLiteLLM(), {"text": TEXT, "part": 1})[0], 200)       # 끝나면 자리가 돌아온다

    def test_서버_자리가_다_차면_기다리지_않고_429(self):
        with mock.patch.dict(os.environ, {"AAS_SPEAK_SLOTS": "1", "AAS_SPEAK_PER_USER": "3"}):
            tts.reset()
            gate, t, _ = self._hold()
            try:
                code, data, _ = self.speak(FakeLiteLLM(), {"text": TEXT, "part": 1}, who="v@x.com")
                self.assertEqual((code, data["busy"]), (429, "slots"))
                self.assertEqual(tts.limits()._busy, {"u@x.com": 1})                          # 거절된 사람의 몫은 바로 돌려준다
            finally:
                gate.set()
                t.join(5)
            self.assertEqual(self.speak(FakeLiteLLM(), {"text": TEXT, "part": 1}, who="v@x.com")[0], 200)
            self.assertEqual(tts.limits()._busy, {})

    def test_기본_한도는_사람마다_1_서버마다_2(self):
        lim = tts.limits()
        self.assertEqual(lim.acquire("a"), "")
        self.assertEqual(lim.acquire("a"), "user")
        self.assertEqual(lim.acquire("b"), "")
        self.assertEqual(lim.acquire("c"), "slots")
        lim.release("a")
        lim.release("b")
        self.assertEqual(lim.acquire("c"), "")
        lim.release("c")

    def test_합성이_실패해도_자리를_돌려준다(self):
        self.speak(FakeLiteLLM(error=urllib.error.URLError(OSError("x"))), {"text": TEXT, "part": 0})
        self.assertEqual(tts.limits()._busy, {})
        self.assertEqual(self.speak(FakeLiteLLM(), {"text": TEXT, "part": 0})[0], 200)


class VoicesConfigTest(unittest.TestCase):
    def info(self, env):
        with mock.patch.dict(os.environ, env), redirect_stdout(io.StringIO()) as out:
            got = tts.info()
        return got, out.getvalue()

    def test_모델과_목소리가_있으면_켜짐_목록은_id_이름_성별만(self):
        got, _ = self.info(ENV)
        self.assertIs(got["tts"], True)
        self.assertEqual(got["voices"], [{"id": "ko-female-calm-a", "name": {"ko": "차분한 여성", "en": "Calm female"}, "gender": "female"},
                                         {"id": "ko-male-calm-b", "name": {"ko": "차분한 남성", "en": "Calm male"}, "gender": "male"}])

    def test_모델이_없거나_목록이_비거나_깨지면_꺼짐_경고는_한_번(self):
        self.assertEqual(self.info({**ENV, "AAS_TTS_MODEL": ""})[0], {"tts": False, "voices": []})
        for raw in ("", "[]", "{not json", '{"id": "x"}', '[{"name": "no id"}, 3]'):
            tts._warned.discard(raw)
            got, log = self.info({**ENV, "AAS_TTS_VOICES": raw})
            self.assertEqual(got, {"tts": False, "voices": []}, raw)
            self.assertIn("AAS_TTS_VOICES", log, raw)
            self.assertEqual(self.info({**ENV, "AAS_TTS_VOICES": raw})[1], "", raw)          # 같은 값이면 다시 경고하지 않는다

    def test_id_가_없는_항목은_빼고_나머지로_켠다(self):
        got, _ = self.info({**ENV, "AAS_TTS_VOICES": json.dumps([{"name": "x"}, {"id": "only", "name": "하나"}, {"id": "only"}])})
        self.assertEqual(got, {"tts": True, "voices": [{"id": "only", "name": "하나", "gender": ""}]})

    def test_chat_status_에_tts_와_목록이_실린다_깨져도_예외_없음(self):
        hub = SimpleNamespace(status=lambda: {"connected": True})
        with mock.patch.object(server, "hub", return_value=hub), mock.patch.object(server, "workspace_for", return_value=None), \
                mock.patch.object(server.primary, "primary_of", return_value="main"), mock.patch.object(server, "_pod_owner_name", return_value=""), \
                mock.patch.object(server.cron_health.hr, "profiles", return_value=[]), mock.patch.object(server, "_agents", return_value=[]), \
                mock.patch.object(server.chat_default, "resolve", return_value="main"), redirect_stdout(io.StringIO()):
            pod = SimpleNamespace(id="tp", hermes_home=Path(TMP.name))
            with mock.patch.dict(os.environ, ENV):
                st = server._chat_status(pod)
                self.assertIs(st["tts"], True)
                self.assertEqual([v["id"] for v in st["tts_voices"]], ["ko-female-calm-a", "ko-male-calm-b"])
                self.assertNotIn("sample", st["tts_voices"][0])
            with mock.patch.dict(os.environ, {**ENV, "AAS_TTS_VOICES": "[{broken"}):
                st = server._chat_status(pod)
                self.assertEqual((st["tts"], st["tts_voices"], st["connected"]), (False, [], True))
            with mock.patch.dict(os.environ, ENV), mock.patch.object(tts, "voices", side_effect=RuntimeError("x")):
                self.assertIs(server._chat_status(pod)["tts"], False)


class FakeHub:
    def __init__(self, pid):
        self.pid = pid

    def status(self):
        return {"configured": True, "connected": True, "error": "", "sessions": []}


class HttpTest(unittest.TestCase):
    """실제 서버로: 경로·권한·헤더·mp3 응답."""

    @classmethod
    def setUpClass(cls):
        from aas.auth import auth
        from aas.fleet import pods
        cls.old = {k: os.environ.get(k) for k in ("AAS_OIDC_ISSUER", "AAS_OIDC_CLIENT_FILE", "AAS_USERS_FILE", "AAS_ALLOWED_HOSTS", "AAS_PODS_FILE")}
        for k in cls.old:
            os.environ.pop(k, None)
        os.environ["AAS_USERS_FILE"] = str(Path(TMP.name) / "no-users.json")
        os.environ["AAS_PODS_FILE"] = str(Path(TMP.name) / "no-pods.json")
        homes = {}
        for pid in ("t", "u"):
            homes[pid] = Path(TMP.name) / f"speak-hermes-{pid}"
            (homes[pid] / "profiles" / "main").mkdir(parents=True, exist_ok=True)
        reg = Path(TMP.name) / "speak-pods.json"
        reg.write_text(json.dumps({"pods": [{"id": pid, "owner": f"{pid}@example.com", "hermes_home": str(h)} for pid, h in homes.items()]}))
        cls.saved = (server._auth, server._registry)
        server._auth = auth.Auth({"issuer": "https://accounts.google.com", "client_id": "", "client_secret": "", "domain": "",
                                  "public_url": "http://localhost:17900", "hours": 1, "users_file": Path(TMP.name) / "no-users.json"})
        server._registry = pods.Registry(reg)
        cls.httpd = aasserver.start()
        cls.port = cls.httpd.server_port

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        for k, v in cls.old.items():
            if v is not None:
                os.environ[k] = v
            else:
                os.environ.pop(k, None)
        server._auth, server._registry = cls.saved

    def req(self, method, path, body=None):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        c.request(method, path, body=json.dumps(body) if body is not None else None, headers={"Content-Type": "application/json", "X-AAS": "1"})
        r = c.getresponse()
        data = r.read()
        headers = {k.lower(): v for k, v in r.getheaders()}
        c.close()
        return r.status, headers, data

    def setUp(self):
        tts.reset()
        self.fake = FakeLiteLLM()
        self.logs = []
        self.patches = [mock.patch.dict(os.environ, ENV),
                        mock.patch.object(server, "hub", side_effect=lambda pod: FakeHub(pod.id)),
                        mock.patch.object(server.cron_health.hr, "profiles", return_value=[SimpleNamespace(name="main")]),
                        mock.patch.object(primary, "is_target", return_value=True),
                        mock.patch.object(primary, "primary_of", return_value="main"),
                        mock.patch.object(server.store, "log_usage", side_effect=lambda kind, note, **kw: self.logs.append((kind, note))),
                        mock.patch.object(tts.models, "api_base", return_value="http://litellm.test/v1"),
                        mock.patch.object(tts.models, "server_llm_key", return_value=("", "")),
                        mock.patch.object(tts, "_post", self.fake)]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in reversed(self.patches):
            p.stop()
        tts.reset()

    def test_speak_는_mp3_와_조각_헤더를_돌려준다(self):
        status, headers, data = self.req("POST", "/api/chat/speak", {"pod": "u", "profile": "main", "text": TEXT, "voice": "ko-male-calm-b", "part": 2})
        self.assertEqual((status, headers["content-type"], data, headers["x-speak-parts"]), (200, "audio/mpeg", MP3, "3"))
        self.assertNotIn("x-speak-truncated", headers)
        self.assertEqual(self.fake.calls[0][2]["input"], "셋째 문장도 마찬가지로 길게 씁니다.")

    def test_읽을_글이_없으면_204_범위_밖은_400(self):
        status, headers, data = self.req("POST", "/api/chat/speak", {"pod": "u", "profile": "main", "text": "```\nx\n```", "part": 0})
        self.assertEqual((status, headers["x-speak-parts"], data), (204, "0", b""))
        status, headers, data = self.req("POST", "/api/chat/speak", {"pod": "u", "profile": "main", "text": TEXT, "part": 9})
        self.assertEqual((status, headers["x-speak-parts"]), (400, "3"))
        self.assertIn("error", json.loads(data))

    def test_남의_에이전트나_없는_프로파일은_거절(self):
        self.assertEqual(self.req("POST", "/api/chat/speak", {"pod": "ghost", "profile": "main", "text": TEXT, "part": 0})[0], 403)
        self.assertEqual(self.req("POST", "/api/chat/speak", {"pod": "u", "profile": "nope", "text": TEXT, "part": 0})[0], 400)
        self.assertEqual(self.fake.calls, [])

    def test_남의_에이전트는_로그인한_사용자에게도_403(self):
        """로그인을 켠 설치: t 의 주인은 u 의 에이전트로 읽어 주기를 부르지 못한다(/api/chat/send 와 같은 검사)."""
        user = {"email": "t@example.com", "name": "t"}
        auth_on = SimpleNamespace(enabled=True)
        t_pod = server._registry.pods[0]
        with mock.patch.object(server.Handler, "_context", lambda self: (auth_on, user, t_pod)), \
                mock.patch.object(server.Registry, "allowed", lambda self, u, enabled, restarting=False: [t_pod]), \
                mock.patch.object(server.Handler, "_mark_actor_role", lambda self, a, u, p: None):
            self.assertEqual(self.req("POST", "/api/chat/speak", {"pod": "u", "profile": "main", "text": TEXT, "part": 0})[0], 403)
            self.assertEqual(self.req("POST", "/api/chat/speak", {"pod": "t", "profile": "main", "text": TEXT, "part": 0})[0], 200)
        self.assertEqual(len(self.fake.calls), 1)

    def test_목소리_목록과_미리_듣기(self):
        status, _, data = self.req("GET", "/api/tts/voices")
        body = json.loads(data)
        self.assertEqual((status, body["tts"], [v["id"] for v in body["voices"]]), (200, True, ["ko-female-calm-a", "ko-male-calm-b"]))
        status, headers, data = self.req("POST", "/api/tts/preview", {"voice": "ko-male-calm-b", "text": "자유 글은 읽지 않는다"})
        self.assertEqual((status, headers["content-type"], data), (200, "audio/mpeg", MP3))
        self.assertEqual(self.fake.calls[0][2]["input"], "안녕하세요. 저는 차분한 남성 목소리입니다.")
        self.assertEqual(self.fake.calls[0][2]["voice"], "ko-male-calm-b")
        self.assertEqual(self.req("POST", "/api/tts/preview", {"voice": "nope"})[0], 400)
        self.assertEqual([k for k, _ in self.logs], ["chat_speak"])

    def test_꺼져_있으면_목록은_tts_false_합성은_404(self):
        with mock.patch.dict(os.environ, {"AAS_TTS_MODEL": ""}):
            self.assertEqual(json.loads(self.req("GET", "/api/tts/voices")[2]), {"tts": False, "voices": []})
            self.assertEqual(self.req("POST", "/api/tts/preview", {"voice": "ko-male-calm-b"})[0], 404)
            self.assertEqual(self.req("POST", "/api/chat/speak", {"pod": "u", "profile": "main", "text": TEXT, "part": 0})[0], 404)
        self.assertEqual(self.fake.calls, [])

    def test_미리_듣기도_사람별_한도를_함께_쓴다(self):
        lim = tts.limits()
        self.assertEqual(lim.acquire("local"), "")                                           # 로그인을 끈 설치의 사용자는 local
        try:
            status, _, data = self.req("POST", "/api/tts/preview", {"voice": "ko-male-calm-b"})
            self.assertEqual((status, json.loads(data)["busy"]), (429, "user"))
        finally:
            lim.release("local")


if __name__ == "__main__":
    unittest.main()
