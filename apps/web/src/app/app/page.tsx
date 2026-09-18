import Link from "next/link";
import { desc, eq } from "drizzle-orm";
import { ChevronRight, Plus } from "lucide-react";
import { schema } from "@/db";
import { withOrgContext } from "@/db/context";
import { ActionForm } from "@/components/action-form";
import { LiveStep, ProjectsWatcher } from "@/components/pipeline-status";
import { ProjectStateIcon, stateShort } from "@/components/project-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CollapsibleSection } from "@/components/ui/collapsible-section";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { listBrandKits } from "@/lib/media/brand";
import { listLogoChannels } from "@/lib/media/logo";
import { PLATFORM_SPEC } from "@/lib/publish/platforms";
import { DURATION_PRESETS, SCRIPT_TONES } from "@/lib/prompts/defaults";
import { loadProjectStatuses } from "@/lib/project-status";
import { dailyLimit, usedToday } from "@/lib/quota";
import { timeAgo } from "@/lib/time";
import { displayHost } from "@/lib/url";
import { canWrite, requireWorkspace } from "@/lib/workspace";
import { createProject } from "./actions";

export const dynamic = "force-dynamic";

export default async function AppHome() {
  const ws = await requireWorkspace();
  const writer = canWrite(ws);
  const [kits, logoChannels, projects, limit, used] = await Promise.all([
    writer ? listBrandKits(ws) : [],
    writer ? listLogoChannels(ws) : [],
    withOrgContext(ws, (tx) =>
      tx
        .select({
          id: schema.projects.id,
          title: schema.projects.title,
          url: schema.projects.url,
          state: schema.projects.state,
          busyStep: schema.projects.busyStep,
          language: schema.projects.language,
          sensitiveTopic: schema.projects.sensitiveTopic,
          political: schema.projects.political,
          autoPipeline: schema.projects.autoPipeline,
          createdAt: schema.projects.createdAt,
          ownerName: schema.user.name,
        })
        .from(schema.projects)
        .leftJoin(schema.user, eq(schema.user.id, schema.projects.ownerId))
        .orderBy(desc(schema.projects.createdAt))
        .limit(100),
    ),
    dailyLimit(ws.userId, "scripts"),
    usedToday(ws.userId, "scripts"),
  ]);
  // Only the projects with a step running are polled (src/components/pipeline-status.tsx).
  const statuses = await loadProjectStatuses(ws, projects.filter((p) => p.busyStep).map((p) => p.id));

  return (
    <ProjectsWatcher initial={statuses}>
      <div className="mx-auto max-w-5xl space-y-5 sm:space-y-6">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">Dự án</h1>
            <p className="text-sm text-muted-foreground">
              {ws.name} · vai trò {ws.role} · kịch bản hôm nay {used}/{limit}
            </p>
          </div>
        </div>

        {writer ? (
          <Card id="new">
            <CardHeader>
              <CardTitle>Dự án mới từ bài báo</CardTitle>
              <CardDescription>Dán link bài. Hệ thống lấy nội dung, nhận diện ngôn ngữ, rồi chờ bạn xác nhận văn bản trước khi viết kịch bản, hoặc bật «tự động» để chạy thẳng tới video.</CardDescription>
            </CardHeader>
            <CardContent>
              <ActionForm action={createProject} className="space-y-3">
                <div className="space-y-1">
                  <Label htmlFor="url">Link bài báo</Label>
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <Input id="url" name="url" type="url" inputMode="url" placeholder="https://vnexpress.net/…" required autoComplete="off" className="flex-1" />
                    <Button type="submit" className="sm:shrink-0">
                      <Plus data-icon="inline-start" /> Tạo dự án
                    </Button>
                  </div>
                </div>
                <CollapsibleSection variant="plain" defaultOpen="desktop" title="Tuỳ chọn" summary="60 giây · giọng mặc định · tự chọn bộ nhận diện" className="rounded-none">
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    <div className="space-y-1">
                      <Label htmlFor="durationSec">Thời lượng</Label>
                      <NativeSelect id="durationSec" name="durationSec" defaultValue="60" className="w-full">
                        {DURATION_PRESETS.map((d) => (
                          <option key={d} value={d}>
                            {d} giây
                          </option>
                        ))}
                      </NativeSelect>
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="tone">Giọng điệu</Label>
                      <NativeSelect id="tone" name="tone" defaultValue="punchy" className="w-full">
                        {SCRIPT_TONES.map((t) => (
                          <option key={t.key} value={t.key}>
                            {t.vi} · {t.en}
                          </option>
                        ))}
                      </NativeSelect>
                    </div>
                    {logoChannels.length ? (
                      <div className="space-y-1">
                        <Label htmlFor="logoChannelId">Logo kênh</Label>
                        <NativeSelect
                          id="logoChannelId"
                          name="logoChannelId"
                          defaultValue={logoChannels.length === 1 ? logoChannels[0].id : ""}
                          className="w-full"
                          title="Bộ nhận diện dùng chung cho mọi kênh; logo thì theo kênh. Sau khi có video, có thể kết xuất lại với logo của kênh khác."
                        >
                          <option value="">Logo của bộ nhận diện</option>
                          {logoChannels.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.name} · {PLATFORM_SPEC[c.platform as keyof typeof PLATFORM_SPEC]?.label ?? c.platform}
                            </option>
                          ))}
                        </NativeSelect>
                      </div>
                    ) : null}
                    {kits.length > 1 ? (
                      <div className="space-y-1">
                        <Label htmlFor="brandKitId">Bộ nhận diện</Label>
                        <NativeSelect
                          id="brandKitId"
                          name="brandKitId"
                          defaultValue=""
                          className="w-full"
                          title="Tự chọn: sau khi lấy bài, hệ thống so nội dung với mô tả + từ khoá của từng bộ; không bộ nào khớp thì dùng bộ mặc định."
                        >
                          <option value="">Tự chọn theo nội dung bài</option>
                          {kits.map((k) => (
                            <option key={k.id} value={k.id}>
                              {k.name}
                              {k.isDefault ? " (mặc định)" : ""}
                            </option>
                          ))}
                        </NativeSelect>
                      </div>
                    ) : null}
                  </div>
                  <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:gap-x-6">
                    <label className="flex min-h-10 items-center gap-2 text-sm" title="Bỏ qua các bước xác nhận: lấy bài → kịch bản → dựng → kết xuất chạy liên tiếp. Duyệt và đăng vẫn cần người.">
                      <input type="checkbox" name="auto" /> tự động tới video
                    </label>
                    <label className="flex min-h-10 items-center gap-2 text-sm">
                      <input type="checkbox" name="force" /> tạo dù đã có dự án cùng bài
                    </label>
                  </div>
                </CollapsibleSection>
              </ActionForm>
            </CardContent>
          </Card>
        ) : (
          <p className="text-sm text-muted-foreground">Vai trò {ws.role} chỉ được xem. Nhờ admin cấp quyền editor để tạo dự án.</p>
        )}

        <section aria-labelledby="projects-heading" className="space-y-2">
          <div className="flex items-center justify-between px-1">
            <h2 id="projects-heading" className="text-sm font-medium text-muted-foreground">
              Gần đây · {projects.length}
            </h2>
          </div>
          {projects.length === 0 ? (
            <p className="rounded-xl bg-card p-6 text-center text-sm text-muted-foreground shadow-xs ring-1 ring-border">Chưa có dự án nào.</p>
          ) : (
            <ul className="divide-y rounded-xl bg-card shadow-xs ring-1 ring-border">
              {projects.map((p) => (
                <li key={p.id}>
                  <Link href={`/app/projects/${p.id}`} className="flex items-center gap-3 px-3 py-3 transition-colors hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:outline-none sm:px-4">
                    <ProjectStateIcon state={p.state} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">{p.title ?? p.url}</div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                        <span className="truncate">{displayHost(p.url)}</span>
                        {p.ownerName ? <span className="hidden sm:inline">· {p.ownerName}</span> : null}
                        <span className="uppercase">· {p.language}</span>
                        {p.autoPipeline ? <Badge variant="outline">tự động</Badge> : null}
                        {p.sensitiveTopic ? <Badge variant="outline">nhạy cảm</Badge> : null}
                        {p.political ? (
                          <Badge variant="outline" title="Không dùng stock hay ảnh AI">
                            chính trị
                          </Badge>
                        ) : null}
                      </div>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1 text-right">
                      <LiveStep id={p.id}>
                        <Badge variant={p.state === "failed" ? "destructive" : p.state === "published" || p.state === "approved" || p.state === "rendered" ? "success" : p.state === "scripted" ? "default" : "secondary"}>{stateShort(p.state)}</Badge>
                      </LiveStep>
                      <span className="text-xs text-muted-foreground" title={p.createdAt.toISOString()}>
                        {timeAgo(p.createdAt)}
                      </span>
                    </div>
                    <ChevronRight className="size-4 shrink-0 text-muted-foreground/60" aria-hidden />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </ProjectsWatcher>
  );
}
