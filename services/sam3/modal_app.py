"""SAM 3.1 on Modal: text-prompted segmentation and tracking over a short run of JPEG frames.

General purpose: nothing here knows what a challenge is. The caller sends a short run of frames
(an attempt's sampled frames, or a single still) and one or more text prompts naming the things to
find ("person", "ball", "hoop", "water bottle"...). For each prompt SAM 3.1 (facebook/sam3.1,
sam3.1_multiplex.pt) finds every instance on the prompt frame, picks up new ones later, and tracks
them through the rest. The reply has, per prompt, per-frame objects (score, pixel box, mask area,
optional RLE mask) and a per-object track summary: plain measurements, never a verdict. Deciding
what they mean for a given challenge is the caller's job.

Deploy (from the repo root, with the workspace's Modal profile):
    MODAL_PROFILE=logan modal deploy services/sam3/modal_app.py
Secrets (in that workspace):
    huggingface  HF_TOKEN with access to the gated facebook/sam3.1 repo
    sam3-auth    SAM3_API_TOKEN: the bearer token callers must send
Weights are downloaded once into the `sam3-weights` Volume, not baked into the image.

API:
    GET  /health   -> {ok, model, gpu}   (no auth; wakes a GPU container, so it is not free)
    POST /segment  Authorization: Bearer <SAM3_API_TOKEN>
         {prompts: [str] (1-4) | prompt: str, frames: [base64 JPEG], prompt_frame?: int = 0,
          masks?: bool = false}
         -> {model, gpu, rev, results: [{prompt, frames: [{index, objects: [{id, score, box_xyxy,
            box_all_xyxy, components, mask_area, mask_rle?}]}], tracks: [{id, frames, missing,
            max_score, first, last}], timing_ms}], timing_ms, boot_ms}
    box_xyxy is the box of the mask's largest connected blob (stable under motion blur, where a
    few stray pixels can stretch the whole-mask box, box_all_xyxy, across the frame).
"""

from __future__ import annotations

import modal

APP_NAME = "youre-on-sam3"
# facebookresearch/sam3 at the commit this was built and tested against (2026-11-18).
SAM3_REF = "31cb7e624e4fe95301b1be1d4e809111593d2e45"
MODEL = "facebook/sam3.1 (sam3.1_multiplex.pt)"
# Bumped on every behavioural change, reported by /health, to tell which code a container runs.
APP_REV = "2026-11-18.7"
# 24 GB Ampere/Ada cards, in order of preference. On 2026-11-18 Modal had no L4 capacity for this
# workspace (requests queued with zero runners) while A10G started at once.
GPU = ["A10G", "L4"]
MAX_FRAMES = 32
MAX_FRAME_BYTES = 2 * 1024 * 1024
MAX_PROMPT_CHARS = 120
MAX_PROMPTS = 4

app = modal.App(APP_NAME)
weights = modal.Volume.from_name("sam3-weights", create_if_missing=True)

image = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install("git", "libgl1", "libglib2.0-0")
    .pip_install("torch==2.10.0", "torchvision", index_url="https://download.pytorch.org/whl/cu128")
    .pip_install(
        f"git+https://github.com/facebookresearch/sam3.git@{SAM3_REF}",
        "opencv-python-headless",
        "scipy",
        "scikit-image",
        "psutil",
        "einops",
        "setuptools<81",  # sam3 imports pkg_resources
        "pycocotools",  # imported by sam3.model_builder's chain but not declared by the package
        "fastapi[standard]",
    )
    # Fail the deploy, not every container start, when an undeclared import is missing.
    .run_commands("python -c 'import sam3.model_builder'")
    .env({"HF_HOME": "/weights/hf", "TOKENIZERS_PARALLELISM": "false"})
)


def rle(mask) -> dict:
    """Uncompressed column-major RLE (the COCO convention): counts start with a run of zeros."""
    import numpy as np

    flat = np.asarray(mask, dtype=np.uint8).flatten(order="F")
    changes = np.flatnonzero(np.diff(flat)) + 1
    bounds = np.concatenate(([0], changes, [flat.size]))
    counts = np.diff(bounds).tolist()
    if flat.size and flat[0] == 1:
        counts = [0] + counts
    return {"size": [int(mask.shape[0]), int(mask.shape[1])], "counts": counts}


def _drop_unknown_init_kwargs(model) -> None:
    """Upstream bug at SAM3_REF: Sam3BasePredictor.start_session always passes
    offload_state_to_cpu (and video_loader_type when set) to model.init_state, but the SAM 3.1
    multiplex model's init_state takes neither, so every start_session raises TypeError. Wrap
    init_state to pass only the keywords its signature accepts (both dropped options default to
    off). Remove once upstream fixes it."""
    import functools
    import inspect

    original = model.init_state
    accepted = set(inspect.signature(original).parameters)

    @functools.wraps(original)
    def init_state(*args, **kwargs):
        return original(*args, **{k: v for k, v in kwargs.items() if k in accepted})

    model.init_state = init_state


