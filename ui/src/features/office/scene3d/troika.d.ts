/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

declare module 'troika-three-text' {
  import type { Mesh } from 'three';
  /** 글자 메시. 속성을 바꾼 뒤 sync() 하면 글꼴을 받아(필요하면) 다시 그린다. */
  export class Text extends Mesh {
    sync(callback?: () => void): void;
    dispose(): void;
  }
  export function configureTextBuilder(config: { unicodeFontsURL?: string; defaultFontURL?: string; sdfGlyphSize?: number; useWorker?: boolean }): void;
}
