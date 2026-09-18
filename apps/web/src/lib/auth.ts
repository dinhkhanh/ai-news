import "server-only";
import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { admin as adminPlugin, organization } from "better-auth/plugins";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db, schema } from "@/db";
import { logActivity } from "@/lib/activity";
import { env, listFromCsv } from "@/lib/env";
import { ac, orgRoles } from "@/lib/permissions";

const e = env();

function domainOf(email: string) {
  return email.split("@")[1]?.toLowerCase() ?? "";
}

async function isDomainAllowed(domain: string) {
  if (!domain) return false;
  const row = await db.query.allowedDomains.findFirst({
    where: eq(schema.allowedDomains.domain, domain),
  });
  if (row) return true;
  // Bootstrap fallback before the table is seeded.
  return listFromCsv(e.ALLOWED_DOMAINS).includes(domain);
}

async function personalOrgFor(userId: string) {
  return db.query.organization.findFirst({
    where: (o, { and, eq }) => and(eq(o.ownerUserId, userId), eq(o.kind, "personal")),
  });
}

async function ensurePersonalOrg(u: { id: string; name: string; email: string }) {
  const existing = await personalOrgFor(u.id);
  if (existing) return existing;
  const slugBase = u.email.split("@")[0].toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "user";
  const orgId = nanoid();
  const [org] = await db
    .insert(schema.organization)
    .values({
      id: orgId,
      name: `${u.name || u.email} (personal)`,
      slug: `${slugBase}-${nanoid(6).toLowerCase()}`,
      kind: "personal",
      ownerUserId: u.id,
      metadata: JSON.stringify({ kind: "personal" }),
    })
    .returning();
  await db.insert(schema.member).values({
    id: nanoid(),
    organizationId: orgId,
    userId: u.id,
    role: "owner",
  });
  await logActivity({
    actorId: u.id,
    organizationId: orgId,
    type: "workspace.created",
    payload: { kind: "personal" },
  });
  return org;
}

/** Organization plugin endpoints that stay reachable: switching / listing one's own workspaces, and create (platform admins only, see allowUserToCreateOrganization). */
const ORG_ENDPOINTS_OPEN = ["/organization/set-active", "/organization/list", "/organization/create"];

export const auth = betterAuth({
  appName: "ai-news",
  baseURL: e.APP_URL,
  secret: e.BETTER_AUTH_SECRET,
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: {
      user: schema.user,
      session: schema.session,
      account: schema.account,
      verification: schema.verification,
      organization: schema.organization,
      member: schema.member,
      invitation: schema.invitation,
    },
  }),
  emailAndPassword: { enabled: false },
  socialProviders: {
    google: {
      clientId: e.GOOGLE_CLIENT_ID,
      clientSecret: e.GOOGLE_CLIENT_SECRET,
      // Require a Google Workspace account (any hosted domain); the exact
      // domain allowlist is enforced against the DB below.
      hd: "*",
      prompt: "select_account",
    },
  },
  session: {
    expiresIn: 60 * 60 * 24 * 14,
    updateAge: 60 * 60 * 24,
    cookieCache: { enabled: true, maxAge: 5 * 60 },
  },
  user: {
    additionalFields: {
      domain: { type: "string", required: false, input: false },
      lastLogin: { type: "date", required: false, input: false },
    },
  },
  databaseHooks: {
    user: {
      create: {
        before: async (u) => {
          const domain = domainOf(u.email);
          if (!(await isDomainAllowed(domain))) {
            throw new APIError("FORBIDDEN", {
              message: `Sign-in is limited to approved Google Workspace domains (${domain} is not allowed).`,
            });
          }
          const bootstrapAdmin = listFromCsv(e.ADMIN_EMAILS).includes(u.email.toLowerCase());
          return {
            data: {
              ...u,
              domain,
              role: bootstrapAdmin ? "admin" : "user",
            },
          };
        },
        after: async (u) => {
          await ensurePersonalOrg(u);
          await logActivity({ actorId: u.id, type: "user.created", payload: { email: u.email } });
        },
      },
    },
    session: {
      create: {
        before: async (s) => {
          const u = await db.query.user.findFirst({ where: eq(schema.user.id, s.userId) });
          if (!u) return false;
          if (!(await isDomainAllowed(u.domain || domainOf(u.email)))) {
            throw new APIError("FORBIDDEN", { message: "Your domain is no longer allowed." });
          }
          const org = (await personalOrgFor(u.id)) ?? (await ensurePersonalOrg(u));
          return { data: { ...s, activeOrganizationId: s.activeOrganizationId ?? org?.id } };
        },
        after: async (s) => {
          const impersonatedBy = (s as { impersonatedBy?: string | null }).impersonatedBy ?? null;
          await db.update(schema.user).set({ lastLogin: new Date() }).where(eq(schema.user.id, s.userId));
          await logActivity({
            actorId: s.userId,
            impersonatorId: impersonatedBy,
            type: impersonatedBy ? "auth.impersonated" : "auth.sign_in",
            ip: s.ipAddress ?? undefined,
            userAgent: s.userAgent ?? undefined,
          });
        },
      },
    },
  },
  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      // Google is the only allowed provider.
      if (ctx.path === "/sign-in/social" && ctx.body?.provider !== "google") {
        throw new APIError("BAD_REQUEST", { message: "Only Google sign-in is supported." });
      }
      // Workspaces and their members are managed in /admin/workspaces (logged, platform admins only). The
      // organization plugin's own endpoints would let every owner of a personal workspace invite members,
      // change roles or edit the workspace outside of that, so only the harmless ones stay open.
      if (ctx.path.startsWith("/organization/") && !ORG_ENDPOINTS_OPEN.includes(ctx.path)) {
        throw new APIError("FORBIDDEN", { message: "Workspaces are managed by a platform admin." });
      }
    }),
  },
  plugins: [
    organization({
      ac,
      roles: orgRoles,
      creatorRole: "owner",
      allowUserToCreateOrganization: async (u) => (u as { role?: string }).role === "admin",
      schema: {
        organization: {
          additionalFields: {
            kind: { type: "string", required: false, input: false, defaultValue: "personal" },
            ownerUserId: { type: "string", required: false, input: false },
          },
        },
      },
      organizationHooks: {
        // `kind` is not client input: personal workspaces are inserted by ensurePersonalOrg, so whatever a
        // platform admin creates through the API is a team workspace.
        beforeCreateOrganization: async ({ organization: org }) => ({ data: { ...org, kind: "team" } }),
        afterCreateOrganization: async ({ organization: org, user: u }) => {
          await logActivity({
            actorId: u.id,
            organizationId: org.id,
            type: "workspace.created",
            payload: { kind: (org as { kind?: string }).kind ?? "team", name: org.name },
          });
        },
      },
    }),
    adminPlugin({
      defaultRole: "user",
      adminRoles: ["admin"],
      impersonationSessionDuration: 60 * 60,
    }),
    nextCookies(),
  ],
});

export type Auth = typeof auth;
export type Session = Auth["$Infer"]["Session"];
