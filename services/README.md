# Optional Python sidecars

Neither service is built by default, and neither is part of `npm test` or
`npm run demo:e2e`. The default backend uses the deterministic mocks
(`PERCEPTION_PROVIDER=mock`, `IDENTITY_PROVIDER=mock`).

| Service | Contract | Backend setting | Cost |
|---|---|---|---|
| `perception/` | §6.0 job API, §6.1 RawDetection JSONL | `PERCEPTION_PROVIDER=http` + `PERCEPTION_URL`, or `nosana` | runs on a paid GPU host: needs `ALLOW_SPEND=1` |
| `embedder/` | §8.1 `/embed/face`, `/embed/voice` | `IDENTITY_PROVIDER=http` + `EMBEDDER_URL` | free, runs locally |

`common/verdict_face.py` is shared by both. Face embeddings are ArcFace-512
(InsightFace `buffalo_l`), mapped to the contract's 128-d with a fixed
SHA-256-derived ±1 projection. The projection digest is pinned in both lock
files. An enrollment made through the embedder therefore matches the `face`
embeddings that the perception worker attaches to person tracks.

CPU tests use generated fixture clips and stand-in models. They need no keys
and spend nothing: `scripts/test-services.sh`. The real-model tests are
skipped unless the pinned weights are installed.

## perception

- **Pipeline:** download each chunk and check its sha256 (a mismatch fails
  the job). Decode mp4 or mjpeg, move frames to session time
  (`local − offset_ms`), and sample at 10 fps. Then run the SAM 3 video
  predictor with one text prompt per label. Person prompts become anonymous
  `person` tracks, and `entity_refs` boxes are used as exemplars.
- **Optional steps:** MediaPipe Pose (`standing`, `elbow_deg`) when
  `need_pose`. HSV re-ID vectors when `need_reid`. Face embeddings every 3rd
  frame when `need_faces`.
- **Camera-motion flag:** median background Farneback flow above 1% of the
  frame width for more than 5 consecutive frames sets `flags` bit0.
- **`model_hash`:** sha256 over the digests of the weight files present,
  plus the canonical `SETTINGS` blob (`perception/settings.py`).
- **Server mode:** `python -m perception` serves `POST /jobs`,
  `GET /jobs/:id` and `GET /jobs/:id/detections.jsonl`.
- **One-shot mode (Nosana):** `python -m perception.oneshot` reads
  `VERDICT_JOB` and POSTs the result to the signed `VERDICT_RESULT_URL`.
- **Build:**

  ```
  python services/perception/scripts/fetch_weights.py --pin   # once; HF_TOKEN for gated SAM 3; commit the digests
  docker build -f services/perception/Dockerfile --build-arg SAM3_REF=<commit> \
    --secret id=hf_token,env=HF_TOKEN -t verdict-perception services
  ```

  Push the image and set
  `NOSANA_PERCEPTION_IMAGE=<registry>/verdict-perception@sha256:<digest>`.
- **Smoke test:** inside the image, run
  `python -m pytest -q tests/test_smoke_real.py`.

## embedder

- **Endpoints:**
  - `POST /embed/face {images_b64}` returns `{embeddings:[[128]]}`. A
    request with no detectable face gets a 422; the service never returns a
    zero vector.
  - `POST /embed/voice {wav_b64}` resamples the clip to 16 kHz mono and
    returns `{embedding:[192]}` from SpeechBrain `spkrec-ecapa-voxceleb`.
- **Run it:**

  ```
  docker build -f services/embedder/Dockerfile -t verdict-embedder services
  docker run --rm -p 8090:8090 verdict-embedder
  ```

  Then set `IDENTITY_PROVIDER=http` and `EMBEDDER_URL=http://127.0.0.1:8090`.
- **Opt-in model test:** `tests/test_real_models.py`. It checks that the
  same face or speaker scores at least τ after §8.2 quantization, and that
  different people score below τ.
