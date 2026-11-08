"""Opt-in: real ArcFace / ECAPA embeddings meet the backend's τ after §8.2
quantization. Skipped unless the models are installed, the pinned weights are
in $VERDICT_WEIGHTS_DIR and $VERDICT_EMBEDDER_FIXTURES holds:
  face_a1.jpg, face_a2.jpg (same person), face_b.jpg (someone else)
  voice_a1.wav, voice_a2.wav (same speaker), voice_b.wav (someone else)
(no fixtures with real people are committed). No keys, no spend.
"""
import importlib.util
import os
from pathlib import Path

import pytest

import verdict_face as vf

FIX = Path(os.environ.get("VERDICT_EMBEDDER_FIXTURES", "/nonexistent"))
HAVE_FACE = importlib.util.find_spec("insightface") is not None and (FIX / "face_a1.jpg").exists()
HAVE_VOICE = importlib.util.find_spec("speechbrain") is not None and (FIX / "voice_a1.wav").exists()


@pytest.mark.skipif(not HAVE_FACE, reason="insightface/weights/fixtures absent")
def test_same_face_above_tau_different_below():
    from embedder.models import InsightFaceModel

    m = InsightFaceModel()
    a1, a2, b = (vf.quantize(m.embed((FIX / n).read_bytes())) for n in ("face_a1.jpg", "face_a2.jpg", "face_b.jpg"))
    assert vf.cos_bps(a1, a2) >= vf.TAU_FACE_BPS
    assert vf.cos_bps(a1, b) < vf.TAU_FACE_BPS


@pytest.mark.skipif(not HAVE_VOICE, reason="speechbrain/weights/fixtures absent")
def test_same_speaker_above_tau_different_below():
    from embedder.audio import to_16k_mono
    from embedder.models import EcapaModel

    m = EcapaModel()
    a1, a2, b = (vf.quantize(m.embed(to_16k_mono((FIX / n).read_bytes()))) for n in ("voice_a1.wav", "voice_a2.wav", "voice_b.wav"))
    assert vf.cos_bps(a1, a2) >= vf.TAU_VOICE_BPS
    assert vf.cos_bps(a1, b) < vf.TAU_VOICE_BPS
