"use client";
import { useActionState, useEffect } from "react";
import { toast } from "sonner";
import type { ActionState } from "@/lib/admin";

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
  }, [state]);
  return (
    <form
      action={formAction}
      className={className}
      data-pending={pending || undefined}
      onSubmit={(e) => {
        if (resetOnSuccess) {
          const form = e.currentTarget;
          queueMicrotask(() => setTimeout(() => form.reset(), 0));
        }
      }}
    >
      <fieldset disabled={pending} className="contents">
        {children}
      </fieldset>
    </form>
  );
}
