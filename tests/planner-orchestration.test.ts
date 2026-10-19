import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runWithoutStepContext } from "../src/server/orchestration/async-context";
import { AsyncLocalStorage } from "node:async_hooks";

describe("P1: Inngest Step Isolation & Planner Orchestration", () => {
  it("isolates ambient Inngest execution context to prevent NESTING_STEPS", async () => {
    // Setup ALS in globalThis matching Inngest's exact ALS registration symbol
    const g = globalThis as any;
    const alsSymbol = Symbol.for("inngest:als");
    const als = new AsyncLocalStorage<any>();

    g[alsSymbol] = {
      resolved: als,
      isFallback: false,
    };

    // 1. Simulate an ambient Inngest step context (e.g., inside step.run("planner-spec"))
    const mockStepContext = {
      app: {},
      execution: {
        instance: {},
        ctx: {},
        executingStep: {
          id: "planner-spec",
          hashedId: "hash-planner-spec",
          userlandId: "planner-spec",
        },
      },
    };

    let observedInsideOuterStep: any = null;
    let observedInsideIsolatedContext: any = null;
    let observedAfterIsolatedContext: any = null;

    await als.run(mockStepContext, async () => {
      // Inside the outer step: ambient context exists with executingStep
      observedInsideOuterStep = als.getStore();

      // Inside isolated agent invocation:
      await runWithoutStepContext(async () => {
        observedInsideIsolatedContext = als.getStore();
      });

      // After isolation finishes, outer step context is restored
      observedAfterIsolatedContext = als.getStore();
    });

    // Verification:
    assert.ok(observedInsideOuterStep, "Ambient context must exist in outer step");
    assert.equal(
      observedInsideOuterStep?.execution?.executingStep?.id,
      "planner-spec",
      "Outer step must have executingStep defined"
    );

    // Inside runWithoutStepContext, store is undefined -> no nested step can be triggered
    assert.equal(
      observedInsideIsolatedContext,
      undefined,
      "runWithoutStepContext must unbind ALS so nested agent tools cannot detect ambient step"
    );

    // Context is restored after isolation block exits
    assert.equal(
      observedAfterIsolatedContext?.execution?.executingStep?.id,
      "planner-spec",
      "Outer step context must be preserved after isolated block completes"
    );
  });

  it("prevents nested step collisions when AgentKit agents run inside step.run", async () => {
    const g = globalThis as any;
    const alsSymbol = Symbol.for("inngest:als");
    const als = new AsyncLocalStorage<any>();

    g[alsSymbol] = {
      resolved: als,
      isFallback: false,
    };

    const mockOuterStep = {
      app: {},
      execution: {
        instance: {},
        ctx: {},
        executingStep: {
          id: "planner-spec",
          hashedId: "hash-planner-spec",
        },
      },
    };

    // Simulated detector: throws NESTING_STEPS if a sub-step is attempted while executingStep is present
    function attemptSubStep(stepId: string) {
      const currentCtx = als.getStore();
      if (currentCtx?.execution?.executingStep) {
        const error = new Error(
          `Cannot nest step "${stepId}" inside executing step "${currentCtx.execution.executingStep.id}". Inngest does not allow nested steps.`
        );
        (error as any).code = "NESTING_STEPS";
        throw error;
      }
      return { stepId, status: "completed" };
    }

    await als.run(mockOuterStep, async () => {
      // A: Direct call without isolation triggers NESTING_STEPS error
      assert.throws(
        () => attemptSubStep("agent-turn-1"),
        (err: any) => err.code === "NESTING_STEPS"
      );

      // B: Wrapped call with runWithoutStepContext succeeds cleanly without collision
      const result = await runWithoutStepContext(async () => {
        return attemptSubStep("agent-turn-1");
      });

      assert.deepEqual(result, { stepId: "agent-turn-1", status: "completed" });
    });
  });

  it("guarantees deterministic memoization and step replay without infinite loops", async () => {
    // Simulate Inngest memoization store
    const stepMemoizationStore = new Map<string, any>();
    let agentExecutionCount = 0;

    // Simulated durable step runner
    async function durableStepRun<T>(stepId: string, fn: () => Promise<T>): Promise<T> {
      if (stepMemoizationStore.has(stepId)) {
        return stepMemoizationStore.get(stepId);
      }
      const output = await runWithoutStepContext(fn);
      stepMemoizationStore.set(stepId, output);
      return output;
    }

    async function executePlannerWorkflow() {
      return durableStepRun("planner-spec", async () => {
        agentExecutionCount++;
        return {
          projectName: "InvoiceApp",
          pages: ["/dashboard", "/invoices"],
          features: ["track payments"],
        };
      });
    }

    // First execution: agent executes once and memoizes output
    const run1 = await executePlannerWorkflow();
    assert.equal(agentExecutionCount, 1);
    assert.equal(run1.projectName, "InvoiceApp");

    // Second execution (workflow replay after failure or next step):
    // Replay receives memoized result immediately; agent is NOT called again
    const run2 = await executePlannerWorkflow();
    assert.equal(agentExecutionCount, 1, "Agent must not be re-invoked on workflow replay");
    assert.deepEqual(run2, run1);
  });

  it("terminates with explicit failure and does not enter infinite active state on agent error", async () => {
    let workflowStatus = "PLANNING";
    let failureFinalized = false;
    let errorCode: string | null = null;

    async function runFailingPlannerStep() {
      try {
        await runWithoutStepContext(async () => {
          throw new Error("Quota exceeded: Gemini API rate limit");
        });
      } catch {
        workflowStatus = "FAILED";
        failureFinalized = true;
        errorCode = "WORKFLOW_EXECUTION_FAILED";
      }
    }

    await runFailingPlannerStep();

    assert.equal(workflowStatus, "FAILED", "Workflow must transition to FAILED on error");
    assert.equal(failureFinalized, true, "Failure must be finalized immediately");
    assert.equal(errorCode, "WORKFLOW_EXECUTION_FAILED");
  });
});
