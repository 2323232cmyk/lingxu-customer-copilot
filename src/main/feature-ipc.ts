import { FEATURE_CHANNELS, type FeatureBridge } from '../shared/feature-bridge-contracts';

export interface FeatureIpcRegistrar<Event> {
  handle(channel: string, listener: (event: Event, ...args: unknown[]) => unknown): void;
  removeHandler(channel: string): void;
}

export function registerFeatureHandlers<Event>(registrar: FeatureIpcRegistrar<Event>, controller: FeatureBridge, assertTrustedSender: (event: Event) => void): () => void {
  for (const [methodName, channel] of Object.entries(FEATURE_CHANNELS)) {
    const method = controller[methodName as keyof FeatureBridge].bind(controller) as (...args: unknown[]) => unknown;
    registrar.handle(channel, (event, ...args) => { assertTrustedSender(event); return method(...args); });
  }
  return () => { for (const channel of Object.values(FEATURE_CHANNELS)) registrar.removeHandler(channel); };
}
