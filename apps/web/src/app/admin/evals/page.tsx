import Link from "next/link";
import { desc, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { withServiceContext } from "@/db/context";
import { ActionForm } from "@/components/action-form";
import { AutoRefresh } from "@/components/auto-refresh";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import type { EvalArticleResult, EvalSummary } from "@/lib/eval-summary";
import { addEvalArticle, deleteEvalArticle, importEvalArticleFromProject, toggleEvalArticle } from "./actions";

export const dynamic = "force-dynamic";

export default async function EvalsPage({ searchParams }: { searchParams: Promise<{ run?: string }> }) {
  const sp = await searchParams;
  const [articles, runs, recentProjects] = await Promise.all([
    db.select().from(schema.evalArticles).orderBy(desc(schema.evalArticles.createdAt)),
    db
      .select({
        id: schema.promptEvals.id,
        status: schema.promptEvals.status,
        durationSec: schema.promptEvals.durationSec,
        tone: schema.promptEvals.tone,
        articleCount: schema.promptEvals.articleCount,
        summary: schema.promptEvals.summary,
        results: schema.promptEvals.results,
        costUsd: schema.promptEvals.costUsd,
        error: schema.promptEvals.error,
        createdAt: schema.promptEvals.createdAt,
        finishedAt: schema.promptEvals.finishedAt,
        purpose: schema.promptTemplates.purpose,
        language: schema.promptTemplates.language,
        version: schema.promptTemplates.version,
        templateId: schema.promptTemplates.id,
      })
      .from(schema.promptEvals)
      .innerJoin(schema.promptTemplates, eq(schema.promptTemplates.id, schema.promptEvals.templateId))
      .orderBy(desc(schema.promptEvals.createdAt))
      .limit(30),
    withServiceContext((tx) =>
      tx
        .select({ id: schema.projects.id, title: schema.projects.title, url: schema.projects.url, language: schema.projects.language, state: schema.projects.state })
        .from(schema.projects)
        .where(eq(schema.projects.state, "scripted"))
        .orderBy(desc(schema.projects.createdAt))
        .limit(15),
    ),
  ]);
  const active = runs.find((r) => r.id === sp.run) ?? runs[0] ?? null;
  const anyRunning = runs.some((r) => r.status === "queued" || r.status === "running");
  const counts = { vi: articles.filter((a) => a.language === "vi" && a.enabled).length, en: articles.filter((a) => a.language === "en" && a.enabled).length };

  return (
    <div className="space-y-8">
      <AutoRefresh active={anyRunning} everyMs={5000} />
      <div>
        <h1 className="text-xl font-semibold">Eval set & runs</h1>
        <p className="text-sm text-muted-foreground">
          Target: ~20 articles, mostly Vietnamese (docs/PLAN.md §9). Enabled now: {counts.vi} vi · {counts.en} en. Runs are started from{" "}
          <Link href="/admin/prompts" className="underline">
            Prompt templates
          </Link>
          ; each run generates a script + faithfulness pass per article with the version under test.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Add an eval article</CardTitle>
            <CardDescription>Paste the article text. Optional expectations are checked against the generated script (case-insensitive substring).</CardDescription>
          </CardHeader>
          <CardContent>
            <ActionForm action={addEvalArticle} className="space-y-3" resetOnSuccess>
              <div className="grid gap-3 md:grid-cols-[1fr_auto]">
                <div className="space-y-1">
                  <Label htmlFor="ev-title">Title</Label>
                  <Input id="ev-title" name="title" required />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="ev-lang">Language</Label>
                  <select id="ev-lang" name="language" defaultValue="vi" className="h-9 rounded-md border bg-background px-2 text-sm">
                    <option value="vi">vi</option>
                    <option value="en">en</option>
                  </select>
                </div>
              </div>
              <div className="space-y-1">
                <Label htmlFor="ev-url">Source URL (optional)</Label>
                <Input id="ev-url" name="sourceUrl" type="url" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="ev-text">Article text</Label>
                <Textarea id="ev-text" name="text" rows={10} required className="text-xs" />
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor="ev-must">Must mention (one per line)</Label>
                  <Textarea id="ev-must" name="mustMention" rows={3} className="text-xs" placeholder="tên, số liệu, địa danh phải xuất hiện" />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="ev-mustnot">Must not mention (one per line)</Label>
                  <Textarea id="ev-mustnot" name="mustNotMention" rows={3} className="text-xs" placeholder="ví dụ: tên trẻ vị thành niên" />
                </div>
              </div>
              <div className="flex items-end justify-between gap-3">
                <div className="flex-1 space-y-1">
                  <Label htmlFor="ev-notes">Notes</Label>
                  <Input id="ev-notes" name="notes" placeholder="Why this article is in the set" />
                </div>
                <Button type="submit" size="sm">
                  Add
                </Button>
              </div>
            </ActionForm>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Import from a real project</CardTitle>
            <CardDescription>Copies the confirmed article text of a scripted project into the eval set.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {recentProjects.length === 0 ? <p className="text-sm text-muted-foreground">No scripted projects yet.</p> : null}
            {recentProjects.map((p) => (
              <ActionForm key={p.id} action={importEvalArticleFromProject} className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
                <input type="hidden" name="projectId" value={p.id} />
                <span className="truncate">
                  <Badge variant="outline" className="mr-2">
                    {p.language}
                  </Badge>
                  {p.title ?? p.url}
                </span>
                <Button type="submit" size="sm" variant="outline">
                  Import
                </Button>
              </ActionForm>
            ))}
          </CardContent>
        </Card>
      </div>

      <div>
        <h2 className="text-lg font-semibold">Articles ({articles.length})</h2>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Title</TableHead>
              <TableHead>Lang</TableHead>
              <TableHead>Words</TableHead>
              <TableHead>Expectations</TableHead>
              <TableHead>Enabled</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {articles.map((a) => (
              <TableRow key={a.id}>
                <TableCell className="max-w-sm">
                  <div className="truncate font-medium">{a.title}</div>
                  {a.sourceUrl ? (
                    <a href={a.sourceUrl} target="_blank" rel="noreferrer" className="block truncate text-xs text-muted-foreground underline">
                      {a.sourceUrl}
                    </a>
                  ) : null}
                  {a.notes ? <div className="text-xs text-muted-foreground">{a.notes}</div> : null}
                </TableCell>
                <TableCell>{a.language}</TableCell>
                <TableCell className="tabular-nums">{a.text.split(/\s+/).length}</TableCell>
                <TableCell className="text-xs">
                  {(a.expectations.mustMention?.length ?? 0) + (a.expectations.mustNotMention?.length ?? 0) || "—"}
                </TableCell>
                <TableCell>
                  <ActionForm action={toggleEvalArticle} className="flex items-center gap-2">
                    <input type="hidden" name="id" value={a.id} />
                    <input type="checkbox" name="enabled" defaultChecked={a.enabled} className="size-4" />
                    <Button type="submit" size="sm" variant="ghost">
                      apply
                    </Button>
                  </ActionForm>
                </TableCell>
                <TableCell>
                  <ActionForm action={deleteEvalArticle}>
                    <input type="hidden" name="id" value={a.id} />
                    <Button type="submit" size="sm" variant="ghost" className="text-destructive">
                      remove
                    </Button>
                  </ActionForm>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <div className="space-y-3">
        <h2 className="text-lg font-semibold">Runs</h2>
        <div className="flex flex-wrap gap-1 text-xs">
          {runs.map((r) => (
            <Link key={r.id} href={`/admin/evals?run=${r.id}`} className={`rounded-full border px-2 py-0.5 ${active?.id === r.id ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}>
              {r.purpose}/{r.language} v{r.version} · {r.status} · {r.createdAt.toISOString().slice(5, 16).replace("T", " ")}
            </Link>
          ))}
          {runs.length === 0 ? <span className="text-muted-foreground">No runs yet.</span> : null}
        </div>
        {active ? <RunDetail run={active} /> : null}
      </div>
    </div>
  );
}

function RunDetail({ run }: { run: { id: string; status: string; purpose: string; language: string; version: number; durationSec: number; tone: string; articleCount: number; summary: Record<string, unknown> | null; results: Array<Record<string, unknown>>; costUsd: string; error: string | null; createdAt: Date; finishedAt: Date | null } }) {
  const s = run.summary as EvalSummary | null;
  const results = run.results as unknown as EvalArticleResult[];
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          {run.purpose}/{run.language} v{run.version} · {run.durationSec}s / {run.tone} ·{" "}
          <Badge variant={run.status === "done" ? "default" : run.status === "failed" ? "destructive" : "secondary"}>{run.status}</Badge>
        </CardTitle>
        <CardDescription>
          {run.articleCount} article(s) · ${run.costUsd}
          {run.finishedAt ? ` · finished ${run.finishedAt.toISOString().slice(0, 16).replace("T", " ")}` : ""}
          {run.error ? ` · ${run.error}` : ""}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {s ? (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-7 text-sm">
            {[
              ["Score", `${s.score}/100`],
              ["Failed", `${s.failed}/${s.articles}`],
              ["Unsupported scenes", `${(s.unsupportedRate * 100).toFixed(1)}%`],
              ["Partial scenes", `${(s.partialRate * 100).toFixed(1)}%`],
              ["Duration off", `${s.avgDurationDeviationPct}%`],
              ["Expectations", `${(s.expectationPassRate * 100).toFixed(0)}%`],
              ["Avg latency", `${(s.avgLatencyMs / 1000).toFixed(0)}s`],
            ].map(([k, v]) => (
              <div key={k} className="rounded-md border p-2">
                <div className="text-xs text-muted-foreground">{k}</div>
                <div className="font-semibold tabular-nums">{v}</div>
              </div>
            ))}
          </div>
        ) : null}
        {results.length ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Article</TableHead>
                <TableHead>Scenes</TableHead>
                <TableHead>Est. s</TableHead>
                <TableHead>ok / partial / unsup.</TableHead>
                <TableHead>Expectations</TableHead>
                <TableHead>Cost</TableHead>
                <TableHead>Hook</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {results.map((r) => (
                <TableRow key={r.articleId}>
                  <TableCell className="max-w-xs truncate">{r.title}</TableCell>
                  {r.ok ? (
                    <>
                      <TableCell>{r.scenes}</TableCell>
                      <TableCell className="tabular-nums">
                        {r.estimatedDurationSec} ({r.durationDeviationPct! > 0 ? "+" : ""}
                        {r.durationDeviationPct}%)
                      </TableCell>
                      <TableCell className="tabular-nums">
                        {r.supported} / {r.partial} / <span className={r.unsupported ? "text-destructive" : ""}>{r.unsupported}</span>
                      </TableCell>
                      <TableCell className="text-xs">
                        {r.expectationsMissed?.length ? <span className="text-destructive">missing: {r.expectationsMissed.join(", ")}</span> : null}
                        {r.forbiddenMentioned?.length ? <span className="text-destructive"> forbidden: {r.forbiddenMentioned.join(", ")}</span> : null}
                        {!r.expectationsMissed?.length && !r.forbiddenMentioned?.length ? "ok" : null}
                      </TableCell>
                      <TableCell className="tabular-nums">${((r.scriptCostUsd ?? 0) + (r.faithfulnessCostUsd ?? 0)).toFixed(3)}</TableCell>
                      <TableCell className="max-w-sm text-xs text-muted-foreground">{r.hook}</TableCell>
                    </>
                  ) : (
                    <TableCell colSpan={6} className="text-xs text-destructive">
                      {r.error}
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : null}
      </CardContent>
    </Card>
  );
}
