# 제3자 소프트웨어·자산 고지

AAS 에 소스나 파일째 들어 있는 것만 적는다. npm·pip 의존성은 각 패키지의 라이선스를 따른다.
OPENMARU 의 이름·로고와 CogentAI 마스코트(`ui/src/assets/mascot/cogentai-chat.png`)는 회사가 권리를 가진 브랜드 자산이라 여기가 아니라 `TRADEMARKS.md` 에 적는다.

## Claw3D (MIT)

- 출처: https://github.com/iamlukethedev/Claw3D, 커밋 `0565b78`(2026-08-21 기준 마지막 푸시)
- 저작권: Copyright (c) 2026 Luke The Dev
- 위치: `ui/src/features/office/scene3d/`(소스), `ui/src/features/office/scene3d/LICENSE.Claw3D`(라이선스 원문)
- 가져온 범위와 고친 곳: `ui/src/features/office/scene3d/CLAW3D_CHANGES.md`
- 상류를 따라가지 않는다. 위 커밋을 가져온 뒤로는 AAS 가 관리한다.

## Noto Sans KR (SIL Open Font License 1.1)

- 출처: https://github.com/google/fonts/tree/main/ofl/notosanskr
- 저작권: Copyright 2014-2021 Adobe (http://www.adobe.com/), with Reserved Font Name 'Source'
- 위치(두 곳):
  - `ui/src/assets/fonts/notosans-kr/*.woff2`(124개) — 화면 전체의 본문 글꼴. Google Fonts 가 나눈 그대로의 조각 파일이며 COP Console 과 같은 파일이다(`ui/src/fonts.css`). 고치지 않았다. 라이선스 원문은 같은 폴더의 `OFL.txt`.
  - `ui/src/features/office/scene3d/assets/fonts/NotoSansKR-Regular-subset.woff` — 오피스 3D 장면 글자용. 라이선스 원문은 같은 폴더의 `OFL.NotoSansKR.txt`.
- 고친 것(3D 장면용 파일만): 가변 글꼴을 굵기 400 으로 고정하고, 한글 음절 전체(U+AC00-D7A3)·한글 자모·라틴·일부 기호만 남기는 부분집합으로 줄였다(`fontTools`). 글꼴 이름은 바꾸지 않았다.
- 쓰는 곳: 오피스 3D 장면의 글자(이름표 등). 글꼴을 따로 주지 않으면 3D 글자 라이브러리가 기본 글꼴을 외부에서 받아 폐쇄망에서 깨지므로 이 파일을 쓴다.

## JetBrains Mono (SIL Open Font License 1.1)

- 출처: https://github.com/JetBrains/JetBrainsMono
- 저작권: Copyright 2020 The JetBrains Mono Project Authors
- 위치: `ui/src/assets/fonts/jetbrains-mono/*.woff2`(라틴·라틴 확장 가변 글꼴 2개), 라이선스 원문은 같은 폴더의 `OFL.txt`. 고치지 않았다.
- 쓰는 곳: 화면의 고정폭 글자(코드·설정 파일 보기).

## 오피스 가구 3D 모델 (Kenney Furniture Kit 2.0, CC0)

- 출처: https://kenney.nl/assets/furniture-kit — 「Furniture Kit (2.0)」, Kenney(www.kenney.nl), 2018-10-20. 내려받은 묶음 `kenney_furniture-kit.zip` 의 `Models/GLTF format/*.glb`
- 라이선스: CC0 1.0(퍼블릭 도메인 헌정). 묶음 안 `License.txt`: "This content is free to use in personal, educational and commercial projects." 출처 표기는 선택이다.
- 위치: `ui/src/features/office/scene3d/assets/models/*.glb` 가운데 Kenney 28개(Furniture Kit 24 + 아래 Nature Kit 4). 같은 폴더의 `balloon.glb` 는 아래 따로 적었다. 고치지 않았다.
- 확인(2026-10-13): Claw3D 에서 온 17개(`bookcaseClosed`·`chairDesk`·`chairModernCushion`·`computerScreen`·`desk`·`deskCorner`·`kitchenCabinet`·`kitchenCoffeeMachine`·`kitchenFridgeSmall`·`lampRoundFloor`·`loungeDesignChair`·`loungeSofa`·`plantSmall1`·`pottedPlant`·`table`·`tableCoffee`·`tableRound`)는 위 묶음의 같은 이름 파일과 바이트까지 같다(`cmp`).
- 한국 사무실 배치(계획 2026-10-13-001)에서 같은 묶음에서 더한 7개: `bookcaseClosedDoors`(사물함)·`bookcaseClosedWide`(문서함)·`coatRackStanding`(옷걸이)·`kitchenMicrowave`(복합기 대신)·`paneling`(화이트보드·게시판)·`rugRectangle`(러그)·`televisionModern`(상황판·회의실 TV).
- 화분 종류를 늘리며(2026-10-16, 사용자 요청) **Kenney Nature Kit 2.1(CC0)** 에서 4개를 더했다: `cactus_tall`(선인장)·`cactus_short`(작은 선인장)·`tree_palmShort`(야자수)·`tree_small`(나무 화분). 출처: https://kenney.nl/assets/nature-kit — 「Nature Kit (2.1)」, Kenney(www.kenney.nl), 2020-04-29, 묶음 `kenney_nature-kit.zip` 의 `Models/GLTF format/*.glb`. 라이선스는 위와 같은 CC0 1.0(묶음 안 `License.txt`: "free to use in personal, educational and commercial projects", 출처 표기는 선택). 고치지 않았고 원본 묶음의 같은 이름 파일과 같다(모두 텍스처 없이 정점 색만 쓰는 3~16KB 파일이라 폐쇄망에서도 외부 요청이 없다).
- Claw3D 에 들어 있던 배경 이미지 `office-bg.png` 는 출처가 적혀 있지 않고 장면 코드가 쓰지 않아 2026-10-22 에 지웠다(스펙 2026-10-21-015 단계 4).

## 부서 현수막의 애드벌룬 3D 모델 (「Hot air balloon」, Poly by Google, CC BY 3.0)

- 출처: https://poly.pizza/m/7Fej0Jd3_Di — 「Hot air balloon」, 제작: Poly by Google(Google Poly 보관본), 올린 곳 Poly Pizza. 내려받은 파일은 `https://static.poly.pizza/776312e5-40ed-40bf-9d26-5fe5ee4e5ce8.glb` 이다.
- 라이선스: Creative Commons Attribution 3.0(CC BY 3.0) — https://creativecommons.org/licenses/by/3.0/ . 출처와 제작자를 밝히면 상업적 이용·수정이 허락된다. 이 목록이 그 표시다.
- 위치: `ui/src/features/office/scene3d/assets/models/balloon.glb`(`balloon`, 삼각형 약 4,300개, 재질 1·그림 1개가 파일 안에 들어 있다). **파일은 고치지 않았다**(내려받은 그대로). 크기·회전은 코드(`DepartmentBanner.tsx`)에서만 바꾼다.
- 고르기(2026-10-15): Poly Pizza 풍선 후보 4개를 같은 조명에서 그려 보고 가장 단정한 줄무늬 모델을 골랐다. 붉은 방사 줄무늬 모델은 특정 국가 깃발과 닮아 뺐다.

## 오피스 배경음악 다섯 곡 (CC0 네 곡, CC BY 4.0 한 곡)

- 위치: `ui/src/features/office/audio/*.mp3`. 쓰는 곳: 오피스 화면의 배경음(기본 끔, 사용자가 켠다). 설정 › 내 화면과 오피스 하단 ♫ 단추에서 곡을 고른다(스펙 2026-10-21-014). 이미지에 들어 있어 외부에 요청하지 않는다.
- 모든 곡을 음량 -16 LUFS·MP3 로 다시 인코딩했다(곡 내용은 고치지 않았다). 받은 주소·원본 SHA-256·명령은 같은 폴더의 `README.md`.
- 「Menu Music」 — 작곡 mrpoly. https://opengameart.org/content/menu-music . CC0 1.0. 출처 표기 의무 없음.
- 「Chill lofi inspired [loop edit]」 — 작곡 omfgdude, 루프 편집 qubodup. https://opengameart.org/content/chill-lofi-inspired-loop-edit . CC0 1.0. 출처 표기 의무 없음.
- 「Forest Ambience」 — TinyWorlds. https://opengameart.org/content/forest-ambience . CC0 1.0. 출처 표기 의무 없음.
- 「Goldberg Variations, BWV 988 — Aria」 — 작곡 J. S. Bach, 연주 Kimiko Ishizaka(Open Goldberg Variations). https://archive.org/details/The_Open_Goldberg_Variations-11823 . CC0 1.0. 출처 표기 의무 없음.
- 「Carefree」 — 작곡 Kevin MacLeod. 라이선스 CC BY 4.0. 출처 표기가 의무이며, incompetech 가 정한 문구는 다음과 같다. 화면에서도 곡 이름 아래에 작곡자와 라이선스를 보인다. 파일은 MP3 로 다시 인코딩하고 음량을 바꿨다(곡 내용은 그대로다).

  "Carefree" Kevin MacLeod (incompetech.com)
  Licensed under Creative Commons: By Attribution 4.0
  https://creativecommons.org/licenses/by/4.0/

- 이전 곡 「Contemplation」(Joth, CC0)은 2026-10-21 에 뺐다.

## PDF.js 부가 파일(cmaps·standard_fonts·wasm)

- 출처: npm `pdfjs-dist@6.3.289`(react-pdf 11.0.0 이 고정한 버전)의 `cmaps/`·`standard_fonts/`·`wasm/` 폴더. **파일은 고치지 않았다**.
- 위치: 빌드가 `ui/scripts/copy-pdfjs-assets.mjs` 로 `aas/static/assets/pdfjs-6.3.289/` 에 복사한다(소스 저장소에는 넣지 않는다). PDF 안 스크립트 실행용 `quickjs-eval.*` 은 쓰지 않아 복사하지 않는다.
- 라이선스(각 폴더의 원문을 함께 복사한다):
  - `cmaps/` — Adobe CMap 자원, Copyright 1990-2009 Adobe Systems Incorporated, BSD 3-Clause 형식(`cmaps/LICENSE`)
  - `standard_fonts/Foxit*.pfb` — PDFium 저자들, BSD 형식(`standard_fonts/LICENSE_FOXIT`)
  - `standard_fonts/Liberation*.ttf` — Red Hat, GPLv2 + 글꼴 예외 조항(`standard_fonts/LICENSE_LIBERATION`). 글꼴을 문서에 넣어 쓰는 것은 예외 조항이 허락한다
  - `wasm/openjpeg*` — OpenJPEG, BSD 2-Clause(`wasm/LICENSE_OPENJPEG`), `wasm/jbig2*` — PDFium 저자들, BSD 형식(`wasm/LICENSE_JBIG2`), `wasm/qcms_bg.wasm` — Mozilla qcms(`wasm/LICENSE_QCMS`). 이를 wasm 으로 묶은 pdf.js 쪽은 Apache-2.0(`wasm/LICENSE_PDFJS_*`)
- 쓰는 곳: 파일 뷰어의 PDF 보기(스펙 2026-10-20-005). 글꼴을 품지 않은 동아시아 PDF(cmaps)·기본 14글꼴을 품지 않은 PDF(standard_fonts)·JPEG 2000·JBIG2 그림(wasm)을 그릴 때만 받는다. 외부에 요청하지 않는다.

## 한글 문서 그리기 wasm(`rhwp_bg.wasm`)

- 출처: npm `@rhwp/core@0.8.7`(https://github.com/edwardkim/rhwp)의 `rhwp_bg.wasm`. **파일은 고치지 않았다**.
- 위치: 빌드가 `aas/static/assets/rhwp_bg-<해시>.wasm` 으로 내보내고, `ui/scripts/compress-assets.mjs` 가 같은 내용을 gzip 으로 줄인 `.wasm.gz` 를 옆에 둔다(소스 저장소에는 넣지 않는다).
- 라이선스: MIT, Copyright (c) 2025-2026 Edward Kim(패키지의 `LICENSE`). wasm 안에 함께 컴파일된 Rust crate 는 npm 패키지에 목록이 없어 상류 태그 `v0.8.7` 의 `Cargo.lock` 으로 확인했다(2026-10-30, 스펙 2026-10-20-005 외부 검토 OV13). 167개 모두 MIT·Apache-2.0·BSD·Zlib 같은 허용형 라이선스이며, 목록과 원문을 실어야 하는 BSD-3-Clause·Zlib 원문은 `docs/licenses/rhwp-wasm-crates.md`.
- 쓰는 곳: 파일 뷰어의 HWP·HWPX 보기(스펙 2026-10-20-005). 한글 파일을 처음 열 때만 받는다. 외부에 요청하지 않는다.
