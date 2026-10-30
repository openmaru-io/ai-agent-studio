---
name: ocr-to-markdown
description: "그림(PNG·JPG·WebP)과 스캔 PDF(글자층 없음)의 한국어·영어 글자를 OCR 로 읽어 Markdown 으로 바꾼다. 손글씨·수식(LaTeX)도 읽는다. / OCR Korean and English text in images and scanned PDFs into Markdown, including handwriting and math formulas."
version: 1.1.0
author: OPENMARU, Inc.
license: Apache-2.0
metadata:
  hermes:
    tags: [ocr, scan, image, pdf, korean, handwriting, formula, markdown, kordoc]
    category: productivity
    related_skills: [doc-to-markdown, hwp-to-markdown, pdf, business-card-ocr]
---

# 그림·스캔 PDF 글자 읽기(OCR) → Markdown

> `<스킬폴더>` 는 이 스킬을 불러올 때(`skill_view`) 받은 `skill_dir` 경로다(스킬 허브로 설치하면 프로파일마다 다르다). 스크립트가 종료 코드 6 으로 끝나거나 `kordoc`·`pandoc` 같은 명령이 없다(command not found)고 나오면 다시 시도하지 말고, 이 에이전트에 필요한 도구가 없다고 사용자에게 알린다.

## 언제 쓰나

- 사용자가 사진·캡처·스캔한 공문(그림이나 글자층 없는 PDF)을 올리고 「글자를 읽어 줘」「텍스트로 바꿔 줘」「표를 옮겨 줘」라고 할 때.
- 글자를 고를 수 있는 PDF(글자층 있음)는 `doc-to-markdown` 이 더 정확하다. 먼저 `pdftotext "<입력>.pdf" - | head` 로 본다 — 글자가 나오면 그쪽을 쓴다.
- 그림의 뜻(무엇이 찍혔는지)을 묻는 질문은 OCR 이 아니라 그림 분석이다.
- **명함이나 손으로 써 준 연락처 쪽지를 등록·저장**하려는 요청(「명함 등록해 줘」「연락처로 등록해 줘」「연락처로 저장해 줘」)은 이 스킬이 아니라 `business-card-ocr` 를 쓴다. vCard(.vcf) 파일을 만들지 않는다.

## 파일 위치 (AAS)

- **입력:** 메시지 끝의 `[사용자가 파일을 올렸습니다: … 경로: /opt/data/workspace/uploads/<날짜>/<이름>]` 줄의 절대 경로를 그대로 쓴다.
- **출력:** `/opt/data/workspace/output/` 에 쓴다(없으면 만든다). 그래야 답 아래에 내려받기 칩이 붙는다.
- **이름:** 원본 이름에서 확장자만 `.md` 로. 같은 이름이 있으면 `-2`, `-3`. 원본은 고치지 않는다.

## 읽는 법 (kordoc, 모델은 이미지에 들어 있다)

```bash
mkdir -p /opt/data/workspace/output
kordoc "<그림.png|jpg|webp>" -o "/opt/data/workspace/output/<이름>.md" --silent          # 그림은 OCR 이 자동
kordoc "<스캔.pdf>" --ocr --no-images -o "/opt/data/workspace/output/<이름>.md" --silent   # OCR 이 필요한 쪽만
```

| 상황 | 옵션 |
|---|---|
| 글자층이 있어도 다시 읽기(글자층이 깨진 PDF) | `--ocr-force` |
| 작은 글자·복잡한 쪽에서 글줄을 놓칠 때 | `--ocr-det server`(느리지만 더 잘 찾는다) |
| 손으로 쓴 칸이 있는 서식·메모 | `--ocr-rec handwriting` — 아래 「손글씨 모드 고르기」 |
| PDF 의 수식 | `--formula-ocr` — 수식을 `$$…$$`(LaTeX)로 넣는다. PDF 에만 돈다 |
| 일부 쪽만 | `-p 1-3` |
| 대체(kordoc 이 실패할 때) | `tesseract "<그림>" - -l kor+eng > "…/<이름>.md"`(그림만, 표 구조 없음) |

