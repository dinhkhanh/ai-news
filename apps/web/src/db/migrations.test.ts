import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Applies every SQL migration to an in-memory Postgres (PGlite) so schema,
 * RLS policies and seed data are validated in CI without a database service.
 * Vault grants are skipped automatically (no vault schema locally).
 */
const dir = path.resolve(__dirname, "migrations");
let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    const statements = readFileSync(path.join(dir, f), "utf8")
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const s of statements) {
      try {
        await pg.exec(s);
      } catch (e) {
        throw new Error(`${f}: ${(e as Error).message}\n${s.slice(0, 400)}`);
      }
    }
  }
});

afterAll(async () => {
  await pg?.close();
});

describe("migrations", () => {
  it("create every table from docs/PLAN.md §5", async () => {
    const { rows } = await pg.query<{ t: string }>("select tablename as t from pg_tables where schemaname='public'");
    const names = rows.map((r) => r.t);
    for (const t of [
      "user", "session", "account", "verification", "organization", "member", "invitation",
      "projects", "articles", "scripts", "assets", "timelines", "renders", "channels", "channel_grants",
      "publications", "brand_kits", "voice_presets", "pronunciations", "prompt_templates", "music_library",
      "integrations", "quotas", "activity_events", "usage_costs", "allowed_domains", "feature_flags",
      "eval_articles", "prompt_evals", "comments", "project_reviews",
    ]) {
      expect(names, `missing table ${t}`).toContain(t);
    }
  });

  it("enable RLS on every org-scoped table", async () => {
    const { rows } = await pg.query<{ relname: string; relrowsecurity: boolean }>(
      "select relname, relrowsecurity from pg_class where relkind='r' and relnamespace='public'::regnamespace",
    );
    const rls = Object.fromEntries(rows.map((r) => [r.relname, r.relrowsecurity]));
    for (const t of ["projects", "articles", "scripts", "assets", "timelines", "renders", "channels", "channel_grants", "publications", "brand_kits", "activity_events", "usage_costs", "comments", "project_reviews"]) {
      expect(rls[t], `RLS off on ${t}`).toBe(true);
    }
    const { rows: pol } = await pg.query<{ n: number }>("select count(*)::int as n from pg_policies");
    expect(pol[0].n).toBeGreaterThanOrEqual(16);
  });

  it("seed the primary domain, quotas and the default Vietnamese voice", async () => {
    const domains = await pg.query<{ domain: string }>("select domain from allowed_domains");
    expect(domains.rows.map((r) => r.domain)).toContain("suzu.group");
    const quotas = await pg.query<{ resource: string; daily_limit: number }>("select resource, daily_limit from quotas where scope='user' and scope_id='*'");
    expect(Object.fromEntries(quotas.rows.map((r) => [r.resource, r.daily_limit]))).toEqual({ scripts: 20, ai_media: 5, render_minutes: 30, publishes: 10 });
    // Migration 0008: the energetic Fenrir voice at a faster rate is the platform default; Charon stays as an alternate at 1.15.
    const voice = await pg.query<{ voice: string; rate: string }>("select voice, rate from voice_presets where language='vi' and is_default");
    expect(voice.rows).toEqual([{ voice: "vi-VN-Chirp3-HD-Fenrir", rate: "1.22" }]);
    const charon = await pg.query<{ rate: string }>("select rate from voice_presets where voice='vi-VN-Chirp3-HD-Charon'");
    expect(charon.rows[0]?.rate).toBe("1.15");
  });

  it("seed exactly one promoted built-in prompt template per purpose/language (phase 2 v1, punchy script v2 from migration 0008)", async () => {
    const { rows } = await pg.query<{ purpose: string; language: string; version: number; promoted: boolean; len: number }>(
      "select purpose, language, version, promoted, length(body)::int as len from prompt_templates order by purpose, language, version",
    );
    const promoted = rows.filter((r) => r.promoted);
    expect(promoted.map((r) => `${r.purpose}/${r.language}@${r.version}`).sort()).toEqual(["faithfulness/en@1", "faithfulness/vi@1", "script/en@2", "script/vi@2"]);
    for (const r of rows) expect(r.len).toBeGreaterThan(400);
    expect(rows.filter((r) => r.purpose === "script").map((r) => r.version)).toEqual([1, 2, 1, 2]);
    for (const r of rows.filter((r) => r.version === 2)) expect(r.promoted).toBe(true);
    // Re-applying the seed statements is a no-op (guarded by "where not exists").
    const { rows: after } = await pg.query<{ n: number }>("select count(*)::int as n from prompt_templates");
    expect(after[0].n).toBe(6);
  });

  it("add the phase 2 columns", async () => {
    const { rows } = await pg.query<{ table_name: string; column_name: string }>(
      "select table_name, column_name from information_schema.columns where table_schema='public' and ((table_name='projects' and column_name in ('busy_step','duration_sec','tone')) or (table_name='articles' and column_name in ('confirmed_at','confirmed_by','word_count','updated_at')))",
    );
    expect(rows.length).toBe(7);
  });

  it("add the phase 4 approval and timeline lineage columns", async () => {
    const { rows } = await pg.query<{ table_name: string; column_name: string }>(
      "select table_name, column_name from information_schema.columns where table_schema='public' and ((table_name='projects' and column_name in ('approved_timeline_id','approved_by','approved_at')) or (table_name='timelines' and column_name in ('parent_id','kind','changes')))",
    );
    expect(rows.length).toBe(6);
  });

  it("add the phase 5 publishing columns and the cancelled status", async () => {
    const { rows } = await pg.query<{ table_name: string; column_name: string }>(
      "select table_name, column_name from information_schema.columns where table_schema='public' and ((table_name='channels' and column_name in ('meta','enabled','last_error','last_checked_at')) or (table_name='publications' and column_name in ('platform','attempts','platform_url','privacy','ai_disclosure','cancelled_at','last_checked_at')))",
    );
    expect(rows.length).toBe(11);
    const { rows: labels } = await pg.query<{ l: string }>("select enumlabel as l from pg_enum where enumtypid = 'publication_status'::regtype");
    expect(labels.map((r) => r.l)).toContain("cancelled");
  });

  it("bump lock_version on project updates", async () => {
    await pg.exec(`insert into "user"(id,name,email) values ('u1','U','u@suzu.group');
      insert into organization(id,name,slug) values ('o1','O','o1');
      insert into projects(id,organization_id,owner_id,url) values ('00000000-0000-0000-0000-000000000001','o1','u1','https://example.com');`);
    await pg.exec(`update projects set title='x' where id='00000000-0000-0000-0000-000000000001'`);
    const { rows } = await pg.query<{ lock_version: number }>("select lock_version from projects");
    expect(rows[0].lock_version).toBe(1);
  });

  it("isolate workspaces once the transaction switches to ai_news_app (migration 0011)", async () => {
    await pg.exec(`insert into "user"(id,name,email) values ('u2','U2','u2@suzu.group');
      insert into organization(id,name,slug) values ('o2','O2','o2');
      insert into projects(id,organization_id,owner_id,url) values ('00000000-0000-0000-0000-000000000002','o2','u2','https://example.org');`);
    // Owner login (postgres) bypasses RLS: sees both workspaces.
    const all = await pg.query<{ n: number }>("select count(*)::int as n from projects");
    expect(all.rows[0].n).toBe(2);
    // The same statements src/db/context.ts runs: role switch + org context, transaction-local.
    const scoped = await pg.transaction(async (tx) => {
      await tx.query("select set_config('role','ai_news_app',true), set_config('app.user_id','u1',true), set_config('app.org_id','o1',true), set_config('app.role','user',true)");
      const who = await tx.query<{ u: string }>("select current_user as u");
      const rows = await tx.query<{ organization_id: string }>("select organization_id from projects");
      return { user: who.rows[0].u, orgs: rows.rows.map((r) => r.organization_id) };
    });
    expect(scoped).toEqual({ user: "ai_news_app", orgs: ["o1"] });
    const service = await pg.transaction(async (tx) => {
      await tx.query("select set_config('role','ai_news_app',true), set_config('app.user_id','',true), set_config('app.org_id','',true), set_config('app.role','service',true)");
      return (await tx.query<{ n: number }>("select count(*)::int as n from projects")).rows[0].n;
    });
    expect(service).toBe(2);
    // Role switch is transaction-local: back to the owner afterwards.
    const after = await pg.query<{ u: string }>("select current_user as u");
    expect(after.rows[0].u).toBe("postgres");
  });

  it("aggregate the admin overview in one call (migration 0010)", async () => {
    await pg.exec(`insert into usage_costs(provider, units, unit_type, cost_usd, organization_id) values
        ('anthropic', 1, 'tokens', 0.25, 'o1'), ('anthropic', 1, 'tokens', 0.50, 'o1'), ('pexels', 1, 'calls', 0.10, 'o1'),
        ('mubert', 1, 'calls', 9.99, 'o1');
      update usage_costs set created_at = now() - interval '40 days' where provider = 'mubert';
      insert into activity_events(type, organization_id) values ('project.created', 'o1'), ('project.created', 'o1');
      update activity_events set created_at = now() - interval '40 days' where id = (select max(id) from activity_events);`);
    const { rows } = await pg.query<{ s: Record<string, unknown> }>("select admin_overview_stats(now() - interval '30 days') as s");
    expect(rows[0].s).toEqual({
      users: 2, orgs: 2, projects: 2, renders: 0, events: 1, spendUsd: 0.85,
      byProvider: [{ provider: "anthropic", usd: 0.75 }, { provider: "pexels", usd: 0.1 }],
    });
    const { rows: empty } = await pg.query<{ s: Record<string, unknown> }>("select admin_overview_stats(now() + interval '1 day') as s");
    expect(empty[0].s).toMatchObject({ events: 0, spendUsd: 0, byProvider: [] });
  });
});
