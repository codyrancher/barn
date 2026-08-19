<script>
// What a publish is doing, in one line of a toolbar, and what went wrong when it does.
//
// A publish is minutes: a production build of a Rancher package, in a pod, over a websocket that
// stays open the whole time. A button that only says "Building" for four of those minutes is
// indistinguishable from a button that has hung, so this says which of the four steps it is on
// and how far along that makes it.
//
// A failure is a paragraph of webpack, which does not fit in a toolbar and must not be thrown
// away either. So the bar turns red, says the step it failed at, and opens the log when clicked.
import AppModal from '@shell/components/AppModal';
import { Card } from '@components/Card';
import { RcButton } from '@components/RcButton';

export default {
  name: 'PublishStatus',

  components: { AppModal, Card, RcButton },

  props: {
    // 0 when nothing is happening, 1..total while it is.
    stage: {
      type:    Number,
      default: 0,
    },

    total: {
      type:    Number,
      default: 0,
    },

    label: {
      type:    String,
      default: '',
    },

    // Set when the last publish failed; clears when the next one starts.
    error: {
      type:    String,
      default: '',
    },

    // Whatever the build wrote, kept whether it succeeded or not.
    log: {
      type:    String,
      default: '',
    },

    // Set when the last publish succeeded, e.g. "base 0.1.0".
    done: {
      type:    String,
      default: '',
    },
  },

  data() {
    return { showLog: false };
  },

  computed: {
    running() {
      return this.stage > 0 && !this.error;
    },

    percent() {
      return this.total ? Math.round(this.stage / this.total * 100) : 0;
    },

    // Only the last lines are worth showing first; a webpack failure puts the reason at the end.
    tail() {
      return this.log.split('\n').slice(-400).join('\n');
    },
  },
};
</script>

<template>
  <div class="publish-status">
    <button
      v-if="error"
      type="button"
      class="publish-status__failed"
      :title="error"
      @click="showLog = true"
    >
      {{ label || 'Publish' }} failed
    </button>

    <div
      v-else-if="running"
      class="publish-status__running"
      role="progressbar"
      :aria-valuenow="stage"
      :aria-valuemin="0"
      :aria-valuemax="total"
    >
      <span class="publish-status__label">{{ label }} ({{ stage }} of {{ total }})</span>
      <span class="publish-status__track">
        <span
          class="publish-status__fill"
          :style="{ width: `${ percent }%` }"
        />
      </span>
    </div>

    <button
      v-else-if="done"
      type="button"
      class="publish-status__done"
      title="Show the build log"
      @click="showLog = true"
    >
      {{ done }} installed
    </button>

    <AppModal
      v-if="showLog"
      name="barn-publish-log"
      :width="900"
      @close="showLog = false"
    >
      <Card :show-highlight-border="false">
        <template #title>
          <h4 class="text-default-text">
            {{ error ? 'Publish failed' : 'Build log' }}
          </h4>
        </template>
        <template #body>
          <p
            v-if="error"
            class="publish-status__message"
          >
            {{ error }}
          </p>
          <pre class="publish-status__log">{{ tail || 'Nothing was written.' }}</pre>
        </template>
        <template #actions>
          <RcButton
            variant="tertiary"
            @click="showLog = false"
          >
            Close
          </RcButton>
        </template>
      </Card>
    </AppModal>
  </div>
</template>

<style lang="scss" scoped>
.publish-status {
  display: flex;
  align-items: center;
  min-width: 0;

  &__running {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 160px;
  }

  &__label {
    font-size: 11px;
    color: var(--muted);
    white-space: nowrap;
  }

  &__track {
    display: block;
    height: 3px;
    border-radius: 2px;
    background: var(--border);
    overflow: hidden;
  }

  &__fill {
    display: block;
    height: 100%;
    background: var(--primary);
    transition: width 200ms;
  }

  &__failed,
  &__done {
    border: none;
    background: none;
    padding: 0;
    font-size: 12px;
    cursor: pointer;
    white-space: nowrap;
    text-decoration: underline;
  }

  &__failed {
    color: var(--error);
  }

  &__done {
    color: var(--muted);
  }

  &__message {
    margin-bottom: 10px;
    color: var(--error);
  }

  &__log {
    max-height: 55vh;
    overflow: auto;
    font-family: monospace;
    font-size: 11px;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
    margin: 0;
  }
}
</style>
