# MRT2 streaming API — spike findings

Measured on an Apple M5, 16 GB RAM, `magenta-rt 2.0.2` (MLX backend),
2026-06-09. Verification script: `backend/scripts/spike_generate.py`.

## Entry point

`magenta_rt.mlx.system.MagentaRT2SystemMlxfn(size="mrt2_small")` — loads the
exported `.mlxfn` model (the format `mrt models download` fetches; no raw
checkpoint needed). The sibling `MagentaRT2System` builds the Python model
from raw safetensors checkpoints — not needed for inference.

```python
mrt = MagentaRT2SystemMlxfn(size="mrt2_small")   # ~1.2 s load + warm-up
emb = mrt.embed_style("disco funk")              # text → (768,) float32
wav, state = mrt.generate(style=emb, frames=25, state=state)
```

## Facts

| Property | Value |
| -------- | ----- |
| Sample rate / channels | 48 000 Hz, stereo |
| Frame | 40 ms (1 920 samples); `frames=25` ≈ 1 s |
| Output | `audio.Waveform`: `samples` shape `(T, 2)` float32 in [-1, 1] |
| Inter-chunk state | `generate()` returns `state` (list of mx.array); pass it back for seamless continuation. `None` = fresh start |
| Prompt change | Pass a different `style=` on the next `generate()` call with the same `state` — takes effect at that chunk boundary, audio stays continuous (verified by ear on `spike_transition.wav`) |
| Style embedding | `embed_style(str | Waveform)` → `(768,)` float32 (MusicCoCa). Embeddings are plain numpy vectors → weighted blends for prompt morph are `w*a + (1-w)*b` before `generate()` |
| RTF, mrt2_small | 1.86× real time (2 s audio in ~1.08 s), steady across chunks |
| Model storage | `~/Documents/Magenta/magenta-rt-v2` (override: `MAGENTA_HOME` env var); mrt2_small = 443 MB, shared resources = 1.3 GB |
| Other knobs | `temperature`, `top_k`, `cfg_musiccoca` per call; `notes` (128 ints) + `drums` (1 int) conditioning wired in issue #46/#48; `cfg_notes` / `cfg_drums` guidance scales exposed by issue #50 |

### Drum conditioning (`drums` + `cfg_drums`, issue #50)

`generate()` takes `drums` (`-1` masked / `0` no-drum / `1` play-drum) and a
separate `cfg_drums` scale in `[-1.0, 7.0]`. `cfg_drums` is **not** applied as
textbook classifier-free guidance — it is *discretised* (1.0-step, `max_bin`
8) into a **learned conditioning token** (`discretize_cfg`,
`mlx/system.py`), so its response is whatever the model learned, not the
`uncond + w·(cond−uncond)` formula.

**How the reference (`magenta/magenta-realtime`) uses it** — the source of
truth LSDJ follows:

- A **binary `drumless` toggle** (`examples/.../Settings.tsx`, `core/src/
  mlx_engine.cpp`): on → `drums=0` (suppress), off → `drums=-1` (auto/masked).
  It **never uses `drums=1` (force)** — the reference has no "force drums".
- A separate **`cfgdrums` knob** ("Drums Adherence"): range **`[0, 5]`**
  (`CFG_MIN`/`CFG_MAX`, shared by all three CFG knobs), step 0.1, default
  **`DEFAULT_CFG_DRUMS = 4.0`**. Some apps (`jam`) hide the knob entirely and
  expose only the toggle.

LSDJ mirrors this: a binary suppress/auto toggle, strength default **4.0**
(`DEFAULT_DRUM_STRENGTH`), slider `[0, 5]` step 0.1.

**Measured on `mrt2_small`, style "warm disco funk"** (percussive spectral
flux, kick 40-150 Hz / hats >4 kHz), corroborating the reference bounds:

- **The library default (1.0) barely suppresses** — effectively `auto` on a
  hot stream.
- **The useful range is ~3-5, non-monotonic**: `cfg_drums=5` gives the
  strongest hat/kick suppression, `3` close; **`7` is *worse* than `5`**
  (out of distribution) — which is exactly why the reference caps at 5.
- **Negative `cfg_drums` does NOT invert** (measured): suppress at `-1` still
  removes drums, force at `-1` still adds them. The flag owns the direction;
  `cfg_drums` only modulates. Negatives are simply not exposed (auto already
  covers the masked `-1` case).
- **Suppression is context-dominated on a transition**: flipping suppress on a
  stream that has been drumming takes ~10-30 s to fully thin as the drummed
  context rolls out of the window; from a fresh stream it bites within a few
  chunks.

### Sampling / guidance operating point (issue #50 reference audit)

The `magenta_rt` **library constructor defaults** differ from what every
`magenta-realtime` **example app** ships (`defaultParams.ts`). LSDJ historically
inherited the library floor by never setting these; it now adopts the reference
app values in `engine.py` (`MagentaRT2SystemMlxfn(...)`), so generation matches
the tuned MRT2 experience:

| Param | Library default | Reference app | LSDJ now |
| ----- | --------------- | ------------- | -------- |
| `temperature` | 1.3 | 1.1 | **1.1** |
| `top_k` | 40 | 50 | **50** |
| `cfg_musiccoca` (prompt adherence) | 3.0 | 1.6 | **1.6** |
| `cfg_notes` (note adherence) | 1.0 | 2.4 | **2.4** |
| `cfg_drums` | 1.0 | 4.0 | per-deck, default **4.0** (drum-sit) |

`cfg_musiccoca` affects all generation; `cfg_notes` only bites while
note-steering (issue #48). These are set once on the system, not per call.

**Note masking (matches the reference).** Non-held pitches are filled with
`-1` (masked) so the model plays the held chord **and freely embellishes
around it** — the reference `populate_condition_tokens` behaviour at its
`unmask_width=0` default (`build_multihot`, `src-tauri/src/midi/notes.rs`). An
earlier LSDJ cut forced them `0` (off), forbidding non-held pitches — that read
as stiff/sparse and was dropped for the reference's freer masking. The
reference's `unmask_width` knob (an off-band of radius *w* around held notes,
`w=127` = all off) is not exposed; a future "harmony freedom" control could add
it.

## Implications for the deck pipeline

- **Chunk size is ours to choose** (any multiple of 40 ms per `generate()`
  call). Decks use 25 frames (1 s): keeps prompt-change latency low while
  per-frame cost dominates, so RTF is unaffected.
- The generation loop is synchronous and CPU/GPU-bound → it lives in a worker
  process; the controller never calls `magenta_rt` (ADR-0002).
- **PCM wire format (WebSocket binary frames):** interleaved stereo float32
  little-endian, 48 000 Hz — exactly `Waveform.samples.tobytes()`, and what
  Web Audio consumes natively. 1 s chunk = 384 000 bytes ≈ 3.1 Mbit/s/deck.
- `embed_style` is cheap relative to generation; embedding on prompt change
  inside the worker loop is fine.

## Open (not blocking M1)

- BPM steerability via prompt text — assess during M4.
- `mrt2_base` RTF on this machine (model not downloaded; M5 likely < 1× —
  per-deck model choice lands in M3 and warns via buffer health anyway).
