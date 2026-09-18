import { asc, eq, inArray } from "drizzle-orm";
import { Link2, Plus } from "lucide-react";
import { schema } from "@/db";
import { withOrgContext } from "@/db/context";
import { ActionForm } from "@/components/action-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { NativeSelect } from "@/components/ui/native-select";
import { flagsEnabled } from "@/lib/flags";
import { presignMap } from "@/lib/media/timeline-resolve";
import { canConnectChannel, canManageChannel } from "@/lib/publish/channel-access";
import { formatVietnam, PLATFORM_SPEC } from "@/lib/publish/platforms";
import { canApprove } from "@/lib/review";
import { requireWorkspace } from "@/lib/workspace";
import { checkMyChannel, disconnectMyChannel, grantMyChannel, revokeMyChannel, setMyChannelEnabled, setMyChannelLogo } from "./actions";

export const dynamic = "force-dynamic";

const PROVIDERS = [
  { id: "youtube", label: "YouTube", app: null },
  { id: "meta", label: "Facebook / Instagram", app: "meta_app" },
  { id: "tiktok", label: "TikTok", app: "tiktok_app" },
] as const;

/**
 * Self-service channels: every member who can edit projects links their own
 * YouTube / Facebook / Instagram / TikTok accounts to the active workspace and
 * manages the ones they connected. Platform admins keep the cross-workspace
 * view at /admin/channels; both call the same OAuth routes and operations.
 */
