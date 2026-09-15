import { db, schema } from "@/db";
import { ActionForm } from "@/components/action-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FEATURE_FLAGS, INTEGRATIONS } from "@/lib/integrations";
import { maskSecret, readSecret } from "@/lib/vault";
import { clearIntegrationSecret, saveIntegration, setFeatureFlag } from "./actions";

export const dynamic = "force-dynamic";

export default async function IntegrationsPage() {
  const [rows, flags] = await Promise.all([db.select().from(schema.integrations), db.select().from(schema.featureFlags)]);
  const byProvider = new Map(rows.map((r) => [r.provider, r]));
  const flagByKey = new Map(flags.map((f) => [f.key, f]));
  const previews = new Map<string, string>();
  await Promise.all(
    rows.map(async (r) => {
      if (!r.vaultRef) return;
      try {
        previews.set(r.provider, maskSecret(await readSecret(r.vaultRef)));
      } catch {
        previews.set(r.provider, "(vault read failed)");
      }
    }),
  );

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-xl font-semibold">Integrations</h1>
        <p className="text-sm text-muted-foreground">
          Shared API keys. Secrets are written to Supabase Vault; only a masked preview is shown here. Deployment credentials (AWS, Google
          service account, Inngest, R2) stay in Vercel env vars.
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {INTEGRATIONS.map((i) => {
          const row = byProvider.get(i.provider);
          return (
            <Card key={i.provider}>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base">{i.label}</CardTitle>
                  {row?.enabled ? <Badge>enabled</Badge> : <Badge variant="secondary">disabled</Badge>}
                </div>
                <CardDescription>
                  {row?.vaultRef ? (
                    <>
                      Secret set <span className="font-mono">{previews.get(i.provider)}</span>
                    </>
                  ) : (
                    "No secret stored"
                  )}
                  {row?.updatedAt ? ` · updated ${row.updatedAt.toISOString().slice(0, 10)}` : null}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <ActionForm action={saveIntegration} className="space-y-3" resetOnSuccess>
                  <input type="hidden" name="provider" value={i.provider} />
                  <div className="space-y-1">
                    <Label htmlFor={`${i.provider}-secret`}>{i.secretLabel}</Label>
                    <Input id={`${i.provider}-secret`} name="secret" type="password" autoComplete="off" placeholder={row?.vaultRef ? "Leave blank to keep current" : ""} />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    {i.hasSpendCap ? (
                      <div className="space-y-1">
                        <Label htmlFor={`${i.provider}-cap`}>Monthly spend cap (USD)</Label>
                        <Input id={`${i.provider}-cap`} name="spendCap" type="number" step="0.01" min="0" defaultValue={row?.spendCapMonthlyUsd ?? ""} />
                      </div>
                    ) : null}
                    {i.hasCredits ? (
                      <div className="space-y-1">
                        <Label htmlFor={`${i.provider}-credits`}>Credits remaining</Label>
                        <Input id={`${i.provider}-credits`} name="credits" type="number" min="0" defaultValue={row?.creditsRemaining ?? ""} />
                      </div>
                    ) : null}
                  </div>
                  <div className="flex items-center justify-between">
                    <label className="flex items-center gap-2 text-sm">
                      <input type="checkbox" name="enabled" defaultChecked={row?.enabled ?? false} className="size-4" />
                      Enabled
                    </label>
                    <Button type="submit" size="sm">
                      Save
                    </Button>
                  </div>
                </ActionForm>
                {row?.vaultRef ? (
                  <ActionForm action={clearIntegrationSecret} className="mt-2 text-right">
                    <input type="hidden" name="provider" value={i.provider} />
                    <Button type="submit" size="sm" variant="ghost" className="text-destructive">
                      Remove secret
                    </Button>
                  </ActionForm>
                ) : null}
              </CardContent>
            </Card>
          );
        })}
      </div>

      <div>
        <h2 className="text-lg font-semibold">Feature flags</h2>
        <div className="mt-3 divide-y rounded-md border">
          {FEATURE_FLAGS.map((f) => {
            const row = flagByKey.get(f.key);
            return (
              <ActionForm key={f.key} action={setFeatureFlag} className="flex items-center justify-between gap-4 px-4 py-3">
                <input type="hidden" name="key" value={f.key} />
                <div>
                  <div className="text-sm font-medium">{f.label}</div>
                  {f.description ? <div className="text-xs text-muted-foreground">{f.description}</div> : null}
                </div>
                <div className="flex items-center gap-3">
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" name="enabled" defaultChecked={row?.enabled ?? false} className="size-4" />
                    {row?.enabled ? "on" : "off"}
                  </label>
                  <Button type="submit" size="sm" variant="outline">
                    Apply
                  </Button>
                </div>
              </ActionForm>
            );
          })}
        </div>
      </div>
    </div>
  );
}
