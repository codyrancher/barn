<script>
// What the agent in this pod is working from, and a place to change it.
//
// A terminal tells you what claude said. It does not tell you what claude was told, and in a
// pod that is four separate things in four places: the instructions committed with the tree,
// the ones in its home directory, the skills it can invoke, and the per-conversation copy
// shell.sh drops into a new session. Between them they decide most of what happens in the pane
// next door, and until now the only way to see any of them was to ask claude to cat them.
//
// So: the list on the left is found in the pod rather than declared here, the pane on the
// right is the file, and Save writes it back. No git, no history: these are files in a pod
// whose tree is a working copy, and the thing that makes a change permanent is copying it into
// the repo, which is true of everything else in there too.
import AppModal from '@shell/components/AppModal';
import AsyncButton from '@shell/components/AsyncButton';
import { Card } from '@components/Card';
import { RcButton } from '@components/RcButton';
import { Banner } from '@components/Banner';
import AgentFileTree from './AgentFileTree.vue';
import { listAgentFiles, readAgentFile, writeAgentFile } from '../extensions';

/**
 * The paths, as a tree.
 *
 * Built here rather than asked for, because `find` returns a flat list and a flat list of four
 * files called CLAUDE.md is four identical rows. Every node is a directory holding directories
 * and files, which is the only shape the recursive component below needs.
 */
function buildTree(paths) {
  const root = {
    name: '', path: '', dirs: [], files: []
  };

  for (const path of paths) {
    const parts = path.split('/').filter(Boolean);
    const fileName = parts.pop();
    let node = root;
    let walked = '';

    for (const part of parts) {
      walked += `/${ part }`;

      let next = node.dirs.find((dir) => dir.name === part);

      if (!next) {
        next = {
          name: part, path: walked, dirs: [], files: []
        };
        node.dirs.push(next);
      }

      node = next;
    }

    node.files.push({ name: fileName, path });
  }

  return root;
}

/**
 * Fold a directory that only ever contains one directory into its parent.
 *
 * `.home/.claude` rather than `.home` holding `.claude` holding one file. It is what a pull
 * request's file list does and it is worth the few lines: without it half the rows in this tree
 * are directories nobody branched at, and the files are four indents deep for no reason.
 */
function collapse(node) {
  for (const dir of node.dirs) {
    collapse(dir);
  }

  for (const dir of node.dirs) {
    while (dir.dirs.length === 1 && !dir.files.length) {
      const only = dir.dirs[0];

      dir.name = `${ dir.name }/${ only.name }`;
      dir.path = only.path;
      dir.files = only.files;
      dir.dirs = only.dirs;
    }
  }

  return node;
}

