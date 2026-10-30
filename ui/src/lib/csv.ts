/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// CSV·TSV 를 표로 그리기 위한 작은 파서(스펙 2026-10-20-002 §3-5). 따옴표 안의 구분자·줄 바꿈·"" 를 다룬다. 따로 라이브러리를 들이지 않는다.

/** 줄 배열. maxRows 를 넘으면 거기서 멈추고 truncated 를 참으로 */
export function parseCsv(text: string, sep = ',', maxRows = 1000): { rows: string[][]; truncated: boolean } {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += c;
      continue;
    }
    if (c === '"' && cell === '') quoted = true;
    else if (c === sep) {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      if (rows.length > maxRows) return { rows: rows.slice(0, maxRows), truncated: true };
    } else cell += c;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.length > maxRows ? { rows: rows.slice(0, maxRows), truncated: true } : { rows, truncated: false };
}
