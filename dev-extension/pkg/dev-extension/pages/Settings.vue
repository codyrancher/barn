<script>
// Settings: the one place a secret is set, generated from what declared it.
//
// Nothing here is written per key. The fields come from the declarations in templates.ts, global
// ones first and then one section per template, so adding a secret is a data change in the same
// way adding a template is. That is also what keeps this page and the sidecar cards agreeing
// about which keys exist.
//
// Three rules the store's shape imposes on this page:
//
//   - a stored value is never rendered back into its field. The field shows whether the key is
//     set and offers to replace or clear it, so a page someone left open cannot leak a token to
//     whoever walks past.
//   - saving writes only the fields that were touched, so opening this page and pressing Save
//     cannot blank a key nobody could see.
//   - a generated secret is different in kind, and this is the deliberate exception to the rule
//     above rather than an oversight in it. The rule exists so that a value someone entrusted to
//     this page cannot be read back out of it; a value the product invented was never anyone's
//     secret, and a password you cannot read is a password you cannot log in with. So: never
//     render back what a person typed, always allow reading what the product generated. Those
//     fields say they are generated rather than pretending someone chose them.
//
// The claude login is on this page too, as an identity rather than a secret: who it is and
// whether it is still valid, never the token.
import Loading from '@shell/components/Loading';
import AsyncButton from '@shell/components/AsyncButton';
import { Banner } from '@components/Banner';
import { RcButton } from '@components/RcButton';
import { LabeledInput } from '@components/Form/LabeledInput';
import {
  setSecretKeys, saveSecrets, secretValue, claudeIdentity, migrateGithubToken,
  templateSecretKey, devPodServiceAccount
} from '../api';
import { TEMPLATES, GLOBAL_SECRETS } from '../templates';

