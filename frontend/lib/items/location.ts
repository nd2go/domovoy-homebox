import type { EntityOut, EntitySummary } from "../api/types/data-contracts";

type GetItem = (id: string) => Promise<{ error: boolean; data: Pick<EntityOut, "location"> }>;

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
