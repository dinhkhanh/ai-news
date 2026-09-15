/**
 * Workspace (organization) roles and platform roles.
 * Shared by server (auth.ts) and client (auth-client.ts).
 */
import { createAccessControl } from "better-auth/plugins/access";
import { adminAc, defaultStatements } from "better-auth/plugins/organization/access";

export const statement = {
  ...defaultStatements,
  project: ["create", "read", "update", "delete"],
  script: ["generate", "edit"],
  asset: ["search", "upload", "generate_ai", "download_web"],
  timeline: ["edit"],
  render: ["request", "pin"],
  publication: ["create", "schedule", "override_faithfulness", "approve"],
  channel: ["use"],
  brand_kit: ["manage"],
  comment: ["create"],
} as const;

export const ac = createAccessControl(statement);

export const viewer = ac.newRole({
  project: ["read"],
});

export const editor = ac.newRole({
  project: ["create", "read", "update"],
  script: ["generate", "edit"],
  asset: ["search", "upload", "generate_ai", "download_web"],
  timeline: ["edit"],
  render: ["request"],
  comment: ["create"],
});

export const publisher = ac.newRole({
  project: ["create", "read", "update", "delete"],
  script: ["generate", "edit"],
  asset: ["search", "upload", "generate_ai", "download_web"],
  timeline: ["edit"],
  render: ["request", "pin"],
  publication: ["create", "schedule", "override_faithfulness", "approve"],
  channel: ["use"],
  comment: ["create"],
});

export const admin = ac.newRole({
  project: ["create", "read", "update", "delete"],
  script: ["generate", "edit"],
  asset: ["search", "upload", "generate_ai", "download_web"],
  timeline: ["edit"],
  render: ["request", "pin"],
  publication: ["create", "schedule", "override_faithfulness", "approve"],
  channel: ["use"],
  brand_kit: ["manage"],
  comment: ["create"],
  ...adminAc.statements,
});

/** Same as admin; the organization plugin needs a creator role name. */
export const owner = admin;

export const orgRoles = { viewer, editor, publisher, admin, owner } as const;
export type OrgRole = keyof typeof orgRoles;
export const ORG_ROLE_NAMES: OrgRole[] = ["viewer", "editor", "publisher", "admin"];

export const PLATFORM_ROLES = ["user", "admin"] as const;
export type PlatformRole = (typeof PLATFORM_ROLES)[number];
