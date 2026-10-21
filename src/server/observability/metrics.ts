import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";

/**
 * Model Pricing Rates per million tokens (USD).
 * Kept fully configurable via environment variables or runtime overrides.
 * Assumptions are recorded with every metric calculation.
 */
export interface ModelRate {
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
}

export interface PricingConfig {
  rates: Record<string, ModelRate>;
  defaultRate: ModelRate;
}

/**
 * Standard baseline model pricing (OpenAI rates as of 2026, with historical Gemini retention).
 * gpt-4o: $2.50 / 1M input, $10.00 / 1M output
 * gpt-4o-mini: $0.15 / 1M input, $0.60 / 1M output
 * Historical Gemini rates preserved for immutable accuracy of historical records:
 * gemini-2.5-flash: $0.075 / 1M input, $0.30 / 1M output
 * gemini-2.5-pro: $1.25 / 1M input, $5.00 / 1M output
 */
export const DEFAULT_PRICING_CONFIG: PricingConfig = {
  rates: {
    // Active OpenAI Models
    "gpt-4o": { inputPerMillionUsd: 2.50, outputPerMillionUsd: 10.00 },
    "gpt-4o-mini": { inputPerMillionUsd: 0.15, outputPerMillionUsd: 0.60 },
    // Historical Models (Preserved for immutable cost auditability)
    "gemini-2.5-flash": { inputPerMillionUsd: 0.075, outputPerMillionUsd: 0.30 },
    "gemini-2.5-pro": { inputPerMillionUsd: 1.25, outputPerMillionUsd: 5.00 },
    "gemini-2.0-flash": { inputPerMillionUsd: 0.10, outputPerMillionUsd: 0.40 },
    "gemini-1.5-flash": { inputPerMillionUsd: 0.075, outputPerMillionUsd: 0.30 },
    "gemini-1.5-pro": { inputPerMillionUsd: 1.25, outputPerMillionUsd: 5.00 },
  },
  defaultRate: { inputPerMillionUsd: 0.15, outputPerMillionUsd: 0.60 },
};

export const COST_DISCLAIMER =
  "Estimated model cost based on configured token rates; not actual provider billing expenditure.";

export function getModelPricingConfig(): PricingConfig {
  if (process.env.MODEL_PRICING_CONFIG_JSON) {
    try {
      const parsed = JSON.parse(process.env.MODEL_PRICING_CONFIG_JSON);
      return {
        rates: { ...DEFAULT_PRICING_CONFIG.rates, ...(parsed.rates || {}) },
        defaultRate: parsed.defaultRate || DEFAULT_PRICING_CONFIG.defaultRate,
      };
    } catch {
      // Fallback to default
    }
  }
  return DEFAULT_PRICING_CONFIG;
}

/**
 * Calculates estimated cost based on actual provider usage metadata.
 * Does NOT report missing usage as measured zero.
 * Does NOT substitute a default model ID when actual model identity is unknown.
 */
export function calculateCost(
  modelId?: string,
  promptTokens?: number,
  completionTokens?: number,
  pricingConfig: PricingConfig = getModelPricingConfig()
): {
  costUsd?: number;
  rateUsed?: ModelRate;
  usageMeasured: boolean;
} {
  // If model is unknown, do not substitute a default model ID
  if (!modelId || typeof modelId !== "string" || modelId.trim() === "") {
    return {
      costUsd: undefined,
      rateUsed: undefined,
      usageMeasured: false,
    };
  }

  // Helper to find model rate without substring collision (e.g. gpt-4o shadowing gpt-4o-mini)
  const resolveRate = (): ModelRate => {
    if (pricingConfig.rates[modelId]) {
      return pricingConfig.rates[modelId];
    }
    const lower = modelId.toLowerCase();
    const sortedKeys = Object.keys(pricingConfig.rates).sort((a, b) => b.length - a.length);
    const key =
      sortedKeys.find((k) => lower === k.toLowerCase()) ||
      sortedKeys.find((k) => lower.includes(k.toLowerCase()));
    return key ? pricingConfig.rates[key] : pricingConfig.defaultRate;
  };

  // If token counts are missing/undefined, do not report missing usage as measured zero
  if (promptTokens === undefined || completionTokens === undefined) {
    return {
      costUsd: undefined,
      rateUsed: resolveRate(),
      usageMeasured: false,
    };
  }

  // Both model and token counts are known
  const rateUsed = resolveRate();

  const inputCost = (promptTokens / 1_000_000) * rateUsed.inputPerMillionUsd;
  const outputCost = (completionTokens / 1_000_000) * rateUsed.outputPerMillionUsd;
  const costUsd = Number((inputCost + outputCost).toFixed(6));

  return {
    costUsd,
    rateUsed,
    usageMeasured: true,
  };
}

