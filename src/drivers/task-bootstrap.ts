import type { TaskBinding } from "../engine/contracts.js";
import { DurableDriver } from "./durable-driver.js";
import { PiResources, type ResourceBootstrap, type ResourceHost } from "./pi-resources.js";

/** Resource discovery completes the accepted binding before its first durable write. */
export interface TaskBootstrap {
  path: string;
  resources: ResourceBootstrap;
  binding?: TaskBinding;
}

export async function openTask(bootstrap: TaskBootstrap, host: ResourceHost): Promise<DurableDriver> {
  const resources = await PiResources.open(bootstrap.resources, host);
  try {
    const original = bootstrap.binding ?? bootstrap.resources.restored!;
    const execution = original.execution;
    if (execution?.requireRegisteredProvider && !resources.models.getRegisteredProviderIds().includes(original.policy.model.provider)) {
      throw new Error(`Worker cannot reconstruct registered provider: ${original.policy.model.provider}. Load its provider extension in the child.`);
    }
    const settings = bootstrap.binding || !execution ? {
      retry: resources.settings.getRetrySettings(), compaction: resources.settings.getCompactionSettings(),
    } : execution.settings;
    const binding = bootstrap.binding ? { ...original,
      resources: { extensions: resources.extensionPaths, trusted: bootstrap.resources.projectTrusted },
      execution: execution ? { ...execution, settings } : undefined,
      policy: { ...original.policy, tools: resources.toolNames, toolSources: resources.toolSources, systemPrompt: resources.systemPrompt },
    } : undefined;
    return await DurableDriver.open({ path: bootstrap.path, binding, models: resources.models, piResources: resources, ...settings });
  } catch (error) {
    await resources.close();
    throw error;
  }
}
