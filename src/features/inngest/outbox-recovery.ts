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
    // 1. Recover stale outbox events with error isolation
    const outboxResult = await step.run("recover-stale-events", async () => {
      try {
        return await recoverStaleOutboxEvents();
      } catch (error) {
        console.error(
          "[Outbox] Scheduled outbox event recovery encountered an error:",
          error instanceof Error ? error.message : String(error)
        );
        return {
          total: 0,
          recovered: 0,
          failed: 1,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    });

    // 2. Stale run watchdog: runs reliably even if outbox recovery encountered an error
    const watchdogResult = await step.run("reconcile-stale-runs", async () => {
      try {
        return await reconcileStaleGenerationRuns();
      } catch (error) {
        console.error(
          "[Outbox] Scheduled stale generation run watchdog encountered an error:",
          error instanceof Error ? error.message : String(error)
        );
        return {
          checked: 0,
          reconciled: 0,
          failed: 1,
          runIds: [],
          error: error instanceof Error ? error.message : String(error),
        };
      }
    });

    return { outbox: outboxResult, staleRuns: watchdogResult };
  }
);

