# AAS compose 환경

AAS 를 Docker Compose 로 띄운다. 운영 설치는 쿠버네티스이고, compose 에서는 다음과 같이 돈다.

- 서버(`aas`)가 Hermes 데이터를 **읽기 사이드카**로만 읽는다. 서버 컨테이너에는 Hermes 폴더가 붙지 않는다(쿠버네티스와 같은 경로).
- 바꾸는 일과 대화는 Hermes 대시보드 API 로 간다.
- **Hermes 만들기와 마켓 설치는 끈다.** 쿠버네티스에서만 할 수 있다. 화면에 이유가 표시된다.

호스트 경로와 호스트 이름은 이 폴더 어디에도 없다. 모두 `.env` 에서 온다.

| 파일 | 구성 | 쓰는 경우 |
|---|---|---|
| `docker-compose.yml` | **빠른 시작.** Hermes 1 + 사이드카 1 + AAS 1 | 처음 쓰는 사람. 이미 돌고 있는 Hermes 가 필요 없다 |
| `docker-compose.attach.yml` | 사이드카 1 + AAS 1 | 이미 돌고 있는 Hermes 에 붙인다 |
| `docker-compose.multi.yml` | Hermes 3 + 사이드카 3 + AAS 1 | 사용자마다 Hermes 를 두는 구조를 시험한다(개발용) |

## 빠른 시작

필요한 것: Docker 와 Docker Compose, OpenAI 호환 LLM 주소 하나(예: 이 컴퓨터의 Ollama, OpenAI). Hermes 는 도구를 쓰려면 문맥 64K 토큰 이상이 필요하다 — Ollama 는 `OLLAMA_CONTEXT_LENGTH=65536` 으로 띄우고 그만큼 되는 모델(예: `llama3.1:8b`, `llama3.2:3b`)을 쓴다.

```sh
cd deploy/compose
cp .env.example .env
# .env 맨 위 「필수」 칸을 채운다: AAS_ADMIN_EMAIL·AAS_ADMIN_PASSWORD, AAS_SIDECAR_TOKEN, HERMES_DASHBOARD_PASSWORD, HERMES_LLM_*
docker compose up -d
```

`http://127.0.0.1:17900` 에 `AAS_ADMIN_EMAIL`·`AAS_ADMIN_PASSWORD` 로 로그인한다(포트는 `AAS_PORT`).

- **첫 관리자**는 AAS 에 계정이 하나도 없을 때만 `.env` 값으로 만든다. 그 뒤 비밀번호를 바꿔도 다시 시작할 때 덮지 않는다. 같은 이메일이 관리자(`AAS_ADMINS`)이고 이 Hermes(설치본 `default`)의 주인이다.
- **Hermes** 는 상류 공개 이미지 `nousresearch/hermes-agent:v0.22.2` 다. 한 컨테이너에서 대시보드와 게이트웨이(크론·채널)가 함께 돈다. 사내 패치가 없어서 작업 지침(AGENTS.md)은 꺼지고, MCP OAuth 연결 상태는 「확인 전」으로 보인다.
- **처음 한 번** `hermes-seed` 가 Hermes 설정(`hermes-config.seed.yaml`)을 데이터 볼륨에 복사하고, 기본 프로파일 비밀값(`.env`)에 `HERMES_LLM_*` 세 값을 넣은 뒤 끝난다(`hermes-seed.sh`). 둘 다 이미 있으면 건드리지 않는다. 상류 Hermes 는 채팅·크론에서 설정의 `${HERMES_LLM_*}` 를 프로파일 비밀값으로만 풀기 때문이다. **나중에 LLM 을 바꾸려면** AAS 의 프로파일 비밀값 화면에서 세 값을 고친다(`.env` 를 바꿔도 이미 만든 프로파일에는 반영되지 않는다).
- **모델 화면과 AI 보조**(태그·요약·슬로건·카드 나누기)도 같은 `HERMES_LLM_*` 를 쓴다. 쿠버네티스가 아니므로 LiteLLM 전용 확인 없이 기본 주소에 `/models`·`/chat/completions` 를 붙이고, 키가 없어도 묻는다. 키가 거절되면 화면에 「키가 거절됐습니다(HERMES_LLM_API_KEY 확인)」가 보인다. AI 보조 호출이 모르는 인자(`chat_template_kwargs`)라며 거절되면 `.env` 에 `AAS_CHAT_TEMPLATE_KWARGS=off` 를 적는다.
- **AAS·사이드카 이미지**는 GHCR(`ghcr.io/openmaru-io/cogentai-aas-server`·`-sidecar`, 태그 `AAS_VERSION`)에서 받고, 받을 수 없으면 이 레포의 소스로 빌드한다. 소스로 다시 빌드하려면 `docker compose up -d --build`.

