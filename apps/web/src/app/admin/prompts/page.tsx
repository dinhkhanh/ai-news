import Link from "next/link";
import { and, desc, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { ActionForm } from "@/components/action-form";
import { AutoRefresh } from "@/components/auto-refresh";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { NativeSelect } from "@/components/ui/native-select";
import type { EvalSummary } from "@/lib/eval-summary";
import { PROMPT_PURPOSES } from "@/lib/integrations";
import { KNOWN_PLACEHOLDERS } from "@/lib/llm/render";
import { defaultTemplate, DURATION_PRESETS, SCRIPT_TONES } from "@/lib/prompts/defaults";
import { runPromptEval } from "../evals/actions";
import { createPromptVersion, promotePromptVersion } from "./actions";

export const dynamic = "force-dynamic";

const EVALUABLE = new Set(["script", "faithfulness"]);

function EvalBadge({ evalJson }: { evalJson: Record<string, unknown> | null }) {
  const s = evalJson as (EvalSummary & { evalId?: string; at?: string }) | null;
  if (!s || typeof s.score !== "number") return <Badge variant="outline">no eval</Badge>;
  return (
    <Link href={`/admin/evals?run=${s.evalId ?? ""}`} className="inline-flex items-center gap-1">
      <Badge variant={s.score >= 80 ? "default" : s.score >= 60 ? "secondary" : "destructive"}>eval {s.score}/100</Badge>
      <span className="text-xs text-muted-foreground">
        unsup. {(s.unsupportedRate * 100).toFixed(0)}% · ±{s.avgDurationDeviationPct}% · ${s.totalCostUsd}
      </span>
    </Link>
  );
}

export default async function PromptsPage({ searchParams }: { searchParams: Promise<{ purpose?: string; language?: string }> }) {
  const sp = await searchParams;
  const purpose = PROMPT_PURPOSES.includes(sp.purpose as never) ? (sp.purpose as (typeof PROMPT_PURPOSES)[number]) : "script";
  const language = sp.language === "en" ? "en" : "vi";
  // Template bodies are long: load them for the pair on screen only; the tab strip just needs to know which pairs have a promoted version.
  const [versions, promotedPairs, running] = await Promise.all([
    db
      .select()
      .from(schema.promptTemplates)
      .where(and(eq(schema.promptTemplates.purpose, purpose), eq(schema.promptTemplates.language, language)))
      .orderBy(desc(schema.promptTemplates.version)),
    db.select({ purpose: schema.promptTemplates.purpose, language: schema.promptTemplates.language }).from(schema.promptTemplates).where(eq(schema.promptTemplates.promoted, true)),
    db.query.promptEvals.findFirst({ columns: { id: true }, where: (e, { inArray }) => inArray(e.status, ["queued", "running"]) }),
  ]);
  const promoted = versions.find((v) => v.promoted);
  const builtIn = defaultTemplate(purpose, language);
  const evaluable = EVALUABLE.has(purpose);

  return (
    <div className="space-y-6">
      <AutoRefresh active={Boolean(running)} everyMs={6000} />
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Prompt templates</h1>
        <p className="text-sm text-muted-foreground">
          One promoted version per purpose and language is used by the pipeline. Every save creates a new version; run an eval on it, then promote.
          Promoting an older version rolls back. Without any promoted version the built-in default is used.{" "}
          <Link href="/admin/evals" className="underline">
            Manage the eval set
          </Link>
          .
        </p>
      </div>

      <div className="flex max-w-full gap-0.5 overflow-x-auto rounded-lg bg-muted p-0.5 scrollbar-none">
        {PROMPT_PURPOSES.map((p) =>
          (["vi", "en"] as const).map((l) => {
            const active = p === purpose && l === language;
            const has = promotedPairs.some((t) => t.purpose === p && t.language === l);
            return (
              <a
                key={`${p}-${l}`}
                href={`/admin/prompts?purpose=${p}&language=${l}`}
                aria-current={active ? "true" : undefined}
                className={`inline-flex h-8 shrink-0 items-center rounded-md px-2.5 text-xs font-medium whitespace-nowrap pointer-coarse:h-9 ${active ? "bg-card text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground"}`}
              >
                {p} / {l} {has ? "●" : "○"}
              </a>
            );
          }),
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              New version · {purpose} / {language} {promoted ? `(current v${promoted.version})` : builtIn ? "(built-in default in use)" : "(none promoted)"}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ActionForm action={createPromptVersion} className="space-y-3">
              <input type="hidden" name="purpose" value={purpose} />
              <input type="hidden" name="language" value={language} />
              <div className="space-y-1">
                <Label htmlFor="body">Template body (system instruction)</Label>
                <Textarea id="body" name="body" rows={18} className="font-mono text-xs" defaultValue={promoted?.body ?? builtIn?.body ?? ""} required />
                <p className="text-xs text-muted-foreground">
                  Placeholders: {KNOWN_PLACEHOLDERS.map((p) => `{{${p}}}`).join(", ")}. The article is appended automatically as a cached block unless{" "}
                  {"{{article_text}}"} is used. Output structure is fixed by the schema; the template explains meaning and rules.
                </p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label htmlFor="model">Model override</Label>
                  <Input id="model" name="model" placeholder="claude-opus-5" defaultValue={promoted?.model ?? builtIn?.model ?? ""} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="notes">Change note</Label>
                  <Input id="notes" name="notes" placeholder="What changed and why" />
                </div>
              </div>
              <div className="flex items-center justify-between">
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" name="promote" className="size-4" /> Promote immediately (skips eval)
                </label>
                <Button type="submit" size="sm">
                  Save version
                </Button>
              </div>
            </ActionForm>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Versions</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {versions.length === 0 ? <p className="text-sm text-muted-foreground">No saved versions; the built-in default is active.</p> : null}
            {versions.map((v) => {
              const promotedEval = promoted?.evalJson as EvalSummary | null | undefined;
              const thisEval = v.evalJson as EvalSummary | null;
              const worse = Boolean(!v.promoted && promotedEval && typeof promotedEval.score === "number" && thisEval && thisEval.score < promotedEval.score);
              return (
                <details key={v.id} className="rounded-lg border p-3" open={v.promoted}>
                  <summary className="flex cursor-pointer flex-wrap items-center gap-2 text-sm">
                    <span className="font-medium">v{v.version}</span>
                    {v.promoted ? <Badge>promoted</Badge> : null}
                    <EvalBadge evalJson={v.evalJson} />
                    <span className="text-xs text-muted-foreground">{v.createdAt.toISOString().slice(0, 16).replace("T", " ")}</span>
                  </summary>
                  {v.notes ? <p className="mt-2 text-xs text-muted-foreground">{v.notes}</p> : null}
                  {v.model ? <p className="mt-1 text-xs">model: {v.model}</p> : null}
                  <div className="mt-2 flex flex-wrap items-end gap-2">
                    {evaluable ? (
                      <ActionForm action={runPromptEval} className="flex flex-wrap items-end gap-2">
                        <input type="hidden" name="templateId" value={v.id} />
                        <NativeSelect name="durationSec" defaultValue="60" fieldSize="sm">
                          {DURATION_PRESETS.map((d) => (
                            <option key={d} value={d}>
                              {d}s
                            </option>
                          ))}
                        </NativeSelect>
                        <NativeSelect name="tone" defaultValue="news" fieldSize="sm">
                          {SCRIPT_TONES.map((t) => (
                            <option key={t.key} value={t.key}>
                              {t.en}
                            </option>
                          ))}
                        </NativeSelect>
                        <Button type="submit" size="sm" variant="outline" disabled={Boolean(running)}>
                          {running ? "eval running…" : "Run eval"}
                        </Button>
                      </ActionForm>
                    ) : null}
                    {!v.promoted ? (
                      <ActionForm action={promotePromptVersion} className="ml-auto flex items-center gap-2">
                        <input type="hidden" name="id" value={v.id} />
                        {worse ? <span className="text-xs text-destructive">scores below the promoted version</span> : null}
                        {evaluable && !thisEval ? <span className="text-xs text-muted-foreground">not evaluated</span> : null}
                        <Button type="submit" size="sm" variant={worse ? "ghost" : "default"}>
                          {v.version < (promoted?.version ?? 0) ? "Roll back to this" : "Promote"}
                        </Button>
                      </ActionForm>
                    ) : null}
                  </div>
                  <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 text-xs">{v.body}</pre>
                </details>
              );
            })}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
