# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""compose 시험 환경용 설정 — 관리자를 환경변수로 지정하고, 마켓 설치를 끈다(쿠버네티스에서만 설치)."""
import json
import os
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

TMP = tempfile.TemporaryDirectory()
os.environ.setdefault("AAS_DATA_DIR", str(Path(TMP.name) / "data"))
os.environ.setdefault("AAS_CONFIG_DIR", str(Path(TMP.name) / "cfg"))

from aas.market import marketplace as mk
from aas.fleet import pods  # noqa: E402

PKG = {"id": "free/hello", "namespace": "free", "name": "hello", "kind": "skill", "version": "1.0.0", "versions": [{"version": "1.0.0"}], "paid": False}


class AdminsFromEnv(unittest.TestCase):
    def tearDown(self):
        os.environ.pop("AAS_ADMINS", None)

    def test_등록부_파일이_없어도_AAS_ADMINS_가_관리자다(self):
        os.environ["AAS_ADMINS"] = "Admin@Example.com, ops@example.com  kim@example.com"
        reg = pods.Registry(Path(TMP.name) / "없는-파일.json")
        self.assertEqual(reg.admins, {"admin@example.com", "ops@example.com", "kim@example.com"})
        self.assertTrue(reg.is_admin({"email": "ADMIN@example.com"}))

    def test_등록부_파일의_관리자와_합쳐진다(self):
        path = Path(TMP.name) / "pods.json"
        path.write_text(json.dumps({"admins": ["file@x.com"], "pods": [{"id": "a", "owner": "a@x.com", "hermes_home": TMP.name}]}), encoding="utf-8")
        os.environ["AAS_ADMINS"] = "env@x.com"
        reg = pods.Registry(path)
        self.assertEqual(reg.admins, {"file@x.com", "env@x.com"})

    def test_지정하지_않으면_관리자는_없다(self):
        self.assertEqual(pods.Registry(Path(TMP.name) / "없는-파일.json").admins, set())

    def test_이메일_모양이_아닌_값은_버린다(self):
        os.environ["AAS_ADMINS"] = "not-an-email, ok@x.com"
        self.assertEqual(pods.Registry(Path(TMP.name) / "없는-파일.json").admins, {"ok@x.com"})


class MarketInstallOff(unittest.TestCase):
    def tearDown(self):
        os.environ.pop("AAS_MARKET_INSTALL", None)

    def test_기본은_켜짐이다(self):
        self.assertEqual(mk.install_state(), {"enabled": True, "reason": ""})

    def test_off_이면_이유와_함께_꺼진다(self):
        os.environ["AAS_MARKET_INSTALL"] = "OFF"
        st = mk.install_state()
        self.assertFalse(st["enabled"])
        self.assertIn("쿠버네티스", st["reason"])

    def test_개요에_설치_상태가_실린다(self):
        os.environ["AAS_MARKET_INSTALL"] = "off"
        out = mk.overview("pod1", {"url": "", "token_file": "", "namespaces": []})
        self.assertFalse(out["install"]["enabled"])

    def test_설치_요청은_거절한다(self):
        os.environ["AAS_MARKET_INSTALL"] = "off"
        with self.assertRaises(mk.MarketError) as cm:
            mk.request_install("pod1", "hermes", PKG, "1.0.0", "ma", "install", "kim@x.com", ["ma"])
        self.assertIn("쿠버네티스", str(cm.exception))

    def test_지우기_요청도_거절한다(self):
        os.environ["AAS_MARKET_INSTALL"] = "off"
        with self.assertRaises(mk.MarketError):
            mk.request_remove("pod1", "hermes", "free/hello", "ma", "kim@x.com")

