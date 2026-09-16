import { asc, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/db";
import { withServiceContext } from "@/db/context";
import { ActionForm } from "@/components/action-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { flagsEnabled } from "@/lib/flags";
import { PLATFORM_SPEC } from "@/lib/publish/platforms";
import { checkChannel, disconnectChannel, grantChannel, pullAnalyticsNow, revokeChannel, setChannelEnabled } from "./actions";

export const dynamic = "force-dynamic";

export default async function ChannelsPage({ searchParams }: { searchParams: Promise<{ connected?: string; error?: string }> }) {
  const sp = await searchParams;
  const [orgs, channels, members, integrations, flags] = await Promise.all([
    db.select({ id: schema.organization.id, name: schema.organization.name, kind: schema.organization.kind }).from(schema.organization).orderBy(asc(schema.organization.name)),
    // channels/channel_grants are RLS-scoped: read them in the service context.
    withServiceContext((tx) => tx.select().from(schema.channels).orderBy(asc(schema.channels.platform), asc(schema.channels.name))),
    db
      .select({ organizationId: schema.member.organizationId, userId: schema.member.userId, role: schema.member.role, email: schema.user.email, name: schema.user.name })
      .from(schema.member)
      .innerJoin(schema.user, eq(schema.user.id, schema.member.userId)),
    db.select({ provider: schema.integrations.provider, enabled: schema.integrations.enabled, vaultRef: schema.integrations.vaultRef }).from(schema.integrations).where(inArray(schema.integrations.provider, ["meta_app", "tiktok_app"])),
    flagsEnabled(["publish_youtube", "publish_facebook", "publish_instagram", "publish_tiktok", "scheduling"]),
  ]);
  const grants = channels.length
    ? await withServiceContext((tx) => tx.select().from(schema.channelGrants).where(inArray(schema.channelGrants.channelId, channels.map((c) => c.id))))
    : [];
  const metaReady = integrations.some((i) => i.provider === "meta_app" && i.enabled && i.vaultRef);
  const tiktokReady = integrations.some((i) => i.provider === "tiktok_app" && i.enabled && i.vaultRef);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Channels</h1>
        <p className="text-sm text-muted-foreground">
          Social channels are connected per workspace by an admin and granted to users (docs/PLAN.md §7). Tokens live in Supabase Vault; a cron refreshes them
          every 6 hours and posts to Slack when one breaks. Redirect URIs to register: <code className="text-xs">{`{APP_URL}/api/channels/oauth/{youtube|meta|tiktok}/callback`}</code>.
        </p>
      </div>
      {sp.connected ? <p className="rounded-md border border-emerald-300 bg-emerald-50 p-3 text-sm dark:bg-emerald-950/30">Connected: {sp.connected}</p> : null}
      {sp.error ? <p className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">{sp.error}</p> : null}
      <div className="flex flex-wrap gap-2 text-xs">
        {(Object.keys(PLATFORM_SPEC) as Array<keyof typeof PLATFORM_SPEC>).map((p) => (
          <Badge key={p} variant={flags[PLATFORM_SPEC[p].flag] ? "default" : "secondary"}>
            {PLATFORM_SPEC[p].label}: {flags[PLATFORM_SPEC[p].flag] ? "on" : "off"}
          </Badge>
        ))}
        <Badge variant={flags.scheduling ? "default" : "secondary"}>Scheduling: {flags.scheduling ? "on" : "off"}</Badge>
        <span className="text-muted-foreground">Flags and the Meta / TikTok app secrets are in Integrations.</span>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {orgs.map((o) => {
          const chs = channels.filter((c) => c.organizationId === o.id);
          const ms = members.filter((m) => m.organizationId === o.id);
          return (
            <Card key={o.id}>
              <CardHeader>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <CardTitle className="text-base">{o.name}</CardTitle>
                  <div className="flex flex-wrap gap-1">
                    <Button size="sm" variant="outline" render={<a href={`/api/channels/oauth/youtube/start?org=${o.id}`} />}>
                      + YouTube
                    </Button>
                    <Button size="sm" variant="outline" disabled={!metaReady} title={metaReady ? "" : "Set the Meta app secret in Integrations first"} render={<a href={`/api/channels/oauth/meta/start?org=${o.id}`} />}>
                      + Facebook / Instagram
                    </Button>
                    <Button size="sm" variant="outline" disabled={!tiktokReady} title={tiktokReady ? "" : "Set the TikTok app secret in Integrations first"} render={<a href={`/api/channels/oauth/tiktok/start?org=${o.id}`} />}>
                      + TikTok
                    </Button>
                  </div>
                </div>
                <CardDescription>
                  {o.kind} · {ms.length} member(s) · {chs.length} channel(s)
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {chs.length === 0 ? <p className="text-sm text-muted-foreground">No channels yet.</p> : null}
                {chs.map((c) => {
                  const gs = grants.filter((g) => g.channelId === c.id);
                  return (
                    <div key={c.id} className="space-y-2 rounded-md border p-3 text-sm">
                      <div className="flex flex-wrap items-center gap-2">
                        {c.avatarUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={c.avatarUrl} alt="" className="h-6 w-6 rounded-full" />
                        ) : null}
                        <span className="font-medium">{c.name}</span>
                        <Badge variant="outline">{PLATFORM_SPEC[c.platform].label}</Badge>
                        {!c.vaultRef ? <Badge variant="destructive">no token</Badge> : c.healthy ? <Badge>healthy</Badge> : <Badge variant="destructive">unhealthy</Badge>}
                        {!c.enabled ? <Badge variant="secondary">paused</Badge> : null}
                        <span className="text-xs text-muted-foreground">
                          {c.expiresAt ? `token expires ${c.expiresAt.toISOString().slice(0, 16).replace("T", " ")}` : "non-expiring token"}
                          {c.lastCheckedAt ? ` · checked ${c.lastCheckedAt.toISOString().slice(0, 16).replace("T", " ")}` : ""}
                        </span>
                      </div>
                      {c.lastError ? <div className="text-xs text-destructive">{c.lastError.slice(0, 300)}</div> : null}
                      <div className="text-xs text-muted-foreground">
                        id {c.externalId} · scopes {c.scopes.length ? c.scopes.join(", ") : "—"}
                      </div>
                      <div className="flex flex-wrap items-center gap-1">
                        <span className="text-xs">Granted:</span>
                        {gs.length === 0 ? <span className="text-xs text-muted-foreground">nobody</span> : null}
                        {gs.map((g) => {
                          const m = ms.find((x) => x.userId === g.userId);
                          return (
                            <ActionForm key={g.id} action={revokeChannel} className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs">
                              <input type="hidden" name="channelId" value={c.id} />
                              <input type="hidden" name="userId" value={g.userId} />
                              <span>{m?.email ?? g.userId}</span>
                              <button type="submit" className="text-muted-foreground hover:text-destructive" title="Revoke">
                                ✕
                              </button>
                            </ActionForm>
                          );
                        })}
                        {ms.filter((m) => !gs.some((g) => g.userId === m.userId)).length ? (
                          <ActionForm action={grantChannel} className="inline-flex items-center gap-1">
                            <input type="hidden" name="channelId" value={c.id} />
                            <select name="userId" className="h-7 rounded-md border bg-background px-1 text-xs">
                              {ms
                                .filter((m) => !gs.some((g) => g.userId === m.userId))
                                .map((m) => (
                                  <option key={m.userId} value={m.userId}>
                                    {m.email} ({m.role})
                                  </option>
                                ))}
                            </select>
                            <Button type="submit" size="sm" variant="outline" className="h-7">
                              Grant
                            </Button>
                          </ActionForm>
                        ) : null}
                      </div>
                      <div className="flex flex-wrap gap-1">
                        <ActionForm action={checkChannel}>
                          <input type="hidden" name="channelId" value={c.id} />
                          <Button type="submit" size="sm" variant="ghost" className="h-7">
                            Check token
                          </Button>
                        </ActionForm>
                        <ActionForm action={pullAnalyticsNow}>
                          <input type="hidden" name="channelId" value={c.id} />
                          <Button type="submit" size="sm" variant="ghost" className="h-7">
                            Pull analytics
                          </Button>
                        </ActionForm>
                        <ActionForm action={setChannelEnabled}>
                          <input type="hidden" name="channelId" value={c.id} />
                          <input type="hidden" name="enabled" value={c.enabled ? "0" : "1"} />
                          <Button type="submit" size="sm" variant="ghost" className="h-7">
                            {c.enabled ? "Pause" : "Enable"}
                          </Button>
                        </ActionForm>
                        <ActionForm action={disconnectChannel}>
                          <input type="hidden" name="channelId" value={c.id} />
                          <Button type="submit" size="sm" variant="ghost" className="h-7 text-destructive">
                            Disconnect
                          </Button>
                        </ActionForm>
                      </div>
                    </div>
                  );
                })}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
