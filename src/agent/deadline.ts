// Timeouts that are guaranteed to fire.
//
// Why not AbortSignal.any([parent, AbortSignal.timeout(ms)])? A signal created by any() is held
// only weakly by its sources. If the pending work is reachable solely through the signal's own
// abort listener (e.g. a hung provider call), the whole cycle can be garbage-collected and the
// timeout never fires — observed in this repo's tests. Here the timer holds a strong reference.

export class DeadlineError extends Error {
  constructor(readonly ms: number) {
    super(`Timed out after ${ms} ms`);
    this.name = "DeadlineError";
  }
}

export interface Deadline {
  signal: AbortSignal;
  /** Stops the timer and detaches from the parent. Call when the work finishes. */
  clear(): void;
}

export function createDeadline(ms: number, parent?: AbortSignal): Deadline {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DeadlineError(ms)), ms);
  const onParentAbort = () => controller.abort(parent?.reason);
  if (parent?.aborted) controller.abort(parent.reason);
  else parent?.addEventListener("abort", onParentAbort, { once: true });
  return {
    signal: controller.signal,
    clear() {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onParentAbort);
    },
  };
}

/** Rejects as soon as `signal` aborts, even if `work` ignores the signal. */
export function raceAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}
