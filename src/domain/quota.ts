import type { ModelIdentity } from "./policy.js";

// Note: see .agents/notes/implemented/architecture/2026-09-09-hierarchical-concurrency-ceilings.md
export interface QuotaLimits {
  readonly default: number;
  readonly providers?: Readonly<Record<string, number>>;
  readonly models?: Readonly<Record<string, number>>;
}

function positiveLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError("Concurrency limits must be positive safe integers");
  }
  return value;
}

function readLimits(limits: QuotaLimits) {
  return {
    default: positiveLimit(limits.default),
    providers: new Map(Object.entries(limits.providers ?? {}).map(([key, value]) => [key, positiveLimit(value)])),
    models: new Map(Object.entries(limits.models ?? {}).map(([key, value]) => [key, positiveLimit(value)])),
  };
}

function releaseCount(counts: Map<string, number>, key: string): void {
  const next = counts.get(key)! - 1;
  if (next === 0) counts.delete(key);
  else counts.set(key, next);
}

/** Capacity belongs to executions, independently of task IDs and mutable ceilings. */
export class Quota {
  private limits: ReturnType<typeof readLimits>;
  private readonly modelRunning = new Map<string, number>();
  private readonly providerRunning = new Map<string, number>();

  constructor(limits: QuotaLimits) {
    this.limits = readLimits(limits);
  }

  setLimits(limits: QuotaLimits): void {
    this.limits = readLimits(limits);
  }

  /** The owner calls the returned release function after actual execution stops. */
  tryAcquire(model: ModelIdentity): (() => void) | undefined {
    const provider = model.provider;
    const modelKey = `${provider}/${model.id}`;
    const modelRunning = this.modelRunning.get(modelKey) ?? 0;
    const providerRunning = this.providerRunning.get(provider) ?? 0;
    const modelLimit = this.limits.models.get(modelKey) ?? this.limits.default;
    const providerLimit = this.limits.providers.get(provider);
    if (modelRunning >= modelLimit || (providerLimit !== undefined && providerRunning >= providerLimit)) return;

    this.modelRunning.set(modelKey, modelRunning + 1);
    this.providerRunning.set(provider, providerRunning + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseCount(this.modelRunning, modelKey);
      releaseCount(this.providerRunning, provider);
    };
  }
}
