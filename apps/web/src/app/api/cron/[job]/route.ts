import { timingSafeEqual } from "node:crypto";
import { after, NextResponse, type NextRequest } from "next/server";
import { CRON_JOBS, isCronJob, type CronJob } from "@/lib/cron-jobs";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * GET|POST /api/cron/<job> with `Authorization: Bearer $CRON_SECRET` (the header Vercel Cron sends on its own;
 * pg_cron + pg_net and a plain curl send the same). Without `CRON_SECRET` the route is closed, never open.
 * The job runs in `after()` and the answer is an immediate 202, because HTTP schedulers give up after a few
 * seconds (pg_net: 5 s by default); `?wait=1` runs it inline and returns the result, for a manual check.
 */
function authorised(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return null;
  const given = Buffer.from(req.headers.get("authorization") ?? "");
  const wanted = Buffer.from(`Bearer ${secret}`);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}

async function runJob(job: CronJob) {
  const t0 = Date.now();
  try {
    const result = await CRON_JOBS[job].run();
    console.log(`[cron] ${job} done in ${Date.now() - t0} ms`, JSON.stringify(result).slice(0, 1000));
    return { ok: true as const, job, ms: Date.now() - t0, result };
  } catch (e) {
    console.error(`[cron] ${job} failed`, e);
    return { ok: false as const, job, ms: Date.now() - t0, error: e instanceof Error ? e.message : String(e) };
  }
}

async function handle(req: NextRequest, ctx: { params: Promise<{ job: string }> }) {
  const ok = authorised(req);
  if (ok === null) return NextResponse.json({ error: "CRON_SECRET is not set" }, { status: 503 });
  if (!ok) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { job } = await ctx.params;
  if (!isCronJob(job)) return NextResponse.json({ error: "Unknown job", jobs: Object.keys(CRON_JOBS) }, { status: 404 });
  if (req.nextUrl.searchParams.get("wait") === "1") {
    const out = await runJob(job);
    return NextResponse.json(out, { status: out.ok ? 200 : 500 });
  }
  after(() => runJob(job));
  return NextResponse.json({ accepted: job }, { status: 202 });
}

export const GET = handle;
export const POST = handle;
