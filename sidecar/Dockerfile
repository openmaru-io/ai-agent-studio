# AAS 읽기 사이드카. Hermes 파드 안에서 Hermes 데이터 폴더를 읽기 전용으로 붙여 쓴다.
# AAS 서버 이미지와 따로 만들고 따로 올린다 — 연산 5개 API 가 바뀔 때만 판을 올린다(사용자 Hermes 파드를 다시 띄우지 않으려는 것).
FROM python:3.12-slim
WORKDIR /app
COPY aas_sidecar ./aas_sidecar
RUN useradd -u 10001 -d /nonexistent -s /usr/sbin/nologin aas
USER 10001
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 AAS_SIDECAR_ROOT=/opt/data AAS_SIDECAR_PORT=17950
EXPOSE 17950
CMD ["python", "-m", "aas_sidecar", "serve", "--host", "0.0.0.0"]
