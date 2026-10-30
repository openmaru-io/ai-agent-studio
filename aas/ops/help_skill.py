# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""AAS 사용법 스킬(aas-help)의 옛 자리 — 스펙 2026-10-18-001 B 를 2026-10-29-001 이 바꿨다(OMAI-1534).

aas-help 는 스킬 허브 패키지(free/aas-help, 원본 aas/assets/aas_skill_packages/aas-help/)로 프로파일마다 들어간다.
예전에는 서버가 ConfigMap 을 올리고 오퍼레이터가 /opt/aas-skills/aas-help 에 붙였으며, 서버가 프로파일 config.yaml 의
skills.external_dirs 에 HELP_DIR 를 넣었다. 그 값이 남은 설정을 주인이 저장할 수 있게 owner_guard 가 이 경로를 계속 허용한다
(없는 폴더는 Hermes 가 조용히 건너뛴다).
"""

HELP_DIR = "/opt/aas-skills"
