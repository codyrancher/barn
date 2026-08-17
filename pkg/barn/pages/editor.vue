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
import AsyncButton from '@shell/components/AsyncButton';
import { RcButton } from '@components/RcButton';
import PublishStatus from '../components/PublishStatus.vue';
import ExtensionFilesModal from '../components/ExtensionFilesModal.vue';
import NewExtensionModal from '../components/NewExtensionModal.vue';
import StartingExtensions from '../components/StartingExtensions.vue';
import {
  ensureExtension, extensionReady, extensionUrl, extensionProxyPath, publishExtension,
  DEFAULT_EXTENSION
} from '../extensions';

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
    RcIcon, RcButton, PodTerminal, ExtensionSelect, ExtensionFilesModal, NewExtensionModal, StartingExtensions, AsyncButton,
    PublishStatus
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
      // The name typed into the box that does not exist yet, held while the modal asks what it
      // should be a copy of.
      creating:  '',
      // Extensions that have been asked for and are coming up. A list rather than one, because
      // nothing here stops you asking for a second while the first is still installing.
      starting:  [],
      // What the right pane is showing, as a path inside the framed dashboard. Kept in sync
      // with the iframe by a poll rather than by its load event, because the thing in there is
      // a single-page app: it changes its URL with pushState and never loads again.
      address:      '',
      addressFocused: false,
      addressTimer: null,
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

    /**
     * What the pop-out opens: where the pane is now, not where it started.
     *
     * Built from the address rather than from `rightUrl`, so somebody who has navigated three
     * pages into the framed dashboard gets those three pages rather than its front door.
     */
    popoutUrl() {
      const path = this.address.startsWith('/') ? this.address : `/${ this.address }`;

      return this.rightUrl ? `${ extensionProxyPath(this.extension) }${ path }` : '';
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
    this.addressTimer = setInterval(() => this.readAddress(), 1000);

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
    clearInterval(this.addressTimer);
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

    /**
     * Where the framed dashboard currently is.
     *
     * Readable at all because it is same-origin: the pane is served through the apiserver's
     * proxy, which is on Rancher's own origin, so this is an ordinary property access rather
     * than something that needs the frame to cooperate. The try/catch is for the moment during
     * a navigation when contentWindow is briefly not there.
     *
     * The proxy prefix comes off for display. Leaving it on would mean a box that is three
     * quarters boilerplate and whose interesting part is off the right-hand edge.
     */
    readAddress() {
      if (this.addressFocused) {
        return;
      }

      try {
        const href = this.$refs.frame?.contentWindow?.location?.href;

        if (href) {
          this.address = href.replace(window.location.origin, '').replace(extensionProxyPath(this.extension), '') || '/';
        }
      } catch { /* mid-navigation, or not framed yet */ }
    },

    /**
     * Back and forward inside the framed dashboard.
     *
     * Its own history rather than the browser's: the pane is same-origin, so this is the
     * ordinary History API on the frame's window. Using the outer browser's would take the
     * whole editor back instead, which is the opposite of what a button next to that address
     * should do.
     */
    history(delta) {
      try {
        this.$refs.frame?.contentWindow?.history?.go(delta);
      } catch { /* mid-navigation */ }
    },

    /** Go where the box says. A path, so what is typed reads like a Rancher URL. */
    go() {
      const path = this.address.startsWith('/') ? this.address : `/${ this.address }`;

      this.$refs.frame.contentWindow.location.href = `${ extensionProxyPath(this.extension) }${ path }`;
      this.$refs.address?.blur();
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

    // A name that is not one of ours yet. What it should start as is a question rather than a
    // default, so this opens the modal instead of creating anything.
    createExtension(name) {
      this.creating = name;
    },

    /**
     * Make it, and stay here.
     *
     * The wait goes on the strip under the actions rather than on a page of its own. Three to
     * ten minutes is a long time to be sent away from the extension you were working on, and
     * that extension goes on working the whole time.
     */
    async onCreate({ name, source, done }) {
      this.creating = '';

      if (!this.starting.includes(name)) {
        this.starting = [...this.starting, name];
      }

      try {
        await ensureExtension(name, source);
        done(true);
      } catch (e) {
        done(false);
        this.starting = this.starting.filter((each) => each !== name);
        this.publishError = e.message || String(e);
      }
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
        <RcButton
          variant="secondary"
          size="small"
          data-testid="barn-agent-files-button"
          @click="showFiles = true"
        >
          Files
        </RcButton>
      </div>
      <div class="mc-editor__bar-gap" />
      <div class="mc-editor__bar mc-editor__bar--right">
        <a
          class="mc-editor__popout"
          :class="{ 'mc-editor__popout--disabled': !rightUrl }"
          :href="popoutUrl"
          target="_blank"
          rel="noopener"
          title="Open this page on its own"
          aria-label="Open this page on its own"
        >
          <i class="icon icon-external-link" />
        </a>
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
      </div>
    </div>


    <StartingExtensions
      :names="starting"
      @open="openExtension"
      @dismiss="starting = starting.filter((each) => each !== $event)"
    />

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
      <div class="mc-editor__right">
        <!--
          The address, over the pane it is about. Nothing else on the action bar is about that
          pane, and at the width a bar shared with three controls left it, a Rancher path was
          mostly off the end.
        -->
        <div class="mc-editor__addressbar">
          <button
            type="button"
            class="mc-editor__nav"
            title="Back"
            aria-label="Back"
            :disabled="!rightUrl"
            @click="history(-1)"
          >
            <i class="icon icon-chevron-left" />
          </button>
          <button
            type="button"
            class="mc-editor__nav"
            title="Forward"
            aria-label="Forward"
            :disabled="!rightUrl"
            @click="history(1)"
          >
            <i class="icon icon-chevron-right" />
          </button>
          <input
            ref="address"
            v-model="address"
            class="mc-editor__address"
            spellcheck="false"
            aria-label="Address of the framed dashboard"
            :disabled="!rightUrl"
            @focus="addressFocused = true"
            @blur="addressFocused = false"
            @keydown.enter="go"
          >
        </div>
        <iframe
          v-if="rightUrl"
          ref="frame"
          class="mc-editor__frame"
          :src="rightUrl"
          :title="extension"
          @load="readAddress"
        />
        <div
          v-else
          class="mc-editor__frame mc-editor__waiting"
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
    </div>

    <ExtensionFilesModal
      v-if="showFiles"
      :extension="extension"
      @close="showFiles = false"
    />

    <NewExtensionModal
      v-if="creating"
      :name="creating"
      @close="creating = ''"
      @create="onCreate"
    />
  </div>
</template>

<style lang="scss" scoped>
$divider-width: 8px;
// Every control on the action bar is this tall.
$control-height: 30px;
// The recessed strip over the framed pane, and everything in it.
$address-height: 28px;

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

  // One height for everything on the bar, said once. None of the shell's size props is this
  // number - small is 24 and the default is 30 - and a bar whose controls are three different
  // heights is what it looked like while each of them was left to its own.
  &__bar button,
  &__bar a,
  &__bar :deep(.vs__dropdown-toggle) {
    height:     $control-height;
    min-height: $control-height;
  }

  // `.labeled-select` is on the same element and is deliberately part of the selector: the
  // shell sets the padding below through a rule of its own with two classes in it, so a
  // two-class selector here is a tie that its stylesheet wins by loading later. Three classes
  // settles it without an !important that the next person has to argue with.
  &__bar-select.labeled-select {
    // A container above the input for a label there isn't, which made the select taller than
    // the part of it you can click.
    :deep(.labeled-container) {
      display: none;
    }

    :deep(.vs__dropdown-toggle) {
      display:     flex;
      align-items: center;
      padding:     0;
    }

    // The reason the text sat above centre: 8px of padding above it, 7 below, and a -5px
    // margin pulling the whole row up inside a box we had given a fixed height.
    :deep(.vs__selected-options) {
      padding:     0 0 0 8px;
      margin:      0;
      align-items: center;
      min-height:  0;
      flex-wrap:   nowrap;
    }

    :deep(.vs__selected),
    :deep(.vs__search) {
      margin:   0;
      padding:  0;
      position: static;
    }

    :deep(.vs__actions) {
      padding: 0 8px 0 4px;
    }

  }

  // The chevron is not the `.vs__open-indicator` svg - the shell hides that and draws its own in
  // the icon font on `.vs__actions::after`, 32px tall with 8px of padding above it and a 2px
  // upward nudge, all of which was for the padded row this no longer has.
  //
  // The selector carries `.no-label.compact-input` because the shell's does, and its rule has
  // one more class than the version of this that only said `.labeled-select` - which is why
  // that version changed the size and left the offset exactly where it was.
  &__bar-select.labeled-select.no-label.compact-input :deep(.vs__actions)::after {
    height:      auto;
    padding-top: 0;
    margin:      0;
    font-size:   18px;
    line-height: 1;
    top:         0;
  }

  // The right-hand side is a column: the address, then the frame. Not a row above the panes,
  // which is where this started and which pushed the terminal and the divider down by its own
  // height so that neither reached the action bar.
  &__right {
    flex:           1 1 0;
    min-width:      0;
    display:        flex;
    flex-direction: column;
  }

  // The address and the two buttons in front of it are one recessed strip: same background,
  // same bottom border, no gaps, so it reads as the top edge of the pane rather than as three
  // controls that happen to be next to each other.
  &__addressbar {
    flex:          0 0 auto;
    display:       flex;
    align-items:   stretch;
    height:        $address-height;
    background:    var(--body-bg, #fff);
    border-bottom: 1px solid var(--border, #dcdee7);
    box-shadow:    inset 0 1px 2px rgba(0, 0, 0, 0.06);
  }

  &__nav {
    flex:            0 0 auto;
    width:           28px;
    display:         inline-flex;
    align-items:     center;
    justify-content: center;
    padding:         0;
    border:          none;
    background:      none;
    // Chrome rather than a link: these are the same kind of thing as the border they sit on,
    // and in link blue they were the loudest thing on a strip whose job is to be quiet.
    color:           var(--muted);
    cursor:          pointer;
    line-height:     0;
    // Both, because the shell gives every button a minimum height for touch targets. Without
    // it these were 40px tall inside a 28px strip and hung out of both edges of it.
    height:          100%;
    min-height:      0;

    i {
      font-size: 16px;
    }

    &:hover:not(:disabled) {
      background: var(--accent-btn);
      color:      var(--body-text);
    }

    &:disabled {
      opacity: 0.4;
      cursor:  default;
    }
  }

  // A hairline between the buttons and the text, so the strip reads as two things rather than
  // as an address that happens to start with two arrows.
  &__nav + &__address {
    border-left: 1px solid var(--border, #dcdee7);
    margin-left: 4px;
    padding-left: 10px;
  }

  &__frame {
    flex:      1 1 auto;
    min-height: 0;
    width:     100%;
    border:    none;
  }

  &__popout {
    display:         inline-flex;
    align-items:     center;
    justify-content: center;
    flex:            0 0 auto;
    // Square, and the height of everything else on the bar.
    width:           $control-height;
    // Everything after it is pushed to the far end, so the bar reads as: this pane, then what
    // is happening to it, then what you can do.
    margin-right:    auto;
    border:          1px solid var(--border, #dcdee7);
    border-radius:   var(--border-radius);
    color:           var(--link);

    &:hover {
      background:   var(--accent-btn);
      border-color: var(--primary);
    }

    &--disabled {
      pointer-events: none;
      opacity:        0.5;
    }
  }

  // Square and edge to edge, and carrying none of the strip's own chrome: the strip draws the
  // border and the inset, this is just where the text goes.
  &__address {
    flex:          1 1 auto;
    min-width:     0;
    padding:       0 8px;
    border:        none;
    border-radius: 0;
    background:    none;
    color:         var(--body-text);
    font-family:   monospace;
    font-size:     12px;

    &:focus {
      outline: none;
    }

    &:disabled {
      color: var(--muted);
    }
  }

  &__bar-select {
    flex: 0 0 auto;

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
