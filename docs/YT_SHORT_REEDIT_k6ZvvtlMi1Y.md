# YT Short re-edit — "Se fue la luz, pero se cuela café…" (k6ZvvtlMi1Y)

Published 2026-07-04 · 44s · https://youtube.com/shorts/k6ZvvtlMi1Y
Analytics-driven re-edit plan executed 2026-07-04 (first-day retention review).

## Why (analytics summary)

- **Hook is great:** 130% retention in the first seconds (viewers rewind it). Keep intact.
- **Dip at 4–7s (110% → 60%):** the 4s moka-pot brew shot + slow bedroom pan stall the pace
  right after the hook pays off.
- **Slide after 10s (ends ~10%):** the unboxing sequence at 0:12–0:17 breaks the
  "blackout life keeps going" narrative and kills momentum mid-video.
- **Target:** punchier ~20s cut that keeps the payoff shots and lands on the sorteo card.

## Edit decision list (source timestamps → new cut, ≈20s)

| # | Source | Len | Shot | Note |
|---|--------|-----|------|------|
| 1 | 0:00–0:04 | 4s | Moka pot on power station + coffee grounds | The 130% hook — untouched |
| 2 | 0:04–0:06 | 2s | Brew gurgling, display 444W | Trimmed from 4s → 2s |
| 3 | 0:17–0:20 | 3s | Egg sizzling on griddle | New reason-to-stay right after coffee payoff |
| 4 | 0:21–0:23 | 2s | Display 1519W | Power proof |
| 5 | 0:24–0:26 | 2s | Rice cooker goes in | Third appliance, keeps rhythm |
| 6 | 0:31–0:33 | 2s | Window AC running at 67° | The "even the AC" beat |
| 7 | 0:35–0:37 | 2s | Battery still 64% @ 1511W | Endurance proof |
| 8 | 0:40–0:43 | 3s | Sorteo end card | CTA, orange transition (0:38–0:40) dropped |

**Cut entirely:** unboxing 0:12–0:17 (save for its own dedicated Short), bedroom pan
0:08–0:10, 61%/530W display 0:10–0:12, 240W display 0:28–0:31, transition 0:38–0:40.

### ffmpeg (frame-precise, run against the original source file)

```bash
ffmpeg -i source.mp4 -filter_complex "\
[0:v]split=8[v1][v2][v3][v4][v5][v6][v7][v8];[0:a]asplit=8[a1][a2][a3][a4][a5][a6][a7][a8];\
[v1]trim=0:4,setpts=PTS-STARTPTS[cv1];[a1]atrim=0:4,asetpts=PTS-STARTPTS[ca1];\
[v2]trim=4:6,setpts=PTS-STARTPTS[cv2];[a2]atrim=4:6,asetpts=PTS-STARTPTS[ca2];\
[v3]trim=17:20,setpts=PTS-STARTPTS[cv3];[a3]atrim=17:20,asetpts=PTS-STARTPTS[ca3];\
[v4]trim=21:23,setpts=PTS-STARTPTS[cv4];[a4]atrim=21:23,asetpts=PTS-STARTPTS[ca4];\
[v5]trim=24:26,setpts=PTS-STARTPTS[cv5];[a5]atrim=24:26,asetpts=PTS-STARTPTS[ca5];\
[v6]trim=31:33,setpts=PTS-STARTPTS[cv6];[a6]atrim=31:33,asetpts=PTS-STARTPTS[ca6];\
[v7]trim=35:37,setpts=PTS-STARTPTS[cv7];[a7]atrim=35:37,asetpts=PTS-STARTPTS[ca7];\
[v8]trim=40:43,setpts=PTS-STARTPTS[cv8];[a8]atrim=40:43,asetpts=PTS-STARTPTS[ca8];\
[cv1][ca1][cv2][ca2][cv3][ca3][cv4][ca4][cv5][ca5][cv6][ca6][cv7][ca7][cv8][ca8]concat=n=8:v=1:a=1[v][a]" \
-map "[v]" -map "[a]" -c:v libx264 -crf 18 -preset slow -c:a aac short_20s_recut.mp4
```

## Sorteo engagement pack (recommendation #3)

Reply fast (first 24–48h weigh most). Spanish first — the audience is the Miami/US
Cuban diaspora. **USA-only shipping; never promise shipping outside the USA.**

**Pinned comment (post now):**
> ☕⚡ SORTEO ACTIVO 🎉 Comenta aquí: ¿qué es lo PRIMERO que enchufarías tú cuando se va
> la luz? 👇 El cafecito no se negocia 😄 #Oiikon

**Reply to the "best content" comment:**
> ¡Gracias mi gente! 🙏 Se fue la luz pero el cafecito no se negocia ☕⚡ ¿Ya dejaste tu
> comentario pa'l sorteo? 👀

**Template — "how do I enter?":**
> ¡Fácil! Deja tu comentario aquí y síguenos. Anunciamos el ganador en la página 🎁
> (Envío gratis a los 48 estados de USA 🇺🇸)

**Template — price question:**
> ¡Buenas! 🙌 Te paso precio y modelos por WhatsApp para atenderte mejor — link en el
> perfil. Hay financiamiento disponible 💳

**Template — skeptical / "does it really run an AC?":**
> ¡Como lo ves en el video! 😄 AC de ventana a 67°, cafetera y arrocera — y la batería
> todavía en 64%. Si quieres los specs completos escríbenos por WhatsApp ⚡

## How to finish the cut (pick one)

The source file is in Google Drive (`video-output-CDF5A44D…-1.MOV`, 42.8 MB, 2026-07-02).
Claude's cloud session cannot fetch video bytes (network allowlist) and Drive's MCP
download caps at 10 MB, so the physical cut needs one of:

1. **ffmpeg locally** — run the command above against the MOV. Frame-precise, best quality.
2. **Phone edit (CapCut / YT create)** — apply the 8-row EDL table above: five deletions,
   two trims, done in ~2 minutes.
3. **Hand it back to Claude** — export/compress the source to an MP4 **under 10 MB**
   (720×1280 is fine), drop it in Drive, and tell Claude "cut it" — it can then download
   via the Drive connector, execute this EDL with ffmpeg, and return the finished file.

Publish the recut as a **new** Short (YouTube can't swap a published video file). Leave
the original up — it's day-1 and still in discovery; judge it after 48–72h.

## Duration takeaway (recommendation #2)

For lifestyle/DIY snippets, target **20–25s**: hook (0–4s) → 3–4 quick payoff beats
(2–3s each) → CTA card (3s). Save unboxings for their own dedicated Short.
