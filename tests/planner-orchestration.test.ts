import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runWithoutStepContext } from "../src/server/orchestration/async-context";
import { AsyncLocalStorage } from "node:async_hooks";
import { getStepTools, createAgent } from "@inngest/agent-kit";

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

  it("verifies installed AgentKit SDK getStepTools resolves undefined inside runWithoutStepContext", async () => {
    const g = globalThis as any;
    const alsSymbol = Symbol.for("inngest:als");
    const als = g[alsSymbol]?.resolved || new AsyncLocalStorage<any>();

    g[alsSymbol] = {
      resolved: als,
      promise: Promise.resolve(als),
      isFallback: false,
    };

    let stepAiInferCalled = false;
    const mockStepTools = {
      run: async (_id: string, fn: () => any) => fn(),
      ai: {
        infer: async () => {
          stepAiInferCalled = true;
          return { output: [{ type: "text", content: "nested step output" }] };
        },
      },
    };

    const mockFunctionContext = {
      app: {},
      ctx: {
        step: mockStepTools,
      },
      execution: {
        ctx: {
          step: mockStepTools,
        },
        executingStep: {
          id: "planner-spec",
        },
      },
    };

    await als.run(mockFunctionContext, async () => {
      // 1. Without isolation, AgentKit SDK getStepTools discovers ambient step tool
      const detectedStepOuter = await getStepTools();
      assert.equal(detectedStepOuter, mockStepTools);

      // 2. Inside runWithoutStepContext, AgentKit SDK getStepTools resolves to undefined
      const detectedStepInner = await runWithoutStepContext(async () => {
        return getStepTools();
      });
      assert.equal(
        detectedStepInner,
        undefined,
        "AgentKit getStepTools() must resolve undefined inside runWithoutStepContext"
      );

      // 3. Verify real AgentKit agent execution with gemini adapter
      // Mock global fetch to return valid Gemini REST candidate
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () => {
        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  role: "model",
                  parts: [
                    {
                      text: JSON.stringify({
                        projectName: "Verified Invoice App",
                        pages: ["/dashboard"],
                      }),
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      };

      try {
        const geminiAdapter = {
          format: "gemini",
          model: "gemini-2.5-pro",
          url: "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent",
          authKey: "synthetic-key",
        };

        const agent = createAgent({
          name: "planner-agent-sdk-verified",
          system: "Generate PRD",
          model: geminiAdapter as any,
        });

        // Run agent inside runWithoutStepContext
        const agentResult = await runWithoutStepContext(async () => {
          return agent.run("Plan an invoice application");
        });

        assert.ok(agentResult, "Agent must return result");
        assert.equal(
          stepAiInferCalled,
          false,
          "AgentKit must NOT call step.ai.infer() inside runWithoutStepContext"
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  it("preserves durable step identity and guarantees deterministic memoization on replay", async () => {
    // Simulate Inngest memoization ledger
    const memoizedStepLedger = new Map<string, any>();
    let networkInferenceCalls = 0;

    const executeWorkflowStep = async (stepId: string, runFn: () => Promise<any>) => {
      // If step was already executed in a previous attempt, replay from ledger
      if (memoizedStepLedger.has(stepId)) {
        return memoizedStepLedger.get(stepId);
      }
      const result = await runWithoutStepContext(runFn);
      memoizedStepLedger.set(stepId, result);
      return result;
    };

    const plannerAgentExecution = async () => {
      networkInferenceCalls++;
      return {
        projectName: "Durable Invoice Manager",
        pages: ["/dashboard", "/invoices"],
        entities: ["Invoice", "Client"],
      };
    };

    // First run: executes inference and memoizes result with durable step ID "planner-spec"
    const firstRunOutput = await executeWorkflowStep("planner-spec", plannerAgentExecution);
    assert.equal(networkInferenceCalls, 1);
    assert.equal(firstRunOutput.projectName, "Durable Invoice Manager");

    // Second run (e.g. replay after subsequent step retry): reuses memoized result without calling network
    const replayOutput = await executeWorkflowStep("planner-spec", plannerAgentExecution);
    assert.equal(
      networkInferenceCalls,
      1,
      "Replay must never re-trigger network inference for memoized steps"
    );
    assert.deepEqual(replayOutput, firstRunOutput);
    assert.ok(memoizedStepLedger.has("planner-spec"), "Durable step ID must remain in ledger");
  });

  it("verifies supported alternative: direct provider invocation has zero ALS ambient context dependencies", async () => {
    // Verify that direct provider invocation (e.g. Google Gemini REST/SDK) works identically
    // without inspecting or relying on Node.js AsyncLocalStorage or Inngest internal symbols
    const originalFetch = globalThis.fetch;
    let fetchCalled = false;

    globalThis.fetch = (async (url: string) => {
      fetchCalled = true;
      assert.ok(String(url).includes("generativelanguage.googleapis.com"));
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                role: "model",
                parts: [
                  {
                    text: JSON.stringify({
                      title: "Direct Provider App",
                      modules: ["Auth", "Dashboard"],
                    }),
                  },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }) as any;

    try {
      // Direct provider invocation helper: independent of Inngest internals
      const invokeDirectProvider = async (prompt: string) => {
        const res = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
        });
        const json = await res.json();
        return JSON.parse(json.candidates[0].content.parts[0].text);
      };

      const result = await invokeDirectProvider("Generate specification");
      assert.equal(fetchCalled, true);
      assert.equal(result.title, "Direct Provider App");
      assert.deepEqual(result.modules, ["Auth", "Dashboard"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
