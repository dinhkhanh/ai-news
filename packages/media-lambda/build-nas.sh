#!/usr/bin/env bash
# Build the web-video API image for a Synology NAS and save it as an importable .tar.
#   bash build-nas.sh            → linux/amd64 (Intel / AMD models: the ones that run Container Manager)
#   ARCH=arm64 bash build-nas.sh → linux/arm64 (ARM models)
# Output (git-ignored): dist/nas/ai-news-webvideo-api-<arch>.tar, docker-compose.yml and,
# on the first run, a nas.env template with a fresh API token. The script never reads
# your credentials: fill in the four R2_* values yourself (same as apps/web/.env.local).
set -euo pipefail
cd "$(dirname "$0")"
ARCH="${ARCH:-amd64}"
TAG="ai-news-webvideo-api:1"
OUT="dist/nas"

mkdir -p "$OUT"
pnpm build:server
docker build --platform "linux/$ARCH" -f Dockerfile.nas -t "$TAG" .
docker save "$TAG" -o "$OUT/ai-news-webvideo-api-$ARCH.tar"
cp docker-compose.nas.yml "$OUT/docker-compose.yml"

if [ ! -f "$OUT/nas.env" ]; then
  umask 077
  {
    echo "# Environment of the ai-news web-video API container. Keep this file private."
    echo "# API_TOKEN is new and random: put the same value in WEB_VIDEO_API_TOKEN of the web app."
    echo "API_TOKEN=$(openssl rand -hex 32)"
    echo "MAX_CONCURRENT=20"
    echo "# Copy these four from apps/web/.env.local:"
    echo "R2_ACCOUNT_ID="
    echo "R2_ACCESS_KEY_ID="
    echo "R2_SECRET_ACCESS_KEY="
    echo "R2_BUCKET=ai-news"
  } > "$OUT/nas.env"
  echo "wrote $OUT/nas.env template (new API token, R2 values left blank)"
else
  echo "kept existing $OUT/nas.env"
fi
ls -lh "$OUT"
