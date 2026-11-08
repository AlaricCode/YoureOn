"""Deterministic fixture clips (generated, nothing binary committed) and a
CPU stand-in segmenter, so the full job plumbing runs without SAM 3."""
from __future__ import annotations

import hashlib
import struct
import tempfile
from pathlib import Path

import cv2
import numpy as np

from perception.models import ModelSet, TrackSample

W, H = 320, 240


def frame(i: int, pan_px: int = 0) -> np.ndarray:
    """Textured background (optionally panned by i*pan_px) + a red ball moving right
    + a blue 'person' block standing still."""
    rng = np.random.default_rng(7)
    tex = (rng.integers(0, 255, size=(H, W * 4, 3), dtype=np.uint8) // 2) + 40
    tex = cv2.GaussianBlur(tex, (7, 7), 0)
    x = (i * pan_px) % (W * 3)
    img = tex[:, x : x + W].copy()
    bx = 20 + i * 6
    cv2.circle(img, (bx, 120), 12, (0, 0, 255), -1)
    cv2.rectangle(img, (220, 60), (270, 220), (255, 0, 0), -1)
    return img


def mjpeg(frames: list[np.ndarray], t0_local: int) -> bytes:
    out = b""
    for i, f in enumerate(frames):
        ok, jpg = cv2.imencode(".jpg", f, [cv2.IMWRITE_JPEG_QUALITY, 92])
        assert ok
        out += struct.pack("<II", len(jpg), t0_local + i * 100) + jpg.tobytes()
    return out


def mp4(frames: list[np.ndarray], fps: int = 10) -> bytes:
    with tempfile.TemporaryDirectory() as d:
        p = Path(d) / "c.mp4"
        vw = cv2.VideoWriter(str(p), cv2.VideoWriter_fourcc(*"mp4v"), fps, (W, H))
        for f in frames:
            vw.write(f)
        vw.release()
        return p.read_bytes()


def sha(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


class ColorSegmenter:
    """Finds the red ball ('ball' prompt) and the blue block ('person' prompt) by color."""

    RANGES = {"ball": ((0, 0, 150), (80, 80, 255)), "person": ((150, 0, 0), (255, 80, 80))}

    def track(self, frames, prompts, seeds):
        out = []
        for fi, fr in enumerate(frames):
            for label, _phrase in prompts:
                lo, hi = self.RANGES.get(label, ((0, 0, 0), (0, 0, 0)))
                m = cv2.inRange(fr.image, np.array(lo), np.array(hi))
                ys, xs = np.nonzero(m)
                if len(xs) < 20:
                    continue
                out.append(TrackSample(fi, label, 1, (float(xs.min()), float(ys.min()), float(xs.max() + 1), float(ys.max() + 1)), int(len(xs)), 0.9))
        return out


class FakePose:
    def pose(self, image, bbox):
        from perception.models import Pose

        return Pose(standing=True, elbow_deg=170.0)


class FakeFace:
    def embed(self, image, bbox):
        v = [0.0] * 128
        v[3] = 1.0
        return v, 0.97


def fake_models(need_pose=True, need_faces=True, need_reid=False) -> ModelSet:
    from perception.models import HsvReid

    return ModelSet(segmenter=ColorSegmenter(), pose=FakePose() if need_pose else None, face=FakeFace() if need_faces else None, reid=HsvReid() if need_reid else None)