class MultiHermesCompose(unittest.TestCase):
    """docker-compose.multi.yml 과 pods.multi.json 이 서로 맞는지(서비스 이름·주소·읽기 사용자)."""

    DIR = Path(__file__).resolve().parent.parent / "deploy" / "compose"

    def test_등록부의_설치본마다_Hermes_와_사이드카_서비스가_있다(self):
        text = (self.DIR / "docker-compose.multi.yml").read_text(encoding="utf-8")
        data = json.loads((self.DIR / "pods.multi.json").read_text(encoding="utf-8"))
        ids = [p["id"] for p in data["pods"]]
        self.assertGreaterEqual(len(ids), 2)
        for pid in ids:
            self.assertIn(f"\n  hermes-{pid}:\n", text)
            self.assertIn(f"\n  sidecar-{pid}:\n", text)
            self.assertIn(f"hermes-{pid}-data:/opt/data:ro", text)        # 사이드카는 읽기 전용
        for p in data["pods"]:
            self.assertEqual(p["sidecar_url"], f"http://sidecar-{p['id']}:17950")
            self.assertEqual(p["dashboard_url"], f"http://hermes-{p['id']}:9119")

    def test_서버에는_Hermes_폴더를_붙이지_않고_사이드카는_Hermes_사용자로_읽는다(self):
        text = (self.DIR / "docker-compose.multi.yml").read_text(encoding="utf-8")
        aas = text[text.index("\n  aas:\n"):text.index("\n  hermes-one:\n")]
        self.assertNotIn("/opt/data", aas)
        self.assertIn("HERMES_UID", text)                                 # 0600 파일(state.db)을 읽으려면 같은 사용자여야 한다

    def test_비밀값은_파일에_없고_pods_는_환경변수_이름만_적는다(self):
        for name in ("docker-compose.multi.yml", "pods.multi.json", ".env.example"):
            text = (self.DIR / name).read_text(encoding="utf-8")
            self.assertNotRegex(text, r"(?i)password\s*[:=]\s*[\"']?[A-Za-z0-9]{6,}", name)
        data = json.loads((self.DIR / "pods.multi.json").read_text(encoding="utf-8"))
        for p in data["pods"]:
            self.assertTrue(p["dashboard_user_env"].isupper() and p["dashboard_password_env"].isupper())

    def test_Hermes_모델_설정은_환경변수만_읽고_모든_Hermes_에_붙는다(self):
        text = (self.DIR / "docker-compose.multi.yml").read_text(encoding="utf-8")
        conf = (self.DIR / "hermes-config.seed.yaml").read_text(encoding="utf-8")
        for var in ("HERMES_LLM_BASE_URL", "HERMES_LLM_MODEL", "HERMES_LLM_API_KEY"):
            self.assertIn("${%s}" % var, conf)                            # 설정 파일에는 값이 없다
            self.assertIn(f"{var}: ${{{var}", text)                       # compose 가 .env 에서 넘긴다
        self.assertRegex(conf, r"(?m)^_config_version: \d+")              # 복사본을 Hermes 가 이 번호부터 마이그레이션한다
        for pid in ("one", "two", "three"):
            self.assertIn(f'hermes-{pid}-data:/d/{pid}', text)            # hermes-seed 가 세 볼륨에 첫 설정을 넣는다(R8)
            self.assertIn(f'volumes: ["hermes-{pid}-data:/opt/data"]', text)
        self.assertIn("host.docker.internal:host-gateway", text)           # 호스트의 LiteLLM 터널에 닿는 길

    @unittest.skipUnless((Path(__file__).resolve().parents[1] / "deploy/compose/oke-litellm.sh").exists(),
                         "사내 전용 파일이라 공개 스냅샷에는 없다(.gitattributes export-ignore)")
    def test_OKE_연결_스크립트에는_주소와_키가_없다(self):
        script = (self.DIR / "oke-litellm.sh").read_text(encoding="utf-8")
        addresses = set(re.findall(r"\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b", script)) - {"127.0.0.1"}
        self.assertEqual(addresses, set())                                 # 베스천·GB10 주소는 .env 에서만(루프백은 터널 주소)
        self.assertIn("OKE_BASTION", script)
        self.assertNotRegex(script, r"(?i)(password|sshpass)")             # 비밀번호가 아니라 SSH 키로 들어간다
        self.assertTrue(os.access(self.DIR / "oke-litellm.sh", os.X_OK))



COMPOSE_DIR = Path(__file__).resolve().parent.parent / "deploy" / "compose"
COMPOSE_FILES = ("docker-compose.yml", "docker-compose.attach.yml", "docker-compose.multi.yml")
UPSTREAM_HERMES = "nousresearch/hermes-agent:v0.22.2"


def _compose(name: str) -> dict:
    import yaml
    return yaml.safe_load((COMPOSE_DIR / name).read_text(encoding="utf-8"))