/**
 * Extracts real provider usage metadata when supplied (supporting OpenAI and historical Gemini).
 */
export function extractUsageMetadata(rawResult: unknown): {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
} | undefined {
  if (!rawResult || typeof rawResult !== "object") return undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyResult = rawResult as any;

  // 1. Direct usage object (Inngest AgentKit or standard OpenAI chat completion usage)
  const candidateUsages = [
    anyResult.usage,
    anyResult.raw?.usage,
    typeof anyResult.raw === "string"
      ? (() => {
          try {
            return JSON.parse(anyResult.raw)?.usage;
          } catch {
            return undefined;
          }
        })()
      : undefined,
  ];

  for (const u of candidateUsages) {
    if (u && typeof u === "object") {
      const prompt =
        typeof u.prompt_tokens === "number"
          ? u.prompt_tokens
          : typeof u.promptTokens === "number"
          ? u.promptTokens
          : undefined;
      const completion =
        typeof u.completion_tokens === "number"
          ? u.completion_tokens
          : typeof u.completionTokens === "number"
          ? u.completionTokens
          : undefined;
      const total =
        typeof u.total_tokens === "number"
          ? u.total_tokens
          : typeof u.totalTokens === "number"
          ? u.totalTokens
          : undefined;

      if (prompt !== undefined || completion !== undefined) {
        return {
          promptTokens: prompt,
          completionTokens: completion,
          totalTokens: total ?? ((prompt || 0) + (completion || 0)),
        };
      }
    }
  }

  // 2. Raw JSON string from Gemini API (historical)
  if (typeof anyResult.raw === "string") {
    try {
      const parsed = JSON.parse(anyResult.raw);
      const um = parsed?.usageMetadata;
      if (um && (typeof um.promptTokenCount === "number" || typeof um.candidatesTokenCount === "number")) {
        return {
          promptTokens: um.promptTokenCount,
          completionTokens: um.candidatesTokenCount,
          totalTokens: um.totalTokenCount,
        };
      }
    } catch {
      // not JSON
    }
  }

  // 3. Parsed usageMetadata on raw object (historical Gemini)
  if (anyResult.raw && typeof anyResult.raw === "object" && anyResult.raw.usageMetadata) {
    const um = anyResult.raw.usageMetadata;
    return {
      promptTokens: um.promptTokenCount,
      completionTokens: um.candidatesTokenCount,
      totalTokens: um.totalTokenCount,
    };
  }

  return undefined;
}

export interface StageMetric {
  stageName: string;
  modelId?: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  usageMeasured: boolean;
  estimatedCostUsd?: number;
  pricingAssumptions?: ModelRate;
  details?: Record<string, unknown>;
  instrumentationError?: string;
}

export interface SandboxMetric {
  creationDurationMs: number;
  totalDurationMs?: number;
  templateId?: string;
  workspacePath?: string;
}

