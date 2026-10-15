#!/usr/bin/env bash
# Give the web-video API on this Mac a signed-in YouTube session, so YouTube's "Sign in to confirm you're not a bot"
# check (which the office line gets at times) lets it through. Run it yourself, in a terminal on the Mac, with a
# browser that is signed in to YouTube:
#
#   bash packages/media-lambda/mac/youtube-cookies.sh            Chrome (macOS asks once for the "Chrome Safe Storage" key)
#   bash packages/media-lambda/mac/youtube-cookies.sh firefox    or safari / brave / edge / chromium; a profile: "chrome:Profile 1"
#   bash packages/media-lambda/mac/youtube-cookies.sh remove     stop using cookies
#
# Only the youtube.com cookies are kept, in ~/Library/Application Support/ai-news-webvideo/youtube-cookies.txt (mode 600);
# the server passes them to yt-dlp for YouTube only (`YTDLP_COOKIES`) and keeps the file updated as YouTube refreshes the
# session. The script never prints them. Run it again when YouTube asks to sign in again (cookies expired or signed out).
set -euo pipefail

APP_DIR="$HOME/Library/Application Support/ai-news-webvideo"
ENV_FILE="$APP_DIR/webvideo.env"
COOKIES="$APP_DIR/youtube-cookies.txt"
YTDLP=/opt/homebrew/bin/yt-dlp
CHECK_URL="https://www.youtube.com/shorts/glnBXVyOgmk"

[ -f "$ENV_FILE" ] || { echo "Install the web-video API first: bash packages/media-lambda/mac/install.sh"; exit 1; }

restart() {
  # The daemon runs as this user with KeepAlive: launchd starts it again within seconds, with the new settings.
  pkill -f "$APP_DIR/server.mjs" || true
  echo "Restarted the web-video API."
}

if [ "${1:-}" = remove ]; then
  rm -f "$COOKIES" "$COOKIES".*
  sed -i '' '/^YTDLP_COOKIES=/d' "$ENV_FILE"
  restart
  echo "Removed the YouTube cookies."
  exit 0
fi

browser="${1:-chrome}"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
chmod 700 "$tmp"

echo "Reading the YouTube cookies from ${browser}…"
# yt-dlp writes every cookie it loaded to --cookies on exit; the lookup checks that YouTube accepts the session.
if "$YTDLP" --cookies-from-browser "${browser}" --cookies "$tmp/all.txt" --skip-download --no-warnings --print "Signed-in check passed: %(title)s" "$CHECK_URL"; then
  ok=1
else
  ok=0
fi
[ -s "$tmp/all.txt" ] || { echo "No cookies were read from ${browser}."; exit 1; }

umask 077
{
  echo "# Netscape HTTP Cookie File"
  awk -F '\t' '$1 ~ /^(#HttpOnly_)?\.?([A-Za-z0-9-]+\.)*youtube\.com$/' "$tmp/all.txt"
} > "$tmp/youtube.txt"
grep -qE $'\t(SAPISID|__Secure-3PAPISID)\t' "$tmp/youtube.txt" || { echo "${browser} has no signed-in YouTube session (no SAPISID cookie). Sign in to youtube.com in ${browser} and run this again."; exit 1; }

mv "$tmp/youtube.txt" "$COOKIES"
chmod 600 "$COOKIES"
grep -q '^YTDLP_COOKIES=' "$ENV_FILE" || echo "YTDLP_COOKIES=\"$COOKIES\"" >> "$ENV_FILE"
restart
echo "Saved $(($(wc -l < "$COOKIES") - 1)) youtube.com cookies to $COOKIES."
[ "$ok" = 1 ] || echo "Note: the check video did not load with these cookies (see the error above); YouTube may still be refusing this line."
