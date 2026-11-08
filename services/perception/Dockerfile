# services/perception — GPU worker for the §6.0 job API (and Nosana one-shot jobs).
# Not built by default (not part of npm test / demo:e2e). Build from the services/ dir:
#   docker build -f services/perception/Dockerfile --build-arg SAM3_REF=<commit> \
#     --secret id=hf_token,env=HF_TOKEN -t verdict-perception services
# then push and pin the image by digest (NOSANA_PERCEPTION_IMAGE=…@sha256:…).
ARG BASE_IMAGE=nvidia/cuda:12.4.1-cudnn-runtime-ubuntu22.04
FROM ${BASE_IMAGE}

ARG SAM3_REF
RUN test -n "$SAM3_REF" || (echo "SAM3_REF build arg (facebookresearch/sam3 commit) is required" && exit 1)

ENV DEBIAN_FRONTEND=noninteractive PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 \
    VERDICT_WEIGHTS_DIR=/opt/verdict/weights VERDICT_SAM3_REF=${SAM3_REF} \
    PYTHONPATH=/opt/verdict/common:/opt/verdict/perception PORT=8092
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3.11 python3.11-venv python3-pip git ffmpeg libgl1 libglib2.0-0 ca-certificates \
    && rm -rf /var/lib/apt/lists/* && ln -sf /usr/bin/python3.11 /usr/local/bin/python

WORKDIR /opt/verdict/perception
COPY perception/requirements.txt ./requirements.txt
RUN python -m pip install --upgrade pip==24.3.1 && python -m pip install -r requirements.txt \
    && python -m pip install "git+https://github.com/facebookresearch/sam3@${SAM3_REF}"

COPY common /opt/verdict/common
COPY perception/weights.lock.json ./weights.lock.json
COPY perception/scripts ./scripts
# Weights are baked in, each checked against its pinned sha256 (an unpinned lock fails the build).
RUN --mount=type=secret,id=hf_token HF_TOKEN="$(cat /run/secrets/hf_token 2>/dev/null || true)" \
    python scripts/fetch_weights.py --require-pinned --dir "$VERDICT_WEIGHTS_DIR"
COPY perception/perception ./perception

EXPOSE 8092
# Server mode (PERCEPTION_PROVIDER=http). Nosana jobs override the command with
# `python -m perception.oneshot` (VERDICT_JOB + VERDICT_RESULT_URL env).
CMD ["python", "-m", "perception"]