def _shape(box) -> dict:
    x0, y0, x1, y1 = box
    w, h = x1 - x0, y1 - y0
    return {"box_xyxy": box, "w": w, "h": h, "aspect_h_over_w": round(h / w, 3) if w else None}


def objects_of(outputs: dict, with_masks: bool) -> list[dict]:
    """One frame's predictor outputs (out_obj_ids, out_probs, out_binary_masks) as plain JSON.
    Boxes come from the masks, in pixels, so they never depend on the model's own box format."""
    import numpy as np
    from scipy import ndimage

    ids = np.asarray(outputs.get("out_obj_ids", []))
    probs = outputs.get("out_probs")
    masks = outputs.get("out_binary_masks")
    objs = []
    for i in range(len(ids)):
        o: dict = {"id": int(ids[i])}
        if probs is not None and len(probs) > i:
            o["score"] = round(float(np.asarray(probs)[i]), 4)
        m = np.asarray(masks[i]).astype(bool) if masks is not None and len(masks) > i else None
        if m is not None and m.any():
            ys, xs = np.nonzero(m)
            o["box_all_xyxy"] = [int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1]
            labels, n = ndimage.label(m)
            sizes = np.bincount(labels.ravel())[1:]
            main = labels == (int(np.argmax(sizes)) + 1)
            ys, xs = np.nonzero(main)
            o["box_xyxy"] = [int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1]
            o["components"] = int(n)
            o["mask_area"] = int(m.sum())
            if with_masks:
                o["mask_rle"] = rle(m)
        else:
            o.update(box_xyxy=None, box_all_xyxy=None, components=0, mask_area=0)
        objs.append(o)
    return objs


def tracks_of(frames: list[dict]) -> list[dict]:
    """Per object id: the frames it is on, the frames it is missing from inside its span, its best
    score, and its shape on the first and last frame it appears on. Measurements only."""
    seen: dict[int, list[tuple[int, dict]]] = {}
    for f in frames:
        for o in f["objects"]:
            if o["mask_area"] > 0:
                seen.setdefault(o["id"], []).append((f["index"], o))
    tracks = []
    for oid, hits in sorted(seen.items()):
        idx = [i for i, _ in hits]
        first, last = hits[0], hits[-1]
        tracks.append(
            {
                "id": oid,
                "frames": idx,
                "missing": [i for i in range(idx[0], idx[-1] + 1) if i not in idx],
                "max_score": max((o.get("score") or 0.0) for _, o in hits),
                "first": {"index": first[0], "mask_area": first[1]["mask_area"], **_shape(first[1]["box_xyxy"])},
                "last": {"index": last[0], "mask_area": last[1]["mask_area"], **_shape(last[1]["box_xyxy"])},
            }
        )
    return tracks


