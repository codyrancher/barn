<script>
// My Work: the harness's landing page, and the first thing a person looks for.
//
// Nothing here yet, and deliberately nothing invented. The page needs three GitHub queries
// (issues assigned to you, PRs you wrote, PRs waiting on your review) and every one of them
// needs a token that is not in this repo. What has been settled is that the browser can do
// the asking: from a page served through Rancher's service proxy, api.github.com answers with
// `access-control-allow-origin: *`, and a request carrying an Authorization header survives
// its CORS preflight. So this page is waiting on somewhere to keep a token, not on whether it
// can be built.
import { Banner } from '@components/Banner';
import { RcButton } from '@components/RcButton';
import { DEV_PRODUCT, BLANK_CLUSTER, SETTINGS_ROUTE } from '../config/constants';

export default {
  name: 'DevMyWork',

  components: { Banner, RcButton },

  data() {
    return {
      settingsTo: { name: SETTINGS_ROUTE, params: { product: DEV_PRODUCT, cluster: BLANK_CLUSTER } },
      planned:    [
        'Issues assigned to you, open, newest first.',
        'Pull requests you opened, with their CI state and whether anyone has approved them.',
        'Pull requests waiting on your review, with whether you have already left one.',
        'A link from each row to the workspace that exists for it, where one does.',
      ],
    };
  },
};
</script>

<template>
  <div class="dev-my-work">
    <header>
      <h1>My Work</h1>
      <p class="subheader">
        What is assigned to you, what you wrote, and what is waiting on you, from GitHub.
      </p>
    </header>

    <Banner color="info">
      <p>
        This page is not built yet, and it is empty rather than filled with examples so that
        nothing here can be mistaken for your actual work.
      </p>
      <p>
        It needs a GitHub token, which will live in a Kubernetes Secret and be set from
        Settings. GitHub itself is reachable from this page: unauthenticated it allows 60
        requests an hour, which is why the token comes first.
      </p>
    </Banner>

    <h3>What it will show</h3>
    <ul>
      <li
        v-for="item in planned"
        :key="item"
      >
        {{ item }}
      </li>
    </ul>

    <RcButton
      variant="secondary"
      :to="settingsTo"
    >
      Go to Settings
    </RcButton>
  </div>
</template>

<style lang="scss" scoped>
  .dev-my-work {
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

    ul {
      max-width:     80ch;
      margin-bottom: 20px;
      color:         var(--muted);
    }
  }
</style>
