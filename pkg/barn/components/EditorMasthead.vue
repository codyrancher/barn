<script>
// The masthead from the Extension Studio design (Figma frame 03, node 9:177).
//
// Built to the design, and honest about which half of it exists. Four things are real, because
// the code behind them is: the extension's name, the branch it is on, the cluster the preview
// runs in, and Publish. The rest is drawn to the design and says so when pressed - a control
// that looks finished and silently does nothing is worse than one that admits it, because a
// person cannot tell it apart from a bug in something that does work.
//
// Every placeholder goes through toastNotYet, which names the control in the message, so a
// report of one is actionable without a screenshot.
import { RcButton } from '@components/RcButton';
import PublishSplit from './PublishSplit.vue';
import { toastNotYet } from '../toast';
import { listBranches, EXT_NS } from '../extensions';
import '../design/tokens';

export default {
  name: 'EditorMasthead',

  components: { RcButton, PublishSplit },

  props: {
    extension: {
      type:     String,
      required: true,
    },

    /** Passed through to the publish button, which is the one action here that is wired. */
    publishOptions: {
      type:    Array,
      default: () => [],
    },

    publishing: {
      type:    Boolean,
      default: false,
    },
  },

  emits: ['back', 'publish', 'publish-select', 'files'],

  data() {
    return { branch: '' };
  },

  computed: {
    // The design shows "Preview on: local". It is `local` for the same reason EXT_CLUSTER is:
    // the pod runs in the cluster this extension is installed into.
    previewOn() {
      return 'local';
    },

    namespace() {
      return EXT_NS;
    },
  },

  async mounted() {
    // Real: the pod's package is a git repository, so this is the branch it is actually on.
    const branches = await listBranches(this.extension).catch(() => null);

    this.branch = branches?.current || '';
  },

  methods: {
    notYet(what) {
      toastNotYet(this.$store, what);
    },
  },
};
</script>

<template>
  <div class="studio-masthead">
    <!-- Real: leaves the editor the way every other page does. -->
    <button
      type="button"
      class="studio-masthead__icon"
      aria-label="Back"
      @click="$emit('back')"
    >
      <i class="icon icon-chevron-left" />
    </button>

    <div class="studio-masthead__name">
      <div class="studio-masthead__title">
        {{ extension }}
      </div>
      <div class="studio-masthead__eyebrow">
        Extension Studio
      </div>
    </div>

    <!--
      Placeholder. The design's state pill mirrors Rancher's cluster-state pill and says
      "Unsaved"; knowing that means diffing the pod's tree against its last commit on every
      change, which nothing does yet.
    -->
    <button
      type="button"
      class="studio-masthead__badge"
      @click="notYet('Unsaved state badge')"
    >
      Unsaved
    </button>

    <!-- Real: the branch the pod's package repository is on. -->
    <div
      v-if="branch"
      class="studio-masthead__chip"
    >
      <i class="icon icon-git" />
      <span>{{ branch }}</span>
    </div>

    <!-- Real: the cluster the preview is served from. -->
    <div class="studio-masthead__chip">
      <i class="icon icon-dot" />
      <span>Preview on: {{ previewOn }}</span>
    </div>

    <!-- Placeholder: there is no notion of a phase or a change count since a version. -->
    <button
      type="button"
      class="studio-masthead__chip studio-masthead__chip--info"
      @click="notYet('Phase chip')"
    >
      <i class="icon icon-refresh" />
      <span>Iterating</span>
    </button>

    <div class="studio-masthead__grow" />

    <!-- Placeholder: nothing snapshots the tree, so there is nothing to have saved. -->
    <button
      type="button"
      class="studio-masthead__autosave"
      @click="notYet('Snapshot / autosave')"
    >
      <i class="icon icon-info" />
      <span>Snapshots</span>
    </button>

    <!-- Placeholder: undo would need those snapshots to exist first. -->
    <RcButton
      variant="link"
      size="small"
      @click="notYet('Undo last change')"
    >
      Undo last change
    </RcButton>

    <!-- Real: the Files tab already shows a diff of the working tree against its history. -->
    <RcButton
      variant="secondary"
      size="small"
      @click="$emit('files')"
    >
      See what changed
    </RcButton>

    <!-- Real: the existing split button, unchanged. -->
    <PublishSplit
      class="studio-masthead__publish"
      label="Publish"
      aria-label-trigger="Other ways to publish"
      :items="publishOptions"
      :disabled="publishing"
      @click="$emit('publish')"
      @select="$emit('publish-select', $event)"
    />

    <button
      type="button"
      class="studio-masthead__icon"
      aria-label="More"
      @click="notYet('Masthead overflow menu')"
    >
      <i class="icon icon-actions" />
    </button>
  </div>
</template>

<style lang="scss" scoped>
// Figure 9:177: row, align center, gap 10, padding 10/16, 1px bottom border.
.studio-masthead {
  display:       flex;
  align-items:   center;
  gap:           var(--studio-gap);
  padding:       var(--studio-pad-y) var(--studio-pad-x);
  border-bottom: 1px solid var(--studio-line);
  background:    var(--studio-surface);
  flex:          0 0 auto;
  min-width:     0;

  &__name {
    display:        flex;
    flex-direction: column;
    gap:            1px;
    min-width:      0;
  }

  &__title {
    font:      var(--studio-heading-16);
    color:     var(--studio-text);
    overflow:  hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  // Caption/11 SemiBold Caps, with the design's 5.45% tracking.
  &__eyebrow {
    font:           600 11px/1.27 var(--body-font, 'Lato', sans-serif);
    letter-spacing: 0.0545em;
    text-transform: uppercase;
    color:          var(--studio-text-muted);
  }

  &__badge {
    padding:       4px 9px;
    border:        none;
    border-radius: var(--studio-radius);
    background:    var(--studio-warn-bg);
    color:         var(--studio-warn-text);
    font:          var(--studio-caption-12);
    cursor:        pointer;
  }

  &__chip {
    display:       inline-flex;
    align-items:   center;
    gap:           var(--studio-gap-tight);
    padding:       4px 8px;
    border:        1px solid var(--studio-line);
    border-radius: var(--studio-radius-chip);
    background:    var(--studio-surface-sunken);
    color:         var(--studio-text-strong);
    font:          var(--studio-caption-12);
    white-space:   nowrap;

    .icon {
      font-size: 13px;
    }

    &--info {
      border-color: transparent;
      background:   var(--studio-info-bg);
      color:        var(--studio-info-text);
      cursor:       pointer;
    }
  }

  &__grow {
    flex: 1 1 auto;
  }

  &__autosave {
    display:     inline-flex;
    align-items: center;
    gap:         var(--studio-gap-tight);
    border:      none;
    background:  transparent;
    color:       var(--studio-text-muted);
    font:        var(--studio-caption-12);
    cursor:      pointer;
    white-space: nowrap;
  }

  &__icon {
    display:         inline-flex;
    align-items:     center;
    justify-content: center;
    width:           26px;
    height:          26px;
    border:          none;
    border-radius:   var(--studio-radius);
    background:      transparent;
    color:           var(--studio-text-strong);
    cursor:          pointer;

    &:hover {
      background: var(--studio-surface-sunken);
    }
  }

  &__publish {
    flex: 0 0 auto;
  }
}
</style>
