#!/usr/bin/env python3
# Copyright 2026 The OPENMARU Authors.
"""명함 목록(CSV)에 한 장씩 더하고, 찾고, 엑셀(xlsx)로 내보낸다 (OMAI-1529, 스킬 business-card-ocr).

사용:
  python cards.py new-tmp                                          작업 폴더를 만들고 경로를 찍는다
  python cards.py ocr <그림> <out.md> [--server] [--handwriting]   kordoc 으로 읽기(기울어진 사진은 펴서도 읽고 나은 쪽)
  python cards.py straighten <그림> <out.png>                      명함 테두리를 찾아 원근을 편다
  python cards.py add --file <card.json> --ocr <front.md> [--ocr <back.md>] [--replace <id> | --allow-duplicate]
  python cards.py export [--since YYYY-MM-DD] [--company <글자>] [--out <폴더>]
  python cards.py find <글자>

- 목록은 프로파일마다 하나다: /opt/data/workspace/business-cards/<프로파일>/cards.csv(프로파일은 HERMES_HOME 으로 가린다,
  AAS_CARDS_CSV 가 있으면 그 파일). 엑셀은 내보낼 때마다 새로 만든다.
- raw_text 는 --ocr 파일(kordoc 결과)을 이 스크립트가 읽어 채운다. 칸 값이 원문에 없으면 값을 바꾸지 않고
  needs_review 에 칸 이름을 넣는다. 전화·이메일 형식이 맞지 않을 때도 같다.
- 쓰기(머리 줄 맞추기·중복 검사·추가·바꾸기)는 한 배타 잠금 안에서, 읽기(export·find)는 공유 잠금으로 한다.
  쓰기 전에 끊긴 마지막 줄을 <csv>.broken 으로 옮기고, 머리 줄은 칸을 더하기만 한다(모르는 칸은 그대로).
- 시각은 TZ 환경 변수가 있으면 그 시간대, 없으면 한국 시간(+09:00)이다.
- 종료 코드: 0 성공, 2 입력 오류, 3 중복(겹친 줄을 JSON 으로 찍음), 4 내보낼 줄 없음, 5 명함 테두리 없음(straighten).
"""

import argparse
import contextlib
import csv
import datetime as dt
import fcntl
import io
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
from pathlib import Path

FIELDS = ("id", "created_at", "name", "name_en", "company", "department", "title", "mobile", "phone", "fax",
          "email", "address", "website", "memo", "source_image", "needs_review", "raw_text")
SCRIPT_FIELDS = ("id", "created_at", "needs_review", "raw_text")           # 스크립트만 채운다
INPUT_FIELDS = tuple(f for f in FIELDS if f not in SCRIPT_FIELDS)
UNCHECKED = ("memo", "source_image")                                       # 원문과 대조하지 않는 칸
PHONES = ("mobile", "phone", "fax")
LABELS = {"id": "번호", "created_at": "등록 시각", "name": "이름", "name_en": "영문 이름", "company": "회사",
          "department": "부서", "title": "직함", "mobile": "휴대폰", "phone": "전화", "fax": "팩스",
          "email": "이메일", "address": "주소", "website": "웹사이트", "memo": "메모", "source_image": "원본 그림",
          "needs_review": "확인 필요", "raw_text": "OCR 원문"}
