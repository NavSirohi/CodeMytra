import { inngest } from "./client";
import { recoverStaleOutboxEvents } from "@/server/orchestration/outbox";

export const outboxRecoveryFunction = inngest.createFunction(
  {
    id: "outbox-recovery",
    triggers: { cron: "*/5 * * * *" }, // Every 5 minutes
  },
  async ({ step }) => {
    const result = await step.run("recover-stale-events", async () => {
      return recoverStaleOutboxEvents();
    });
    return result;
  }
);
