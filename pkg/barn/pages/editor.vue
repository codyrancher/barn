<script>
// The Editor: two panes filling the page, reached from the flask button in the side menu or
// from the extension box in the header.
//
// Left pane: a terminal in the extension's pod, with claude running in it (see
// components/PodTerminal.vue).
// Right pane: that extension's dev server (see extensions.ts) — the live, hot-reloading
// Rancher the same pod is serving, framed same-origin through the Kubernetes API service
// proxy, which is what makes framing it possible.
//
// So the two panes are two views of one pod: what claude edits on the left is what
// hot-reloads on the right, and which pod that is comes from the route.
//
// Registered in index.ts under the 'plain' parent rather than 'blank'. Blank renders the
// route and nothing else, which meant this page had to carry a Back button to be escapable
// at all. Plain brings the top-level menu, which is the way out; its header bar is hidden
// here (see the unscoped style block at the bottom) because each pane labels itself.
import { RcIcon } from '@components/RcIcon';
import PodTerminal from '../components/PodTerminal.vue';
import ExtensionSelect from '../components/ExtensionSelect.vue';
import ClaudeMark from '../components/ClaudeMark.vue';
import AsyncButton from '@shell/components/AsyncButton';
import PublishStatus from '../components/PublishStatus.vue';
import ExtensionFilesModal from '../components/ExtensionFilesModal.vue';
import {
  ensureExtension, extensionReady, extensionUrl, publishExtension, DEFAULT_EXTENSION
} from '../extensions';
import { EXTENSION_STARTING_ROUTE } from '../editor-product';

// How close to an edge the divider can be dragged, in percent of the page.
const MIN_SPLIT = 10;
const MAX_SPLIT = 90;
const DEFAULT_SPLIT = 50;

// Where the divider position is remembered between visits. It's stored as a
// percentage, so the panes keep their proportions when the window is a
// different size next time.
const SPLIT_KEY = 'barn.editor.split';

function clampSplit(percent) {
  return Math.min(MAX_SPLIT, Math.max(MIN_SPLIT, percent));
}

function readSplit() {
  try {
    const stored = parseFloat(window.localStorage.getItem(SPLIT_KEY));

    return isNaN(stored) ? DEFAULT_SPLIT : clampSplit(stored);
  } catch {
    // Storage can be unavailable (private mode, blocked cookies) — not fatal.
    return DEFAULT_SPLIT;
  }
}

function writeSplit(percent) {
  try {
    window.localStorage.setItem(SPLIT_KEY, String(percent));
  } catch { /* see readSplit */ }
}

// How often to re-ask the dev server whether it's up. Its first boot is an
// install and a full dashboard compile, so this is a wait of minutes, not
// seconds, and there's nothing to gain from asking faster.
const DEV_POLL_MS = 5000;

