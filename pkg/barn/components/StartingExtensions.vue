<script>
// Extensions that are coming up, on a strip under the editor's actions.
//
// Creating one used to take you to a page of its own that did nothing but wait, which is a poor
// trade for the three to ten minutes it takes: you are sent away from the thing you were working
// on to watch a spinner, and the extension you were editing is still perfectly usable. So the
// wait moved here. It is a strip rather than a page, several can be on it at once, and switching
// extensions in the box above does not disturb it.
//
// It reports the three things it can actually observe, in order, rather than inventing a
// percentage: the objects exist, the pod is up, and the dev server answers. The last one is the
// long pole, because it is a yarn install and a full dashboard compile.
import { extensionPod, extensionReady } from '../extensions';

// The whole wait is minutes and each check is two requests, so asking faster would only add load
// to the cluster that is trying to compile.
const POLL_MS = 5000;

export default {
  name: 'StartingExtensions',

  props: {
    // The names being created, in the order they were asked for.
    names: {
      type:    Array,
      default: () => [],
    },
  },

  emits: ['ready', 'open', 'dismiss'],

  data() {
    return {
      // name -> { pod, ready, since }
      state: {},
      timer: null,
    };
  },

  computed: {
    rows() {
      return this.names.map((name) => {
        const state = this.state[name] || {};
        const stage = state.ready ? 3 : (state.pod ? 2 : 1);

        return {
          name,
          stage,
          total: 3,
          ready: !!state.ready,
          label: ['Creating the objects', 'Waiting for the pod', 'Installing and compiling'][stage - 1],
          since: state.since ? this.elapsed(state.since) : '',
        };
      });
    },
  },

  watch: {
    names: {
      immediate: true,
      handler(names) {
        for (const name of names) {
          if (!this.state[name]) {
            this.state[name] = { pod: '', ready: false, since: Date.now() };
          }
        }
      },
    },
  },

  mounted() {
    this.check();
    this.timer = setInterval(() => this.check(), POLL_MS);
  },

  beforeUnmount() {
    clearInterval(this.timer);
  },

  methods: {
    async check() {
      for (const name of this.names) {
        const pod = await extensionPod(name).catch(() => null);
        const ready = pod ? await extensionReady(name) : false;
        const was = this.state[name] || { since: Date.now() };

        this.state = {
          ...this.state, [name]: { ...was, pod: pod || '', ready }
        };

        if (ready && !was.ready) {
          this.$emit('ready', name);
        }
      }
    },

    elapsed(since) {
      const seconds = Math.floor((Date.now() - since) / 1000);
      const minutes = Math.floor(seconds / 60);

      return minutes ? `${ minutes }m` : `${ seconds }s`;
    },
  },
};
</script>

<template>
  <div
    v-if="rows.length"
    class="starting"
  >
    <div
      v-for="row in rows"
      :key="row.name"
      class="starting__row"
    >
      <span class="starting__name">{{ row.name }}</span>
      <span class="starting__label">{{ row.ready ? 'Ready' : `${ row.label } (${ row.stage } of ${ row.total })` }}</span>
      <span class="starting__track">
        <span
          class="starting__fill"
          :style="{ width: `${ Math.round(row.stage / row.total * 100) }%` }"
        />
      </span>
      <span class="starting__since">{{ row.since }}</span>
      <button
        v-if="row.ready"
        type="button"
        class="starting__action"
        @click="$emit('open', row.name)"
      >
        Open
      </button>
      <button
        type="button"
        class="starting__action"
        :title="row.ready ? 'Hide this' : 'Stop watching; it carries on coming up'"
        @click="$emit('dismiss', row.name)"
      >
        Dismiss
      </button>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.starting {
  flex:          0 0 auto;
  border-bottom: 1px solid var(--border, #dcdee7);

  &__row {
    display:     flex;
    align-items: center;
    gap:         10px;
    padding:     4px 10px;
    font-size:   11px;
  }

  &__name {
    font-family: monospace;
    font-weight: 600;
  }

  &__label {
    color: var(--muted);
  }

  &__track {
    // Takes the room the words do not, so the bar is the part that grows.
    flex:          1 1 auto;
    min-width:     60px;
    height:        3px;
    border-radius: 2px;
    background:    var(--border);
    overflow:      hidden;
  }

  &__fill {
    display:    block;
    height:     100%;
    background: var(--primary);
    transition: width 200ms;
  }

  &__since {
    color: var(--muted);
  }

  &__action {
    border:          none;
    background:      none;
    padding:         0;
    color:           var(--link);
    font-size:       11px;
    cursor:          pointer;
    text-decoration: underline;
  }
}
</style>
