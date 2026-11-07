# noliric — Telegram-бот «угадай трек по секунде»
# Только Node.js + ffmpeg: образ лёгкий, RAM почти не нужна.
# .env в образ не копируется: docker run --env-file .env ...
FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY bot.js ./

ENV NODE_ENV=production \
    DATA_DIR=/app/data

VOLUME ["/app/data"]
CMD ["node", "bot.js"]