export interface GenerationRunMetrics {
  runId: string;
  projectId: string;
  startedAt: string;
  completedAt: string;
  totalDurationMs: number;
  stages: Record<string, StageMetric>;
  sandbox?: SandboxMetric;
  totalPromptTokens?: number;
  totalCompletionTokens?: number;
  totalTokens?: number;
  hasMeasuredUsage: boolean;
  totalEstimatedCostUsd?: number;
  modelsUsed: string[];
  repairAttempts: number;
  finalOutcome: "COMPLETED" | "FAILED" | "CANCELLED";
  pricingAssumptions: Record<string, ModelRate>;
  costDisclaimer: string;
  hasInstrumentationErrors: boolean;
  instrumentationErrors: string[];
  isCompleteMeasurement: boolean;
}

export interface RecordStageMetricParams {
  runId: string;
  projectId: string;
  stageName: string;
  modelId?: string;
  startedAt: number | Date | string;
  finishedAt: number | Date | string;
  promptTokens?: number;
  completionTokens?: number;
  details?: Record<string, unknown>;
  pricingConfig?: PricingConfig;
  instrumentationError?: string;
}

/**
 * Replay-safe stage metric persistence.
 * Upserts the stage metric into RunEvent with unique metricKey `${runId}:${stageName}`.
 * If an Inngest step retries or concurrent attempts occur, it updates the existing stage event
 * atomically using database-level uniqueness rather than duplicating it.
 */
