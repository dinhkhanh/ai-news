import Link from "next/link"
import { cn } from "@/lib/utils"

export type SegmentedOption = { href: string; label: React.ReactNode; active: boolean }

/**
 * The reference's segmented control, as links: a grey 10 px track, the current
 * option a white pill with a hairline and a soft shadow, the others grey text.
 */
function SegmentedLinks({ options, label, className }: { options: SegmentedOption[]; label: string; className?: string }) {
  return (
    <nav aria-label={label} className={cn("inline-flex h-8 shrink-0 items-stretch rounded-xl bg-sidebar pointer-coarse:h-10", className)}>
      {options.map((o) => (
        <Link
          key={o.href}
          href={o.href}
          aria-current={o.active ? "page" : undefined}
          className={cn(
            "inline-flex items-center rounded-[9px] px-3 text-[0.9375rem] whitespace-nowrap text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/40",
            o.active && "bg-card font-medium text-foreground shadow-xs ring-1 ring-sidebar-border",
          )}
        >
          {o.label}
        </Link>
      ))}
    </nav>
  )
}

export { SegmentedLinks }
