import type { Writable } from 'node:stream';

/** Diagnostics may outlive the terminal that launched them. Never open an error dialog for a closed log pipe. */
export function createDiagnosticReporter(output: Writable): (report: Record<string, unknown>) => void {
  let unavailable = output.destroyed || output.writableEnded;
  output.on('error', () => { unavailable = true; });
  output.on('close', () => { unavailable = true; });
  return (report) => {
    if (unavailable || output.destroyed || output.writableEnded) return;
    const line = JSON.stringify(report) + '\n';
    try {
      output.write(line, (error) => { if (error) unavailable = true; });
    } catch {
      unavailable = true;
    }
  };
}