### 손글씨 모드 고르기

사용자가 모드를 말하면 그대로 따른다. 말하지 않았으면 그림을 보고 고른다.

- **손으로 쓴 글자가 보이면**(손글씨로 채운 서식·신청서, 손으로 쓴 메모) `--ocr-rec handwriting` 으로 읽는다. 답에 「손글씨 모드로 읽어 인쇄된 부분은 띄어쓰기가 붙을 수 있습니다」라고 적는다.
- **손글씨가 섞였는지 애매하면** 두 모드로 다 읽어 `<이름>.md`(기본)·`<이름>-손글씨.md` 두 파일을 주고, 값이 다른 곳을 몇 개 짚어 알린다.
- **인쇄된 글자뿐이면** 기본 모드로 읽는다. 손글씨 모드는 인쇄체의 띄어쓰기를 많이 잃는다.
- 근거(2026-10-27 OKE 측정): 손글씨로 채운 서식 사진에서 손글씨 모드가 기본이 틀린 이름·날짜를 맞게 읽었다. 인쇄체만 있는 글에서는 두 모드 모두 글자는 100% 맞았지만, 어절 일치가 기본 91%·손글씨 58% 였다. `--ocr-det server` 는 두 시험 모두 결과가 같거나 거의 같았고 시간만 40~70% 더 걸렸다 — 글줄을 놓쳤을 때만 쓴다.

## 결과 확인과 다듬기

- **kordoc 이 만든 파일을 그대로 결과로 둔다. 파일 전체를 다시 쓰지 않는다**(`write_file` 로 덮어쓰기, 표를 옮겨 적기 모두 안 된다). 다시 쓰면 칸이 빠지고 숫자·이름이 바뀐다 — 2026-10-27 서식 사진에서 「2530 원」이 「253,000원」, 「종된」이 「종점」이 되고 칸 여러 개가 사라졌다.
- **병합 칸이 있는 표는 HTML `<table>`(`rowspan`·`colspan`)로 나온다. 정상이며 그대로 둔다.** Markdown 표로 바꾸지 않는다 — Markdown 표는 병합 칸을 나타내지 못한다. hwpx 로 만들 때 `kordoc generate` 가 병합 칸까지 옮긴다(`markdown-to-doc`).
- **읽은 값을 고치지 않는다.** 숫자에 쉼표·0 을 붙이거나, 날짜를 그럴듯하게 바꾸거나, 이름·지명을 추측해 바꾸지 않는다. 이상해 보이는 값은 그대로 두고 답에서 「원문과 대조가 필요합니다」라고 짚는다.
- 손볼 것이 있으면 그 줄만 고친다(`patch`). OCR 은 구두점 뒤 띄어쓰기를 자주 빠뜨린다(「1.한글」). 내용을 바꾸지 말고 띄어쓰기만 고치는 것은 괜찮다. 고쳤으면 그렇다고 말한다.
- `--no-images` 를 줘도 결과에 `![image](…)` 줄이 남을 수 있다. 그 줄은 지운다.
- 읽은 글자가 적거나 깨졌으면 `--ocr-det server` 로 한 번 더 해 본다. 그래도 안 되면 그림이 흐리거나 기울어졌다고 알리고, 더 선명한 사진을 부탁한다.
- OCR 결과는 원문과 다를 수 있다. 숫자·이름·금액처럼 중요한 값은 「원문과 대조가 필요합니다」라고 덧붙인다.

## 사용자에게 알리기

답 끝에 저장한 경로를 적고 「답 아래 파일 칩이나 대화 메뉴의 「파일」에서 내려받을 수 있습니다」라고 안내한다. `MEDIA:` 태그나 다운로드 주소를 만들지 않는다.

## 하지 않는 것

- 인터넷에서 모델이나 변환기를 받지 않는다. `pip install`·`npm install` 을 하지 않는다(폐쇄망, `KORDOC_OFFLINE=1` 이고 모델은 `/opt/kordoc/models` 에 있다).
- 원본 파일을 덮어쓰지 않는다. 스킬 폴더(`<스킬폴더>`)에 쓰지 않는다.
