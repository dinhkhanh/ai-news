import postgres from "postgres";
import { readFileSync } from "node:fs";
const env = Object.fromEntries(readFileSync(".env.local","utf8").split("\n").filter(l=>/^[A-Z_]+=/.test(l)).map(l=>{const i=l.indexOf("=");return [l.slice(0,i), l.slice(i+1).replace(/^"|"$/g,"")]}));
for (const max of [2, 7]) {
  const sql = postgres(env.DATABASE_URL, { prepare:false, max, idle_timeout:20, connect_timeout:10 });
  await sql`select 1`;
  const since = new Date(Date.now() - 30*24*3600*1000);
  const qs = {
    users: () => sql`select count(*) from "user"`,
    orgs: () => sql`select count(*) from organization`,
    projects: () => sql`select count(*) from projects`,
    renders: () => sql`select count(*) from renders`,
    events30d: () => sql`select count(*) from activity_events where created_at >= ${since}`,
    costs30d: () => sql`select sum(cost_usd) from usage_costs where created_at >= ${since}`,
    byProvider: () => sql`select provider, coalesce(sum(cost_usd),0) from usage_costs where created_at >= ${since} group by provider order by sum(cost_usd) desc`,
  };
  if (max === 2) for (const [n,q] of Object.entries(qs)) { const s=performance.now(); const r=await q(); console.log(n.padEnd(12), (performance.now()-s).toFixed(0).padStart(5)+" ms", JSON.stringify(r[0])); }
  const s = performance.now(); await Promise.all(Object.values(qs).map(q=>q())); console.log(`all 7 in parallel, pool max=${max}:`, (performance.now()-s).toFixed(0)+" ms");
  await sql.end();
}
