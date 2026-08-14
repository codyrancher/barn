<script>
// The extension's source, in the pod, with its history beside it.
//
// This started as a list of the four files that tell claude what to do, which was useful and
// too narrow: the interesting question in a pod is not only "what was it told" but "what is
// there and what has changed". So it is the whole package now - every file under
// `/app/pkg/<the extension>`, node_modules excluded - with a branch to work on and the commits
// on it.
//
// The tree in the pod is seeded from a ConfigMap rather than cloned, so it arrives with no
// history at all. `ensureExtensionRepo` gives it one the first time this opens: a `git init` and
// a commit of the seeded state, which is what makes a branch dropdown and a commit list mean
// anything. Nothing here pushes anywhere - the remote for this work is the barn repo, and
// getting there is still copying files back.
import AppModal from '@shell/components/AppModal';
import AsyncButton from '@shell/components/AsyncButton';
import LabeledSelect from '@shell/components/form/LabeledSelect';
import { LabeledInput } from '@components/Form/LabeledInput';
import { Card } from '@components/Card';
import { RcButton } from '@components/RcButton';
import { Banner } from '@components/Banner';
import FileTree from './FileTree.vue';
import {
  ensureExtensionRepo, listExtensionFiles, readExtensionFile, writeExtensionFile,
  listBranches, checkoutBranch, listCommits, commitExtension, countChanges
} from '../extensions';