export default async function ChannelsPage({ searchParams }: { searchParams: Promise<{ connected?: string; error?: string }> }) {
  const ws = await requireWorkspace();
  const sp = await searchParams;
  const [{ channels, grants, members, apps }, flags] = await Promise.all([
    withOrgContext(ws, async (tx) => {
      const channels = await tx.query.channels.findMany({ where: eq(schema.channels.organizationId, ws.organizationId), orderBy: [asc(schema.channels.platform), asc(schema.channels.name)] });
      const grants = await tx.query.channelGrants.findMany({ where: eq(schema.channelGrants.organizationId, ws.organizationId) });
      const members = await tx
        .select({ userId: schema.member.userId, role: schema.member.role, name: schema.user.name, email: schema.user.email })
        .from(schema.member)
        .innerJoin(schema.user, eq(schema.user.id, schema.member.userId))
        .where(eq(schema.member.organizationId, ws.organizationId))
        .orderBy(asc(schema.user.name));
      const apps = await tx
        .select({ provider: schema.integrations.provider, enabled: schema.integrations.enabled, vaultRef: schema.integrations.vaultRef })
        .from(schema.integrations)
        .where(inArray(schema.integrations.provider, ["meta_app", "tiktok_app"]));
      return { channels, grants, members, apps };
    }),
    flagsEnabled(Object.values(PLATFORM_SPEC).map((p) => p.flag)),
  ]);
  // Presigning is local signing, no network; the logos themselves load in the browser.
  const logoUrls = await presignMap(channels.flatMap((c) => (c.logoPath ? [c.logoPath] : [])), 600);
  const canConnect = canConnectChannel(ws);
  const appReady = (key: string | null) => key === null || apps.some((a) => a.provider === key && a.enabled && a.vaultRef);
  const who = (userId: string | null) => {
    if (!userId) return "—";
    if (userId === ws.userId) return "bạn";
    const m = members.find((x) => x.userId === userId);
    return m ? m.name || m.email : "người đã rời workspace";
  };
  const offPlatforms = Object.values(PLATFORM_SPEC).filter((p) => !flags[p.flag]);

  return (
    <div className="mx-auto max-w-6xl space-y-4 sm:space-y-6">
      <div>
        <h1 className="sr-only">Kênh</h1>
        <p className="text-sm text-muted-foreground">
          Workspace {ws.name}. Kết nối kênh YouTube, trang Facebook, tài khoản Instagram hoặc TikTok của bạn để đăng video thẳng từ dự án. Kênh bạn kết nối do bạn quản lý: bạn được cấp quyền
          đăng ngay, và có thể cho đồng nghiệp trong workspace đăng cùng. Khoá truy cập được mã hoá, tự làm mới mỗi 6 giờ và không bao giờ hiển thị lại.
        </p>
      </div>
      {sp.connected ? <p className="rounded-md border border-emerald-300 bg-emerald-50 p-3 text-sm dark:bg-emerald-950/30">Đã kết nối: {sp.connected}</p> : null}
      {sp.error ? <p className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">{sp.error}</p> : null}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Link2 className="size-4" aria-hidden /> Kết nối kênh mới
          </CardTitle>
          <CardDescription>
            Bạn sẽ được chuyển sang nền tảng để đăng nhập và cấp quyền đăng video, rồi quay lại đây. Với Facebook / Instagram, mọi trang bạn chọn trong bước cấp quyền đều được thêm vào.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {canConnect ? (
            <div className="flex flex-wrap gap-2">
              {PROVIDERS.map((p) =>
                appReady(p.app) ? (
                  <Button key={p.id} variant="outline" render={<a href={`/api/channels/oauth/${p.id}/start`} />}>
                    <Plus className="size-4" aria-hidden /> {p.label}
                  </Button>
                ) : (
                  <Button key={p.id} variant="outline" disabled title="Admin chưa cấu hình ứng dụng của nền tảng này">
                    <Plus className="size-4" aria-hidden /> {p.label}
                  </Button>
                ),
              )}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Vai trò “viewer” không kết nối được kênh. Nhờ admin workspace nâng vai trò của bạn.</p>
          )}
          {PROVIDERS.some((p) => !appReady(p.app)) ? <p className="text-xs text-muted-foreground">Nền tảng bị mờ là do admin chưa cấu hình ứng dụng (app secret) cho nền tảng đó.</p> : null}
          {offPlatforms.length ? <p className="text-xs text-muted-foreground">Đang tắt đăng bài cho: {offPlatforms.map((p) => p.label).join(", ")}. Bạn vẫn kết nối được, nhưng chỉ đăng được khi admin bật lại.</p> : null}
          {canConnect && !canApprove(ws) ? (
            <p className="text-xs text-muted-foreground">Lưu ý: trong workspace này bạn là “editor”; việc đăng bài cần vai trò publisher trở lên, nên kênh của bạn sẽ do publisher được bạn cấp quyền đăng.</p>
          ) : null}
        </CardContent>
      </Card>

      {channels.length === 0 ? (
        <p className="text-sm text-muted-foreground">Workspace chưa có kênh nào.</p>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {channels.map((c) => {
            const manage = canManageChannel(ws, c);
            const gs = grants.filter((g) => g.channelId === c.id);
            const granted = ws.isAdmin || gs.some((g) => g.userId === ws.userId);
            const grantable = members.filter((m) => !gs.some((g) => g.userId === m.userId));
            const connected = Boolean(c.vaultRef);
            return (
              <Card key={c.id}>
                <CardHeader>
                  <div className="flex flex-wrap items-center gap-2">
                    {c.avatarUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={c.avatarUrl} alt="" className="size-7 rounded-full" />
                    ) : null}
                    <CardTitle className="text-base">{c.name}</CardTitle>
                    <Badge variant="outline">{PLATFORM_SPEC[c.platform].label}</Badge>
                    {!connected ? <Badge variant="destructive">đã ngắt kết nối</Badge> : c.healthy ? <Badge>hoạt động</Badge> : <Badge variant="destructive">lỗi kết nối</Badge>}
                    {connected && !c.enabled ? <Badge variant="secondary">tạm dừng</Badge> : null}
                    {c.connectedBy === ws.userId ? <Badge variant="secondary">của bạn</Badge> : null}
                  </div>
                  <CardDescription>
                    Kết nối bởi {who(c.connectedBy)}
                    {c.lastCheckedAt ? ` · kiểm tra lúc ${formatVietnam(c.lastCheckedAt)}` : ""} · {granted ? "bạn được đăng lên kênh này" : "bạn chưa được cấp quyền đăng"}
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3 text-sm">
                  {c.lastError && connected ? (
                    <p className="text-xs text-destructive">
                      {c.lastError.slice(0, 300)}
                      {canConnect ? " — kết nối lại kênh bằng nút ở trên để cấp khoá mới." : ""}
                    </p>
                  ) : null}
                  {!connected && canConnect ? <p className="text-xs text-muted-foreground">Kết nối lại bằng nút ở trên (đăng nhập đúng tài khoản này) để dùng tiếp; lịch sử đăng vẫn được giữ.</p> : null}
                  {manage ? (
                    <>
                      <ActionForm action={setMyChannelLogo} className="flex flex-wrap items-center gap-2 rounded-md bg-muted/40 p-2">
                        <input type="hidden" name="channelId" value={c.id} />
                        <span className="text-xs font-medium">Logo trên video</span>
                        {c.logoPath && logoUrls[c.logoPath] ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={logoUrls[c.logoPath]} alt={`Logo ${c.name}`} className="h-9 max-w-32 rounded bg-slate-800 object-contain p-1" />
                        ) : (
                          <span className="text-xs text-muted-foreground">chưa có: video của kênh dùng logo của bộ nhận diện</span>
                        )}
                        <input name="logo" type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" className="max-w-56 text-xs" />
                        {c.logoPath ? (
                          <label className="flex items-center gap-1 text-xs">
                            <input type="checkbox" name="remove" /> gỡ logo
                          </label>
                        ) : null}
                        <Button type="submit" size="xs" variant="outline">
                          Lưu logo
                        </Button>
                        <span className="text-[11px] text-muted-foreground">PNG / SVG / WebP, ≤ 2 MB, nền trong suốt; vẽ ở góc trên bên phải, cao 90 px.</span>
                      </ActionForm>
                      <div className="flex flex-wrap items-center gap-1">
                        <span className="text-xs">Được đăng:</span>
                        {gs.length === 0 ? <span className="text-xs text-muted-foreground">chưa ai</span> : null}
                        {gs.map((g) => (
                          <ActionForm key={g.id} action={revokeMyChannel} className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs">
                            <input type="hidden" name="channelId" value={c.id} />
                            <input type="hidden" name="userId" value={g.userId} />
                            <span>{who(g.userId)}</span>
                            <button type="submit" className="text-muted-foreground hover:text-destructive" title="Thu hồi quyền đăng" aria-label={`Thu hồi quyền đăng của ${who(g.userId)}`}>
                              ✕
                            </button>
                          </ActionForm>
                        ))}
                        {grantable.length ? (
                          <ActionForm action={grantMyChannel} className="inline-flex items-center gap-1">
                            <input type="hidden" name="channelId" value={c.id} />
                            <NativeSelect name="userId" fieldSize="sm" aria-label="Thành viên">
                              {grantable.map((m) => (
                                <option key={m.userId} value={m.userId}>
                                  {m.name || m.email} ({m.role})
                                </option>
                              ))}
                            </NativeSelect>
                            <Button type="submit" size="xs" variant="outline">
                              Cấp quyền
                            </Button>
                          </ActionForm>
                        ) : null}
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {connected ? (
                          <>
                            <ActionForm action={checkMyChannel}>
                              <input type="hidden" name="channelId" value={c.id} />
                              <Button type="submit" size="xs" variant="ghost">
                                Kiểm tra kết nối
                              </Button>
                            </ActionForm>
                            <ActionForm action={setMyChannelEnabled}>
                              <input type="hidden" name="channelId" value={c.id} />
                              <input type="hidden" name="enabled" value={c.enabled ? "0" : "1"} />
                              <Button type="submit" size="xs" variant="ghost">
                                {c.enabled ? "Tạm dừng" : "Bật lại"}
                              </Button>
                            </ActionForm>
                            <ActionForm action={disconnectMyChannel}>
                              <input type="hidden" name="channelId" value={c.id} />
                              <Button type="submit" size="xs" variant="ghost" className="text-destructive">
                                Ngắt kết nối
                              </Button>
                            </ActionForm>
                          </>
                        ) : null}
                      </div>
                    </>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      {granted ? "Kênh do người khác quản lý." : `Muốn đăng lên kênh này, nhờ ${who(c.connectedBy)} hoặc admin workspace cấp quyền.`}
                    </p>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