export default {
  name: 'BarnEditor',

  components: {
    RcIcon, PodTerminal, ExtensionSelect, ExtensionFilesModal, ClaudeMark, AsyncButton, PublishStatus
  },

  data() {
    return {
      rightUrl: '',
      // Width of the left pane, as a percentage of the page.
      split:    readSplit(),
      dragging: false,
      // Bookkeeping for the dev server poll, so it stops with the page.
      unmounted:    false,
      devPollTimer: null,
      // Whether the source browser is open. The left bar is about the source and about claude,
      // and this is the first thing on it.
      showFiles: false,
      // What the last publish did and said. The stage is what the bar counts; the log is kept
      // whether it worked or not, because a build log is worth reading either way.
      publishStage: 0,
      publishTotal: 0,
      publishLabel: '',
      publishError: '',
      publishLog:   '',
      published:    '',
    };
  },

  computed: {
    // Which extension this editor is pointed at. A path segment rather than a fixed name, so
    // the header's box can send you between them, and defaulted so every link that predates
    // there being more than one still works.
    extension() {
      return this.$route.params.extension || DEFAULT_EXTENSION;
    },
  },

  watch: {
    // Switching extensions is switching pods: the right pane has to go back to waiting rather
    // than keep framing the one that is no longer being edited. The terminal on the left
    // re-connects on its own, because `extension` is a prop of it.
    extension() {
      this.rightUrl = '';
      this.waitForDevServer();
    },

    // Persist the divider position, but not on every pointermove — the final
    // position of a drag is written when the drag ends.
    split(percent) {
      if (!this.dragging) {
        writeSplit(percent);
      }
    },

    dragging(dragging) {
      if (!dragging) {
        writeSplit(this.split);
      }
    },
  },

  mounted() {
    // The terminal brings itself up (it waits on the pod, not on the dev
    // server), so nothing here has to wait for the left pane.
    this.waitForDevServer();

    // What the page needs from the template it is under, and cannot ask for from inside its
    // own scope: see the unscoped style block at the bottom. The class goes on <html> rather
    // than on <body>, which was the first attempt and silently did nothing - the shell owns
    // body's class list (theme-light, overflow-hidden, dashboard-body) and rewrites it whole
    // on navigation, so a class added there survives until the next route change and no
    // longer.
    document.documentElement.classList.add('barn-editor-page');
  },

  beforeUnmount() {
    this.unmounted = true;
    clearTimeout(this.devPollTimer);
    document.documentElement.classList.remove('barn-editor-page');
  },

  methods: {
    // Frame the dev server once it answers. It's created when the extension
    // loads, but a cold one installs and compiles for a few minutes first, and
    // framing it before then would show the proxy's error page instead.
    async waitForDevServer() {
      ensureExtension(this.extension);

      while (!this.unmounted) {
        if (await extensionReady(this.extension)) {
          this.rightUrl = extensionUrl(this.extension);

          return;
        }

        await new Promise((resolve) => {
          this.devPollTimer = setTimeout(resolve, DEV_POLL_MS);
        });
      }
    },

    startDrag(event) {
      this.dragging = true;
      // Capture keeps the moves coming to the divider once the pointer is over
      // an iframe — without it the iframe's document swallows them.
      event.currentTarget.setPointerCapture(event.pointerId);
    },

    onDrag(event) {
      if (!this.dragging) {
        return;
      }

      const rect = this.$refs.panes?.getBoundingClientRect();

      if (!rect?.width) {
        return;
      }

      this.setSplit((event.clientX - rect.left) / rect.width * 100);
    },

    endDrag(event) {
      this.dragging = false;
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    },

    onKeyDown(event) {
      const step = event.shiftKey ? 10 : 2;
      const moves = {
        ArrowLeft:  -step,
        ArrowRight: step,
        Home:       MIN_SPLIT - this.split,
        End:        MAX_SPLIT - this.split,
      };

      if (moves[event.key] === undefined) {
        return;
      }

      event.preventDefault();
      this.setSplit(this.split + moves[event.key]);
    },

    reset() {
      this.split = DEFAULT_SPLIT;
    },

    setSplit(percent) {
      this.split = clampSplit(percent);
    },

    openExtension(name) {
      this.$router.push({ name: this.$route.name, params: { extension: name } });
    },

    /**
     * Build this extension and install it into the Rancher around us.
     *
     * Minutes, not seconds: it is a production build of a Rancher package, run in the pod, and
     * the socket stays open for the whole of it. AsyncButton is what makes that bearable - it
     * says it is working and refuses a second press.
     */
    async publish(done) {
      this.publishError = '';
      this.published = '';
      this.publishLog = '';

      try {
        const result = await publishExtension(this.extension, (stage, label, total) => {
          this.publishStage = stage;
          this.publishLabel = label;
          this.publishTotal = total;
        });

        this.published = `${ result.plugin } ${ result.version }`;
        this.publishLog = result.log;
        done(true);
      } catch (e) {
        this.publishError = e.message || String(e);
        // PublishError carries the output and the step it died at; anything else is a message.
        this.publishLog = e.log || '';
        this.publishLabel = e.stage || this.publishLabel;
        done(false);
      } finally {
        this.publishStage = 0;
      }
    },

    createExtension(name) {
      ensureExtension(name);
      this.$router.push({ name: EXTENSION_STARTING_ROUTE, params: { extension: name } });
    },
  },
};
</script>

