import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  WECHAT_WORKER_PROTOCOL_VERSION,
  type WechatWorkerHello,
  type WechatWorkerResponse,
} from '../../../shared/wechat-worker-protocol';
import {
  WechatEngineManager,
  type WechatWorkerProcess,
} from './engine-manager';

class FakeWorker extends EventEmitter implements WechatWorkerProcess {
  readonly posted: unknown[] = [];
  killed = false;

  postMessage(message: unknown): void {
    this.posted.push(message);
  }

  kill(): boolean {
    this.killed = true;
    return true;
  }
}

const hello = (generation: string): WechatWorkerHello => ({
  protocolVersion: WECHAT_WORKER_PROTOCOL_VERSION,
  kind: 'hello',
  generation,
  engineVersion: '0.1.0',
  resourceFingerprint: 'a'.repeat(64),
  capabilities: ['engine.start', 'accounts.list'],
});

const response = (
  generation: string,
  requestId: string,
  result: unknown,
): WechatWorkerResponse => ({
  protocolVersion: WECHAT_WORKER_PROTOCOL_VERSION,
  kind: 'response',
  generation,
  requestId,
  ok: true,
  result,
});

const ids = (...values: string[]): (() => string) => {
  const queue = [...values];
  return () => {
    const value = queue.shift();
    if (!value) throw new Error('Test ID queue is empty');
    return value;
  };
};

afterEach(() => {
  vi.useRealTimers();
});

