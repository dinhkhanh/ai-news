#!/usr/bin/env bash
# Apply R2 lifecycle rules (docs/PLAN.md §9). Needs CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN (R2 edit), R2_BUCKET.
set -euo pipefail
: "${CLOUDFLARE_ACCOUNT_ID:?}" "${CLOUDFLARE_API_TOKEN:?}"
BUCKET="${R2_BUCKET:-ai-news}"
DIR="$(cd "$(dirname "$0")" && pwd)"
curl -fsS -X PUT "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/r2/buckets/${BUCKET}/lifecycle" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" -H "Content-Type: application/json" \
  --data @"${DIR}/lifecycle.json" | python3 -m json.tool
echo "Lifecycle applied to ${BUCKET}. Pinned renders live under pinned/ (no rule)."
