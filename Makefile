# Copyright 2026 The OPENMARU Authors.
# CogentAI AAS 서버. CI 와 로컬이 같은 목표를 쓴다.
PYTHON ?= python3
IMG ?= aas:local
SIDECAR_IMG ?= aas-sidecar:local

.PHONY: help test-python test-python-docker test-python-pg push lint-ui test-ui build-ui docker verify-keycloak ci ci-kind

help: ## 목표 목록
	@grep -E '^[a-z-]+:.*##' $(MAKEFILE_LIST) | sed 's/:.*## /\t/'

# 서버가 쓰는 의존성(Dockerfile 과 같은 버전). 없으면 실제 서버를 띄우는 시험(aasserver.py)이 import 에서 멈춘다(2026-10-14).
PY_DEPS ?= pyyaml==6.0.3 websockets==17.2 uvicorn==0.54.0 starlette==1.7.0 tzdata
VENV ?= .venv
$(VENV)/.deps: Makefile
	$(PYTHON) -m venv $(VENV)
	$(VENV)/bin/pip install -q $(PY_DEPS)
	touch $@

test-python: $(VENV)/.deps ## Python 시험(표준 unittest). 처음 한 번 .venv 에 서버 의존성을 설치한다
	PYTHONPATH=. $(VENV)/bin/python -m unittest discover -s tests -p "test_*.py"

PG_IMG ?= postgres:16
PG_VENV ?= .venv-pg
test-python-pg: ## PostgreSQL 컨테이너에서 같은 시험(시험마다 스키마). 풀 상한 1 로도 한 번 더 돌려 중첩 연결을 확인한다(docker 필요)
	$(PYTHON) -m venv $(PG_VENV)
	$(PG_VENV)/bin/pip install -q "psycopg[binary]==3.3.6" psycopg_pool==3.3.3 pyyaml websockets==17.2 uvicorn==0.54.0 starlette==1.7.0
	-docker rm -f aas-pg-test >/dev/null 2>&1
	docker run -d --name aas-pg-test -e POSTGRES_PASSWORD=test -p 55432:5432 $(PG_IMG) -c max_connections=200 >/dev/null
	@until docker exec aas-pg-test pg_isready -q; do sleep 1; done; sleep 2
	@export AAS_DB_BACKEND=postgres AAS_DB_HOST=127.0.0.1 AAS_DB_PORT=55432 AAS_DB_NAME=postgres AAS_DB_USER=postgres AAS_DB_PASSWORD=test AAS_DB_SCHEMA=auto AAS_DB_SSLMODE=disable; \
	  PYTHONPATH=. $(PG_VENV)/bin/python -m unittest discover -s tests -p "test_*.py" && \
	  AAS_DB_POOL_MAX=1 AAS_DB_POOL_TIMEOUT=5 PYTHONPATH=. $(PG_VENV)/bin/python -m unittest discover -s tests -p "test_*.py"; \
	  rc=$$?; docker rm -f aas-pg-test >/dev/null 2>&1; exit $$rc

test-python-docker: ## Python 시험을 python:3.12 컨테이너에서(에이전트에 맞는 파이썬이 없을 때. CI 가 쓴다)
	docker run --rm -u "$$(id -u):$$(id -g)" -e HOME=/tmp -v "$(CURDIR)":/src -w /src $(PY_IMAGE) sh -c 'pip install -q --user pyyaml==6.0.3 websockets==17.2 uvicorn==0.54.0 starlette==1.7.0 tzdata && PYTHONPATH=. python -m unittest discover -s tests -p "test_*.py"'

# 이미지를 올릴 레지스트리(예: ghcr.io/<조직>). 기본값이 없다 — 비어 있으면 make push 가 멈춘다. CI 는 빌드 설정이 넘긴다
REGISTRY ?=
VERSION ?= 1.0.5
# 화면의 버전 정보 창에 보이는 값(ui/src/lib/buildInfo.ts). 이미지에는 .git 이 들어가지 않아 빌드 인자로 넘긴다
GIT_COMMIT ?= $(shell git rev-parse HEAD 2>/dev/null)
GIT_COMMIT_DATE ?= $(shell git log -1 --format=%cd --date=iso 2>/dev/null)
BUILD_INFO = --build-arg AAS_VERSION=$(VERSION) --build-arg AAS_GIT_COMMIT=$(GIT_COMMIT) --build-arg "AAS_GIT_COMMIT_DATE=$(GIT_COMMIT_DATE)"
PLATFORMS ?= linux/amd64,linux/arm64
PY_IMAGE ?= python:3.12-slim
push: ## 서버·읽기 사이드카 이미지를 여러 아키텍처로 빌드해 REGISTRY 에 VERSION 태그로 푸시(docker login 이 되어 있어야 한다)
	@[ -n "$(REGISTRY)" ] || { echo "REGISTRY 를 정하세요. 예: make push REGISTRY=ghcr.io/<조직> VERSION=$(VERSION)" >&2; exit 2; }
	docker buildx inspect aas-multi >/dev/null 2>&1 || docker buildx create --name aas-multi >/dev/null
	docker buildx build --builder aas-multi --platform $(PLATFORMS) $(BUILD_INFO) -t $(REGISTRY)/cogentai-aas-server:$(VERSION) --push .
	docker buildx build --builder aas-multi --platform $(PLATFORMS) --build-arg AAS_VERSION=$(VERSION) -t $(REGISTRY)/cogentai-aas-sidecar:$(VERSION) --push sidecar

lint-ui: ## 화면 린트와 타입 검사
	cd ui && npm ci --silent && npm run lint && npm run tsc

test-ui: ## 화면 단위 시험
	cd ui && npx vitest run

build-ui: ## 화면 빌드 + 에어갭 검사(외부 주소가 섞이면 실패)
	cd ui && npm run build

docker: ## 서버·읽기 사이드카 이미지
	docker build $(BUILD_INFO) -t $(IMG) .
	docker build --build-arg AAS_VERSION=$(VERSION) -t $(SIDECAR_IMG) sidecar

verify-keycloak: ## AAS 전용 Keycloak 설치를 kind 에서 확인(docker·kind 필요, 약 5분). 사내 레포에만 있다
	@test -x deploy/k8s/keycloak/verify-kind.sh || { echo "deploy/k8s/keycloak 은 공개본에 없다(쿠버네티스 설치는 공개하지 않았다)" >&2; exit 2; }
	deploy/k8s/keycloak/verify-kind.sh

ci: test-python lint-ui test-ui build-ui docker ## 클러스터가 필요 없는 전부
ci-kind: verify-keycloak ## kind 가 필요한 것(Keycloak·PostgreSQL 이미지만 필요하고 AAS 이미지는 쓰지 않는다)
