<script>
// The global "Dev" button in the top header.
//
// It is registered as the `NavHeaderRight` component rather than as an
// `ActionLocation.HEADER` action, because that action API renders the icon alone: `label`
// becomes the aria-label and the tooltip, and there is no way through it to put the word
// "Dev" on the button. Header.vue resolves this component with
// `$extension.getDynamic('component', 'NavHeaderRight')` and renders it inside
// `.rd-header-right` on every page, which is the same reach with the label kept.
//
// Two things to know before adding to this. It is a single global slot and the last
// registration wins, so a second extension claiming NavHeaderRight replaces this outright
// (nothing else in this dashboard claims it today). And the product registration already puts
// a labelled Dev entry in the side menu, so what this adds is the header specifically, for
// the pages where the side menu is collapsed or somewhere else entirely.
import { RcButton } from '@components/RcButton';
import { DEV_PRODUCT, BLANK_CLUSTER, WORKSPACES_ROUTE } from '../config/constants';

export default {
  name: 'DevHeaderButton',

  components: { RcButton },

  computed: {
    workspacesTo() {
      return {
        name:   WORKSPACES_ROUTE,
        params: { product: DEV_PRODUCT, cluster: BLANK_CLUSTER },
      };
    },
  },
};
</script>

<template>
  <div class="dev-header-button">
    <RcButton
      variant="tertiary"
      size="small"
      left-icon="terminal"
      data-testid="dev-header-button"
      :to="workspacesTo"
    >
      Dev
    </RcButton>
  </div>
</template>

<style lang="scss" scoped>
  .dev-header-button {
    display:     flex;
    align-items: center;
    // The header is its own colour scheme, and a tertiary button defaults to the body's
    // text colour, which is unreadable on it in dark mode.
    color:       var(--header-btn-text);

    :deep(.rc-button) {
      color: inherit;
    }
  }
</style>
