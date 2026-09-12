#!/usr/bin/env python3
# /// script
# requires-python = ">=3.12,<3.14"
# dependencies = [
#   "torch==2.14.0",
#   "torchvision==0.29.0",
#   "transformers==5.17.0",
#   "safetensors==0.8.0",
#   "pillow==12.3.0",
#   "numpy==2.5.3",
#   "huggingface-hub==1.31.0",
#   "timm==1.0.29",
#   "einops==0.8.2",
#   "kornia==0.8.3",
# ]
# ///
"""One-shot BiRefNet Dynamic matting for Ply (spec #159 ticket #162).

The single production matting engine behind `src/segment.ts`: given a local
PNG, predict the subject matte on PyTorch/MPS and write a grayscale mask PNG
at the input's own size. One process per matte — no daemon, no warm session.

Preprocessing is the US-002 contract (the qualified FOLLOWUP.md shape):
  1. aspect-preserving downscale with BILINEAR only if max(w,h) > 2048;
  2. replicate-border pad right/bottom to multiples of 32 (Swin patch grid);
  3. inference on the padded tensor;
  4. crop the padding from the predicted alpha BEFORE any resize back;
  5. BILINEAR resize of the cropped alpha to the original size (skipped when
     identical — aligned inputs are a pad-free, resample-free no-op).
Source RGB is never touched here; the TypeScript caller applies the mask as
alpha onto the original pixels (`composeMatte`).

Backend discipline: MPS is asserted FIRST, before weights load and before any
mask is written. Anything but MPS is a loud nonzero failure — there is no CPU
or CoreML fallback and no silent device switch. The observed device is
reported on stdout (`device_observable`), which the caller records.

Offline discipline: architecture code and weights come from the local caches
only (`local_files_only`, `HF_HUB_OFFLINE=1` in the caller's env). A first run
on a fresh machine needs network once: fetch the weights (see the caller's
fix-it message), then warm the architecture cache with `--warm-cache`.

Protocol: exactly one JSON object on stdout. Exit 0 with
`{"ok": true, "mask": ..., "device_observable": "mps", ...}` on success;
exit 1 with `{"ok": false, "error": ...}` (plus the message on stderr) on any
failure. Nothing is written on failure.

Usage:
  uv run --locked --script scripts/matte-birefnet-dynamic.py \
    --weights models/birefnet-dynamic.safetensors \
    --input photo.png --out-mask /tmp/mask.png
  uv run --locked --script scripts/matte-birefnet-dynamic.py --warm-cache
"""

import argparse
import hashlib
import json
import sys
import time
from pathlib import Path
from typing import NoReturn

# Immutable Hugging Face revision. Never follow `main` — a floating tip can
# execute different remote code (trust_remote_code) and produce a mask the
# runtime pin then cannot vouch for.
MODEL_REPO = "ZhengPeng7/BiRefNet_dynamic"
MODEL_REVISION = "280306042f57b7a33854319da62fd86aaa89ec4c"
# The pinned weights identity (spec #159 US-001, ADR-0020). Mirrors
# DYNAMIC_SEGMENTER.sha256 / .source in src/segment.ts — never drift one
# without the other (test/matting-prereq-failures.test.ts binds them).
WEIGHTS_SHA256 = "e3d2e4884e51ff30f0cd630edc6b1e41b06b7f23a0a2a5169f7b7cb33a711c2d"
WEIGHTS_SOURCE = f"https://huggingface.co/{MODEL_REPO}/resolve/{MODEL_REVISION}/model.safetensors"
MAX_SIDE = 2048
PAD_MULTIPLE = 32


def parse() -> argparse.Namespace:
    ap = argparse.ArgumentParser()
    ap.add_argument("--weights", default=None)
    ap.add_argument("--input", default=None)
    ap.add_argument("--out-mask", default=None)
    ap.add_argument("--meas", default=None,
                        help="diagnostic only: write the JSON record here too (production never passes this)")
    ap.add_argument("--max-side", type=int, default=MAX_SIDE,
                        help="diagnostic only: production always uses the default 2048 locked US-002 cap")
    ap.add_argument("--warm-cache", action="store_true")
    return ap.parse_args()


