/**
 * Who may connect and manage social channels from /app/channels. Pure (tested).
 *
 * Connecting is self-service: every workspace member who can edit projects links
 * their own accounts and is granted the channel on the spot. A channel is then
 * managed (token check, pause, logo, grants, disconnect) by whoever connected
 * it, by the workspace's admins / owner, and by platform admins. Publishing
 * itself stays with `canApprove` + a grant (publish-actions.ts).
 */
type Actor = { userId: string; role: string; isAdmin: boolean };

const CONNECT_ROLES = ["editor", "publisher", "admin", "owner"];
const WORKSPACE_MANAGER_ROLES = ["admin", "owner"];

export function canConnectChannel(actor: Pick<Actor, "role" | "isAdmin">) {
  return actor.isAdmin || CONNECT_ROLES.includes(actor.role);
}

/** Workspace role alone, for the OAuth callback that only knows the membership. */
export function roleCanConnectChannel(role: string | null | undefined) {
  return Boolean(role) && CONNECT_ROLES.includes(role as string);
}

export function canManageChannel(actor: Actor, channel: { connectedBy: string | null }) {
  return actor.isAdmin || WORKSPACE_MANAGER_ROLES.includes(actor.role) || (channel.connectedBy !== null && channel.connectedBy === actor.userId);
}
