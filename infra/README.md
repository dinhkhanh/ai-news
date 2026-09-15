# infra

- `r2/` – bucket creation and lifecycle rules (Cloudflare API). Run once per environment.
- `aws/` – extra IAM policy for the Vercel-side IAM user (Remotion policies come from
  `pnpm --filter @ai-news/video lambda:policies`).
- Remotion Lambda deploy: `packages/video/scripts/deploy.ts`.
- Media Lambda deploy: `packages/media-lambda/template.yaml` (AWS SAM, container image).

See `docs/SETUP.md` for the order of operations.
