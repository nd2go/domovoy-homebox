import type { EntityOut, EntityPatch, EntitySummary } from "../api/types/data-contracts";

type GetItem = (id: string) => Promise<{ error: boolean; data: Pick<EntityOut, "location"> }>;
type ItemLocationState = {
  location?: Pick<EntitySummary, "id"> | null;
  parent?: { entityType?: { isLocation: boolean } | null } | null;
};

/** Summary parents can be items; only detail responses include a resolved location. */
export async function loadItemLocation(getItem: GetItem, id: string): Promise<EntitySummary | null> {
  try {
    const { data, error } = await getItem(id);
    return error ? null : (data?.location ?? null);
  } catch {
    return null;
  }
}

export function commonItemLocation(locations: (EntitySummary | null)[]): EntitySummary | null {
  const first = locations[0];
  if (!first || locations.some(location => location?.id !== first.id)) {
    return null;
  }
  return first;
}

/** Change physical location without replacing a nested item's logical parent. */
export function itemLocationChange(
  item: ItemLocationState,
  location: EntitySummary
): Pick<EntityPatch, "parentId" | "locationId"> | null {
  if (item.location?.id === location.id) return {};
  if (item.parent && !item.parent.entityType) return null;
  return item.parent?.entityType?.isLocation ? { parentId: location.id } : { locationId: location.id };
}
