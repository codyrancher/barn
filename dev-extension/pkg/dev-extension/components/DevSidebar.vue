<script>
// The product's navigation: templates as sections, workspaces as rows.
//
// It is not Rancher's product nav, because that nav cannot draw these rows: it builds each
// entry's label itself through `escapeHtml` and its entries have no icon field, so a state dot
// is impossible, and it has no per-row slot, so a delete control is impossible. Both are on
// every row of the thing this is a port of.
//
// Neither `nav/Type.vue` nor `nav/Group.vue` is wrapped here, and both were tried:
//
//   - Type renders its own `<li>`. A row needs a dot before the link and a delete after it, so
//     wrapping Type puts an `<li>` inside an `<li>`, which is invalid markup and laid the two
//     rails out differently in each row. Its label inset also comes from rules that only exist
//     inside Group's stylesheet, so outside the nav it is 3px adrift of everything else.
//   - Group renders its children through Type itself with no slot between them, so a Group
//     section cannot carry a dot or a delete on a row either.
//
// What is taken from them instead is their metrics, which is the part worth keeping: a 33px
// row, a 16px left inset, 14px labels on a 16px line, all read out of the shell's own nav
// styles rather than picked by eye.
//
// Everything else is the shell's. Colours, spacing and type come from Rancher's own variables,
// the icons are Rancher's icon font, the create control is RcButton, the tooltips are the
// shell's directive, and the state colours are the same `colorForState` the tables and badges
// use. Where the harness and Rancher disagree on a colour, this takes Rancher's.
import { colorForState, stateDisplay } from '@shell/plugins/dashboard-store/resource-class';
import { listWorkspaces, deleteWorkspace } from '../api';
import { showTerminal } from '../terminals';
import { TEMPLATES } from '../templates';
import {
  DEV_PRODUCT, BLANK_CLUSTER, WORKSPACE_ROUTE, CREATE_ROUTE, WORKSPACES_ROUTE,
  MY_WORK_ROUTE, INSIGHTS_ROUTE, SETTINGS_ROUTE
} from '../config/constants';

const REFRESH_MS = 5000;

// The sidebar is rebuilt on every navigation, because the router-view above it is keyed on the
// path. Without this the list blinks empty and fills in again on every click, which is the
// difference between a sidebar and a page element that happens to be on the left.
let cached = [];

export default {
  name: 'DevSidebar',

  data() {
    return {
      workspaces:   cached,
      templates:    TEMPLATES,
      error:        '',
      // The workspace a delete has been asked for, so the row can ask before it does it.
      confirming:   '',
      refreshTimer: null,
      /**
       * The entries that are not workspaces, as an icon row at the foot.
       *
       * Icons rather than labelled rows because the column is about workspaces, and these are
       * the things that are not one. `list-flat` for My Work is the honest pick of what the
       * shell has: it is a list, and Rancher's `user` icon already means an account elsewhere
       * in the product, which My Work is not.
       *
       * Terminal is not among them: it is not a page, it is the drawer, and it opens in place.
       */
      globals: [
        {
          label: 'My Work', icon: 'icon-list-flat', route: MY_WORK_ROUTE
        },
        {
          label: 'Insights', icon: 'icon-monitoring', route: INSIGHTS_ROUTE
        },
        {
          label: 'Settings', icon: 'icon-gear', route: SETTINGS_ROUTE
        },
      ],
    };
  },

  computed: {
    /** Every template, with the workspaces made from it. A template with none still shows. */
    sections() {
      return this.templates.map((template) => ({
        ...template,
        workspaces: this.workspaces.filter((workspace) => workspace.template === template.id),
      }));
    },

    /** Workspaces whose template is gone, so they cannot become invisible by losing it. */
    orphans() {
      const known = this.templates.map((template) => template.id);

      return this.workspaces.filter((workspace) => !known.includes(workspace.template));
    },

    currentWorkspace() {
      return this.$route.params.workspace || '';
    },
  },

  async fetch() {
    await this.refresh();
  },

  mounted() {
    this.refreshTimer = setInterval(() => this.refresh(), REFRESH_MS);
  },

  beforeUnmount() {
    clearInterval(this.refreshTimer);
  },

  methods: {
    async refresh() {
      try {
        this.workspaces = await listWorkspaces();
        cached = this.workspaces;
      } catch { /* the next poll will say if it is more than a blip */ }
    },

    workspaceTo(workspace) {
      return {
        name:   WORKSPACE_ROUTE,
        params: { product: DEV_PRODUCT, cluster: BLANK_CLUSTER, workspace: workspace.name },
      };
    },

    /**
     * Create, from the section that already knows which template it is.
     *
     * The template is the section, so the create page is opened with it chosen and asks only
     * for the name. This is the only way in: the Workspaces page's own button opens the same
     * page with the same query.
     */
    createTo(template) {
      return {
        name:   CREATE_ROUTE,
        params: { product: DEV_PRODUCT, cluster: BLANK_CLUSTER },
        query:  { template: template.id },
      };
    },

    /** The drawer, not a page. See showTerminal. */
    openTerminal() {
      showTerminal(this.$store);
    },

    globalTo(route) {
      return { name: route, params: { product: DEV_PRODUCT, cluster: BLANK_CLUSTER } };
    },

    isGlobalActive(route) {
      return this.$route.name === route;
    },

    /**
     * The dot's colour, from Rancher's own state colours, with one deliberate exception.
     *
     * `colorForState('stopped')` is error red, because in the rest of Rancher a stopped thing is
     * a thing that stopped. Here it is a workspace someone pressed Stop on, which is the ordinary
     * way to leave one, and a red dot next to it says the same thing as the red dot next to a
     * crash loop. Muted is what the nav already uses for "nothing to report".
     */
    dotClass(workspace) {
      return workspace.state === 'stopped' ? 'text-muted' : colorForState(workspace.state);
    },

    stateLabel(workspace) {
      return stateDisplay(workspace.state);
    },

    async remove(workspace) {
      this.error = '';
      this.confirming = '';

      try {
        await deleteWorkspace(workspace.name);
        await this.refresh();

        // Standing on a workspace that has just been deleted is standing on a page that is
        // about to say it does not exist.
        if (this.currentWorkspace === workspace.name) {
          this.$router.push({ name: WORKSPACES_ROUTE, params: { product: DEV_PRODUCT, cluster: BLANK_CLUSTER } });
        }
      } catch (e) {
        this.error = e.message || String(e);
      }
    },
  },
};
</script>

