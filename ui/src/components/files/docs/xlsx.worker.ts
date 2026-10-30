/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 엑셀 해석 작업 스레드(스펙 2026-10-20-005 리뷰 D4). exceljs 는 통합 문서 전체를 메모리에 올리므로 화면과 따로 돈다.
// 시트마다 앞 1,000줄·100열(§7 D4)을 글자로 바꿔 돌려준다. 숨은 시트는 뺀다. 병합 칸은 왼쪽 위에만 값을 둔다.
import ExcelJS from 'exceljs';

import { cellText, type CellValue, isNumeric } from './xlsxFormat';

export const MAX_ROWS = 1000;
export const MAX_COLS = 100;

export interface Sheet {
  name: string;
  rows: string[][];
  /** 오른쪽 정렬할 칸(행 × 열, 1 이면 숫자·날짜) */
  numeric: Uint8Array;
  cols: number;
  cutRows: boolean;
  cutCols: boolean;
}

self.onmessage = async (e: MessageEvent<{ id: number; type: string; bytes: ArrayBuffer }>) => {
  const { id, bytes } = e.data;
  try {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(bytes);
    const sheets: Sheet[] = [];
    for (const ws of wb.worksheets) {
      if (ws.state && ws.state !== 'visible') continue;
      const rowCount = Math.min(ws.rowCount, MAX_ROWS);
      const cols = Math.min(ws.columnCount, MAX_COLS);
      const rows: string[][] = [];
      const numeric = new Uint8Array(rowCount * cols);
      for (let r = 1; r <= rowCount; r++) {
        const row = ws.getRow(r);
        const out: string[] = [];
        for (let c = 1; c <= cols; c++) {
          const cell = row.getCell(c);
          if (cell.isMerged && cell.master && cell.master.address !== cell.address) {
            out.push('');
            continue;
          }
          const v = cell.value as CellValue;
          out.push(cellText(v, cell.numFmt));
          if (isNumeric(v)) numeric[(r - 1) * cols + (c - 1)] = 1;
        }
        rows.push(out);
      }
      sheets.push({ name: ws.name, rows, numeric, cols, cutRows: ws.rowCount > MAX_ROWS, cutCols: ws.columnCount > MAX_COLS });
    }
    (self as unknown as Worker).postMessage({ id, ok: true, data: sheets }, sheets.map((s) => s.numeric.buffer));
  } catch {
    (self as unknown as Worker).postMessage({ id, ok: false, code: 'failed' });
  }
};
