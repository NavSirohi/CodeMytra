import { Fragment } from "@/generated/prisma/client";

export type ProjectFragment = Fragment & {
  files: Record<string, string>;
  selectionType?: "current-revision" | "historical-revision" | "assistant-fragment";
  revisionId?: string | null;
};

export function parseFragmentFiles(files: Fragment["files"]): Record<string, string> {
    if (!files || typeof files !== "object" || Array.isArray(files)) {
      return {};
    }
  
    return files as Record<string, string>;
  }
  