## 이미 돌고 있는 Hermes 에 붙이기

```sh
cd deploy/compose
cp .env.example .env
# .env 의 「붙기」 칸을 채운다: HERMES_DATA_DIR, AAS_DASHBOARD_*, AAS_SIDECAR_TOKEN, AAS_ADMIN_EMAIL·AAS_ADMIN_PASSWORD
docker compose -f docker-compose.attach.yml up -d
```

- 첫 관리자를 `.env` 로 만들지 않으려면 `./create-user.sh <이메일>` 로 먼저 만든다. 서버는 계정 없이는 `127.0.0.1` 밖으로 열리지 않는다.
- 사이드카는 `HERMES_UID`·`HERMES_GID`(기본 10000)로 읽는다. 붙는 Hermes 의 파일 주인 번호와 같아야 `state.db`·`.env`(0600)를 읽는다.
- 빠른 시작과 프로젝트 이름(`aas`)과 볼륨을 함께 쓴다. 둘 중 하나만 띄운다.

## 확인

```sh
docker compose ps                          # 모두 healthy (hermes-seed 는 끝나서 exited 0)
curl -s http://127.0.0.1:17900/healthz
docker compose logs -f aas
```

- 서버가 Hermes 를 읽지 못하면 사이드카 토큰과 사용자 번호(`HERMES_UID`)를 먼저 본다.
- 채팅·크론이 「Connection error」로 끝나면 Hermes 로그(`docker compose exec hermes tail -50 /opt/data/logs/errors.log`)를 본다. `base_url=${HERMES_LLM_BASE_URL}` 처럼 참조가 그대로 찍혀 있으면 그 프로파일의 비밀값에 `HERMES_LLM_*` 가 없는 것이다.

## Hermes 여러 개로 시험하기

사용자마다 Hermes 가 하나씩 생기는 쿠버네티스 구조를 한 컴퓨터에서 흉내 낸다. 이미 돌고 있는 Hermes 가 없어도 된다.

| 구성 | 개수 | 하는 일 |
|---|---|---|
| Hermes(`hermes-one`·`hermes-two`·`hermes-three`) | 3 | 각자 데이터 볼륨과 대시보드(9119). 사용자 Hermes 파드와 같다 |
| 읽기 사이드카 | 3 | Hermes 마다 하나. 자기 Hermes 의 볼륨만 읽기 전용으로 붙인다 |
| AAS 서버 | 1 | Hermes 폴더를 붙이지 않고, 사이드카(읽기)와 대시보드 API(쓰기·대화)로만 닿는다. 등록부는 `pods.multi.json` |

