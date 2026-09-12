# ADR-0020: Local segmentation runs BiRefNet Dynamic on PyTorch/MPS

- Status: Accepted (from spec #159 ticket #162)
- Supersedes: ADR-0009 (BiRefNet HR through `onnxruntime-node` / CoreML)

## Context

The pinned engine behind the MatteEngine seam was BiRefNet HR through
`onnxruntime-node` (CoreML on Apple silicon, warned CPU fallback). That pin
became the wrong tool for the work Matting now does:

- A fresh `ply matte` took about six minutes (weight read, hash, CoreML
  compile, one image, process exit).
- The same engine punched holes in white interiors (Luigi V3's gloves and
  hat) — genuine subject pixels cut away.
- A throwaway local comparison (gitignored `out/matting-comparison/`,
  FOLLOWUP.md, frozen 16-image set) qualified BiRefNet Dynamic on
  PyTorch/MPS: interiors stay opaque, genuine openings stay open, fresh
  whole-command medians are ~4 s (Luigi 4.12 s, portrait 4.52 s, mug
  3.81 s), weights are 444 MB MIT, and cached inference runs with the
  network denied. Kenny reviewed the evidence and selected this pin.

## Decision

The pinned segmenter in `src/segment.ts` is **BiRefNet Dynamic**
(`ZhengPeng7/BiRefNet_dynamic`, MIT) at immutable revision
`280306042f57b7a33854319da62fd86aaa89ec4c` (never `main`), weights
sha-256 `e3d2e4884e51ff30f0cd630edc6b1e41b06b7f23a0a2a5169f7b7cb33a711c2d`,
running on **PyTorch/MPS** in a **one-shot pinned `uv` Python process**
(`scripts/matte-birefnet-dynamic.py`, exact `==` hashed lockfile). The
published engine identity names the revision:
`local-segmentation:birefnet-dynamic@280306042f57b7a33854319da62fd86aaa89ec4c`;
a successful inference records backend `mps`.

- **One engine.** Dynamic+MPS replaces HR ONNX/CoreML outright. The HR
  export script and the `onnxruntime-node` dependency are retired. No dual
  stack: keeping both would split qualification evidence and leave the
  six-minute path one flag away.
- **Preprocessing is the US-002 contract, not a square resize.**
  Aspect-preserving downscale with bilinear only when
  `max(width, height) > 2048`; replicate-border pad right/bottom to
  multiples of 32 (Swin patch grid); crop the padding from the predicted
  alpha *before* bilinear resize back to the original size. Aligned sizes
  are a pad-free, resample-free no-op. The numeric contract is locked in
  TypeScript without weights (`src/dynamic-geometry.ts`,
  `test/segment-geometry.test.ts`); production pixel preprocessing lives
  only in the Python script. `composeMatte` still applies the mask as alpha
  onto unchanged source RGB.
- **MPS is required for inference.** TypeScript preflight verifies the
  weights file and sha-256 (streamed, no Python launched); the single
  inference process asserts MPS is the running device before weights load
  and before any mask is written. Missing weights, wrong hash, or no MPS
  fail loud with the pin, the backend requirement, and the fetch command —
  before inference and before publish. No CPU fallback. No CoreML fallback.
  No silent device switch (the process reports its observed device; anything
  but `mps` refuses the matte). There is no second `uv --check` process:
  that would double cold start and miss the seconds-level bar.
- **Offline after cache.** The process never contacts the Hub at matte time
  (`local_files_only`, `HF_HUB_OFFLINE=1`); architecture code is warmed once
  (`--warm-cache`) and weights fetched once. Kernel-denial with a negative
  control remains the offline proof.
- **Timing scope `engine` is always fresh.** The figure covers the one and
  only inference process — startup, weight load, inference, mask write. It
  must never be mixed with a warm-loaded figure under the same scope.
- **No daemon.** A fresh command is already seconds-level; #130 stays
  answered, not implemented. No Neural Engine path, no ONNX backup.

## Consequences

- `models/birefnet-dynamic.safetensors` (~444 MB) replaces
  `models/birefnet-hr-fp16.onnx` in the gitignored cache; the old file can
  be deleted. Fetch is `curl` of the pinned resolve URL plus one
  `--warm-cache` for the (small) architecture code — both documented in the
  missing-weights message and the README.
- The default suite never launches Python and never loads weights (fake
  engines; static script-shape checks; numeric geometry tests). Live
  qualification is `PLY_RUN_LIVE=1`, skips without cache, and inspects
  actual matted pixels including a non-square fixture.
- Installing the pin remattes nothing: existing mattes, Layers, content
  blobs, Renders, and `examples/thumbnail-luigi-go/` stay byte-identical.
  SchemaVersion 1 records stay readable.
- Swapping the segmenter again remains a pin change behind the same seam,
  with the same obligations: loud preflight, offline after cache, live
  pixels before merge.
