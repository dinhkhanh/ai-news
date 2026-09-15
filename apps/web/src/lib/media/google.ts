import "server-only";
import { env } from "@/lib/env";

/** Service-account credentials for Google Cloud clients (TTS, STT, Vertex). */
export function googleCredentials() {
  const raw = env().GOOGLE_APPLICATION_CREDENTIALS_JSON;
  if (!raw) throw new Error("GOOGLE_APPLICATION_CREDENTIALS_JSON is not set");
  const credentials = JSON.parse(raw) as { client_email: string; private_key: string; project_id?: string };
  return { credentials, projectId: credentials.project_id };
}

export const GOOGLE_LANG: Record<"vi" | "en", string> = { vi: "vi-VN", en: "en-US" };
