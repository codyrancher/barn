<script>
// The box you pick an extension in, and make one in.
//
// One component because it is in two places - Rancher's header on every page, and the editor's
// own toolbar - and those two would otherwise disagree about what a name means the moment
// either changed. It knows how to list and how to create; where to go afterwards belongs to
// whoever mounted it, which is why it emits rather than navigates.
import LabeledSelect from '@shell/components/form/LabeledSelect';
import { listExtensions, normalizeExtensionName } from '../extensions';

// How often the list is re-read. Extensions are created from here and from other browsers, and
// a pod that has finished installing is one this should stop calling "starting", so it is a
// poll rather than a one-off.
const LIST_POLL_MS = 10000;

export default {
  name: 'ExtensionSelect',

  components: { LabeledSelect },

  props: {
    // The one to show as chosen. Empty is fine: on most pages there isn't one.
    value: {
      type:    String,
      default: '',
    },

    placeholder: {
      type:    String,
      default: 'Extension',
    },
  },

  emits: ['open', 'create'],

  data() {
    return {
      extensions: [],
      timer:      null,
    };
  },

  computed: {
    /**
     * What the box offers, and what it shows for each.
     *
     * A pod that is still installing is listed rather than hidden: it is a real extension, it
     * is where you are going next, and hiding it would make the name you just typed vanish for
     * the ten minutes it takes to come up.
     */
    options() {
      return this.extensions.map((extension) => ({
        label: extension.ready ? extension.name : `${ extension.name } (starting)`,
        value: extension.name,
      }));
    },
  },

  mounted() {
    this.refresh();
    this.timer = setInterval(() => this.refresh(), LIST_POLL_MS);
  },

  beforeUnmount() {
    clearInterval(this.timer);
  },

  methods: {
    /**
     * What a chosen option is worth.
     *
     * `(option) => option.value` is the obvious version and it is silently wrong here. When the
     * options are objects, vue-select builds a typed-in one in their shape and fills only the
     * label: `{ label: 'probe one' }`. So `.value` is undefined, the handler below reads a name
     * of '' and returns, and the create half of this control does nothing at all while the open
     * half works. Which is a hard fault to see, because the dropdown offers the new name exactly
     * as it should and Enter dismisses it exactly as it should.
     *
     * The string case is for a vue-select configured with plain string options, which this is
     * one prop change away from being.
     */
    reduce(option) {
      if (typeof option === 'string') {
        return option;
      }

      return option?.value ?? option?.label;
    },

    async refresh() {
      // Quietly: this runs on every page in Rancher, and a Rancher where the user cannot list
      // Deployments is one where this control has nothing to offer rather than one that should
      // be putting an error in the header.
      this.extensions = await listExtensions().catch(() => []);
    },

    /**
     * One handler for both halves of a taggable select.
     *
     * vue-select hands back the option object for something in the list and the raw string for
     * something typed, and there is no third case: an unknown name is a new extension, which is
     * the whole point of the box being taggable. Normalising first is what makes "My Thing" and
     * "my-thing" the same extension rather than a rejection from the apiserver.
     */
    onSelect(selected) {
      const name = normalizeExtensionName(this.reduce(selected));

      if (!name) {
        return;
      }

      this.$emit(this.extensions.some((extension) => extension.name === name) ? 'open' : 'create', name);
    },
  },
};
</script>

<template>
  <LabeledSelect
    class="extension-select"
    data-testid="barn-extension-select"
    :value="value"
    :options="options"
    :taggable="true"
    :searchable="true"
    :clearable="false"
    :reduce="reduce"
    :compact-input="true"
    :placeholder="placeholder"
    @update:value="onSelect"
  />
</template>

<style lang="scss" scoped>
.extension-select {
  // Wide enough for a name and the "(starting)" suffix, narrow enough that a header still
  // belongs to whatever it is the header of.
  width: 200px;

  // LabeledSelect is built for a form row and is taller than a header control.
  :deep(.vs__dropdown-toggle) {
    min-height: 32px;
  }
}
</style>
