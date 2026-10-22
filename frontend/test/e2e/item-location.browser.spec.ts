import { randomUUID } from "node:crypto";
import type { APIRequestContext, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import type { EntityCreate, EntityOut, EntityTypeSummary } from "../../lib/api/types/data-contracts";

// Keep real UI login and the server-set HttpOnly cookies. This local harness
// uses explicit cookie domains, which WebKit drops for the localhost hostname.
const baseURL = new URL(process.env.E2E_BASE_URL || "http://localhost:3000");
if (baseURL.hostname === "localhost") baseURL.hostname = "127.0.0.1";
test.use({ baseURL: baseURL.href });

async function createEntity(request: APIRequestContext, body: EntityCreate): Promise<EntityOut> {
  const response = await request.post("/api/v1/entities", { data: body });
  expect(response.status()).toBe(201);
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

test("nested creation inherits the parent location and location dialogs never reuse stale guesses", async ({
  page,
}) => {
  test.slow();
  const unique = randomUUID();
  // Reuse the harness's seeded account, as login.browser.spec.ts does. Unique
  // record names isolate parallel browser projects without registration bursts.
  const email = "demo@example.com";
  const password = "demodemo";

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
  await page.fill("input[type='text']", email);
  await page.fill("input[type='password']", password);
  await page.click("button[type='submit']");
  await expect(page).toHaveURL("/home");

  const typesResponse = await page.request.get("/api/v1/entity-types");
  expect(typesResponse.ok()).toBe(true);
  const types: EntityTypeSummary[] = await typesResponse.json();
  const locationType = types.find(type => type.isLocation);
  const itemType = types.find(type => !type.isLocation);
  if (!locationType || !itemType) throw new Error("Test account must have both location and item entity types");

  const roomA = await createEntity(page.request, {
    entityTypeId: locationType.id,
    name: `Room A ${unique}`,
    description: "Synthetic browser location",
    quantity: 1,
    tagIds: [],
  });
  const roomB = await createEntity(page.request, {
    entityTypeId: locationType.id,
    name: `Room B ${unique}`,
    description: "Synthetic browser location",
    quantity: 1,
    tagIds: [],
  });
  const box = await createEntity(page.request, {
    entityTypeId: itemType.id,
    name: `Parent box ${unique}`,
    parentId: roomA.id,
    description: "Synthetic parent item, not a physical location",
    quantity: 1,
    tagIds: [],
  });

  // Create through the visible flow, then independently inspect the submitted
  // parent/location fields and the backend's resolved location.
  await page.goto(`/item/${box.id}`);
  await page.getByRole("button", { name: "Create Subitem", exact: true }).click();
  const createDialog = page.getByRole("dialog");
  await expect(createDialog.getByRole("combobox", { name: "Parent Location", exact: true })).toContainText(roomA.name);
  await expect(createDialog.getByRole("combobox", { name: "Parent Item", exact: true })).toContainText(box.name);
  const childName = `Inherited child ${unique}`;
  await createDialog.getByRole("textbox", { name: /Item Name/ }).fill(childName);
  const createdResponse = page.waitForResponse(
    response => response.url().endsWith("/api/v1/entities") && response.request().method() === "POST"
  );
  await createDialog.getByRole("button", { name: "Create", exact: true }).click();
  const created = await createdResponse;
  expect(created.status()).toBe(201);
  expect(created.request().postDataJSON()).toMatchObject({ parentId: box.id, locationId: null });
  const child: EntityOut = await created.json();
  expect(child.parent?.id).toBe(box.id);
  expect(child.location?.id).toBe(roomA.id);
  expect(child.locationId ?? null).toBeNull();
  await expect(page).toHaveURL(`/item/${child.id}`);

  const explicit = await createEntity(page.request, {
    entityTypeId: itemType.id,
    name: `Explicit child ${unique}`,
    parentId: box.id,
    locationId: roomB.id,
    description: "Synthetic explicit location distinct from the parent",
    quantity: 1,
    tagIds: [],
  });
  expect(explicit.parent?.id).toBe(box.id);
  expect(explicit.location?.id).toBe(roomB.id);
  // Parent pages use effective-location filtering: the explicit child stored
  // elsewhere belongs in that location's listing. Search includes both records.
  await page.goto(`/search?q=${unique}`);
  const inheritedRow = page.getByRole("row").filter({ has: page.getByText(childName, { exact: true }) });
  const explicitRow = page.getByRole("row").filter({ has: page.getByText(explicit.name, { exact: true }) });
  await expect(inheritedRow.getByRole("link", { name: roomA.name, exact: true })).toHaveAttribute(
    "href",
    `/location/${roomA.id}`
  );
  await expect(explicitRow.getByRole("link", { name: roomB.name, exact: true })).toHaveAttribute(
    "href",
    `/location/${roomB.id}`
  );
  await expect(inheritedRow.locator(`a[href='/location/${box.id}']`)).toHaveCount(0);

  const writes: string[] = [];
  page.on("request", request => {
    if (request.method() === "PATCH" && request.url().includes("/api/v1/entities/")) writes.push(request.url());
  });
  const knownDialog = await openLocationChange(page, childName);
  const knownLocation = knownDialog.getByRole("combobox", { name: "Parent Location", exact: true });
  await expect(knownLocation).toContainText(roomA.name);
  await knownLocation.click();
  await page.getByRole("option", { name: roomB.name, exact: true }).click();
  await expect(knownLocation).toContainText(roomB.name);
  await page.keyboard.press("Escape");
  await expect(knownDialog).toBeHidden();

  // A failed detail read cannot reuse the last dialog's chosen location or
  // substitute the parent box. No PATCH is allowed without pressing Save.
  await page.route(`**/api/v1/entities/${explicit.id}`, route =>
    route.request().method() === "GET"
      ? route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "synthetic failure" }),
        })
      : route.continue()
  );
  const failedDetail = page.waitForResponse(
    response => response.url().endsWith(`/api/v1/entities/${explicit.id}`) && response.status() === 503
  );
  const unknownDialog = await openLocationChange(page, explicit.name);
  await failedDetail;
  await expect(unknownDialog.getByRole("combobox", { name: "Parent Location", exact: true })).toContainText(
    "Select a Location"
  );
  await expect(unknownDialog.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(unknownDialog).toBeHidden();
  expect(writes).toEqual([]);

  await page.reload();
  const failedRow = page.getByRole("row").filter({ has: page.getByText(explicit.name, { exact: true }) });
  await expect(failedRow.getByText("Unknown", { exact: true })).toBeVisible();
  await expect(failedRow.locator(`a[href='/location/${box.id}']`)).toHaveCount(0);
});