export async function recordStageMetric(
  params: RecordStageMetricParams,
  dbClient = prisma
): Promise<StageMetric> {
  const {
    runId,
    stageName,
    modelId,
    details,
    pricingConfig = getModelPricingConfig(),
    instrumentationError,
  } = params;

  const startMs = typeof params.startedAt === "number"
    ? params.startedAt
    : new Date(params.startedAt).getTime();
  const endMs = typeof params.finishedAt === "number"
    ? params.finishedAt
    : new Date(params.finishedAt).getTime();
  const durationMs = Math.max(1, endMs - startMs);

  const { costUsd, rateUsed, usageMeasured } = calculateCost(
    modelId,
    params.promptTokens,
    params.completionTokens,
    pricingConfig
  );

  const totalTokens = usageMeasured
    ? (params.promptTokens || 0) + (params.completionTokens || 0)
    : undefined;

  const metric: StageMetric = {
    stageName,
    modelId,
    startedAt: new Date(startMs).toISOString(),
    finishedAt: new Date(endMs).toISOString(),
    durationMs,
    promptTokens: params.promptTokens,
    completionTokens: params.completionTokens,
    totalTokens,
    usageMeasured,
    estimatedCostUsd: costUsd,
    pricingAssumptions: rateUsed,
    details,
    instrumentationError,
  };

  const stageKey = `STAGE_METRIC_${stageName}`;
  const metricKey = `${runId}:${stageName}`;
  const costText = costUsd !== undefined ? `$${costUsd.toFixed(4)} (indicative)` : "unmeasured";
  const tokensText = totalTokens !== undefined ? `${totalTokens} tokens` : "unmeasured tokens";

  try {
    if (typeof dbClient.runEvent.upsert === "function") {
      await dbClient.runEvent.upsert({
        where: { metricKey },
        update: {
          stage: stageKey,
          agentRole: "Observability Engine",
          message: `Stage ${stageName} metric updated: duration ${durationMs}ms, ${tokensText}, estimated cost: ${costText}`,
          payload: metric as unknown as Prisma.InputJsonObject,
        },
        create: {
          runId,
          stage: stageKey,
          agentRole: "Observability Engine",
          message: `Stage ${stageName} metric recorded: duration ${durationMs}ms, ${tokensText}, estimated cost: ${costText}`,
          payload: metric as unknown as Prisma.InputJsonObject,
          metricKey,
        },
      });
    } else {
      // Fallback for mock environments lacking upsert
      const existing = await dbClient.runEvent.findFirst({
        where: { runId, stage: stageKey },
        orderBy: { createdAt: "desc" },
      });

      if (existing) {
        await dbClient.runEvent.update({
          where: { id: existing.id },
          data: {
            message: `Stage ${stageName} metric updated: duration ${durationMs}ms, ${tokensText}, estimated cost: ${costText}`,
            payload: metric as unknown as Prisma.InputJsonObject,
          },
        });
      } else {
        await dbClient.runEvent.create({
          data: {
            runId,
            stage: stageKey,
            agentRole: "Observability Engine",
            message: `Stage ${stageName} metric recorded: duration ${durationMs}ms, ${tokensText}, estimated cost: ${costText}`,
            payload: metric as unknown as Prisma.InputJsonObject,
            metricKey,
          },
        });
      }
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    metric.instrumentationError = errorMsg;
    console.error(`[recordStageMetric] Failed to persist stage metric for ${stageName}:`, err);
  }

  return metric;
}

/**
 * Aggregates all persisted stage records for a run into a final GenerationRunMetrics report.
 * Generated from persisted stage records, not from an in-memory collector initialized at the end.
 * Works for both successful and failed runs (preserving incomplete-run metrics).
 */
export async function aggregateAndPersistRunMetrics(
  runId: string,
  projectId: string,
  outcome: "COMPLETED" | "FAILED" | "CANCELLED" = "COMPLETED",
  pricingConfig: PricingConfig = getModelPricingConfig(),
  dbClient = prisma
): Promise<GenerationRunMetrics> {
  const stageEvents = await dbClient.runEvent.findMany({
    where: {
      runId,
      stage: { startsWith: "STAGE_METRIC_" },
    },
    orderBy: { createdAt: "asc" },
  });

  const stages: Record<string, StageMetric> = {};
  const instrumentationErrors: string[] = [];
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let totalEstimatedCostUsd = 0;
  let hasMeasuredUsage = false;
  let hasMeasuredCost = false;
  let totalDurationMs = 0;
  let earliestStart = Date.now();
  let latestEnd = 0;
  let repairAttempts = 0;
  let sandbox: SandboxMetric | undefined;
  const modelsUsedSet = new Set<string>();
  const pricingAssumptions: Record<string, ModelRate> = {};

  for (const event of stageEvents) {
    if (!event.payload) continue;
    const stageMetric = event.payload as unknown as StageMetric;
    const stageName = stageMetric.stageName || event.stage.replace("STAGE_METRIC_", "");
    stages[stageName] = stageMetric;

    if (stageMetric.instrumentationError) {
      instrumentationErrors.push(`${stageName}: ${stageMetric.instrumentationError}`);
    }

    totalDurationMs += stageMetric.durationMs || 0;
    const sStart = new Date(stageMetric.startedAt).getTime();
    const sEnd = new Date(stageMetric.finishedAt).getTime();
    if (sStart < earliestStart) earliestStart = sStart;
    if (sEnd > latestEnd) latestEnd = sEnd;

    if (stageMetric.usageMeasured) {
      hasMeasuredUsage = true;
      totalPromptTokens += stageMetric.promptTokens || 0;
      totalCompletionTokens += stageMetric.completionTokens || 0;
    }

    if (
      stageMetric.estimatedCostUsd === undefined &&
      stageMetric.modelId &&
      stageMetric.promptTokens !== undefined &&
      stageMetric.completionTokens !== undefined
    ) {
      const { costUsd, rateUsed } = calculateCost(
        stageMetric.modelId,
        stageMetric.promptTokens,
        stageMetric.completionTokens,
        pricingConfig
      );
      if (costUsd !== undefined) {
        stageMetric.estimatedCostUsd = costUsd;
        stageMetric.pricingAssumptions = rateUsed;
      }
    }

    if (stageMetric.estimatedCostUsd !== undefined) {
      hasMeasuredCost = true;
      totalEstimatedCostUsd += stageMetric.estimatedCostUsd;
    }

    if (stageMetric.modelId) {
      modelsUsedSet.add(stageMetric.modelId);
      if (stageMetric.pricingAssumptions) {
        pricingAssumptions[stageMetric.modelId] = stageMetric.pricingAssumptions;
      }
    }

    // Extract sandbox details if recorded
    if (stageName === "sandbox-init" && stageMetric.details) {
      sandbox = {
        creationDurationMs: stageMetric.durationMs,
        templateId: stageMetric.details.templateId as string | undefined,
        workspacePath: stageMetric.details.workspacePath as string | undefined,
      };
    }

    // Extract repair attempts from QA stage if present
    if (stageName === "qa-and-repair" && stageMetric.details) {
      repairAttempts = (stageMetric.details.repairAttempts as number) || 0;
    }
  }

  // Fallback start/end if no stages recorded
  if (earliestStart > Date.now()) earliestStart = Date.now();
  if (latestEnd === 0) latestEnd = Date.now();

  const hasInstrumentationErrors = instrumentationErrors.length > 0;
  const isCompleteMeasurement = !hasInstrumentationErrors && Object.keys(stages).length > 0;

  const finalMetrics: GenerationRunMetrics = {
    runId,
    projectId,
    startedAt: new Date(earliestStart).toISOString(),
    completedAt: new Date(latestEnd).toISOString(),
    totalDurationMs: Math.max(totalDurationMs, latestEnd - earliestStart),
    stages,
    sandbox,
    totalPromptTokens: hasMeasuredUsage ? totalPromptTokens : undefined,
    totalCompletionTokens: hasMeasuredUsage ? totalCompletionTokens : undefined,
    totalTokens: hasMeasuredUsage ? totalPromptTokens + totalCompletionTokens : undefined,
    hasMeasuredUsage,
    totalEstimatedCostUsd: hasMeasuredCost ? Number(totalEstimatedCostUsd.toFixed(6)) : undefined,
    modelsUsed: Array.from(modelsUsedSet),
    repairAttempts,
    finalOutcome: outcome,
    pricingAssumptions,
    costDisclaimer: COST_DISCLAIMER,
    hasInstrumentationErrors,
    instrumentationErrors,
    isCompleteMeasurement,
  };

  const costStr = finalMetrics.totalEstimatedCostUsd !== undefined
    ? `$${finalMetrics.totalEstimatedCostUsd.toFixed(4)} (indicative estimate)`
    : "unmeasured";
  const tokenStr = finalMetrics.totalTokens !== undefined
    ? `${finalMetrics.totalTokens} tokens`
    : "unmeasured tokens";

  const aggMetricKey = `${runId}:AGGREGATE_METRICS`;

  try {
    if (typeof dbClient.runEvent.upsert === "function") {
      await dbClient.runEvent.upsert({
        where: { metricKey: aggMetricKey },
        update: {
          stage: "METRICS_RECORDED",
          agentRole: "Observability Engine",
          message: `Generation metrics aggregated (${outcome}): duration ${finalMetrics.totalDurationMs}ms, ${tokenStr}, estimated cost ${costStr}`,
          payload: finalMetrics as unknown as Prisma.InputJsonObject,
        },
        create: {
          runId,
          stage: "METRICS_RECORDED",
          agentRole: "Observability Engine",
          message: `Generation metrics aggregated (${outcome}): duration ${finalMetrics.totalDurationMs}ms, ${tokenStr}, estimated cost ${costStr}`,
          payload: finalMetrics as unknown as Prisma.InputJsonObject,
          metricKey: aggMetricKey,
        },
      });
    } else {
      const existingAggregate = await dbClient.runEvent.findFirst({
        where: {
          runId,
          stage: "METRICS_RECORDED",
        },
        orderBy: { createdAt: "desc" },
      });

      if (existingAggregate) {
        await dbClient.runEvent.update({
          where: { id: existingAggregate.id },
          data: {
            message: `Generation metrics aggregated (${outcome}): duration ${finalMetrics.totalDurationMs}ms, ${tokenStr}, estimated cost ${costStr}`,
            payload: finalMetrics as unknown as Prisma.InputJsonObject,
          },
        });
      } else {
        await dbClient.runEvent.create({
          data: {
            runId,
            stage: "METRICS_RECORDED",
            agentRole: "Observability Engine",
            message: `Generation metrics aggregated (${outcome}): duration ${finalMetrics.totalDurationMs}ms, ${tokenStr}, estimated cost ${costStr}`,
            payload: finalMetrics as unknown as Prisma.InputJsonObject,
            metricKey: aggMetricKey,
          },
        });
      }
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    finalMetrics.hasInstrumentationErrors = true;
    finalMetrics.isCompleteMeasurement = false;
    finalMetrics.instrumentationErrors.push(`persistence: ${errorMsg}`);
    console.error("[aggregateAndPersistRunMetrics] Failed to persist aggregated metrics:", err);
  }

  return finalMetrics;
}

/**
 * Retrieves recorded metrics for a generation run.
 * If final aggregate is not yet recorded, aggregates available stage records.
 */
export async function getRunMetrics(
  runId: string,
  dbClient = prisma
): Promise<GenerationRunMetrics | null> {
  const event = await dbClient.runEvent.findFirst({
    where: {
      runId,
      stage: "METRICS_RECORDED",
    },
    orderBy: { createdAt: "desc" },
  });

  if (event && event.payload) {
    return event.payload as unknown as GenerationRunMetrics;
  }

  // Fallback: aggregate any recorded stages for this run
  const stageEvents = await dbClient.runEvent.findMany({
    where: {
      runId,
      stage: { startsWith: "STAGE_METRIC_" },
    },
  });

  if (stageEvents.length === 0) return null;

  const run = await dbClient.generationRun.findUnique({
    where: { id: runId },
    select: { projectId: true, status: true },
  });

  const outcome = run?.status === "COMPLETED" ? "COMPLETED" : "FAILED";
  return aggregateAndPersistRunMetrics(runId, run?.projectId || "", outcome, undefined, dbClient);
}

/**
 * Retained for backwards-compatibility with existing tests.
 */
export class GenerationMetricsCollector {
  private runId: string;
  private projectId: string;
  private startedAt: number;
  private stageStarts: Map<string, { startMs: number; modelId?: string }> = new Map();
  private stages: Record<string, StageMetric> = {};
  private sandbox?: SandboxMetric;
  private repairAttempts = 0;
  private pricingConfig: PricingConfig;

  constructor(runId: string, projectId: string, pricingConfig?: PricingConfig) {
    this.runId = runId;
    this.projectId = projectId;
    this.startedAt = Date.now();
    this.pricingConfig = pricingConfig || getModelPricingConfig();
  }

  public startStage(stageName: string, modelId?: string) {
    this.stageStarts.set(stageName, {
      startMs: Date.now(),
      modelId,
    });
  }

  public endStage(
    stageName: string,
    options: {
      promptTokens?: number;
      completionTokens?: number;
      details?: Record<string, unknown>;
    } = {}
  ): StageMetric {
    const entry = this.stageStarts.get(stageName);
    const startMs = entry ? entry.startMs : this.startedAt;
    const modelId = entry?.modelId;
    const endMs = Date.now();
    const durationMs = Math.max(1, endMs - startMs);

    const { costUsd, rateUsed, usageMeasured } = calculateCost(
      modelId,
      options.promptTokens,
      options.completionTokens,
      this.pricingConfig
    );

    const totalTokens = usageMeasured
      ? (options.promptTokens || 0) + (options.completionTokens || 0)
      : undefined;

    const stageMetric: StageMetric = {
      stageName,
      modelId,
      startedAt: new Date(startMs).toISOString(),
      finishedAt: new Date(endMs).toISOString(),
      durationMs,
      promptTokens: options.promptTokens,
      completionTokens: options.completionTokens,
      totalTokens,
      usageMeasured,
      estimatedCostUsd: costUsd,
      pricingAssumptions: rateUsed,
      details: options.details,
    };

    this.stages[stageName] = stageMetric;
    this.stageStarts.delete(stageName);
    return stageMetric;
  }

  public recordSandboxCreation(durationMs: number, templateId?: string, workspacePath?: string) {
    this.sandbox = {
      creationDurationMs: durationMs,
      templateId,
      workspacePath,
    };
  }

  public recordSandboxTotal(totalDurationMs: number) {
    if (this.sandbox) {
      this.sandbox.totalDurationMs = totalDurationMs;
    } else {
      this.sandbox = {
        creationDurationMs: 0,
        totalDurationMs,
      };
    }
  }

  public recordRepairAttempt() {
    this.repairAttempts += 1;
  }

  public recordInstrumentationError(stageName: string, error: string) {
    if (this.stages[stageName]) {
      this.stages[stageName].instrumentationError = error;
    }
  }

  public finalize(outcome: "COMPLETED" | "FAILED" | "CANCELLED" = "COMPLETED"): GenerationRunMetrics {
    const endMs = Date.now();
    const totalDurationMs = Math.max(1, endMs - this.startedAt);

    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;
    let totalEstimatedCostUsd = 0;
    let hasMeasuredUsage = false;
    let hasMeasuredCost = false;
    const modelsUsedSet = new Set<string>();
    const pricingAssumptions: Record<string, ModelRate> = {};
    const instrumentationErrors: string[] = [];

    for (const stage of Object.values(this.stages)) {
      if (stage.instrumentationError) {
        instrumentationErrors.push(`${stage.stageName}: ${stage.instrumentationError}`);
      }
      if (stage.usageMeasured) {
        hasMeasuredUsage = true;
        totalPromptTokens += stage.promptTokens || 0;
        totalCompletionTokens += stage.completionTokens || 0;
      }
      if (stage.estimatedCostUsd !== undefined) {
        hasMeasuredCost = true;
        totalEstimatedCostUsd += stage.estimatedCostUsd;
      }
      if (stage.modelId) {
        modelsUsedSet.add(stage.modelId);
        if (stage.pricingAssumptions) {
          pricingAssumptions[stage.modelId] = stage.pricingAssumptions;
        }
      }
    }

    const hasInstrumentationErrors = instrumentationErrors.length > 0;
    const isCompleteMeasurement = !hasInstrumentationErrors && Object.keys(this.stages).length > 0;

    return {
      runId: this.runId,
      projectId: this.projectId,
      startedAt: new Date(this.startedAt).toISOString(),
      completedAt: new Date(endMs).toISOString(),
      totalDurationMs,
      stages: this.stages,
      sandbox: this.sandbox,
      totalPromptTokens: hasMeasuredUsage ? totalPromptTokens : undefined,
      totalCompletionTokens: hasMeasuredUsage ? totalCompletionTokens : undefined,
      totalTokens: hasMeasuredUsage ? totalPromptTokens + totalCompletionTokens : undefined,
      hasMeasuredUsage,
      totalEstimatedCostUsd: hasMeasuredCost ? Number(totalEstimatedCostUsd.toFixed(6)) : undefined,
      modelsUsed: Array.from(modelsUsedSet),
      repairAttempts: this.repairAttempts,
      finalOutcome: outcome,
      pricingAssumptions,
      costDisclaimer: COST_DISCLAIMER,
      hasInstrumentationErrors,
      instrumentationErrors,
      isCompleteMeasurement,
    };
  }

  public async persist(
    outcome: "COMPLETED" | "FAILED" | "CANCELLED" = "COMPLETED",
    dbClient = prisma
  ): Promise<GenerationRunMetrics> {
    const metrics = this.finalize(outcome);
    try {
      await dbClient.runEvent.create({
        data: {
          runId: this.runId,
          stage: "METRICS_RECORDED",
          agentRole: "Observability Engine",
          message: `Generation metrics recorded: total duration ${metrics.totalDurationMs}ms, ${metrics.totalTokens ?? "unmeasured"} tokens, estimated cost $${metrics.totalEstimatedCostUsd !== undefined ? metrics.totalEstimatedCostUsd.toFixed(4) : "unmeasured"}`,
          payload: metrics as unknown as Prisma.InputJsonObject,
        },
      });
    } catch (err) {
      console.error("[MetricsCollector] Failed to persist metrics event:", err);
    }
    return metrics;
  }
}
