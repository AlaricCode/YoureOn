"""WAV decoding to 16 kHz mono float32 (ECAPA input), numpy only."""
from __future__ import annotations

import io
import wave

import numpy as np

TARGET_SR = 16000


def decode_wav(data: bytes) -> tuple[np.ndarray, int]:
    """PCM 8/16/24/32-bit WAV → (mono float32 in [-1, 1], sample_rate)."""
    with wave.open(io.BytesIO(data), "rb") as w:
        ch, width, sr, n = w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()
        raw = w.readframes(n)
    if width == 1:
        x = (np.frombuffer(raw, dtype=np.uint8).astype(np.float32) - 128.0) / 128.0
    elif width == 2:
        x = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    elif width == 3:
        b = np.frombuffer(raw, dtype=np.uint8).reshape(-1, 3)
        v = (b[:, 0].astype(np.int32) | (b[:, 1].astype(np.int32) << 8) | (b[:, 2].astype(np.int32) << 16))
        v = np.where(v & 0x800000, v - 0x1000000, v)
        x = v.astype(np.float32) / 8388608.0
    elif width == 4:
        x = np.frombuffer(raw, dtype="<i4").astype(np.float32) / 2147483648.0
    else:
        raise ValueError(f"unsupported sample width {width}")
    if ch > 1:
        x = x.reshape(-1, ch).mean(axis=1)
    return x, sr


def resample(x: np.ndarray, sr: int, target: int = TARGET_SR) -> np.ndarray:
    """Band-limited (windowed-sinc via FFT) resampling to `target` Hz."""
    if sr == target or len(x) == 0:
        return x.astype(np.float32)
    n_out = int(round(len(x) * target / sr))
    X = np.fft.rfft(x)
    n_keep = min(len(X), n_out // 2 + 1)
    Y = np.zeros(n_out // 2 + 1, dtype=complex)
    Y[:n_keep] = X[:n_keep]
    return (np.fft.irfft(Y, n=n_out) * (n_out / len(x))).astype(np.float32)


def to_16k_mono(data: bytes) -> np.ndarray:
    x, sr = decode_wav(data)
    return resample(x, sr)
