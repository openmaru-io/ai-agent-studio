/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 문서 본문의 공통 틀(스펙 2026-10-20-005 §6·§6-1). FileViewer 묶음 안에 있고, 형식별 본문(PdfBody·DocxBody)은 여기서 처음 열 때 받는다.
// - 라이브러리를 받기 전에 Office 파일을 거른다(리뷰 D7 CFB, D13 압축 폭탄) → 작은 창(디자인 DV2)
// - 본문마다 오류 경계를 둔다(리뷰 D3). 다시 시도는 lazy 를 새로 만든다 — lazy 는 한 번 실패한 import 를 기억한다(리뷰 D12)
// - 묶음·작업 스레드·부가 파일이 404 면 다시 배포된 것이라 「새 버전」으로 알린다(리뷰 D12, 재검토 D7)
import { Component, type ComponentType, type ErrorInfo, lazy, type ReactNode, Suspense, useEffect, useMemo, useState } from 'react';

import { t } from '@/i18n';
import { isChunkError } from '@/lib/chunkError';
import type { ViewerKind } from '@/lib/fileKinds';

import { DocSkeleton, Failure, Notice } from '../viewerParts';
import type { ViewerFile } from '../viewerStore';
import { preCheck } from './docMath';
import { docStore } from './docStore';

/** 본문이 부모에게 알리는 실패. small 은 파일 성질(다시 시도 없음), retry 는 일시 실패, newVersion 은 다시 배포 */
export type DocFail = { type: 'small'; reason: string } | { type: 'retry'; reason: string } | { type: 'newVersion' } | { type: 'empty' };

export interface DocBodyProps {
  file: ViewerFile;
  bytes: Uint8Array;
  onFail: (f: DocFail) => void;
}

const LOADERS: Partial<Record<ViewerKind, () => Promise<{ default: ComponentType<DocBodyProps> }>>> = {
  pdf: () => import('./PdfBody'),
  docx: () => import('./DocxBody'),
  xlsx: () => import('./XlsxBody'),
  pptx: () => import('./PptxBody'),
  hwp: () => import('./HwpBody'),
};

/** 주소 중 하나라도 404 면 참. 다시 배포 뒤 옛 작업 스레드·wasm·cmaps 가 없어진 경우를 가린다(재검토 D7) */
export async function assetGone(urls: string[]): Promise<boolean> {
  const res = await Promise.all(
    urls.map((u) =>
      fetch(u, { method: 'HEAD', cache: 'no-store' })
        .then((r) => r.status === 404)
        .catch(() => false)
    )
  );
  return res.some(Boolean);
}

class Boundary extends Component<{ children: ReactNode; onError: (e: unknown) => void }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown, _info: ErrorInfo) {
    this.props.onError(error);
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

export function DocBody({ file, kind, bytes, onSmall }: { file: ViewerFile; kind: ViewerKind; bytes: Uint8Array; onSmall: () => void }) {
  const [attempt, setAttempt] = useState(0);
  const [fail, setFail] = useState<DocFail | null>(null);
  const check = useMemo(() => preCheck(kind, file.name, bytes), [kind, file.name, bytes]);
  // 다시 시도마다 lazy 를 새로 만든다(실패한 promise 를 버린다)
  const Body = useMemo(() => (LOADERS[kind] ? lazy(LOADERS[kind]) : null), [kind, attempt]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => docStore.reset(), []);
  const small = fail?.type === 'small' || check !== 'ok';
  useEffect(() => {
    if (small) onSmall();
  }, [small]); // eslint-disable-line react-hooks/exhaustive-deps

  if (check !== 'ok') return <Notice file={file} text={t(`chat.viewer.doc.${check}`)} />;
  if (!Body) return <Notice file={file} text={t('chat.viewer.unsupported')} />;
  if (fail?.type === 'small') return <Notice file={file} text={fail.reason} />;
  if (fail?.type === 'empty') return <Notice file={file} text={t('chat.viewer.doc.empty')} />;
  if (fail)
    return (
      <Failure
        file={file}
        reason={fail.type === 'newVersion' ? t('chat.viewer.doc.newVersion') : fail.reason}
        refresh={fail.type === 'newVersion'}
        onRetry={() => {
          setFail(null);
          setAttempt((a) => a + 1);
        }}
      />
    );
  return (
    <Boundary
      key={attempt}
      onError={(e) => setFail(isChunkError(e) ? { type: 'newVersion' } : { type: 'retry', reason: t('chat.viewer.doc.failOpen') })}
    >
      <Suspense fallback={<DocSkeleton />}>
        <Body file={file} bytes={bytes} onFail={setFail} />
      </Suspense>
    </Boundary>
  );
}
