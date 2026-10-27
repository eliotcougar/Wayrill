import { serviceCall } from './serviceClient';
import type { TestTarget } from './outboundTestPlan';

/** Reserve space for the request envelope inside the service's 16 MiB frame. */
export function testBatches(targets: TestTarget[]): TestTarget[][] {
  const batches: TestTarget[][] = [];
  let part: TestTarget[] = [],
    bytes = 0;
  const encoder = new TextEncoder();
  for (const target of targets) {
    const size = encoder.encode(JSON.stringify(target)).length;
    if (size > 15 * 1024 * 1024) throw new Error('Test configuration is too large.');
    if (part.length === 8 || bytes + size > 15 * 1024 * 1024) {
      batches.push(part);
      part = [];
      bytes = 0;
    }
    part.push(target);
    bytes += size;
  }
  if (part.length) batches.push(part);
  return batches;
}

/** Cancellation acknowledges the request before its restricted cores finish. */
export async function drainTestJob(id: number) {
  try {
    let job = await serviceCall<{ busy: boolean }>('outbounds.testCancel', { job: id });
    const deadline = performance.now() + 30000;
    while (job.busy && performance.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 200));
      job = await serviceCall<{ busy: boolean }>('outbounds.testGet', { job: id });
    }
  } catch {
    // Service loss/replacement also invalidates this job. Preserve the original
    // operation error rather than replacing it with a cleanup failure.
  }
}
