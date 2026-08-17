<script>
export default {
  name: 'BaseHome',

  data() {
    return { renderedAt: new Date().toLocaleTimeString() };
  },
};
</script>

<template>
  <div class="base-home">
    <h1>It works</h1>
    <p>
      This page is served by a dev server running as a pod in this cluster. Edit
      <code>pages/Home.vue</code> in the pane beside it and the change is here within seconds,
      with no build step and nothing to reinstall.
    </p>
    <p class="base-home__stamp">
      rendered at {{ renderedAt }}
    </p>
  </div>
</template>

<style lang="scss" scoped>
.base-home {
  padding: 20px;

  h1 {
    color: var(--primary);
  }

  p {
    max-width: 70ch;
  }

  &__stamp {
    display:       inline-block;
    margin-top:    10px;
    padding:       6px 10px;
    border:        1px solid var(--border);
    border-radius: var(--border-radius);
    font-family:   monospace;
  }
}
</style>
