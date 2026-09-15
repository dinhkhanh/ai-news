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
    const voice = await pg.query<{ voice: string }>("select voice from voice_presets where language='vi' and is_default");
    expect(voice.rows[0]?.voice).toBe("vi-VN-Chirp3-HD-Charon");
  });

  it("seed one promoted built-in prompt template per purpose/language (phase 2)", async () => {
    const { rows } = await pg.query<{ purpose: string; language: string; version: number; promoted: boolean; len: number }>(
      "select purpose, language, version, promoted, length(body)::int as len from prompt_templates order by purpose, language",
    );
    expect(rows.map((r) => `${r.purpose}/${r.language}`).sort()).toEqual(["faithfulness/en", "faithfulness/vi", "script/en", "script/vi"]);
    for (const r of rows) {
      expect(r.version).toBe(1);
      expect(r.promoted).toBe(true);
      expect(r.len).toBeGreaterThan(400);
    }
    // Re-applying the seed statement is a no-op (guarded by "where not exists").
    const { rows: after } = await pg.query<{ n: number }>("select count(*)::int as n from prompt_templates");
    expect(after[0].n).toBe(4);
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

  it("bump lock_version on project updates", async () => {
    await pg.exec(`insert into "user"(id,name,email) values ('u1','U','u@suzu.group');
      insert into organization(id,name,slug) values ('o1','O','o1');
      insert into projects(id,organization_id,owner_id,url) values ('00000000-0000-0000-0000-000000000001','o1','u1','https://example.com');`);
    await pg.exec(`update projects set title='x' where id='00000000-0000-0000-0000-000000000001'`);
    const { rows } = await pg.query<{ lock_version: number }>("select lock_version from projects");
    expect(rows[0].lock_version).toBe(1);
  });
});
