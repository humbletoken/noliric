# noliric — Telegram-бот «угадай трек по инструменталу»
# Локальная нейросеть (MDX-Net Inst HQ 4, ~1 ГБ RAM) собирается и скачивается автоматически.
# .env в образ не копируется: docker run --env-file .env ...
FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONUNBUFFERED=1 \
    VIRTUAL_ENV=/opt/venv \
    PATH=/opt/venv/bin:$PATH \
    SEP_MODEL_DIR=/opt/models

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ffmpeg ca-certificates python3 python3-venv python3-dev build-essential libsndfile1 libsamplerate0 \
 && rm -rf /var/lib/apt/lists/*

# PyTorch + torchvision (CPU, одной парой версий) + audio-separator.
# torchvision тянет onnx2torch: если он придёт с PyPI отдельно — «torchvision::nms does not exist».
RUN python3 -m venv /opt/venv \
 && pip install --upgrade pip setuptools wheel \
 && pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu \
 && pip install "audio-separator[cpu]==0.48.0" --extra-index-url https://download.pytorch.org/whl/cpu \
 && python -c "import torch, torchvision; from audio_separator.separator import Separator; print('torch', torch.__version__, '| torchvision', torchvision.__version__)"

# Модели скачиваются при сборке — бот стартует сразу
RUN mkdir -p /opt/models \
 && for m in UVR-MDX-NET-Inst_HQ_4.onnx UVR-MDX-NET-Inst_HQ_3.onnx; do \
      audio-separator --download_model_only -m "$m" --model_file_dir /opt/models || echo "WARN: $m скачается при первом запуске"; \
    done

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY bot.js ./

ENV NODE_ENV=production \
    DATA_DIR=/app/data \
    PYTHON_BIN=/opt/venv/bin/python \
    SEP_ENGINE=local

VOLUME ["/app/data"]
CMD ["node", "bot.js"]
