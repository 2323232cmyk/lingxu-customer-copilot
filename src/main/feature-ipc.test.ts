import { describe, expect, it, vi } from 'vitest';
import { FEATURE_CHANNELS, type FeatureBridge } from '../shared/feature-bridge-contracts';
import { createFeaturePreloadBridge } from '../shared/feature-preload';
import { registerFeatureHandlers } from './feature-ipc';

describe('feature bridge security', () => {
  it('exposes only the allowlisted methods and not generic IPC primitives', async () => {
    const invoke = vi.fn().mockResolvedValue({ ok: true, value: [] });
    const bridge = createFeaturePreloadBridge(invoke);
    expect(Object.keys(bridge).sort()).toEqual(Object.keys(FEATURE_CHANNELS).sort());
    expect(bridge).not.toHaveProperty('invoke');
    expect(bridge).not.toHaveProperty('send');
    await bridge.searchCrmCustomers('客户');
    expect(invoke).toHaveBeenCalledWith('features:crm-search', '客户');
    await bridge.listCrmCustomers({ page: 2, stage: 'visited' });
    expect(invoke).toHaveBeenCalledWith('features:crm-list', { page: 2, stage: 'visited' });
    await bridge.getCrmWorkspaceOverview();
    expect(invoke).toHaveBeenCalledWith('features:crm-overview');
    await bridge.listCrmTasks({ scope: 'overdue' });
    expect(invoke).toHaveBeenCalledWith('features:crm-tasks', { scope: 'overdue' });
    await bridge.getKnowledgeWorkspace();
    expect(invoke).toHaveBeenCalledWith('features:knowledge-workspace');
    await bridge.getKnowledgeDocument('synthetic-id');
    expect(invoke).toHaveBeenCalledWith('features:knowledge-document', 'synthetic-id');
    await bridge.createKnowledgeDocument({ title: '公司服务', body: '待审核正文', expiry: null });
    expect(invoke).toHaveBeenCalledWith('features:knowledge-create', { title: '公司服务', body: '待审核正文', expiry: null });
    await bridge.saveKnowledgeDocument({ id: 'synthetic-id', expectedRevision: 1, title: '公司服务', body: '修订正文', expiry: null });
    expect(invoke).toHaveBeenCalledWith('features:knowledge-save', expect.objectContaining({ id: 'synthetic-id', expectedRevision: 1 }));
    await bridge.setKnowledgeDocumentStatus({ id: 'synthetic-id', expectedRevision: 2, status: 'approved' });
    expect(invoke).toHaveBeenCalledWith('features:knowledge-status', { id: 'synthetic-id', expectedRevision: 2, status: 'approved' });
    await bridge.importKnowledgeDocuments();
    expect(invoke).toHaveBeenCalledWith('features:knowledge-import');
  });

  it('validates the sender for every channel before executing any service', async () => {
    const handlers = new Map<string, (event: { trusted: boolean }, ...args: unknown[]) => unknown>();
    const methods = Object.fromEntries(Object.keys(FEATURE_CHANNELS).map((name) => [name, vi.fn().mockResolvedValue({ ok: true })]));
    const registrar = { handle: (channel: string, handler: (event: { trusted: boolean }, ...args: unknown[]) => unknown) => { handlers.set(channel, handler); }, removeHandler: vi.fn() };
    const dispose = registerFeatureHandlers(registrar, methods as unknown as FeatureBridge, (event) => { if (!event.trusted) throw new Error('untrusted'); });
    for (const [name, channel] of Object.entries(FEATURE_CHANNELS)) {
      const handler = handlers.get(channel);
      expect(handler).toBeDefined();
      expect(() => handler?.({ trusted: false }, 'arbitrary-input')).toThrow('untrusted');
      expect(methods[name]).not.toHaveBeenCalled();
      await handler?.({ trusted: true }, 'validated-in-controller');
      expect(methods[name]).toHaveBeenCalledWith('validated-in-controller');
    }
    dispose();
    expect(registrar.removeHandler).toHaveBeenCalledTimes(Object.keys(FEATURE_CHANNELS).length);
  });
});
