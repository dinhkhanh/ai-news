/**
 * Phase 3 acceptance test without the browser: for a project that already has
 * a script, sends project/assets.requested (TTS + B-roll + music + mix →
 * timeline), then project/render.requested (Remotion Lambda → loudnorm → QA),
 * and prints what was built, the QA result, costs and activity.
 *
 *   INNGEST_DEV=1 pnpm --filter web exec tsx --env-file=.env.local scripts/send-test-media.ts <projectId> [--assets-only] [--render-only] [--skip-stock]
 * Requires `INNGEST_DEV=1 pnpm dev` and the Inngest dev server running.
 */
import postgres from "postgres";
import { Inngest } from "inngest";
import { projectAssetsRequested, projectRenderRequested } from "../src/inngest/events";

const sql = postgres(process.env.DATABASE_DIRECT_URL ?? process.env.DATABASE_URL!, { prepare: false, max: 1 });
const inngest = new Inngest({ id: "ai-news" });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function runFailed(eventId: string) {
  if (!process.env.INNGEST_DEV) return null;
  try {
    const res = await fetch(`http://localhost:8288/v1/events/${eventId}/runs`);
    if (!res.ok) return null;
    const { data } = (await res.json()) as { data: Array<{ status: string; output?: unknown }> };
    const run = data[0];
    return run && ["Failed", "Cancelled"].includes(run.status) ? run : null;
  } catch {
    return null;
  }
}

async function waitFor(projectId: string, eventId: string, done: (p: { state: string; busy_step: string | null; last_error: string | null }) => boolean, label: string, timeoutSec = 900) {
  const started = Date.now();
  for (;;) {
    await sleep(5000);
    const [p] = await sql<{ state: string; busy_step: string | null; last_error: string | null }[]>`select state, busy_step, last_error from projects where id = ${projectId}`;
    const elapsed = Math.round((Date.now() - started) / 1000);
    console.log(`${elapsed}s ${label}: state=${p.state} busy=${p.busy_step ?? "-"}${p.last_error ? ` error=${p.last_error.slice(0, 160)}` : ""}`);
    if (done(p)) return p;
    if (!p.busy_step && p.last_error) throw new Error(`${label} failed: ${p.last_error}`);
    const run = await runFailed(eventId);
    if (run) throw new Error(`${label} run ${run.status}: ${JSON.stringify(run.output ?? run).slice(0, 1500)}`);
    if (elapsed > timeoutSec) throw new Error(`${label} timed out`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const projectId = args.find((a) => !a.startsWith("--"));
  if (!projectId) throw new Error("usage: send-test-media.ts <projectId> [--assets-only] [--render-only] [--skip-stock]");
  const assetsOnly = args.includes("--assets-only");
  const renderOnly = args.includes("--render-only");
  const skipStock = args.includes("--skip-stock");

  const [p] = await sql<{ organization_id: string; owner_id: string; state: string; title: string | null }[]>`select organization_id, owner_id, state, title from projects where id = ${projectId}`;
  if (!p) throw new Error("project not found");
  console.log(`project ${projectId} "${p.title}" state=${p.state}`);
  const ctx = { projectId, organizationId: p.organization_id, requestedBy: p.owner_id };

  if (!renderOnly) {
    await sql`update projects set busy_step = 'assets', last_error = null where id = ${projectId}`;
    const evt = await inngest.send(projectAssetsRequested.create({ ...ctx, skipStock }));
    console.log(`sent ${evt.ids[0]} (assets)`);
    await waitFor(projectId, evt.ids[0], (x) => x.state === "composed" && !x.busy_step, "assets");
    const [t] = await sql<{ id: string; version: number; duration_sec: string; json: { scenes: Array<{ id: string; kind: string; durationFrames: number; visual: { kind: string }; credit: string | null }>; captions: unknown[]; attribution: string[] }; build_json: Record<string, unknown> }[]>`
      select id, version, duration_sec, json, build_json from timelines where project_id = ${projectId} order by version desc limit 1`;
    console.log(`\n=== timeline v${t.version} ${t.duration_sec}s, ${t.json.scenes.length} scenes, ${t.json.captions.length} captions`);
    for (const sc of t.json.scenes) console.log(`  [${sc.id} ${sc.kind}] ${(sc.durationFrames / 30).toFixed(1)}s visual=${sc.visual.kind} ${sc.credit ?? ""}`);
    console.log("attribution:", t.json.attribution.join(" · "));
    const b = t.build_json as { voice?: { scenes: Array<{ sceneId: string; timing: string; matched: number; words: number; durationMs: number }> }; music?: unknown; musicError?: string | null; mix?: unknown; stockEnabled?: boolean };
    console.log("voice:", (b.voice?.scenes ?? []).map((s) => `${s.sceneId}:${s.timing}${s.timing === "stt" ? `(${s.matched}/${s.words})` : ""} ${(s.durationMs / 1000).toFixed(1)}s`).join("  "));
    console.log("music:", JSON.stringify(b.music), b.musicError ? `error=${b.musicError}` : "", "stockEnabled:", b.stockEnabled);
    console.log("mix:", JSON.stringify(b.mix));
    if (assetsOnly) {
      await printCosts(projectId);
      await sql.end();
      return;
    }
  }

  await sql`update projects set busy_step = 'render', last_error = null where id = ${projectId}`;
  const evt = await inngest.send(projectRenderRequested.create(ctx));
  console.log(`sent ${evt.ids[0]} (render)`);
  // Phase 4: only a render of the approved timeline moves the project to `rendered`; other renders are previews.
  await waitFor(projectId, evt.ids[0], (x) => !x.busy_step, "render");
  const [r] = await sql<{ id: string; status: string; timeline_id: string | null; timeline_version: number | null; output_path: string | null; cover_path: string | null; duration_sec: string | null; cost_usd: string | null; render_seconds: string | null; qa_json: { probe?: unknown; checks?: unknown; error?: string } | null; error: string | null }[]>`
    select id, status, timeline_id, timeline_version, output_path, cover_path, duration_sec, cost_usd, render_seconds, qa_json, error from renders where project_id = ${projectId} order by created_at desc limit 1`;
  const [pp] = await sql<{ state: string; approved_timeline_id: string | null }[]>`select state, approved_timeline_id from projects where id = ${projectId}`;
  console.log(`\n=== render ${r.id} status=${r.status} timeline v${r.timeline_version} (${r.timeline_id === pp.approved_timeline_id ? "approved" : "preview"}) ${r.duration_sec}s $${r.cost_usd} in ${r.render_seconds}s → project state=${pp.state}`);
  console.log("output:", r.output_path, "cover:", r.cover_path);
  console.log("probe:", JSON.stringify(r.qa_json?.probe));
  console.log("checks:", JSON.stringify(r.qa_json?.checks));
  if (r.error) console.log("error:", r.error);
  await printCosts(projectId);
  console.log(`\nopen http://localhost:3000/app/projects/${projectId}`);
  await sql.end();
}

async function printCosts(projectId: string) {
  const costs = await sql<{ provider: string; n: string; units: string; cost: string }[]>`select provider, count(*) as n, sum(units) as units, sum(cost_usd) as cost from usage_costs where project_id = ${projectId} group by provider order by provider`;
  console.log("usage_costs:", costs.map((c) => `${c.provider}×${c.n} ${Number(c.units).toFixed(1)}u $${Number(c.cost).toFixed(4)}`).join(" | "));
  const events = await sql<{ type: string }[]>`select type from activity_events where project_id = ${projectId} order by id`;
  console.log("activity:", events.map((e) => e.type).join(" → "));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
