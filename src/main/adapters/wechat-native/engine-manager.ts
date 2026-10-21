import { randomUUID } from 'node:crypto';
import {
  createWechatWorkerRequest,
  isWechatEngineStartResult,
  isWechatWorkerIncomingMessage,
  type WechatWorkerCommand,
  type WechatWorkerEvent,
} from '../../../shared/wechat-worker-protocol';

export type WechatEngineManagerState =
  | 'stopped'
  | 'starting'
  | 'ready'
  | 'backoff'
  | 'fatal';

export interface WechatEngineManagerSnapshot {
  readonly state: WechatEngineManagerState;
  readonly generation?: string;
  readonly restartAttempt: number;
  readonly restartInMs?: number;
  readonly lastError?: string;
}

export interface WechatWorkerProcess {
  postMessage(message: unknown): void;
  kill(): boolean;
  on(event: 'message', listener: (message: unknown) => void): this;
  once(event: 'exit', listener: (code: number | null) => void): this;
  once(event: 'error', listener: (error: Error) => void): this;
}

export type WechatWorkerSpawn = (generation: string) => WechatWorkerProcess;

export interface WechatEngineManagerOptions {
  readonly spawn: WechatWorkerSpawn;
  readonly requestTimeoutMs?: number;
  readonly engineStartTimeoutMs?: number;
  readonly handshakeTimeoutMs?: number;
  readonly backoffDelaysMs?: readonly number[];
  readonly maxRestartAttempts?: number;
  readonly stableResetMs?: number;
  readonly random?: () => number;
  readonly idFactory?: () => string;
}

interface PendingRequest {
  readonly command: WechatWorkerCommand;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
}

interface ReadyWaiter {
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
}

export class WechatWorkerCommandError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'WechatWorkerCommandError';
  }
}

const defaultBackoffDelays = [1000, 2000, 5000, 10_000, 30_000] as const;

export class WechatEngineManager {
  private readonly spawn: WechatWorkerSpawn;
  private readonly requestTimeoutMs: number;
  private readonly engineStartTimeoutMs: number;
  private readonly handshakeTimeoutMs: number;
  private readonly backoffDelaysMs: readonly number[];
  private readonly maxRestartAttempts: number;
  private readonly stableResetMs: number;
  private readonly random: () => number;
  private readonly idFactory: () => string;
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private readonly stateListeners = new Set<(snapshot: WechatEngineManagerSnapshot) => void>();
  private readonly eventListeners = new Set<(event: WechatWorkerEvent) => void>();
  private readonly readyWaiters = new Set<ReadyWaiter>();

  private child: WechatWorkerProcess | undefined;
  private generation: string | undefined;
  private state: WechatEngineManagerState = 'stopped';
  private shouldRun = false;
  private restartAttempt = 0;
  private restartTimer: ReturnType<typeof setTimeout> | undefined;
  private handshakeTimer: ReturnType<typeof setTimeout> | undefined;
  private stableTimer: ReturnType<typeof setTimeout> | undefined;
  private lastEventSequence = 0;
  private capabilities = new Set<WechatWorkerCommand>();
  private lastError: string | undefined;
  private restartInMs: number | undefined;

  constructor(options: WechatEngineManagerOptions) {
    if (options.backoffDelaysMs?.some((delay) => !Number.isFinite(delay) || delay < 0)) {
      throw new Error('Backoff delays must be finite non-negative numbers');
    }
    this.spawn = options.spawn;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 8000;
    this.engineStartTimeoutMs = options.engineStartTimeoutMs ?? 75_000;
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? 8000;
    this.backoffDelaysMs = options.backoffDelaysMs?.length
      ? [...options.backoffDelaysMs]
      : defaultBackoffDelays;
    this.maxRestartAttempts = options.maxRestartAttempts ?? 5;
    this.stableResetMs = options.stableResetMs ?? 60_000;
    this.random = options.random ?? Math.random;
    this.idFactory = options.idFactory ?? randomUUID;
  }

