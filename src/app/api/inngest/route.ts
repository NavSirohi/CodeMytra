import { inngest } from "@/features/inngest/client";
import { codeAgentFunction } from "@/features/inngest/functions";
import { outboxRecoveryFunction } from "@/features/inngest/outbox-recovery";
import { serve } from "inngest/next";

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [codeAgentFunction, outboxRecoveryFunction],
});