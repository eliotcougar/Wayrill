import { serviceCall } from './serviceClient';

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
