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
 * Standard baseline model pricing (Google Gemini rates as of 2026).
 * Flash: $0.075 / 1M input (<128k), $0.30 / 1M output
 * Pro: $1.25 / 1M input (<128k), $5.00 / 1M output
 */
export const DEFAULT_PRICING_CONFIG: PricingConfig = {
  rates: {
    "gemini-2.5-flash": { inputPerMillionUsd: 0.075, outputPerMillionUsd: 0.30 },
    "gemini-2.5-pro": { inputPerMillionUsd: 1.25, outputPerMillionUsd: 5.00 },
    "gemini-2.0-flash": { inputPerMillionUsd: 0.10, outputPerMillionUsd: 0.40 },
    "gemini-1.5-flash": { inputPerMillionUsd: 0.075, outputPerMillionUsd: 0.30 },
    "gemini-1.5-pro": { inputPerMillionUsd: 1.25, outputPerMillionUsd: 5.00 },
  },
  defaultRate: { inputPerMillionUsd: 0.10, outputPerMillionUsd: 0.40 },
};

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

export function calculateCost(
  modelId: string,
  promptTokens = 0,
  completionTokens = 0,
  pricingConfig: PricingConfig = getModelPricingConfig()
): { costUsd: number; rateUsed: ModelRate } {
  // Normalize model key
  const normalizedKey = Object.keys(pricingConfig.rates).find((k) =>
    modelId.toLowerCase().includes(k.toLowerCase())
  );
  const rateUsed = normalizedKey
    ? pricingConfig.rates[normalizedKey]
    : pricingConfig.defaultRate;

  const inputCost = (promptTokens / 1_000_000) * rateUsed.inputPerMillionUsd;
  const outputCost = (completionTokens / 1_000_000) * rateUsed.outputPerMillionUsd;
  const costUsd = Number((inputCost + outputCost).toFixed(6));

  return { costUsd, rateUsed };
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
  estimatedCostUsd: number;
  pricingAssumptions: ModelRate;
  details?: Record<string, unknown>;
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
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  totalEstimatedCostUsd: number;
  modelsUsed: string[];
  repairAttempts: number;
  finalOutcome: "COMPLETED" | "FAILED" | "CANCELLED";
  pricingAssumptions: Record<string, ModelRate>;
}

/**
 * Lightweight in-memory collector for per-generation metrics.
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
    const modelId = entry?.modelId || "gemini-2.5-flash";
    const endMs = Date.now();
    const durationMs = Math.max(1, endMs - startMs);

    const promptTokens = options.promptTokens || 0;
    const completionTokens = options.completionTokens || 0;
    const totalTokens = promptTokens + completionTokens;

    const { costUsd, rateUsed } = calculateCost(
      modelId,
      promptTokens,
      completionTokens,
      this.pricingConfig
    );

    const stageMetric: StageMetric = {
      stageName,
      modelId,
      startedAt: new Date(startMs).toISOString(),
      finishedAt: new Date(endMs).toISOString(),
      durationMs,
      promptTokens,
      completionTokens,
      totalTokens,
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

  public finalize(outcome: "COMPLETED" | "FAILED" | "CANCELLED" = "COMPLETED"): GenerationRunMetrics {
    const endMs = Date.now();
    const totalDurationMs = Math.max(1, endMs - this.startedAt);

    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;
    let totalEstimatedCostUsd = 0;
    const modelsUsedSet = new Set<string>();
    const pricingAssumptions: Record<string, ModelRate> = {};

    for (const stage of Object.values(this.stages)) {
      totalPromptTokens += stage.promptTokens || 0;
      totalCompletionTokens += stage.completionTokens || 0;
      totalEstimatedCostUsd += stage.estimatedCostUsd || 0;
      if (stage.modelId) {
        modelsUsedSet.add(stage.modelId);
        pricingAssumptions[stage.modelId] = stage.pricingAssumptions;
      }
    }

    return {
      runId: this.runId,
      projectId: this.projectId,
      startedAt: new Date(this.startedAt).toISOString(),
      completedAt: new Date(endMs).toISOString(),
      totalDurationMs,
      stages: this.stages,
      sandbox: this.sandbox,
      totalPromptTokens,
      totalCompletionTokens,
      totalTokens: totalPromptTokens + totalCompletionTokens,
      totalEstimatedCostUsd: Number(totalEstimatedCostUsd.toFixed(6)),
      modelsUsed: Array.from(modelsUsedSet),
      repairAttempts: this.repairAttempts,
      finalOutcome: outcome,
      pricingAssumptions,
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
          message: `Generation metrics recorded: total duration ${metrics.totalDurationMs}ms, ${metrics.totalTokens} tokens, estimated cost $${metrics.totalEstimatedCostUsd.toFixed(4)}`,
          payload: metrics as unknown as Prisma.InputJsonObject,
        },
      });
    } catch (err) {
      console.error("[MetricsCollector] Failed to persist metrics event:", err);
    }
    return metrics;
  }
}

/**
 * Retrieves recorded metrics for a generation run.
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

  if (!event || !event.payload) return null;
  return event.payload as unknown as GenerationRunMetrics;
}
