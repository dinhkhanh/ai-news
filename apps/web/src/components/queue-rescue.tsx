"use client";
import { Zap } from "lucide-react";
import { fetchDirect, scriptDirect } from "@/app/app/projects/[id]/actions";
import { ActionForm } from "@/components/action-form";
import { Button } from "@/components/ui/button";
import { DIRECT_STEPS, STEP_LABEL } from "@/lib/project-state";
import { cn } from "@/lib/utils";

const FETCH_METHODS = [
  ["browser_rendering", "Browser"],
  ["http", "HTTP"],
  ["firecrawl", "Firecrawl"],
] as const;

/** "Run it here, without the queue": one provider per button, because a direct run does not walk the chain. */
export function DirectFetchButtons({ projectId, disabled }: { projectId: string; disabled?: boolean }) {
  return (
    <>
      {FETCH_METHODS.map(([method, label]) => (
        <ActionForm key={method} action={fetchDirect}>
          <input type="hidden" name="projectId" value={projectId} />
          <input type="hidden" name="method" value={method} />
          <Button type="submit" size="sm" variant="outline" disabled={disabled} title="Chạy ngay trong ứng dụng, không qua hàng đợi; chỉ thử đúng cách này.">
            <Zap className="size-3.5" />
            Chạy trực tiếp: {label}
          </Button>
        </ActionForm>
      ))}
    </>
  );
}

/**
 * Shown by <PipelineStatus> when the queue (Inngest) has not picked a requested step up after `QUEUE_SLOW_MS`,
 * or the step went stale: says that the wait is not the user's fault and, for the short steps (`DIRECT_STEPS`),
 * offers to run the step inside the app. The longer steps can only wait for the queue.
 */
export function QueueRescue({ projectId, step, stale, canRun = true, className }: { projectId: string; step: string; stale?: boolean; canRun?: boolean; className?: string }) {
  const direct = (DIRECT_STEPS as readonly string[]).includes(step);
  if (stale && !(direct && canRun)) return null; // the stale banner already says "run it again"; nothing to add
  return (
    <div className={cn("space-y-2 rounded-md border border-amber-500/50 bg-amber-500/10 p-2 text-xs text-amber-900 dark:text-amber-200", className)}>
      {stale ? null : (
        <p>
          <b>Hàng đợi xử lý đang chậm.</b> Bước “{STEP_LABEL[step] ?? step}” thường được nhận trong vài giây nhưng vẫn chưa bắt đầu; nhiều khả năng dịch vụ hàng đợi (Inngest) đang gặp sự cố, không phải lỗi của bạn.
        </p>
      )}
      {direct && canRun ? (
        <>
          <p>{step === "fetch" ? "Bạn có thể lấy bài ngay trong ứng dụng, không cần chờ hàng đợi. Mỗi nút chỉ thử đúng một cách:" : "Bạn có thể viết kịch bản ngay trong ứng dụng, không cần chờ hàng đợi:"}</p>
          <div className="flex flex-wrap gap-2">
            {step === "fetch" ? (
              <DirectFetchButtons projectId={projectId} />
            ) : (
              <ActionForm action={scriptDirect}>
                <input type="hidden" name="projectId" value={projectId} />
                <Button type="submit" size="sm" variant="outline">
                  <Zap className="size-3.5" />
                  Chạy trực tiếp: viết kịch bản
                </Button>
              </ActionForm>
            )}
          </div>
        </>
      ) : stale ? null : (
        <p>Bước này quá dài để chạy ngoài hàng đợi. Không cần bấm lại: nó sẽ tự chạy khi hàng đợi hoạt động trở lại.</p>
      )}
    </div>
  );
}
