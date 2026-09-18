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

  it("give every seeded script template the newsTerms rule next to brollTerms (migration 0019)", async () => {
    const { rows } = await pg.query<{ language: string; version: number; body: string }>("select language, version, body from prompt_templates where purpose = 'script' order by language, version");
    expect(rows).toHaveLength(4);
    for (const r of rows) {
      const i = r.body.indexOf(". brollTerms");
      expect(i, `${r.language}@${r.version}`).toBeGreaterThan(0);
      expect(r.body.indexOf("newsTerms"), `${r.language}@${r.version}`).toBeGreaterThan(i);
      expect(r.body.indexOf("newsTerms")).toBeLessThan(r.body.indexOf("\n9."));
    }
  });

  it("switch on the flags that are on by default (face_guard 0018, web_video_downloader 0020)", async () => {
    const { rows } = await pg.query<{ key: string; enabled: boolean }>("select key, enabled from feature_flags where key in ('face_guard','web_video_downloader') order by key");
    expect(rows).toEqual([{ key: "face_guard", enabled: true }, { key: "web_video_downloader", enabled: true }]);
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

  it("serve each admin page from one function call (migration 0013)", async () => {
    const one = async <T,>(q: string) => (await pg.query<{ d: T }>(q)).rows[0].d;
    await pg.exec(`insert into member(id, organization_id, user_id, role) values ('m1','o1','u1','owner'), ('m2','o2','u2','owner');
      insert into channels(id, organization_id, platform, external_id, name, healthy, expires_at) values
        ('00000000-0000-0000-0000-0000000000c1','o1','youtube','yt1','Chan A', true, now() + interval '1 day'),
        ('00000000-0000-0000-0000-0000000000c2','o2','tiktok','tt1','Chan B', false, null);
      insert into channel_grants(organization_id, channel_id, user_id) values ('o1','00000000-0000-0000-0000-0000000000c1','u1');
      insert into renders(id, organization_id, project_id, status, cost_usd) values ('00000000-0000-0000-0000-0000000000d1','o1','00000000-0000-0000-0000-000000000001','done', 0.1200);
      insert into publications(organization_id, project_id, render_id, channel_id, platform, status, published_at, analytics_json, idempotency_key, platform_url) values
        ('o1','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000c1','youtube','published', now(), '{"views": 100, "likes": 7}', 'k1', 'https://y/1'),
        ('o1','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000c1','youtube','published', now(), null, 'k2', null),
        ('o1','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000c1','youtube','failed', null, null, 'k3', null);
      insert into usage_costs(provider, units, unit_type, cost_usd, organization_id) values ('youtube_api', 1600, 'units', 0, 'o1');`);

    const a = await one<Record<string, unknown>>("select admin_analytics_stats(now() - interval '30 days', now() - interval '1 hour') as d");
    expect(a).toMatchObject({
      produced: 1, published: 2, ytUnitsToday: 1600, channels: 2, unhealthyChannels: 1,
      byStatus: { published: 2, failed: 1 },
      byPlatform: [{ platform: "youtube", posts: 2, views: 100, likes: 7, comments: 0, shares: 0 }],
    });
    // Posts without analytics sort last, not first.
    expect((a.topPosts as Array<{ views: number | null; title: string }>).map((p) => [p.views, p.title])).toEqual([[100, "x"], [null, "x"]]);
    expect((a.byDay as unknown[]).length).toBe(1);

    const c = await one<{ orgs: unknown[]; channels: Array<Record<string, unknown>>; members: unknown[]; grants: unknown[]; metaReady: boolean; flags: Record<string, boolean> }>(
      "select admin_channels_page() as d",
    );
    expect(c.orgs.length).toBe(2);
    expect(c.channels.map((x) => [x.name, x.hasToken, x.scopes])).toEqual([["Chan A", false, []], ["Chan B", false, []]]);
    expect(new Date(c.channels[0].expiresAt as string).getTime()).toBeGreaterThan(Date.now());
    expect(c.members).toContainEqual({ organizationId: "o1", userId: "u1", role: "owner", email: "u@suzu.group", name: "U" });
    expect(c.grants.length).toBe(1);
    expect(c.metaReady).toBe(false);
    expect(typeof c.flags).toBe("object");

    const w = await one<{ orgs: unknown[]; members: unknown[]; users: Array<{ email: string }> }>("select admin_workspaces_page() as d");
    expect([w.orgs.length, w.members.length, w.users.map((u) => u.email)]).toEqual([2, 2, ["u2@suzu.group", "u@suzu.group"]]);

    const q = await one<{ quotas: Array<{ scopeId: string; dailyLimit: number }>; users: unknown[]; orgs: unknown[] }>("select admin_quotas_page() as d");
    expect(q.quotas.length).toBeGreaterThanOrEqual(4);
    expect(q.quotas.every((r) => r.scopeId === "*" && typeof r.dailyLimit === "number")).toBe(true);

    // No vault schema here: the page still loads and says the preview could not be read.
    await pg.exec(`insert into integrations(provider, enabled, vault_ref, spend_cap_monthly_usd) values ('anthropic', true, gen_random_uuid(), 50), ('pexels', false, null, null)`);
    const i = await one<{ integrations: Array<Record<string, unknown>> }>("select admin_integrations_page() as d");
    const byProvider = Object.fromEntries(i.integrations.map((r) => [r.provider, r]));
    expect(byProvider.anthropic).toMatchObject({ hasSecret: true, enabled: true, spendCapMonthlyUsd: "50.00", preview: "(vault read failed)" });
    expect(byProvider.pexels).toMatchObject({ hasSecret: false, preview: null });

    const renders = await one<Array<Record<string, unknown>>>("select admin_recent_renders(20) as d");
    expect(renders).toMatchObject([{ status: "done", costUsd: "0.1200", durationSec: null }]);

    const act = await one<Array<{ type: string; actorEmail: string | null }>>("select admin_activity_page('project.', null, 100, 0) as d");
    expect(act.length).toBe(2);
    expect(await one<unknown[]>("select admin_activity_page('nope', null, 100, 0) as d")).toEqual([]);
    expect((await one<unknown[]>("select admin_activity_page(null, null, 1, 1) as d")).length).toBe(1);
  });

  it("load eval results only for the run on screen (migration 0013)", async () => {
    const one = async <T,>(q: string) => (await pg.query<{ d: T }>(q)).rows[0].d;
    await pg.exec(`insert into eval_articles(language, title, text) values ('vi', 'Bai', '  mot hai   ba bon  ');
      insert into prompt_evals(id, template_id, status, results, created_at)
        select ('00000000-0000-0000-0000-0000000000e' || n)::uuid, (select id from prompt_templates order by purpose, language, version limit 1), 'done',
               jsonb_build_array(jsonb_build_object('run', n)), now() - make_interval(mins => n)
        from generate_series(1, 2) n;`);
    type Page = { articles: Array<Record<string, unknown>>; runs: Array<Record<string, unknown>>; activeId: string; activeResults: unknown; recentProjects: unknown[] };
    const newest = await one<Page>("select admin_evals_page(null) as d");
    expect(newest.articles).toMatchObject([{ title: "Bai", words: 4 }]);
    expect(newest.articles[0]).not.toHaveProperty("text");
    expect(newest.runs.length).toBe(2);
    expect(newest.runs[0]).not.toHaveProperty("results");
    expect([newest.activeId, newest.activeResults]).toEqual(["00000000-0000-0000-0000-0000000000e1", [{ run: 1 }]]);
    const picked = await one<Page>("select admin_evals_page('00000000-0000-0000-0000-0000000000e2') as d");
    expect([picked.activeId, picked.activeResults]).toEqual(["00000000-0000-0000-0000-0000000000e2", [{ run: 2 }]]);
    // Unknown run id falls back to the newest run.
    const unknown = await one<Page>("select admin_evals_page('00000000-0000-0000-0000-0000000000ff') as d");
    expect(unknown.activeId).toBe("00000000-0000-0000-0000-0000000000e1");
  });

  it("keep the admin functions off the public API roles (migration 0013)", async () => {
    const { rows } = await pg.query<{ proname: string; grantees: string[] }>(
      `select p.proname, array(select (a).grantee::regrole::text from (select aclexplode(p.proacl) a) s) as grantees
       from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'admin\\_%'`,
    );
    expect(rows.length).toBe(10);
    for (const r of rows) {
      expect(r.grantees, r.proname).toContain("ai_news_app");
      for (const g of r.grantees) expect(["postgres", "ai_news_app"], `${r.proname} granted to ${g}`).toContain(g);
    }
  });
  it("allow several brand kits per workspace but one default, and free a project when its kit is deleted (migrations 0014–0016)", async () => {
    await pg.exec(`insert into "user"(id,name,email) values ('u14','U14','u14@suzu.group');
      insert into organization(id,name,slug) values ('o14','O14','o14');`);
    const kit = (name: string, isDefault: boolean) =>
      pg.query<{ id: string; overlay_layer: string; logo_motion: string; headline_style: object; auto_match: boolean; match_keywords: string[] }>(
        `insert into brand_kits(organization_id,name,is_default,fonts,colours,caption_style,safe_zones) values ('o14',$1,$2,'{}','{}','{}','{}') returning id, overlay_layer, logo_motion, headline_style, auto_match, match_keywords`,
        [name, isDefault],
      );
    await kit("Tin chung", true);
    const sport = (await kit("Thể thao", false)).rows[0];
    expect(sport).toMatchObject({ overlay_layer: "under_text", logo_motion: "flip", headline_style: {}, auto_match: true, match_keywords: [] });
    await expect(kit("Thứ hai mặc định", true)).rejects.toThrow(/brand_kits_one_default_idx/);
    await pg.query(`insert into projects(id,organization_id,owner_id,url,brand_kit_id,brand_kit_source) values ('00000000-0000-4000-8000-000000000014','o14','u14','https://example.com/a',$1,'auto')`, [sport.id]);
    await pg.query("delete from brand_kits where id=$1", [sport.id]);
    const { rows } = await pg.query<{ brand_kit_id: string | null }>("select brand_kit_id from projects where id='00000000-0000-4000-8000-000000000014'");
    expect(rows[0].brand_kit_id).toBeNull();
  });
  it("give channels a logo and let projects and renders point at the channel whose logo they carry (migration 0017)", async () => {
    await pg.exec(`insert into "user"(id,name,email) values ('u17','U17','u17@suzu.group');
      insert into organization(id,name,slug) values ('o17','O17','o17');`);
    const ch = await pg.query<{ id: string }>(`insert into channels(organization_id,platform,external_id,name,logo_path) values ('o17','youtube','UC17','Kênh 17','library/brand/o17/channel-logo.png') returning id`);
    await pg.query(`insert into projects(id,organization_id,owner_id,url,logo_channel_id) values ('00000000-0000-4000-8000-000000000017','o17','u17','https://example.com/b',$1)`, [ch.rows[0].id]);
    await pg.query(`insert into renders(organization_id,project_id,logo_channel_id,logo_path) values ('o17','00000000-0000-4000-8000-000000000017',$1,'library/brand/o17/channel-logo.png')`, [ch.rows[0].id]);
    const page = await pg.query<{ data: { channels: Array<{ id: string; logoPath: string | null }> } }>("select admin_channels_page() as data");
    expect(page.rows[0].data.channels.find((c) => c.id === ch.rows[0].id)?.logoPath).toBe("library/brand/o17/channel-logo.png");
    // Disconnecting the channel keeps the project and the render (and what the render drew).
    await pg.query("delete from channels where id=$1", [ch.rows[0].id]);
    const left = await pg.query<{ p: string | null; r: string | null; path: string }>("select p.logo_channel_id as p, r.logo_channel_id as r, r.logo_path as path from projects p join renders r on r.project_id=p.id where p.id='00000000-0000-4000-8000-000000000017'");
    expect(left.rows[0]).toEqual({ p: null, r: null, path: "library/brand/o17/channel-logo.png" });
  });
});
