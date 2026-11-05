import type {Duplex} from 'node:stream';

/** Test-only transport pause. Forward the original frame and write callback,
 * preserving the exact binding bytes instead of rebuilding a START message. */
export function holdLinuxFixtureStart(control: Duplex, reached: () => void, resume: Promise<void>): void {
  const write = control.write.bind(control);
  control.write = ((...args: Parameters<typeof control.write>) => {
    let start = false;
    try {
      const frame = JSON.parse(String(args[0])) as {type?: unknown; version?: unknown};
      start = frame?.type === 'START' && frame.version === 1;
    } catch { /* Plain SEAL/TERM and malformed input are forwarded unchanged. */ }
    if (!start) return write(...args);
    reached();
    void resume.then(() => {if (!control.destroyed) write(...args);});
    return true;
  }) as typeof control.write;
}
