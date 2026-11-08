"""Model adapters. Heavy libraries (torch, sam3, mediapipe, insightface) are
imported lazily inside the real adapters, so the API, media and pipeline
plumbing (and their tests) run without them.

Interfaces (all coordinates in source pixels, x0,y0,x1,y1):
  Segmenter.track(frames, prompts, seeds) -> [TrackSample]
  PoseEstimator.pose(image, bbox)          -> Pose | None
  FaceEmbedder.embed(image, bbox)          -> (emb128, conf) | None
  ReidEmbedder.embed(image, bbox)          -> list[float]
"""
from __future__ import annotations

import math
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Optional, Protocol, Sequence

import numpy as np

from .settings import SETTINGS, WEIGHTS_DIR

Box = tuple[float, float, float, float]


@dataclass
class TrackSample:
    frame_idx: int
    label: str  # prompt label: the entity name, or "person" for person prompts
    obj_id: int  # predictor object id, unique per label
    bbox: Box
    mask_area_px: int
    score: float


@dataclass
class Pose:
    standing: bool
    elbow_deg: Optional[float]


class Segmenter(Protocol):
    def track(self, frames: Sequence, prompts: Sequence[tuple[str, str]], seeds: dict[str, Box]) -> list[TrackSample]: ...


class PoseEstimator(Protocol):
    def pose(self, image: np.ndarray, bbox: Box) -> Optional[Pose]: ...


class FaceEmbedder(Protocol):
    def embed(self, image: np.ndarray, bbox: Box) -> Optional[tuple[list[float], float]]: ...


class ReidEmbedder(Protocol):
    def embed(self, image: np.ndarray, bbox: Box) -> list[float]: ...


def crop(image: np.ndarray, bbox: Box, pad: float = 0.0) -> tuple[np.ndarray, int, int]:
    h, w = image.shape[:2]
    x0, y0, x1, y1 = bbox
    pw, ph = (x1 - x0) * pad, (y1 - y0) * pad
    xa, ya = max(0, int(x0 - pw)), max(0, int(y0 - ph))
    xb, yb = min(w, int(math.ceil(x1 + pw))), min(h, int(math.ceil(y1 + ph)))
    return image[ya:yb, xa:xb], xa, ya


def angle_deg(a, b, c) -> float:
    """Angle ABC in degrees."""
    ba = np.asarray(a, dtype=np.float64) - np.asarray(b, dtype=np.float64)
    bc = np.asarray(c, dtype=np.float64) - np.asarray(b, dtype=np.float64)
    den = float(np.linalg.norm(ba) * np.linalg.norm(bc))
    if den == 0:
        return 180.0
    return float(np.degrees(np.arccos(np.clip(np.dot(ba, bc) / den, -1.0, 1.0))))


# ---- SAM 3 -----------------------------------------------------------------------------


class Sam3Segmenter:
    """SAM 3 video predictor with text prompts (one session, one prompt per label).

    Uses the `sam3` package's request API (start_session / add_prompt /
    propagate_in_video / close_session). Entity reference boxes from the
    calibration are passed as positive box exemplars on frame 0 when the
    label has one (best effort: the backend's sticky binding, §6.2 D-44,
    still picks the track by IoU against the same boxes).
    """

    def __init__(self, checkpoint: Optional[Path] = None, device: Optional[str] = None):
        from sam3.model_builder import build_sam3_video_predictor  # type: ignore

        ckpt = checkpoint or (WEIGHTS_DIR / "sam3.pt")
        kwargs = {"checkpoint_path": str(ckpt)} if ckpt.exists() else {}
        self.predictor = build_sam3_video_predictor(**kwargs)
        self.cfg = SETTINGS["sam3"]

    def track(self, frames, prompts, seeds):
        import tempfile

        from .media import write_frames_dir

        out: list[TrackSample] = []
        if not frames:
            return out
        h, w = frames[0].image.shape[:2]
        with tempfile.TemporaryDirectory() as d:
            write_frames_dir(list(frames), Path(d))
            for label, phrase in prompts:
                sess = self.predictor.handle_request(request=dict(type="start_session", resource_path=d))
                sid = sess["session_id"]
                try:
                    req = dict(type="add_prompt", session_id=sid, frame_index=0, text=phrase)
                    if label in seeds:
                        x0, y0, x1, y1 = seeds[label]
                        # normalized xywh exemplar, positive
                        req["bounding_boxes"] = [[x0 / w, y0 / h, (x1 - x0) / w, (y1 - y0) / h]]
                        req["bounding_box_labels"] = [1]
                    self.predictor.handle_request(request=req)
                    for item in self.predictor.handle_stream_request(request=dict(type="propagate_in_video", session_id=sid)):
                        out.extend(self._samples(item, label, w, h))
                finally:
                    self.predictor.handle_request(request=dict(type="close_session", session_id=sid))
        return out

    def _samples(self, item: dict, label: str, w: int, h: int) -> list[TrackSample]:
        fi = int(item["frame_index"])
        o = item["outputs"]
        ids = list(o.get("out_obj_ids", []))
        probs = list(o.get("out_probs", []))
        boxes = o.get("out_boxes_xywh", [])
        masks = o.get("out_binary_masks", None)
        res = []
        order = sorted(range(len(ids)), key=lambda i: -float(probs[i]))[: self.cfg["max_objects_per_prompt"]]
        for i in order:
            p = float(probs[i])
            if p < self.cfg["score_threshold"]:
                continue
            bx, by, bw, bh = (float(v) for v in boxes[i])
            # normalized xywh → source px xyxy
            bbox = (bx * w, by * h, (bx + bw) * w, (by + bh) * h)
            area = int(np.asarray(masks[i]).sum()) if masks is not None else int(bw * w * bh * h)
            res.append(TrackSample(fi, label, int(ids[i]), bbox, area, p))
        return res


