# 0028. Stable Audio 3 LoRA finetunes via the MLX path

- **Status:** Accepted
- **Date:** 2026-06-27
- **Deciders:** Daniel Peter
- **Extends:** ADR-0012

## Context

The in-app model manager (#43) installs the *official* models. Users also want
to bring **custom Stable Audio 3 finetunes**. The spike for #44
([`docs/spike-sa3-lora.md`](../spike-sa3-lora.md)) investigated whether that is
possible on our runtime and built a proof-of-concept; two of its conclusions are
architecturally significant and recorded here.

The facts that force the decision:

- SA3 supports **LoRA** finetuning, producing a small adapter (~50–300 MB). LSDJ
  runs SA3 through the **MLX** fork as a spawned subprocess (ADR-0012), whose CLI
  had **no LoRA support** — so a valid SA3 LoRA could not be loaded by our
  runtime at all.
- The adapter is distributed as **`.safetensors`** (data-only). The issue feared
  a pickle `.ckpt` (`torch.load` → arbitrary code execution); that fear does not
  apply to the modern artifact. Both the SA3-native trainer
  (`scripts/train_lora.py`) and the HuggingFace `peft` ecosystem save
  safetensors; a legacy pickle `.ckpt` branch exists only in *PyTorch's* loader,
  which our MLX runtime never invokes.
- The MLX DiT is built from named `nn.Linear`/`nn.Conv1d` submodules whose names
  match the PyTorch layer names a LoRA targets, so a LoRA delta can be merged
  into the DiT weights **at load time** — no runtime parametrization needed
  (spike, §"MLX feasibility"). The PoC merged a real public adapter
  (`motiftechnologies/stable-audio-3-maqam-lora`, PEFT, medium) into the medium
  DiT and produced measurably different audio through LSDJ's own subprocess path.

Magenta RT 2 finetuning is still "coming soon" upstream; it is out of scope here
and tracked by the spike's revisit trigger.

## Decision

- **Accept LoRA adapters as `.safetensors` only.** The import path never calls
  `torch.load`; pickle-backed files (`.ckpt`/`.pt`/`.pth`/`.bin`) are **refused
  outright** with a clear error. Both safetensors conventions are read: SA3-native
  (adapter config in the file's metadata) and PEFT (config in a sibling
  `adapter_config.json`). An adapter is validated structurally — recognised keys,
  inferable rank, and shapes that match the base (non-matching layers are skipped,
  not forced) — before it is applied.
- **LoRA rides the existing spawned subprocess; it is merged at load time.**
  ADR-0012's "spawn, never import" holds unchanged: a new `--lora` /
  `--lora-strength` flag on `sa3_mlx.py` folds each adapter's delta into the DiT
  weight dict before the model is materialised. There is no per-step cost and a
  bit-exact bypass at `--lora-strength 0`. The merge math covers **all nine SA3
  adapter types** (lora, dora-rows/cols, bora, and the four `-xs` variants) and
  mirrors the PyTorch reference; it lives in the checkout
  (`optimized/mlx/models/defs/lora_merge.py`) and is intended as an **upstream
  contribution** to `Stability-AI/stable-audio-3`.
- **A LoRA is a small artifact that rides a base.** Many LoRAs map to one base
  model; deltas accumulate against the original weight, so stacking is
  order-independent for linear LoRA. This is a different lifecycle from a full
  model and the follow-up importer (the #43-style registry/UI) is built around it.

## Consequences

- **Trust posture is settled and low-risk.** An imported adapter cannot execute
  code — the only residual surface is numeric (a malformed adapter yields bad
  audio or a load error, not RCE). This is a materially lower bar than importing
  an arbitrary full model, and lets the follow-up importer adopt the #43 "any
  source, warn + validate" stance without a sandbox.
- **Path 1 is cheap.** No PyTorch re-export and no multi-GB artifact per finetune
  (the rejected Path 2): the adapter merges in seconds at load, in place on the
  weight dict, so peak generation memory is unchanged from ADR-0012.
- **We carry upstream-track code.** The MLX fork is un-versioned and pinned
  (`bccf5b7`, `sa3-pin.json`); a rebase could rename layers and break the merge's
  name mapping. Mitigated by mirroring the converter's name remap, skipping
  unknown layers, the pinned commit, and the spike's captured patch. If upstream
  lands native MLX LoRA, we drop ours and bump the pin (ADR-0012's upgrade path).
- **`-xs` adapters recompute SVD bases at load** (the frozen bases are not stored
  in the checkpoint). On the medium DiT this is the heaviest case; flagged for the
  follow-up build issue to measure and, if needed, cache.
- **Base/adapter matching is enforced at import, not silently.** A medium adapter
  needs the medium DiT; the importer validates the pairing and the runtime skips
  non-matching layers rather than corrupting weights.
- Wiring `--lora` into `backend/lsdj/sa3.py` and the `/api/generate` contract, and
  the registry/UI, are **not** done here — they are the gated follow-up build
  issue (#66).

## Alternatives considered

- **Merge LoRA into the base in PyTorch, then re-export the MLX npz (Path 2)** —
  avoids touching MLX inference, but needs the full torch stack plus a re-export
  per finetune and produces a fresh multi-GB optimized model each time. Heavier in
  effort, disk, and lifecycle; rejected.
- **Wait for upstream native MLX LoRA (Path 3)** — no public timeline; would block
  the feature indefinitely. Recorded as a revisit trigger instead.
- **Accept pickle `.ckpt` with a scanner or sandbox** — adds complexity and
  residual risk for no benefit: the modern artifact is already safetensors, so
  refusing pickle costs users nothing real.
- **Runtime LoRA parametrization (mirror `torch.nn.utils.parametrize`)** — adds a
  per-step forward cost and bookkeeping; merge-at-load is simpler and the DiT is
  loaded fresh per generation anyway (ADR-0012), so there is nothing to amortise.

<!-- Status values: Proposed | Accepted | Rejected | Deprecated |
     Superseded by ADR-NNNN -->
