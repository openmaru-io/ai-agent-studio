# 오피스 배경음악

분위기별 다섯 곡(스펙 2026-10-21-014). 목록과 기본 곡은 `tracks.ts` 에 있다. 라이선스 고지는 레포 루트의 `THIRD_PARTY_NOTICES.md`.

| 파일 | 곡 | 작곡·연주 | 라이선스 | 받은 주소 (2026-10-21) | 원본 SHA-256 |
|---|---|---|---|---|---|
| `menu-music.mp3` | Menu Music | mrpoly | CC0 | https://opengameart.org/sites/default/files/awesomeness.wav (페이지 https://opengameart.org/content/menu-music) | `8fa296fe15051c7030ae16f61f825c83ef50c9d25fa0a9dfc7bf7e38769e1ee7` |
| `chill-lofi.mp3` | Chill lofi inspired [loop edit] | omfgdude, 루프 편집 qubodup | CC0 | https://opengameart.org/sites/default/files/chilllofir-loop.ogg (페이지 https://opengameart.org/content/chill-lofi-inspired-loop-edit) | `ccaa02bb60310146f1fa3b1c70be0a5a57f0674b9c4944a22b85b0c03e932cdb` |
| `carefree.mp3` | Carefree | Kevin MacLeod | CC BY 4.0 | https://incompetech.com/music/royalty-free/mp3-royaltyfree/Carefree.mp3 | `8433b770a630d9b1594fd484442c677907ece899a4d149954cd2e74fd733e311` |
| `forest-ambience.mp3` | Forest Ambience | TinyWorlds | CC0 | https://opengameart.org/sites/default/files/Forest_Ambience.mp3 (페이지 https://opengameart.org/content/forest-ambience) | `9850aa1d0d5d66bd9c5daf8bb77c6d852e01f2f4de22f283bd5621e8bed13b75` |
| `goldberg-aria.mp3` | Goldberg Variations, BWV 988 — Aria | J. S. Bach, 연주 Kimiko Ishizaka | CC0 | https://archive.org/download/The_Open_Goldberg_Variations-11823/Kimiko_Ishizaka_-_01_-_Aria.mp3 | `6412a52127ef4c16b6cf7e4abc134ba3fbdb7419e542690135d5def80c09cfb4` |

## 다시 인코딩

원본의 음량이 -15.6 ~ -46.2 LUFS 로 제각각이라 모두 -16 LUFS(최대 -1.5 dBTP)로 맞추고 44.1kHz 스테레오 MP3 로 만들었다. 곡 내용은 고치지 않았다.
`loudnorm` 을 두 번 쓴다. 첫 번째로 재고, 두 번째에 잰 값을 넣어 선형으로 맞춘다(ffmpeg 9.0.2).

```sh
# 1) 재기: input_i·input_tp·input_lra·input_thresh·target_offset 을 얻는다
ffmpeg -i <원본> -af loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json -f null -
# 2) 맞추기. 비트레이트는 음악 128k, Forest Ambience 만 96k
ffmpeg -i <원본> -map_metadata -1 \
  -af "loudnorm=I=-16:TP=-1.5:LRA=11:measured_I=..:measured_TP=..:measured_LRA=..:measured_thresh=..:offset=..:linear=true,aresample=44100" \
  -ar 44100 -ac 2 -c:a libmp3lame -b:a 128k <파일>.mp3
```

| 파일 | 길이 | 크기 | 음량(다시 잼) | SHA-256 |
|---|---|---|---|---|
| `menu-music.mp3` | 47.7초 | 764,490 | -16.5 LUFS | `4476012e961441f6797ace82fb447f4f939f516981f2db9f0e9c56f2436e1c6e` |
| `chill-lofi.mp3` | 97.2초 | 1,556,523 | -16.5 LUFS | `8161ca851ccd810612a64f6a3729344b1d5a2487561a4a4a0e5761ba92f0e49a` |
| `carefree.mp3` | 205.1초 | 3,283,112 | -16.5 LUFS | `36967051b8fe69d17ef99e5672f849990c5eb2a6860089ee6ba69662f89ba019` |
| `forest-ambience.mp3` | 44.7초 | 537,644 | -16.4 LUFS | `bce0a4d14ca977baa6491ead5c44dd1f766b476de59ffe948175d28680b2833c` |
| `goldberg-aria.mp3` | 299.5초 | 4,793,198 | -16.5 LUFS | `06a85342bf6394a4e0c230bf1f0611b8526c15cc83ce958d5e51db71d1e7969d` |

이전 곡 `contemplation.mp3`(「Contemplation」, Joth, CC0)는 2026-10-21 에 뺐다. 그 곡은 -26.8 LUFS 를 음량 0.3 으로 틀어 너무 작았다(사용자 2026-10-21). 지금은 -16 LUFS 곡을 0.4 로 튼다(`ambient.ts` 의 `VOLUME`).
