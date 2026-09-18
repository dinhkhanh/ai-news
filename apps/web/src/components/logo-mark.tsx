import { cn } from "@/lib/utils";

/** The pinwheel at the top of the rail: eight tapered blades, drawn in the text colour like the reference's mark. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={cn("size-6 text-foreground", className)} fill="currentColor" aria-hidden>
      {[0, 45, 90, 135, 180, 225, 270, 315].map((deg) => (
        <path key={deg} d="M11.1 9.4 10 1.6h4l-1.1 7.8z" transform={`rotate(${deg + 12} 12 12)`} />
      ))}
    </svg>
  );
}
