import { Fragment } from "@/generated/prisma/client";

export type ProjectFragment = Fragment & {
  files: Record<string, string>;
  selectionType?: "current-revision" | "historical-revision" | "assistant-fragment" | "draft-artifact";
  revisionId?: string | null;
  draftId?: string | null;
  isDraft?: boolean;
  validationStatus?: string;
};

export function parseFragmentFiles(files: Fragment["files"]): Record<string, string> {
    if (!files || typeof files !== "object" || Array.isArray(files)) {
      return {};
    }
  
    return files as Record<string, string>;
  }
  