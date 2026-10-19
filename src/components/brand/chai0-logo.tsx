import { cn } from "@/lib/utils";

/**
 * Props for {@link CodeMytraLogo}.
 *
 * @property className - Extra classes applied to the wrapper.
 * @property showWordmark - Whether to render the "CodeMytra" text next to the mark.
 */
type CodeMytraLogoProps = {
  className?: string;
  showWordmark?: boolean;
};

/**
 * The standalone CodeMytra glyph (SVG mark) without the wordmark.
 *
 * Inherits color via `currentColor` so it adapts to the surrounding text color.
 * Originally from the teacher's Chai0 project; retained and rebranded for CodeMytra.
 *
 * @param className - Extra classes applied to the `<svg>` element.
 */
function CodeMytraMark({ className }: { className?: string }) {
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

// Backward-compatible exports so existing imports keep working during the rename transition.
// Remove these aliases once all references are updated.
export { CodeMytraMark };
/** @deprecated Use `CodeMytraMark` instead */
export const Chai0Mark = CodeMytraMark;
/** @deprecated Use `CodeMytraLogo` instead */
export const Chai0Logo = CodeMytraLogo;