def fail(msg: str) -> NoReturn:
    rec = {"ok": False, "error": msg}
    print(json.dumps(rec))
    print(f"matte-birefnet-dynamic: {msg}", file=sys.stderr)
    raise SystemExit(1)


def assert_mps(torch: object, weights: str) -> str:
    """MPS must be the running device. Checked before weights load and before
    any mask is written — a CPU-only run is a failure, not a warning.

    The refusal names the fix (expected weights path, pin, fetch command,
    MPS requirement — spec #159 US-006): it is the process's own error text,
    so the TypeScript caller surfaces it verbatim."""
    import torch as t

    assert torch is t
    built = t.backends.mps.is_built()
    avail = t.backends.mps.is_available()
    if not (built and avail):
        from pathlib import Path as _Path

        _parent = str(_Path(weights).parent) if weights else ""
        parent = _parent if _parent not in ("", ".") else "models"
        fail(
            "MPS is required for local matting but is not the running device "
            f"(mps built: {built}, available: {avail}). "
            "There is no CPU or CoreML fallback — run on Apple Silicon with a "
            "PyTorch MPS build.\n"
            f"Expected weights: {weights}\n"
            f"sha-256: {WEIGHTS_SHA256}\n"
            f"Fetch the exact pinned bytes at revision {MODEL_REVISION}:\n"
            f"  {WEIGHTS_SOURCE}\n"
            f"  mkdir -p {parent}\n"
            f"  curl -L --fail -o {weights} {WEIGHTS_SOURCE}\n"
            "Then warm the pinned architecture cache once (small, needs network once):\n"
            "  uv run --locked --script scripts/matte-birefnet-dynamic.py --warm-cache"
        )
    return "mps"


def load_model(weights: str):  # type: ignore[no-untyped-def]
    import torch
    from transformers import AutoModelForImageSegmentation

    try:
        model = AutoModelForImageSegmentation.from_pretrained(
            MODEL_REPO,
            revision=MODEL_REVISION,
            trust_remote_code=True,
            local_files_only=True,
        )
    except Exception as e:
        fail(
            f"the pinned architecture ({MODEL_REPO}@{MODEL_REVISION}) is not in the "
            f"local cache and no network fetch is attempted at matte time: {e}. "
            "Warm it once while online: "
            "`uv run --locked --script scripts/matte-birefnet-dynamic.py --warm-cache`."
        )
    model.float()
    from safetensors.torch import load_file

    try:
        sd = load_file(weights, device="cpu")
    except Exception as e:
        fail(f"the weights file cannot be read ({weights}): {e}")
    try:
        model.load_state_dict(sd, strict=True)
    except Exception as e:
        fail(
            f"the weights at {weights} do not load into {MODEL_REPO}@{MODEL_REVISION} "
            f"(strict): {str(e)[:400]}"
        )
    return model


def preprocess_with_pad(orig_rgb, max_side: int = MAX_SIDE):  # type: ignore[no-untyped-def]
    """Genuine replicate padding; aspect preserved. Mirrors the qualified
    adapter and `src/dynamic-geometry.ts` (same truncation, same remainders)."""
    import torch
    import torch.nn.functional as F
    from torchvision import transforms

    ow, oh = orig_rgb.size
    scale = min(1.0, max_side / max(ow, oh))
    nw0, nh0 = max(1, int(ow * scale)), max(1, int(oh * scale))
    if (nw0, nh0) != (ow, oh):
        from PIL import Image

        work = orig_rgb.resize((nw0, nh0), Image.BILINEAR)
        scaled = True
    else:
        work = orig_rgb
        scaled = False
    pw = (-nw0) % PAD_MULTIPLE
    ph = (-nh0) % PAD_MULTIPLE
    t = transforms.ToTensor()(work)
    mean = torch.tensor([0.485, 0.456, 0.406]).view(3, 1, 1)
    std = torch.tensor([0.229, 0.224, 0.225]).view(3, 1, 1)
    t = (t - mean) / std
    if pw or ph:
        t = F.pad(t, (0, pw, 0, ph), mode="replicate")
    nwp, nhp = nw0 + pw, nh0 + ph
    assert nwp % PAD_MULTIPLE == 0 and nhp % PAD_MULTIPLE == 0
    meta = {
        "ow": ow, "oh": oh, "nw0": nw0, "nh0": nh0,
        "pw": pw, "ph": ph, "nwp": nwp, "nhp": nhp,
        "scale": scale, "scaled": scaled,
    }
    return t.unsqueeze(0), meta


