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
| Other knobs | `temperature`, `top_k`, `cfg_musiccoca` per call; also `notes` (128 ints) and `drums` (1 int) conditioning — unused for now |

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
