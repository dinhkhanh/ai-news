#!/usr/bin/env bash
# Create the R2 bucket in APAC and enable object versioning is not available on R2; we rely on the
# pinned/ prefix + Supabase-side render metadata for durability. Needs CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN.
set -euo pipefail
: "${CLOUDFLARE_ACCOUNT_ID:?}" "${CLOUDFLARE_API_TOKEN:?}"
BUCKET="${R2_BUCKET:-ai-news}"
curl -fsS -X POST "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/r2/buckets" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" -H "Content-Type: application/json" \
  --data "{\"name\":\"${BUCKET}\",\"locationHint\":\"apac\"}" | python3 -m json.tool
