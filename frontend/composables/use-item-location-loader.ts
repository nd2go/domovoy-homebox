import { inject, onScopeDispose, provide, readonly, ref, watch } from "vue";
import type { InjectionKey, Ref, WatchSource } from "vue";
import type { EntitySummary } from "~/lib/api/types/data-contracts";
import { loadItemLocation } from "~/lib/items/location";
import { createItemLocationLoader } from "~/lib/items/location-loader";
import { onServerEvent, ServerEvent } from "./use-server-events";

type ItemLocationContext = {
  generation: Readonly<Ref<number>>;
  load: ReturnType<typeof createItemLocationLoader<EntitySummary>>["load"];
};

const itemLocationKey: InjectionKey<ItemLocationContext> = Symbol("table-item-locations");

function createContext(data?: () => EntitySummary[]): ItemLocationContext {
  const preferences = useViewPreferences();
  const auth = useAuthContext();
  const generation = ref(0);
  const loader = createItemLocationLoader(id => loadItemLocation(itemId => useUserApi().items.get(itemId), id));
  const sources: WatchSource<unknown>[] = [
    () => preferences.value.collectionId,
    () => auth.token,
    () => auth.attachmentToken,
  ];
  if (data) sources.push(data);

  function invalidate() {
    loader.invalidate();
    generation.value++;
  }

  // A fresh list response also invalidates descendants whose own updatedAt did
  // not change when their parent moved. Equal preference replacements do not.
  watch(sources, invalidate, { flush: "sync" });
  onServerEvent(ServerEvent.EntityMutation, invalidate);
  onScopeDispose(loader.dispose);

  return {
    generation: readonly(generation),
    load: (id, revision) => (auth.token && auth.attachmentToken ? loader.load(id, revision) : Promise.resolve(null)),
  };
}

export function provideItemLocationLoader(data: () => EntitySummary[]) {
  provide(itemLocationKey, createContext(data));
}

export function useItemLocationLoader(): ItemLocationContext {
  return inject(itemLocationKey, null) ?? createContext();
}