describe('WechatEngineManager', () => {
  it('requires a valid hello and correlates bounded requests by generation and ID', async () => {
    const workers: FakeWorker[] = [];
    const manager = new WechatEngineManager({
      spawn: () => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker;
      },
      idFactory: ids('generation-1', 'request-1'),
    });

    const started = manager.start();
    workers[0].emit('message', hello('generation-1'));
    await started;
    expect(manager.getSnapshot().state).toBe('ready');

    const requested = manager.request('accounts.list', {});
    expect(workers[0].posted).toMatchObject([{
      kind: 'request',
      generation: 'generation-1',
      requestId: 'request-1',
      command: 'accounts.list',
    }]);
    workers[0].emit('message', response('generation-1', 'request-1', {
      accounts: [{ accountKey: 'account-1', displayName: '测试账号' }],
    }));
    await expect(requested).resolves.toMatchObject({
      accounts: [{ accountKey: 'account-1' }],
    });
    manager.stop();
  });

  it('treats an invalid or mismatched handshake as fatal', async () => {
    const worker = new FakeWorker();
    const manager = new WechatEngineManager({
      spawn: () => worker,
      idFactory: ids('generation-1'),
    });

    const started = manager.start();
    worker.emit('message', hello('forged-generation'));

    await expect(started).rejects.toThrow('generation mismatch');
    expect(manager.getSnapshot().state).toBe('fatal');
    expect(worker.killed).toBe(true);
  });

  it('creates a fresh worker after an explicit retry from fatal without retrying fatal automatically', async () => {
    vi.useFakeTimers();
    const workers: FakeWorker[] = [];
    const manager = new WechatEngineManager({
      spawn: () => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker;
      },
      idFactory: ids('generation-1', 'generation-2'),
    });
    const firstStart = manager.start();
    workers[0].emit('message', hello('forged-generation'));
    await expect(firstStart).rejects.toThrow('generation mismatch');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(workers).toHaveLength(1);

    const retried = manager.start();
    expect(workers).toHaveLength(2);
    workers[1].emit('message', hello('generation-2'));

    await expect(retried).resolves.toBeUndefined();
    expect(manager.getSnapshot()).toMatchObject({
      state: 'ready', generation: 'generation-2', restartAttempt: 0,
    });
    expect(manager.getSnapshot().lastError).toBeUndefined();
    manager.stop();
  });

  it('stays stopped at the retry limit until a user explicitly starts a fresh retry budget', async () => {
    vi.useFakeTimers();
    const workers: FakeWorker[] = [];
    const manager = new WechatEngineManager({
      spawn: () => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker;
      },
      idFactory: ids('generation-1', 'generation-2', 'generation-3'),
      handshakeTimeoutMs: 10,
      backoffDelaysMs: [5],
      maxRestartAttempts: 1,
      random: () => 0.5,
    });
    const started = manager.start();
    const rejected = expect(started).rejects.toThrow('handshake timed out');
    await vi.advanceTimersByTimeAsync(25);
    await rejected;
    expect(manager.getSnapshot()).toMatchObject({ state: 'fatal', restartAttempt: 1 });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(workers).toHaveLength(2);

    const retried = manager.start();
    expect(workers).toHaveLength(3);
    workers[2].emit('message', hello('generation-3'));
    await expect(retried).resolves.toBeUndefined();
    expect(manager.getSnapshot()).toMatchObject({ state: 'ready', restartAttempt: 0 });
    manager.stop();
  });

  it('accepts the strict account and conversation result from engine.start', async () => {
    const worker = new FakeWorker();
    const manager = new WechatEngineManager({
      spawn: () => worker,
      idFactory: ids('generation-1', 'request-1'),
    });

    const started = manager.start();
    worker.emit('message', hello('generation-1'));
    await started;
    const requested = manager.request('engine.start', {});
    worker.emit('message', response('generation-1', 'request-1', {
      accountKey: 'account-1',
      conversations: [{
        contactKey: 'contact-1',
        displayName: '林先生',
        kind: 'contact',
      }],
    }));

    await expect(requested).resolves.toMatchObject({
      accountKey: 'account-1',
      conversations: [{ contactKey: 'contact-1' }],
    });
    manager.stop();
  });

  it('times out a stuck request, backs off, and starts a new generation', async () => {
    vi.useFakeTimers();
    const workers: FakeWorker[] = [];
    const manager = new WechatEngineManager({
      spawn: () => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker;
      },
      idFactory: ids('generation-1', 'request-1', 'generation-2'),
      requestTimeoutMs: 50,
      engineStartTimeoutMs: 100,
      handshakeTimeoutMs: 50,
      backoffDelaysMs: [10],
      random: () => 0.5,
    });

    const firstStart = manager.start();
    workers[0].emit('message', hello('generation-1'));
    await firstStart;

    const requested = manager.request('engine.start', {});
    const rejected = expect(requested).rejects.toThrow('request timed out');
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    expect(manager.getSnapshot()).toMatchObject({
      state: 'backoff',
      restartAttempt: 1,
      restartInMs: 10,
    });
    expect(workers[0].killed).toBe(true);

    const secondStart = manager.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(workers).toHaveLength(2);
    workers[1].emit('message', hello('generation-2'));
    await secondStart;
    expect(manager.getSnapshot()).toMatchObject({ state: 'ready', generation: 'generation-2' });
    manager.stop();
  });

  it('does not reset the retry budget while native startup is still pending', async () => {
    vi.useFakeTimers();
    const workers: FakeWorker[] = [];
    const manager = new WechatEngineManager({
      spawn: () => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker;
      },
      idFactory: ids('generation-1', 'request-1', 'generation-2', 'request-2'),
      engineStartTimeoutMs: 100,
      handshakeTimeoutMs: 10,
      stableResetMs: 20,
      backoffDelaysMs: [5],
      maxRestartAttempts: 1,
      random: () => 0.5,
    });
    try {
      const started = manager.start();
      workers[0].emit('message', hello('generation-1'));
      await started;
      const firstFailure = expect(manager.request('engine.start', {}))
        .rejects.toThrow('request timed out');
      await vi.advanceTimersByTimeAsync(100);
      await firstFailure;
      await vi.advanceTimersByTimeAsync(5);
      workers[1].emit('message', hello('generation-2'));

      const secondFailure = expect(manager.request('engine.start', {}))
        .rejects.toThrow('request timed out');
      await vi.advanceTimersByTimeAsync(100);
      await secondFailure;

      expect(manager.getSnapshot()).toMatchObject({ state: 'fatal', restartAttempt: 1 });
      await vi.advanceTimersByTimeAsync(1000);
      expect(workers).toHaveLength(2);
    } finally {
      manager.stop();
    }
  });

  it('resets the retry budget after a successfully initialized native generation remains stable', async () => {
    vi.useFakeTimers();
    const workers: FakeWorker[] = [];
    const manager = new WechatEngineManager({
      spawn: () => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker;
      },
      idFactory: ids('generation-1', 'generation-2', 'request-1'),
      handshakeTimeoutMs: 10,
      stableResetMs: 20,
      backoffDelaysMs: [5],
      random: () => 0.5,
    });
    const started = manager.start();
    await vi.advanceTimersByTimeAsync(15);
    workers[1].emit('message', hello('generation-2'));
    await started;
    expect(manager.getSnapshot().restartAttempt).toBe(1);
    const initialized = manager.request('engine.start', {});
    workers[1].emit('message', response('generation-2', 'request-1', {
      accountKey: 'account-1', conversations: [],
    }));
    await initialized;

    await vi.advanceTimersByTimeAsync(20);

    expect(manager.getSnapshot()).toMatchObject({ state: 'ready', restartAttempt: 0 });
    manager.stop();
  });

  it('ignores stale process messages and refuses non-monotonic current events', async () => {
    vi.useFakeTimers();
    const workers: FakeWorker[] = [];
    const manager = new WechatEngineManager({
      spawn: () => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker;
      },
      idFactory: ids('generation-1', 'generation-2'),
      backoffDelaysMs: [1],
      random: () => 0.5,
    });

    const firstStart = manager.start();
    workers[0].emit('message', hello('generation-1'));
    await firstStart;
    workers[0].emit('exit', 1);
    await vi.advanceTimersByTimeAsync(1);
    const secondStart = manager.start();
    workers[0].emit('message', { malformed: true });
    workers[1].emit('message', hello('generation-2'));
    await secondStart;

    const event = {
      protocolVersion: WECHAT_WORKER_PROTOCOL_VERSION,
      kind: 'event',
      generation: 'generation-2',
      sequence: 1,
      event: 'engine.state',
      payload: { state: 'streaming' },
    };
    workers[1].emit('message', event);
    workers[1].emit('message', event);
    expect(manager.getSnapshot().state).toBe('fatal');
    expect(workers[1].killed).toBe(true);
  });

  it('stops without restarting and rejects outstanding readiness waiters', async () => {
    vi.useFakeTimers();
    const worker = new FakeWorker();
    const manager = new WechatEngineManager({
      spawn: () => worker,
      idFactory: ids('generation-1'),
      handshakeTimeoutMs: 20,
      backoffDelaysMs: [5],
    });

    const started = manager.start();
    manager.stop();
    await expect(started).rejects.toThrow('stopped');
    await vi.advanceTimersByTimeAsync(100);
    expect(manager.getSnapshot().state).toBe('stopped');
    expect(worker.killed).toBe(true);
  });
});
