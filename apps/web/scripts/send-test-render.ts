/**
 * Sends render/test.requested for the first platform admin's personal
 * workspace and polls the renders table until the run finishes.
 * Local:  INNGEST_DEV=1 pnpm exec tsx --env-file=.env.local scripts/send-test-render.ts
 * Cloud:  pnpm exec tsx --env-file=.env.local scripts/send-test-render.ts   (uses INNGEST_EVENT_KEY)
 */
import postgres from "postgres";
import { Inngest } from "inngest";
import { testRenderRequested } from "../src/inngest/events";

const sql = postgres(process.env.DATABASE_DIRECT_URL ?? process.env.DATABASE_URL!, { prepare: false, max: 1 });

async function main() {
  const [admin] = await sql<{ id: string; email: string; org: string }[]>`
    select u.id, u.email, o.id as org from "user" u
    join organization o on o.owner_user_id = u.id and o.kind = 'personal'
    where u.platform_role = 'admin' order by u.created_at limit 1`;
  if (!admin) throw new Error("no admin user with a personal workspace");
  const durationSec = Number(process.argv[2] ?? 6);
  const inngest = new Inngest({ id: "ai-news" });
  const before = await sql<{ n: number }[]>`select count(*)::int as n from renders`;
  const { ids } = await inngest.send(
    testRenderRequested.create({ requestedBy: admin.id, organizationId: admin.org, title: "ai-news phase 1 test render", durationSec }),
  );
  console.log(`sent ${ids[0]} for ${admin.email} (org ${admin.org}), ${durationSec}s`);

  const started = Date.now();
  for (;;) {
    await new Promise((r) => setTimeout(r, 5000));
    const rows = await sql<{ id: string; status: string; error: string | null; output_path: string | null; cost_usd: string | null; duration_sec: string | null; qa_json: Record<string, unknown> | null }[]>`
      select id, status, error, output_path, cost_usd, duration_sec, qa_json from renders order by created_at desc limit 1`;
    const r = rows[0];
    const n = (await sql<{ n: number }[]>`select count(*)::int as n from renders`)[0].n;
    const elapsed = Math.round((Date.now() - started) / 1000);
    if (n === before[0].n || !r) {
      console.log(`${elapsed}s: waiting for function to pick up the event`);
    } else {
      console.log(`${elapsed}s: render ${r.id} ${r.status}${r.error ? ` (${r.error.slice(0, 120)})` : ""}`);
      if (["done", "failed", "qa_failed"].includes(r.status)) {
        console.log(JSON.stringify({ output: r.output_path, costUsd: r.cost_usd, durationSec: r.duration_sec, qa: r.qa_json }, null, 2));
        break;
      }
    }
    // In dev mode also watch the run itself so an early step failure ends the poll.
    if (process.env.INNGEST_DEV) {
      try {
        const res = await fetch(`http://localhost:8288/v1/events/${ids[0]}/runs`);
        if (res.ok) {
          const { data } = (await res.json()) as { data: Array<{ status: string; output?: unknown }> };
          const run = data[0];
          if (run && ["Failed", "Cancelled"].includes(run.status)) {
            console.log(`run ${run.status}:`, JSON.stringify(run.output).slice(0, 1500));
            break;
          }
        }
      } catch {
        /* dev server not reachable; keep polling the table */
      }
    }
    if (elapsed > 600) throw new Error("timed out after 10 min");
  }
  await sql.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
