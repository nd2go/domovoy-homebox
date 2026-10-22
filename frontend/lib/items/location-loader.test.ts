import { describe, expect, test } from "vitest";
import { createItemLocationLoader } from "./location-loader";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(complete => {
    resolve = complete;
  });
  return { promise, resolve };
}

const revision = "2026-10-22T12:00:00Z";

describe("table location requests", () => {
  test("starts at most four requests and advances the queue as responses finish", async () => {
    const gates = Array.from({ length: 6 }, () => deferred<{ id: string }>());
    const started: string[] = [];
    let active = 0;
    let maximum = 0;
    const loader = createItemLocationLoader(async id => {
      started.push(id);
      maximum = Math.max(maximum, ++active);
      const location = await gates[Number(id)]!.promise;
      active--;
      return location;
    });
    const requests = gates.map((_, index) => loader.load(String(index), revision));
    expect(started).toEqual(["0", "1", "2", "3"]);

    gates[0]!.resolve({ id: "room-0" });
    await requests[0];
    expect(started).toEqual(["0", "1", "2", "3", "4"]);
    gates.forEach((gate, index) => gate.resolve({ id: `room-${index}` }));
    await expect(Promise.all(requests)).resolves.toHaveLength(6);
    expect(maximum).toBe(4);
  });

  test("a table cell and expanded row share pending and completed item revisions", async () => {
    const gate = deferred<{ id: string }>();
    let requests = 0;
    const loader = createItemLocationLoader(async () => {
      requests++;
      return gate.promise;
    });
    const cell = loader.load("item", revision);
    expect(loader.load("item", new Date(revision))).toBe(cell);
    gate.resolve({ id: "room" });
    await expect(cell).resolves.toEqual({ id: "room" });
    expect(loader.load("item", revision)).toBe(cell);
    expect(requests).toBe(1);

    await loader.load("item", "2026-10-22T12:00:01Z");
    expect(requests).toBe(2);
  });

  test("failed requests remain unknown until fresh data allows another lookup", async () => {
    let requests = 0;
    let failing = true;
    const loader = createItemLocationLoader(async () => {
      requests++;
      if (failing) throw new Error("detail unavailable");
      return { id: "room" };
    });
    await expect(loader.load("item", revision)).resolves.toBeNull();
    await expect(loader.load("item", revision)).resolves.toBeNull();
    expect(requests).toBe(1);

    failing = false;
    loader.invalidate();
    await expect(loader.load("item", revision)).resolves.toEqual({ id: "room" });
    expect(requests).toBe(2);
  });

  test("a context change drops queued work and discards the old in-flight response", async () => {
    const previous = deferred<{ id: string }>();
    const started: string[] = [];
    const loader = createItemLocationLoader(async id => {
      started.push(id);
      return id === "previous" ? previous.promise : { id: "current-room" };
    }, 1);
    const pending = loader.load("previous", revision);
    const queued = loader.load("cancelled", revision);
    loader.invalidate();
    const current = loader.load("current", revision);
    await expect(queued).resolves.toBeNull();
    expect(started).toEqual(["previous"]);

    previous.resolve({ id: "previous-tenant-room" });
    await expect(pending).resolves.toBeNull();
    await expect(current).resolves.toEqual({ id: "current-room" });
    expect(started).toEqual(["previous", "current"]);
  });

  test("a fresh list response invalidates an inherited location even without a child revision change", async () => {
    let room = { id: "before-parent-move" };
    let requests = 0;
    const loader = createItemLocationLoader(async () => {
      requests++;
      return room;
    });
    await expect(loader.load("child", revision)).resolves.toEqual(room);
    room = { id: "after-parent-move" };
    loader.invalidate();
    await expect(loader.load("child", revision)).resolves.toEqual(room);
    expect(requests).toBe(2);
  });

  test("unmounting cancels queued lookups and prevents any result or new request", async () => {
    const gate = deferred<{ id: string }>();
    let requests = 0;
    const loader = createItemLocationLoader(async () => {
      requests++;
      return gate.promise;
    }, 1);
    const running = loader.load("running", revision);
    const queued = loader.load("queued", revision);
    loader.dispose();
    await expect(queued).resolves.toBeNull();
    await expect(loader.load("after-unmount", revision)).resolves.toBeNull();
    gate.resolve({ id: "stale-room" });
    await expect(running).resolves.toBeNull();
    expect(requests).toBe(1);
  });
});
