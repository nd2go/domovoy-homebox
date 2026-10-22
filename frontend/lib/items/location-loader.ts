export type ItemRevision = string | Date;

type PendingLocation<T> = {
  id: string;
  generation: number;
  resolve: (location: T | null) => void;
};

/** One table owns this queue and discards it when its data or context changes. */
export function createItemLocationLoader<T>(fetchLocation: (id: string) => Promise<T | null>, concurrency = 4) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) {
    throw new RangeError("Location request concurrency must be between one and four");
  }

  const entries = new Map<string, Promise<T | null>>();
  const queue: PendingLocation<T>[] = [];
  let generation = 0;
  let active = 0;
  let disposed = false;

  async function run(entry: PendingLocation<T>) {
    active++;
    try {
      const location = await fetchLocation(entry.id);
      entry.resolve(entry.generation === generation && !disposed ? location : null);
    } catch {
      entry.resolve(null);
    } finally {
      active--;
      drain();
    }
  }

  function drain() {
    while (!disposed && active < concurrency && queue.length) {
      const entry = queue.shift();
      if (entry) void run(entry);
    }
  }

  function load(id: string, revision: ItemRevision): Promise<T | null> {
    if (disposed) return Promise.resolve(null);
    const timestamp = revision instanceof Date ? revision.getTime() : Date.parse(revision);
    const key = JSON.stringify([id, Number.isNaN(timestamp) ? String(revision) : timestamp]);
    const existing = entries.get(key);
    if (existing) return existing;

    const promise = new Promise<T | null>(resolve => {
      queue.push({ id, generation, resolve });
    });
    entries.set(key, promise);
    drain();
    return promise;
  }

  function invalidate() {
    generation++;
    entries.clear();
    for (const entry of queue.splice(0)) entry.resolve(null);
  }

  function dispose() {
    disposed = true;
    invalidate();
  }

  return { load, invalidate, dispose };
}
