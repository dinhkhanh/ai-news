import { ActionForm } from "@/components/action-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { NativeSelect } from "@/components/ui/native-select";
import { loadAdminChannels } from "@/lib/admin-data";
import { PLATFORM_SPEC } from "@/lib/publish/platforms";
import { presignMap } from "@/lib/media/timeline-resolve";
import { checkChannel, disconnectChannel, grantChannel, pullAnalyticsNow, revokeChannel, setChannelEnabled, setChannelLogo } from "./actions";

export const dynamic = "force-dynamic";

export default async function ChannelsPage({ searchParams }: { searchParams: Promise<{ connected?: string; error?: string }> }) {
  const sp = await searchParams;
  // One round-trip: admin_channels_page() (migration 0013) reads across workspaces.
  const { orgs, channels, members, grants, metaReady, tiktokReady, flags } = await loadAdminChannels();
  // Presigning is local signing, no network; the logos themselves load in the browser.
  const logoUrls = await presignMap(channels.flatMap((c) => (c.logoPath ? [c.logoPath] : [])), 600);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="sr-only">Channels</h1>
        <p className="text-sm text-muted-foreground">
          Members connect and manage their own channels at <code className="text-xs">/app/channels</code> (docs/PLAN.md §7); this page is the cross-workspace view, where an admin can also
          connect for any workspace, grant, pause or disconnect. Tokens live in Supabase Vault; a cron refreshes them
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
                    <div key={c.id} className="space-y-2 rounded-lg border p-3 text-sm">
                      <div className="flex flex-wrap items-center gap-2">
                        {c.avatarUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={c.avatarUrl} alt="" className="h-6 w-6 rounded-full" />
                        ) : null}
                        <span className="font-medium">{c.name}</span>
                        <Badge variant="outline">{PLATFORM_SPEC[c.platform].label}</Badge>
                        {!c.hasToken ? <Badge variant="destructive">no token</Badge> : c.healthy ? <Badge>healthy</Badge> : <Badge variant="destructive">unhealthy</Badge>}
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
                      <ActionForm action={setChannelLogo} className="flex flex-wrap items-center gap-2 rounded-md bg-muted/40 p-2">
                        <input type="hidden" name="channelId" value={c.id} />
                        <span className="text-xs font-medium">Video logo</span>
                        {c.logoPath && logoUrls[c.logoPath] ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={logoUrls[c.logoPath]} alt={`${c.name} logo`} className="h-9 max-w-32 rounded bg-slate-800 object-contain p-1" />
                        ) : (
                          <span className="text-xs text-muted-foreground">none: videos for this channel use the brand kit&apos;s logo</span>
                        )}
                        <input name="logo" type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" className="max-w-56 text-xs" />
                        {c.logoPath ? (
                          <label className="flex items-center gap-1 text-xs">
                            <input type="checkbox" name="remove" /> remove
                          </label>
                        ) : null}
                        <Button type="submit" size="xs" variant="outline">
                          Save logo
                        </Button>
                        <span className="text-[11px] text-muted-foreground">PNG / SVG / WebP, ≤ 2 MB, transparent background; drawn top-right at 90 px high.</span>
                      </ActionForm>
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
                            <NativeSelect name="userId" fieldSize="sm">
                              {ms
                                .filter((m) => !gs.some((g) => g.userId === m.userId))
                                .map((m) => (
                                  <option key={m.userId} value={m.userId}>
                                    {m.email} ({m.role})
                                  </option>
                                ))}
                            </NativeSelect>
                            <Button type="submit" size="xs" variant="outline">
                              Grant
                            </Button>
                          </ActionForm>
                        ) : null}
                      </div>
                      <div className="flex flex-wrap gap-1">
                        <ActionForm action={checkChannel}>
                          <input type="hidden" name="channelId" value={c.id} />
                          <Button type="submit" size="xs" variant="ghost">
                            Check token
                          </Button>
                        </ActionForm>
                        <ActionForm action={pullAnalyticsNow}>
                          <input type="hidden" name="channelId" value={c.id} />
                          <Button type="submit" size="xs" variant="ghost">
                            Pull analytics
                          </Button>
                        </ActionForm>
                        <ActionForm action={setChannelEnabled}>
                          <input type="hidden" name="channelId" value={c.id} />
                          <input type="hidden" name="enabled" value={c.enabled ? "0" : "1"} />
                          <Button type="submit" size="xs" variant="ghost">
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