```sh
cd deploy/compose
cp .env.example .env     # AAS_SIDECAR_TOKEN, HERMES_DASHBOARD_PASSWORD, AAS_ADMIN_PASSWORD 를 채운다(첫 관리자 admin@example.com)
docker compose -f docker-compose.multi.yml up -d --build
./seed-multi.sh          # 설치본마다 프로파일 둘을 만든다(one: ma·ops, two: qa·doc, three: sa·dev)
./seed-data-multi.sh     # 크론 작업(정상·멈춤·실패)·실행 기록·대화 세션을 채운다(70초 넘게 걸림, 모델이 있으면 대화까지)
./verify-multi.sh        # 설치본마다 대시보드 로그인과 사이드카 읽기를 확인한다
python3 e2e-multi.py --url http://127.0.0.1:17900 --email admin@example.com --password '<AAS_ADMIN_PASSWORD>'
```

- 화면은 실제 서버에서 `ui/parity/offline.mjs` 로 외부 요청 0건을 확인하고 `npm run fps` 로 장면 성능을 잰다. 옛 화면과의 대조 도구는 옛 화면을 지울 때 함께 없앴다(커밋 `3e3319d`).
- 첫 관리자(`AAS_ADMIN_EMAIL`, 기본 `admin@example.com`)는 설치본 one·two 의 `owner` 와 같게 둔다. 설치본 three 의 주인은 일반 사용자 `member@example.com` 이다(방 구성원 권한 시험용). 다른 이메일을 쓰려면 `pods.multi.json` 과 `.env` 를 함께 고친다.
- 일반 사용자 계정은 `docker compose -f docker-compose.multi.yml run --rm --no-deps aas python -c "from aas.auth import auth; auth.save_user('member@example.com', '<10자 이상>')"` 로 만든다.
- `e2e-multi.py --members` 는 방 구성원 권한까지 확인한다(일반 사용자가 보이는 자리·방·카드·회의·크론만 쓰는지, 방에서 빠지면 카드가 실행할 때 보류되는지, 스트림에도 보이는 자리만 오는지). `--llm` 은 에이전트의 실제 답과 카드 실행까지 본다.
- `e2e-multi.py` 는 자리 앉히기 → 칸반 카드(설치본 셋에 걸침) → 크론 → 방 → 회의 → 오피스 상태를 실제 Hermes 3개에 대해 확인하고, 만든 것을 지운다.
- **Hermes 는 빠른 시작과 같은 상류 이미지·시작 방식이다**(대시보드 s6 서비스 + `gateway run`). 다른 Hermes 이미지로 시험하려면 `.env` 에 `HERMES_IMAGE` 와 그 이미지의 시작 명령 `HERMES_COMMAND` 를 함께 적는다. 이미지마다 시작 방식이 달라 명령을 맞춰야 한다.
- **사이드카는 Hermes 와 같은 사용자(`HERMES_UID`, 기본 10000)로 읽는다.** `state.db`·`.env` 가 소유자만 읽도록(0600) 만들어져서, 다른 사용자로는 읽지 못하고 `/api/health` 등이 500 을 낸다. 쿠버네티스에서 같은 파드 보안 설정을 쓰는 것과 같다.
- **모델은 LiteLLM 으로 연결한다.** Hermes 는 `hermes-config.seed.yaml`(주소·모델·키를 `${HERMES_LLM_*}` 로 참조)로 `provider: custom` 을 쓰고, `hermes-seed` 가 세 Hermes 의 기본 프로파일 비밀값에 값을 넣는다. 기본은 호스트의 `14400` 포트이고, `seed-multi.sh` 는 프로파일을 기본 프로파일 복제(`--clone`, 비밀값 포함)로 만든다. 연결하지 않으면 회의·채팅에서 「No inference provider configured」 알림이 나오고 카드는 실행 뒤 「막힘」이 된다.
- **주기 작업.** 서버의 `--ticker` 는 설치본이 여럿이면 모두 동시에 읽어 「설치본/프로파일」 이름으로 합쳐 수집한다. 한 설치본이 느리거나 죽어도 그 설치본만 수집 실패로 남는다(`aas/__main__.py` `_collect_health`).
- 빠른 시작·붙기 compose 와 따로 쓴다(프로젝트 이름 `aas-multi`, 볼륨도 따로). 포트가 겹치면 `.env` 의 `AAS_PORT` 를 바꾼다.
- 정리: `docker compose -f docker-compose.multi.yml down -v` (Hermes 데이터 볼륨까지 지운다).

