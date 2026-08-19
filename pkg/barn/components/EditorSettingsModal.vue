<script>
// What the editor is configured with, which is currently the two things publishing to GitHub
// needs and cannot work out for itself.
//
// The token is write-only from here. It is stored in a Secret rather than this browser (see
// SETTINGS_SECRET) because the thing that eventually spends it is a pod, and it never comes
// back out: the field says whether one is set and offers to replace it, which is the whole of
// what a settings form has to know. Showing a saved credential back to the page would put it
// in the DOM of a tab somebody leaves open on a shared screen, and buys nothing - nobody
// reads a token to check it, they replace it.
import AppModal from '@shell/components/AppModal';
import AsyncButton from '@shell/components/AsyncButton';
import { LabeledInput } from '@components/Form/LabeledInput';
import { Card } from '@components/Card';
import { RcButton } from '@components/RcButton';
import { Banner } from '@components/Banner';
import { readSettings, saveSettings } from '../extensions';

export default {
  name: 'EditorSettingsModal',

  components: {
    AppModal, AsyncButton, Card, RcButton, Banner, LabeledInput
  },

  emits: ['close', 'saved'],

  data() {
    return {
      // '' means "left alone" and is not written; see save below. Clearing one is the Remove
      // link, because a blank field cannot mean both "keep" and "delete".
      token:    '',
      hasToken: false,
      loading:  true,
      error:    '',
      // Set by the Clear button, which is the only way to remove a token: a blank field means
      // "keep", so it cannot also mean "delete".
      clearToken: false,
    };
  },

  computed: {
    tokenPlaceholder() {
      return this.hasToken ? 'Stored. Leave blank to keep it.' : 'ghp_...';
    },

  },

  async mounted() {
    try {
      // Any extension will do: the token is the one setting left here and it is the same for
      // all of them. The repository moved to the point of publishing, where it is asked.
      this.hasToken = (await readSettings('')).hasToken;
    } catch (e) {
      this.error = e?.message || String(e);
    } finally {
      this.loading = false;
    }
  },

  methods: {
    async save(done) {
      try {
        await saveSettings('', {
          // undefined rather than '' when it was left alone, because '' is the deliberate clear.
          token: this.clearToken ? '' : (this.token || undefined),
        });
        this.$emit('saved');
        done(true);
        this.$emit('close');
      } catch (e) {
        this.error = e?.message || String(e);
        done(false);
      }
    },
  },
};
</script>

<template>
  <AppModal
    name="barn-editor-settings"
    :width="560"
    @close="$emit('close')"
  >
    <Card
      class="editor-settings"
      :show-highlight-border="false"
    >
      <template #title>
        <h4 class="text-default-text">
          Editor settings
        </h4>
      </template>

      <template #body>
        <Banner
          v-if="error"
          color="error"
          :label="error"
        />

        <p class="editor-settings__intro">
          Used to import and publish extensions to GitHub.
        </p>

        <LabeledInput
          v-model:value="token"
          label="GitHub token"
          type="password"
          :placeholder="tokenPlaceholder"
          :disabled="loading || clearToken"
          class="editor-settings__field"
        />
        <p
          v-if="hasToken"
          class="editor-settings__hint"
        >
          One is stored; typing here replaces it.
          <a
            href="#"
            @click.prevent="clearToken = !clearToken"
          >{{ clearToken ? 'Keep it' : 'Remove it' }}</a>
        </p>
        <Banner
          v-if="clearToken"
          color="warning"
          label="The stored token will be removed when you save."
        />
      </template>

      <template #actions>
        <div class="editor-settings__actions">
          <RcButton
            variant="tertiary"
            @click="$emit('close')"
          >
            Cancel
          </RcButton>
          <AsyncButton
            mode="edit"
            action-label="Save"
            waiting-label="Saving"
            success-label="Saved"
            :disabled="loading"
            @click="save"
          />
        </div>
      </template>
    </Card>
  </AppModal>
</template>

<style lang="scss" scoped>
.editor-settings {
  &__intro {
    max-width: 70ch;
    margin-bottom: 15px;
    color: var(--muted);
  }

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
