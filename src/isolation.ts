import type { AdapterDescriptor, EnforcementStrength } from "./contracts.js";

export type SupportedHostPlatform = "darwin";

export interface IsolationRequirement {
  filesystem: EnforcementStrength;
  workloadNetwork: EnforcementStrength;
}

export interface AdapterOsCapability {
  adapter: string;
  platform: NodeJS.Platform;
  officiallySupportedHost: boolean;
  runtimeIsolationAvailable: boolean;
  filesystem: EnforcementStrength;
  workloadNetwork: EnforcementStrength;
  providerControlPlane: AdapterDescriptor["capabilities"]["network"]["providerControlPlane"];
}

export function adapterOsCapability(descriptor: AdapterDescriptor, platform: NodeJS.Platform = process.platform): AdapterOsCapability {
  const officiallySupportedHost = platform === "darwin";
  const runtimeIsolationAvailable = platform === "darwin" || platform === "linux";
  return {
    adapter: descriptor.adapter,
    platform,
    officiallySupportedHost,
    runtimeIsolationAvailable,
    filesystem: runtimeIsolationAvailable ? descriptor.capabilities.filesystemEnforcement : "unavailable",
    workloadNetwork: runtimeIsolationAvailable ? descriptor.capabilities.network.workload : "unavailable",
    providerControlPlane: descriptor.capabilities.network.providerControlPlane,
  };
}

export function isolationIssues(
  descriptor: AdapterDescriptor,
  requirement: IsolationRequirement,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const capability = adapterOsCapability(descriptor, platform);
  if (!capability.runtimeIsolationAvailable) return [`host OS ${platform} is outside the runtime isolation support matrix`];
  const issues: string[] = [];
  if (!enforcementSatisfies(capability.filesystem, requirement.filesystem)) {
    issues.push(`filesystem enforcement ${capability.filesystem} is weaker than required ${requirement.filesystem} on ${platform}`);
  }
  if (!enforcementSatisfies(capability.workloadNetwork, requirement.workloadNetwork)) {
    issues.push(`workload-network enforcement ${capability.workloadNetwork} is weaker than required ${requirement.workloadNetwork} on ${platform}`);
  }
  return issues;
}

export function enforcementSatisfies(actual: EnforcementStrength, required: EnforcementStrength): boolean {
  const rank: Record<EnforcementStrength, number> = { unavailable: 0, tool_policy_only: 1, enforced: 2 };
  return rank[actual] >= rank[required];
}