<template>
  <nav class="dev-sidebar">
    <div class="dev-sidebar__scroll">
      <section
        v-for="section in sections"
        :key="section.id"
        class="dev-sidebar__section"
      >
        <div class="dev-sidebar__head">
          <i
            class="dev-sidebar__glyph icon"
            :class="section.icon"
          />
          <span class="dev-sidebar__label">{{ section.label }}</span>
          <!--
            Quiet until the pointer is in the section, or until it is focused, which is the
            same rule the row's delete follows. It keeps its place in the layout either way, so
            the label does not move when it appears, and it stays in the tab order, because
            hidden-until-hover is unusable from a keyboard if it is the only way to create a
            workspace.
          -->
          <router-link
            v-clean-tooltip="`New ${ section.label } workspace`"
            class="dev-sidebar__control dev-sidebar__control--bordered dev-sidebar__reveal"
            :aria-label="`New ${ section.label } workspace`"
            :to="createTo(section)"
          >
            <i class="icon icon-plus" />
          </router-link>
        </div>

        <ul>
          <li
            v-for="workspace in section.workspaces"
            :key="workspace.name"
            :class="{ 'dev-sidebar__row--current': workspace.name === currentWorkspace }"
            class="dev-sidebar__row"
          >
            <router-link
              class="dev-sidebar__link"
              :to="workspaceTo(workspace)"
            >
              <!--
                The state class goes on the wrapper and the glyph reads it back through
                currentColor, which is what lets the stylesheet adjust it for the theme without
                knowing which state it is. See the __dot rule.
              -->
              <span
                v-clean-tooltip="stateLabel(workspace)"
                class="dev-sidebar__glyph dev-sidebar__dot"
                :class="dotClass(workspace)"
              ><i class="icon icon-dot" /></span>
              <span class="dev-sidebar__name">{{ workspace.name }}</span>
            </router-link>
            <button
              v-if="confirming !== workspace.name"
              v-clean-tooltip="`Delete ${ workspace.name }`"
              type="button"
              class="dev-sidebar__control dev-sidebar__reveal dev-sidebar__delete"
              :aria-label="`Delete ${ workspace.name }`"
              @click="confirming = workspace.name"
            >
              <i class="icon icon-trash" />
            </button>
            <button
              v-else
              v-clean-tooltip="`Confirm deleting ${ workspace.name }`"
              type="button"
              class="dev-sidebar__control dev-sidebar__delete dev-sidebar__delete--confirm"
              :aria-label="`Confirm deleting ${ workspace.name }`"
              @click="remove(workspace)"
            >
              <i class="icon icon-checkmark" />
            </button>
          </li>

          <li
            v-if="!section.workspaces.length"
            class="dev-sidebar__empty"
          >
            None yet
          </li>
        </ul>
      </section>

      <!-- A workspace whose template has been removed from the code still has to be reachable. -->
      <section
        v-if="orphans.length"
        class="dev-sidebar__section"
      >
        <div class="dev-sidebar__head">
          <i class="dev-sidebar__glyph icon icon-warning" />
          <span class="dev-sidebar__label">Unknown template</span>
        </div>
        <ul>
          <li
            v-for="workspace in orphans"
            :key="workspace.name"
            :class="{ 'dev-sidebar__row--current': workspace.name === currentWorkspace }"
            class="dev-sidebar__row"
          >
            <router-link
              class="dev-sidebar__link"
              :to="workspaceTo(workspace)"
            >
              <span
                v-clean-tooltip="stateLabel(workspace)"
                class="dev-sidebar__glyph dev-sidebar__dot"
                :class="dotClass(workspace)"
              ><i class="icon icon-dot" /></span>
              <span class="dev-sidebar__name">{{ workspace.name }}</span>
            </router-link>
            <button
              type="button"
              class="dev-sidebar__control dev-sidebar__reveal dev-sidebar__delete"
              :aria-label="`Delete ${ workspace.name }`"
              @click="remove(workspace)"
            >
              <i class="icon icon-trash" />
            </button>
          </li>
        </ul>
      </section>
    </div>

    <div
      v-if="error"
      class="dev-sidebar__error"
    >
      {{ error }}
    </div>

    <!-- The things that are not workspaces, out of the way of the things that are. -->
    <div class="dev-sidebar__globals">
      <button
        v-clean-tooltip="'Terminal'"
        type="button"
        aria-label="Terminal"
        @click="openTerminal"
      >
        <i class="icon icon-terminal" />
      </button>
      <router-link
        v-for="global in globals"
        :key="global.route"
        v-clean-tooltip="global.label"
        :to="globalTo(global.route)"
        :aria-label="global.label"
        :class="{ 'dev-sidebar__globals--current': isGlobalActive(global.route) }"
      >
        <i
          class="icon"
          :class="global.icon"
        />
      </router-link>
    </div>
  </nav>