export default {
  name: 'DevSettings',

  components: {
    Loading, AsyncButton, Banner, RcButton, LabeledInput
  },

  async fetch() {
    // The one-off `github-token` Secret is folded into the store here, on the page that owns the
    // store, and deleted. It is idempotent and does nothing on a cluster that never had one.
    await migrateGithubToken().catch(() => {});
    await this.refresh();
  },

  data() {
    return {
      keys:     [],
      claude:   null,
      podSa:    null,
      // Key to the string typed into its field. A key that is not in here was not touched, and
      // is not written on Save. An empty field is never in here: clearing is what Clear is for.
      edits:    {},
      // Keys Clear was pressed on, which is the only thing that writes an empty value.
      cleared:  [],
      // Key to the value of a generated secret, once Show has been pressed for it.
      revealed: {},
      error:    '',
      saved:    false,
    };
  },

  computed: {
    /**
     * The sections, in the order the spec asks for them: global first, then one per template.
     *
     * A template with no declared secrets still gets a section, saying so, for the same reason
     * the sidebar shows a template with no workspaces: the set of templates is the map of what
     * this product can do, and a gap in it reads as something being broken.
     */
    sections() {
      return [
        {
          id:      'global',
          title:   'Global',
          help:    'Secrets that belong to the product rather than to any one template.',
          secrets: GLOBAL_SECRETS.map((secret) => this.field(secret, secret.key)),
        },
        ...TEMPLATES.map((template) => ({
          id:      template.id,
          title:   template.label,
          help:    `Secrets the ${ template.label } template and its sidecars need. Stored under the ${ template.id }. prefix, so two templates can each have a key of the same name.`,
          secrets: (template.secrets || []).map((secret) => this.field(secret, templateSecretKey(template.id, secret.key))),
        })),
      ];
    },

    changed() {
      return Object.keys(this.edits).length > 0 || this.cleared.length > 0;
    },

    /** What Save will write: the fields that were typed into, and the keys Clear was pressed on. */
    writes() {
      const out = { ...this.edits };

      for (const key of this.cleared) {
        out[key] = '';
      }

      return out;
    },

    claudeState() {
      if (!this.claude) {
        return 'No claude login is stored yet. A terminal that logs in pushes its credentials here, and every other terminal pulls them.';
      }

      const expires = new Date(this.claude.expiresAt);
      const valid = this.claude.expiresAt > Date.now();

      return `${ this.claude.subscriptionType } login, ${ valid ? 'valid until' : 'expired' } ${ expires.toLocaleString() }.`;
    },
  },

  methods: {
    /** One declaration, joined to whether the cluster has it. */
    field(secret, key) {
      return {
        ...secret,
        storeKey: key,
        set:      this.keys.includes(key),
      };
    },

    async refresh() {
      const [keys, claude, podSa] = await Promise.all([
        setSecretKeys().catch(() => []),
        claudeIdentity().catch(() => null),
        devPodServiceAccount().catch(() => null),
      ]);

      this.keys = keys;
      this.claude = claude;
      this.podSa = podSa;
    },

    placeholder(secret) {
      if (secret.set) {
        return 'Set. Type to replace it.';
      }

      return secret.generated ? 'Generated when it is first needed' : 'Not set';
    },

    async reveal(secret) {
      try {
        this.revealed = { ...this.revealed, [secret.storeKey]: await secretValue(secret.storeKey) };
      } catch (e) {
        this.error = e.message || String(e);
      }
    },

    hide(secret) {
      const revealed = { ...this.revealed };

      delete revealed[secret.storeKey];
      this.revealed = revealed;
    },

    /**
     * Something was typed.
     *
     * An empty field is never a change, whatever it was a moment ago. Typing a character into a
     * field whose key is set and deleting it again used to leave an empty edit behind, and an
     * empty value is a deliberate clear, so one stray keystroke and a Save destroyed a token
     * nobody could see. Clearing has a button of its own; the field only ever sets a value.
     */
    edit(secret, value) {
      const edits = { ...this.edits };

      if (value === '') {
        delete edits[secret.storeKey];
      } else {
        edits[secret.storeKey] = value;
      }

      this.edits = edits;
      this.cleared = this.cleared.filter((key) => key !== secret.storeKey);
    },

    /** An explicit clear, which is the only thing that writes an empty value. */
    clear(secret) {
      if (!this.cleared.includes(secret.storeKey)) {
        this.cleared = [...this.cleared, secret.storeKey];
      }

      this.hide(secret);
    },

    async save(done) {
      this.error = '';
      this.saved = false;

      try {
        await saveSecrets(this.writes);
        this.edits = {};
        this.cleared = [];
        this.revealed = {};
        await this.refresh();
        this.saved = true;
        done(true);
      } catch (e) {
        this.error = e.message || String(e);
        done(false);
      }
    },
  },
};
</script>

