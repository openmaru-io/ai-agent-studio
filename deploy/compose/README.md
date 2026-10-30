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
| `AAS_VERSION`·`AAS_IMAGE`·`AAS_SIDECAR_IMAGE` | AAS·사이드카 이미지(기본 GHCR, 없으면 소스 빌드) |
| `HERMES_DATA_DIR` | 붙기: Hermes 데이터 폴더의 호스트 경로. 사이드카가 읽기 전용으로 붙인다 |
| `AAS_ADMINS` | 붙기: 관리자 이메일(쉼표·공백으로 여러 명). 비우면 `AAS_ADMIN_EMAIL` |
| `AAS_DASHBOARD_URL`·`_USER`·`_PASSWORD` | 붙기: Hermes 대시보드. 바꾸는 일이 간다 |
| `AAS_LITELLM_URL`·`AAS_LITELLM_MODEL_PREFIX` | 붙기: 모델 화면·AI 보조용 LiteLLM 주소(`/v1` 없이)와 보일 모델의 앞부분. `HERMES_LLM_BASE_URL` 이 있으면 그것을 먼저 쓴다 |
| `AAS_CHAT_TEMPLATE_KWARGS` | AI 보조 호출에 생각 끄기(`chat_template_kwargs`)를 보낼지(기본 on) |
| `AAS_BIND`·`AAS_PORT` | 접속 주소. 기본 `127.0.0.1:17900` |
| `AAS_ALLOWED_HOSTS` | 허용할 Host. 비우면 `AAS_PORT` 를 따라간다 |
| `AAS_TRUSTED_PROXY` | AAS 앞 HTTPS 리버스 프록시의 `X-Forwarded-Proto` 를 믿을 연결(`true` 또는 CIDR). 비우면 http 로 보아 localhost 가 아닌 주소에서는 비밀값 탭이 막힌다 |

## Keycloak SSO 확인

```bash
../../.venv/bin/python keycloak-e2e.py     # 실제 Keycloak 컨테이너(기본 공개 이미지 quay.io/keycloak/keycloak:26.2.5, `--image` 로 바꾼다)와 AAS 서버를 임시로 띄운다
```

AAS 서버를 이 컴퓨터의 Python 으로 띄우므로 서버 의존성이 필요하다. 레포 루트에서 `make test-python` 을 한 번 돌려 `.venv` 를 만들고 그 `.venv/bin/python` 으로 돌린다(의존성이 없으면 Keycloak 을 띄우기 전에 이유를 알리고 멈춘다).

realm(그룹 `aas-users`, 역할 `aas-admin`, 사용자 셋)과 비밀번호·클라이언트 비밀은 실행마다 무작위로 만들고, 끝나면 컨테이너와 임시 폴더를 지운다(`--keep` 이면 남긴다). 로그인 화면의 폼을 직접 제출해 인가 코드 흐름을 끝까지 돌고, 그룹 구성원·그룹 밖 거절·역할만 있는 관리자·로그아웃을 확인한다. 로그인 화면을 못 찾으면 `E2E_DEBUG=1` 로 Keycloak 의 응답을 본다.