### 게이트웨이 다시 시작 필요 확인(스펙 2026-11-18-016)

MCP 서버 내용·메신저 채널·연결에 쓰는 비밀값처럼 게이트웨이가 다시 떠야 읽히는 설정을 AAS 에서 바꾸면 상단 막대에 다시 시작 아이콘이 생긴다. 다음 순서로 기록과 바깥 다시 시작 판별을 확인한다.

```sh
# ① 기록 만들기: hermes-one 의 ma 프로파일에 Docmost 가 설치돼 있으면 쓰기 도구를 켠다(화면 MCP 탭의 「쓰기 도구」와 같다)
curl -s -b cookies.txt -H 'Content-Type: application/json' -H 'X-AAS: 1' \
  -d '{"pod":"one","name":"ma","action":"mcp_docmost_write","write":true}' http://127.0.0.1:17900/api/profile/action | jq '.restart_pending'
# ② 기록 보기(다시 시작할 수 있는 사람에게만 나온다)
curl -s -b cookies.txt http://127.0.0.1:17900/api/me | jq '.pod.restart_pending'
# ③ AAS 밖에서 다시 시작한 것처럼: 게이트웨이를 다시 띄운 뒤 15초가 지나 /api/me 를 두 번 읽으면 기록이 사라진다
docker compose -f docker-compose.multi.yml restart hermes-one
sleep 20; curl -s -b cookies.txt http://127.0.0.1:17900/api/me >/dev/null; sleep 3
curl -s -b cookies.txt http://127.0.0.1:17900/api/me | jq '.pod.restart_pending.total'
```

- `cookies.txt` 는 화면에 로그인한 브라우저의 `aas_session` 쿠키를 옮겨 적은 것이다. 지금 작업공간이 `one` 이어야 `pod` 가 hermes-one 이다.
- 판별은 Hermes 가 시작마다 한 줄씩 쓰는 `gateway-starts.log`(루트 프로파일은 Hermes 폴더, 이름 있는 프로파일은 `profiles/<이름>/`)의 마지막 시각보다 5초 넘게 먼저 쓴 기록을 지운다. `./verify-multi.sh` 가 설치본마다 이 시각과 기록 수를 보인다.

## 화면 코드를 고치면서 보기

빠른 시작 compose 를 서버로 두고 화면은 Vite 개발 서버(`http://127.0.0.1:3000`)로 본다. 저장하면 바로 반영된다.

```sh
./local-dev.sh start            # LiteLLM 터널 → (리눅스) 브리지 터널 → compose → 개발 서버
./local-dev.sh start --build    # Python 서버 코드(aas/)를 고쳤을 때
./local-dev.sh status
./local-dev.sh stop             # 반대 순서로 끈다(볼륨은 남긴다)
```

- `.env` 에 `OKE_BASTION`(SSH 키로 들어가는 베스천)과 `AAS_ALLOWED_HOSTS=localhost:17900,127.0.0.1:17900,localhost:3000,127.0.0.1:3000` 을 적는다. 개발 서버가 Host 를 그대로 넘겨 3000 이 없으면 API 가 막힌다.
- 리눅스에서는 `oke-litellm.sh` 의 터널(127.0.0.1)에 컨테이너가 닿지 못해, docker 브리지 주소에도 같은 터널 입구를 연다. 맥은 필요 없다.
- 개발 서버 기록은 `${XDG_RUNTIME_DIR:-$HOME/.cache}/aas-local-dev/ui.log`(나만 쓰는 폴더).

## 정리

```sh
docker compose down        # 데이터(aas-data)와 계정(aas-config) 볼륨은 남는다
docker compose down -v     # 볼륨까지 지운다
```

## 설정 한눈에