<template>
  <Loading v-if="$fetchState.pending" />
  <div
    v-else
    class="dev-settings"
  >
    <header>
      <h1>Settings</h1>
      <p class="subheader">
        Every secret this product uses, in one Kubernetes Secret of your own in the dev-system
        namespace. A value is never shown again after it is saved, and saving writes only the
        fields you changed.
      </p>
    </header>

    <Banner
      v-if="error"
      color="error"
      :label="error"
    />
    <Banner
      v-else-if="saved"
      color="success"
      label="Saved."
    />

    <section
      v-for="section in sections"
      :key="section.id"
      class="dev-settings__section"
    >
      <h3>{{ section.title }}</h3>
      <p class="subheader">
        {{ section.help }}
      </p>

      <p
        v-if="!section.secrets.length"
        class="dev-settings__none"
      >
        This template declares no secrets.
      </p>

      <div
        v-for="secret in section.secrets"
        :key="secret.storeKey"
        class="dev-settings__field"
      >
        <!--
          Bound through a handler rather than with v-model, so a key is in `edits` only because
          something was typed into it. With v-model an input that emitted once on mount would put
          every key in there as an empty string, and an empty string is a deliberate clear.
        -->
        <LabeledInput
          type="password"
          :value="edits[secret.storeKey] || ''"
          :label="secret.label"
          :placeholder="placeholder(secret)"
          @update:value="(value) => edit(secret, value)"
        />
        <!--
          The help is a paragraph rather than LabeledInput's `sub-label`, because that slot is
          `position: absolute; top: 100%` with pointer events, so it hangs over whatever follows
          the field. Here that is the row of controls, and Clear and Show were unclickable behind
          it. In flow it takes its own height and nothing sits underneath anything.
        -->
        <p class="dev-settings__help">
          {{ secret.help }}
        </p>
        <div class="dev-settings__row">
          <span class="dev-settings__key">{{ secret.storeKey }}</span>
          <span
            class="dev-settings__state"
            :class="{ 'dev-settings__state--set': secret.set }"
          >{{ secret.set ? 'Set' : 'Not set' }}</span>
          <span
            v-if="secret.required && !secret.set"
            class="dev-settings__pending"
          >Required</span>
          <span
            v-if="secret.generated"
            class="dev-settings__state"
          >Generated</span>

          <!--
            Only for generated secrets, and only one at a time. A value someone typed is never
            offered back; a value the product made up has to be readable or the sidecar it belongs
            to cannot be logged into.
          -->
          <RcButton
            v-if="secret.generated && secret.set && !revealed[secret.storeKey]"
            variant="link"
            size="small"
            @click="reveal(secret)"
          >
            Show
          </RcButton>
          <template v-else-if="revealed[secret.storeKey]">
            <code class="dev-settings__revealed">{{ revealed[secret.storeKey] }}</code>
            <RcButton
              variant="link"
              size="small"
              @click="hide(secret)"
            >
              Hide
            </RcButton>
          </template>

          <RcButton
            v-if="secret.set"
            variant="link"
            size="small"
            @click="clear(secret)"
          >
            Clear
          </RcButton>
          <span
            v-if="cleared.includes(secret.storeKey)"
            class="dev-settings__pending"
          >Will be cleared on save</span>
        </div>
      </div>
    </section>

    <div class="dev-settings__actions">
      <AsyncButton
        mode="apply"
        :disabled="!changed"
        @click="save"
      />
    </div>

    <section class="dev-settings__section">
      <h3>Claude login</h3>
      <p class="subheader">
        The one login every terminal here shares, kept in dev-system/claude-credentials. It is an
        identity rather than a setting: a terminal that logs in pushes it, and the others pull it,
        so nothing is typed in on this page.
      </p>
      <p class="dev-settings__identity">
        {{ claudeState }}
      </p>
    </section>

    <section
      v-if="podSa && podSa.current !== podSa.wanted"
      class="dev-settings__section"
    >
      <h3>Global terminal permissions</h3>
      <Banner color="warning">
        The dev server's pod runs as <code>{{ podSa.current }}</code> rather than
        <code>{{ podSa.wanted }}</code>, so a global terminal in it can reach the cluster only as
        far as that account does. A pod takes its ServiceAccount when it starts, so this needs a
        restart of the dev server pod, which throws away every terminal session in it. It is left
        here to be done deliberately rather than done for you.
      </Banner>
    </section>
  </div>
</template>

<style lang="scss" scoped>
  .dev-settings {
    padding:   20px;
    overflow-y: auto;

    header {
      margin-bottom: 20px;

      h1 {
        margin-bottom: 0;
      }
    }

    .subheader {
      max-width: 90ch;
      margin:    4px 0 10px 0;
      color:     var(--muted);
    }

    &__section {
      margin-top: 30px;
      max-width:  90ch;
    }

    &__field {
      margin-top: 20px;
    }

    // The key, its state and its controls on one line under the field, so the field itself is
    // just a field and everything about it is in one place.
    &__row {
      display:     flex;
      align-items: center;
      gap:         10px;
      margin-top:  4px;
      font-size:   12px;
    }

    &__help {
      margin:    4px 0 0 0;
      color:     var(--muted);
      font-size: 12px;
    }

    &__key {
      color:       var(--muted);
      font-family: monospace;
    }

    &__state {
      color: var(--muted);

      &--set {
        color: var(--success);
      }
    }

    &__revealed {
      font-family: monospace;
    }

    &__pending {
      color: var(--warning);
    }

    &__none,
    &__identity {
      color: var(--muted);
    }

    &__actions {
      display:    flex;
      margin-top: 20px;
    }
  }
</style>
