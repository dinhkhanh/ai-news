"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import type { SceneVerdict, StoredFaithfulness, StoredScript } from "@/lib/llm/schemas";
import { findRange } from "@/lib/text-match";
import { cn } from "@/lib/utils";

type Props = {
  article: { title: string | null; text: string; siteName: string | null; url: string; screenshotUrl: string | null };
  script: StoredScript;
  faithfulness: StoredFaithfulness | null;
  meta: { version: number; createdAt: string; costUsd: string; inputTokens: number; outputTokens: number };
};

const verdictVariant = (v?: SceneVerdict["verdict"]) => (v === "supported" ? "default" : v === "partial" ? "secondary" : v === "unsupported" ? "destructive" : "outline");
const verdictLabel = (v?: SceneVerdict["verdict"]) => (v === "supported" ? "Có căn cứ" : v === "partial" ? "Một phần" : v === "unsupported" ? "Không căn cứ" : "Chưa kiểm");

export function ScriptReview({ article, script, faithfulness, meta }: Props) {
  const [active, setActive] = useState<string | null>(null);
  const verdicts = useMemo(() => new Map((faithfulness?.scenes ?? []).map((s) => [s.sceneId, s])), [faithfulness]);
  const activeScene = script.scenes.find((s) => s.id === active) ?? null;
  const activeVerdict = active ? verdicts.get(active) : undefined;
  const range = useMemo(() => {
    if (!activeScene) return null;
    return findRange(article.text, activeVerdict?.evidence) ?? findRange(article.text, activeScene.supportingSentence);
  }, [article.text, activeScene, activeVerdict]);
  const markRef = useRef<HTMLElement>(null);
  useEffect(() => {
    markRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [range]);

  // Split the article into paragraphs while keeping absolute offsets for the highlight.
  const paragraphs = useMemo(() => {
    const out: Array<{ start: number; text: string }> = [];
    let pos = 0;
    for (const p of article.text.split("\n")) {
      if (p.trim()) out.push({ start: pos, text: p });
      pos += p.length + 1;
    }
    return out;
  }, [article.text]);

  const total = script.scenes.reduce((a, s) => a + s.durationSec, 0);

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      {/* ---- script ---- */}
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="text-base font-semibold">{script.title}</div>
            <div className="text-xs text-muted-foreground">
              v{meta.version} · {script.generation.model}
              {script.generation.servedBy ? ` (served by ${script.generation.servedBy})` : ""} · template v{script.generation.templateVersion} ·{" "}
              {script.generation.durationSec}s / {script.generation.tone} · est. {total.toFixed(0)}s · ${meta.costUsd} · {meta.inputTokens + meta.outputTokens} tokens
            </div>
          </div>
          {faithfulness ? (
            <div className="flex gap-1">
              <Badge>{faithfulness.counts.supported} ok</Badge>
              {faithfulness.counts.partial ? <Badge variant="secondary">{faithfulness.counts.partial} partial</Badge> : null}
              {faithfulness.counts.unsupported + faithfulness.counts.unchecked ? (
                <Badge variant="destructive">{faithfulness.counts.unsupported + faithfulness.counts.unchecked} unsupported</Badge>
              ) : null}
            </div>
          ) : (
            <Badge variant="outline">faithfulness check unavailable</Badge>
          )}
        </div>
        {faithfulness?.summary ? <p className="rounded-md border bg-muted/40 p-2 text-xs">{faithfulness.summary}</p> : null}
        {script.notes ? <p className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs dark:bg-amber-950/30">Ghi chú: {script.notes}</p> : null}

        <ol className="space-y-2">
          {script.scenes.map((s, i) => {
            const v = verdicts.get(s.id);
            const isActive = active === s.id;
            return (
              <li
                key={s.id}
                onClick={() => setActive(isActive ? null : s.id)}
                className={cn("cursor-pointer rounded-md border p-3 text-sm transition-colors hover:bg-muted/50", isActive && "border-primary bg-muted/60")}
              >
                <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span className="font-mono">{i + 1}</span>
                  <Badge variant="outline">{s.kind}</Badge>
                  <span>{s.durationSec}s</span>
                  <Badge variant={verdictVariant(v?.verdict)} className="ml-auto">
                    {verdictLabel(v?.verdict)}
                  </Badge>
                </div>
                <p className="leading-relaxed">{s.voiceover}</p>
                <p className="mt-1 text-xs">
                  <span className="text-muted-foreground">On screen:</span> <span className="font-medium">{s.onScreenText}</span>
                </p>
                {s.brollTerms.length || s.newsTerms?.length ? (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {/* What the voice-over names (other outlets' pictures, web video) reads first; English stock phrases after. */}
                    {(s.newsTerms ?? []).map((t) => (
                      <span key={`n-${t}`} className="rounded bg-primary/10 px-1.5 py-0.5 text-[11px] text-foreground" title="Tìm ảnh / video thật theo lời bình">
                        {t}
                      </span>
                    ))}
                    {s.brollTerms.map((t) => (
                      <span key={t} className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground" title="Từ khoá stock (tiếng Anh)">
                        {t}
                      </span>
                    ))}
                  </div>
                ) : null}
                {v?.note ? <p className="mt-2 text-xs text-destructive">{v.note}</p> : null}
                {isActive && (v?.evidence ?? s.supportingSentence) ? (
                  <p className="mt-2 border-l-2 pl-2 text-xs text-muted-foreground">
                    “{v?.evidence ?? s.supportingSentence}”{v?.evidence && faithfulness && !faithfulness.evidenceFound[s.id] ? " (quote not found verbatim in the article)" : ""}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ol>

        <details className="rounded-md border p-3 text-sm">
          <summary className="cursor-pointer font-medium">Platform metadata</summary>
          <div className="mt-2 grid gap-3 md:grid-cols-3">
            {(["youtube", "facebook", "tiktok"] as const).map((p) => (
              <div key={p} className="space-y-1 text-xs">
                <div className="font-semibold uppercase text-muted-foreground">{p}</div>
                <div className="font-medium">{script.metadata[p].title}</div>
                <div>{script.metadata[p].description}</div>
                <div className="text-muted-foreground">{script.metadata[p].hashtags.map((h) => `#${h}`).join(" ")}</div>
              </div>
            ))}
          </div>
        </details>
      </div>

      {/* ---- article ---- */}
      <div className="space-y-2 lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:overflow-auto">
        <div className="text-xs text-muted-foreground">
          {activeScene ? (range ? "Căn cứ được tô sáng trong bài." : "Không tìm thấy câu căn cứ nguyên văn trong bài.") : "Chọn một cảnh để xem căn cứ trong bài báo."}
        </div>
        <article className="rounded-md border p-4 text-sm leading-relaxed">
          <h3 className="mb-2 text-base font-semibold">{article.title}</h3>
          <p className="mb-3 text-xs text-muted-foreground">
            {article.siteName ? `${article.siteName} · ` : ""}
            <a href={article.url} target="_blank" rel="noreferrer" className="underline">
              {article.url}
            </a>
          </p>
          {paragraphs.map((p) => {
            const end = p.start + p.text.length;
            if (!range || range[1] <= p.start || range[0] >= end) return <p key={p.start} className="mb-2">{p.text}</p>;
            const a = Math.max(0, range[0] - p.start);
            const b = Math.min(p.text.length, range[1] - p.start);
            return (
              <p key={p.start} className="mb-2">
                {p.text.slice(0, a)}
                <mark ref={a === 0 && range[0] < p.start ? undefined : markRef} className="rounded bg-yellow-200 px-0.5 dark:bg-yellow-700/60">
                  {p.text.slice(a, b)}
                </mark>
                {p.text.slice(b)}
              </p>
            );
          })}
        </article>
        {article.screenshotUrl ? (
          <details className="text-xs">
            <summary className="cursor-pointer text-muted-foreground">Page screenshot</summary>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={article.screenshotUrl} alt="Article page screenshot" className="mt-2 w-full rounded-md border" />
          </details>
        ) : null}
      </div>
    </div>
  );
}
