/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 화면을 빌드한 판의 정보. 좌측 메뉴 아래 버전 단추와 버전 정보 창이 쓴다(COP Console 의 getDetailedVersion·versionInfoRows 와 같은 내용).
// 값은 빌드 때 VITE_AAS_* 환경변수로 들어온다: 이미지는 Makefile → Dockerfile 빌드 인자, 로컬 빌드는 vite.config.ts 가 git 에서 채운다.
// 이미지 빌드에는 .git 이 들어가지 않으므로(.dockerignore) git 값은 빌드 인자로만 받는다.
import { t } from '@/i18n';

export interface BuildInfo {
  version: string;
  gitCommit: string;
  gitCommitDate: string;
  buildDate: string;
}

type Env = Record<string, string | boolean | undefined>;

export function buildInfo(env: Env = import.meta.env): BuildInfo {
  const s = (k: string) => (typeof env[k] === 'string' ? (env[k] as string).trim() : '');
  return {
    version: s('VITE_AAS_VERSION'),
    gitCommit: s('VITE_AAS_GIT_COMMIT'),
    gitCommitDate: s('VITE_AAS_GIT_COMMIT_DATE'),
    buildDate: s('VITE_AAS_BUILD_DATE'),
  };
}

const NA = 'N/A';

/** 커밋 해시 앞 8자. COP 과 같은 길이다 */
export const shortHash = (hash: string) => hash.slice(0, 8);

/** 버전 표기. 값이 없으면 N/A */
export const versionLabel = (info: BuildInfo) => (info.version ? `v${info.version.replace(/^v/, '')}` : `v${NA}`);

export interface VersionRow {
  label: string;
  value: string;
  /** 고정폭 글꼴로 보일 값(해시·날짜) */
  mono?: boolean;
}

/** 버전 정보 창의 표. COP 의 행에서 쿠버네티스 행과 문서 주소(에어갭 검사가 외부 주소를 막는다)를 뺐다 */
export function versionRows(info: BuildInfo, product: string): VersionRow[] {
  return [
    { label: t('about.product'), value: product },
    { label: t('about.version'), value: versionLabel(info), mono: true },
    { label: t('about.commitShort'), value: shortHash(info.gitCommit) || NA, mono: true },
    { label: t('about.commit'), value: info.gitCommit || NA, mono: true },
    { label: t('about.commitDate'), value: info.gitCommitDate || NA, mono: true },
    // 커밋 날짜만으로는 그 커밋 뒤에 다시 빌드한 이미지인지 알 수 없다
    { label: t('about.buildDate'), value: info.buildDate || NA, mono: true },
  ];
}
