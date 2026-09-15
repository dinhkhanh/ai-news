#!/usr/bin/env bash
# Build the media Lambda container and deploy the SAM stack to ap-southeast-1.
# Reads R2_* and REMOTION_AWS_* from apps/web/.env.local (or the environment).
# Requires Docker running and the AWS SAM CLI.
set -euo pipefail
cd "$(dirname "$0")"
ENV_FILE="${ENV_FILE:-../../apps/web/.env.local}"
readvar() { grep -E "^$1=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- || true; }
: "${AWS_ACCESS_KEY_ID:=$(readvar REMOTION_AWS_ACCESS_KEY_ID)}"
: "${AWS_SECRET_ACCESS_KEY:=$(readvar REMOTION_AWS_SECRET_ACCESS_KEY)}"
: "${R2_ACCOUNT_ID:=$(readvar R2_ACCOUNT_ID)}"
: "${R2_ACCESS_KEY_ID:=$(readvar R2_ACCESS_KEY_ID)}"
: "${R2_SECRET_ACCESS_KEY:=$(readvar R2_SECRET_ACCESS_KEY)}"
: "${R2_BUCKET:=$(readvar R2_BUCKET)}"
export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_DEFAULT_REGION=ap-southeast-1
[ -n "$AWS_ACCESS_KEY_ID" ] || { echo "AWS credentials missing"; exit 1; }
# IMAGE_REPO=<account>.dkr.ecr.ap-southeast-1.amazonaws.com/ai-news-media skips SAM's companion stack
# (needs fewer CloudFormation permissions). Without it SAM creates the ECR repo itself.
if [ -n "${IMAGE_REPO:-}" ]; then REPO_ARGS=(--image-repository "$IMAGE_REPO"); else REPO_ARGS=(--resolve-image-repos); fi
pnpm build
sam build
sam deploy --no-confirm-changeset --no-fail-on-empty-changeset --resolve-s3 "${REPO_ARGS[@]}" \
  --capabilities CAPABILITY_IAM --stack-name ai-news-media --region ap-southeast-1 \
  --parameter-overrides "R2AccountId=$R2_ACCOUNT_ID R2AccessKeyId=$R2_ACCESS_KEY_ID R2SecretAccessKey=$R2_SECRET_ACCESS_KEY R2Bucket=${R2_BUCKET:-ai-news}"
