"""§8.1 request/response shapes with stand-in models (no weights needed)."""
import base64
import io
import math
import wave

import numpy as np
from fastapi.testclient import TestClient

from embedder.app import create_app
from embedder.audio import resample, to_16k_mono
from embedder.models import NoFaceError


class FakeFace:
    def embed(self, jpeg):
        if jpeg == b"noface":
            raise NoFaceError("no face found")
        v = [0.0] * 128
        v[jpeg[0] % 128] = 2.0
        return v


class FakeVoice:
    def __init__(self):
        self.seen = []

    def embed(self, pcm):
        self.seen.append(pcm)
        return [1.0] * 192


def wav(seconds=1.0, sr=48000, channels=2, hz=440.0):
    t = np.arange(int(seconds * sr)) / sr
    x = (0.3 * np.sin(2 * np.pi * hz * t) * 32767).astype("<i2")
    if channels == 2:
        x = np.stack([x, x], axis=1).reshape(-1)
    b = io.BytesIO()
    with wave.open(b, "wb") as w:
        w.setnchannels(channels)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(x.tobytes())
    return b.getvalue()


def client():
    voice = FakeVoice()
    return TestClient(create_app(FakeFace, lambda: voice)), voice


def b64(b):
    return base64.b64encode(b).decode()


def test_face_contract():
    c, _ = client()
    r = c.post("/embed/face", json={"images_b64": [b64(b"\x05jpeg"), b64(b"\x07jpeg")]})
    assert r.status_code == 200
    embs = r.json()["embeddings"]
    assert len(embs) == 2 and all(len(e) == 128 for e in embs)
    assert all(abs(math.hypot(*e) - 1) < 1e-9 for e in embs)
    assert embs[0][5] == 1.0
    # No face: 422, never a zero vector.
    assert c.post("/embed/face", json={"images_b64": [b64(b"noface")]}).status_code == 422
    assert c.post("/embed/face", json={"images_b64": ["***"]}).status_code == 400
    assert c.post("/embed/face", json={"images_b64": []}).status_code == 422


def test_voice_contract_resamples_to_16k_mono():
    c, voice = client()
    r = c.post("/embed/voice", json={"wav_b64": b64(wav(1.0, 48000, 2))})
    assert r.status_code == 200
    e = r.json()["embedding"]
    assert len(e) == 192 and abs(math.hypot(*e) - 1) < 1e-9
    assert len(voice.seen[0]) == 16000
    assert c.post("/embed/voice", json={"wav_b64": b64(wav(0.1))}).status_code == 422
    assert c.post("/embed/voice", json={"wav_b64": b64(b"not a wav")}).status_code == 400


def test_resample_preserves_tone():
    x = to_16k_mono(wav(1.0, 44100, 1, hz=1000.0))
    spec = np.abs(np.fft.rfft(x))
    assert abs(np.argmax(spec) - 1000) <= 1
    assert len(resample(np.zeros(4800, dtype=np.float32), 48000)) == 1600
