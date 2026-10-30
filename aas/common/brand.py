# Copyright 2026 OPENMARU, Inc.
# SPDX-License-Identifier: Apache-2.0
"""설치 브랜드(OPENMARU · MSAP · AINP) — COP Console·Observ 와 같은 `PRODUCT_NAME` 방식(OMAI-1299).

차트가 `PRODUCT_NAME=<BRAND>_CogentAI` 를 넣는다(COP 인스톨러의 `product_brand` → 차트 `global.productBrand`).
판정은 콘솔 `getProductInfo.ts` 와 같다: 공백·밑줄 형태를 모두 받고 MSAP·AINP 로 시작하면 그 브랜드, 그 밖과 빈 값은 OPENMARU.
판권·기본 회사명은 세 브랜드 모두 OPENMARU 로 둔다(사용자 결정 2026-10-17) — 여기서는 로고·제품명·로그인 테마만 정한다.
스펙: cogentai-aas-docs docs-plan/deploy/aas-product-brand.md
"""
from __future__ import annotations

from dataclasses import dataclass

from . import config

KEYS = ("OPENMARU", "MSAP", "AINP")


@dataclass(frozen=True)
class Brand:
    key: str                 # OPENMARU | MSAP | AINP
    product: str             # 「MSAP CogentAI」 — 로고에 적힌 이름
    full: str                # 「MSAP CogentAI AAS」 — 탭 첫 제목
    env_value: str           # 「MSAP_CogentAI」 — 화면에 넘기는 PRODUCT_NAME
    login_theme: str         # Keycloak 로그인 테마: aas | aas-msap | aas-ainp
    logo_file: str           # aas/web/brand/ 아래 서버 화면용 로고


def parse(raw: str | None) -> str:
    name = (raw or "").strip().replace("_", " ").upper()
    for key in ("MSAP", "AINP"):
        if name.startswith(key):
            return key
    return "OPENMARU"


def of(key: str) -> Brand:
    key = key if key in KEYS else "OPENMARU"
    product = f"{key} CogentAI"
    return Brand(key=key, product=product, full=f"{product} AAS", env_value=f"{key}_CogentAI",
                 login_theme="aas" if key == "OPENMARU" else f"aas-{key.lower()}", logo_file=f"{key}_CogentAI_logo.svg")


def current() -> Brand:
    return of(parse(config.get("PRODUCT_NAME", "")))
