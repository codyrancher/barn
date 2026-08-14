<script>
// The Editor: a chrome-less full-screen page reached from the flask button in
// the side menu. Registered in index.ts under the 'blank' parent, which renders
// nothing but the route (unlike 'plain', which still draws a header).
//
// Left pane: a terminal in the DevExtension pod, with claude running in it (see
// components/PodTerminal.vue).
// Right pane: DevExtension's dev server (see dev-extension.ts) — the live,
// hot-reloading Rancher that same pod is serving, framed same-origin through the
// Kubernetes API service proxy, which is what makes framing it possible.
//
// So the two panes are two views of one pod: what claude edits on the left is
// what hot-reloads on the right.
import { RcButton } from '@components/RcButton';
import { RcIcon } from '@components/RcIcon';
import PodTerminal from '../components/PodTerminal.vue';
import { ensureDevExtension, devExtensionReady, devExtensionUrl } from '../dev-extension';

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

  components: { RcButton, RcIcon, PodTerminal },

  data() {
    return {
      rightUrl: '',
      // Width of the left pane, as a percentage of the page.
      split:    readSplit(),
      dragging: false,
      // Bookkeeping for the dev server poll, so it stops with the page.
      unmounted:    false,
      devPollTimer: null,
    };
  },

  watch: {
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
  },

  beforeUnmount() {
    this.unmounted = true;
    clearTimeout(this.devPollTimer);
  },

  methods: {
    // Frame the dev server once it answers. It's created when the extension
    // loads, but a cold one installs and compiles for a few minutes first, and
    // framing it before then would show the proxy's error page instead.
    async waitForDevServer() {
      ensureDevExtension();

      while (!this.unmounted) {
        if (await devExtensionReady()) {
          this.rightUrl = devExtensionUrl();

          return;
        }

        await new Promise((resolve) => {
          this.devPollTimer = setTimeout(resolve, DEV_POLL_MS);
        });
      }
    },

    goBack() {
      // Vue Router records the entry it navigated from in history.state.back;
      // it's null when the editor is the first page of the tab (the header
      // button opens it in a new one), where there is nothing to go back to.
      if (window.history.state?.back) {
        this.$router.back();
      } else {
        this.$router.push({ name: 'home' });
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
  },
};
</script>

<template>
  <div class="mc-editor">
    <header class="mc-editor__toolbar">
      <RcButton
        variant="tertiary"
        size="small"
        left-icon="chevron-left"
        @click="goBack"
      >
        Back
      </RcButton>
    </header>
    <div
      ref="panes"
      class="mc-editor__panes"
      :class="{ 'mc-editor__panes--dragging': dragging }"
    >
      <PodTerminal
        class="mc-editor__pane"
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
        title="DevExtension"
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
        <span>Starting the DevExtension dev server</span>
        <span class="mc-editor__waiting-note">
          A first boot installs and compiles, which takes a few minutes.
        </span>
      </div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
$divider-width: 8px;

.mc-editor {
  position: fixed;
  inset: 0;
  display: flex;
  flex-direction: column;
  width: 100vw;
  height: 100vh;
  background: var(--body-bg, #fff);

  &__toolbar {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 10px;
    border-bottom: 1px solid var(--border, #dcdee7);
    background: var(--header-bg, var(--body-bg, #fff));
  }

  &__panes {
    // Fill what the toolbar leaves; min-height lets the iframes shrink instead
    // of pushing the toolbar off the page.
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
