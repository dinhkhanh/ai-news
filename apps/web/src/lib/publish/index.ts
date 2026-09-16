import "server-only";
import { facebook, instagram } from "./meta";
import type { Platform } from "./platforms";
import { tiktok } from "./tiktok";
import type { PlatformClient } from "./types";
import { youtube } from "./youtube";

export const clients: Record<Platform, PlatformClient> = { youtube, facebook, instagram, tiktok };
export const clientFor = (platform: Platform) => clients[platform];

export { PlatformError } from "./types";
export type { CheckResult, PlatformClient, PublicationMetadata, PublishJob, StartResult } from "./types";
