import postgres from "postgres";
import { readFileSync } from "node:fs";
const env = Object.fromEntries(readFileSync(".env.local","utf8").split("\n").filter(l=>/^[A-Z_]+=/.test(l)).map(l=>{const i=l.indexOf("=");return [l.slice(0,i), l.slice(i+1).replace(/^"|"$/g,"")]}));
const race = (p, ms=20000) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout ${ms}ms`)), ms))]);
async function trial(label, opts, body) {
  const sql = postgres(env.DATABASE_URL, { prepare:false, max:2, idle_timeout:20, connect_timeout:10, ...opts });
  const s = performance.now();
  try { await race(body(sql)); console.log(label.padEnd(44), "ok", (performance.now()-s).toFixed(0)+" ms"); }
  catch (e) { console.log(label.padEnd(44), "FAIL", (performance.now()-s).toFixed(0)+" ms", e.message); }
  await race(sql.end({ timeout: 2 }), 5000).catch(()=>{});
}
await trial("A: 2 concurrent select 1 (cold pool)", {}, (sql) => Promise.all([sql`select 1`, sql`select 2`]));
await trial("B: warm 1, then 2 concurrent", {}, async (sql) => { await sql`select 1`; await Promise.all([sql`select 1`, sql`select 2`]); });
await trial("C: warm 1, then 3 concurrent", {}, async (sql) => { await sql`select 1`; await Promise.all([sql`select 1`, sql`select 2`, sql`select 3`]); });
await trial("D: 7 concurrent counts (cold)", {}, (sql) => Promise.all([sql`select count(*) from "user"`, sql`select count(*) from organization`, sql`select count(*) from projects`, sql`select count(*) from renders`, sql`select count(*) from activity_events`, sql`select sum(cost_usd) from usage_costs`, sql`select provider from usage_costs group by provider`]));
await trial("E: same 7 with max=1", { max: 1 }, (sql) => Promise.all([sql`select count(*) from "user"`, sql`select count(*) from organization`, sql`select count(*) from projects`, sql`select count(*) from renders`, sql`select count(*) from activity_events`, sql`select sum(cost_usd) from usage_costs`, sql`select provider from usage_costs group by provider`]));
await trial("F: 2 concurrent on DIRECT url (session pooler)", { }, async (sql) => { const d = postgres(env.DATABASE_DIRECT_URL, { prepare:false, max:2, connect_timeout:10 }); try { await Promise.all([d`select 1`, d`select 2`]); } finally { await d.end({timeout:2}); } });
process.exit(0);
