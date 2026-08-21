<script>
// What the editor shows while it is making the things it needs.
//
// The install used to be invisible: three functions ran on load, swallowed anything that went
// wrong, and the only symptom was an editor that took minutes to work or quietly never did.
// This is the same work with the lid off - every object, one sentence on why it exists, and a
// link into Rancher for anybody who wants to see the thing itself rather than take our word.
//
// It drives the install as well as showing it. That is safe to do from more than one tab at
// once, and the reason is worth stating: each step reads the cluster before it writes, and a
// 409 from losing that race counts as success. So two tabs, or one tab refreshed half way,
// converge on the same result instead of fighting over it.
import { runInstall, installState, stepLink } from '../install';

export default {
  name: 'InstallProgress',

  props: {
    extension: {
      type:     String,
      required: true,
    },

    /** Installing a fresh cluster, or bringing an existing one up to date. Only the words differ. */
    mode: {
      type:    String,
      default: 'install',
    },
  },

  emits: ['done'],

  data() {
    return { progress: [], running: false };
  },

  computed: {
    title() {
      return this.mode === 'update' ? 'Updating the editor' : 'Setting up the editor';
    },

    subtitle() {
      return this.mode === 'update'
        ? 'Bringing this cluster up to date with the version you just installed. What is already right is left alone.'
        : 'Making what the editor needs in this cluster. This happens once; afterwards the editor opens straight away.';
    },

    total() {
      return this.progress.length;
    },

    complete() {
      return this.progress.filter((entry) => entry.state === 'done').length;
    },

    failed() {
      return this.progress.filter((entry) => entry.state === 'failed');
    },

    finished() {
      return this.total > 0 && this.progress.every((entry) => entry.state === 'done' || entry.state === 'failed');
    },
  },

  async mounted() {
    // What is already there, before anything is made, so a cluster that only needs one object
    // does not flash a list of nine as though it were about to build them all.
    this.progress = await installState(this.extension).catch(() => []);
    await this.run();
  },

  methods: {
    stepLink,

    async run() {
      this.running = true;
      this.progress = await runInstall(this.extension, (progress) => {
        this.progress = progress;
      });
      this.running = false;

      if (!this.failed.length) {
        this.$emit('done');
      }
    },

    icon(state) {
      return {
        waiting:  'icon-dot',
        checking: 'icon-spinner icon-spin',
        creating: 'icon-spinner icon-spin',
        done:     'icon-checkmark',
        failed:   'icon-warning',
      }[state] || 'icon-dot';
    },
  },
};
</script>

<template>
  <div class="install">
    <div class="install__head">
      <h2 class="install__title">
        {{ title }}
      </h2>
      <p class="install__subtitle">
        {{ subtitle }}
      </p>
      <div class="install__count">
        {{ complete }} of {{ total }}
      </div>
    </div>

    <ul class="install__steps">
      <li
        v-for="entry in progress"
        :key="entry.step.id"
        class="install__step"
        :class="`install__step--${ entry.state }`"
      >
        <i
          class="icon install__icon"
          :class="icon(entry.state)"
        />
        <div class="install__body">
          <a
            :href="stepLink(entry.step)"
            class="install__label"
            target="_blank"
            rel="noopener"
          >{{ entry.step.label }}</a>
          <div class="install__description">
            {{ entry.step.description }}
          </div>
          <div
            v-if="entry.error"
            class="install__error"
          >
            {{ entry.error }}
          </div>
        </div>
      </li>
    </ul>

    <div
      v-if="finished && failed.length"
      class="install__footer"
    >
      <span>{{ failed.length }} of {{ total }} could not be made. The rest were.</span>
      <a
        href="#"
        @click.prevent="run"
      >Try those again</a>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.install {
  display:        flex;
  flex-direction: column;
  gap:            14px;
  padding:        24px;
  max-width:      760px;
  margin:         0 auto;
  overflow-y:     auto;

  &__title {
    margin: 0;
  }

  &__subtitle {
    margin:    4px 0 0;
    color:     var(--muted);
    max-width: 70ch;
  }

  &__count {
    margin-top: 8px;
    color:      var(--muted);
    font-size:  12px;
  }

  &__steps {
    list-style: none;
    margin:     0;
    padding:    0;
    display:    flex;
    flex-direction: column;
    gap:        2px;
  }

  &__step {
    display:       grid;
    grid-template-columns: 20px 1fr;
    gap:           10px;
    padding:       10px;
    border:        1px solid transparent;
    border-radius: var(--border-radius);

    &--creating,
    &--checking {
      border-color: var(--border);
      background:   var(--accent-btn);
    }

    &--failed {
      border-color: var(--error);
    }

    // Made already, and not the thing to look at.
    &--waiting .install__label,
    &--waiting .install__description {
      opacity: 0.6;
    }
  }

  &__icon {
    line-height: 20px;

    .install__step--done & {
      color: var(--success);
    }

    .install__step--failed & {
      color: var(--error);
    }

    .install__step--waiting & {
      color: var(--muted);
    }
  }

  &__label {
    font-family: monospace;
    font-size:   13px;
  }

  &__description {
    color:     var(--muted);
    font-size: 12px;
    max-width: 70ch;
  }

  &__error {
    margin-top: 4px;
    color:      var(--error);
    font-size:  12px;
  }

  &__footer {
    display:     flex;
    gap:         10px;
    align-items: center;
    color:       var(--muted);
    font-size:   12px;
  }
}
</style>
