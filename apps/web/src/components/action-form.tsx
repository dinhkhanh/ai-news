"use client";
import { startTransition, useActionState, useEffect } from "react";
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
    // The action is dispatched from onSubmit instead of the `action` prop on purpose. With a function
    // `action`, React stamps `action="javascript:throw new Error('A React form was unexpectedly
    // submitted…')"` on every client-rendered form; if the browser's native submission ever runs
    // (an event React did not intercept, e.g. right after a soft navigation or refresh), the user gets
    // that error. Without the prop the worst case is a plain GET reload of the page.
    <form
      className={cn(className, pending && "cursor-progress opacity-70")}
      aria-busy={pending || undefined}
      data-pending={pending || undefined}
      onSubmit={(e) => {
        e.preventDefault();
        const form = e.currentTarget;
        const submitter = (e.nativeEvent as SubmitEvent).submitter;
        const fd = new FormData(form, submitter instanceof HTMLElement ? submitter : undefined);
        // Outside the `action` prop the dispatch needs its own transition, or `pending` never updates.
        startTransition(() => formAction(fd));
        if (resetOnSuccess) queueMicrotask(() => setTimeout(() => form.reset(), 0));
      }}
    >
      <fieldset disabled={pending} className="contents space-y-4">
        {children}
      </fieldset>
    </form>
  );
}
