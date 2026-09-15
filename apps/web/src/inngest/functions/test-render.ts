import { NonRetriableError } from "inngest";
import { inngest } from "../client";
import { testRenderRequested } from "../events";
import { db, schema } from "@/db";
import { logActivity, recordUsageCost } from "@/lib/activity";
import { invokeMediaLambda } from "@/lib/media-lambda";
import { r2Key } from "@/lib/r2";
import { getRenderStatus, startRender } from "@/lib/remotion";
import { eq } from "drizzle-orm";

/**
 * Phase 1 acceptance test: render the TestCard composition on Remotion Lambda
 * with output written straight to R2, then run the media Lambda QA probe on
 * the result and record cost. Trigger it from /admin/health.
 */
export const testRender = inngest.createFunction(
  { id: "test-render", triggers: [testRenderRequested], retries: 2, concurrency: { limit: 2 } },
  async ({ event, step, logger }) => {
    const { requestedBy, organizationId } = event.data;
    const title = event.data.title ?? "ai-news test render";
    const durationSec = event.data.durationSec ?? 6;

    const renderRow = await step.run("create-render-row", async () => {
      const [row] = await db
        .insert(schema.renders)
        .values({ organizationId, status: "queued", requestedBy })
        .returning({ id: schema.renders.id });
      return row;
    });

    const outKey = r2Key.test(`${renderRow.id}.mp4`);

    const started = await step.run("start-remotion-render", async () => {
      const res = await startRender({
        composition: "TestCard",
        inputProps: { title, durationSec, fps: 30 },
        outKey,
        durationInFrames: durationSec * 30,
      });
      await db
        .update(schema.renders)
        .set({ status: "rendering", remotionRenderId: res.renderId, remotionBucket: res.bucketName })
        .where(eq(schema.renders.id, renderRow.id));
      return res;
    });

    // Poll until done. Remotion Lambda test renders finish in well under a minute.
    let attempt = 0;
    let costUsd = 0;
    for (;;) {
      attempt += 1;
      const status = await step.run(`poll-${attempt}`, () => getRenderStatus(started));
      if (status.fatalErrorEncountered) {
        await step.run("mark-failed", () =>
          db
            .update(schema.renders)
            .set({ status: "failed", error: status.errors.map((e) => e.message).join("\n").slice(0, 4000) })
            .where(eq(schema.renders.id, renderRow.id)),
        );
        throw new NonRetriableError(`Remotion render failed: ${status.errors[0]?.message ?? "unknown"}`);
      }
      if (status.done) {
        costUsd = status.costs.accruedSoFar;
        break;
      }
      if (attempt > 40) throw new NonRetriableError("Render did not finish within the polling budget");
      await step.sleep(`wait-${attempt}`, "5s");
    }

    const qa = await step.run("qa-probe", () =>
      invokeMediaLambda({ action: "probe", input: { key: outKey }, expect: { width: 1080, height: 1920, fps: 30 } }),
    );

    await step.run("finalise", async () => {
      const passed = qa.ok && qa.passed;
      await db
        .update(schema.renders)
        .set({
          status: passed ? "done" : "qa_failed",
          outputPath: outKey,
          durationSec: qa.probe?.durationSec?.toFixed(2),
          costUsd: costUsd.toFixed(4),
          qaJson: qa as unknown as Record<string, unknown>,
          error: passed ? null : qa.error ?? "QA probe failed",
        })
        .where(eq(schema.renders.id, renderRow.id));
      await recordUsageCost({
        provider: "remotion_lambda",
        resource: "TestCard",
        units: durationSec,
        unitType: "render_seconds",
        costUsd,
        userId: requestedBy,
        organizationId,
        renderId: renderRow.id,
      });
      await logActivity({
        actorId: requestedBy,
        organizationId,
        type: "render.test_completed",
        payload: { renderId: renderRow.id, passed, outKey },
      });
      logger.info("test render finished", { renderId: renderRow.id, passed });
    });

    return { renderId: renderRow.id, outKey, qa };
  },
);
