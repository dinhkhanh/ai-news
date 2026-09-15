"use server";
import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { assertAdmin, run, str, type ActionState } from "@/lib/admin";
import { FEATURE_FLAGS, isIntegrationProvider } from "@/lib/integrations";
import { deleteSecret, upsertSecret } from "@/lib/vault";

export async function saveIntegration(_: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const { session, log } = await assertAdmin();
    const provider = str(fd, "provider");
    if (!isIntegrationProvider(provider)) throw new Error("Unknown provider");
    const secret = str(fd, "secret");
    const enabled = fd.get("enabled") === "on";
    const spendCapRaw = str(fd, "spendCap");
    const creditsRaw = str(fd, "credits");

    const existing = await db.query.integrations.findFirst({ where: eq(schema.integrations.provider, provider) });
    let vaultRef = existing?.vaultRef ?? null;
    if (secret) vaultRef = await upsertSecret(`integration:${provider}`, secret, `Shared ${provider} credential`);

    await db
      .insert(schema.integrations)
      .values({
        provider,
        vaultRef,
        enabled,
        spendCapMonthlyUsd: spendCapRaw ? Number(spendCapRaw).toFixed(2) : null,
        creditsRemaining: creditsRaw ? Math.trunc(Number(creditsRaw)) : null,
        updatedBy: session.user.id,
      })
      .onConflictDoUpdate({
        target: schema.integrations.provider,
        set: {
          vaultRef,
          enabled,
          spendCapMonthlyUsd: spendCapRaw ? Number(spendCapRaw).toFixed(2) : null,
          creditsRemaining: creditsRaw ? Math.trunc(Number(creditsRaw)) : null,
          updatedBy: session.user.id,
          updatedAt: new Date(),
        },
      });
    await log("admin.integration.saved", { provider, enabled, secretRotated: Boolean(secret) });
    revalidatePath("/admin/integrations");
    return `${provider} saved${secret ? " (secret stored in Vault)" : ""}`;
  });
}

export async function clearIntegrationSecret(_: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const { log } = await assertAdmin();
    const provider = str(fd, "provider");
    const existing = await db.query.integrations.findFirst({ where: eq(schema.integrations.provider, provider) });
    if (existing?.vaultRef) await deleteSecret(existing.vaultRef);
    await db.update(schema.integrations).set({ vaultRef: null, enabled: false }).where(eq(schema.integrations.provider, provider));
    await log("admin.integration.secret_cleared", { provider });
    revalidatePath("/admin/integrations");
    return `${provider} secret removed`;
  });
}

export async function setFeatureFlag(_: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const { session, log } = await assertAdmin();
    const key = str(fd, "key");
    const flag = FEATURE_FLAGS.find((f) => f.key === key);
    if (!flag) throw new Error("Unknown flag");
    const enabled = fd.get("enabled") === "on";
    await db
      .insert(schema.featureFlags)
      .values({ key, enabled, description: flag.description, updatedBy: session.user.id })
      .onConflictDoUpdate({ target: schema.featureFlags.key, set: { enabled, updatedBy: session.user.id, updatedAt: new Date() } });
    await log("admin.feature_flag.set", { key, enabled });
    revalidatePath("/admin/integrations");
    return `${flag.label}: ${enabled ? "on" : "off"}`;
  });
}