class QuickStartCompose(unittest.TestCase):
    """빠른 시작·붙기·여러 개 compose 가 공개 자원만으로 뜨는 모양인지(스펙 2026-10-21-015 단계 2)."""

    def test_이미지_기본값은_공개_레지스트리다(self):
        public = ("ghcr.io/openmaru-io/", "nousresearch/hermes-agent:", "busybox:", "python:", "postgres:", "redis:", "ghcr.io/iflytek/")
        for name in sorted(p.name for p in COMPOSE_DIR.glob("docker-compose*.yml")):
            text = (COMPOSE_DIR / name).read_text(encoding="utf-8")
            for ref in re.findall(r"(?m)^\s*image:\s*(\S+)", text):
                default = re.sub(r"^\$\{[A-Z_]+:-(.*)\}$", r"\1", ref)         # ${AAS_IMAGE:-기본값} 이면 기본값
                with self.subTest(name=name, image=default):
                    self.assertTrue(default.startswith(public), default)

    def test_Hermes_기본_이미지는_상류_공개_이미지다(self):
        # oauth-test 는 사내 레포에만 있다(.gitattributes 로 공개본에서 뺀다)
        for name in ("docker-compose.yml", "docker-compose.multi.yml", "docker-compose.oauth-test.yml"):
            if not (COMPOSE_DIR / name).exists():
                continue
            with self.subTest(name=name):
                self.assertIn("${HERMES_IMAGE:-%s}" % UPSTREAM_HERMES, (COMPOSE_DIR / name).read_text(encoding="utf-8"))
        hermes = _compose("docker-compose.yml")["services"]["hermes"]
        self.assertEqual(hermes["command"], ["gateway", "run"])                     # 게이트웨이(크론·채널) + s6 대시보드
        self.assertEqual(hermes["environment"]["HERMES_DASHBOARD"], "1")
        self.assertNotIn("user", hermes)                                             # 상류 이미지는 --user 를 거부한다(HERMES_UID 로)

    def test_사이드카는_Hermes_와_같은_사용자로_읽는다(self):
        for name in ("docker-compose.yml", "docker-compose.attach.yml"):
            with self.subTest(name=name):
                services = _compose(name)["services"]
                side = services.get("sidecar") or services["aas-sidecar"]
                self.assertEqual(side["user"], "${HERMES_UID:-10000}:${HERMES_GID:-10000}")     # 0600 파일(B5)

    def test_빠른_시작의_필수_값은_비면_up_이_멈춘다(self):
        text = (COMPOSE_DIR / "docker-compose.yml").read_text(encoding="utf-8")
        for var in ("AAS_ADMIN_EMAIL", "AAS_ADMIN_PASSWORD", "AAS_SIDECAR_TOKEN", "HERMES_DASHBOARD_PASSWORD",
                    "HERMES_LLM_BASE_URL", "HERMES_LLM_MODEL"):
            with self.subTest(var=var):
                self.assertRegex(text, r"\$\{%s:\?" % var)
        env = (COMPOSE_DIR / ".env.example").read_text(encoding="utf-8")
        required = env[env.index("# --- 필수"):env.index("# --- 선택")]
        for var in ("AAS_ADMIN_EMAIL", "AAS_ADMIN_PASSWORD", "AAS_SIDECAR_TOKEN", "HERMES_DASHBOARD_PASSWORD", "HERMES_LLM_BASE_URL"):
            self.assertRegex(required, r"(?m)^%s=$" % var)                          # .env.example 맨 위 필수 칸, 값은 비어 있다

    def test_첫_관리자_이메일이_관리자이자_기본_POD_주인이다(self):
        env = _compose("docker-compose.yml")["services"]["aas"]["environment"]
        self.assertEqual(env["AAS_ADMINS"], "${AAS_ADMIN_EMAIL}")
        self.assertEqual(env["AAS_DEFAULT_POD_OWNER"], "${AAS_ADMIN_EMAIL}")
        self.assertEqual(env["AAS_MARKET_INSTALL"], "off")                           # 마켓 설치는 쿠버네티스 전용(D5)
        self.assertEqual(env["AAS_DASHBOARD_URL"], "http://hermes:9119")
        self.assertEqual(env["AAS_SIDECAR_URL"], "http://sidecar:17950")

    def test_HTTPS_프록시를_믿게_하는_값을_env_에서_넘긴다(self):
        # 프록시가 https 를 알려도 AAS_TRUSTED_PROXY 가 없으면 http 로 보아 비밀값 탭이 막힌다(README 리뷰 A2)
        for name in ("docker-compose.yml", "docker-compose.attach.yml"):
            with self.subTest(name=name):
                env = _compose(name)["services"]["aas"]["environment"]
                self.assertEqual(env["AAS_TRUSTED_PROXY"], "${AAS_TRUSTED_PROXY:-}")      # 기본은 믿지 않는다
        self.assertRegex((COMPOSE_DIR / ".env.example").read_text(encoding="utf-8"), r"(?m)^AAS_TRUSTED_PROXY=$")

    def test_모델_화면과_AI_보조는_Hermes_와_같은_LLM_값을_받는다(self):
        env = _compose("docker-compose.yml")["services"]["aas"]["environment"]
        for var in ("HERMES_LLM_BASE_URL", "HERMES_LLM_MODEL"):
            self.assertEqual(env[var], "${%s}" % var)                                   # 새 AAS_LLM_* 를 만들지 않는다(R6)
        for var in ("AAS_MARKET_TAG_MODEL", "AAS_SKILL_SUMMARY_MODEL", "AAS_SKILL_DESC_MODEL"):
            self.assertEqual(env[var], "${HERMES_LLM_MODEL}")                           # AI 보조 모델 이름(F2)
        self.assertEqual(env["AAS_LITELLM_MODEL_PREFIX"], "")                           # 운영 접두어로 거르지 않는다(단계 3-2)
        self.assertNotIn("AAS_K8S_NAMESPACE", env)                                       # compose 는 OpenAI 호환 경로(R5)

    def test_AAS_와_사이드카는_GHCR_이미지를_받고_없으면_소스로_빌드한다(self):
        for name in ("docker-compose.yml", "docker-compose.attach.yml", "docker-compose.multi.yml"):
            for svc_name, svc in _compose(name)["services"].items():
                if "build" not in svc:
                    continue
                with self.subTest(name=name, svc=svc_name):
                    self.assertRegex(svc["image"], r"ghcr\.io/openmaru-io/cogentai-aas-(server|sidecar):\$\{AAS_VERSION:-latest\}")
                    self.assertEqual(svc["pull_policy"], "missing")

    def test_Hermes_는_seed_가_끝난_뒤에_뜬다(self):
        services = _compose("docker-compose.yml")["services"]
        self.assertEqual(services["hermes"]["depends_on"]["hermes-seed"]["condition"], "service_completed_successfully")
        self.assertIn("./hermes-config.seed.yaml:/seed/config.yaml:ro", services["hermes-seed"]["volumes"])


