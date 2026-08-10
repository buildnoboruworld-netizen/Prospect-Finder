import { cn } from "@/lib/utils";

// The Noboru World mark, redrawn as a 2-polygon SVG (the original traced
// asset lives at public/noboru-world-logo.svg — 246KB with a baked white
// background, kept as the canonical brand file). The dark triangle uses
// currentColor so the mark adapts: near-black on light surfaces, white on
// the black header.
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 1080 1080"
      className={cn("size-6", className)}
      aria-hidden="true"
    >
      <polygon fill="#8CD056" points="170,45 872,45 872,828" />
      <polygon fill="currentColor" points="212,272 912,1040 212,1040" />
    </svg>
  );
}