  getSnapshot(): WechatEngineManagerSnapshot {
    return {
      state: this.state,
      ...(this.generation ? { generation: this.generation } : {}),
      restartAttempt: this.restartAttempt,
      ...(this.restartInMs === undefined ? {} : { restartInMs: this.restartInMs }),
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }

  subscribeState(listener: (snapshot: WechatEngineManagerSnapshot) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  subscribeEvents(listener: (event: WechatWorkerEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  start(): Promise<void> {
    if (this.state === 'ready') return Promise.resolve();

    const ready = new Promise<void>((resolve, reject) => {
      this.readyWaiters.add({ resolve, reject });
    });
    if (!this.shouldRun) {
      this.shouldRun = true;
      this.restartAttempt = 0;
      this.lastError = undefined;
      this.spawnAttempt();
    }
    return ready;
  }

  stop(): void {
    this.shouldRun = false;
    this.clearLifecycleTimers();
    const child = this.child;
    this.child = undefined;
    this.generation = undefined;
    this.capabilities.clear();
    this.rejectPending(new Error('WeChat engine stopped'));
    this.rejectReadyWaiters(new Error('WeChat engine stopped'));
    if (child) child.kill();
    this.transition('stopped');
  }

  request(
    command: WechatWorkerCommand,
    payload: Record<string, unknown>,
    timeoutOverrideMs?: number,
  ): Promise<unknown> {
    const child = this.child;
    const generation = this.generation;
    if (this.state !== 'ready' || !child || !generation) {
      return Promise.reject(new Error('WeChat engine is not ready'));
    }
    if (!this.capabilities.has(command)) {
      return Promise.reject(new Error(`WeChat engine does not support ${command}`));
    }

    const requestId = this.idFactory();
    let request;
    try {
      request = createWechatWorkerRequest(generation, requestId, command, payload);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error('Invalid worker request'));
    }
    const timeoutMs = timeoutOverrideMs
      ?? (command === 'engine.start' ? this.engineStartTimeoutMs : this.requestTimeoutMs);
    if (!Number.isFinite(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) {
      return Promise.reject(new Error('WeChat worker request timeout is invalid'));
    }
    if (command === 'engine.start') this.clearTimer('stable');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`WeChat worker request timed out: ${command}`));
        this.handleTransientFailure(
          child,
          new Error(`WeChat worker request timed out: ${command}`),
        );
      }, timeoutMs);
      this.pendingRequests.set(requestId, { command, timer, resolve, reject });
      try {
        child.postMessage(request);
      } catch (error) {
        clearTimeout(timer);
        this.pendingRequests.delete(requestId);
        const failure = error instanceof Error ? error : new Error('Unable to contact WeChat worker');
        reject(failure);
        this.handleTransientFailure(child, failure);
      }
    });
  }

  private spawnAttempt(): void {
    if (!this.shouldRun) return;
    this.clearTimer('restart');
    const generation = this.idFactory();
    this.generation = generation;
    this.lastEventSequence = 0;
    this.capabilities.clear();
    this.restartInMs = undefined;
    this.transition('starting');

    let child: WechatWorkerProcess;
    try {
      child = this.spawn(generation);
    } catch (error) {
      this.scheduleRestart(error instanceof Error ? error : new Error('Unable to spawn WeChat worker'));
      return;
    }
    this.child = child;
    child.on('message', (message) => this.handleMessage(child, generation, message));
    child.once('error', (error) => this.handleTransientFailure(child, error));
    child.once('exit', (code) => this.handleTransientFailure(
      child,
      new Error(`WeChat worker exited (${code ?? 'unknown'})`),
    ));
    this.handshakeTimer = setTimeout(() => {
      this.handleTransientFailure(child, new Error('WeChat worker handshake timed out'));
    }, this.handshakeTimeoutMs);
  }

  private handleMessage(
    child: WechatWorkerProcess,
    generation: string,
    value: unknown,
  ): void {
    if (child !== this.child || generation !== this.generation) return;
    if (!isWechatWorkerIncomingMessage(value)) {
      this.handleFatal(child, new Error('WeChat worker returned an invalid protocol message'));
      return;
    }
    if (value.generation !== generation) {
      this.handleFatal(child, new Error('WeChat worker generation mismatch'));
      return;
    }

    if (value.kind === 'hello') {
      if (this.state !== 'starting') {
        this.handleFatal(child, new Error('WeChat worker sent an unexpected hello'));
        return;
      }
      this.clearTimer('handshake');
      this.capabilities = new Set(value.capabilities);
      this.lastError = undefined;
      this.transition('ready');
      this.resolveReadyWaiters();
      return;
    }

    if (this.state !== 'ready') {
      this.handleFatal(child, new Error('WeChat worker sent data before the hello handshake'));
      return;
    }

    if (value.kind === 'response') {
      const pending = this.pendingRequests.get(value.requestId);
      if (!pending) {
        this.handleFatal(child, new Error('WeChat worker returned an unknown request ID'));
        return;
      }
      this.pendingRequests.delete(value.requestId);
      clearTimeout(pending.timer);
      if (value.ok) {
        if (pending.command === 'engine.start' && !isWechatEngineStartResult(value.result)) {
          pending.reject(new Error('WeChat worker returned an invalid engine.start result'));
          this.handleFatal(child, new Error('WeChat worker returned an invalid engine.start result'));
          return;
        }
        if (pending.command === 'engine.start') {
          this.clearTimer('stable');
          this.stableTimer = setTimeout(() => {
            this.restartAttempt = 0;
            this.emitState();
          }, this.stableResetMs);
        }
        pending.resolve(value.result);
      } else {
        const workerError = value.error;
        if (!workerError) {
          pending.reject(new Error('WeChat worker response is missing an error'));
          this.handleFatal(child, new Error('WeChat worker response is missing an error'));
          return;
        }
        pending.reject(new WechatWorkerCommandError(
          workerError.code,
          workerError.message,
          workerError.retryable,
        ));
      }
      return;
    }

    if (value.sequence <= this.lastEventSequence) {
      this.handleFatal(child, new Error('WeChat worker event sequence is not monotonic'));
      return;
    }
    this.lastEventSequence = value.sequence;
    for (const listener of this.eventListeners) {
      try {
        listener(value);
      } catch {
        // A UI or persistence listener must not break the native engine lifecycle.
      }
    }
  }

  private handleTransientFailure(child: WechatWorkerProcess, error: Error): void {
    if (child !== this.child) return;
    this.child = undefined;
    this.clearTimer('handshake');
    this.clearTimer('stable');
    child.kill();
    this.rejectPending(error);
    this.scheduleRestart(error);
  }

  private scheduleRestart(error: Error): void {
    this.lastError = error.message;
    if (!this.shouldRun) {
      this.transition('stopped');
      return;
    }
    if (this.restartAttempt >= this.maxRestartAttempts) {
      this.enterFatal(error);
      return;
    }
    const base = this.backoffDelaysMs[Math.min(
      this.restartAttempt,
      this.backoffDelaysMs.length - 1,
    )];
    const jitter = 0.8 + Math.min(1, Math.max(0, this.random())) * 0.4;
    const delay = Math.max(0, Math.round(base * jitter));
    this.restartAttempt += 1;
    this.restartInMs = delay;
    this.transition('backoff');
    this.restartTimer = setTimeout(() => this.spawnAttempt(), delay);
  }

  private handleFatal(child: WechatWorkerProcess, error: Error): void {
    if (child !== this.child) return;
    this.child = undefined;
    child.kill();
    this.enterFatal(error);
  }

  private enterFatal(error: Error): void {
    this.shouldRun = false;
    this.clearLifecycleTimers();
    this.lastError = error.message;
    this.rejectPending(error);
    this.rejectReadyWaiters(error);
    this.transition('fatal');
  }

  private transition(state: WechatEngineManagerState): void {
    this.state = state;
    if (state !== 'backoff') this.restartInMs = undefined;
    this.emitState();
  }

  private emitState(): void {
    const snapshot = this.getSnapshot();
    for (const listener of this.stateListeners) {
      try {
        listener(snapshot);
      } catch {
        // Observers are isolated from the engine lifecycle.
      }
    }
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }

  private resolveReadyWaiters(): void {
    for (const waiter of this.readyWaiters) waiter.resolve();
    this.readyWaiters.clear();
  }

  private rejectReadyWaiters(error: Error): void {
    for (const waiter of this.readyWaiters) waiter.reject(error);
    this.readyWaiters.clear();
  }

  private clearLifecycleTimers(): void {
    this.clearTimer('restart');
    this.clearTimer('handshake');
    this.clearTimer('stable');
  }

  private clearTimer(type: 'restart' | 'handshake' | 'stable'): void {
    const timer = type === 'restart'
      ? this.restartTimer
      : type === 'handshake'
        ? this.handshakeTimer
        : this.stableTimer;
    if (timer) clearTimeout(timer);
    if (type === 'restart') this.restartTimer = undefined;
    if (type === 'handshake') this.handshakeTimer = undefined;
    if (type === 'stable') this.stableTimer = undefined;
  }
}
