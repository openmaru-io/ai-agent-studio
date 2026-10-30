# AAS 제어면. Hermes 는 이 이미지에 들어 있지 않다 — 이미 돌고 있는 Hermes 에 연결한다.
# 화면(React)은 이미지를 만들 때만 빌드한다. 실행 이미지에는 빌드된 정적 파일만 들어가므로 설치 현장에 npm 이 필요 없다.
# 폐쇄망 빌드는 NODE_IMAGE·PYTHON_IMAGE 를 Harbor 미러로 바꿔 넘긴다.
ARG NODE_IMAGE=node:20-bookworm-slim
ARG PYTHON_IMAGE=python:3.12-slim

# 화면 빌드 결과는 아키텍처와 무관한 정적 파일이라 빌드하는 장비의 아키텍처로 한 번만 만든다. 대상마다 만들면 arm64 가 QEMU 흉내로 돌아 약 11분 걸렸다(amd64 는 1분)
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS ui
WORKDIR /ui
COPY ui/package.json ui/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY ui/ ./
# 좌측 메뉴 아래 버전 단추가 보이는 값(ui/src/lib/buildInfo.ts). .git 은 이미지에 들어오지 않으므로 Makefile 이 넘긴다. 빌드 날짜는 vite 가 채운다
ARG AAS_VERSION=
ARG AAS_GIT_COMMIT=
ARG AAS_GIT_COMMIT_DATE=
ENV VITE_AAS_VERSION=${AAS_VERSION} VITE_AAS_GIT_COMMIT=${AAS_GIT_COMMIT} VITE_AAS_GIT_COMMIT_DATE=${AAS_GIT_COMMIT_DATE}
# vite 의 outDir 이 ../aas/static 이라 /aas/static 에 나온다. 빌드 끝에 외부 주소 검사(에어갭)가 돈다.
RUN npm run build

FROM ${PYTHON_IMAGE}
# uvicorn·starlette: HTTP 와 웹소켓을 같은 포트에서 받는 ASGI 서버(OMAI-1100). websockets 는 uvicorn 의 websockets-sansio 구현과 채팅 클라이언트가 함께 쓴다
RUN pip install --no-cache-dir uvicorn==0.54.0 starlette==1.7.0 websockets==17.2 pyyaml==6.0.3 tzdata 'psycopg[binary]==3.3.6' psycopg_pool==3.3.3
WORKDIR /app
COPY aas ./aas
COPY --from=ui /aas/static ./aas/static
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 HOME=/aas-home TZ=Asia/Seoul
# 사용자 ID 는 Hermes 이미지(10000)와 같다. 공유 볼륨(NFS)에서 에이전트가 만든 파일을 서버가 지울 수 있어야 한다(OMAI-1204)
RUN useradd -u 10000 -d /aas-home aas && mkdir -p /aas-home /data /etc/aas && chown aas /aas-home /data /etc/aas
USER 10000
EXPOSE 17900
CMD ["python", "-m", "aas", "serve", "--host", "0.0.0.0", "--port", "17900", "--ticker"]
