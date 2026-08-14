<script>
// Settings: where the two credentials this product will need are set.
//
// Both are still to build, and both are listed here with what they are for, because the nav
// is the layout: an entry that is missing says the product does not do the thing, and an
// entry that shows an invented form says it already does. This says neither.
import { Banner } from '@components/Banner';

export default {
  name: 'DevSettings',

  components: { Banner },

  data() {
    return {
      settings: [
        {
          label:  'GitHub token',
          state:  'Not built yet',
          detail: 'A personal access token, kept in a Kubernetes Secret and read through Steve, never in a ConfigMap and never in a URL. My Work is the page that needs it.',
        },
        {
          label:  'Claude login',
          state:  'Not built yet',
          detail: 'Whether the terminals are logged in, and as whom. Each pod has its own login today, so a login in one is invisible to the others; the plan is one shared Secret that every terminal pulls from and pushes back to.',
        },
      ],
    };
  },
};
</script>

<template>
  <div class="dev-settings">
    <header>
      <h1>Settings</h1>
      <p class="subheader">
        The credentials this product uses, and what each one is for.
      </p>
    </header>

    <Banner
      color="info"
      label="Nothing here can be set yet. Both entries below are listed so the nav describes the product honestly, not because they are half-wired."
    />

    <dl class="dev-settings__list">
      <template
        v-for="setting in settings"
        :key="setting.label"
      >
        <dt>
          {{ setting.label }}
          <span class="dev-settings__state">{{ setting.state }}</span>
        </dt>
        <dd>{{ setting.detail }}</dd>
      </template>
    </dl>
  </div>
</template>

<style lang="scss" scoped>
  .dev-settings {
    header {
      margin-bottom: 20px;

      h1 {
        margin-bottom: 0;
      }

      .subheader {
        max-width: 80ch;
        margin:    4px 0 0 0;
        color:     var(--muted);
      }
    }

    &__list {
      max-width: 90ch;

      dt {
        display:     flex;
        align-items: baseline;
        gap:         10px;
        margin-top:  20px;
        font-weight: bold;
      }

      dd {
        margin: 4px 0 0 0;
        color:  var(--muted);
      }
    }

    &__state {
      font-size:   12px;
      font-weight: normal;
      color:       var(--muted);
    }
  }
</style>
