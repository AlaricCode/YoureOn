"""One perception job: chunks → 10 fps frames → SAM 3 tracks (+ pose, faces,
re-ID) → §6.1 RawDetection JSON Lines, camera-motion flag and model_hash."""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Optional

from .media import Fetcher, Frame, http_fetch, load_session_frames
from .models import ModelSet, TrackSample
from .motion import background_motion, camera_motion_flag
from .schema import JobRequest
from .settings import FLAG_CAMERA_MOTION, FRAME_MS, SETTINGS

PERSON = "person"
MAX_TRACK_ID = 0xFFFF


@dataclass
class JobResult:
    lines: list[dict]
    flags: int
    model_hash: str
    width_px: Optional[int]
    height_px: Optional[int]
    stats: dict = field(default_factory=dict)

    def jsonl(self) -> str:
        return "".join(json.dumps(l, separators=(",", ":"), sort_keys=True) + "\n" for l in self.lines)


def prompt_labels(req: JobRequest) -> list[tuple[str, str]]:
    """(label, phrase) per SAM 3 run. Person prompts collapse into one anonymous
    "person" run (the worker never knows who is who; identity is §8.5's job)."""
    out: list[tuple[str, str]] = []
    seen = set()
    for p in req.prompts:
        label = PERSON if p.phrase.strip().lower() == PERSON else p.entity
        if label in seen:
            continue
        seen.add(label)
        out.append((label, p.phrase))
    return out


def seed_boxes(req: JobRequest, width: int, height: int) -> dict[str, tuple[float, float, float, float]]:
    """Calibration entity_refs (0..10000 normalized) → source px, for non-person labels."""
    seeds = {}
    for r in req.entity_refs:
        x0, y0, x1, y1 = r.bbox
        seeds[r.entity] = (x0 * width / 10000, y0 * height / 10000, x1 * width / 10000, y1 * height / 10000)
    return seeds


def assign_track_ids(samples: list[TrackSample]) -> dict[tuple[str, int], int]:
    """(label, obj_id) → u16 track_id: 1.. in order of first appearance (frame, label, obj_id)."""
    ids: dict[tuple[str, int], int] = {}
    for s in sorted(samples, key=lambda s: (s.frame_idx, s.label, s.obj_id)):
        k = (s.label, s.obj_id)
        if k not in ids:
            if len(ids) >= MAX_TRACK_ID:
                raise ValueError("more than 65535 tracks")
            ids[k] = len(ids) + 1
    return ids


def run_job(req: JobRequest, models: ModelSet, model_hash: str, fetch: Fetcher = http_fetch) -> JobResult:
    frames: list[Frame] = load_session_frames(req.video_urls, req.offset_ms, fetch)
    if not frames:
        return JobResult(lines=[], flags=0, model_hash=model_hash, width_px=None, height_px=None, stats={"frames": 0})
    h, w = frames[0].image.shape[:2]
    samples = models.segmenter.track(frames, prompt_labels(req), seed_boxes(req, w, h))
    tids = assign_track_ids(samples)
    by_frame: dict[int, list[TrackSample]] = {}
    for s in samples:
        by_frame.setdefault(s.frame_idx, []).append(s)

    stride = SETTINGS["face"]["stride_frames"]
    lines: list[dict] = []
    for fi, fr in enumerate(frames):
        for s in sorted(by_frame.get(fi, []), key=lambda s: tids[(s.label, s.obj_id)]):
            line = {
                "t_ms": fr.t_ms,
                "entity": s.label,
                "track_id": tids[(s.label, s.obj_id)],
                "bbox_px": [round(v, 2) for v in s.bbox],
                "mask_area_px": int(s.mask_area_px),
                "confidence": round(float(s.score), 4),
            }
            if s.label == PERSON:
                if req.need_pose and models.pose:
                    p = models.pose.pose(fr.image, s.bbox)
                    if p is not None:
                        line["pose"] = {"standing": p.standing, **({"elbow_deg": round(p.elbow_deg, 1)} if p.elbow_deg is not None else {})}
                if req.need_reid and models.reid:
                    v = models.reid.embed(fr.image, s.bbox)
                    if v:
                        line["reid"] = v
                # Faces on the session's stride frames (backend samples floor(t/100) % stride == 0).
                if req.need_faces and models.face and (fr.t_ms // FRAME_MS) % stride == 0:
                    fe = models.face.embed(fr.image, s.bbox)
                    if fe is not None:
                        emb, conf = fe
                        line["face"] = {"emb": [round(x, 6) for x in emb], "conf": round(conf, 4)}
            lines.append(line)

    mags = []
    for i in range(1, len(frames)):
        boxes = [s.bbox for s in by_frame.get(i, [])]
        mags.append(background_motion(frames[i - 1].image, frames[i].image, boxes))
    flags = FLAG_CAMERA_MOTION if camera_motion_flag(mags, w) else 0
    return JobResult(lines=lines, flags=flags, model_hash=model_hash, width_px=w, height_px=h, stats={"frames": len(frames), "tracks": len(tids)})
