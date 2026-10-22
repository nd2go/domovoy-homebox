import { randomUUID } from "node:crypto";
import type { Page, WebSocketRoute } from "@playwright/test";
import { expect, test } from "@playwright/test";
import type { EntityListResult, EntityOut, EntitySummary, EntityTypeSummary } from "../../lib/api/types/data-contracts";

// MOCK API performance scenario: authentication uses the real UI, while the 96
// list/detail fixtures, view preferences and server events are mocked without data writes.
// Service workers must not bypass the request counters or response gates.
test.use({
  serviceWorkers: "block",
  trace: "retain-on-failure",
  viewport: { width: 1280, height: 900 },
});

const CREATED = "2026-01-01T00:00:00Z";
const ZERO_DATE = "0001-01-01T00:00:00Z";

function summary(name: string, entityType: EntityTypeSummary, parent: EntitySummary | null = null): EntitySummary {
  return {
    id: randomUUID(),
    name,
    entityType,
    archived: false,
    assetId: "0",
    createdAt: CREATED,
    updatedAt: CREATED,
    description: "Synthetic mock API performance fixture",
    insured: false,
    itemCount: 0,
    parent,
    purchasePrice: 0,
    quantity: 1,
    soldDate: ZERO_DATE,
    tags: [],
  };
}

function detail(item: EntitySummary, location: EntitySummary): EntityOut {
  return {
    ...item,
    attachments: [],
    children: [],
    fields: [],
    lifetimeWarranty: false,
    location,
    locationId: null,
    manufacturer: "",
    modelNumber: "",
    notes: "",
    purchaseDate: ZERO_DATE,
    purchaseFrom: "",
    serialNumber: "",
    soldNotes: "",
    soldPrice: 0,
    soldTo: "",
    syncChildEntityLocations: false,
    totalPrice: 0,
    warrantyDetails: "",
    warrantyExpires: ZERO_DATE,
  };
}

function hasSessionMarker(page: Page) {
  return page.evaluate(() => document.cookie.split(";").some(cookie => cookie.trim() === "hb.auth.session=true"));
}

async function painted(page: Page) {
  await page.evaluate(
    () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
  );
}

