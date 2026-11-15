"""Pinned worker settings and the §6.0 `model_hash`.

model_hash = sha256( canonical JSON of {
    "weights":  [[name, sha256-of-file], ...] sorted by name,
    "settings": SETTINGS,
} )
computed from the weight files actually present at runtime, so two hosts
report the same hash iff they run the same weights with the same settings.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path

SERVICE_DIR = Path(__file__).resolve().parent.parent
LOCK_PATH = SERVICE_DIR / "weights.lock.json"
WEIGHTS_DIR = Path(os.environ.get("VERDICT_WEIGHTS_DIR", "/opt/verdict/weights"))

FPS = 10
FRAME_MS = 100

# Everything that changes outputs for the same input lives here (canonical, sorted keys).
SETTINGS: dict = {
    "version": 1,
    "fps": FPS,
    "sam3": {"score_threshold": 0.5, "max_objects_per_prompt": 8, "seed_iou_min": 0.3},
    "pose": {"model_complexity": 1, "min_visibility": 0.5, "standing_knee_deg": 150.0, "standing_hip_deg": 150.0},
    "motion": {"flow_width_px": 320, "threshold_frac_width": 0.01, "min_consecutive_frames": 6},
    "face": {"stride_frames": 3, "det_size": 640, "det_score_min": 0.6, "upper_frac": 0.5, "projection": "verdict/face-projection/v1"},
    "reid": {"kind": "hsv-hist-centered", "bins": [8, 8, 4]},
    # inference libraries pinned in requirements.txt (their versions change outputs too)
    "libs": {"sam3": "SAM3_REF", "mediapipe": "0.10.14", "insightface": "0.7.3", "onnxruntime-gpu": "1.18.1", "opencv-python-headless": "4.10.0.84", "torch": "2.5.1"},
}
# The SAM 3 git ref is a build arg (Dockerfile); record the one actually installed.
SETTINGS["libs"]["sam3"] = os.environ.get("VERDICT_SAM3_REF", "unpinned")

# flags (§6.2 / §5.4 track flags set by the job)
FLAG_CAMERA_MOTION = 1 << 0


def canonical_json(obj) -> bytes:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("ascii")


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def load_lock() -> dict:
    return json.loads(LOCK_PATH.read_text("utf-8"))


def weight_digests(weights_dir: Path = WEIGHTS_DIR, lock: dict | None = None, verify: bool = True) -> list[list[str]]:
    """[[name, sha256], ...] of the lock's files present under weights_dir; verifies pinned digests."""
    lock = lock if lock is not None else load_lock()
    out = []
    for w in lock["weights"]:
        p = weights_dir / w["file"]
        if not p.exists():
            if w.get("optional"):
                continue
            raise FileNotFoundError(f"missing weight file {p} ({w['name']}); run scripts/fetch_weights.py")
        digest = sha256_file(p)
        pinned = w.get("sha256")
        if verify and pinned and pinned != digest:
            raise ValueError(f"weight {w['name']}: sha256 {digest} != pinned {pinned}")
        out.append([w["name"], digest])
    # The face projection is a weight too (derived, but it changes outputs).
    from verdict_face import projection_sha256  # services/common on PYTHONPATH

    out.append(["face_projection", projection_sha256()])
    return sorted(out)


def model_hash(digests: list[list[str]], settings: dict = SETTINGS) -> str:
    return hashlib.sha256(canonical_json({"weights": sorted(digests), "settings": settings})).hexdigest()
