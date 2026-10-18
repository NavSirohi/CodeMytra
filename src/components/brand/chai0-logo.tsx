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
    <svg
      viewBox="0 0 44 48"
      fill="none"
      aria-hidden
      aria-label="CodeMytra"
      className={cn("shrink-0", className)}
    >
      <rect
        x="8.5"
        y="4"
        width="27"
        height="40"
        rx="13.5"
        stroke="currentColor"
        strokeWidth="5"
        fill="none"
      />
      <path
        fill="currentColor"
        d="M10.8 38.2C10.8 32.5 13.8 26.5 19.5 24.8C16.2 29.2 13.2 34.2 10.8 38.2Z"
      />
    </svg>
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
    <span className={cn("inline-flex items-center gap-2.5 text-foreground", className)}>
      <CodeMytraMark className="h-7 w-auto" />
      {showWordmark ? (
        <span className="text-base font-semibold tracking-tight">CodeMytra</span>
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
