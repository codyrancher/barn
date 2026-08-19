<script>
// Bring an extension in from a repository.
//
// The sibling of NewExtensionModal, and deliberately the same shape: a name, a question about
// where the contents come from, and a button that hands the work back to the page. What it
// asks for instead of a seed is a repository, and what it produces is the same thing - a
// `source` string that `ensureExtension` knows how to satisfy (`github:owner/repo#branch`).
//
// So the two modals do not share a creation path so much as they share the only one there is:
// the page's onCreate takes whichever of them emitted, and neither knows what the other did.
import AppModal from '@shell/components/AppModal';
import AsyncButton from '@shell/components/AsyncButton';
import { LabeledInput } from '@components/Form/LabeledInput';
import { Card } from '@components/Card';
import { RcButton } from '@components/RcButton';
import { Banner } from '@components/Banner';
import { normalizeExtensionName, listExtensions, readSettings } from '../extensions';

export default {
  name: 'ImportExtensionModal',

  components: {
    AppModal, AsyncButton, Card, RcButton, Banner, LabeledInput
  },

  emits: ['close', 'create', 'settings'],

  data() {
    return {
      name:   '',
      repo:   '',
      branch: '',
      taken:  [],
      error:  '',
      // Whether there is a token. Unlike publishing, this does not stop an import: a public
      // repository clones without one. It only decides whether to say so.
      hasToken: true,
    };
  },

  computed: {
    // What the name will actually be. Applied rather than rejected, the same way the header's
    // box does it: somebody typing "My Thing" means an extension, not a validation error.
    normalized() {
      return normalizeExtensionName(this.name);
    },

    repoInvalid() {
      return !!this.repo && !/^[\w.-]+\/[\w.-]+$/.test(this.repo);
    },

    nameTaken() {
      return !!this.normalized && this.taken.includes(this.normalized);
    },

    canImport() {
      return !!this.normalized && !!this.repo && !this.repoInvalid && !this.nameTaken;
    },
  },

  async mounted() {
    this.taken = (await listExtensions().catch(() => [])).map((each) => each.name);
    // Any extension will do - the token is not one of theirs. See repoKey.
    this.hasToken = (await readSettings('').catch(() => ({ hasToken: false }))).hasToken;
  },

  methods: {
    create(done) {
      if (!this.canImport) {
        done(false);

        return;
      }

      // The branch rides on the source rather than as a second argument, because everything
      // downstream of here passes one string around and a second one would have to be threaded
      // through all of it to be read in one place.
      const source = `github:${ this.repo }${ this.branch ? `#${ this.branch }` : '' }`;

      this.$emit('create', { name: this.normalized, source, done });
    },
  },
};
</script>

<template>
  <AppModal
    name="barn-import-extension"
    :width="620"
    @close="$emit('close')"
  >
    <Card
      class="import-extension"
      :show-highlight-border="false"
    >
      <template #title>
        <h4 class="text-default-text">
          Import from GitHub
        </h4>
      </template>

      <template #body>
        <Banner
          v-if="error"
          color="error"
          :label="error"
        />

        <Banner
          v-if="!hasToken"
          color="warning"
        >
          <span>
            There is no GitHub token yet. A public repository imports without one; a private one
            does not.
            <a
              href="#"
              @click.prevent="$emit('settings')"
            >Add one in settings</a>, then come back.
          </span>
        </Banner>

        <LabeledInput
          v-model:value="name"
          label="Name"
          placeholder="my-extension"
          class="import-extension__field"
        />
        <p
          v-if="nameTaken"
          class="import-extension__hint import-extension__hint--error"
        >
          <code>{{ normalized }}</code> already exists here.
        </p>
        <p
          v-else-if="normalized && normalized !== name"
          class="import-extension__hint"
        >
          It will be called <code>{{ normalized }}</code>.
        </p>

        <LabeledInput
          v-model:value="repo"
          label="GitHub repository"
          placeholder="owner/name"
          class="import-extension__field"
        />
        <p
          v-if="repoInvalid"
          class="import-extension__hint import-extension__hint--error"
        >
          That has to be owner/name.
        </p>

        <LabeledInput
          v-model:value="branch"
          label="Branch"
          placeholder="the repository's default"
          class="import-extension__field"
        />
      </template>

      <template #actions>
        <div class="import-extension__actions">
          <RcButton
            variant="tertiary"
            @click="$emit('close')"
          >
            Cancel
          </RcButton>
          <AsyncButton
            mode="edit"
            action-label="Import"
            waiting-label="Importing"
            success-label="Importing"
            :disabled="!canImport"
            @click="create"
          />
        </div>
      </template>
    </Card>
  </AppModal>
</template>

<style lang="scss" scoped>
.import-extension {
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
