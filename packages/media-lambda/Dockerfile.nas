# ai-news web-video API for a machine on a regular ISP line (Synology NAS, mini PC):
# Node 22 + yt-dlp's ffmpeg build + standalone yt-dlp + the bundled server (src/server.ts).
# Multi-arch: linux/amd64 (Intel / AMD Synology) and linux/arm64. Build with build-nas.sh.
FROM node:22-bookworm-slim
ARG TARGETARCH
# ffmpeg comes from yt-dlp's own builds (glibc-dynamic). The John Van Sickle static build segfaults on network input
# here (static glibc DNS lookup), and with --download-sections ffmpeg does the fetching itself.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl xz-utils && rm -rf /var/lib/apt/lists/* \
 && case "$TARGETARCH" in arm64) FF=linuxarm64; YT=yt-dlp_linux_aarch64 ;; *) FF=linux64; YT=yt-dlp_linux ;; esac \
 && curl -fsSL --retry 5 --retry-all-errors "https://github.com/yt-dlp/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-${FF}-gpl.tar.xz" -o /tmp/ffmpeg.tar.xz \
 && mkdir -p /opt/ffmpeg && tar -xJf /tmp/ffmpeg.tar.xz -C /opt/ffmpeg --strip-components=1 \
 && rm -rf /tmp/ffmpeg.tar.xz /opt/ffmpeg/bin/ffplay /opt/ffmpeg/doc /opt/ffmpeg/man \
 && ln -s /opt/ffmpeg/bin/ffmpeg /usr/local/bin/ffmpeg && ln -s /opt/ffmpeg/bin/ffprobe /usr/local/bin/ffprobe \
 && ffmpeg -hide_banner -version | head -1 \
 && curl -fsSL --retry 5 --retry-all-errors "https://github.com/yt-dlp/yt-dlp/releases/latest/download/${YT}" -o /usr/local/bin/yt-dlp \
 && chmod +x /usr/local/bin/yt-dlp && /usr/local/bin/yt-dlp --version

ENV NODE_ENV=production PORT=8787 WORK_DIR=/tmp FFMPEG_PATH=/usr/local/bin/ffmpeg FFPROBE_PATH=/usr/local/bin/ffprobe YTDLP_PATH=/usr/local/bin/yt-dlp
WORKDIR /app
COPY dist/server.mjs /app/server.mjs
USER node
EXPOSE 8787
HEALTHCHECK --interval=60s --timeout=10s --start-period=20s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "/app/server.mjs"]
