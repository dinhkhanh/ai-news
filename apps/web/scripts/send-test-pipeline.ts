/**
 * Phase 2 acceptance test without the browser: creates a project for the first
 * platform admin's personal workspace, sends project/fetch.requested, waits for
 * the article, confirms it, sends project/script.requested and prints the
 * script + faithfulness result.
 *
 *   INNGEST_DEV=1 pnpm --filter web exec tsx --env-file=.env.local scripts/send-test-pipeline.ts <article-url> [durationSec] [tone] [--fetch-only]
 * Requires `INNGEST_DEV=1 pnpm dev` and `pnpm --filter web inngest:dev` running.
 */
import postgres from "postgres";
import { Inngest } from "inngest";
import { projectFetchRequested, projectScriptRequested } from "../src/inngest/events";

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

async function waitFor(projectId: string, eventId: string, done: (p: { state: string; busy_step: string | null; last_error: string | null }) => boolean, label: string) {
  const started = Date.now();
  for (;;) {
    await sleep(4000);
    const [p] = await sql<{ state: string; busy_step: string | null; last_error: string | null }[]>`select state, busy_step, last_error from projects where id = ${projectId}`;
    const elapsed = Math.round((Date.now() - started) / 1000);
    console.log(`${elapsed}s ${label}: state=${p.state} busy=${p.busy_step ?? "-"}${p.last_error ? ` error=${p.last_error.slice(0, 160)}` : ""}`);
    if (done(p)) return p;
    if (p.state === "failed" || (!p.busy_step && p.last_error)) throw new Error(`${label} failed: ${p.last_error}`);
    const run = await runFailed(eventId);
    if (run) throw new Error(`${label} run ${run.status}: ${JSON.stringify(run.output ?? run).slice(0, 1500)}`);
    if (elapsed > 600) throw new Error(`${label} timed out`);
  }
}

async function main() {
  const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const fetchOnly = process.argv.includes("--fetch-only");
  const url = args[0];
  if (!url) throw new Error("usage: send-test-pipeline.ts <article-url> [durationSec] [tone] [--fetch-only]");
  const durationSec = Number(args[1] ?? 60);
  const tone = args[2] ?? "news";

  const [admin] = await sql<{ id: string; email: string; org: string }[]>`
    select u.id, u.email, o.id as org from "user" u
    join organization o on o.owner_user_id = u.id and o.kind = 'personal'
    where u.platform_role = 'admin' order by u.created_at limit 1`;
  if (!admin) throw new Error("no admin user with a personal workspace");

  const [project] = await sql<{ id: string }[]>`
    insert into projects (organization_id, owner_id, url, canonical_url, duration_sec, tone, busy_step)
    values (${admin.org}, ${admin.id}, ${url}, ${url}, ${durationSec}, ${tone}, 'fetch') returning id`;
  console.log(`project ${project.id} for ${admin.email}`);

  const fetchEvt = await inngest.send(projectFetchRequested.create({ projectId: project.id, organizationId: admin.org, requestedBy: admin.id }));
  console.log(`sent ${fetchEvt.ids[0]} (fetch)`);
  await waitFor(project.id, fetchEvt.ids[0], (p) => p.state === "fetched" && !p.busy_step, "fetch");

  const [article] = await sql<{ id: string; title: string | null; word_count: number; fetch_method: string; language: string; flags: unknown; site_name: string | null; screenshot_path: string | null; snapshot_path: string | null }[]>`
    select id, title, word_count, fetch_method, language, flags, site_name, screenshot_path, snapshot_path from articles where project_id = ${project.id} order by created_at desc limit 1`;
  const [proj] = await sql<{ sensitive_topic: boolean; language: string }[]>`select sensitive_topic, language from projects where id = ${project.id}`;
  console.log(JSON.stringify({ article: { ...article, sensitiveTopic: proj.sensitive_topic } }, null, 2));
  if (fetchOnly) {
    console.log(`fetch only; open http://localhost:3000/app/projects/${project.id}`);
    await sql.end();
    return;
  }

  await sql`update articles set confirmed_at = now(), confirmed_by = ${admin.id} where id = ${article.id}`;
  await sql`update projects set busy_step = 'script' where id = ${project.id}`;
  const scriptEvt = await inngest.send(projectScriptRequested.create({ projectId: project.id, organizationId: admin.org, requestedBy: admin.id, durationSec, tone }));
  console.log(`sent ${scriptEvt.ids[0]} (script)`);
  await waitFor(project.id, scriptEvt.ids[0], (p) => p.state === "scripted" && !p.busy_step, "script");

  const [script] = await sql<{ version: number; model: string; cost_usd: string; input_tokens: number; output_tokens: number; scenes_json: Record<string, unknown>; faithfulness_json: Record<string, unknown> | null }[]>`
    select version, model, cost_usd, input_tokens, output_tokens, scenes_json, faithfulness_json from scripts where project_id = ${project.id} order by version desc limit 1`;
  const s = script.scenes_json as { title: string; scenes: Array<{ id: string; kind: string; durationSec: number; voiceover: string; onScreenText: string; brollTerms: string[] }>; estimatedDurationSec: number; metadata: unknown; notes: string | null; generation: unknown };
  const f = script.faithfulness_json as { counts?: unknown; summary?: string; scenes?: Array<{ sceneId: string; verdict: string; note: string | null }> } | null;
  console.log(`\n=== ${s.title} (v${script.version}, ${script.model}, $${script.cost_usd}, ${script.input_tokens}+${script.output_tokens} tokens, est ${s.estimatedDurationSec}s)`);
  for (const sc of s.scenes) {
    const v = f?.scenes?.find((x) => x.sceneId === sc.id);
    console.log(`[${sc.id} ${sc.kind} ${sc.durationSec}s ${v?.verdict ?? "unchecked"}] ${sc.voiceover}`);
    console.log(`    on-screen: ${sc.onScreenText} | b-roll: ${sc.brollTerms.join(", ")}${v?.note ? `\n    note: ${v.note}` : ""}`);
  }
  console.log("notes:", s.notes);
  console.log("faithfulness:", JSON.stringify(f?.counts), f?.summary);
  console.log("metadata:", JSON.stringify(s.metadata, null, 1));
  console.log("generation:", JSON.stringify(s.generation));
  const costs = await sql<{ provider: string; resource: string; cost: string; meta: unknown }[]>`select provider, resource, cost_usd as cost, meta from usage_costs where project_id = ${project.id} order by id`;
  console.log("usage_costs:", JSON.stringify(costs));
  const events = await sql<{ type: string }[]>`select type from activity_events where project_id = ${project.id} order by id`;
  console.log("activity:", events.map((e) => e.type).join(" → "));
  console.log(`\nopen http://localhost:3000/app/projects/${project.id}`);
  await sql.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
