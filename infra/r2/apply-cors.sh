#!/usr/bin/env bash
# Apply R2 CORS rules so the editor can PUT uploads straight to the bucket with a presigned URL
# (apps/web: createUploadUrl → browser PUT → registerUpload). Add the production app origin to
# cors.json before running. Needs CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN (R2 edit), R2_BUCKET.
set -euo pipefail
: "${CLOUDFLARE_ACCOUNT_ID:?}" "${CLOUDFLARE_API_TOKEN:?}"
BUCKET="${R2_BUCKET:-ai-news}"
DIR="$(cd "$(dirname "$0")" && pwd)"
curl -fsS -X PUT "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/r2/buckets/${BUCKET}/cors" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" -H "Content-Type: application/json" \
  --data @"${DIR}/cors.json" | python3 -m json.tool
echo "CORS applied to ${BUCKET}."
