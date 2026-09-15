import { desc } from "drizzle-orm";
import { db, schema } from "@/db";
import { ActionForm } from "@/components/action-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { PROMPT_PURPOSES } from "@/lib/integrations";
import { createPromptVersion, promotePromptVersion } from "./actions";

export const dynamic = "force-dynamic";

export default async function PromptsPage({ searchParams }: { searchParams: Promise<{ purpose?: string; language?: string }> }) {
  const sp = await searchParams;
  const purpose = PROMPT_PURPOSES.includes(sp.purpose as never) ? (sp.purpose as (typeof PROMPT_PURPOSES)[number]) : "script";
  const language = sp.language === "en" ? "en" : "vi";
  const all = await db.select().from(schema.promptTemplates).orderBy(desc(schema.promptTemplates.createdAt));
  const versions = all.filter((t) => t.purpose === purpose && t.language === language).sort((a, b) => b.version - a.version);
  const promoted = versions.find((v) => v.promoted);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Prompt templates</h1>
        <p className="text-sm text-muted-foreground">
          One promoted version per purpose and language is used by the pipeline. Every save creates a new version; promote to switch,
          promote an older version to roll back. Eval runs arrive in phase 2.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        {PROMPT_PURPOSES.map((p) =>
          (["vi", "en"] as const).map((l) => {
            const active = p === purpose && l === language;
            const has = all.some((t) => t.purpose === p && t.language === l && t.promoted);
            return (
              <a
                key={`${p}-${l}`}
                href={`/admin/prompts?purpose=${p}&language=${l}`}
                className={`rounded-full border px-3 py-1 text-xs ${active ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}
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
              New version · {purpose} / {language} {promoted ? `(current v${promoted.version})` : "(none promoted)"}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ActionForm action={createPromptVersion} className="space-y-3">
              <input type="hidden" name="purpose" value={purpose} />
              <input type="hidden" name="language" value={language} />
              <div className="space-y-1">
                <Label htmlFor="body">Template body</Label>
                <Textarea id="body" name="body" rows={18} className="font-mono text-xs" defaultValue={promoted?.body ?? ""} required />
                <p className="text-xs text-muted-foreground">
                  Placeholders: {"{{article_text}}"}, {"{{article_title}}"}, {"{{duration_sec}}"}, {"{{tone}}"}, {"{{language}}"}.
                </p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label htmlFor="model">Model override</Label>
                  <Input id="model" name="model" placeholder="claude-opus-5" defaultValue={promoted?.model ?? ""} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="notes">Change note</Label>
                  <Input id="notes" name="notes" placeholder="What changed and why" />
                </div>
              </div>
              <div className="flex items-center justify-between">
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" name="promote" className="size-4" /> Promote immediately
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
            {versions.length === 0 ? <p className="text-sm text-muted-foreground">No versions yet.</p> : null}
            {versions.map((v) => (
              <details key={v.id} className="rounded-md border p-3">
                <summary className="flex cursor-pointer items-center justify-between text-sm">
                  <span>
                    v{v.version} {v.promoted ? <Badge className="ml-2">promoted</Badge> : null}
                    <span className="ml-2 text-xs text-muted-foreground">{v.createdAt.toISOString().slice(0, 16).replace("T", " ")}</span>
                  </span>
                  {!v.promoted ? (
                    <ActionForm action={promotePromptVersion}>
                      <input type="hidden" name="id" value={v.id} />
                      <Button type="submit" size="sm" variant="outline">
                        Promote
                      </Button>
                    </ActionForm>
                  ) : null}
                </summary>
                {v.notes ? <p className="mt-2 text-xs text-muted-foreground">{v.notes}</p> : null}
                {v.model ? <p className="mt-1 text-xs">model: {v.model}</p> : null}
                <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 text-xs">{v.body}</pre>
              </details>
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