| 변수 | 뜻 |
|---|---|
| `AAS_ADMIN_EMAIL`·`AAS_ADMIN_PASSWORD` | 첫 관리자(계정이 없을 때만 만든다). 빠른 시작은 필수 |
| `AAS_SIDECAR_TOKEN` | 서버와 사이드카가 나눠 가지는 토큰(16자 이상) |
| `HERMES_DASHBOARD_PASSWORD` | Hermes 대시보드 비밀번호(AAS 만 쓴다). 빠른 시작·여러 개 |
| `HERMES_LLM_BASE_URL`·`HERMES_LLM_MODEL`·`HERMES_LLM_API_KEY` | Hermes 가 쓰는 OpenAI 호환 LLM. 빠른 시작은 앞의 둘이 필수. 여러 개 시험은 비우면 호스트의 LiteLLM(14400) |
| `HERMES_IMAGE`·`HERMES_COMMAND` | Hermes 이미지(기본 상류 v0.22.2)와 시작 명령(기본 `gateway run`) |
| `HERMES_UID`·`HERMES_GID` | Hermes 와 사이드카의 사용자 번호(기본 10000) |
| `AAS_SIDECAR_MAX_ENTRIES` | 사이드카가 한 번에 나열하는 항목 수의 상한(기본 50000). 서버 로그에 `[AAS-TREE-CUT]` 경고(「폴더 일부를 끊었습니다」·「잘렸습니다」)가 보이면 먼저 경고의 많은 폴더 이름을 `AAS_TREE_SKIP_DIRS_EXTRA` 에 더하고, 그래도 끊기면 올린다(사이드카 메모리가 는다) |
| `AAS_TREE_SKIP_DIRS_EXTRA` | 서버가 안을 읽지 않을 폴더 이름을 쉼표로 더한다(예 `vendor,target,build`). `.venv`·`site-packages`·`.deps`·`.python`·`node_modules` 등 의존성 폴더는 늘 건너뛴다. 여기 넣은 이름은 스킬 찾기·집계에서도 빠지므로 스킬 이름과 겹칠 수 있는 이름과 `skills`·`profiles` 는 넣지 않는다. 서버 여러 대는 같은 값 |
| `AAS_TREE_IDLE_DROP` | 사람이 이만큼(초) 쓰지 않은 에이전트의 묶음을 서버 메모리에서 버린다(기본 3600). 버린 뒤 다시 열면 처음부터 받는다(큰 작업공간 20~60초). 서버 메모리는 `AAS_TREE_CACHE_MB`(기본 512) 상한이 지킨다 |
| `AAS_TREE_PREWARM` | 서버가 뜬 뒤 60초부터 최근 7일 사람이 쓴 에이전트(최대 20개)의 묶음을 한 번에 하나씩 미리 받는다(기본 켬, `0` 이면 끔). 배포 직후 첫 화면의 「응답 없음」을 줄인다 |
| `AAS_VERSION`·`AAS_IMAGE`·`AAS_SIDECAR_IMAGE` | AAS·사이드카 이미지(기본 GHCR, 없으면 소스 빌드) |
| `HERMES_DATA_DIR` | 붙기: Hermes 데이터 폴더의 호스트 경로. 사이드카가 읽기 전용으로 붙인다 |
| `AAS_ADMINS` | 붙기: 관리자 이메일(쉼표·공백으로 여러 명). 비우면 `AAS_ADMIN_EMAIL` |
| `AAS_DASHBOARD_URL`·`_USER`·`_PASSWORD` | 붙기: Hermes 대시보드. 바꾸는 일이 간다 |
| `AAS_LITELLM_URL`·`AAS_LITELLM_MODEL_PREFIX` | 붙기: 모델 화면·AI 보조용 LiteLLM 주소(`/v1` 없이)와 보일 모델의 앞부분. `HERMES_LLM_BASE_URL` 이 있으면 그것을 먼저 쓴다 |
| `AAS_CHAT_TEMPLATE_KWARGS` | AI 보조 호출에 생각 끄기(`chat_template_kwargs`)를 보낼지(기본 on) |
| `AAS_BIND`·`AAS_PORT` | 접속 주소. 기본 `127.0.0.1:17900` |
| `AAS_ALLOWED_HOSTS` | 허용할 Host. 비우면 `AAS_PORT` 를 따라간다 |
| `AAS_TRUSTED_PROXY` | AAS 앞 HTTPS 리버스 프록시의 `X-Forwarded-Proto` 를 믿을 연결(`true` 또는 CIDR). 비우면 http 로 보아 localhost 가 아닌 주소에서는 비밀값 탭이 막힌다 |

