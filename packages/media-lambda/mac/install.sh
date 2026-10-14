#!/usr/bin/env bash
# Run the web-video API (src/server.ts) natively on an always-on Mac with Apple silicon (e.g. the office Mac mini)
# instead of the NAS: a launchd daemon that starts at boot without anyone logged in and restarts if it stops, plus a
# daily `brew upgrade yt-dlp` (video sites break old yt-dlp versions often). Guide: docs/SETUP.md → "Mac mini".
#
#   bash packages/media-lambda/mac/install.sh            install or update (asks for your Mac password for launchd)
#   bash packages/media-lambda/mac/install.sh status     service state + /health
#   bash packages/media-lambda/mac/install.sh uninstall  stop and remove both daemons (keeps the env file and logs)
#
# Secrets live in ~/Library/Application Support/ai-news-webvideo/webvideo.env (mode 600). The script creates it on the
# first run with blank values and stops: fill in API_TOKEN (the same value as WEB_VIDEO_API_TOKEN in Vercel) and the
# four R2_* values, then run it again. It never prints them.
set -euo pipefail
cd "$(dirname "$0")/.."

LABEL=com.ai-news.webvideo
UPDATE_LABEL=com.ai-news.webvideo-ytdlp-update
APP_DIR="$HOME/Library/Application Support/ai-news-webvideo"
ENV_FILE="$APP_DIR/webvideo.env"
LOG_DIR="$HOME/Library/Logs/ai-news-webvideo"
WORK_DIR="$HOME/Library/Caches/ai-news-webvideo"
BREW=/opt/homebrew/bin/brew
PLIST="/Library/LaunchDaemons/$LABEL.plist"
UPDATE_PLIST="/Library/LaunchDaemons/$UPDATE_LABEL.plist"
PORT_DEFAULT=8787

health() {
  local port
  port=$(grep -E '^PORT=' "$ENV_FILE" 2>/dev/null | cut -d= -f2 || true)
  curl -s -m 5 "http://127.0.0.1:${port:-$PORT_DEFAULT}/health" || echo "(no answer)"
  echo
}

case "${1:-install}" in
  status)
    sudo launchctl print "system/$LABEL" 2>/dev/null | grep -E "state =|pid =|last exit code" || echo "$LABEL is not loaded"
    health
    exit 0
    ;;
  uninstall)
    sudo launchctl bootout "system/$LABEL" 2>/dev/null || true
    sudo launchctl bootout "system/$UPDATE_LABEL" 2>/dev/null || true
    sudo rm -f "$PLIST" "$UPDATE_PLIST"
    echo "Removed both daemons. Kept $ENV_FILE and $LOG_DIR."
    exit 0
    ;;
  install) ;;
  *) echo "usage: $0 [install|status|uninstall]"; exit 1 ;;
esac

[ "$(uname -m)" = arm64 ] || { echo "This installer is for Apple silicon Macs."; exit 1; }
[ -x "$BREW" ] || { echo "Homebrew is required (https://brew.sh), installed at /opt/homebrew."; exit 1; }

# 1. Tools: node runs the server; yt-dlp downloads (deno = the JavaScript runtime yt-dlp needs for YouTube); ffmpeg encodes.
missing=()
for f in node yt-dlp ffmpeg deno; do "$BREW" list --formula "$f" >/dev/null 2>&1 || missing+=("$f"); done
if [ ${#missing[@]} -gt 0 ]; then echo "Installing ${missing[*]} with Homebrew…"; "$BREW" install "${missing[@]}"; fi

# 2. The server bundle (the same file the NAS image runs).
pnpm build:server >/dev/null
mkdir -p "$APP_DIR" "$LOG_DIR" "$WORK_DIR"
cp dist/server.mjs "$APP_DIR/server.mjs"

# 3. Settings and secrets.
if [ ! -f "$ENV_FILE" ]; then
  umask 077
  cat > "$ENV_FILE" <<EOF
# ai-news web-video API on this Mac. Mode 600: keep it that way.
# API_TOKEN: the same value as WEB_VIDEO_API_TOKEN in Vercel (and API_TOKEN in the NAS's nas.env), so the app needs no change.
API_TOKEN=
# Cloudflare R2, the same four values as the NAS's nas.env.
R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET=ai-news
PORT=$PORT_DEFAULT
# Downloads encoding at once (each uses every core); more wait in the queue.
MAX_CONCURRENT=3
WORK_DIR=$WORK_DIR
FFMPEG_PATH=/opt/homebrew/bin/ffmpeg
FFPROBE_PATH=/opt/homebrew/bin/ffprobe
YTDLP_PATH=/opt/homebrew/bin/yt-dlp
NODE_ENV=production
EOF
  echo "Created $ENV_FILE"
fi
chmod 600 "$ENV_FILE"
for k in API_TOKEN R2_ACCOUNT_ID R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY; do
  if ! grep -qE "^$k=.+" "$ENV_FILE"; then
    echo "Fill in $k (and any other blank secret) in:"
    echo "  open -e \"$ENV_FILE\""
    echo "then run this script again."
    exit 1
  fi
done
token=$(grep -E '^API_TOKEN=' "$ENV_FILE" | cut -d= -f2-)
[ ${#token} -ge 24 ] || { echo "API_TOKEN must be at least 24 characters (use the one Vercel has)."; exit 1; }

# 4. launchd: daemons run at boot as this user, without a login session. The plists hold no secrets.
tmp=$(mktemp -d)
cat > "$tmp/$LABEL.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>UserName</key><string>$USER</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>--env-file=$ENV_FILE</string>
    <string>$APP_DIR/server.mjs</string>
  </array>
  <key>WorkingDirectory</key><string>$APP_DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>HOME</key><string>$HOME</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$LOG_DIR/server.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/server.log</string>
</dict>
</plist>
EOF
cat > "$tmp/$UPDATE_LABEL.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$UPDATE_LABEL</string>
  <key>UserName</key><string>$USER</string>
  <key>ProgramArguments</key>
  <array><string>$BREW</string><string>upgrade</string><string>yt-dlp</string><string>deno</string></array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>HOME</key><string>$HOME</string>
  </dict>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>4</integer><key>Minute</key><integer>15</integer></dict>
  <key>StandardOutPath</key><string>$LOG_DIR/ytdlp-update.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/ytdlp-update.log</string>
</dict>
</plist>
EOF
plutil -lint "$tmp/$LABEL.plist" "$tmp/$UPDATE_LABEL.plist" >/dev/null

echo "Installing the launchd daemons (your Mac password is asked once)…"
sudo install -m 644 -o root -g wheel "$tmp/$LABEL.plist" "$PLIST"
sudo install -m 644 -o root -g wheel "$tmp/$UPDATE_LABEL.plist" "$UPDATE_PLIST"
rm -rf "$tmp"
for l in "$LABEL" "$UPDATE_LABEL"; do sudo launchctl bootout "system/$l" 2>/dev/null || true; done
sudo launchctl bootstrap system "$PLIST"
sudo launchctl bootstrap system "$UPDATE_PLIST"

for _ in 1 2 3 4 5 6 7 8 9 10; do
  curl -s -m 2 "http://127.0.0.1:$(grep -E '^PORT=' "$ENV_FILE" | cut -d= -f2)/health" >/dev/null 2>&1 && break
  sleep 1
done
echo "Health:"; health
echo "Logs: $LOG_DIR/server.log"
