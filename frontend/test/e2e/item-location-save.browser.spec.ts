import { randomUUID } from "node:crypto";
import type { APIRequestContext, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import type { EntityCreate, EntityOut, EntityTypeSummary } from "../../lib/api/types/data-contracts";

test.use({ serviceWorkers: "block", trace: "retain-on-failure" });

async function createEntity(request: APIRequestContext, body: EntityCreate): Promise<EntityOut> {
  const response = await request.post("/api/v1/entities", { data: body });
  expect(response.status()).toBe(201);
  return response.json();
}

async function getEntity(request: APIRequestContext, id: string): Promise<EntityOut> {
  const response = await request.get(`/api/v1/entities/${id}`);
  expect(response.status()).toBe(200);
  return response.json();
}

async function openLocationChange(page: Page, itemName: string) {
  const row = page.getByRole("row").filter({ has: page.getByText(itemName, { exact: true }) });
  await row.getByRole("button", { name: "Open menu", exact: true }).click();
  await page.getByRole("menuitem", { name: "Change Location", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Change Item Details", exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

test("location saves retain nested parents and a submitted batch cannot be dismissed halfway", async ({ page }) => {
  test.slow();
  const unique = randomUUID();
  await page.addInitScript(() => {
    localStorage.setItem(
      "homebox/preferences/location",
      JSON.stringify({
        language: "en",
        itemDisplayView: "table",
        tableHeaders: [
          { value: "name", enabled: true },
          { value: "location", enabled: true },
        ],
      })
    );
  });
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
  await expect
    .poll(() =>
      page.evaluate(() => document.cookie.split(";").some(cookie => cookie.trim() === "hb.auth.session=true"))
    )
    .toBe(true);

  const typesResponse = await page.request.get("/api/v1/entity-types");
  expect(typesResponse.status()).toBe(200);
  const types: EntityTypeSummary[] = await typesResponse.json();
  const locationType = types.find(type => type.isLocation);
  const itemType = types.find(type => !type.isLocation);
  if (!locationType || !itemType) throw new Error("Test account must have both entity types");
  const base = { description: "Synthetic location save regression", quantity: 1, tagIds: [] };
  const roomA = await createEntity(page.request, {
    ...base,
    name: `Room A ${unique}`,
    entityTypeId: locationType.id,
  });
  const roomB = await createEntity(page.request, {
    ...base,
    name: `Room B ${unique}`,
    entityTypeId: locationType.id,
  });
  const box = await createEntity(page.request, {
    ...base,
    name: `Parent ${unique}`,
    entityTypeId: itemType.id,
    parentId: roomA.id,
  });
  const first = await createEntity(page.request, {
    ...base,
    name: `Nested one ${unique}`,
    entityTypeId: itemType.id,
    parentId: box.id,
  });
  const second = await createEntity(page.request, {
    ...base,
    name: `Nested two ${unique}`,
    entityTypeId: itemType.id,
    parentId: box.id,
  });
  const direct = await createEntity(page.request, {
    ...base,
    name: `Direct ${unique}`,
    entityTypeId: itemType.id,
    parentId: roomA.id,
    locationId: roomA.id,
  });

  expect(
    await page.evaluate(() => document.cookie.split(";").some(cookie => cookie.trim() === "hb.auth.session=true"))
  ).toBe(true);
  await page.goto(`/search?q=${unique}`);
  const unchangedDialog = await openLocationChange(page, first.name);
  await expect(unchangedDialog.getByRole("combobox", { name: "Parent Location", exact: true })).toContainText(
    roomA.name
  );
  // A normal settings refresh replaces preferences without changing collection/session.
  // It must not be treated as leaving the dialog's context.
  const settingsURL = "/api/v1/users/self/settings";
  const settingsResponse = await page.request.get(settingsURL);
  expect(settingsResponse.status()).toBe(200);
  const settings: { item: Record<string, unknown> } = await settingsResponse.json();
  const settingsRefresh = page.waitForResponse(
    response => response.url().endsWith(settingsURL) && response.request().method() === "GET"
  );
  const settingsSaved = await page.request.put(settingsURL, { data: settings.item });
  expect(settingsSaved.status()).toBe(200);
  const refreshed = await settingsRefresh;
  expect(refreshed.status()).toBe(200);
  await refreshed.finished();
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
  await expect(unchangedDialog).toBeVisible();
  await expect(unchangedDialog.getByRole("combobox", { name: "Parent Location", exact: true })).toContainText(
    roomA.name
  );
  const unchanged = page.waitForResponse(
    response => response.url().endsWith(`/api/v1/entities/${first.id}`) && response.request().method() === "PATCH"
  );
  await unchangedDialog.getByRole("button", { name: "Save", exact: true }).click();
  const unchangedResponse = await unchanged;
  expect(unchangedResponse.status()).toBe(200);
  expect(unchangedResponse.request().postDataJSON()).not.toHaveProperty("parentId");
  expect(unchangedResponse.request().postDataJSON()).not.toHaveProperty("locationId");
  await expect(unchangedDialog).toBeHidden();
  const inherited = await getEntity(page.request, first.id);
  expect(inherited.parent?.id).toBe(box.id);
  expect(inherited.locationId ?? null).toBeNull();
  expect(inherited.location?.id).toBe(roomA.id);

  const changedDialog = await openLocationChange(page, first.name);
  const location = changedDialog.getByRole("combobox", { name: "Parent Location", exact: true });
  await expect(location).toContainText(roomA.name);
  await location.click();
  await page.getByRole("option", { name: roomB.name, exact: true }).click();
  const changed = page.waitForResponse(
    response => response.url().endsWith(`/api/v1/entities/${first.id}`) && response.request().method() === "PATCH"
  );
  await changedDialog.getByRole("button", { name: "Save", exact: true }).click();
  const changedResponse = await changed;
  expect(changedResponse.status()).toBe(200);
  expect(changedResponse.request().postDataJSON()).toMatchObject({ locationId: roomB.id });
  expect(changedResponse.request().postDataJSON()).not.toHaveProperty("parentId");
  await expect(changedDialog).toBeHidden();
  const moved = await getEntity(page.request, first.id);
  expect(moved.parent?.id).toBe(box.id);
  expect(moved.locationId).toBe(roomB.id);
  expect(moved.location?.id).toBe(roomB.id);

  // Direct location parents use the API's parent move and keep locationId clear.
  const directDialog = await openLocationChange(page, direct.name);
  const directLocation = directDialog.getByRole("combobox", { name: "Parent Location", exact: true });
  await expect(directLocation).toContainText(roomA.name);
  await directLocation.click();
  await page.getByRole("option", { name: roomB.name, exact: true }).click();
  const directSaved = page.waitForResponse(
    response => response.url().endsWith(`/api/v1/entities/${direct.id}`) && response.request().method() === "PATCH"
  );
  await directDialog.getByRole("button", { name: "Save", exact: true }).click();
  const directResponse = await directSaved;
  expect(directResponse.status()).toBe(200);
  expect(directResponse.request().postDataJSON()).toMatchObject({ parentId: roomB.id });
  expect(directResponse.request().postDataJSON()).not.toHaveProperty("locationId");
  await expect(directDialog).toBeHidden();
  const directMoved = await getEntity(page.request, direct.id);
  expect(directMoved.parent?.id).toBe(roomB.id);
  expect(directMoved.locationId ?? null).toBeNull();
  expect(directMoved.location?.id).toBe(roomB.id);

  for (const item of [first, second]) {
    await page
      .getByRole("row")
      .filter({ has: page.getByText(item.name, { exact: true }) })
      .getByRole("checkbox")
      .click();
  }
  await page.getByRole("columnheader").getByRole("button", { name: "Open menu", exact: true }).click();
  await page.getByRole("menuitem", { name: "Change Location", exact: true }).click();
  const batchDialog = page.getByRole("dialog", { name: "Change Item Details", exact: true });
  const batchLocation = batchDialog.getByRole("combobox", { name: "Parent Location", exact: true });
  await expect(batchLocation).toContainText("Select a Location");
  await batchLocation.click();
  await page.getByRole("option", { name: roomB.name, exact: true }).click();
  await expect(batchDialog.getByRole("button", { name: "Save", exact: true })).toBeEnabled();

  let releaseFirst = () => {};
  let firstWritten = () => {};
  const gate = new Promise<void>(resolve => {
    releaseFirst = resolve;
  });
  const firstWrite = new Promise<void>(resolve => {
    firstWritten = resolve;
  });
  const batchIds = [first.id, second.id];
  const requests: string[] = [];
  await page.route("**/api/v1/entities/*", async route => {
    const id = route.request().url().split("/").at(-1)!;
    if (route.request().method() !== "PATCH" || !batchIds.includes(id)) return route.continue();
    requests.push(id);
    const response = await route.fetch();
    if (requests.length === 1) {
      firstWritten();
      await gate;
    }
    await route.fulfill({ response });
  });
  const savedBatch = Promise.all(
    batchIds.map(id =>
      page.waitForResponse(
        response => response.url().endsWith(`/api/v1/entities/${id}`) && response.request().method() === "PATCH"
      )
    )
  );
  try {
    await batchDialog.getByRole("button", { name: "Save", exact: true }).click();
    await firstWrite;
    await expect(batchDialog.locator("button[type='submit']")).toBeDisabled();
    await expect(batchDialog.getByRole("button", { name: "Close", exact: true })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(batchDialog).toBeVisible();
    await page.mouse.click(1, 1);
    await expect(batchDialog).toBeVisible();
  } finally {
    releaseFirst();
  }
  for (const response of await savedBatch) expect(response.status()).toBe(200);
  await expect(batchDialog).toBeHidden();
  expect(requests).toHaveLength(2);
  expect(new Set(requests)).toEqual(new Set(batchIds));
  for (const id of batchIds) {
    const item = await getEntity(page.request, id);
    expect(item.parent?.id).toBe(box.id);
    expect(item.locationId).toBe(roomB.id);
    expect(item.location?.id).toBe(roomB.id);
  }
});
