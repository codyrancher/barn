<script>
// What a new extension starts as.
//
// Typing a name that does not exist used to make one immediately, seeded from this product's own
// extension, which is a strong opinion to hold silently: it is the largest thing here and most
// of what somebody wants to build is not it. So the name opens this instead, and the question it
// asks is the one that was being answered by default.
//
// Three kinds of answer, and the third is the reason this is a list rather than a checkbox:
//
//   base   the stock extension - one product, one page - which is what
//          `yarn create @rancher/extension` gives you.
//   dev    this product's own extension, for when you want everything it already does.
//   <any>  an extension already running here, copied out of its pod as it is now, including
//          whatever was changed in it an hour ago.
import AppModal from '@shell/components/AppModal';
import LabeledSelect from '@shell/components/form/LabeledSelect';
import AsyncButton from '@shell/components/AsyncButton';
import { Card } from '@components/Card';
import { RcButton } from '@components/RcButton';
import { Banner } from '@components/Banner';
import { listExtensions, BUILT_IN_SEEDS } from '../extensions';

export default {
  name: 'NewExtensionModal',

  components: {
    AppModal, AsyncButton, Card, RcButton, Banner, LabeledSelect
  },

  props: {
    // The name that was typed, already normalised.
    name: {
      type:     String,
      required: true,
    },
  },

  emits: ['close', 'create'],

  data() {
    return {
      // Not `dev`. The default answer to "what should this new thing be" is the small one.
      source:  BUILT_IN_SEEDS.includes('base') ? 'base' : BUILT_IN_SEEDS[0],
      running: [],
      error:   '',
    };
  },

  computed: {
    /**
     * The built-ins first, then anything running here that is not a built-in.
     *
     * An extension whose name matches a built-in is listed once, as the built-in, because
     * cloning `dev` from its pod and seeding `dev` from the bundle are close enough that
     * offering both would be asking somebody to guess at a difference that will not matter.
     */
    options() {
      const builtIns = BUILT_IN_SEEDS.map((id) => ({ label: id, value: id }));
      // An extension that is not running has no pod to copy out of, so it is listed and refused
      // rather than hidden: it is a thing you have, and being told why is better than looking
      // for it.
      const clones = this.running
        .filter((extension) => !BUILT_IN_SEEDS.includes(extension.name))
        .map((extension) => ({
          label:    extension.ready ? extension.name : `${ extension.name } (not running)`,
          value:    extension.name,
          disabled: !extension.ready,
        }));

      return [...builtIns, ...clones];
    },
  },

  mounted() {
    this.refresh();
  },

  methods: {
    async refresh() {
      this.running = await listExtensions().catch(() => []);
    },

    create(done) {
      // The work happens in the page that opened this, because it is the page that knows where
      // to go afterwards. `done` is handed over with it so the button stays busy until the
      // objects exist rather than until this component stops caring.
      this.$emit('create', { name: this.name, source: this.source, done });
    },
  },
};
</script>

<template>
  <AppModal
    name="barn-new-extension"
    :width="620"
    @close="$emit('close')"
  >
    <Card
      class="new-extension"
      :show-highlight-border="false"
    >
      <template #title>
        <h4 class="text-default-text">
          Create New Extension "{{ name }}"
        </h4>
      </template>

      <template #body>
        <Banner
          v-if="error"
          color="error"
          :label="error"
        />

        <LabeledSelect
          v-model:value="source"
          label="Clone From"
          :options="options"
          :clearable="false"
        />
      </template>

      <template #actions>
        <div class="new-extension__actions">
          <RcButton
            variant="tertiary"
            @click="$emit('close')"
          >
            Cancel
          </RcButton>
          <AsyncButton
            mode="edit"
            action-label="Create"
            waiting-label="Creating"
            success-label="Created"
            @click="create"
          />
        </div>
      </template>
    </Card>
  </AppModal>
</template>

<style lang="scss" scoped>
.new-extension {
  &__actions {
    display:         flex;
    gap:             10px;
    justify-content: flex-end;
    width:           100%;
  }
}
</style>
