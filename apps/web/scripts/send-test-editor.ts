/**
 * Phase 4 acceptance test without the browser: on a project that already has
 * a timeline, sends project/scene.regenerate.requested (voice | broll | music)
 * for the latest version and prints the resulting version: lineage, change
 * list, editor document, mix provenance, activity and costs. The editor's
 * save path (saveTimelineVersion → media Lambda re-mix → new version) is the
 * same code the regeneration step ends with, so this exercises it end to end.
 *
 *   INNGEST_DEV=1 pnpm --filter web exec tsx --env-file=.env.local scripts/send-test-editor.ts <projectId> [voice|broll|music] [sceneId] [--text "new voice-over"]
 * Requires `INNGEST_DEV=1 pnpm dev` and the Inngest dev server running.
 */
import postgres from "postgres";
import { Inngest } from "inngest";
import { projectSceneRegenerateRequested } from "../src/inngest/events";

const sql = postgres(process.env.DATABASE_DIRECT_URL ?? process.env.DATABASE_URL!, { prepare: false, max: 1 });
const inngest = new Inngest({ id: "ai-news" });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type TimelineRow = { id: string; version: number; kind: string; parent_id: string | null; changes: string[]; duration_sec: string; json: { scenes: Array<{ id: string; kind: string; durationFrames: number; visual: { kind: string }; voiceSrc: string | null }>; captions: unknown[]; audio: { mixSrc: string | null }; coverAtSec: number | null }; build_json: { doc?: { scenes: Array<{ id: string; voice: { key: string } | null }> }; mix?: { mixKey: string; signature: string; reused: boolean; integratedLufs: number | null } } };

const latest = async (projectId: string) => (await sql<TimelineRow[]>`select id, version, kind, parent_id, changes, duration_sec, json, build_json from timelines where project_id = ${projectId} order by version desc limit 1`)[0];

async function main() {
  const args = process.argv.slice(2);
  const projectId = args[0];
  if (!projectId) throw new Error("usage: send-test-editor.ts <projectId> [voice|broll|music] [sceneId] [--text ...]");
  const what = (["voice", "broll", "music"].includes(args[1]) ? args[1] : "voice") as "voice" | "broll" | "music";
  const textIdx = args.indexOf("--text");
  const voiceover = textIdx >= 0 ? args[textIdx + 1] : undefined;
  const sceneId = what === "music" ? undefined : (args.find((a, i) => i >= 2 && !a.startsWith("--") && (textIdx < 0 || i !== textIdx + 1)) ?? "s1");

  const [p] = await sql<{ organization_id: string; owner_id: string; state: string; title: string | null; approved_timeline_id: string | null }[]>`select organization_id, owner_id, state, title, approved_timeline_id from projects where id = ${projectId}`;
  if (!p) throw new Error("project not found");
  const before = await latest(projectId);
  if (!before) throw new Error("project has no timeline; run send-test-media.ts first");
  console.log(`project ${projectId} "${p.title}" state=${p.state} latest timeline v${before.version} (${before.kind}) doc=${before.build_json.doc ? "stored" : "reconstructed"} approved=${p.approved_timeline_id === before.id}`);

  await sql`update projects set busy_step = 'regenerate', last_error = null where id = ${projectId}`;
  const evt = await inngest.send(projectSceneRegenerateRequested.create({ projectId, organizationId: p.organization_id, requestedBy: p.owner_id, timelineId: before.id, what, sceneId, voiceover }));
  console.log(`sent ${evt.ids[0]} (${what}${sceneId ? ` ${sceneId}` : ""}${voiceover ? ` text="${voiceover.slice(0, 40)}…"` : ""})`);

  const started = Date.now();
  for (;;) {
    await sleep(4000);
    const [x] = await sql<{ state: string; busy_step: string | null; last_error: string | null }[]>`select state, busy_step, last_error from projects where id = ${projectId}`;
    const elapsed = Math.round((Date.now() - started) / 1000);
    console.log(`${elapsed}s state=${x.state} busy=${x.busy_step ?? "-"}${x.last_error ? ` error=${x.last_error.slice(0, 160)}` : ""}`);
    if (!x.busy_step) {
      if (x.last_error) throw new Error(x.last_error);
      break;
    }
    if (elapsed > 600) throw new Error("timed out");
  }

  const after = await latest(projectId);
  if (after.id === before.id) throw new Error("no new timeline version was created");
  console.log(`\n=== timeline v${after.version} (${after.kind}) parent=${after.parent_id === before.id ? `v${before.version}` : after.parent_id} ${after.duration_sec}s, ${after.json.scenes.length} scenes, ${after.json.captions.length} captions`);
  console.log("changes:", after.changes.join(" · "));
  console.log("mix:", JSON.stringify(after.build_json.mix));
  console.log("doc stored:", Boolean(after.build_json.doc), "| voice keys:", after.build_json.doc?.scenes.map((s) => `${s.id}:${s.voice?.key.split("/").pop()}`).join(" "));
  for (const sc of after.json.scenes) console.log(`  [${sc.id} ${sc.kind}] ${(sc.durationFrames / 30).toFixed(1)}s visual=${sc.visual.kind} voiceSrc=${sc.voiceSrc?.split("/").pop() ?? "-"}`);
  console.log("audio.mixSrc:", after.json.audio.mixSrc, "coverAtSec:", after.json.coverAtSec);
  const [proj] = await sql<{ state: string; approved_timeline_id: string | null }[]>`select state, approved_timeline_id from projects where id = ${projectId}`;
  console.log("project:", proj);
  const events = await sql<{ type: string; payload: Record<string, unknown> }[]>`select type, payload from activity_events where project_id = ${projectId} order by id desc limit 4`;
  console.log("activity (latest first):", events.map((e) => `${e.type}${e.type.startsWith("timeline") ? ` v${e.payload.version} remixed=${e.payload.remixed}` : ""}`).join(" ← "));
  const costs = await sql<{ provider: string; n: string; cost: string }[]>`select provider, count(*) as n, sum(cost_usd) as cost from usage_costs where project_id = ${projectId} and created_at > now() - interval '15 minutes' group by provider`;
  console.log("usage_costs (15 min):", costs.map((c) => `${c.provider}×${c.n} $${Number(c.cost).toFixed(4)}`).join(" | ") || "none");
  console.log(`\nopen http://localhost:3000/app/projects/${projectId}/edit`);
  await sql.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