EXCEL_MAX = 32000                                                          # 엑셀 한 칸 한도 32,767자
FIND_LIMIT = 20
LOW_TEXT = 40                                                              # 한글·영문·숫자가 이보다 적으면 명함을 못 읽은 것
KST = dt.timezone(dt.timedelta(hours=9))
_PHONE = re.compile(r"^[0+(][0-9+\-().\s]*$")                              # 0·+·( 로 시작(2026-10-28 OKE P6: 주소 숫자가 휴대폰으로)
_EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
_LOOSE = re.compile(r"[\s\-.()]")
# 이름 칸에 붙어 들어오는 직함(2026-10-28 OKE 실화면: 「오솔길 변호사」). 두 글자 이상만 본다 — 한 글자(장·님)는 이름 끝과 헷갈린다
_TITLES = ("대표이사", "대표", "부회장", "회장", "부사장", "사장", "전무", "상무", "이사", "본부장", "센터장", "실장", "팀장",
           "부장", "차장", "과장", "대리", "주임", "사원", "수석연구원", "책임연구원", "선임연구원", "연구원", "수석", "책임", "선임",
           "매니저", "변호사", "변리사", "세무사", "회계사", "노무사", "교수", "박사", "원장", "관장", "소장", "국장", "처장",
           "위원장", "위원", "컨설턴트", "디자이너", "엔지니어", "ceo", "cto", "cfo", "coo", "manager", "director")
_CONTACT_PHONE = re.compile(r"\(?0\d{1,3}\)?[\s\-.)]?\d{3,4}[\s\-.]\d{4}|\+\d{1,3}(?:[\s\-.]?\d{1,4}){2,4}")
_CONTACT_EMAIL = re.compile(r"[^@\s]+@[^@\s]+\.[A-Za-z]{2,}")
_QUOTES = str.maketrans("‘’‚‛“”„‟", "''''\"\"\"\"")       # OCR 이 ' 를 ’ 로 읽는다(2026-10-28 V2 S9)


class InputError(Exception):
    pass


class MissingTool(Exception):
    """이 에이전트에 도구가 없다(스킬 허브로 상류 Hermes 이미지에 설치된 경우, 스펙 2026-10-29-001 D4). 종료 코드 6."""


def profile_name() -> str:
    """HERMES_HOME=/opt/data/profiles/<이름> 이면 그 이름, 루트 프로파일(/opt/data)이나 값이 없으면 default."""
    home = Path(os.environ.get("HERMES_HOME") or "/opt/data")
    return home.name if home.parent.name == "profiles" and home.name else "default"


def csv_path() -> Path:
    """프로파일마다 목록을 따로 둔다(2026-10-28 사용자 결정, 스펙 Q4). AAS_CARDS_CSV 는 시험·빌드 확인용으로 통째로 바꾼다."""
    if os.environ.get("AAS_CARDS_CSV"):
        return Path(os.environ["AAS_CARDS_CSV"])
    return Path(os.environ.get("AAS_CARDS_DIR") or "/opt/data/workspace/business-cards") / profile_name() / "cards.csv"


def tmp_root() -> Path:
    return Path(os.environ.get("AAS_CARDS_TMP") or "/opt/data/workspace/.tmp/cards")


def now() -> dt.datetime:
    """TZ 가 있으면 그 시간대, 없으면 한국 시간. 이미지에 시간대 설정이 없어 그대로 두면 UTC 가 된다."""
    if os.environ.get("TZ"):
        return dt.datetime.now().astimezone().replace(microsecond=0)
    return dt.datetime.now(KST).replace(microsecond=0)


@contextlib.contextmanager
def locked(path: Path, exclusive: bool):
    path.parent.mkdir(parents=True, exist_ok=True)
    # . 으로 시작해야 AAS 파일 칩에 안 뜬다. 읽기·쓰기(a+)로 연다: NFS 는 flock 을 fcntl 잠금으로 흉내 내서 공유 잠금은
    # 읽기로, 배타 잠금은 쓰기로 연 파일에만 걸린다(2026-10-28 OKE: "a" 로 열어 export 가 EBADF 로 실패).
    with open(path.with_name(f".{path.name}.lock"), "a+") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH)
        try:
            yield
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)


def complete_end(data: bytes) -> int:
    """따옴표 밖의 마지막 줄바꿈 바로 뒤 위치. 그 뒤는 저장 중에 끊긴 줄이다(" 와 \\n 은 UTF-8 다중 바이트 안에 없다)."""
    inside, end = False, 0
    for i, b in enumerate(data):
        if b == 0x22:
            inside = not inside
        elif b == 0x0A and not inside:
            end = i + 1
    return end


