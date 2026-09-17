# ai-news media Lambda: Node 22 + static ffmpeg/ffprobe + yt-dlp
FROM public.ecr.aws/lambda/nodejs:22

# ffmpeg static build (John Van Sickle) - includes libx264, aac, loudnorm, sidechaincompress
# yt-dlp: the standalone linux binary (PyInstaller). The zipapp needs Python >= 3.10 and this base image only has 3.9.
RUN dnf install -y tar xz && dnf clean all \
 && curl -fsSL --retry 5 --retry-all-errors https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz -o /tmp/ffmpeg.tar.xz \
 && mkdir -p /opt/ffmpeg && tar -xJf /tmp/ffmpeg.tar.xz -C /opt/ffmpeg --strip-components=1 \
 && ln -s /opt/ffmpeg/ffmpeg /usr/local/bin/ffmpeg && ln -s /opt/ffmpeg/ffprobe /usr/local/bin/ffprobe \
 && rm /tmp/ffmpeg.tar.xz \
 && curl -fsSL --retry 5 --retry-all-errors https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux -o /usr/local/bin/yt-dlp \
 && chmod +x /usr/local/bin/yt-dlp && /usr/local/bin/yt-dlp --version

ENV FFMPEG_PATH=/usr/local/bin/ffmpeg FFPROBE_PATH=/usr/local/bin/ffprobe YTDLP_PATH=/usr/local/bin/yt-dlp WORK_DIR=/tmp

COPY dist/handler.mjs ${LAMBDA_TASK_ROOT}/handler.mjs
CMD ["handler.handler"]
