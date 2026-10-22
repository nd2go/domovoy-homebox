<script setup lang="ts">
  import { Dialog, DialogContent, DialogFooter, DialogTitle, DialogHeader } from "@/components/ui/dialog";
  import { Button } from "@/components/ui/button";
  import { useDialog } from "@/components/ui/dialog-provider";
  import { DialogID } from "~/components/ui/dialog-provider/utils";
  import type { EntityPatch, EntitySummary, TagOut } from "~/lib/api/types/data-contracts";
  import LocationSelector from "~/components/Location/Selector.vue";
  import MdiLoading from "~icons/mdi/loading";
  import { toast } from "~/components/ui/sonner";
  import { useI18n } from "vue-i18n";
  import TagSelector from "~/components/Tag/Selector.vue";
  import { commonItemLocation, loadItemLocation } from "~/lib/items/location";

  const { activeDialog, closeDialog, registerOpenDialogCallback } = useDialog();

  const preferences = useViewPreferences();
  const auth = useAuthContext();
  const { t } = useI18n();
  const tagStore = useTagStore();

  const allTags = computed(() => tagStore.tags);

  const items = ref<EntitySummary[]>([]);
  const saving = ref(false);
  const loadingLocation = ref(false);
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

  watch(newLocation, () => locationSelectionRevision++, { flush: "sync" });
  watch(activeDialog, dialog => {
    if (dialog !== DialogID.ItemChangeDetails) openingRevision++;
  });
  watch(
    () => [preferences.value.collectionId, auth.attachmentToken],
    () => {
      openingRevision++;
      items.value = [];
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
        void Promise.all(params.items.map(item => loadItemLocation(id => api.items.get(id), item.id))).then(
          locations => {
            if (revision !== openingRevision || activeDialog.value !== DialogID.ItemChangeDetails) return;
            // Do not overwrite a location the user chose while details loaded.
            if (selectionRevision === locationSelectionRevision) {
              newLocation.value = commonItemLocation(locations);
            }
            loadingLocation.value = false;
          }
        );
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
    const location = newLocation.value;
    const changes = { ...enabled };
    const selected = items.value;
    const tagsToAdd = addTags.value;
    const tagsToRemove = removeTags.value;
    if (!selected.length || loadingLocation.value || (changes.changeLocation && !location)) {
      return;
    }

    const revision = openingRevision;
    const api = useUserApi();
    saving.value = true;

    // Process items sequentially to avoid database locking issues with concurrent write transactions
    for (const item of selected) {
      if (revision !== openingRevision) return;
      const patch: EntityPatch = {
        id: item.id,
      };

      if (changes.changeLocation) {
        patch.parentId = location!.id;
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
    saving.value = false;
  };
</script>

<template>
  <Dialog :dialog-id="DialogID.ItemChangeDetails">
    <DialogContent>
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
          :disabled="saving || loadingLocation || (enabled.changeLocation && !newLocation)"
          @click="save"
        >
          <span v-if="!saving">{{ $t("global.save") }}</span>
          <MdiLoading v-else class="animate-spin" />
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
