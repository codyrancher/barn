<script>
// Rancher's split button, composed here rather than imported.
//
// The shell ships one - `@components/RcButtonSplit` - and this is its markup, its class names
// and its stylesheet copied across. What it is not is its `<script setup>`, and that is the
// whole reason this file exists: that component takes its props as a TypeScript type that
// spreads `IconProps` imported from `@components/RcButton/types`, and `@vue/compiler-sfc` has
// to resolve that import itself to turn the type into runtime props. It resolves it against a
// tsconfig beside the file being compiled, which for a component inside `node_modules/@rancher/
// shell` is the shell's own - never this package's - so the alias is unknown and the build
// stops at "Failed to resolve import source". Adding the alias to our tsconfig does not help,
// for the same reason.
//
// Everything underneath is the shell's and is imported normally: those are value imports,
// which webpack resolves with the alias it already has. So this is Rancher's split button in
// every respect a person can see, assembled one level down from the wrapper that cannot
// compile in an extension.
import { RcButton } from '@components/RcButton';
import { RcDropdown, RcDropdownItem, RcDropdownTrigger } from '@components/RcDropdown';
import { RcIcon } from '@components/RcIcon';

export default {
  name: 'PublishSplit',

  components: {
    RcButton, RcDropdown, RcDropdownItem, RcDropdownTrigger, RcIcon
  },

  props: {
    /** What the near half says, and does when pressed. */
    label: {
      type:     String,
      required: true,
    },

    /** `{ id, label }` per line in the dropdown. `select` carries the id back. */
    items: {
      type:    Array,
      default: () => [],
    },

    disabled: {
      type:    Boolean,
      default: false,
    },

    /** What the caret half is called for anyone not looking at it. */
    ariaLabelTrigger: {
      type:    String,
      default: 'More actions',
    },
  },

  emits: ['click', 'select'],
};
</script>

<template>
  <RcDropdown placement="bottom-end">
    <div class="rc-button-split">
      <RcButton
        class="rc-button-split-action"
        variant="primary"
        size="small"
        :disabled="disabled"
        @click="$emit('click', $event)"
      >
        {{ label }}
      </RcButton>

      <RcDropdownTrigger
        class="rc-button-split-trigger"
        variant="primary"
        size="small"
        :disabled="disabled"
        :aria-label="ariaLabelTrigger"
      >
        <RcIcon
          type="chevron-down"
          size="inherit"
        />
      </RcDropdownTrigger>
    </div>

    <template #dropdownCollection>
      <RcDropdownItem
        v-for="item in items"
        :key="item.id"
        @click="$emit('select', item.id)"
      >
        {{ item.label }}
      </RcDropdownItem>
    </template>
  </RcDropdown>
</template>

<style lang="scss" scoped>
// Copied from RcButtonSplit so the two look the same. If the shell's ever changes, this is the
// file that has to be brought back into line with it.
.rc-button-split {
  display: inline-flex;

  // Round only the outer left edge of the main button
  :deep(.rc-button-split-action) {
    border-top-right-radius: 0;
    border-bottom-right-radius: 0;
  }

  // Round only the outer right edge of the trigger button; narrow padding
  :deep(button.rc-button-split-trigger) {
    border-top-left-radius: 0;
    border-bottom-left-radius: 0;
    padding-left: 8px;
    padding-right: 8px;
    min-width: unset;
  }

  :deep(button.btn-small.rc-button-split-trigger) {
    padding-left: 4px;
    padding-right: 4px;
  }

  // Primary: semi-transparent right border as separator
  :deep(.rc-button-split-trigger.variant-primary),
  :deep(.rc-button-split-trigger.variant-secondary),
  :deep(.rc-button-split-trigger.variant-tertiary) {
    border-left: 1px solid rgba(255, 255, 255, 0.3);
  }
}
</style>