/**
 * The paths, as a tree.
 *
 * Built here rather than asked for, because `find` returns a flat list and a flat list of a
 * hundred files is not something anyone reads. Every node is a directory holding directories and
 * files, which is the only shape the recursive component below needs.
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
      walked = walked ? `${ walked }/${ part }` : part;

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
 * `config/constants` rather than `config` holding `constants`. It is what a pull request's file
 * list does and it is worth the few lines: without it a good half of the rows are directories
 * nobody branched at.
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
  name: 'ExtensionFilesModal',

  components: {
    AppModal, AsyncButton, LabeledSelect, LabeledInput, Card, RcButton, Banner, FileTree
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
      branches: [],
      branch:   '',
      commits:  [],
      changes:  0,
      selected: '',
      contents: '',
      // What was read, so Save is offered only when there is something to save.
      original: '',
      message:  '',
      loading:  true,
      error:    '',
    };
  },

  computed: {
    dirty() {
      return this.contents !== this.original;
    },

    tree() {
      let node = collapse(buildTree(this.files));

      // Walk down through the single-child directories at the top; where that stops is the
      // deepest directory every one of these files is under.
      while (node.dirs.length === 1 && !node.files.length) {
        node = node.dirs[0];
      }

      return { dirs: node.dirs, files: node.files };
    },

    branchOptions() {
      return this.branches.map((branch) => ({ label: branch, value: branch }));
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
        // Before anything is listed: a tree with no history has no branches to put in a
        // dropdown, and this is the first place anybody would notice that.
        await ensureExtensionRepo(this.extension);

        this.files = await listExtensionFiles(this.extension);
        await this.refreshGit();

        if (this.files.length && !this.selected) {
          await this.open(this.firstToShow());
        }
      } catch (e) {
        this.error = e.message || String(e);
      } finally {
        this.loading = false;
      }
    },

    // The parts that change when a commit or a checkout happens, without re-reading the file
    // being edited underneath whoever is editing it.
    async refreshGit() {
      const [branches, commits, changes] = await Promise.all([
        listBranches(this.extension),
        listCommits(this.extension),
        countChanges(this.extension),
      ]);

      this.branches = branches.branches;
      this.branch = branches.current;
      this.commits = commits;
      this.changes = changes;
    },

    /**
     * What to open on arrival.
     *
     * Not `files[0]`, which is alphabetical and therefore `.gitignore` - a file nobody opened
     * this to read. The instructions and the entry point are the two places somebody actually
     * starts from.
     */
    firstToShow() {
      return this.files.find((path) => path === 'CLAUDE.md') ||
        this.files.find((path) => path === 'index.ts') ||
        this.files[0];
    },

    async open(path) {
      this.selected = path;
      this.contents = await readExtensionFile(this.extension, path);
      this.original = this.contents;
    },

    /**
     * Switch branch, or make one.
     *
     * The same taggable shape as the extension box in the header, for the same reason: the
     * moment you want a branch is the moment you are typing its name, and a separate New
     * Branch button would be a second way to say the same thing.
     */
    async onBranch(selected) {
      // Parenthesised, and it has to be: `a ?? b || c` is a syntax error in JavaScript rather
      // than a precedence question, and the parser's complaint about it is that the whole
      // component failed to parse.
      const chosen = typeof selected === 'string' ? selected : (selected?.value ?? selected?.label ?? '');
      const branch = chosen.trim();

      if (!branch || branch === this.branch) {
        return;
      }

      this.error = '';

      const out = await checkoutBranch(this.extension, branch);

      // git says what went wrong on the way out, and the usual one is worth showing: switching
      // with uncommitted changes that the target branch would overwrite.
      if (/error:|fatal:/.test(out)) {
        this.error = out.trim();
      }

      this.files = await listExtensionFiles(this.extension);
      await this.refreshGit();
      await this.open(this.selected);
    },

    async save(done) {
      try {
        await writeExtensionFile(this.extension, this.selected, this.contents);
        this.original = this.contents;
        this.changes = await countChanges(this.extension);
        done(true);
      } catch (e) {
        this.error = e.message || String(e);
        done(false);
      }
    },

    async commit(done) {
      try {
        const out = await commitExtension(this.extension, this.message || 'Edited in the browser');

        if (/error:|fatal:/.test(out)) {
          throw new Error(out.trim());
        }

        this.message = '';
        await this.refreshGit();
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
    name="barn-extension-files"
    :width="1000"
    @close="$emit('close')"
  >
    <Card
      class="ext-files"
      :show-highlight-border="false"
    >
      <template #title>
        <h4 class="text-default-text">
          {{ extension }} files
        </h4>
      </template>

      <template #body>
        <Banner
          v-if="error"
          color="error"
          :label="error"
        />

        <div
          v-if="loading"
          class="text-muted"
        >
          Looking in the pod
        </div>

        <div
          v-else
          class="ext-files__panes"
        >
          <div class="ext-files__side">
            <LabeledSelect
              class="ext-files__branch"
              label="Branch"
              :value="branch"
              :options="branchOptions"
              :taggable="true"
              :searchable="true"
              :clearable="false"
              :compact-input="true"
              @update:value="onBranch"
            />

            <nav class="ext-files__tree">
              <FileTree
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
                class="ext-files__loose"
                :class="{ 'ext-files__loose--current': file.path === selected }"
                @click="open(file.path)"
              >
                {{ file.name }}
              </button>
            </nav>

            <div class="ext-files__commits">
              <div class="ext-files__heading">
                Commits on {{ branch }}
              </div>
              <ol>
                <li
                  v-for="entry in commits"
                  :key="entry.sha"
                >
                  <span class="ext-files__sha">{{ entry.sha }}</span>
                  <span class="ext-files__subject">{{ entry.subject }}</span>
                  <span class="ext-files__when">{{ entry.when }}</span>
                </li>
              </ol>
              <div
                v-if="!commits.length"
                class="text-muted"
              >
                None yet.
              </div>
            </div>
          </div>

          <div class="ext-files__editor">
            <label
              class="ext-files__path"
              for="ext-file-body"
            >{{ selected || 'Nothing open' }}</label>
            <textarea
              id="ext-file-body"
              v-model="contents"
              spellcheck="false"
            />
          </div>
        </div>
      </template>

      <template #actions>
        <div class="ext-files__actions">
          <LabeledInput
            v-if="changes"
            v-model:value="message"
            class="ext-files__message"
            :placeholder="`Commit message for ${ changes } changed file(s)`"
            :compact-input="true"
          />
          <AsyncButton
            v-if="changes"
            mode="edit"
            action-label="Commit"
            waiting-label="Committing"
            success-label="Committed"
            @click="commit"
          />
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
.ext-files {
  &__panes {
    display: flex;
    gap: 15px;
    // Tall enough to be an editor and short enough to leave the modal on the screen.
    height: 65vh;
  }

  &__side {
    flex: 0 0 300px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    min-height: 0;
  }

  &__tree {
    // The tree takes what the branch box and the commits leave, and scrolls inside it.
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    border: 1px solid var(--border);
    border-radius: var(--border-radius);
    padding: 5px;
  }

  &__commits {
    flex: 0 0 auto;
    max-height: 30%;
    overflow-y: auto;
    border: 1px solid var(--border);
    border-radius: var(--border-radius);
    padding: 5px;

    ol {
      list-style: none;
      margin: 0;
      padding: 0;
    }

    li {
      display: flex;
      gap: 6px;
      align-items: baseline;
      font-size: 11px;
      line-height: 20px;
      white-space: nowrap;
    }
  }

  &__heading {
    font-size: 11px;
    color: var(--muted);
    padding: 0 2px 4px;
  }

  &__sha {
    font-family: monospace;
    color: var(--link);
  }

  &__subject {
    // The subject is the part worth reading, so it is the part that gets the room.
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  &__when {
    color: var(--muted);
  }

  &__loose {
    display: block;
    width: 100%;
    text-align: left;
    padding: 0 6px;
    height: 22px;
    min-height: 0;
    border: none;
    border-radius: var(--border-radius);
    background: none;
    color: var(--link);
    font-family: monospace;
    font-size: 12px;
    line-height: 22px;
    cursor: pointer;

    // A different colour from the selected row below, not the same one. They were both
    // --accent-btn, which meant the row under the pointer and the file actually open looked
    // identical and the tree appeared to select things it had not.
    &:hover {
      background: var(--nav-hover, var(--accent-btn));
    }

    &--current {
      background: var(--accent-btn);
      color: var(--body-text);
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
    font-family: monospace;
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
    align-items: center;
    justify-content: flex-end;
    width: 100%;
  }

  &__message {
    // Takes the room the buttons do not, so a message is typed in place rather than in a
    // second dialog on top of this one.
    flex: 1 1 auto;
    max-width: 420px;
  }
}
</style>
