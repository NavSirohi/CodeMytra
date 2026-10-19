import { cn } from "@/lib/utils";

/**
 * Props for {@link CodeMytraLogo}.
 *
 * @property className - Extra classes applied to the wrapper.
 * @property showWordmark - Whether to render the "CodeMytra" text next to the mark.
 */
export type CodeMytraLogoProps = {
  className?: string;
  showWordmark?: boolean;
};

/**
 * The standalone CodeMytra glyph (SVG mark) without the wordmark.
 *
 * Inherits color via `currentColor` so it adapts to the surrounding text color.
 *
 * @param className - Extra classes applied to the `<svg>` element.
 */
export function CodeMytraMark({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "w-7 h-7 inline-grid place-items-center bg-[#284938] text-white rounded-[9px] font-serif font-semibold text-base leading-none select-none shrink-0 -rotate-6 shadow-xs",
        className
      )}
      aria-hidden="true"
    >
      म
    </span>
  );
}

/**
 * The CodeMytra brand logo: the glyph mark plus an optional "CodeMytra" wordmark.
 *
 * @param props - See {@link CodeMytraLogoProps}.
 */
export function CodeMytraLogo({
  className,
  showWordmark = true,
}: CodeMytraLogoProps) {
  return (
    <span className={cn("inline-flex items-center gap-2 text-foreground font-sans", className)}>
      <CodeMytraMark className="h-7 w-7" />
      {showWordmark ? (
        <span className="text-base font-bold tracking-tight">
          Code<em className="text-[#c75c35] not-italic">Mytra</em>
        </span>
      ) : null}
    </span>
  );
}

// Backward-compatible aliases for legacy imports during transition
export const Chai0Mark = CodeMytraMark;
export const Chai0Logo = CodeMytraLogo;