def unpad_and_resize_alpha(alpha_pad_pil, meta, ow: int, oh: int):  # type: ignore[no-untyped-def]
    """Crop padding FIRST (top-left to pre-pad dims), then BILINEAR back to
    the original size — skipped when identical, so aligned inputs are never
    resampled as a side effect."""
    from PIL import Image

    nw0, nh0 = meta["nw0"], meta["nh0"]
    w, h = alpha_pad_pil.size
    if (w, h) != (meta["nwp"], meta["nhp"]):
        fail(f"predicted alpha is {w}x{h}, not the padded {meta['nwp']}x{meta['nhp']}")
    cropped = alpha_pad_pil.crop((0, 0, nw0, nh0))
    if (nw0, nh0) == (ow, oh):
        return cropped
    return cropped.resize((ow, oh), Image.BILINEAR)


def warm_cache() -> None:
    import torch  # noqa: F401 (warms the same interpreter that mattes)
    from transformers import AutoModelForImageSegmentation

    model = AutoModelForImageSegmentation.from_pretrained(
        MODEL_REPO, revision=MODEL_REVISION, trust_remote_code=True
    )
    _ = model
    print(json.dumps({"ok": True, "cached": f"{MODEL_REPO}@{MODEL_REVISION}"}))


def main() -> None:
    a = parse()
    if a.warm_cache:
        warm_cache()
        return
    if not a.weights or not a.input or not a.out_mask:
        fail("--weights, --input, and --out-mask are all required (or pass --warm-cache)")
    t0 = time.time()
    import torch
    from torchvision import transforms
    from PIL import Image

    # Backend first: before weights load, before any mask is written.
    device = assert_mps(torch, a.weights)
    weights = a.weights
    if not Path(weights).is_file():
        fail(f"the weights file is not there: {weights}")
    model = load_model(weights)
    model.to(device).eval()
    try:
        orig = Image.open(a.input).convert("RGB")
    except Exception as e:
        fail(f"the input cannot be read as an image ({a.input}): {e}")
    ow, oh = orig.size
    inp, meta = preprocess_with_pad(orig, a.max_side)
    inp = inp.to(device)
    torch.set_float32_matmul_precision("high")
    try:
        with torch.no_grad():
            preds = model(inp)[-1].sigmoid().cpu()
    except Exception as e:
        fail(f"inference failed on {device}: {e}")
    pred = preds[0].squeeze()
    alpha_pad = transforms.ToPILImage()(pred)
    alpha = unpad_and_resize_alpha(alpha_pad, meta, ow, oh).convert("L")
    if alpha.size != (ow, oh):
        fail(f"output size {alpha.size} != input {(ow, oh)}")
    Path(a.out_mask).parent.mkdir(parents=True, exist_ok=True)
    alpha.save(a.out_mask, "PNG")

    def sha(p: str) -> str:
        return hashlib.sha256(Path(p).read_bytes()).hexdigest()

    rec = {
        "ok": True,
        "mask": a.out_mask,
        "device_observable": device,
        "input_size": [ow, oh],
        "output_size": [ow, oh],
        "internal": (
            f"{meta['nwp']}x{meta['nhp']} (pre-pad {meta['nw0']}x{meta['nh0']}, "
            f"pad right {meta['pw']} bottom {meta['ph']} replicate, scale {meta['scale']:.4f})"
        ),
        "weights_sha256": sha(weights),
        "wall_s": round(time.time() - t0, 3),
    }
    if a.meas:
        Path(a.meas).parent.mkdir(parents=True, exist_ok=True)
        Path(a.meas).write_text(json.dumps(rec, indent=2) + "\n")
    print(json.dumps(rec))


if __name__ == "__main__":
    main()
