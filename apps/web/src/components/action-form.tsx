"use client";
import { useActionState, useEffect } from "react";
import { toast } from "sonner";
import type { ActionState } from "@/lib/admin";
import { ACTION_EVENT } from "@/components/pipeline-status";
import { cn } from "@/lib/utils";

type Props = {
  action: (prev: ActionState, fd: FormData) => Promise<ActionState>;
  children: React.ReactNode;
  className?: string;
  /** Reset the form after a successful submit. */
  resetOnSuccess?: boolean;
};

export function ActionForm({ action, children, className, resetOnSuccess }: Props) {
  const [state, formAction, pending] = useActionState(action, { ok: false });
  useEffect(() => {
    if (state.message) (state.ok ? toast.success : toast.error)(state.message);
    // Let the status pollers on the page pick up the new busy step right away.
    if (state.ok) window.dispatchEvent(new CustomEvent(ACTION_EVENT, { detail: state }));
  }, [state]);
  return (
    <form
      action={formAction}
      className={cn(className, pending && "cursor-progress opacity-70")}
      aria-busy={pending || undefined}
      data-pending={pending || undefined}
      onSubmit={(e) => {
        if (resetOnSuccess) {
          const form = e.currentTarget;
          queueMicrotask(() => setTimeout(() => form.reset(), 0));
        }
      }}
    >
      <fieldset disabled={pending} className="contents space-y-4">
        {children}
      </fieldset>
    </form>
  );
}
