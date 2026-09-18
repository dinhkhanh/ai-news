import * as React from "react";
import { ChevronDownIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * A native `<select>` in the app's field style. Native on purpose: it works inside
 * server-rendered `<ActionForm>`s and opens the platform picker on phones.
 * Heights match `<Input>` (36 px, 44 px on touch screens). `className` sizes the
 * wrapper (`w-full`, `max-w-48`, `flex-1`…); the select always fills it.
 */
function NativeSelect({ className, fieldSize = "default", ...props }: React.ComponentProps<"select"> & { fieldSize?: "default" | "sm" }) {
  return (
    <span className={cn("relative inline-flex max-w-full min-w-0 items-center", className)}>
      <select
        data-slot="native-select"
        className={cn(
          "w-full min-w-0 appearance-none rounded-lg border border-input bg-card pr-8 pl-3 text-base text-foreground shadow-xs transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50 md:text-sm dark:bg-input/30",
          fieldSize === "sm" ? "h-8 pl-2.5 md:text-xs pointer-coarse:h-10" : "h-9 pointer-coarse:h-11",
        )}
        {...props}
      />
      <ChevronDownIcon className="pointer-events-none absolute right-2.5 size-4 text-muted-foreground" aria-hidden />
    </span>
  );
}

export { NativeSelect };
