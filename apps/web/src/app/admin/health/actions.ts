"use server";
import { revalidatePath } from "next/cache";
import { inngest } from "@/inngest/client";
import { testRenderRequested } from "@/inngest/events";
import { assertAdmin, run, type ActionState } from "@/lib/admin";

export async function triggerTestRender(_: ActionState, fd: FormData): Promise<ActionState> {
  return run(async () => {
    const { session, log } = await assertAdmin();
    const organizationId = (session.session as { activeOrganizationId?: string | null }).activeOrganizationId;
    if (!organizationId) throw new Error("No active workspace on this session");
    const durationSec = Math.min(60, Math.max(3, Number(fd.get("durationSec") ?? 6) || 6));
    const { ids } = await inngest.send(
      testRenderRequested.create({ requestedBy: session.user.id, organizationId, title: "ai-news phase 1 test render", durationSec }),
    );
    await log("render.test_requested", { eventId: ids[0], durationSec }, { organizationId });
    revalidatePath("/admin/health");
    return `Test render queued (event ${ids[0]})`;
  });
}
