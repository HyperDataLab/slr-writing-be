/**
 * Lets at most `limit` pieces of work run at once; the rest wait their turn in the order they asked.
 * Used so a burst of requests cannot send a burst of calls to a service that charges per call.
 */
export class Semaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('A semaphore needs a limit of at least 1');
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((resolve) => this.waiting.push(resolve));
    else this.active += 1;
    try {
      return await work();
    } finally {
      const next = this.waiting.shift();
      // Hand the place straight to the next one in line; the count of active work stays the same.
      if (next) next();
      else this.active -= 1;
    }
  }

  get running(): number { return this.active; }
  get queued(): number { return this.waiting.length; }
}
