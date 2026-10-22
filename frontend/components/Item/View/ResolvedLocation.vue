<script setup lang="ts">
  import type { EntitySummary } from "~/lib/api/types/data-contracts";
  import { useItemLocationLoader } from "~/composables/use-item-location-loader";

  const props = defineProps<{ item: EntitySummary }>();
  const loader = useItemLocationLoader();
  const element = ref<HTMLElement | null>(null);
  const visible = ref(false);
  const location = ref<EntitySummary | null>(null);
  let observer: IntersectionObserver | null = null;

  onMounted(() => {
    if (typeof IntersectionObserver === "undefined") {
      visible.value = true;
      return;
    }
    observer = new IntersectionObserver(
      entries => {
        visible.value = entries.some(entry => entry.isIntersecting);
      },
      { rootMargin: "200px" }
    );
    if (element.value) observer.observe(element.value);
  });
  onBeforeUnmount(() => observer?.disconnect());

  // Visibility only controls loading. Retain known content offscreen so that
  // scrolling cannot change row heights or make the observer oscillate.
  watch(
    [() => props.item.id, () => props.item.updatedAt, loader.generation],
    () => {
      location.value = null;
    },
    { immediate: true, flush: "sync" }
  );

  // Offscreen rows do not enqueue requests. A table cell and its expanded view
  // share a promise, while fresh data/context always starts a new generation.
  watch(
    [visible, () => props.item.id, () => props.item.updatedAt, loader.generation],
    async (_, __, onCleanup) => {
      let cancelled = false;
      onCleanup(() => {
        cancelled = true;
      });
      if (!visible.value) return;
      const generation = loader.generation.value;
      const resolved = await loader.load(props.item.id, props.item.updatedAt);
      if (!cancelled && generation === loader.generation.value) {
        location.value = resolved;
      }
    },
    { immediate: true }
  );
</script>

<template>
  <span ref="element">
    <NuxtLink v-if="location" :to="`/location/${location.id}`" class="hover:underline">
      {{ location.name }}
    </NuxtLink>
    <span v-else class="text-muted-foreground">{{ $t("global.unknown") }}</span>
  </span>
</template>
