<script>
// The global terminals: sessions that belong to no workspace.
//
// The terminals themselves are not on this page. They are tabs in Rancher's window manager,
// the drawer across the bottom of the screen that container shells and logs open into, which
// is the same shape the harness has: resizable, tabbed, one tab per terminal, and still there
// when you navigate somewhere else. Putting a terminal on this page as well would be a second
// place for the same session to be, and closing the page would look like closing the terminal.
//
// So this page is what the drawer's tab strip cannot be: somewhere to open one, and a list of
// the ones that are open. Anything that would have been a plus on the strip is here and in each
// terminal's own controls, because the strip belongs to the shell and has no slot for one.
import { Banner } from '@components/Banner';
import { RcButton } from '@components/RcButton';
import { openTerminal, openTerminals, terminalSession } from '../terminals';
import { DEV_PRODUCT, BLANK_CLUSTER, TERMINAL_ROUTE } from '../config/constants';

export default {
  name: 'DevGlobalTerminal',

  components: { Banner, RcButton },

  computed: {
    /** The terminals in the drawer right now, straight out of the window manager's own store. */
    open() {
      return openTerminals(this.$store).map((number) => ({
        number,
        session: terminalSession(number),
        label:   `Terminal ${ number }`,
      }));
    },
  },

  /**
   * A terminal in the address opens that one, so a link to a terminal is a link somebody can
   * follow. The address is then put back to the plain page, because the terminal is in the
   * drawer from here on and the drawer outlives this page: leaving the number in the bar would
   * reopen it every time someone came back to this nav entry.
   */
  mounted() {
    const number = Number(this.$route.params.terminal);

    if (Number.isInteger(number) && number > 0) {
      openTerminal(this.$store, number);
      this.$router.replace({
        name:   TERMINAL_ROUTE,
        params: { product: DEV_PRODUCT, cluster: BLANK_CLUSTER },
      });
    }
  },

  methods: {
    newTerminal() {
      openTerminal(this.$store);
    },

    show(number) {
      openTerminal(this.$store, number);
    },
  },
};
</script>

<template>
  <div class="dev-terminals">
    <header>
      <div>
        <h1>Terminal</h1>
        <p class="subheader">
          Sessions that belong to no workspace, in the pod that serves this dashboard. Each one
          is tmux, so closing its tab or the browser leaves it running, and opening it again
          reattaches to the conversation you left.
        </p>
      </div>
      <RcButton
        variant="primary"
        left-icon="plus"
        @click="newTerminal"
      >
        New terminal
      </RcButton>
    </header>

    <Banner
      v-if="!open.length"
      color="info"
      label="No terminals are open. New terminal opens one in the drawer along the bottom of the page, where it stays while you work elsewhere."
    />

    <ul
      v-else
      class="dev-terminals__list"
    >
      <li
        v-for="terminal in open"
        :key="terminal.number"
      >
        <RcButton
          variant="link"
          left-icon="terminal"
          @click="show(terminal.number)"
        >
          {{ terminal.label }}
        </RcButton>
        <span class="dev-terminals__session">{{ terminal.session }}</span>
      </li>
    </ul>

    <p class="dev-terminals__note">
      Claude is logged in per pod, so a new terminal may ask you to log in. Sharing one login
      across the pods is still to build.
    </p>
  </div>
</template>

<style lang="scss" scoped>
  .dev-terminals {
    header {
      display:       flex;
      align-items:   flex-start;
      gap:           20px;
      margin-bottom: 20px;

      h1 {
        margin-bottom: 0;
      }

      .subheader {
        max-width: 80ch;
        margin:    4px 0 0 0;
        color:     var(--muted);
      }

      > :last-child {
        margin-left: auto;
      }
    }

    &__list {
      margin:     0 0 20px 0;
      padding:    0;
      list-style: none;

      li {
        display:     flex;
        align-items: center;
        gap:         10px;
        padding:     4px 0;
      }
    }

    &__session {
      color:       var(--muted);
      font-family: monospace;
      font-size:   12px;
    }

    &__note {
      max-width: 80ch;
      color:     var(--muted);
    }
  }
</style>
