import { inngest } from "./client";
import {
  recoverStaleOutboxEvents,
  reconcileStaleGenerationRuns,
} from "@/server/orchestration/outbox";

export const outboxRecoveryFunction = inngest.createFunction(
  {
    id: "outbox-recovery",
    triggers: { cron: "*/5 * * * *" }, // Every 5 minutes
  },
  async ({ step }) => {
    const outboxResult = await step.run("recover-stale-events", async () => {
      return recoverStaleOutboxEvents();
    });

    const watchdogResult = await step.run("reconcile-stale-runs", async () => {
      return reconcileStaleGenerationRuns();
    });

    return { outbox: outboxResult, staleRuns: watchdogResult };
  }
);

