<script setup lang="ts">
  import type { EntitySummary } from "~/lib/api/types/data-contracts";
  import { loadItemLocation } from "~/lib/items/location";

  const props = defineProps<{ item: EntitySummary }>();
  const preferences = useViewPreferences();
  const auth = useAuthContext();
  const location = ref<EntitySummary | null>(null);

  // Component-local state: a refreshed item, collection or session never reuses a
  // previous location. Fetch only when this cell/expanded view is rendered.
  watch(
    () => [props.item.id, props.item.updatedAt, preferences.value.collectionId, auth.attachmentToken],
    async (_, __, onCleanup) => {
      let cancelled = false;
      onCleanup(() => {
        cancelled = true;
      });
      location.value = null;
      const resolved = await loadItemLocation(id => useUserApi().items.get(id), props.item.id);
      if (!cancelled) {
        location.value = resolved;
      }
    },
    { immediate: true }
  );
</script>

<template>
  <span>
    <NuxtLink v-if="location" :to="`/location/${location.id}`" class="hover:underline">
      {{ location.name }}
    </NuxtLink>
    <span v-else class="text-muted-foreground">{{ $t("global.unknown") }}</span>
  </span>
</template>