<template>
  <div class="mc-editor">
    <!--
      One bar per pane rather than one across the page. Rancher's own header is hidden here
      (see the unscoped block below), and a single bar over two panes would have had to say
      which half each of its words was about. Each bar is the width of the pane under it and
      moves with the divider, so the answer is where it is rather than what it says.
    -->
    <div class="mc-editor__bars">
      <div
        class="mc-editor__bar"
        :style="{ width: `calc(${ split }% - 4px)` }"
      >
        <button
          type="button"
          class="mc-editor__icon-button"
          data-testid="barn-agent-files-button"
          title="Files"
          aria-label="Files"
          @click="showFiles = true"
        >
          <ClaudeMark :size="16" />
        </button>
      </div>
      <div class="mc-editor__bar-gap" />
      <div class="mc-editor__bar mc-editor__bar--right">
        <AsyncButton
          class="mc-editor__publish"
          mode="edit"
          action-label="Publish"
          waiting-label="Building"
          success-label="Published"
          error-label="Build failed"
          size="sm"
          @click="publish"
        />
        <PublishStatus
          :stage="publishStage"
          :total="publishTotal"
          :label="publishLabel"
          :error="publishError"
          :log="publishLog"
          :done="published"
        />
        <ExtensionSelect
          class="mc-editor__bar-select"
          :value="extension"
          @open="openExtension"
          @create="createExtension"
        />
      </div>
    </div>
    <div
      ref="panes"
      class="mc-editor__panes"
      :class="{ 'mc-editor__panes--dragging': dragging }"
    >
      <PodTerminal
        class="mc-editor__pane"
        :extension="extension"
        :style="{ width: `calc(${ split }% - 4px)` }"
      />
      <div
        class="mc-editor__divider"
        role="separator"
        tabindex="0"
        aria-orientation="vertical"
        aria-label="Resize the editor panes"
        :aria-valuenow="Math.round(split)"
        :aria-valuemin="10"
        :aria-valuemax="90"
        @pointerdown="startDrag"
        @pointermove="onDrag"
        @pointerup="endDrag"
        @pointercancel="endDrag"
        @keydown="onKeyDown"
        @dblclick="reset"
      >
        <span class="mc-editor__grip" />
      </div>
      <iframe
        v-if="rightUrl"
        class="mc-editor__pane mc-editor__pane--right"
        :src="rightUrl"
        :title="extension"
      />
      <div
        v-else
        class="mc-editor__pane mc-editor__pane--right mc-editor__waiting"
      >
        <RcIcon
          type="spinner"
          size="large"
          class="icon-spin"
        />
        <span>Starting the dev server for {{ extension }}</span>
        <span class="mc-editor__waiting-note">
          A first boot installs and compiles, which takes a few minutes.
        </span>
      </div>
    </div>

    <ExtensionFilesModal
      v-if="showFiles"
      :extension="extension"
      @close="showFiles = false"
    />
  </div>
</template>

<style lang="scss" scoped>
$divider-width: 8px;

