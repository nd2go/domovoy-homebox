<script setup lang="ts">
  import { Dialog, DialogContent, DialogFooter, DialogTitle, DialogHeader } from "@/components/ui/dialog";
  import { Button } from "@/components/ui/button";
  import { useDialog } from "@/components/ui/dialog-provider";
  import { DialogID } from "~/components/ui/dialog-provider/utils";
  import type { EntityOut, EntityPatch, EntitySummary, TagOut } from "~/lib/api/types/data-contracts";
  import LocationSelector from "~/components/Location/Selector.vue";
  import MdiLoading from "~icons/mdi/loading";
  import { toast } from "~/components/ui/sonner";
  import { useI18n } from "vue-i18n";
  import TagSelector from "~/components/Tag/Selector.vue";
  import { commonItemLocation, itemLocationChange, loadItemLocation } from "~/lib/items/location";

  const { activeDialog, closeDialog, registerOpenDialogCallback } = useDialog();

  const preferences = useViewPreferences();
  const auth = useAuthContext();
  const { t } = useI18n();
  const tagStore = useTagStore();

  const allTags = computed(() => tagStore.tags);

  const items = ref<EntitySummary[]>([]);
  const saving = ref(false);
  const loadingLocation = ref(false);
  const locationDetails = ref(new Map<string, Pick<EntityOut, "location" | "parent">>());
  let openingRevision = 0;
  let locationSelectionRevision = 0;

  const enabled = reactive({
    changeLocation: false,
    addTags: false,
    removeTags: false,
  });

  const newLocation = ref<EntitySummary | null>(null);
  const addTags = ref<string[]>([]);
  const removeTags = ref<string[]>([]);

  const locationPatches = computed(() => {
    const patches = new Map<string, Pick<EntityPatch, "parentId" | "locationId">>();
    if (!enabled.changeLocation) return patches;
    if (!newLocation.value) return null;
    for (const item of items.value) {
      const detail = locationDetails.value.get(item.id);
      if (!detail) return null;
      const patch = itemLocationChange(detail, newLocation.value);
      if (!patch) return null;
      patches.set(item.id, patch);
    }
    return patches;
  });

  const preventCloseWhileSaving = (event: Event) => {
    if (saving.value) event.preventDefault();
  };

  watch(newLocation, () => locationSelectionRevision++, { flush: "sync" });
  watch(activeDialog, dialog => {
    if (dialog !== DialogID.ItemChangeDetails) openingRevision++;
  });
  watch(
    () => [preferences.value.collectionId, auth.attachmentToken],
    () => {
      openingRevision++;
      items.value = [];
      locationDetails.value = new Map();
      newLocation.value = null;
      if (activeDialog.value === DialogID.ItemChangeDetails) closeDialog(DialogID.ItemChangeDetails);
    }
  );

  const availableToAddTags = ref<TagOut[]>([]);
  const availableToRemoveTags = ref<TagOut[]>([]);

  const intersectTagIds = (items: EntitySummary[]): string[] => {
    if (items.length === 0) return [];
    const counts = new Map<string, number>();
    for (const it of items) {
      const seen = new Set<string>();
      for (const l of it.tags || []) seen.add(l.id);
      for (const id of seen) counts.set(id, (counts.get(id) || 0) + 1);
    }
    return [...counts.entries()].filter(([_, c]) => c === items.length).map(([id]) => id);
  };

  const unionTagIds = (items: EntitySummary[]): string[] => {
    const s = new Set<string>();
    for (const it of items) for (const l of it.tags || []) s.add(l.id);
    return Array.from(s);
  };

  onMounted(() => {
    const cleanup = registerOpenDialogCallback(DialogID.ItemChangeDetails, params => {
      const revision = ++openingRevision;
      items.value = params.items;
      saving.value = false;
      loadingLocation.value = false;
      locationDetails.value = new Map();
      newLocation.value = null;
      addTags.value = [];
      removeTags.value = [];
      availableToAddTags.value = [];
      availableToRemoveTags.value = [];
      enabled.changeLocation = params.changeLocation ?? false;
      enabled.addTags = params.addTags ?? false;
      enabled.removeTags = params.removeTags ?? false;

      if (params.changeLocation && params.items.length > 0) {
        loadingLocation.value = true;
        const selectionRevision = locationSelectionRevision;
        const api = useUserApi();
        const details = new Map<string, Pick<EntityOut, "location" | "parent">>();
        void Promise.all(
          params.items.map(item =>
            loadItemLocation(async id => {
              const result = await api.items.get(id);
              if (!result.error) details.set(id, result.data);
              return result;
            }, item.id)
          )
        ).then(locations => {
          if (revision !== openingRevision || activeDialog.value !== DialogID.ItemChangeDetails) return;
          locationDetails.value = details;
          // Do not overwrite a location the user chose while details loaded.
          if (selectionRevision === locationSelectionRevision) {
            newLocation.value = commonItemLocation(locations);
          }
          loadingLocation.value = false;
        });
      }

      if (params.addTags && params.items.length > 0) {
        const intersection = intersectTagIds(params.items);
        availableToAddTags.value = allTags.value.filter(l => !intersection.includes(l.id));
      }

      if (params.removeTags && params.items.length > 0) {
        const union = unionTagIds(params.items);
        availableToRemoveTags.value = allTags.value.filter(l => union.includes(l.id));
      }
    });

    onUnmounted(cleanup);
  });

  const save = async () => {
    const changes = { ...enabled };
    const selected = [...items.value];
    const patches = locationPatches.value;
    const tagsToAdd = [...addTags.value];
    const tagsToRemove = [...removeTags.value];
    if (saving.value || !selected.length || loadingLocation.value || (changes.changeLocation && !patches)) {
      return;
    }

    const revision = openingRevision;
    const api = useUserApi();
    saving.value = true;

    try {
      // Process items sequentially to avoid database locking issues with concurrent write transactions
      for (const item of selected) {
        if (revision !== openingRevision) return;
        const patch: EntityPatch = {
          id: item.id,
        };

        if (changes.changeLocation) {
          Object.assign(patch, patches?.get(item.id));
        }

        let currentTags = item.tags.map(l => l.id);

        if (changes.addTags) {
          currentTags = currentTags.concat(tagsToAdd);
        }

        if (changes.removeTags) {
          currentTags = currentTags.filter(l => !tagsToRemove.includes(l));
        }

        if (changes.addTags || changes.removeTags) {
          patch.tagIds = Array.from(new Set(currentTags));
        }

        const { error, data } = await api.items.patch(item.id, patch);

        if (error) {
          console.error("failed to update item", item.id, data);
          toast.error(t("components.item.view.change_details.failed_to_update_item"));
          continue;
        }
      }

      if (revision !== openingRevision) return;
      closeDialog(DialogID.ItemChangeDetails, true);
      enabled.changeLocation = false;
      enabled.addTags = false;
      enabled.removeTags = false;
      items.value = [];
      addTags.value = [];
      removeTags.value = [];
      availableToAddTags.value = [];
      availableToRemoveTags.value = [];
    } finally {
      if (revision === openingRevision) saving.value = false;
    }
  };
</script>

<template>
  <Dialog :dialog-id="DialogID.ItemChangeDetails">
    <DialogContent
      :disable-close="saving"
      @escape-key-down="preventCloseWhileSaving"
      @interact-outside="preventCloseWhileSaving"
    >
      <DialogHeader>
        <DialogTitle>{{ $t("components.item.view.change_details.title") }}</DialogTitle>
      </DialogHeader>
      <LocationSelector v-if="enabled.changeLocation" v-model="newLocation" />
      <TagSelector
        v-if="enabled.addTags"
        v-model="addTags"
        :tags="availableToAddTags"
        :name="$t('components.item.view.change_details.add_tags')"
      />
      <TagSelector
        v-if="enabled.removeTags"
        v-model="removeTags"
        :tags="availableToRemoveTags"
        :name="$t('components.item.view.change_details.remove_tags')"
      />
      <DialogFooter>
        <Button
          type="submit"
          :disabled="saving || loadingLocation || (enabled.changeLocation && !locationPatches)"
          @click="save"
        >
          <span v-if="!saving">{{ $t("global.save") }}</span>
          <MdiLoading v-else class="animate-spin" />
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
