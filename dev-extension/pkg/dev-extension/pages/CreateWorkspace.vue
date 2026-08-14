<script>
// Create a workspace: a name and a template, which is exactly what the harness asks for.
//
// Not CruResource, which is the shell's form chrome for editing one Steve resource: a
// workspace is three of them created together and there is no model to hand it. The inputs,
// the banner and the buttons are still the shell's.
import AsyncButton from '@shell/components/AsyncButton';
import LabeledSelect from '@shell/components/form/LabeledSelect';
import { LabeledInput } from '@components/Form/LabeledInput';
import { Banner } from '@components/Banner';
import { RcButton } from '@components/RcButton';
import { createWorkspace, workspaceNameError, workspaceNamespace } from '../api';
import { TEMPLATES, templateById } from '../templates';
import {
  DEV_PRODUCT, BLANK_CLUSTER, WORKSPACES_ROUTE, WORKSPACE_ROUTE
} from '../config/constants';

export default {
  name: 'DevCreateWorkspace',

  components: {
    AsyncButton, LabeledSelect, LabeledInput, Banner, RcButton
  },

  data() {
    // The Templates page links here with a template already chosen; an unknown one in the
    // query falls back rather than leaving the select empty and the form unsubmittable.
    const asked = this.$route.query.template;

    return {
      name:     '',
      template: templateById(asked)?.id || TEMPLATES[0].id,
      error:    '',
      // The name is only complained about once it has been typed in and left alone, so the
      // form does not tell someone their first keystroke is invalid.
      touched:  false,
      options:  TEMPLATES.map((template) => ({ label: template.label, value: template.id })),
      cancelTo: { name: WORKSPACES_ROUTE, params: { product: DEV_PRODUCT, cluster: BLANK_CLUSTER } },
    };
  },

  computed: {
    nameError() {
      return workspaceNameError(this.name);
    },

    shownNameError() {
      return this.touched ? this.nameError : '';
    },

    selected() {
      return templateById(this.template);
    },

    namespace() {
      return this.nameError ? '' : workspaceNamespace(this.name);
    },
  },

  watch: {
    // The error is about the name that was submitted, so editing the name is what ends it.
    // Left standing it would go on hiding the banner that says what the new name would make,
    // until the next press of Create.
    name() {
      this.error = '';
    },
  },

  methods: {
    async create(done) {
      this.touched = true;
      this.error = '';

      if (this.nameError) {
        done(false);

        return;
      }

      try {
        await createWorkspace(this.name, this.template);
        // Straight to the workspace rather than back to the list: the thing worth watching
        // next is the pod coming up, and that is on the detail page.
        this.$router.push({
          name:   WORKSPACE_ROUTE,
          params: { product: DEV_PRODUCT, cluster: BLANK_CLUSTER, workspace: this.name },
        });
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
  <div class="dev-create">
    <header>
      <h1>Create Workspace</h1>
      <p class="subheader">
        A workspace is a namespace, a Deployment and a Service. The template decides what runs
        in it.
      </p>
    </header>

    <Banner
      v-if="error"
      color="error"
      :label="error"
    />

    <div class="dev-create__form">
      <LabeledInput
        v-model:value="name"
        label="Workspace name"
        :required="true"
        placeholder="my-workspace"
        @blur="touched = true"
      />
      <LabeledSelect
        v-model:value="template"
        label="Template"
        :options="options"
        :clearable="false"
      />
    </div>

    <Banner
      v-if="shownNameError"
      color="error"
      :label="shownNameError"
    />
    <!--
      Not while a create has failed. This banner says what the name would make and the error
      above says why it did not, so on a name that is taken the page reads "a workspace called
      delta already exists" and "creates the namespace dev-delta" at the same time.
    -->
    <Banner
      v-else-if="namespace && !error"
      color="info"
      :label="`Creates the namespace ${ namespace }, running ${ selected.image }.`"
    />

    <p
      v-if="selected"
      class="dev-create__description"
    >
      {{ selected.description }}
    </p>

    <div class="dev-create__actions">
      <RcButton
        variant="secondary"
        :to="cancelTo"
      >
        Cancel
      </RcButton>
      <AsyncButton
        mode="create"
        :disabled="!name"
        @click="create"
      />
    </div>
  </div>
</template>

<style lang="scss" scoped>
  .dev-create {
    max-width: 720px;

    header {
      display:       block;
      margin-bottom: 20px;

      h1 {
        margin-bottom: 0;
      }

      .subheader {
        margin: 4px 0 0 0;
        color:  var(--muted);
      }
    }

    &__form {
      display:               grid;
      grid-template-columns: 1fr 1fr;
      gap:                   20px;
      margin-bottom:         20px;
    }

    &__description {
      max-width: 80ch;
      color:     var(--muted);
    }

    &__actions {
      display:         flex;
      gap:             10px;
      justify-content: flex-end;
      margin-top:      20px;
    }
  }
</style>
