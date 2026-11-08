"""Shared face-embedding pieces of services/perception and services/embedder.

Both services must produce the *same* 128-d face embedding for the same face,
so a template enrolled through services/embedder (`POST /embed/face`) matches
the `face` embeddings services/perception attaches to person tracks.

Embedding = L2-normalize(P · arcface512(aligned_face)), where P is a fixed
128×512 Rademacher projection (entries ±1/sqrt(128)) derived from SHA-256 in
counter mode over PROJECTION_SEED. It is implementation-independent (no RNG
library), so its digest is stable and is pinned in both lock files.
Random ±1 projections preserve cosine similarity in expectation
(Johnson–Lindenstrauss), which is what the closed-set match (§8.3) uses.
"""
from __future__ import annotations

import hashlib
import math
from typing import Sequence

FACE_DIM = 128
ARCFACE_DIM = 512
PROJECTION_SEED = b"verdict/face-projection/v1"


def projection_signs() -> bytes:
    """128*512 sign bits as bytes (bit i of the stream = sign of entry i, row-major)."""
    need = FACE_DIM * ARCFACE_DIM // 8
    out = bytearray()
    counter = 0
    while len(out) < need:
        out += hashlib.sha256(PROJECTION_SEED + counter.to_bytes(4, "little")).digest()
        counter += 1
    return bytes(out[:need])


def projection_sha256() -> str:
    """Digest pinned in weights.lock.json of both services."""
    return hashlib.sha256(projection_signs()).hexdigest()


def projection_matrix():
    """The projection as a float32 numpy array (128, 512)."""
    import numpy as np

    bits = np.unpackbits(np.frombuffer(projection_signs(), dtype=np.uint8), bitorder="little")
    signs = bits.astype(np.float32) * 2.0 - 1.0
    return (signs.reshape(FACE_DIM, ARCFACE_DIM) / math.sqrt(FACE_DIM)).astype(np.float32)


def l2_normalize(v: Sequence[float]) -> list[float]:
    n = math.sqrt(sum(float(x) * float(x) for x in v))
    if n == 0 or not math.isfinite(n):
        raise ValueError("cannot normalize a zero/non-finite vector")
    return [float(x) / n for x in v]


def project_arcface(emb512) -> list[float]:
    """512-d ArcFace embedding → 128-d L2-normalized contract embedding (§8.1)."""
    import numpy as np

    v = np.asarray(emb512, dtype=np.float32).reshape(-1)
    if v.shape[0] != ARCFACE_DIM:
        raise ValueError(f"expected a {ARCFACE_DIM}-d ArcFace embedding, got {v.shape[0]}")
    v = v / max(float(np.linalg.norm(v)), 1e-12)
    return l2_normalize((projection_matrix() @ v).tolist())


# §8.2 quantization + §8.3 match, for tests that check the τ thresholds exactly as the backend does.
EMB_SCALE = 512  # engine constants.ts EMB_SCALE


def quantize(v: Sequence[float]) -> list[int]:
    out = []
    for x in v:
        y = float(x) * EMB_SCALE
        r = math.floor(abs(y) + 0.5) * (1 if y >= 0 else -1)
        out.append(max(-127, min(127, int(r))))
    return out


def cos_bps(e: Sequence[int], o: Sequence[int]) -> int:
    """§8.3 integer cosine in basis points."""
    dot = sum(a * b for a, b in zip(e, o))
    ne = sum(a * a for a in e)
    no = sum(b * b for b in o)
    if dot <= 0 or ne == 0 or no == 0:
        return 0
    return (dot * 10000) // math.isqrt(ne * no)

TAU_FACE_BPS = 5500  # engine constants.ts
TAU_VOICE_BPS = 5000
