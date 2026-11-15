"""§6.0 job request / status and §6.1 RawDetection, as pydantic models."""
from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel, Field, field_validator

HEX64 = r"^[0-9a-f]{64}$"


class VideoUrl(BaseModel):
    index: int = Field(ge=0)
    url: str
    sha256: str = Field(pattern=HEX64)
    start_ms: int = Field(ge=0)
    duration_ms: int = Field(ge=1)
    body_format: Literal["mp4", "mjpeg"]


class Prompt(BaseModel):
    entity: str = Field(min_length=1, max_length=64)
    phrase: str = Field(min_length=1, max_length=128)


class EntityRef(BaseModel):
    entity: str
    label: Optional[str] = None
    # x0,y0,x1,y1 normalized 0..10000 (§5.2)
    bbox: list[int] = Field(min_length=4, max_length=4)


class JobRequest(BaseModel):
    bet: str = Field(min_length=32, max_length=44)
    job_nonce: str = Field(min_length=8, max_length=64)
    fps: Literal[10]
    offset_ms: int
    video_urls: list[VideoUrl] = Field(max_length=4096)
    prompts: list[Prompt] = Field(max_length=16)
    entity_refs: list[EntityRef] = Field(default_factory=list, max_length=16)
    need_pose: bool = False
    need_reid: bool = False
    # backend extension (CONTRACTS-ERRATA backend-audit-faces): `face` on person lines
    need_faces: bool = False

    @field_validator("video_urls")
    @classmethod
    def _sorted_unique(cls, v: list[VideoUrl]) -> list[VideoUrl]:
        idx = [x.index for x in v]
        if len(set(idx)) != len(idx):
            raise ValueError("duplicate video index")
        return sorted(v, key=lambda x: x.index)


class Host(BaseModel):
    provider: str
    job_id: str
    url: str
    market: str


class Frame(BaseModel):
    width_px: int
    height_px: int


class JobStatus(BaseModel):
    status: Literal["queued", "running", "done", "failed"]
    model_hash: str
    flags: int
    detections_url: str
    host: Host
    # extension: decoded source frame size (backend quantization), null until known
    frame: Optional[Frame] = None
    error: Optional[str] = None
