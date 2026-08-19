<script>
// Where to push, asked at the moment of pushing.
//
// This was a setting once, on the assumption that an extension has a repository the way it has
// a name. It does not: it has one the first time somebody decides it does, and the decision is
// worth seeing again on the next push rather than being applied silently to it.
//
// So the answer is remembered and offered back, and the question is still asked. Blank the
// first time, filled in and one Return away every time after that.
import AppModal from '@shell/components/AppModal';
import AsyncButton from '@shell/components/AsyncButton';
import { LabeledInput } from '@components/Form/LabeledInput';
import { Card } from '@components/Card';
import { RcButton } from '@components/RcButton';
import { Banner } from '@components/Banner';
import { readSettings } from '../extensions';

export default {
  name: 'PublishGithubModal',

  components: {
    AppModal, AsyncButton, Card, RcButton, Banner, LabeledInput
  },

  props: {
    /** Which extension is being published, which is whose remembered answer to offer back. */
    extension: {
      type:     String,
      required: true,
    },
  },

  emits: ['close', 'publish', 'settings'],

  data() {
    return {
      repo:     '',
      hasToken: true,
      loading:  true,
    };
  },

  computed: {
    repoInvalid() {
      return !!this.repo && !/^[\w.-]+\/[\w.-]+$/.test(this.repo);
    },

    canPublish() {
      return !!this.repo && !this.repoInvalid && this.hasToken;
    },
  },

  async mounted() {
    // Both halves come from the same Secret: what was pushed to last time, and whether there
    // is a token to push with at all. Failing to read it is the same as having neither.
    const settings = await readSettings(this.extension).catch(() => ({ repo: '', hasToken: false }));

    this.repo = settings.repo;
    this.hasToken = settings.hasToken;
    this.loading = false;
  },

  methods: {
    publish(done) {
      if (!this.canPublish) {
        done(false);

        return;
      }

      // The page runs it, because the page owns the status strip the progress goes to. `done`
      // travels with it so the button stays busy until the push is over.
      this.$emit('publish', { repo: this.repo, done });
    },
  },
};
</script>

<template>
  <AppModal
    name="barn-publish-github"
    :width="560"
    @close="$emit('close')"
  >
    <Card
      class="publish-github"
      :show-highlight-border="false"
    >
      <template #title>
        <h4 class="text-default-text">
          Publish {{ extension }} to GitHub
        </h4>
      </template>

      <template #body>
        <Banner
          v-if="!loading && !hasToken"
          color="warning"
        >
          <span>
            There is no GitHub token yet, and pushing needs one.
            <a
              href="#"
              @click.prevent="$emit('settings')"
            >Add one in settings</a>, then come back.
          </span>
        </Banner>

        <LabeledInput
          v-model:value="repo"
          label="GitHub repository"
          placeholder="owner/name"
          :disabled="loading"
          class="publish-github__field"
        />
        <p
          v-if="repoInvalid"
          class="publish-github__hint publish-github__hint--error"
        >
          That has to be owner/name.
        </p>
      </template>

      <template #actions>
        <div class="publish-github__actions">
          <RcButton
            variant="tertiary"
            @click="$emit('close')"
          >
            Cancel
          </RcButton>
          <AsyncButton
            mode="edit"
            action-label="Publish"
            waiting-label="Pushing"
            success-label="Pushed"
            error-label="Push failed"
            :disabled="!canPublish"
            @click="publish"
          />
        </div>
      </template>
    </Card>
  </AppModal>
</template>

<style lang="scss" scoped>
.publish-github {
  &__field {
    margin-top: 10px;
  }

  &__hint {
    margin: 4px 0 10px;
    color: var(--muted);
    font-size: 12px;

    &--error {
      color: var(--error);
    }
  }

  &__actions {
    display:         flex;
    gap:             10px;
    justify-content: flex-end;
    width:           100%;
  }
}
</style>
