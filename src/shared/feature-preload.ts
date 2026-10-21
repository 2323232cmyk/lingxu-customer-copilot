import { FEATURE_CHANNELS, type FeatureBridge } from './feature-bridge-contracts';

/** Only named, allowlisted methods cross the context bridge; the invoke primitive stays private. */
export function createFeaturePreloadBridge(invoke: (channel: string, ...args: unknown[]) => Promise<unknown>): FeatureBridge {
  return Object.fromEntries(Object.entries(FEATURE_CHANNELS).map(([method, channel]) => [method, (...args: unknown[]) => invoke(channel, ...args)])) as unknown as FeatureBridge;
}
