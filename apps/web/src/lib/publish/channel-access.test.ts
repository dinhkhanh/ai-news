import { describe, expect, it } from "vitest";
import { canConnectChannel, canManageChannel, roleCanConnectChannel } from "./channel-access";

describe("channel access", () => {
  it("lets every writer connect, not viewers", () => {
    for (const role of ["editor", "publisher", "admin", "owner"]) expect(canConnectChannel({ role, isAdmin: false })).toBe(true);
    expect(canConnectChannel({ role: "viewer", isAdmin: false })).toBe(false);
    expect(canConnectChannel({ role: "viewer", isAdmin: true })).toBe(true);
    expect(roleCanConnectChannel("editor")).toBe(true);
    expect(roleCanConnectChannel("viewer")).toBe(false);
    expect(roleCanConnectChannel(null)).toBe(false);
  });

  it("lets the connector, workspace admins and platform admins manage a channel", () => {
    const channel = { connectedBy: "u1" };
    expect(canManageChannel({ userId: "u1", role: "editor", isAdmin: false }, channel)).toBe(true);
    expect(canManageChannel({ userId: "u2", role: "publisher", isAdmin: false }, channel)).toBe(false);
    expect(canManageChannel({ userId: "u2", role: "owner", isAdmin: false }, channel)).toBe(true);
    expect(canManageChannel({ userId: "u2", role: "admin", isAdmin: false }, channel)).toBe(true);
    expect(canManageChannel({ userId: "u2", role: "viewer", isAdmin: true }, channel)).toBe(true);
    // A channel whose connector was deleted belongs to nobody in particular.
    expect(canManageChannel({ userId: "u2", role: "editor", isAdmin: false }, { connectedBy: null })).toBe(false);
  });
});
