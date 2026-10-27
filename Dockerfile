FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --chown=node:node package.json server.js ./
COPY --chown=node:node lib ./lib

USER node
# Render متغیر PORT رو خودش تنظیم می‌کنه (پیش‌فرض ۱۰۰۰۰)
EXPOSE 10000
CMD ["node", "server.js"]
