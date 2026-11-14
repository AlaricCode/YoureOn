"""Real models (lazy imports):
  face:  InsightFace buffalo_l (SCRFD detect + align, ArcFace 512-d) → fixed
         512→128 projection (services/common/verdict_face.py) → L2-normalize.
  voice: SpeechBrain spkrec-ecapa-voxceleb (192-d), 16 kHz mono → L2-normalize.
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Optional, Protocol

import numpy as np

WEIGHTS_DIR = Path(os.environ.get("VERDICT_WEIGHTS_DIR", "/opt/verdict/weights"))
ECAPA_REVISION = os.environ.get("VERDICT_ECAPA_REVISION", "main")


class NoFaceError(Exception):
    pass


class FaceModel(Protocol):
    def embed(self, jpeg: bytes) -> list[float]: ...


class VoiceModel(Protocol):
    def embed(self, pcm16k: np.ndarray) -> list[float]: ...


class InsightFaceModel:
    def __init__(self, root: Optional[Path] = None, det_score_min: float = 0.6):
        from insightface.app import FaceAnalysis  # type: ignore

        self.det_score_min = det_score_min
        self.app = FaceAnalysis(name="buffalo_l", root=str(root or WEIGHTS_DIR / "insightface"), allowed_modules=["detection", "recognition"])
        self.app.prepare(ctx_id=0 if os.environ.get("VERDICT_DEVICE", "cpu") == "cuda" else -1, det_size=(640, 640))

    def embed(self, jpeg: bytes) -> list[float]:
        import cv2

        from verdict_face import project_arcface

        img = cv2.imdecode(np.frombuffer(jpeg, dtype=np.uint8), cv2.IMREAD_COLOR)
        if img is None:
            raise NoFaceError("not a decodable image")
        faces = [f for f in self.app.get(img) if float(f.det_score) >= self.det_score_min]
        if not faces:
            raise NoFaceError("no face found")
        # The largest confident face is the subject (pre-cropped faces are the whole image).
        f = max(faces, key=lambda x: float((x.bbox[2] - x.bbox[0]) * (x.bbox[3] - x.bbox[1])))
        return project_arcface(f.normed_embedding)


class EcapaModel:
    def __init__(self):
        import torch  # type: ignore
        from speechbrain.inference.speaker import EncoderClassifier  # type: ignore

        self.torch = torch
        local = WEIGHTS_DIR / "spkrec-ecapa-voxceleb"
        baked = (local / "hyperparams.yaml").exists()
        # Baked, digest-checked files (scripts/fetch_weights.py) win over a hub download.
        # The model's hyperparams.yaml points its pretrainer at the hub repo
        # (`pretrained_path`); override it so the checkpoints load from `local` too.
        self.enc = EncoderClassifier.from_hparams(
            source=str(local) if baked else "speechbrain/spkrec-ecapa-voxceleb",
            savedir=str(local),
            revision=ECAPA_REVISION,
            overrides={"pretrained_path": str(local)} if baked else {},
            run_opts={"device": "cuda" if os.environ.get("VERDICT_DEVICE") == "cuda" else "cpu"},
        )

    def embed(self, pcm16k: np.ndarray) -> list[float]:
        with self.torch.no_grad():
            e = self.enc.encode_batch(self.torch.from_numpy(pcm16k).unsqueeze(0)).squeeze().cpu().numpy()
        n = float(np.linalg.norm(e))
        if n == 0:
            raise ValueError("zero voice embedding")
        return [float(v) / n for v in e]
