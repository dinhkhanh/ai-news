# ai-news

News article URL → short vertical video → Facebook Reels, TikTok, YouTube Shorts. Internal tool for `suzu.group`.

- Plan: [`docs/PLAN.md`](docs/PLAN.md)
- Setup: [`docs/SETUP.md`](docs/SETUP.md)
- External filings: [`docs/REQUESTS.md`](docs/REQUESTS.md)

```sh
pnpm install
cp .env.example apps/web/.env.local   # fill in
pnpm db:migrate                        # DATABASE_DIRECT_URL
pnpm dev                               # http://localhost:3000
pnpm --filter web inngest:dev          # Inngest dev server (with INNGEST_DEV=1)
```

Workspace: `apps/web` (Next.js + admin), `packages/video` (Remotion), `packages/media-lambda` (FFmpeg Lambda), `infra/`.
