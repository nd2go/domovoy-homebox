import { randomUUID } from "node:crypto";
import type { APIRequestContext, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import type { EntityCreate, EntityOut, EntityTypeSummary } from "../../lib/api/types/data-contracts";

test.use({ trace: "retain-on-failure" });

async function createEntity(request: APIRequestContext, body: EntityCreate): Promise<EntityOut> {
  const response = await request.post("/api/v1/entities", { data: body });
  expect(response.status()).toBe(201);
  return response.json();
}

function hasSessionMarker(page: Page) {
  return page.evaluate(() => document.cookie.split(";").some(cookie => cookie.trim() === "hb.auth.session=true"));
}

test("syncing child locations leaves an edited entity type pending until Save is confirmed", async ({ page }) => {
  test.slow();
  const unique = randomUUID();
  await page.addInitScript(() => {
    localStorage.setItem("homebox/preferences/location", JSON.stringify({ language: "en" }));
  });
  await page.goto("/");
  await page.fill("input[type='text']", "demo@example.com");
  await page.fill("input[type='password']", "demodemo");
  const loginResponse = page.waitForResponse(
    response => response.url().endsWith("/api/v1/users/login") && response.request().method() === "POST"
  );
  await page.click("button[type='submit']");
  expect((await loginResponse).status()).toBe(200);
  await expect(page).toHaveURL("/home");
  await expect(page.getByRole("heading", { name: "Quick Statistics", exact: true })).toBeVisible();
  await expect.poll(() => hasSessionMarker(page)).toBe(true);

  const typesResponse = await page.request.get("/api/v1/entity-types");
  expect(typesResponse.ok()).toBe(true);
  const types: EntityTypeSummary[] = await typesResponse.json();
  const locationType = types.find(type => type.isLocation);
  const itemType = types.find(type => !type.isLocation);
  if (!locationType || !itemType) throw new Error("Test account must have both location and item entity types");

  const room = await createEntity(page.request, {
    entityTypeId: locationType.id,
    name: `Type confirmation room ${unique}`,
    description: "Synthetic browser location",
    quantity: 1,
    tagIds: [],
  });
  const item = await createEntity(page.request, {
    entityTypeId: itemType.id,
    name: `Type confirmation item ${unique}`,
    parentId: room.id,
    description: "Synthetic browser item",
    quantity: 1,
    tagIds: [],
  });

  const entityURL = `/api/v1/entities/${item.id}`;
  const writes: string[] = [];
  page.on("request", request => {
    if (request.url().endsWith(entityURL) && ["PUT", "PATCH"].includes(request.method())) {
      writes.push(request.method());
    }
  });
  expect(await hasSessionMarker(page)).toBe(true);
  await page.goto(`/item/${item.id}/edit`);

  const entityType = page.getByText("Entity Type", { exact: true }).locator("..").getByRole("combobox");
  await entityType.click();
  await page.getByRole("option", { name: locationType.name, exact: true }).click();
  await expect(entityType).toContainText(locationType.name);

  const syncToggle = page.getByText("Sync child items' locations", { exact: true }).locator("..").getByRole("switch");
  const toggledValue = !item.syncChildEntityLocations;
  const syncedResponse = page.waitForResponse(
    response => response.url().endsWith(entityURL) && response.request().method() === "PUT"
  );
  await syncToggle.click();
  const synced = await syncedResponse;
  expect(synced.status()).toBe(200);
  expect(synced.request().postDataJSON()).toMatchObject({
    entityTypeId: itemType.id,
    syncChildEntityLocations: toggledValue,
  });

  const afterToggle = await page.request.get(entityURL);
  expect(afterToggle.ok()).toBe(true);
  const stored: EntityOut = await afterToggle.json();
  expect(stored.entityType?.id).toBe(itemType.id);
  expect(stored.syncChildEntityLocations).toBe(toggledValue);
  await expect(page).toHaveURL(`/item/${item.id}/edit`);
  await expect(entityType).toContainText(locationType.name);

  await page.getByRole("button", { name: "Save", exact: true }).click();
  const confirmation = page.getByRole("alertdialog", { name: "Confirm", exact: true });
  await expect(confirmation).toContainText("Changing the entity type may cause loss of data");
  await confirmation.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(confirmation).toBeHidden();
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeEnabled();

  const afterCancel = await page.request.get(entityURL);
  expect(afterCancel.ok()).toBe(true);
  const unchanged: EntityOut = await afterCancel.json();
  expect(unchanged.entityType?.id).toBe(itemType.id);
  expect(unchanged.syncChildEntityLocations).toBe(toggledValue);
  expect(writes).toEqual(["PUT"]);
  await expect(page).toHaveURL(`/item/${item.id}/edit`);
});