## 소유자가 넣는 접속 주소(AAS_OWNER_ENV_URLS, 스펙 2026-11-24-009)

**받는 것은 https 출처(스킴·호스트·포트)뿐이고 경로는 받지 않는다.**

이름이 `_BASE_URL` 로 끝나는 비밀값은 원래 관리자만 넣는다. 스킬이 쓰는 문서 서버 주소처럼 소유자가 직접 넣게 하려면, 관리자가 이 설정에 이름과 출처를 짝으로 적는다. 그러면 소유자 화면에는 입력란 대신 「관리자가 정한 주소 넣기」 단추가 나오고, 서버는 그 출처와 같은 값만 받는다. 이 검사는 화면·API 를 거친 실수를 막을 뿐 보안 경계는 아니다. 에이전트는 자기 `.env` 를 읽을 수 있다.

```bash
# .env (여러 항목은 쉼표로)
AAS_OWNER_ENV_URLS=DOCS_BASE_URL=https://docs.example.com,WIKI_BASE_URL=https://wiki.example.com
```

```yaml
# docker-compose 의 aas 서비스(이 폴더의 두 파일은 이미 넘긴다)
environment:
  AAS_OWNER_ENV_URLS: ${AAS_OWNER_ENV_URLS:-}
```

```yaml
# 쿠버네티스 aas-server 배포의 env (값에 = 와 , 가 있으므로 따옴표로)
- name: AAS_OWNER_ENV_URLS
  value: "DOCS_BASE_URL=https://docs.example.com"
```

- 서버는 환경변수를 먼저 읽고, 비어 있으면 설정 파일(`AAS_CONFIG_DIR/aas.env`)을 읽는다. 값을 바꾼 뒤에는 `aas` 를 다시 띄운다. compose 는 `docker compose up -d aas` 로 다시 만든다. `restart` 로는 `environment:` 를 다시 읽지 않는다.
- 서버가 시작할 때 해석 결과를 한 줄 남긴다(`docker compose logs aas | grep AAS_OWNER_ENV_URLS`). 칸은 「연 이름」·「접두어로 잠김」·「버린 항목(사유)」·「덮인 이름」이고, 값 원문은 적지 않는다.
- 이름마다 출처는 하나다. 같은 이름이 두 번 나오면 뒤 항목이 앞을 덮는다.
- 다음 항목은 버린다.
  - 이름이 `_BASE_URL` 로 끝나지 않음(`not_base_url`)
  - 이름에 소문자가 들었거나 `=` 가 없음(`malformed`)
  - https 가 아니거나 경로·계정·질의가 붙은 주소, IP 주소 그대로이거나 `localhost` 인 주소(`bad_origin`)
- 다음 이름은 목록에 적어도 열리지 않는다.
  - 모델·플랫폼 주소(`OPENAI_`·`ANTHROPIC_`·`HERMES_`·`LITELLM_` 등 접두어)
  - Hermes 변수 목록에서 범주가 provider·setting·messaging 인 이름
  - 범주가 tool 인 주소(`HONCHO_BASE_URL` 등)는 적으면 열린다.
