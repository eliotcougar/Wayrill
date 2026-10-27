import type { EdgeGeometry } from './edgeGeometry';
import type { EdgePath, NodeBounds } from './edgePaths';
export type RoutingGeometry = { edges: EdgeGeometry[]; nodes: NodeBounds[] };
type Job = {
  id: number;
  geometry: RoutingGeometry;
  complete: (paths: ReadonlyMap<string, EdgePath>, error: string) => void;
};

/** One running layout plus the newest pending layout; stale drag positions cannot accumulate work. */
export class EdgeRoutingClient {
  private worker?: Worker;
  private running?: Job;
  private latest?: Job;
  private timer?: ReturnType<typeof setTimeout>;
  private deadline?: ReturnType<typeof setTimeout>;
  private sequence = 0;
  private transactions = 0;
  constructor(
    private createWorker = () =>
      new Worker(new URL('./edgeRouting.worker.ts', import.meta.url), { type: 'module' }),
    private timeout = 4000,
  ) {}
  request(geometry: RoutingGeometry, complete: Job['complete']) {
    this.latest = { id: ++this.sequence, geometry, complete };
    // A trailing debounce starves the router during an uninterrupted drag.
    // Sample the newest geometry once per frame; a running job owns one latest slot.
    if (!this.running && !this.timer)
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.dispatch();
      }, 16);
  }
  private release() {
    if (this.worker) {
      this.worker.onmessage = null;
      this.worker.onerror = null;
      this.worker.onmessageerror = null;
      this.worker.terminate();
    }
    this.worker = undefined;
    this.transactions = 0;
    clearTimeout(this.deadline);
  }
  private fail(message: string) {
    const job = this.running;
    this.running = undefined;
    this.release();
    job?.complete(new Map(), message);
    this.dispatch();
  }
  private dispatch() {
    if (this.running || !this.latest) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    const job = this.latest;
    this.latest = undefined;
    this.running = job;
    try {
      if (!this.worker) {
        this.worker = this.createWorker();
        this.worker.onmessage = (
          event: MessageEvent<{ id: number; paths?: [string, EdgePath][]; error?: string }>,
        ) => {
          if (event.data.id !== this.running?.id) return;
          const finished = this.running;
          this.running = undefined;
          clearTimeout(this.deadline);
          if (event.data.error) this.release();
          finished.complete(new Map(event.data.paths ?? []), event.data.error ?? '');
          // Retire the entire WASM heap periodically, including allocator high-water marks.
          if (++this.transactions >= 32) this.release();
          this.dispatch();
        };
        this.worker.onerror = (event) => {
          event.preventDefault();
          this.fail('Connection layout failed. Move overlapping nodes or retry.');
        };
        this.worker.onmessageerror = () =>
          this.fail('Connection layout returned unreadable data. Retry layout.');
      }
      this.deadline = setTimeout(
        () => this.fail('Connection layout timed out. Spread the nodes or retry.'),
        this.timeout,
      );
      this.worker.postMessage({ id: job.id, ...job.geometry });
    } catch {
      this.fail('Connection layout could not start. Retry layout.');
    }
  }
  dispose() {
    clearTimeout(this.timer);
    this.release();
    this.running = undefined;
    this.latest = undefined;
  }
}
