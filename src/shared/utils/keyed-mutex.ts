/**
 * Runs functions that share a key one after another, in the order they asked, inside this process.
 *
 * Why it exists: writers of one snapshot also take a database lock, but a request waiting on that lock holds a database
 * connection. A burst of requests for one snapshot would hold every connection of the pool while they wait, and any other
 * request, for any other snapshot, would have to wait for a free connection too. Queuing in memory first means only one
 * request per key reaches the database at a time, and the others wait without holding anything. The database lock stays,
 * for several instances of the server.
 */
const tails = new Map<string, Promise<void>>();

export async function runExclusive<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = tails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => mine);
  tails.set(key, tail);

  await previous;
  try {
    return await work();
  } finally {
    release();
    // Forget the key when nobody queued behind us, so the map does not grow with every snapshot ever written.
    if (tails.get(key) === tail) tails.delete(key);
  }
}

/** Keys with a running or queued function. For tests. */
export const activeKeys = (): number => tails.size;
