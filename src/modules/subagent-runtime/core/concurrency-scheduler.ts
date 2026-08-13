import type { ConcurrencyDecision, ConcurrencyLimits } from "../contracts/scheduling.js";

function providerFromModelKey(modelKey: string): string {
  const slash = modelKey.indexOf("/");
  return slash > 0 ? modelKey.slice(0, slash) : modelKey;
}

export function createConcurrencyAccounting(initialLimits: ConcurrencyLimits) {
  let limits = initialLimits;
  const modelRunning = new Map<string, number>();
  const providerRunning = new Map<string, number>();

  const count = (counts: ReadonlyMap<string, number>, key: string): number => counts.get(key) ?? 0;

  const hasCapacity = (concurrencyKey: string): boolean => {
    const modelLimit = limits.modelLimits[concurrencyKey] ?? limits.defaultModelLimit;
    if (count(modelRunning, concurrencyKey) >= modelLimit) return false;
    const provider = providerFromModelKey(concurrencyKey);
    const providerLimit = limits.providerLimits[provider];
    return providerLimit == null || count(providerRunning, provider) < providerLimit;
  };

  return {
    reserve(concurrencyKey: string): ConcurrencyDecision {
      if (!hasCapacity(concurrencyKey)) {
        return { accepted: false, reason: "concurrency", concurrencyKey };
      }
      const provider = providerFromModelKey(concurrencyKey);
      modelRunning.set(concurrencyKey, count(modelRunning, concurrencyKey) + 1);
      providerRunning.set(provider, count(providerRunning, provider) + 1);
      return { accepted: true, concurrencyKey };
    },
    release(concurrencyKey: string): void {
      const provider = providerFromModelKey(concurrencyKey);
      const modelCount = Math.max(0, count(modelRunning, concurrencyKey) - 1);
      const providerCount = Math.max(0, count(providerRunning, provider) - 1);
      if (modelCount === 0) modelRunning.delete(concurrencyKey);
      else modelRunning.set(concurrencyKey, modelCount);
      if (providerCount === 0) providerRunning.delete(provider);
      else providerRunning.set(provider, providerCount);
    },
    replaceLimits(next: ConcurrencyLimits): void {
      limits = next;
    },
  };
}
