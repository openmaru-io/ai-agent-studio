# AAS 읽기 사이드카. Hermes 파드 안에서 Hermes 데이터 폴더를 읽기 전용으로 붙여 쓴다.
# AAS 서버 이미지와 따로 만들지만 같은 판(태그)으로 올린다. 판은 AAS_VERSION 빌드 인자로 받아 /v1/version 의 sidecar 로 알린다(스펙 2026-11-03-003).
# 서버는 판 번호가 아니라 ops 목록으로 기능을 가리므로, 판이 달라도(사용자 Hermes 파드를 아직 다시 띄우지 않았어도) 함께 동작한다.
FROM python:3.12-slim
ARG AAS_VERSION=
WORKDIR /app
COPY aas_sidecar ./aas_sidecar
RUN useradd -u 10001 -d /nonexistent -s /usr/sbin/nologin aas
USER 10001
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 AAS_SIDECAR_ROOT=/opt/data AAS_SIDECAR_PORT=17950 AAS_SIDECAR_VERSION=${AAS_VERSION}
EXPOSE 17950
CMD ["python", "-m", "aas_sidecar", "serve", "--host", "0.0.0.0"]
