import type { SalesCopilotBridge } from './shared/contracts';

declare global {
  interface Window {
    salesCopilot: SalesCopilotBridge;
  }
}

export {};
