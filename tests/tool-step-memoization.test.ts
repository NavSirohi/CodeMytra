import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("Task 2: Inngest Tool Step Memoization & Unique Step Identifiers", () => {
  it("Scenario 1: Multiple sequential terminal commands receive distinct step IDs and execute independently", async () => {
    const executedSteps: string[] = [];
    const stepOutputs: Record<string, string> = {};

    const mockStep = {
      run: async <T>(stepId: string, fn: () => Promise<T>): Promise<T> => {
        executedSteps.push(stepId);
        if (stepOutputs[stepId] !== undefined) {
          // Inngest memoization behavior: return cached result
          return stepOutputs[stepId] as unknown as T;
        }
        const res = await fn();
        stepOutputs[stepId] = res as unknown as string;
        return res;
      },
    };

    let toolCallCounter = 0;
    const stepPrefix = "initial-coding";

    // Simulate 3 sequential terminal commands from the agent
    const runTerminal = async (cmd: string) => {
      const stepId = `${stepPrefix}-terminal-${++toolCallCounter}`;
      return mockStep.run(stepId, async () => {
        return `Output for: ${cmd}`;
      });
    };

    const out1 = await runTerminal("echo first");
    const out2 = await runTerminal("echo second");
    const out3 = await runTerminal("echo third");

    assert.equal(out1, "Output for: echo first");
    assert.equal(out2, "Output for: echo second");
    assert.equal(out3, "Output for: echo third");

    // Verify each command received a distinct, monotonic step ID
    assert.deepEqual(executedSteps, [
      "initial-coding-terminal-1",
      "initial-coding-terminal-2",
      "initial-coding-terminal-3",
    ]);

    // Verify that none of the steps reused a previous step's output
    assert.notEqual(out1, out2);
    assert.notEqual(out2, out3);
  });

  it("Scenario 2: Multiple file-write operations receive distinct step IDs and persist cumulative changes", async () => {
    const executedSteps: string[] = [];
    let toolCallCounter = 0;
    const stepPrefix = "initial-coding";
    const filesystem: Record<string, string> = {};

    const mockStep = {
      run: async <T>(stepId: string, fn: () => Promise<T>): Promise<T> => {
        executedSteps.push(stepId);
        return await fn();
      },
    };

    const runWriteFiles = async (files: Record<string, string>) => {
      const stepId = `${stepPrefix}-createOrUpdateFiles-${++toolCallCounter}`;
      return mockStep.run(stepId, async () => {
        for (const [p, c] of Object.entries(files)) {
          filesystem[p] = c;
        }
        return { ...filesystem };
      });
    };

    await runWriteFiles({ "app/page.tsx": "export default function Page() { return 1; }" });
    await runWriteFiles({ "components/button.tsx": "export function Button() {}" });
    await runWriteFiles({ "app/page.tsx": "export default function Page() { return 2; }" });

    assert.deepEqual(executedSteps, [
      "initial-coding-createOrUpdateFiles-1",
      "initial-coding-createOrUpdateFiles-2",
      "initial-coding-createOrUpdateFiles-3",
    ]);

    assert.equal(filesystem["app/page.tsx"], "export default function Page() { return 2; }");
    assert.equal(filesystem["components/button.tsx"], "export function Button() {}");
  });

  it("Scenario 3: Repeated file reads receive distinct step IDs and observe updated file content", async () => {
    const executedSteps: string[] = [];
    let toolCallCounter = 0;
    const stepPrefix = "initial-coding";
    const filesystem: Record<string, string> = { "app/page.tsx": "v1" };

    const mockStep = {
      run: async <T>(stepId: string, fn: () => Promise<T>): Promise<T> => {
        executedSteps.push(stepId);
        return await fn();
      },
    };

    const runReadFiles = async (paths: string[]) => {
      const stepId = `${stepPrefix}-readFiles-${++toolCallCounter}`;
      return mockStep.run(stepId, async () => {
        return paths.map((p) => ({ path: p, content: filesystem[p] || "" }));
      });
    };

    const read1 = await runReadFiles(["app/page.tsx"]);
    assert.equal(read1[0].content, "v1");

    // File is modified on disk
    filesystem["app/page.tsx"] = "v2-modified";

    const read2 = await runReadFiles(["app/page.tsx"]);
    assert.equal(read2[0].content, "v2-modified");

    assert.deepEqual(executedSteps, [
      "initial-coding-readFiles-1",
      "initial-coding-readFiles-2",
    ]);
  });

  it("Scenario 4: A failed command followed by a corrected command does not pollute the second command", async () => {
    const executedSteps: string[] = [];
    let toolCallCounter = 0;
    const stepPrefix = "initial-coding";

    const mockStep = {
      run: async <T>(stepId: string, fn: () => Promise<T>): Promise<T> => {
        executedSteps.push(stepId);
        return await fn();
      },
    };

    const runTerminal = async (cmd: string) => {
      const stepId = `${stepPrefix}-terminal-${++toolCallCounter}`;
      return mockStep.run(stepId, async () => {
        if (cmd.includes("syntax-error")) {
          return "SyntaxError: Unexpected token";
        }
        return "Build succeeded with 0 errors";
      });
    };

    const failResult = await runTerminal("bun run build --syntax-error");
    assert.ok(failResult.includes("SyntaxError"));

    const successResult = await runTerminal("bun run build");
    assert.ok(successResult.includes("Build succeeded"));

    assert.deepEqual(executedSteps, [
      "initial-coding-terminal-1",
      "initial-coding-terminal-2",
    ]);
  });

  it("Scenario 5: A second coding-agent invocation during QA repair uses isolated prefix and never collides with initial coding steps", async () => {
    const memoizedStepCache: Record<string, string> = {};
    const stepCallHistory: string[] = [];

    const mockStep = {
      run: async <T>(stepId: string, fn: () => Promise<T>): Promise<T> => {
        stepCallHistory.push(stepId);
        if (memoizedStepCache[stepId] !== undefined) {
          return memoizedStepCache[stepId] as unknown as T;
        }
        const val = await fn();
        memoizedStepCache[stepId] = val as unknown as string;
        return val;
      },
    };

    // Phase 1: Initial coding agent
    let initialCounter = 0;
    const initialPrefix = "initial-coding";
    const runInitialTerminal = async (cmd: string) => {
      const stepId = `${initialPrefix}-terminal-${++initialCounter}`;
      return mockStep.run(stepId, async () => `initial-${cmd}`);
    };

    await runInitialTerminal("tsc"); // step: initial-coding-terminal-1

    // Phase 2: QA repair coding agent with its own distinct prefix
    let repairCounter = 0;
    const repairPrefix = "qa-repair-1";
    const runRepairTerminal = async (cmd: string) => {
      const stepId = `${repairPrefix}-terminal-${++repairCounter}`;
      return mockStep.run(stepId, async () => `repair-${cmd}`);
    };

    const repairOut1 = await runRepairTerminal("tsc"); // step: qa-repair-1-terminal-1

    assert.equal(memoizedStepCache["initial-coding-terminal-1"], "initial-tsc");
    assert.equal(memoizedStepCache["qa-repair-1-terminal-1"], "repair-tsc");
    assert.equal(repairOut1, "repair-tsc");

    // Both step IDs are completely distinct; repair did NOT receive the initial memoized result
    assert.deepEqual(stepCallHistory, [
      "initial-coding-terminal-1",
      "qa-repair-1-terminal-1",
    ]);
  });

  it("Scenario 6: Interrupted execution and replay matches previously recorded steps and resumes cleanly", async () => {
    // Simulate Inngest replay: step 1 was recorded in previous run. Replay executes steps 1 and 2.
    const recordedInngestSteps: Record<string, string> = {
      "initial-coding-terminal-1": "Cached output from turn 1 before interruption",
    };
    const newExecutions: string[] = [];

    const mockStep = {
      run: async <T>(stepId: string, fn: () => Promise<T>): Promise<T> => {
        if (recordedInngestSteps[stepId]) {
          return recordedInngestSteps[stepId] as unknown as T;
        }
        newExecutions.push(stepId);
        const res = await fn();
        recordedInngestSteps[stepId] = res as unknown as string;
        return res;
      },
    };

    let counter = 0;
    const prefix = "initial-coding";
    const runTerminal = async (cmd: string) => {
      const stepId = `${prefix}-terminal-${++counter}`;
      return mockStep.run(stepId, async () => `Fresh output for ${cmd}`);
    };

    // Replay executes turn 1 (which was interrupted after execution)
    const turn1Result = await runTerminal("turn 1 command");
    assert.equal(turn1Result, "Cached output from turn 1 before interruption");
    assert.equal(newExecutions.length, 0); // Not re-executed!

    // Function progresses to turn 2 (new execution)
    const turn2Result = await runTerminal("turn 2 command");
    assert.equal(turn2Result, "Fresh output for turn 2 command");
    assert.deepEqual(newExecutions, ["initial-coding-terminal-2"]);
  });
});
