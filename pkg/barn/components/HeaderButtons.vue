<script>
// This extension's global buttons, in the header, with their names on them.
//
// `plugin.addAction(ActionLocation.HEADER, ...)` cannot do that. The shell
// renders an extension header action as an icon and nothing else, and puts the
// action's `label` on the aria-label and the tooltip (see the extension actions
// block in @shell/components/nav/Header.vue). Two actions from one extension
// therefore arrived as two identical anonymous icons, and the Editor was not
// findable without hovering both.
//
// NavHeaderRight is the one place the shell renders a whole component of ours
// into the header: it resolves `$extension.getDynamic('component',
// 'NavHeaderRight')` and renders it inside the header's right-hand group on
// every page. So it is where a button with a word on it can live.
//
// Two things to know before adding to this. It is a single global slot and the
// last registration wins, so a second extension claiming it makes these buttons
// disappear rather than duplicate, which is the symptom to look for. And it is
// rendered everywhere, including pages with no cluster, so nothing here may
// assume a cluster or a namespace.
import { RcButton } from '@components/RcButton';
import { ensureEditorContent } from '../api';
import { ensureDevExtension, devExtensionUrl } from '../dev-extension';
import { EDITOR_ROUTE } from '../editor-product';

export default {
  name: 'BarnHeaderButtons',

  components: { RcButton },

  methods: {
    // Both open in a new tab rather than navigating: the header is on every
    // page, so a click here is an aside, not a departure from what you were
    // doing. Both also make sure the thing they open exists first, since the
    // pods behind them are created lazily by the extension.
    openEditor() {
      ensureEditorContent();

      window.open(this.$router.resolve({ name: EDITOR_ROUTE }).href, '_blank');
    },

    openDevExtension() {
      ensureDevExtension();

      window.open(devExtensionUrl(), '_blank');
    },
  },
};
</script>

<template>
  <div class="mc-header-buttons">
    <RcButton
      variant="link"
      size="small"
      data-testid="barn-editor-button"
      @click="openEditor"
    >
      Editor
    </RcButton>
    <RcButton
      variant="link"
      size="small"
      data-testid="barn-dev-extension-button"
      @click="openDevExtension"
    >
      Dev Extension
    </RcButton>
  </div>
</template>

<style lang="scss" scoped>
.mc-header-buttons {
  display: flex;
  align-items: center;
  // The header's own gap between its right-hand controls, so these sit in the
  // same rhythm as the shell's buttons rather than crowding them.
  gap: 4px;
  margin-right: 8px;
  white-space: nowrap;
}
</style>