@app.cls(
    image=image,
    gpu=GPU,
    volumes={"/weights": weights},
    secrets=[modal.Secret.from_name("huggingface"), modal.Secret.from_name("sam3-auth")],
    scaledown_window=300,  # stays warm 5 min after the last request, then scales to zero
    timeout=600,
    max_containers=1,  # one GPU at most: a backlog queues instead of starting a fleet
)
@modal.concurrent(max_inputs=1)  # one session at a time per GPU
class Sam3:
    @modal.enter()
    def load(self):
        import os
        import time

        import torch
        from huggingface_hub import hf_hub_download
        from sam3.model_builder import build_sam3_predictor

        t0 = time.perf_counter()
        token = os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN")
        ckpt = hf_hub_download("facebook/sam3.1", "sam3.1_multiplex.pt", token=token)
        hf_hub_download("facebook/sam3.1", "config.json", token=token)
        weights.commit()
        t1 = time.perf_counter()
        # FlashAttention 3 is not installed (Hopper-only kernels): the default attention path.
        self.predictor = build_sam3_predictor(
            checkpoint_path=ckpt, version="sam3.1", use_fa3=False, async_loading_frames=False
        )
        _drop_unknown_init_kwargs(self.predictor.model)
        self.gpu_name = torch.cuda.get_device_name(0)
        self.boot = {
            "weights_ms": round((t1 - t0) * 1000),
            "build_ms": round((time.perf_counter() - t1) * 1000),
        }
        self.api_token = os.environ["SAM3_API_TOKEN"]
        print(f"sam3.ready boot_ms={self.boot} gpu={self.gpu_name}")

    def _track(self, workdir: str, n: int, prompt: str, prompt_frame: int, with_masks: bool) -> dict:
        """One session per prompt over the same frames, so prompts never share object ids."""
        import time

        import torch

        p = self.predictor
        t0 = time.perf_counter()
        # The upstream notebooks run everything under bf16 autocast; propagate_in_video's detector
        # backbone assumes it (else "mat1 and mat2 must have the same dtype"). Autocast is
        # thread-local and FastAPI runs this on a worker thread, so it is entered here.
        with torch.autocast(device_type="cuda", dtype=torch.bfloat16):
            sid = p.handle_request({"type": "start_session", "resource_path": workdir})["session_id"]
            t1 = time.perf_counter()
            try:
                first = p.handle_request(
                    {"type": "add_prompt", "session_id": sid, "frame_index": prompt_frame, "text": prompt}
                )
                t2 = time.perf_counter()
                per_frame = {prompt_frame: first["outputs"]}
                if n > 1:
                    for r in p.handle_stream_request({"type": "propagate_in_video", "session_id": sid}):
                        per_frame[r["frame_index"]] = r["outputs"]
                t3 = time.perf_counter()
            finally:
                p.handle_request({"type": "close_session", "session_id": sid})
        frames = [{"index": i, "objects": objects_of(per_frame[i], with_masks)} for i in sorted(per_frame)]
        return {
            "prompt": prompt,
            "prompt_frame": prompt_frame,
            "frames": frames,
            "tracks": tracks_of(frames),
            "timing_ms": {
                "load_frames": round((t1 - t0) * 1000),
                "prompt": round((t2 - t1) * 1000),
                "propagate": round((t3 - t2) * 1000),
            },
        }

    def segment(self, frames: list[bytes], prompts: list[str], prompt_frame: int, with_masks: bool) -> dict:
        import shutil
        import tempfile
        import time

        t0 = time.perf_counter()
        workdir = tempfile.mkdtemp(prefix="sam3-")
        try:
            for i, jpg in enumerate(frames):
                with open(f"{workdir}/{i:05d}.jpg", "wb") as f:
                    f.write(jpg)
            results = [self._track(workdir, len(frames), q, prompt_frame, with_masks) for q in prompts]
        finally:
            shutil.rmtree(workdir, ignore_errors=True)
        return {
            "model": MODEL,
            "sam3_ref": SAM3_REF,
            "rev": APP_REV,
            "gpu": self.gpu_name,
            "results": results,
            "timing_ms": {"total": round((time.perf_counter() - t0) * 1000)},
            "boot_ms": self.boot,
        }

    @modal.asgi_app(label="youre-on-sam3")
    def web(self):
        import base64
        import binascii
        import hmac

        from fastapi import Body, FastAPI, Header, HTTPException
        from pydantic import BaseModel, Field, ValidationError

        api = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)

        class SegmentBody(BaseModel):
            prompt: str | None = Field(default=None, min_length=1, max_length=MAX_PROMPT_CHARS)
            prompts: list[str] | None = Field(default=None, min_length=1, max_length=MAX_PROMPTS)
            frames: list[str] = Field(min_length=1, max_length=MAX_FRAMES)
            prompt_frame: int = 0
            masks: bool = False

        @api.get("/health")
        def health():
            return {"ok": True, "model": MODEL, "gpu": self.gpu_name, "rev": APP_REV}

        @api.post("/segment")
        def segment(raw: dict = Body(...), authorization: str | None = Header(default=None)):
            # The model is validated by hand: with postponed annotations FastAPI cannot resolve a
            # class defined in this function, and the auth check should come before validation.
            expected = f"Bearer {self.api_token}"
            if not authorization or not hmac.compare_digest(authorization.encode(), expected.encode()):
                raise HTTPException(status_code=401, detail="unauthorized")
            try:
                body = SegmentBody.model_validate(raw)
            except ValidationError as e:
                raise HTTPException(status_code=422, detail=e.errors(include_url=False, include_input=False))
            prompts = [q.strip() for q in (body.prompts or ([body.prompt] if body.prompt else []))]
            if not prompts or any(not q or len(q) > MAX_PROMPT_CHARS for q in prompts):
                raise HTTPException(status_code=422, detail=f"give prompt or prompts (1-{MAX_PROMPTS}, each 1-{MAX_PROMPT_CHARS} chars)")
            if len(set(prompts)) != len(prompts):
                raise HTTPException(status_code=422, detail="duplicate prompts")
            if not 0 <= body.prompt_frame < len(body.frames):
                raise HTTPException(status_code=422, detail="prompt_frame out of range")
            frames = []
            for i, b64 in enumerate(body.frames):
                try:
                    jpg = base64.b64decode(b64, validate=True)
                except (binascii.Error, ValueError):
                    raise HTTPException(status_code=422, detail=f"frames[{i}] is not base64")
                if len(jpg) > MAX_FRAME_BYTES or jpg[:3] != b"\xff\xd8\xff":
                    raise HTTPException(status_code=422, detail=f"frames[{i}] is not a JPEG under 2 MB")
                frames.append(jpg)
            try:
                return self.segment(frames, prompts, body.prompt_frame, body.masks)
            except Exception as e:  # authorized callers get the cause, not a bare 500
                import traceback

                traceback.print_exc()
                raise HTTPException(status_code=500, detail=f"{type(e).__name__}: {str(e)[:500]}")

        return api
