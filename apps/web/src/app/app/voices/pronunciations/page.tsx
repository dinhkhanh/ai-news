import { asc, desc, eq, isNull } from "drizzle-orm";
import { Trash2 } from "lucide-react";
import { schema } from "@/db";
import { withOrgContext } from "@/db/context";
import { ActionForm } from "@/components/action-form";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { timeAgo } from "@/lib/time";
import { canWrite, requireWorkspace } from "@/lib/workspace";
import { VoiceTabs } from "../voice-tabs";
import { deletePronunciation } from "./actions";
import { PronunciationForm } from "./pronunciation-form";

export const dynamic = "force-dynamic";

const LANG_LABEL = { vi: "Tiếng Việt", en: "English" } as const;

/**
 * The shared pronunciation dictionary: a word as written → how the voice-over reads it, for every workspace and
 * every voice. Anyone who edits projects adds and fixes entries; captions keep the word as written.
 */
export default async function PronunciationsPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const ws = await requireWorkspace();
  const writer = canWrite(ws);
  const q = ((await searchParams).q ?? "").trim().toLowerCase();
  const rows = await withOrgContext(ws, (tx) =>
    tx
      .select({
        id: schema.pronunciations.id,
        language: schema.pronunciations.language,
        term: schema.pronunciations.term,
        replacement: schema.pronunciations.replacement,
        createdAt: schema.pronunciations.createdAt,
        createdByName: schema.user.name,
      })
      .from(schema.pronunciations)
      .leftJoin(schema.user, eq(schema.user.id, schema.pronunciations.createdBy))
      .where(isNull(schema.pronunciations.organizationId))
      .orderBy(asc(schema.pronunciations.language), desc(schema.pronunciations.createdAt), asc(schema.pronunciations.term)),
  );
  const shown = q ? rows.filter((r) => r.term.toLowerCase().includes(q) || r.replacement.toLowerCase().includes(q)) : rows;

  return (
    <div className="mx-auto max-w-5xl space-y-5 sm:space-y-6">
      <VoiceTabs active="pronunciations" />

      {writer ? (
        <Card>
          <CardHeader>
            <CardTitle>Thêm cách đọc</CardTitle>
            <CardDescription>
              Giọng đọc sai một từ (tên báo, tên riêng, viết tắt)? Thêm vào đây một lần, mọi video mới của mọi workspace sẽ đọc đúng. Phụ đề vẫn hiện từ như viết. Viết phần «Đọc là» theo cách phát âm tiếng Việt (VnExpress → Vi En Express). Khớp nguyên từ, phân biệt hoa thường.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <PronunciationForm />
          </CardContent>
        </Card>
      ) : null}

      <section aria-labelledby="dict-heading" className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2 px-1">
          <h2 id="dict-heading" className="text-sm font-medium text-muted-foreground">
            Từ điển · {rows.length}
          </h2>
          <form className="w-full sm:w-64" role="search">
            <input
              name="q"
              defaultValue={q}
              placeholder="Tìm từ…"
              aria-label="Tìm trong từ điển"
              className="h-8 w-full rounded-lg border bg-card px-2.5 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/40 pointer-coarse:h-10"
            />
          </form>
        </div>
        {shown.length === 0 ? (
          <p className="rounded-xl bg-card p-6 text-center text-sm text-muted-foreground shadow-xs ring-1 ring-border">{q ? "Không có từ nào khớp." : "Từ điển đang trống."}</p>
        ) : (
          <ul className="divide-y rounded-xl bg-card shadow-xs ring-1 ring-border">
            {shown.map((r) => (
              <li key={r.id} className="px-3 py-3 sm:px-4">
                {writer ? (
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <PronunciationForm entry={{ id: r.id, language: r.language, term: r.term, replacement: r.replacement }} />
                      <p className="mt-1 text-xs text-muted-foreground">
                        {LANG_LABEL[r.language]}
                        {r.createdByName ? ` · thêm bởi ${r.createdByName}` : " · có sẵn"} · {timeAgo(r.createdAt)}
                      </p>
                    </div>
                    <ActionForm action={deletePronunciation}>
                      <input type="hidden" name="id" value={r.id} />
                      <Button type="submit" size="icon-sm" variant="ghost" className="text-destructive" aria-label={`Xoá “${r.term}”`} title="Xoá khỏi từ điển (video đã dựng giữ nguyên)">
                        <Trash2 />
                      </Button>
                    </ActionForm>
                  </div>
                ) : (
                  <div className="text-sm">
                    <span className="font-medium">{r.term}</span> → {r.replacement} <span className="text-xs text-muted-foreground">· {LANG_LABEL[r.language]}</span>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
