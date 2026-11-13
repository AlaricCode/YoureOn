# services/embedder — §8.1 face/voice embeddings (IDENTITY_PROVIDER=http, EMBEDDER_URL).
# Optional, not built by default. Build from the services/ dir:
#   docker build -f services/embedder/Dockerfile -t verdict-embedder services
#   docker run --rm -p 8090:8090 verdict-embedder
FROM python:3.11.11-slim-bookworm

ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 VERDICT_WEIGHTS_DIR=/opt/verdict/weights \
    PYTHONPATH=/opt/verdict/common:/opt/verdict/embedder HOST=0.0.0.0 PORT=8090
RUN apt-get update && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 g++ \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/verdict/embedder
COPY embedder/requirements.txt ./requirements.txt
# CPU-only PyTorch first: the default Linux wheel bundles several GB of CUDA
# libraries the embedder never uses (it runs on CPU), and the oversized layer
# can fail Docker Desktop's image export.
RUN python -m pip install --upgrade pip==24.3.1 \
    && python -m pip install torch==2.5.1 torchaudio==2.5.1 --index-url https://download.pytorch.org/whl/cpu \
    && python -m pip install -r requirements.txt
COPY common /opt/verdict/common
COPY embedder/weights.lock.json ./weights.lock.json
COPY embedder/scripts ./scripts
RUN python scripts/fetch_weights.py --require-pinned --dir "$VERDICT_WEIGHTS_DIR"
COPY embedder/embedder ./embedder
EXPOSE 8090
CMD ["python", "-m", "embedder"]