# ---- MediaPipe Pose --------------------------------------------------------------------


class MediaPipePose:
    """MediaPipe Pose on the person crop: standing + min elbow angle (§5.1 primitives)."""

    def __init__(self):
        import mediapipe as mp  # type: ignore

        self.cfg = SETTINGS["pose"]
        self.mp_pose = mp.solutions.pose
        self.pose_model = self.mp_pose.Pose(static_image_mode=True, model_complexity=self.cfg["model_complexity"])

    def pose(self, image, bbox):
        import cv2

        sub, xa, ya = crop(image, bbox, pad=0.1)
        if sub.size == 0:
            return None
        r = self.pose_model.process(cv2.cvtColor(sub, cv2.COLOR_BGR2RGB))
        if not r.pose_landmarks:
            return None
        lm = r.pose_landmarks.landmark
        vis = self.cfg["min_visibility"]
        sh, sw = sub.shape[:2]

        def pt(i):
            p = lm[i]
            return (p.x * sw, p.y * sh) if p.visibility >= vis else None

        return pose_from_landmarks(pt, self.cfg)


def pose_from_landmarks(pt, cfg) -> Optional[Pose]:
    """standing: some leg with hip and knee angles ≥ thresholds and shoulders above hips.
    elbow_deg: min shoulder–elbow–wrist angle over visible arms (None if none)."""
    elbows = []
    for s, e, wr in ((11, 13, 15), (12, 14, 16)):
        a, b, c = pt(s), pt(e), pt(wr)
        if a and b and c:
            elbows.append(angle_deg(a, b, c))
    standing = False
    for sh_i, hip, knee, ank in ((11, 23, 25, 27), (12, 24, 26, 28)):
        s, h, k, a = pt(sh_i), pt(hip), pt(knee), pt(ank)
        if s and h and k and a and s[1] < h[1]:
            if angle_deg(h, k, a) >= cfg["standing_knee_deg"] and angle_deg(s, h, k) >= cfg["standing_hip_deg"]:
                standing = True
    if not elbows and not standing and pt(23) is None and pt(24) is None:
        return None
    return Pose(standing=standing, elbow_deg=min(elbows) if elbows else None)


# ---- faces (same model + projection as services/embedder) ------------------------------


class InsightFaceEmbedder:
    """SCRFD detection + ArcFace (buffalo_l) inside the upper part of a person box,
    projected 512→128 with the shared fixed projection (services/common)."""

    def __init__(self, root: Optional[Path] = None):
        from insightface.app import FaceAnalysis  # type: ignore

        self.cfg = SETTINGS["face"]
        self.app = FaceAnalysis(name="buffalo_l", root=str(root or WEIGHTS_DIR / "insightface"), allowed_modules=["detection", "recognition"])
        ctx = 0 if os.environ.get("VERDICT_DEVICE", "cuda") == "cuda" else -1
        self.app.prepare(ctx_id=ctx, det_size=(self.cfg["det_size"], self.cfg["det_size"]))

    def embed(self, image, bbox):
        from verdict_face import project_arcface

        x0, y0, x1, y1 = bbox
        upper = (x0, y0, x1, y0 + (y1 - y0) * self.cfg["upper_frac"])
        sub, _, _ = crop(image, upper, pad=0.15)
        if sub.size == 0:
            return None
        faces = [f for f in self.app.get(sub) if float(f.det_score) >= self.cfg["det_score_min"]]
        if not faces:
            return None
        f = max(faces, key=lambda x: float(x.det_score))
        return project_arcface(f.normed_embedding), float(f.det_score)


# ---- re-ID ----------------------------------------------------------------------------


class HsvReid:
    """Cheap appearance vector: mean-centered, L2-normalized HSV histogram of the
    person crop (8×8×4 bins). Only used for the §8.5 re-ID link threshold."""

    def __init__(self):
        self.bins = SETTINGS["reid"]["bins"]

    def embed(self, image, bbox):
        import cv2

        sub, _, _ = crop(image, bbox)
        if sub.size == 0:
            return []
        hsv = cv2.cvtColor(sub, cv2.COLOR_BGR2HSV)
        hist = cv2.calcHist([hsv], [0, 1, 2], None, self.bins, [0, 180, 0, 256, 0, 256]).reshape(-1).astype(np.float64)
        hist = np.sqrt(hist / max(hist.sum(), 1.0))
        hist -= hist.mean()
        n = float(np.linalg.norm(hist))
        return [round(float(v) / n, 5) for v in hist] if n > 0 else []


@dataclass
class ModelSet:
    segmenter: Segmenter
    pose: Optional[PoseEstimator] = None
    face: Optional[FaceEmbedder] = None
    reid: Optional[ReidEmbedder] = None


def load_models(need_pose: bool, need_faces: bool, need_reid: bool) -> ModelSet:
    """Real models (GPU container). Cached per process by the caller."""
    return ModelSet(
        segmenter=Sam3Segmenter(),
        pose=MediaPipePose() if need_pose else None,
        face=InsightFaceEmbedder() if need_faces else None,
        reid=HsvReid() if need_reid else None,
    )