export default {
  name: 'AgentFilesModal',

  components: {
    AppModal, AsyncButton, Card, RcButton, Banner, AgentFileTree
  },

  props: {
    // Which extension's pod to look in.
    extension: {
      type:     String,
      required: true,
    },
  },

  emits: ['close'],

  data() {
    return {
      files:    [],
      selected: '',
      contents: '',
      // What was read, so Save can be offered only when there is something to save.
      original: '',
      loading:  true,
      error:    '',
    };
  },

  computed: {
    dirty() {
      return this.contents !== this.original;
    },

    /**
     * The tree, rooted at the deepest directory every one of these files is under.
     *
     * Everything is inside `/app`, so showing it would be one row of indent that says nothing.
     * The prefix is not thrown away though - it goes above the tree, because these are paths in
     * a pod and where they are is part of what they are.
     */
    tree() {
      let node = collapse(buildTree(this.files));

      // Walk down through the single-child directories at the top; where that stops is the
      // deepest directory every one of these files is under.
      while (node.dirs.length === 1 && !node.files.length) {
        node = node.dirs[0];
      }

      return { prefix: node.path || '/', dirs: node.dirs, files: node.files };
    },
  },

  mounted() {
    this.refresh();
  },

  methods: {
    async refresh() {
      this.loading = true;
      this.error = '';

      try {
        this.files = await listAgentFiles(this.extension);

        if (this.files.length) {
          await this.open(this.files[0]);
        }
      } catch (e) {
        this.error = e.message || String(e);
      } finally {
        this.loading = false;
      }
    },

    async open(path) {
      this.selected = path;
      this.contents = await readAgentFile(this.extension, path);
      this.original = this.contents;
    },

    async save(done) {
      try {
        await writeAgentFile(this.extension, this.selected, this.contents);
        this.original = this.contents;
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
  <AppModal
    name="barn-agent-files"
    :width="900"
    @close="$emit('close')"
  >
    <Card
      class="agent-files"
      :show-highlight-border="false"
    >
      <template #title>
        <h4 class="text-default-text">
          Agent files in {{ extension }}
        </h4>
      </template>

      <template #body>
        <Banner
          v-if="error"
          color="error"
          :label="error"
        />

        <p class="agent-files__intro">
          Everything claude in this pod reads before it reads the code. These are files in the
          pod, so an edit here takes effect on the next thing it reads them for, and lives only
          as long as the pod's tree does.
        </p>

        <div
          v-if="loading"
          class="text-muted"
        >
          Looking in the pod
        </div>
        <div
          v-else-if="!files.length"
          class="text-muted"
        >
          Nothing yet. A pod that is still installing has none of these, and neither does one
          where claude has never run.
        </div>

        <div
          v-else
          class="agent-files__panes"
        >
          <nav class="agent-files__list">
            <div class="agent-files__root">
              {{ tree.prefix }}
            </div>
            <AgentFileTree
              v-for="dir in tree.dirs"
              :key="dir.path"
              :node="dir"
              :current="selected"
              @select="open"
            />
            <button
              v-for="file in tree.files"
              :key="file.path"
              type="button"
              class="agent-files__loose"
              :class="{ 'agent-files__loose--current': file.path === selected }"
              @click="open(file.path)"
            >
              {{ file.name }}
            </button>
          </nav>

          <div class="agent-files__editor">
            <label
              class="agent-files__path"
              :for="'agent-file-body'"
            >{{ selected }}</label>
            <textarea
              id="agent-file-body"
              v-model="contents"
              spellcheck="false"
            />
          </div>
        </div>
      </template>

      <template #actions>
        <div class="agent-files__actions">
          <RcButton
            variant="tertiary"
            @click="$emit('close')"
          >
            Close
          </RcButton>
          <AsyncButton
            mode="apply"
            :disabled="!dirty || !selected"
            @click="save"
          />
        </div>
      </template>
    </Card>
  </AppModal>
</template>

<style lang="scss" scoped>
.agent-files {
  &__intro {
    max-width: 80ch;
    margin-bottom: 15px;
    color: var(--muted);
  }

  &__panes {
    display: flex;
    gap: 15px;
    // Tall enough to be an editor and short enough to leave the modal on the screen.
    height: 60vh;
  }

  &__list {
    flex: 0 0 260px;
    overflow-y: auto;
    border: 1px solid var(--border);
    border-radius: var(--border-radius);
    padding: 5px;
  }

  // Where the tree starts, since the tree itself is relative to it.
  &__root {
    font-size:     11px;
    font-family:   monospace;
    color:         var(--muted);
    padding:       2px 6px 6px;
    overflow:      hidden;
    text-overflow: ellipsis;
    white-space:   nowrap;
  }

  // A file directly in the root directory, which has no directory row to sit under.
  &__loose {
    display:       block;
    width:         100%;
    text-align:    left;
    padding:       0 6px;
    height:        22px;
    min-height:    0;
    border:        none;
    border-radius: var(--border-radius);
    background:    none;
    color:         var(--link);
    font-family:   monospace;
    font-size:     12px;
    line-height:   22px;
    cursor:        pointer;

    &:hover {
      background: var(--accent-btn);
    }

    &--current {
      background:  var(--accent-btn);
      color:       var(--body-text);
      font-weight: 600;
    }
  }

  &__editor {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 5px;
  }

  &__path {
    font-size: 11px;
    color: var(--muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  textarea {
    flex: 1 1 auto;
    width: 100%;
    resize: none;
    font-family: monospace;
    font-size: 12px;
    line-height: 1.5;
  }

  &__actions {
    display: flex;
    gap: 10px;
    justify-content: flex-end;
    width: 100%;
  }
}
</style>
