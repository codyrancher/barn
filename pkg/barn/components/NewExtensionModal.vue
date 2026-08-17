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
import AsyncButton from '@shell/components/AsyncButton';
import { Card } from '@components/Card';
import { RcButton } from '@components/RcButton';
import { Banner } from '@components/Banner';
import { listExtensions, BUILT_IN_SEEDS } from '../extensions';

// What each built-in is, in the one line the list has room for. Written here rather than beside
// the seed itself because it is UI copy: the seed is a directory of files and has no opinion.
const DESCRIPTIONS = {
  base: 'The stock extension. One product, one page, and nothing else.',
  dev:  "Barn's own extension: workspaces, terminals, sidecars, ports, the lot.",
};

export default {
  name: 'NewExtensionModal',

  components: {
    AppModal, AsyncButton, Card, RcButton, Banner
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
      const builtIns = BUILT_IN_SEEDS.map((id) => ({
        id, label: id, description: DESCRIPTIONS[id] || '', kind: 'seed',
      }));
      const clones = this.running
        .filter((extension) => !BUILT_IN_SEEDS.includes(extension.name))
        .map((extension) => ({
          id:          extension.name,
          label:       extension.name,
          description: extension.ready ? 'Copied from its pod as it is now.' : 'Not running, so there is nothing to copy yet.',
          kind:        'clone',
          disabled:    !extension.ready,
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
          Create {{ name }}
        </h4>
      </template>

      <template #body>
        <Banner
          v-if="error"
          color="error"
          :label="error"
        />

        <p class="new-extension__intro">
          What should it start as? Every option is a copy: nothing is shared afterwards, and what
          you do to this one does not touch what it came from.
        </p>

        <label
          v-for="option in options"
          :key="option.id"
          class="new-extension__option"
          :class="{
            'new-extension__option--current': option.id === source,
            'new-extension__option--disabled': option.disabled,
          }"
        >
          <input
            v-model="source"
            type="radio"
            :value="option.id"
            :disabled="option.disabled"
          >
          <span class="new-extension__label">
            <span class="new-extension__name">{{ option.label }}</span>
            <span
              v-if="option.kind === 'clone'"
              class="new-extension__tag"
            >running here</span>
          </span>
          <span class="new-extension__description">{{ option.description }}</span>
        </label>
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
  &__intro {
    max-width: 70ch;
    margin-bottom: 15px;
    color: var(--muted);
  }

  &__option {
    display:               grid;
    grid-template-columns: auto 1fr;
    gap:                   2px 10px;
    align-items:           center;
    padding:               8px 10px;
    margin-bottom:         6px;
    border:                1px solid var(--border);
    border-radius:         var(--border-radius);
    cursor:                pointer;

    &--current {
      border-color: var(--primary);
    }

    &--disabled {
      cursor:  not-allowed;
      opacity: 0.6;
    }

    input {
      grid-row: span 2;
    }
  }

  &__label {
    display:     flex;
    align-items: center;
    gap:         8px;
  }

  &__name {
    font-weight: 600;
    font-family: monospace;
  }

  &__tag {
    padding:       1px 6px;
    border-radius: 10px;
    background:    var(--accent-btn);
    color:         var(--muted);
    font-size:     10px;
  }

  &__description {
    grid-column: 2;
    color:       var(--muted);
    font-size:   12px;
  }

  &__actions {
    display:         flex;
    gap:             10px;
    justify-content: flex-end;
    width:           100%;
  }
}
</style>