test("MOCK API: 96-row locations load near the viewport with four requests and share expanded-row cache", async ({
  page,
}) => {
  // WebKit's observed cold page setup consumed 21.8s before this multi-phase
  // scenario reached its first search. Keep the shared timeout/retries intact.
  test.slow();
  const unique = randomUUID();
  const eventSockets: WebSocketRoute[] = [];
  // Other real browser scenarios share this demo account and emit mutations.
  // Mock only this file's event stream; the test sends its own mutation below.
  await page.routeWebSocket(
    url => url.pathname === "/api/v1/ws/events",
    socket => {
      eventSockets.push(socket);
    }
  );
  const preferences = {
    language: "en",
    itemDisplayView: "table",
    itemsPerTablePage: 96,
    tableHeaders: [
      { value: "name", enabled: true },
      { value: "location", enabled: true },
      { value: "assetId", enabled: false },
      { value: "quantity", enabled: false },
      { value: "insured", enabled: false },
      { value: "purchasePrice", enabled: false },
      { value: "archived", enabled: false },
      { value: "createdAt", enabled: false },
      { value: "updatedAt", enabled: false },
    ],
  };
  await page.addInitScript(value => {
    localStorage.setItem("homebox/preferences/location", JSON.stringify(value));
  }, preferences);
  await page.goto("/");
  await page.fill("input[type='text']", "demo@example.com");
  await page.fill("input[type='password']", "demodemo");
  const login = page.waitForResponse(
    response => response.url().endsWith("/api/v1/users/login") && response.request().method() === "POST"
  );
  await page.click("button[type='submit']");
  expect((await login).status()).toBe(200);
  await expect(page).toHaveURL("/home");
  await expect(page.getByRole("heading", { name: "Quick Statistics", exact: true })).toBeVisible();
  await expect.poll(() => hasSessionMarker(page)).toBe(true);

  const typesResponse = await page.request.get("/api/v1/entity-types");
  expect(typesResponse.status()).toBe(200);
  const types: EntityTypeSummary[] = await typesResponse.json();
  const locationType = types.find(type => type.isLocation);
  const itemType = types.find(type => !type.isLocation);
  if (!locationType || !itemType) throw new Error("Test account must have both entity types");
  const roomA = summary(`Mock room A ${unique}`, locationType);
  const roomB = summary(`Mock room B ${unique}`, locationType);
  const parent = summary(`Mock parent item ${unique}`, itemType);
  const items = Array.from({ length: 96 }, (_, index) =>
    summary(`Mock item ${String(index).padStart(2, "0")} ${unique}`, itemType, parent)
  );
  const first = items[0]!;
  const last = items.at(-1)!;
  const byID = new Map(items.map(item => [item.id, item]));
  const counts = new Map<string, number>();
  const initialPositions = new Map<string, { top: number; bottom: number; viewportHeight: number } | null>();
  let measureInitialRequests = true;
  let active = 0;
  let maximumActive = 0;
  let firstLocation = roomA;
  let failFirst = false;
  let listRequests = 0;
  let releaseDetails = () => {};
  const detailGate = new Promise<void>(resolve => {
    releaseDetails = resolve;
  });

  // Keep this test's table settings independent of the shared demo account.
  await page.route("**/api/v1/users/self/settings", route =>
    route.fulfill({
      json: route.request().method() === "GET" ? { item: preferences } : {},
    })
  );
  await page.route("**/api/v1/entities?*", route => {
    const url = new URL(route.request().url());
    if (route.request().method() !== "GET" || url.searchParams.get("q") !== unique) return route.continue();
    listRequests += 1;
    expect(url.searchParams.get("pageSize")).toBe("96");
    const result: EntityListResult = {
      items,
      page: 1,
      pageSize: 96,
      total: 96,
      totalPrice: 0,
    };
    return route.fulfill({ json: result });
  });
  await page.route("**/api/v1/entities/*", async route => {
    const id = new URL(route.request().url()).pathname.split("/").at(-1)!;
    const item = byID.get(id);
    if (route.request().method() !== "GET" || !item) return route.continue();
    counts.set(id, (counts.get(id) ?? 0) + 1);
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    try {
      if (measureInitialRequests) {
        // Measure while this request is intercepted and all responses are still
        // gated. Later room names can reflow the table and change row bounds.
        initialPositions.set(
          id,
          await page.evaluate(itemID => {
            const row = document.querySelector(`a[href="/item/${itemID}"]`)?.closest("tr");
            if (!row) return null;
            const box = row.getBoundingClientRect();
            return { top: box.top, bottom: box.bottom, viewportHeight: innerHeight };
          }, id)
        );
      }
      await detailGate;
      await route.fulfill(
        id === first.id && failFirst
          ? {
              status: 503,
              json: { error: "Synthetic mock API detail failure" },
            }
          : { json: detail(item, id === first.id ? firstLocation : roomA) }
      );
    } finally {
      active -= 1;
    }
  });

  const row = (item: EntitySummary) =>
    page.getByRole("row").filter({
      has: page.getByRole("link", { name: item.name, exact: true }),
    });
  const firstRow = row(first);
  const lastRow = row(last);
  try {
    expect(await hasSessionMarker(page)).toBe(true);
    const oldSocketCount = eventSockets.length;
    await page.goto(`/search?q=${unique}`);
    await expect.poll(() => eventSockets.length).toBeGreaterThan(oldSocketCount);
    await expect(page.getByRole("row").filter({ has: page.getByText(/Mock item \d{2}/) })).toHaveCount(96);
    await expect(page.getByRole("columnheader")).toHaveCount(4);
    await expect.poll(() => active).toBe(4);
    await expect.poll(() => initialPositions.size).toBe(4);
    await painted(page);
    expect(maximumActive).toBe(4);
    expect(counts.size).toBe(4);
    for (const [id, position] of initialPositions) {
      expect(position, `Request-time row bounds for ${id}`).not.toBeNull();
      if (position) {
        expect(position.bottom).toBeGreaterThanOrEqual(-200);
        expect(position.top).toBeLessThanOrEqual(position.viewportHeight + 200);
      }
    }

    // A completed first screen must not enqueue all 96 rendered rows. The last
    // offscreen row remains Unknown until the user actually scrolls to it.
    measureInitialRequests = false;
    releaseDetails();
    const nearNames = await page.getByRole("row").evaluateAll(rows =>
      rows.flatMap(row => {
        const name = row.querySelector("td:nth-child(2)")?.textContent?.trim();
        const box = row.getBoundingClientRect();
        return name?.startsWith("Mock item ") && box.bottom > 0 && box.top < innerHeight ? [name] : [];
      })
    );
    expect(nearNames.length).toBeGreaterThan(0);
    for (const name of nearNames) {
      await expect(
        page
          .getByRole("row")
          .filter({ has: page.getByText(name, { exact: true }) })
          .getByRole("link", {
            name: roomA.name,
            exact: true,
          })
      ).toBeVisible();
    }
    await expect.poll(() => active).toBe(0);
    await painted(page);
    expect(maximumActive).toBeLessThanOrEqual(4);
    expect(counts.size).toBeLessThanOrEqual(48);
    expect(counts.has(last.id)).toBe(false);
    await expect(lastRow.getByText("Unknown", { exact: true })).toHaveCount(1);

    await lastRow.scrollIntoViewIfNeeded();
    await expect(lastRow.getByRole("link", { name: roomA.name, exact: true })).toBeVisible();
    expect(counts.get(last.id)).toBe(1);
    expect(maximumActive).toBeLessThanOrEqual(4);
    // Leaving the viewport must retain known content, so it cannot collapse
    // rows or oscillate their intersection state as the user scrolls.
    await expect(firstRow.getByRole("link", { name: roomA.name, exact: true })).toHaveCount(1);
    expect(counts.get(first.id)).toBe(1);

    await firstRow.scrollIntoViewIfNeeded();
    await expect(firstRow.getByRole("link", { name: roomA.name, exact: true })).toBeVisible();
    expect(counts.get(first.id)).toBe(1);
    await firstRow.getByRole("button", { name: "Open menu", exact: true }).click();
    await page.getByRole("menuitem", { name: "Toggle Expand", exact: true }).click();
    const expanded = page.getByRole("row").filter({
      has: page.getByRole("heading", { name: first.name, exact: true }),
    });
    await expect(expanded.getByRole("link", { name: roomA.name, exact: true })).toBeVisible();
    await painted(page);
    expect(counts.get(first.id)).toBe(1);

    // A parent move can change an inherited location without changing the
    // child's updatedAt. New list responses must invalidate both cached views.
    firstLocation = roomB;
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await expect(firstRow.getByRole("link", { name: roomB.name, exact: true })).toBeVisible();
    await expect(expanded.getByRole("link", { name: roomB.name, exact: true })).toBeVisible();
    expect(counts.get(first.id)).toBe(2);

    // A later failed read must display Unknown rather than the cached room.
    failFirst = true;
    const failed = page.waitForResponse(
      response => response.url().endsWith(`/api/v1/entities/${first.id}`) && response.status() === 503
    );
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await (await failed).finished();
    await painted(page);
    await expect(firstRow.getByText("Unknown", { exact: true })).toHaveCount(1);
    await expect(expanded.getByText("Unknown", { exact: true })).toHaveCount(1);
    await expect(firstRow.getByRole("link", { name: roomB.name, exact: true })).toHaveCount(0);
    expect(counts.get(first.id)).toBe(3);
    expect(maximumActive).toBeLessThanOrEqual(4);

    // MOCK server event: refresh inherited details without a new search/list
    // response or a changed child revision, as when the parent moves again.
    failFirst = false;
    firstLocation = roomA;
    const listsBeforeEvent = listRequests;
    eventSockets.at(-1)!.send(JSON.stringify({ event: "entity.mutation" }));
    await expect(firstRow.getByRole("link", { name: roomA.name, exact: true })).toBeVisible();
    await expect(expanded.getByRole("link", { name: roomA.name, exact: true })).toBeVisible();
    expect(counts.get(first.id)).toBe(4);
    expect(listRequests).toBe(listsBeforeEvent);
    expect(first.updatedAt).toBe(CREATED);
    expect(maximumActive).toBeLessThanOrEqual(4);
  } finally {
    releaseDetails();
    if (!page.isClosed()) await page.unrouteAll({ behavior: "ignoreErrors" });
  }
});
