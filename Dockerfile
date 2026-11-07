# noliric — Telegram-бот + отделение вокала (Mel-Band RoFormer, CPU)
# .env в образ не копируется: docker run --env-file .env ...
FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONUNBUFFERED=1 \
    VIRTUAL_ENV=/opt/venv \
    PATH=/opt/venv/bin:$PATH

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ffmpeg python3 python3-venv python3-dev build-essential \
      libsndfile1 libsamplerate0 ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# PyTorch (CPU-сборка) + audio-separator
RUN python3 -m venv /opt/venv \
 && pip install --upgrade pip setuptools wheel \
 && pip install torch --index-url https://download.pytorch.org/whl/cpu \
 && pip install "audio-separator[cpu]==0.48.0"

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY bot.js ./

ENV NODE_ENV=production \
    DATA_DIR=/app/data \
    PYTHON_BIN=/opt/venv/bin/python

VOLUME ["/app/data"]
CMD ["node", "bot.js"]