</template>

<style lang="scss" scoped>
  // Every number here is Rancher's own: the shell's nav rows are 33px tall with a 16px left
  // inset and 14px labels on a 16px line (components/nav/Group.vue), and $space-s is its small
  // step. Nothing is picked to match a screenshot.
  $row-height: 33px;
  $rail: 16px;      // the left inset, and the width of the icon slot
  $gap: 8px;        // icon slot to label, and the right inset
  $control: 22px;   // the right-hand control, the same box in both kinds of row

  .dev-sidebar {
    display:        flex;
    flex-direction: column;
    height:         100%;
    min-height:     0;
    overflow:       hidden;
    border-right:   1px solid var(--nav-border, var(--border));
    background:     var(--nav-bg, var(--body-bg));

    &__scroll {
      flex:       1 1 auto;
      overflow-y: auto;
    }

    ul {
      margin:     0;
      padding:    0;
      list-style: none;
    }

    // The two kinds of row are the same box: same height, same insets, same three columns.
    // A div rather than a <header> element, because the shell styles bare HEADERs globally and
    // one of those rules is a 48px height.
    &__head,
    &__row {
      display:       flex;
      align-items:   center;
      box-sizing:    border-box;
      width:         100%;
      height:        $row-height;
      margin:        0;
      padding:       0 $gap 0 $rail;
    }

    &__head {
      border-top: 1px solid var(--nav-border, var(--border));

      .dev-sidebar__glyph {
        color:     var(--primary);
        font-size: 14px;
      }
    }

    // The left rail: the section's icon and a row's state dot are the same box, so they share
    // one vertical line, and the labels after them share another.
    &__glyph {
      flex:        0 0 $rail;
      width:       $rail;
      margin-right: $gap;
      text-align:  left;
    }

    &__label {
      flex:           1 1 auto;
      min-width:      0;
      overflow:       hidden;
      color:          var(--muted);
      font-size:      12px;
      font-weight:    600;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      text-overflow:  ellipsis;
      white-space:    nowrap;
      // A section heading is not a link and must not pick one's underline up from anywhere.
      text-decoration: none;
    }

    // One colour for every workspace name, whatever state it is in: a stopped workspace is
    // still one whose name you are trying to read. State is the dot's job and only the dot's.
    &__link {
      display:         flex;
      align-items:     center;
      flex:            1 1 auto;
      min-width:       0;
      height:          100%;
      color:           var(--body-text);
      font-size:       14px;
      line-height:     16px;
      text-decoration: none;

      &:hover,
      &:focus {
        text-decoration: none;
      }
    }

    &__row {
      .icon-dot {
        font-size:   8px;
        line-height: 1;
      }
    }

    // The state dot, pulled toward the body text until it is legible on the body background.
    //
    // Rancher's state colours are not theme-aware: --success is rgb(0, 112, 50) in both themes,
    // and only the background moves, so on the dark nav it measures 2.36:1 where a graphical
    // object needs 3:1. --error and --primary have the same problem. There is no token to switch
    // to either: the click-badge family is white for error and info in both themes, and the gauge
    // colours are a different vocabulary.
    //
    // So the state colour is kept and mixed toward --body-text, which is the one colour each
    // theme guarantees against its own background. In dark that lightens it, in light it deepens
    // it, and the direction is right in both without this file knowing which theme it is in or
    // inventing a colour of its own. A browser without color-mix ignores the declaration and gets
    // the state colour unchanged, which is where this started.
    &__dot .icon-dot {
      color: color-mix(in srgb, currentColor, var(--body-text) 45%);

      &:hover {
        background: var(--nav-hover, var(--accent-btn));
      }

      // Selected is a background and a weight, not a colour. Rancher's own nav pairs
      // --active-nav with --on-active, but only the second is defined in every theme here, and
      // taking one without the other is how a selected row ends up white on white.
      &--current {
        background: var(--nav-hover, var(--accent-btn));

        .dev-sidebar__link {
          font-weight: 600;
        }
      }
    }

    // The name, truncated rather than wrapped: a row is one line and a workspace name can be
    // forty characters. It shrinks before the control does, so a long name never runs under it.
    &__name {
      overflow:      hidden;
      text-overflow: ellipsis;
      white-space:   nowrap;
    }

    // The right-hand control of either row: one box, one column, one place.
    //
    // `min-height` as well as `height`, because one of the shell's global BUTTON rules sets a
    // 40px minimum and a minimum beats a height. Without it the row's delete is a 22x40 box
    // against the section's 22x22 plus, and the two rails stop lining up.
    &__control {
      display:         flex;
      align-items:     center;
      justify-content: center;
      flex:            0 0 $control;
      width:           $control;
      height:          $control;
      min-height:      $control;
      padding:         0;
      border:          none;
      border-radius:   var(--border-radius);
      background:      transparent;
      color:           var(--muted);
      cursor:          pointer;

      .icon {
        font-size: 12px;
      }
    }

    // The create control, outlined so it reads as a button rather than as another row icon.
    //
    // Both colours here are foreground tokens rather than --primary and --border, and that is
    // the point: --primary on the nav background is 2.93:1 in dark, and --border is about 1.4:1
    // in both themes, which is a control nobody can see with a glyph nobody can read. --muted
    // and --body-text are the two colours this nav already uses for text, so they are legible on
    // it by construction.
    &__control--bordered {
      border: 1px solid var(--muted);
      color:  var(--body-text);

      &:hover {
        background: var(--nav-hover, var(--accent-btn));
      }
    }

    // Quiet until you are near the thing it acts on, and always there for a keyboard. Opacity
    // rather than display, so the row's layout is the same whether it is showing or not.
    &__reveal {
      opacity: 0;

      &:focus-visible {
        opacity: 1;
      }
    }

    &__section:hover &__head &__reveal,
    &__row:hover &__reveal {
      opacity: 1;
    }

    &__delete {
      &:hover,
      &:focus-visible {
        opacity: 1;
        color:   var(--error);
      }

      &--confirm {
        opacity: 1;
        color:   var(--error);
      }
    }

    &__empty {
      padding:   0 $gap ($gap / 2) calc(#{$rail} + #{$rail} + #{$gap});
      color:     var(--muted);
      font-size: 12px;
    }

    &__error {
      padding:   $gap $rail;
      color:     var(--error);
      font-size: 12px;
    }

    &__globals {
      display:         flex;
      align-items:     center;
      justify-content: center;
      gap:             $gap;
      padding:         $gap;
      border-top:      1px solid var(--nav-border, var(--border));

      // One box for all four, so they read as a set: same size, same radius, same hover, and
      // the button reset so it cannot inherit a different weight from the user agent. The
      // min-height is part of that reset: a shell rule gives every BUTTON a 40px minimum, which
      // beats a height and left the Terminal button 28x40 in a row of 28x28 links.
      a,
      button {
        display:         flex;
        align-items:     center;
        justify-content: center;
        width:           28px;
        height:          28px;
        min-height:      28px;
        margin:          0;
        padding:         0;
        border:          none;
        border-radius:   var(--border-radius);
        background:      transparent;
        color:           var(--body-text);
        font:            inherit;
        line-height:     1;
        appearance:      none;
        cursor:          pointer;

        .icon {
          font-size: 16px;
        }

        &:hover {
          background: var(--nav-hover, var(--accent-btn));
        }
      }

      &--current {
        background:  var(--nav-hover, var(--accent-btn));
        font-weight: 600;
      }
    }
  }
</style>
