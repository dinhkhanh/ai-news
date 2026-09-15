import "server-only";
import { sql } from "@/db";

/**
 * Supabase Vault wrapper. Secrets never leave the server; callers get the
 * secret id (uuid) to store in *_vault_ref columns.
 */
export async function createSecret(name: string, secret: string, description?: string): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    select vault.create_secret(${secret}, ${name}, ${description ?? ""}) as id`;
  return rows[0].id;
}

export async function updateSecret(id: string, secret: string, name?: string, description?: string): Promise<void> {
  await sql`select vault.update_secret(${id}::uuid, ${secret}, ${name ?? null}, ${description ?? null})`;
}

export async function readSecret(id: string): Promise<string | null> {
  const rows = await sql<{ decrypted_secret: string }[]>`
    select decrypted_secret from vault.decrypted_secrets where id = ${id}::uuid limit 1`;
  return rows[0]?.decrypted_secret ?? null;
}

export async function readSecretByName(name: string): Promise<string | null> {
  const rows = await sql<{ decrypted_secret: string }[]>`
    select decrypted_secret from vault.decrypted_secrets where name = ${name} order by created_at desc limit 1`;
  return rows[0]?.decrypted_secret ?? null;
}

export async function deleteSecret(id: string): Promise<void> {
  await sql`delete from vault.secrets where id = ${id}::uuid`;
}

/** Upsert by name; returns the secret id. */
export async function upsertSecret(name: string, secret: string, description?: string): Promise<string> {
  const rows = await sql<{ id: string }[]>`select id from vault.secrets where name = ${name} limit 1`;
  if (rows[0]) {
    await updateSecret(rows[0].id, secret, name, description);
    return rows[0].id;
  }
  return createSecret(name, secret, description);
}

/** Masked preview for the admin UI. */
export function maskSecret(s: string | null | undefined) {
  if (!s) return "";
  if (s.length <= 8) return "••••";
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}
