# Issue #66 — SA3 LoRA adapter manager: hardware/UX checklist

Issue #66 builds the production importer for Stable Audio 3 LoRA finetunes on
top of the spike's merge-at-load runtime (ADR-0028, `docs/spike-sa3-lora.md`):
a `sa3-loras/<base>/<slug>/` registry in the app data dir owned by the Rust
shell, a `lora` field on `/api/generate` that rides `--lora`/`--lora-strength`
into the pinned fork's CLI, adapter pickers in the generate surfaces, and a
manager section with import (HuggingFace repo id or local `.safetensors`) and
in-app delete.

Unit tests cover name/path trust boundaries, the safetensors-header
validation (pickle refusal, convention detection, base inference), the exact
argv, the `/api/generate` contract, and the picker/manager UI. What follows
needs a real machine with the SA3 checkout warmed — the sandbox cannot run
the shell or MLX. The public PEFT adapter the spike used
(`motiftechnologies/stable-audio-3-maqam-lora`, medium base) is the reference
adapter throughout.

## Import

- [ ] Settings drawer → Model library shows the **LoRA adapters** section
      with "No adapters installed" and an **Open folder** that reveals
      `~/Library/Application Support/LSDJai/sa3-loras`.
- [ ] Enter `motiftechnologies/stable-audio-3-maqam-lora` and Install: fetch /
      download / install progress shows, then the adapter lists as
      `stable-audio-3-maqam-lora` — **Medium DiT (tracks)**, ~200 MB.
- [ ] Cancel works mid-download and surfaces as a clean stop, not an error.
- [ ] Import the same adapter's `adapter_model.safetensors` via **Import
      file…** (download it separately first): refused as already installed
      when the slug collides; imports cleanly under a different folder name.
- [ ] A pickle file (`.ckpt`/`.pt` — rename any small file) is refused by the
      file picker's filter, and forcing a path at it (e.g. via the HF id of a
      pickle-only repo) yields the explicit pickle refusal, not a generic
      error.
- [ ] A non-LoRA `.safetensors` (e.g. a Magenta `*_state.safetensors`) is
      refused with "not a recognised SA3 LoRA".

## Generate

- [ ] Media Explorer → Generate, engine **Track (SA3 medium)**: the LoRA
      picker offers the Maqam adapter; the pad engines do NOT offer it (wrong
      base), and the deck pad panels don't either.
- [ ] Compose two tracks from the same prompt + fixed conditions, adapter
      None vs Maqam at ×1: audibly different in character (the spike measured
      a difference as large as the signal itself).
- [ ] Strength ×0.25 vs ×1.5 audibly scales the adapter's influence.
- [ ] Backend log (the generation server's stderr) shows the CLI's
      `lora: merged 168 layer(s) from 1 adapter(s)` line during a LoRA take.
- [ ] Magenta engine ignores the adapter path entirely (no `lora` in its
      render request).

## Bypass (ADR-0028's bit-exact claim)

- [ ] Two tracks with the same prompt and `seed`, adapter **None** vs Maqam at
      **×0**: byte-identical WAVs (compare SHA-256). Seed rides via the
      `/api/generate` `seed` field (issue #54) — use
      `scripts/verify_sa3_surface.py`-style direct calls if the UI has no seed
      control.

## Registry lifecycle

- [ ] Quit and relaunch: the adapter is still listed (the registry is the
      directory layout — nothing else to persist).
- [ ] Delete from the manager: the row disappears, the folder is gone, and an
      in-flight picker choice falls back to **None** on the next generate.
- [ ] Drop a valid adapter folder in by hand (`sa3-loras/medium/<name>/` with
      its `.safetensors`): the watcher lists it live, and it generates.

## Wrong-base refusal

- [ ] POST `/api/generate` directly with `kind: "sfx"` and the medium
      adapter's name: 422 naming the base mismatch (the UI never offers the
      combination; the boundary still refuses it).
