<script>
// The wait after a new extension is asked for.
//
// Creating one is four objects and takes a moment. What takes minutes is what happens next,
// in the pod: pulling node, writing the seeded tree out of the ConfigMap, `yarn install`, and
// then a full Rancher dashboard compile. None of that reports progress anywhere this page can
// read it cheaply, so rather than invent a percentage this shows the three things it can
// actually observe, in order, and says plainly that the first boot is slow.
//
// It is a route rather than a state of the editor page because the editor is a terminal in the
// pod beside the dev server it serves, and for most of this wait neither of those exists.
import { RcIcon } from '@components/RcIcon';
import { RcButton } from '@components/RcButton';
import {
  ensureExtension, extensionPod, extensionReady, extensionUrl
} from '../extensions';
import { EDITOR_ROUTE } from '../editor-product';

// How often to look. The whole wait is minutes and every check is two requests, so asking
// faster would only add load to the cluster that is trying to compile.
const POLL_MS = 5000;

export default {
  name: 'BarnExtensionStarting',

  components: { RcIcon, RcButton },

  data() {
    return {
      pod:       '',
      ready:     false,
      unmounted: false,
      timer:     null,
      // When this page was opened, so the wait can say how long it has been rather than
      // leaving somebody to guess whether it is stuck.
      startedAt: Date.now(),
      elapsed:   0,
      elapsedTimer: null,
    };
  },

  computed: {
    name() {
      return this.$route.params.extension;
    },

    url() {
      return extensionUrl(this.name);
    },

    /**
     * The three observable stages, and which one is current.
     *
     * `done` rather than a single index, because they do not always advance in order: a pod
     * that is restarted goes back to waiting, and a page opened on an extension that is
     * already up should show all three done rather than animate through them.
     */
    stages() {
      return [
        {
          label: 'Creating the objects in the cluster',
          done:  true,
        },
        {
          label: 'Waiting for the pod',
          done:  !!this.pod,
        },
        {
          label: 'Installing and compiling',
          done:  this.ready,
          note:  'A first boot installs a dashboard and compiles it, which takes a few minutes.',
        },
      ];
    },

    elapsedLabel() {
      const minutes = Math.floor(this.elapsed / 60);
      const seconds = this.elapsed % 60;

      return minutes ? `${ minutes }m ${ seconds }s` : `${ seconds }s`;
    },
  },

  mounted() {
    // Re-asserted rather than assumed. This page is reachable by its URL, and somebody who
    // opens it for an extension that was never created should get one created rather than a
    // spinner that will never finish.
    ensureExtension(this.name);
    this.watch();

    this.elapsedTimer = setInterval(() => {
      this.elapsed = Math.floor((Date.now() - this.startedAt) / 1000);
    }, 1000);
  },

  beforeUnmount() {
    this.unmounted = true;
    clearTimeout(this.timer);
    clearInterval(this.elapsedTimer);
  },

  methods: {
    async watch() {
      while (!this.unmounted) {
        this.pod = await extensionPod(this.name).catch(() => null) || '';
        this.ready = await extensionReady(this.name);

        if (this.ready) {
          // Straight into the editor for it, which is where somebody who just made an
          // extension was going. `replace`, so Back leaves rather than returning to a wait
          // that is over.
          this.$router.replace({ name: EDITOR_ROUTE, params: { extension: this.name } });

          return;
        }

        await new Promise((resolve) => {
          this.timer = setTimeout(resolve, POLL_MS);
        });
      }
    },
  },
};
</script>

<template>
  <div class="barn-starting">
    <h1>Starting {{ name }}</h1>
    <p class="barn-starting__subtitle">
      A dev server for this extension is coming up as a pod in the cluster. This page goes to
      the editor as soon as it serves.
    </p>

    <ol class="barn-starting__stages">
      <li
        v-for="stage in stages"
        :key="stage.label"
        class="barn-starting__stage"
        :class="{ 'barn-starting__stage--done': stage.done }"
      >
        <RcIcon
          v-if="stage.done"
          type="checkmark"
          class="barn-starting__tick"
        />
        <RcIcon
          v-else
          type="spinner"
          class="icon-spin"
        />
        <div>
          <div>{{ stage.label }}</div>
          <div
            v-if="stage.note && !stage.done"
            class="barn-starting__note"
          >
            {{ stage.note }}
          </div>
        </div>
      </li>
    </ol>

    <p class="barn-starting__elapsed">
      {{ elapsedLabel }} so far<span v-if="pod"> &middot; pod {{ pod }}</span>
    </p>

    <RcButton
      variant="tertiary"
      size="small"
      :to="url"
      target="_blank"
    >
      Open it anyway
    </RcButton>
  </div>
</template>

<style lang="scss" scoped>
.barn-starting {
  max-width: 70ch;
  padding-top: 20px;

  &__subtitle {
    color: var(--muted);
    margin-bottom: 30px;
  }

  &__stages {
    list-style: none;
    margin: 0 0 20px 0;
    padding: 0;
  }

  &__stage {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 8px 0;
    color: var(--muted);

    &--done {
      color: var(--body-text);
    }
  }

  &__tick {
    color: var(--success);
  }

  &__note {
    font-size: 12px;
    color: var(--muted);
  }

  &__elapsed {
    color: var(--muted);
    font-size: 12px;
    margin-bottom: 20px;
  }
}
</style>