def read(path: Path) -> tuple[list[str], list[dict]]:
    """머리 줄과 줄들. 끊긴 마지막 줄은 읽지 않는다."""
    if not path.exists():
        return [], []
    data = path.read_bytes()
    text = data[:complete_end(data)].decode("utf-8")
    reader = csv.DictReader(io.StringIO(text, newline=""))
    return list(reader.fieldnames or []), [{k: (v or "") for k, v in row.items() if k is not None} for row in reader]


def write_all(path: Path, header: list[str], rows: list[dict]) -> None:
    """임시 파일에 다 쓰고 한 번에 바꾼다. 바꾸기 전 파일은 <csv>.bak 으로 남긴다."""
    if path.exists():
        shutil.copyfile(path, str(path) + ".bak")
    tmp = path.with_name(path.name + ".tmp")
    with open(tmp, "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(header)
        for row in rows:
            w.writerow([row.get(k, "") for k in header])
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def repair(path: Path) -> bool:
    """끊긴 마지막 줄을 <csv>.broken 에 덧붙여 옮기고 잘라 낸다. 잘라 냈으면 True."""
    if not path.exists():
        return False
    data = path.read_bytes()
    end = complete_end(data)
    if end == len(data):
        return False
    with open(str(path) + ".broken", "ab") as f:
        f.write(data[end:])
    with open(path, "r+b") as f:
        f.truncate(end)
        f.flush()
        os.fsync(f.fileno())
    return True


def ensure_header(path: Path) -> list[str]:
    """머리 줄에 없는 칸을 끝에 더한다. 파일에만 있는 칸(지금 판이 모르는 칸)은 지우지 않는다."""
    header, rows = read(path)
    if not header:
        write_all(path, list(FIELDS), [])
        return list(FIELDS)
    missing = [f for f in FIELDS if f not in header]
    if missing:
        header = header + missing
        write_all(path, header, rows)
    return header


def append(path: Path, header: list[str], row: dict) -> None:
    with open(path, "a", encoding="utf-8", newline="") as f:
        csv.writer(f).writerow([row.get(k, "") for k in header])
        f.flush()
        os.fsync(f.fileno())


def loose(text: str) -> str:
    return _LOOSE.sub("", text.translate(_QUOTES)).casefold()


def mobile_key(value: str) -> str:
    digits = re.sub(r"\D", "", value)
    if digits.startswith("0082"):
        return "0" + digits[4:]
    if digits.startswith("82") and not digits.startswith("0"):
        return "0" + digits[2:]
    return digits


def load_card(file: Path, ocr: list[Path]) -> dict:
    try:
        card = json.loads(file.read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        raise InputError(f"JSON 파일을 읽지 못했습니다: {file}: {e}")
    if not isinstance(card, dict):
        raise InputError("JSON 은 객체({...})여야 합니다")
    bad = [k for k in card if k not in INPUT_FIELDS]
    if bad:
        raise InputError(f"받을 수 없는 키: {', '.join(bad)} (받는 키: {', '.join(INPUT_FIELDS)}; "
                         f"{', '.join(SCRIPT_FIELDS)} 는 스크립트가 채운다)")
    out = {}
    for k, v in card.items():
        if v is None:
            v = ""
        if not isinstance(v, str):
            raise InputError(f"{k}: 값은 글자여야 합니다")
        out[k] = v.strip()
    texts = []
    for p in ocr:
        try:
            texts.append(p.read_text(encoding="utf-8").rstrip())
        except OSError as e:
            raise InputError(f"--ocr 파일을 읽지 못했습니다: {p}: {e}")
    out["raw_text"] = "\n---\n".join(texts)
    return out


def review(card: dict) -> list[str]:
    """원문에 없거나 형식이 맞지 않는 칸 이름(FIELDS 순서)."""
    raw = loose(card["raw_text"])
    flagged = set()
    for k in INPUT_FIELDS:
        v = card.get(k, "")
        if not v:
            continue
        if k not in UNCHECKED and loose(v) not in raw:
            flagged.add(k)
        if k in PHONES and not (_PHONE.match(v) and len(re.sub(r"\D", "", v)) >= 7):
            flagged.add(k)
        if k == "email" and not _EMAIL.match(v):
            flagged.add(k)
        if k == "name":
            bare = re.sub(r"\s", "", v).casefold()
            if any(bare.endswith(t) and len(bare) > len(t) for t in _TITLES):
                flagged.add(k)
    return [k for k in FIELDS if k in flagged]


def duplicates(card: dict, rows: list[dict], skip_id: str = "") -> list[dict]:
    email = card.get("email", "").casefold()
    mobile = mobile_key(card.get("mobile", ""))
    name, company = card.get("name", "").casefold(), card.get("company", "").casefold()
    found = []
    for row in rows:
        if row.get("id") == skip_id:
            continue
        match = []
        if email and row.get("email", "").casefold() == email:
            match.append("email")
        if mobile and mobile_key(row.get("mobile", "")) == mobile:
            match.append("mobile")
        if not email and not mobile and name and company and \
                row.get("name", "").casefold() == name and row.get("company", "").casefold() == company:
            match.append("name+company")
        if match:
            found.append({"id": row.get("id", ""), "name": row.get("name", ""), "company": row.get("company", ""),
                          "match": match})
    return found


def cmd_new_tmp(_args) -> int:
    root = tmp_root()
    root.mkdir(parents=True, exist_ok=True)
    folder = root / f"{now():%Y%m%d-%H%M%S}-{secrets.token_hex(3)}"
    folder.mkdir()
    print(folder)
    return 0


def cmd_add(args) -> int:
    card = load_card(Path(args.file), [Path(p) for p in args.ocr])
    path = csv_path()
    with locked(path, exclusive=True):
        recovered = repair(path)
        header = ensure_header(path)
        _, rows = read(path)
        target = None
        if args.replace:
            target = next((r for r in rows if r.get("id") == args.replace), None)
            if target is None:
                raise InputError(f"없는 id: {args.replace}")
            # 같은 사람의 새 사진으로 바꿔도 앞 원문·그림은 남긴다(2026-10-28 OKE P3: 통째로 바꿔 바른 주소가 표시됨)
            old, new = target.get("raw_text", ""), card["raw_text"]
            card["raw_text"] = new if not old else old if not new or new in old else f"{old}\n---\n{new}"
            images = [p for p in target.get("source_image", "").split(";") + card.get("source_image", "").split(";") if p]
            card["source_image"] = ";".join(dict.fromkeys(images))
        if not args.allow_duplicate:
            dup = duplicates(card, rows, skip_id=args.replace or "")
            if dup:
                print(json.dumps({"duplicate": dup}, ensure_ascii=False))
                return 3
        flagged = review(card)
        if target is not None:
            row = {k: v for k, v in target.items() if k not in INPUT_FIELDS}       # 모르는 칸·id·created_at 은 둔다
            row.update({k: card.get(k, "") for k in INPUT_FIELDS})
        else:
            stamp = now()
            # 같은 초에 여러 장이면 무작위 4자가 겹칠 수 있다(2026-10-29 동시 추가 시험 100줄에 id 99개) → 잠금 안에서 피한다
            base = rid = f"c-{stamp:%Y%m%d%H%M%S}-{secrets.token_hex(2)}"
            taken, n = {r.get("id") for r in rows}, 2
            while rid in taken:
                rid, n = f"{base}-{n}", n + 1
            row = {"id": rid, "created_at": stamp.isoformat()}
            row.update({k: card.get(k, "") for k in INPUT_FIELDS})
        row["needs_review"] = ";".join(flagged)
        row["raw_text"] = card["raw_text"]
        if target is not None:
            write_all(path, header, [row if r is target else r for r in rows])
        else:
            append(path, header, row)
    folder = Path(args.file).resolve().parent
    if folder.parent == tmp_root().resolve():                                    # new-tmp 폴더면 연락처를 남기지 않는다
        shutil.rmtree(folder, ignore_errors=True)
    shown = {k: v for k, v in row.items() if k != "raw_text"}
    print(json.dumps({"id": row["id"], "needs_review": flagged, "recovered": recovered, "row": shown},
                     ensure_ascii=False))
    return 0


def selected(args) -> tuple[list[str], list[dict]]:
    path = csv_path()
    with locked(path, exclusive=False):
        header, rows = read(path)
    if args.since:
        rows = [r for r in rows if r.get("created_at", "")[:10] >= args.since]
    if args.company:
        rows = [r for r in rows if args.company.casefold() in r.get("company", "").casefold()]
    return header, rows


def free_name(folder: Path, stem: str) -> Path:
    out, n = folder / f"{stem}.xlsx", 2
    while out.exists():
        out, n = folder / f"{stem}-{n}.xlsx", n + 1
    return out


def cmd_export(args) -> int:
    try:
        from openpyxl import Workbook
        from openpyxl.cell.cell import ILLEGAL_CHARACTERS_RE
        from openpyxl.styles import Alignment, Font, PatternFill
    except ImportError:
        raise MissingTool("openpyxl") from None

    header, rows = selected(args)
    if not rows:
        print("내보낼 명함이 없습니다", file=sys.stderr)
        return 4
    known = [f for f in FIELDS if f != "raw_text"]
    cols = known + [h for h in header if h not in FIELDS] + ["raw_text"]
    wb = Workbook()
    ws = wb.active
    ws.title = "명함"
    yellow = PatternFill("solid", fgColor="FFF2CC")
    widths = [len(LABELS.get(c, c)) for c in cols]
    for j, c in enumerate(cols, 1):
        cell = ws.cell(row=1, column=j, value=LABELS.get(c, c))
        cell.font = Font(bold=True)
    for i, row in enumerate(rows, 2):
        flagged = set(row.get("needs_review", "").split(";")) - {""}
        for j, c in enumerate(cols, 1):
            v = ILLEGAL_CHARACTERS_RE.sub("", row.get(c, ""))
            if len(v) > EXCEL_MAX:
                v = v[:EXCEL_MAX] + "…(잘림)"
            cell = ws.cell(row=i, column=j)
            cell.value = v
            cell.data_type = "s"                                                  # =·+·-·@ 로 시작해도 수식이 아니다
            cell.number_format = "@"
            if c in flagged:
                cell.fill = yellow
            if c == "raw_text":
                cell.alignment = Alignment(wrap_text=True, vertical="top")
            widths[j - 1] = max(widths[j - 1], max((len(x) for x in v.splitlines()), default=0))
    for j, w in enumerate(widths, 1):
        ws.column_dimensions[ws.cell(row=1, column=j).column_letter].width = min(w, 50) + 2
    ws.freeze_panes = "A2"
    ws.auto_filter.ref = ws.dimensions
    folder = Path(args.out or "/opt/data/workspace/output")
    folder.mkdir(parents=True, exist_ok=True)
    out = free_name(folder, f"명함-{now():%Y%m%d-%H%M}")
    wb.save(out)
    print(f"명함 {len(rows)}줄")
    print(out)
    return 0


def cmd_find(args) -> int:
    path = csv_path()
    with locked(path, exclusive=False):
        _, rows = read(path)
    q = args.text.casefold()
    digits = re.sub(r"\D", "", args.text)
    hits = [r for r in rows
            if any(q in r.get(k, "").casefold() for k in ("name", "name_en", "company", "email", "mobile"))
            or (len(digits) >= 4 and digits in mobile_key(r.get("mobile", "")))]
    shown = [{k: v for k, v in r.items() if k != "raw_text"} for r in hits[:FIND_LIMIT]]
    print(json.dumps({"total": len(hits), "rows": shown}, ensure_ascii=False))
    return 0


def straighten(image: str, out: str):
    """사진에서 명함 테두리(가장 큰 볼록 사각형)를 찾아 원근을 펴 out 에 쓴다. 못 찾으면(스캔본처럼 명함이 그림 전체) None.
    kordoc 은 기울기를 바로잡지 않는다(2026-10-28 V2: 15도 기울인 명함이 10칸 중 2칸만 읽혔다)."""
    import math

    import cv2
    import numpy as np

    img = cv2.imread(image)                                                   # EXIF 방향은 imread 가 맞춘다
    if img is None:
        raise InputError(f"그림을 읽지 못했습니다: {image}")
    h, w = img.shape[:2]
    scale = min(1.0, 1500 / max(h, w))
    small = cv2.resize(img, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA) if scale < 1 else img
    gray = cv2.GaussianBlur(cv2.cvtColor(small, cv2.COLOR_BGR2GRAY), (5, 5), 0)
    edges = cv2.dilate(cv2.Canny(gray, 50, 150), np.ones((5, 5), np.uint8))
    contours, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    frame = small.shape[0] * small.shape[1]
    quad = None
    for c in sorted(contours, key=cv2.contourArea, reverse=True)[:5]:
        if not 0.15 * frame <= cv2.contourArea(c) <= 0.97 * frame:              # 너무 작거나 그림 테두리 자체
            continue
        approx = cv2.approxPolyDP(c, 0.02 * cv2.arcLength(c, True), True)
        if len(approx) == 4 and cv2.isContourConvex(approx):
            quad = approx.reshape(4, 2).astype("float32") / scale
            break
    if quad is None:
        return None
    s, d = quad.sum(axis=1), np.diff(quad, axis=1).ravel()
    tl, br, tr, bl = quad[s.argmin()], quad[s.argmax()], quad[d.argmin()], quad[d.argmax()]
    width = int(round(max(np.linalg.norm(tr - tl), np.linalg.norm(br - bl))))
    height = int(round(max(np.linalg.norm(bl - tl), np.linalg.norm(br - tr))))
    dst = np.array([[0, 0], [width - 1, 0], [width - 1, height - 1], [0, height - 1]], "float32")
    flat = cv2.warpPerspective(img, cv2.getPerspectiveTransform(np.array([tl, tr, br, bl]), dst), (width, height))
    if not cv2.imwrite(out, flat):
        raise InputError(f"그림을 쓰지 못했습니다: {out}")
    angle = math.degrees(math.atan2(float(tr[1] - tl[1]), float(tr[0] - tl[0])))
    return {"found": True, "angle": round(angle, 1), "size": [width, height], "out": out}


def cmd_straighten(args) -> int:
    info = straighten(args.image, args.out)
    print(json.dumps(info or {"found": False}, ensure_ascii=False))
    return 0 if info else 5


def text_score(text: str) -> int:
    return len(re.findall(r"[가-힣A-Za-z0-9@]", text))


def kordoc(image: str, out: Path, server: bool, handwriting: bool = False) -> str:
    cmd = [os.environ.get("AAS_KORDOC") or "kordoc", image, "-o", str(out), "--silent"]
    if not shutil.which(cmd[0]):
        raise MissingTool("kordoc")
    cmd += (["--ocr-det", "server"] if server else []) + (["--ocr-rec", "handwriting"] if handwriting else [])
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0 or not out.exists():
        raise InputError(f"kordoc 이 그림을 읽지 못했습니다: {image}: {r.stderr.strip()[-300:]}")
    return out.read_text(encoding="utf-8")


def cmd_ocr(args) -> int:
    """원본을 읽고, 명함 테두리를 찾으면 편 그림도 읽어 글자(한글·영문·숫자)가 더 많은 쪽을 out 에 남긴다.
    늘 펴면 안 된다: 2026-10-28 V2 에서 휴대폰 사진(P3)과 고해상도 스캔(P4)은 명함 안쪽의 사각형을 잡아 줄 수가 줄었다."""
    out = Path(args.out)
    orig = kordoc(args.image, out, args.server, args.handwriting)
    flat_img = out.with_name(out.stem + "-flat.png")
    try:
        info = straighten(args.image, str(flat_img))
    except (ImportError, InputError):                                           # OpenCV 가 못 여는 그림도 kordoc 결과는 쓴다
        info = None
    result = {"used": "original", "straightened": bool(info), "angle": info and info["angle"], "handwriting": args.handwriting,
              "chars": {"original": text_score(orig)}, "out": str(out)}
    if info:
        flat = kordoc(str(flat_img), out.with_name(out.stem + "-flat.md"), args.server, args.handwriting)
        result["chars"]["straightened"] = text_score(flat)
        if text_score(flat) > text_score(orig):
            out.write_text(flat, encoding="utf-8")
            result["used"] = "straightened"
    # 스킬 문서보다 도구 결과를 더 잘 따른다(2026-10-28 OKE P7: 두 번 읽고도 그림 분석을 되풀이). 다음 할 일을 결과에 적는다
    # 손글씨 쪽지처럼 원래 글자가 적어도 전화번호·이메일을 읽었으면 멈추게 하지 않는다(2026-10-28 손글씨 합성 H1·H5 22~34자)
    score = max(result["chars"].values())
    kept = out.read_text(encoding="utf-8")
    low = score < LOW_TEXT and not (_CONTACT_PHONE.search(kept) or _CONTACT_EMAIL.search(kept))
    if low and not (args.server or args.handwriting):                           # 손글씨 모드도 두 번째 읽기다
        result["next"] = (f"읽은 글자가 적습니다({score}자). --server 를 붙여(한국어 손글씨면 --handwriting 을 붙여) "
                          "한 번만 더 읽으세요.")
    elif low:
        result["next"] = (f"읽은 글자가 적습니다({score}자). 더 시도하지 마세요(그림 분석·전처리·다른 OCR·웹 검색 금지). "
                          "읽힌 칸만 등록할지, 명함을 다시 찍어 줄지 등록하기 전에 사용자에게 물으세요.")
    print(json.dumps(result, ensure_ascii=False))
    return 0


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="명함 목록(CSV) 더하기·찾기·엑셀 내보내기")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("new-tmp")
    a = sub.add_parser("add")
    a.add_argument("--file", required=True)
    a.add_argument("--ocr", required=True, action="append")
    g = a.add_mutually_exclusive_group()
    g.add_argument("--replace")
    g.add_argument("--allow-duplicate", action="store_true")
    e = sub.add_parser("export")
    e.add_argument("--since")
    e.add_argument("--company")
    e.add_argument("--out")
    f = sub.add_parser("find")
    f.add_argument("text")
    s = sub.add_parser("straighten")
    s.add_argument("image")
    s.add_argument("out")
    o = sub.add_parser("ocr")
    o.add_argument("image")
    o.add_argument("out")
    o.add_argument("--server", action="store_true")
    o.add_argument("--handwriting", action="store_true")                       # 한국어 손글씨 모델(kordoc --ocr-rec handwriting)
    args = p.parse_args(argv)
    try:
        return {"new-tmp": cmd_new_tmp, "add": cmd_add, "export": cmd_export, "find": cmd_find,
                "straighten": cmd_straighten, "ocr": cmd_ocr}[args.cmd](args)
    except InputError as err:
        print(str(err), file=sys.stderr)
        return 2
    except MissingTool as err:
        print(f"이 스킬에 필요한 도구가 이 에이전트에 없습니다: {err}", file=sys.stderr)
        return 6


if __name__ == "__main__":
    sys.exit(main())
