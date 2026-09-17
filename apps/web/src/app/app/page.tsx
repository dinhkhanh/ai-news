import Link from "next/link";
import { desc, eq } from "drizzle-orm";
import { schema } from "@/db";
import { withOrgContext } from "@/db/context";
import { ActionForm } from "@/components/action-form";
import { LiveStep, ProjectsWatcher } from "@/components/pipeline-status";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { listBrandKits } from "@/lib/media/brand";
import { listLogoChannels } from "@/lib/media/logo";
import { PLATFORM_SPEC } from "@/lib/publish/platforms";
import { DURATION_PRESETS, SCRIPT_TONES } from "@/lib/prompts/defaults";
import { loadProjectStatuses } from "@/lib/project-status";
import { dailyLimit, usedToday } from "@/lib/quota";
import { displayHost } from "@/lib/url";
import { canWrite, requireWorkspace } from "@/lib/workspace";
import { createProject } from "./actions";

export const dynamic = "force-dynamic";

const STATE_LABEL: Record<string, string> = {
  created: "đang tải",
  fetched: "chờ xác nhận",
  scripted: "có kịch bản",
  composed: "đã dựng",
  in_review: "chờ duyệt",
  approved: "đã duyệt",
  rendered: "đã kết xuất",
  published: "đã đăng",
  failed: "lỗi",
};

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
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Dự án</h1>
          <p className="text-sm text-muted-foreground">
            Workspace: {ws.name} · vai trò {ws.role} · kịch bản hôm nay {used}/{limit}
          </p>
        </div>
      </div>

      {writer ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Dự án mới từ bài báo</CardTitle>
            <CardDescription>
              Dán link bài. Hệ thống lấy nội dung, nhận diện ngôn ngữ, rồi chờ bạn xác nhận văn bản trước khi viết kịch
              bản — hoặc bật «tự động» để chạy thẳng tới video.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ActionForm action={createProject} className="space-y-3">
              <div className="space-y-1">
                <Label htmlFor="url">Link bài báo</Label>
                <Input
                  id="url"
                  name="url"
                  type="url"
                  placeholder="https://vnexpress.net/…"
                  required
                  autoComplete="off"
                />
              </div>
              <div className="flex flex-wrap items-end gap-3">
                <div className="space-y-1">
                  <Label htmlFor="durationSec">Thời lượng</Label>
                  <select
                    id="durationSec"
                    name="durationSec"
                    defaultValue="60"
                    className="h-9 rounded-md border bg-background px-2 text-sm"
                  >
                    {DURATION_PRESETS.map((d) => (
                      <option key={d} value={d}>
                        {d} giây
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="tone">Giọng điệu</Label>
                  <select
                    id="tone"
                    name="tone"
                    defaultValue="punchy"
                    className="h-9 rounded-md border bg-background px-2 text-sm"
                  >
                    {SCRIPT_TONES.map((t) => (
                      <option key={t.key} value={t.key}>
                        {t.vi} · {t.en}
                      </option>
                    ))}
                  </select>
                </div>
                {logoChannels.length ? (
                  <div className="space-y-1">
                    <Label htmlFor="logoChannelId">Logo kênh</Label>
                    <select
                      id="logoChannelId"
                      name="logoChannelId"
                      defaultValue={logoChannels.length === 1 ? logoChannels[0].id : ""}
                      className="h-9 max-w-56 rounded-md border bg-background px-2 text-sm"
                      title="Bộ nhận diện dùng chung cho mọi kênh; logo thì theo kênh. Sau khi có video, có thể kết xuất lại với logo của kênh khác."
                    >
                      <option value="">Logo của bộ nhận diện</option>
                      {logoChannels.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name} · {PLATFORM_SPEC[c.platform as keyof typeof PLATFORM_SPEC]?.label ?? c.platform}
                        </option>
                      ))}
                    </select>
                  </div>
                ) : null}
                {kits.length > 1 ? (
                  <div className="space-y-1">
                    <Label htmlFor="brandKitId">Bộ nhận diện</Label>
                    <select
                      id="brandKitId"
                      name="brandKitId"
                      defaultValue=""
                      className="h-9 max-w-56 rounded-md border bg-background px-2 text-sm"
                      title="Tự chọn: sau khi lấy bài, hệ thống so nội dung với mô tả + từ khoá của từng bộ; không bộ nào khớp thì dùng bộ mặc định."
                    >
                      <option value="">Tự chọn theo nội dung bài</option>
                      {kits.map((k) => (
                        <option key={k.id} value={k.id}>
                          {k.name}
                          {k.isDefault ? " (mặc định)" : ""}
                        </option>
                      ))}
                    </select>
                  </div>
                ) : null}
                <label
                  className="flex items-center gap-2 pb-2 text-sm"
                  title="Bỏ qua các bước xác nhận: lấy bài → kịch bản → dựng → kết xuất chạy liên tiếp. Duyệt và đăng vẫn cần người."
                >
                  <input type="checkbox" name="auto" className="size-4" /> tự động tới video
                </label>
                <label className="flex items-center gap-2 pb-2 text-sm">
                  <input type="checkbox" name="force" className="size-4" /> tạo dù đã có dự án cùng bài
                </label>
                <Button type="submit" className="ml-auto">
                  Tạo dự án
                </Button>
              </div>
            </ActionForm>
          </CardContent>
        </Card>
      ) : (
        <p className="text-sm text-muted-foreground">
          Vai trò {ws.role} chỉ được xem. Nhờ admin cấp quyền editor để tạo dự án.
        </p>
      )}

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Bài</TableHead>
            <TableHead>Trạng thái</TableHead>
            <TableHead>Ngôn ngữ</TableHead>
            <TableHead>Người tạo</TableHead>
            <TableHead>Tạo lúc</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {projects.length === 0 ? (
            <TableRow>
              <TableCell colSpan={5} className="text-center text-sm text-muted-foreground">
                Chưa có dự án nào.
              </TableCell>
            </TableRow>
          ) : null}
          {projects.map((p) => (
            <TableRow key={p.id}>
              <TableCell className="max-w-md">
                <Link
                  href={`/app/projects/${p.id}`}
                  key={`project-${p.id}`}
                  className="block truncate font-medium hover:underline"
                >
                  {p.title ?? p.url}
                </Link>
                <div className="text-xs text-muted-foreground">{displayHost(p.url)}</div>
              </TableCell>
              <TableCell>
                <LiveStep id={p.id}>
                  <Badge variant={p.state === "failed" ? "destructive" : p.state === "scripted" ? "default" : "secondary"}>
                    {STATE_LABEL[p.state] ?? p.state}
                  </Badge>
                </LiveStep>
                {p.autoPipeline ? (
                  <Badge variant="outline" className="ml-1">
                    tự động
                  </Badge>
                ) : null}
                {p.sensitiveTopic ? (
                  <Badge variant="outline" className="ml-1">
                    nhạy cảm
                  </Badge>
                ) : null}
              </TableCell>
              <TableCell className="text-xs">{p.language}</TableCell>
              <TableCell className="text-xs">{p.ownerName}</TableCell>
              <TableCell className="text-xs text-muted-foreground">
                {p.createdAt.toISOString().slice(0, 16).replace("T", " ")}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
    </ProjectsWatcher>
  );
}
