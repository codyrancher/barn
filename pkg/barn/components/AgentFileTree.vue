<script>
// One directory of a file tree, and every directory under it.
//
// Recursive, which in a single-file component means the `name` above is load-bearing: it is how
// the template below resolves itself. Vue registers a component under its own name for exactly
// this, and without it the tree renders one level deep and silently stops.
//
// The shape is the one a pull request's file list uses, because that is the shape people already
// know how to read: a caret per directory, a click to fold it, one indent per level, and a
// directory with a single child folded into its parent so a path nobody branched at does not
// cost four rows to walk past.
export default {
  name: 'AgentFileTree',

  props: {
    node: {
      type:     Object,
      required: true,
    },

    // The file currently open, so the row for it can say so.
    current: {
      type:    String,
      default: '',
    },
  },

  emits: ['select'],

  data() {
    return {
      // Open by default. There are a handful of these files and the reason to look at the tree
      // at all is to see them; starting folded would mean clicking through to find that out.
      open: true,
    };
  },
};
</script>

<template>
  <div class="agent-tree">
    <button
      type="button"
      class="agent-tree__dir"
      :aria-expanded="open"
      @click="open = !open"
    >
      <span
        class="agent-tree__caret"
        :class="{ 'agent-tree__caret--open': open }"
      >&#9656;</span>
      {{ node.name }}
    </button>

    <div
      v-if="open"
      class="agent-tree__children"
    >
      <AgentFileTree
        v-for="child in node.dirs"
        :key="child.path"
        :node="child"
        :current="current"
        @select="$emit('select', $event)"
      />
      <button
        v-for="file in node.files"
        :key="file.path"
        type="button"
        class="agent-tree__file"
        :class="{ 'agent-tree__file--current': file.path === current }"
        @click="$emit('select', file.path)"
      >
        {{ file.name }}
      </button>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.agent-tree {
  &__dir,
  &__file {
    display:     block;
    width:       100%;
    text-align:  left;
    padding:     0 6px;
    border:      none;
    background:  none;
    cursor:      pointer;
    font-size:   12px;
    // Explicit, and `min-height` with it: the shell gives every button a minimum height for
    // touch targets, which is right for a form and turns a twenty-row tree into a scroll.
    line-height: 22px;
    height:      22px;
    min-height:  0;
    white-space: nowrap;
    overflow:    hidden;
    text-overflow: ellipsis;
    border-radius: var(--border-radius);
  }

  // Muted, because a directory is the address of a file rather than a thing to open, and the
  // files are what the eye should land on.
  &__dir {
    color: var(--muted);
  }

  &__file {
    // The colour a link is, which is what these are: the tree is a list of things to open.
    color: var(--link);
    // Directories are structure and files are content, so the files carry the code font.
    font-family: monospace;

    &:hover {
      background: var(--accent-btn);
    }

    &--current {
      background: var(--accent-btn);
      color:      var(--body-text);
      font-weight: 600;
    }
  }

  &__caret {
    display:    inline-block;
    width:      12px;
    font-size:  10px;
    color:      var(--muted);
    transition: transform 100ms;

    &--open {
      transform: rotate(90deg);
    }
  }

  // One indent per level, applied by the nesting itself rather than by a depth prop, so a tree
  // of any depth is a tree of any depth.
  &__children {
    padding-left: 11px;
  }
}
</style>