@unittest.skipUnless(shutil.which("sh"), "sh 가 필요하다")
class HermesSeed(unittest.TestCase):
    """hermes-seed.sh: 설정 파일과 기본 프로파일 .env 의 LLM 값은 없을 때만 넣는다(R8·S0-1)."""

    ROOT = os.geteuid() == 0

    def run_seed(self, data, **env):
        # 주인 바꾸기(chown)는 root 만 한다. root 가 아니면(개발자 맥) 지금 사용자로 넘겨 chown 이 아무것도 바꾸지 않게 한다(OMAI-1240)
        owner = {} if self.ROOT else {"HERMES_UID": str(os.getuid()), "HERMES_GID": str(os.getgid())}
        full = {"PATH": os.environ["PATH"], "HERMES_SEED_CONFIG": str(COMPOSE_DIR / "hermes-config.seed.yaml"),
                "HERMES_LLM_BASE_URL": "http://llm/v1", "HERMES_LLM_MODEL": "m1", "HERMES_LLM_API_KEY": "", **owner, **env}
        subprocess.run(["sh", str(COMPOSE_DIR / "hermes-seed.sh"), str(data)], env=full, check=True)

    def test_처음에는_설정을_복사하고_env_에_세_값을_넣는다(self):
        data = Path(tempfile.mkdtemp(dir=TMP.name))
        self.run_seed(data)
        self.assertEqual((data / "config.yaml").read_text(encoding="utf-8"),
                         (COMPOSE_DIR / "hermes-config.seed.yaml").read_text(encoding="utf-8"))
        self.assertEqual((data / ".env").read_text(encoding="utf-8"),
                         "HERMES_LLM_BASE_URL=http://llm/v1\nHERMES_LLM_MODEL=m1\nHERMES_LLM_API_KEY=\n")
        self.assertEqual((data / ".env").stat().st_mode & 0o777, 0o600)
        if self.ROOT:                                                               # 사내 패치 이미지는 hermes 사용자(10000)로 읽는다
            self.assertEqual([(p.stat().st_uid, p.stat().st_gid) for p in (data / "config.yaml", data / ".env")], [(10000, 10000)] * 2)

    def test_이미_있는_설정과_값은_건드리지_않는다(self):
        data = Path(tempfile.mkdtemp(dir=TMP.name))
        (data / "config.yaml").write_text("_config_version: 50\n", encoding="utf-8")
        (data / ".env").write_text("OTHER=1\nHERMES_LLM_MODEL=changed-in-screen\n", encoding="utf-8")
        self.run_seed(data)
        self.run_seed(data, HERMES_LLM_MODEL="m2")                                 # 다시 up 해도 같다
        self.assertEqual((data / "config.yaml").read_text(encoding="utf-8"), "_config_version: 50\n")
        env = (data / ".env").read_text(encoding="utf-8")
        self.assertIn("HERMES_LLM_MODEL=changed-in-screen\n", env)
        self.assertEqual(env.count("HERMES_LLM_BASE_URL="), 1)
        self.assertTrue(env.startswith("OTHER=1\n"))


if __name__ == "__main__":
    unittest.main()
