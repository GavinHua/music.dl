FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY src ./src
COPY public ./public
COPY source ./source

RUN mkdir -p /app/data/music

ENV NODE_ENV=production \
    PORT=8000 \
    DATA_PATH=/app/data \
    MUSIC_PATH=/app/data/music \
    SOURCE_PATH=/app/source \
    ALLOW_UNSAFE_VM=true

EXPOSE 8000
CMD ["npm", "start"]
