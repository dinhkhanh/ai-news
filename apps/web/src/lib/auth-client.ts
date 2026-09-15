"use client";
import { createAuthClient } from "better-auth/react";
import { adminClient, inferAdditionalFields, organizationClient } from "better-auth/client/plugins";
import type { Auth } from "@/lib/auth";
import { ac, orgRoles } from "@/lib/permissions";

export const authClient = createAuthClient({
  plugins: [
    inferAdditionalFields<Auth>(),
    organizationClient({ ac, roles: orgRoles }),
    adminClient(),
  ],
});

export const { useSession, signIn, signOut } = authClient;
