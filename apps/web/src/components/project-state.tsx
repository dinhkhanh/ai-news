import { CircleAlert, CircleCheck, CircleDashed, CircleX, Clapperboard, Clock, Eye, FileText, Film, Send, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/** Label, icon and colour of a project state, shared by the list, the header and the tab bar. */
export const PROJECT_STATE: Record<string, { label: string; short: string; icon: LucideIcon; tone: string }> = {
  created: { label: "Đang tải bài", short: "đang tải", icon: CircleDashed, tone: "text-muted-foreground bg-muted" },
  fetched: { label: "Chờ xác nhận bài", short: "chờ xác nhận", icon: Clock, tone: "text-sky-600 bg-sky-500/12 dark:text-sky-400" },
  scripted: { label: "Đã có kịch bản", short: "có kịch bản", icon: FileText, tone: "text-primary bg-primary/12" },
  composed: { label: "Đã dựng timeline", short: "đã dựng", icon: Clapperboard, tone: "text-violet-600 bg-violet-500/12 dark:text-violet-400" },
  in_review: { label: "Chờ duyệt", short: "chờ duyệt", icon: Eye, tone: "text-amber-600 bg-amber-500/12 dark:text-amber-400" },
  approved: { label: "Đã duyệt", short: "đã duyệt", icon: CircleCheck, tone: "text-success bg-success/12" },
  rendered: { label: "Đã kết xuất", short: "đã kết xuất", icon: Film, tone: "text-success bg-success/12" },
  published: { label: "Đã đăng", short: "đã đăng", icon: Send, tone: "text-success bg-success/12" },
  failed: { label: "Lỗi", short: "lỗi", icon: CircleX, tone: "text-destructive bg-destructive/10" },
};

const FALLBACK = { label: "", short: "", icon: CircleAlert, tone: "text-muted-foreground bg-muted" };

export const stateLabel = (state: string) => PROJECT_STATE[state]?.label ?? state;
export const stateShort = (state: string) => PROJECT_STATE[state]?.short ?? state;

/** Round coloured state icon, like the status glyphs of the reference inbox. */
export function ProjectStateIcon({ state, className, size = "md" }: { state: string; className?: string; size?: "sm" | "md" }) {
  const s = PROJECT_STATE[state] ?? FALLBACK;
  return (
    <span className={cn("flex shrink-0 items-center justify-center rounded-full", s.tone, size === "md" ? "size-9 [&>svg]:size-5" : "size-6 [&>svg]:size-3.5", className)} title={s.label || state} aria-hidden>
      <s.icon />
    </span>
  );
}
