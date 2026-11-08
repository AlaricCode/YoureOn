"""FastAPI app for §8.1:

  POST /embed/face  {images_b64:[...]} → {embeddings:[[128 floats]]}  (one per image, L2-normalized)
                     422 if any image has no detectable face (never a zero vector)
  POST /embed/voice {wav_b64}          → {embedding:[192 floats]}     (16 kHz mono, L2-normalized)
  GET  /health                         → {ok, face_dim, voice_dim}
"""
from __future__ import annotations

import base64
import binascii
import math
from typing import Callable

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from .audio import TARGET_SR, to_16k_mono
from .models import FaceModel, NoFaceError, VoiceModel

FACE_DIM = 128
VOICE_DIM = 192
MAX_IMAGES = 16
MIN_VOICE_S = 0.3
MAX_VOICE_S = 60.0


class FaceReq(BaseModel):
    images_b64: list[str] = Field(min_length=1, max_length=MAX_IMAGES)


class VoiceReq(BaseModel):
    wav_b64: str = Field(min_length=1)


def _b64(s: str) -> bytes:
    try:
        return base64.b64decode(s, validate=True)
    except (binascii.Error, ValueError):
        raise HTTPException(status_code=400, detail="invalid base64")


def _unit(v: list[float], dim: int, what: str) -> list[float]:
    if len(v) != dim or not all(math.isfinite(x) for x in v):
        raise HTTPException(status_code=500, detail=f"{what}: model returned a bad vector")
    n = math.sqrt(sum(x * x for x in v))
    if n == 0:
        raise HTTPException(status_code=500, detail=f"{what}: zero vector")
    return [x / n for x in v]


def create_app(face_factory: Callable[[], FaceModel], voice_factory: Callable[[], VoiceModel]) -> FastAPI:
    app = FastAPI(title="verdict-embedder", version="1.0.0")
    cache: dict = {}

    def face() -> FaceModel:
        if "face" not in cache:
            cache["face"] = face_factory()
        return cache["face"]

    def voice() -> VoiceModel:
        if "voice" not in cache:
            cache["voice"] = voice_factory()
        return cache["voice"]

    @app.get("/health")
    def health():
        return {"ok": True, "face_dim": FACE_DIM, "voice_dim": VOICE_DIM}

    @app.post("/embed/face")
    def embed_face(req: FaceReq):
        out = []
        for i, s in enumerate(req.images_b64):
            try:
                out.append(_unit(face().embed(_b64(s)), FACE_DIM, "face"))
            except NoFaceError as e:
                raise HTTPException(status_code=422, detail=f"image {i}: {e}")
        return {"embeddings": out}

    @app.post("/embed/voice")
    def embed_voice(req: VoiceReq):
        try:
            pcm = to_16k_mono(_b64(req.wav_b64))
        except HTTPException:
            raise
        except Exception as e:  # noqa: BLE001
            raise HTTPException(status_code=400, detail=f"not a PCM WAV: {e}")
        secs = len(pcm) / TARGET_SR
        if secs < MIN_VOICE_S or secs > MAX_VOICE_S:
            raise HTTPException(status_code=422, detail=f"clip length {secs:.2f}s outside {MIN_VOICE_S}–{MAX_VOICE_S}s")
        return {"embedding": _unit(voice().embed(pcm), VOICE_DIM, "voice")}

    return app


def real_app() -> FastAPI:
    from .models import EcapaModel, InsightFaceModel

    return create_app(InsightFaceModel, EcapaModel)