- 경로가 필요한 변수는 목록에 올리지 않는다. 소유자는 출처만 넣을 수 있어서, 덮어쓰면 스킬이 깨진다.
- 목록을 바꿔도 이미 저장된 값은 다시 검사하지 않는다. 목록에서 뺀 이름의 값은 소유자가 지울 수 없으니 관리자가 지운다. 관리자 계정으로 프로파일 → 「비밀값」 → 그 이름 → 「지우기」를 누르거나, `POST /api/profile/action` 에 `{"action":"env_clear","name":"<프로파일>","target":"<이름>","confirm":"<이름>"}` 를 보낸다.
- 스킬 작성자: SKILL.md 의 `required_environment_variables` 에 `*_BASE_URL` 을 선언하면, 관리자가 이 목록에 올렸을 때만 소유자가 넣을 수 있다. 템플릿에는 이런 이름을 선언할 수 없다. 설치마다 목록이 다르기 때문이다.

| 거절 사유 코드 | 뜻 | 할 일 |
|---|---|---|
| `url_proxy` | 접속 주소 이름이라 관리자만 넣는다(목록에 없거나, 목록에 있어도 모델·플랫폼 주소) | 관리자가 넣거나 목록에 올린다. 목록에 적었는데도 이 코드가 나오면 시작 로그의 「접두어로 잠김」을 본다 |
| `url_not_allowed` | 목록의 출처와 다른 값, 또는 지금 목록에 없음 | 「관리자가 정한 주소 넣기」 단추를 쓴다 |
| `list_unreadable` | Hermes 변수 목록을 읽지 못함 | 잠시 뒤 다시 시도한다 |

## Keycloak SSO 확인

```bash
../../.venv/bin/python keycloak-e2e.py     # 실제 Keycloak 컨테이너(기본 공개 이미지 quay.io/keycloak/keycloak:26.2.5, `--image` 로 바꾼다)와 AAS 서버를 임시로 띄운다
```

AAS 서버를 이 컴퓨터의 Python 으로 띄우므로 서버 의존성이 필요하다. 레포 루트에서 `make test-python` 을 한 번 돌려 `.venv` 를 만들고 그 `.venv/bin/python` 으로 돌린다(의존성이 없으면 Keycloak 을 띄우기 전에 이유를 알리고 멈춘다).

realm(그룹 `aas-users`, 역할 `aas-admin`, 사용자 셋)과 비밀번호·클라이언트 비밀은 실행마다 무작위로 만들고, 끝나면 컨테이너와 임시 폴더를 지운다(`--keep` 이면 남긴다). 로그인 화면의 폼을 직접 제출해 인가 코드 흐름을 끝까지 돌고, 그룹 구성원·그룹 밖 거절·역할만 있는 관리자·로그아웃을 확인한다. 로그인 화면을 못 찾으면 `E2E_DEBUG=1` 로 Keycloak 의 응답을 본다.

## 로그인 도메인 확인(구글 → 회사 도메인, 스펙 2026-11-15-005)

```bash
../../.venv/bin/python keycloak-alias-e2e.py   # Keycloak 두 개(AAS 영역·구글 역할)와 AAS 서버를 임시로 띄운다
```

구글 역할의 Keycloak 에 `@legacy.example.com` 사용자를 두고, AAS 영역에는 외부 제공자 `google`(IMPORT·trustEmail)과 client scope `aas-login-provider` 를 차트와 같은 순서로 붙인다. 브라우저 흉내로 로그인 화면의 google 단추를 눌러 끝까지 돌고, 꺼짐(지금처럼 거절) → 켬(회사 이메일로 들어옴, 리프레시 토큰에 새 이메일) → 두 번째 로그인(이메일 그대로) → 회사 이메일 사용자가 이미 있음(`AAS-LM-NEEDS-ADMIN`) → 전원 바꾸기를 확인한다. 비밀은 실행마다 무작위이고, 끝나면 컨테이너 둘·네트워크·임시 폴더를 지운다(`--keep` 이면 남긴다).
