/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 3D 장면이 그리다 죽거나(WebGL 오류) WebGL 이 없으면 같은 자리에 2D 보기를 보인다(계획 007 G4). 빈 상자만 남지 않게 한다.
// 다시 배포 뒤 옛 장면 묶음이 404 면 2D 보기에 새 버전 안내를 넣고 화면 오류 경계처럼 새로 고친다(스펙 2026-10-21-013 §6).
import { Component, ReactNode } from 'react';

import { t } from '@/i18n';
import { isChunkError, keepReloading } from '@/lib/chunkError';

export function canUseWebGL(): boolean {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    return false;
  }
}

interface Props {
  fallback: (reason: string) => ReactNode;
  children: ReactNode;
}

export class SceneBoundary extends Component<Props, { reason: string | null }> {
  state = { reason: null as string | null };

  private stop?: () => void;

  static getDerivedStateFromError(e: unknown) {
    if (isChunkError(e)) return { reason: t('common.newVersion') };
    return { reason: e instanceof Error ? e.message || e.name : String(e) };
  }

  componentDidCatch(e: unknown) {
    if (isChunkError(e)) this.stop = keepReloading();
  }

  componentWillUnmount() {
    this.stop?.();
  }

  render() {
    return this.state.reason !== null ? this.props.fallback(this.state.reason) : this.props.children;
  }
}
