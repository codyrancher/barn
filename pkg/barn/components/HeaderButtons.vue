<script>
// This extension's global controls, in the header, with their names on them.
//
// `plugin.addAction(ActionLocation.HEADER, ...)` cannot do that. The shell renders an extension
// header action as an icon and nothing else, and puts the action's `label` on the aria-label and
// the tooltip (see the extension actions block in @shell/components/nav/Header.vue). Two actions
// from one extension therefore arrived as two identical anonymous icons, and the Editor was not
// findable without hovering both.
//
// NavHeaderRight is the one place the shell renders a whole component of ours into the header:
// it resolves `$extension.getDynamic('component', 'NavHeaderRight')` and renders it inside the
// header's right-hand group on every page. So it is where a control with words on it can live.
//
// Two things to know before adding to this. It is a single global slot and the last registration
// wins, so a second extension claiming it makes these disappear rather than duplicate, which is
// the symptom to look for. And it is rendered everywhere, including pages with no cluster, so
// nothing here may assume a cluster or a namespace.
import { RcButton } from '@components/RcButton';
import ExtensionSelect from './ExtensionSelect.vue';
import { ensureEditorContent } from '../api';
import { ensureExtension, DEFAULT_EXTENSION } from '../extensions';
import { EDITOR_ROUTE, EXTENSION_STARTING_ROUTE } from '../editor-product';

export default {
  name: 'BarnHeaderButtons',

  components: { RcButton, ExtensionSelect },

  computed: {
    // Which one the page is on, so the box shows where you are rather than sitting empty on
    // the extension you are looking at.
    current() {
      return this.$route.params?.extension || '';
    },
  },

  methods: {
    open(name) {
      this.$router.push({ name: EDITOR_ROUTE, params: { extension: name } });
    },

    // New. Create it and go and watch it come up: the objects are made in a moment and the pod
    // then installs and compiles for minutes, so the thing worth navigating to is the wait.
    create(name) {
      ensureExtension(name);
      this.$router.push({ name: EXTENSION_STARTING_ROUTE, params: { extension: name } });
    },

    // The editor for whichever extension you were last on, or the default one. In place rather
    // than a new tab: the page it goes to has Rancher's top-level menu, so it is somewhere you
    // can leave again.
    openEditor() {
      ensureEditorContent();
      this.open(this.current || DEFAULT_EXTENSION);
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
    <ExtensionSelect
      :value="current"
      @open="open"
      @create="create"
    />
  </div>
</template>

<style lang="scss" scoped>
.mc-header-buttons {
  display: flex;
  align-items: center;
  // The header's own gap between its right-hand controls, so these sit in the same rhythm as
  // the shell's buttons rather than crowding them.
  gap: 4px;
  margin-right: 8px;
  white-space: nowrap;
}
</style>