.mc-editor {
  display: flex;
  flex-direction: column;
  // Fill the layout rather than the viewport. `position: fixed` and 100vh, which this used
  // when the page drew no chrome at all, would put the panes over the top-level menu, and
  // that rail is now the way out of here.
  height: 100%;
  background: var(--body-bg, #fff);

  &__bars {
    flex: 0 0 auto;
    display: flex;
    border-bottom: 1px solid var(--border, #dcdee7);
  }

  &__bar {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 8px;
    // Enough for a name and a word about it, and no more: this bar exists to label a pane,
    // not to become a second toolbar.
    padding: 6px 10px;
    min-width: 0;
    font-size: 12px;
    overflow: hidden;
    white-space: nowrap;

    &--right {
      flex: 1 1 0;
      width: auto;
    }
  }

  // The divider's width, so the two bars break where the panes do - and the divider's line,
  // so it runs from the top of the bars to the bottom of the page in one stroke. Two bars
  // separated by a gap read as one bar with a space in it; the line is what makes the sides
  // look like sides.
  &__bar-gap {
    flex:            0 0 $divider-width;
    display:         flex;
    justify-content: center;

    &::after {
      content:    '';
      width:      1px;
      background: var(--border, #dcdee7);
    }
  }

  &__bar-name {
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  &__bar-note {
    color: var(--muted, #6c6c76);
    // A build failure is a paragraph of webpack, and this bar is one line. The whole of it is
    // on the title attribute; what shows is enough to know it failed.
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }

  &__bar-error {
    color: var(--error, #f64747);
  }

  &__publish {
    flex: 0 0 auto;
  }

  // Hard against the right edge, where the link to a new tab used to be. The bar is otherwise
  // empty, so this is the whole of it.
  &__bar-select {
    margin-left: auto;
  }

  // A square with a rounded border, sized so it is the same height as the select across the
  // gap rather than the height of the glyph inside it.
  &__icon-button {
    display:         inline-flex;
    align-items:     center;
    justify-content: center;
    width:           24px;
    height:          24px;
    padding:         0;
    border:          1px solid var(--border, #dcdee7);
    border-radius:   var(--border-radius);
    background:      none;
    cursor:          pointer;
    line-height:     0;

    &:hover {
      background:   var(--accent-btn);
      border-color: var(--primary);
    }

    &:focus-visible {
      outline: 2px solid var(--primary);
    }
  }

  &__panes {
    // Fill the page; min-height lets the iframes shrink rather than overflow it.
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    width: 100%;

    // While dragging, the pointer is captured by the divider — but the iframes
    // would still take hover/selection, so switch them off for the duration.
    &--dragging .mc-editor__pane {
      pointer-events: none;
    }
  }

  &__pane {
    flex: 0 0 auto;
    height: 100%;
    border: none;

    &--right {
      flex: 1 1 0;
      width: auto;
    }
  }

  &__divider {
    flex: 0 0 $divider-width;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: col-resize;
    background: transparent;
    // The divider is a hit area; the line itself is drawn by the grip.
    user-select: none;
    touch-action: none;

    &:hover .mc-editor__grip,
    &:focus-visible .mc-editor__grip {
      width: 3px;
      background: var(--primary, #3d98d3);
    }

    &:focus-visible {
      outline: none;
    }
  }

  &__grip {
    width: 1px;
    height: 100%;
    background: var(--border, #dcdee7);
    transition: background 100ms, width 100ms;
  }

  &__waiting {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 10px;
    color: var(--muted, #6c6c76);

    &-note {
      font-size: 12px;
      opacity: 0.8;
    }
  }

}

.mc-editor__panes--dragging .mc-editor__grip {
  width: 3px;
  background: var(--primary, #3d98d3);
}
</style>

<style lang="scss">
  // Unscoped, and it has to be: everything below belongs to the shell's 'plain' template, so
  // nothing this page renders is inside the scope that would reach it. All of it is keyed on
  // a class the page puts on <html> while it is mounted (see mounted()), so no other page
  // under the same template is affected.
  html.barn-editor-page {
    // The header bar goes, the top-level menu stays. They are one element in the shell -
    // TopLevelMenu is the first child of <header> - so this cannot be `display: none`. The
    // grid row is collapsed by zeroing the variable that sizes it, the element is allowed to
    // overflow what is left, and everything in it except the menu is hidden.
    //
    // Which leaves the way out of this page intact: the rail is fixed-positioned, so it is
    // still where it always is once the row it nominally lives in is gone.
    // Through `body` rather than on the element itself: the themes declare this on `:root`,
    // which is this same element, and a class on it is no more specific than they are. One
    // step down settles it without an !important.
    body {
      --header-height: 0px;
    }

    header[data-testid="header"] {
      border:     none;
      background: none;
      overflow:   visible;
      // Zeroing the grid row is not enough on its own. The element keeps its own 55px height,
      // so it goes on overlapping the page under it, and an invisible 55px band across the top
      // swallowed every click on the bars below - which is how this was found.
      height:         0;
      min-height:     0;
      pointer-events: none;

      > *:not(:first-child) {
        display: none;
      }

      // The rail is the exception, because it is the one part of the header that stays.
      > :first-child {
        pointer-events: auto;
      }
    }

    .main-layout > .indented-panel {
      width:       100%;
      margin:      0;
      padding-top: 0 !important;
    }
  }
</style>
