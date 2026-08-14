<script>
// Overrides the core /prefs route (registered in index.ts) to add an "Enable
// Barn" checkbox to the END of the Advanced Features section WITHOUT
// copying the core template: render the original prefs page, then Teleport our
// checkbox into the Advanced Features container. The container is found by its
// heading text (robust to Rancher-version class changes) rather than a class.
import Prefs from '@shell/pages/prefs.vue';
import { Checkbox } from '@components/Form/Checkbox';
import { NAV_PREF } from '../product';

export default {
  name: 'BarnPrefs',

  components: { Prefs, Checkbox },

  data() {
    return { target: null };
  },

  computed: {
    enabled: {
      get() {
        try {
          const v = this.$store.getters['prefs/get'](NAV_PREF);

          return v === undefined || v === null ? true : !!v;
        } catch {
          return true;
        }
      },
      set(value) {
        this.$store.dispatch('prefs/set', { key: NAV_PREF, value: !!value });
        // The nav is registered once at product init, so a change only applies
        // on the next load — reload so toggling takes effect immediately.
        setTimeout(() => window.location.reload(), 200);
      },
    },
  },

  mounted() {
    // Locate the Advanced Features section by its heading and teleport into it.
    this.$nextTick(() => {
      const h = Array.from(document.querySelectorAll('h4'))
        .find(el => /advanced features/i.test(el.textContent || ''));

      this.target = h ? h.parentElement : null;
    });
  },
};
</script>

<template>
  <div class="barn-prefs">
    <Prefs />
    <Teleport
      v-if="target"
      :to="target"
    >
      <Checkbox
        v-model:value="enabled"
        label="Enable Barn"
        tooltip="Show the Barn navigation (Closets, Secret Sets) in the cluster explorer. Reloads to apply."
        class="mt-20"
      />
    </Teleport>
  </div>
</template>
