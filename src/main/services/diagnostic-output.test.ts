import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createDiagnosticReporter } from './diagnostic-output';

describe('diagnostic output when a terminal closes', () => {
  it('writes JSON records while the pipe is available', () => {
    const chunks: string[] = [];
    const output = new Writable({ write(chunk, _encoding, done) { chunks.push(chunk.toString()); done(); } });
    createDiagnosticReporter(output)({ connected: true });
    expect(chunks).toEqual(['{"connected":true}\n']);
  });

  it('handles an asynchronous EPIPE without an uncaught error or subsequent writes', async () => {
    let writes = 0;
    const output = new Writable({ write(_chunk, _encoding, done) {
      writes++;
      process.nextTick(() => done(Object.assign(new Error('broken pipe'), { code: 'EPIPE' })));
    } });
    const report = createDiagnosticReporter(output);
    report({ phase: 'starting' });
    await new Promise<void>((resolve) => output.once('close', resolve));
    expect(() => report({ phase: 'stopped' })).not.toThrow();
    expect(writes).toBe(1);
  });

  it('does not write to an already ended stream', () => {
    let writes = 0;
    const output = new Writable({ write(_chunk, _encoding, done) { writes++; done(); } });
    output.end();
    createDiagnosticReporter(output)({ phase: 'stopped' });
    expect(writes).toBe(0);
  });
});
