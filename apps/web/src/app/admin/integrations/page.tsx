import { ActionForm } from "@/components/action-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { loadAdminIntegrations } from "@/lib/admin-data";
import { FEATURE_FLAGS, flagDefault, INTEGRATIONS } from "@/lib/integrations";
import { clearIntegrationSecret, saveIntegration, setFeatureFlag } from "./actions";

export const dynamic = "force-dynamic";

export default async function IntegrationsPage() {
  // One round-trip: admin_integrations_page() (migration 0013) also masks the Vault secrets in the database.
  const { integrations: rows, flags } = await loadAdminIntegrations();
  const byProvider = new Map(rows.map((r) => [r.provider, r]));

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Integrations</h1>
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
                  {row?.hasSecret ? (
                    <>
                      Secret set <span className="font-mono">{row.preview}</span>
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
                    <Input id={`${i.provider}-secret`} name="secret" type="password" autoComplete="off" placeholder={row?.hasSecret ? "Leave blank to keep current" : ""} />
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
                {row?.hasSecret ? (
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
            const on = flags[f.key] ?? flagDefault(f.key);
            return (
              <ActionForm key={f.key} action={setFeatureFlag} className="flex items-center justify-between gap-4 px-4 py-3">
                <input type="hidden" name="key" value={f.key} />
                <div>
                  <div className="text-sm font-medium">{f.label}</div>
                  {f.description ? <div className="text-xs text-muted-foreground">{f.description}</div> : null}
                </div>
                <div className="flex items-center gap-3">
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" name="enabled" defaultChecked={on} className="size-4" />
                    {on ? "on" : "off"}
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
