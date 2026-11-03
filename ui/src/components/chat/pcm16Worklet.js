/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 스트리밍 받아쓰기(OMAI-1554, 계약 stt-stream-protocol.md §2)의 AudioWorklet: 마이크 소리를 16kHz·PCM16 LE·모노로 바꿔 약 100ms(1,600 표본)씩 보낸다.
// AudioWorklet 전역(AudioWorkletProcessor·registerProcessor·sampleRate)에서만 돈다 — import 없이 이 파일 하나로 끝나야 한다.
// 화면 묶음 안의 정적 파일로 낸다(sttStream.ts 가 ?url 로 부른다). 외부에서 받지 않는다(에어갭).
// 다운샘플은 구간 평균(상자 필터)이다. 비율이 정수가 아니어도(44.1kHz → 16kHz) 누적 값으로 표본 간격을 맞춘다.
/* global sampleRate */
const OUT_RATE = 16000;
const CHUNK = 1600;

class Pcm16Downsampler extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / OUT_RATE;
    this.acc = 0;
    this.sum = 0;
    this.n = 0;
    this.out = new Int16Array(CHUNK);
    this.len = 0;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.sum += ch[i];
      this.n += 1;
      this.acc += 1;
      if (this.acc >= this.ratio) {
        this.acc -= this.ratio;
        const v = Math.max(-1, Math.min(1, this.sum / this.n));
        this.sum = 0;
        this.n = 0;
        this.out[this.len++] = v < 0 ? Math.round(v * 0x8000) : Math.round(v * 0x7fff);
        if (this.len === CHUNK) {
          const buf = this.out.buffer;
          this.port.postMessage(buf, [buf]);
          this.out = new Int16Array(CHUNK);
          this.len = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('aas-pcm16', Pcm16Downsampler);
