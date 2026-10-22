import { describe, expect, test } from "vitest";
import type { EntitySummary } from "../api/types/data-contracts";
import { commonItemLocation, itemLocationChange, loadItemLocation } from "./location";

function location(id: string): EntitySummary {
  return {
    id,
    name: id,
    archived: false,
    assetId: "1",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    description: "",
    insured: false,
    itemCount: 0,
    purchasePrice: 0,
    quantity: 1,
    soldDate: "0001-01-01T00:00:00Z",
    tags: [],
  };
}

describe("resolved item locations", () => {
  test("uses an explicit physical location instead of the parent item", async () => {
    const room = location("room");
    const detail = { location: room, locationId: room.id, parent: location("box") };
    expect(await loadItemLocation(async () => ({ data: detail, error: false }), "item")).toEqual(room);
  });

  test("keeps a resolved inherited location without pinning it to locationId", async () => {
    const room = location("room");
    const detail = { location: room, locationId: null, parent: location("box") };
    expect(await loadItemLocation(async () => ({ data: detail, error: false }), "item")).toEqual(room);
    expect(detail.locationId).toBeNull();
  });

  test("does not turn a parent item into a location when detail has none", async () => {
    const detail = { location: null, parent: location("box") };
    expect(await loadItemLocation(async () => ({ data: detail, error: false }), "item")).toBeNull();
  });

  test("failed and rejected detail requests leave location unknown", async () => {
    expect(
      await loadItemLocation(async () => ({ data: { location: location("stale") }, error: true }), "item")
    ).toBeNull();
    expect(
      await loadItemLocation(async () => {
        throw new Error("network unavailable");
      }, "item")
    ).toBeNull();
  });

  test("preselects only a location confirmed for every selected item", () => {
    const room = location("room");
    expect(commonItemLocation([room, { ...room }])).toEqual(room);
    expect(commonItemLocation([room, null])).toBeNull();
    expect(commonItemLocation([room, location("other-room")])).toBeNull();
    expect(commonItemLocation([])).toBeNull();
  });

  test("leaves unchanged inherited and explicit locations untouched", () => {
    const room = location("room");
    expect(itemLocationChange({ location: room, parent: { entityType: { isLocation: false } } }, room)).toEqual({});
    expect(itemLocationChange({ location: room, parent: null }, room)).toEqual({});
  });

  test("moves nested items physically without changing their logical parent", () => {
    expect(
      itemLocationChange(
        { location: location("old-room"), parent: { entityType: { isLocation: false } } },
        location("new-room")
      )
    ).toEqual({ locationId: "new-room" });
  });

  test("moves direct location children by parent as required by the API", () => {
    expect(
      itemLocationChange(
        { location: location("old-room"), parent: { entityType: { isLocation: true } } },
        location("new-room")
      )
    ).toEqual({ parentId: "new-room" });
  });

  test("does not guess a missing parent type when changing location", () => {
    expect(itemLocationChange({ location: location("old-room"), parent: {} }, location("new-room"))).toBeNull();
    expect(itemLocationChange({ location: null, parent: null }, location("new-room"))).toEqual({
      locationId: "new-room",
    });
  });
});
