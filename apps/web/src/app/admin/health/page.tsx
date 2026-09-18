import { ActionForm } from "@/components/action-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { loadAdminRecentRenders } from "@/lib/admin-data";
import { STEP_LABEL } from "@/lib/project-state";
import { findStalledQueue, inngestStatus } from "@/lib/queue-health";
import { headObject, presignGet } from "@/lib/r2";
import { triggerTestRender } from "./actions";

export const dynamic = "force-dynamic";

const ENV_CHECKS: Array<[string, string]> = [
  ["DATABASE_URL", "Supabase (pooled)"],
  ["BETTER_AUTH_SECRET", "Better Auth"],
  ["GOOGLE_CLIENT_ID", "Google OAuth"],
  ["INNGEST_SIGNING_KEY", "Inngest"],
  ["CRON_SECRET", "Cron routes (/api/cron/*, external scheduler)"],
  ["R2_ACCESS_KEY_ID", "Cloudflare R2"],
  ["REMOTION_AWS_ACCESS_KEY_ID", "AWS (Remotion + media Lambda)"],
  ["REMOTION_FUNCTION_NAME", "Remotion Lambda function"],
  ["REMOTION_SERVE_URL", "Remotion site bundle"],
  ["MEDIA_LAMBDA_FUNCTION_NAME", "Media Lambda"],
  ["GOOGLE_APPLICATION_CREDENTIALS_JSON", "Google Cloud service account (TTS/STT)"],
  ["CLOUDFLARE_API_TOKEN", "Cloudflare API (Browser Rendering, R2 lifecycle)"],
];

export default async function HealthPage() {
  // The R2 probe is a network call: run it next to the (single) database round-trip, not after it.
  // The queue checks ride along with the R2 probe: one more service read in parallel does not lengthen the page.
  const [renders, stalled, inngest, r2Status] = await Promise.all([
    loadAdminRecentRenders(20),
    findStalledQueue().catch(() => null),
    inngestStatus(),
    headObject("tmp/_test/.probe").then(
      (h) => (h.exists ? "reachable" : "reachable (bucket empty)"),
      (e) => `error: ${e instanceof Error ? e.message : String(e)}`,
    ),
  ]);
  const links = new Map<string, string>();
  for (const r of renders) {
    if (r.outputPath && r.status === "done") {
      try {
        links.set(r.id, await presignGet(r.outputPath, 600));
      } catch {
        /* ignore */
      }
    }
  }

  return (
    <div className="space-y-6">
      <h1 className="sr-only">Health</h1>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Configuration</CardTitle>
            <CardDescription>Presence of deployment env vars (values never shown).</CardDescription>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            {ENV_CHECKS.map(([key, label]) => (
              <div key={key} className="flex items-center justify-between">
                <span>
                  {label} <code className="text-xs text-muted-foreground">{key}</code>
                </span>
                {process.env[key] ? <Badge>set</Badge> : <Badge variant="destructive">missing</Badge>}
              </div>
            ))}
            <div className="flex items-center justify-between border-t pt-2">
              <span>R2 bucket</span>
              <span className="text-xs">{r2Status}</span>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">End-to-end test render</CardTitle>
            <CardDescription>
              Inngest → Remotion Lambda (ap-southeast-1) → R2 → media Lambda QA probe → usage_costs. Expect 1080×1920 @
              30 fps, H.264.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ActionForm action={triggerTestRender} className="flex items-end gap-2">
              <label className="text-sm">
                Duration (s)
                <Input name="durationSec" type="number" min="3" max="60" defaultValue={6} className="w-24" />
              </label>
              <Button type="submit" size="sm" className="self-auto sm:self-start">
                Run test render
              </Button>
            </ActionForm>
            <p className="mt-2 text-xs text-muted-foreground">
              Inngest dashboard shows step-by-step progress; the table below refreshes on reload.
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2 text-base">
            Background queue (Inngest)
            {stalled === null ? <Badge variant="secondary">unknown</Badge> : stalled.length ? <Badge variant="destructive">{stalled.length} step(s) waiting</Badge> : <Badge>picking up</Badge>}
            {inngest ? <Badge variant={inngest.indicator === "none" ? "default" : "destructive"}>{inngest.description}</Badge> : <Badge variant="secondary">status page unreadable</Badge>}
          </CardTitle>
          <CardDescription>
            Steps requested more than 90 s ago that the queue has not started (what users see as “Đang xếp hàng…”), next to status.inngest.com. Fetch and script can be run directly from the project page; the other steps wait for the queue.
          </CardDescription>
        </CardHeader>
        {stalled?.length || inngest?.incidents.length ? (
          <CardContent className="space-y-2 text-sm">
            {inngest?.incidents.map((i) => (
              <p key={i.name + i.since}>
                <b>{i.name}</b> · {i.status} · since {i.since.replace("T", " ").slice(0, 16)} UTC
              </p>
            ))}
            {stalled?.map((s) => (
              <p key={s.projectId} className="text-xs text-muted-foreground">
                {STEP_LABEL[s.step] ?? s.step} · project <code>{s.projectId}</code> · waiting since {s.since.replace("T", " ").slice(0, 19)} UTC
              </p>
            ))}
          </CardContent>
        ) : null}
      </Card>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Created</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Duration</TableHead>
            <TableHead>Cost</TableHead>
            <TableHead>QA</TableHead>
            <TableHead>Output</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {renders.map((r) => {
            const qa = (r.qaJson ?? {}) as { checks?: Record<string, { ok: boolean }>; error?: string };
            const failed = Object.entries(qa.checks ?? {})
              .filter(([, c]) => !c.ok)
              .map(([k]) => k);
            return (
              <TableRow key={r.id}>
                <TableCell className="text-xs text-muted-foreground">
                  {r.createdAt.toISOString().replace("T", " ").slice(0, 19)}
                </TableCell>
                <TableCell>
                  <Badge
                    variant={
                      r.status === "done"
                        ? "default"
                        : r.status === "failed" || r.status === "qa_failed"
                          ? "destructive"
                          : "secondary"
                    }
                  >
                    {r.status}
                  </Badge>
                </TableCell>
                <TableCell className="tabular-nums">{r.durationSec ? `${r.durationSec}s` : "—"}</TableCell>
                <TableCell className="tabular-nums">{r.costUsd ? `$${r.costUsd}` : "—"}</TableCell>
                <TableCell className="text-xs">
                  {failed.length ? `failed: ${failed.join(", ")}` : (qa.error ?? (r.status === "done" ? "passed" : ""))}
                </TableCell>
                <TableCell>
                  {links.get(r.id) ? (
                    <a className="text-xs underline" href={links.get(r.id)} target="_blank" rel="noreferrer">
                      open
                    </a>
                  ) : (
                    <span className="text-xs text-muted-foreground">{r.error?.slice(0, 80)}</span>
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
