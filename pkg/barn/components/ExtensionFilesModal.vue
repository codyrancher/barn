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
import DiffView from './DiffView.vue';
import {
  ensureExtensionRepo, listExtensionFiles, readExtensionFile,
  listBranches, checkoutBranch, listCommits, commitExtension, countChanges, showCommit
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

/**
 * The commit message box: one line to start with, ten at most.
 *
 * The line height is ours rather than inherited, because the maximum is expressed in lines and
 * a maximum in pixels that happens to be ten lines today is one that quietly becomes nine when
 * somebody changes a font.
 */
const MESSAGE_LINE = 20;
const MESSAGE_LINES = 10;

/** How many commits the list shows before it has to be asked for the rest. */
const COMMITS_SHOWN = 3;

export default {
  name: 'ExtensionFilesModal',

  components: {
    AppModal, AsyncButton, LabeledSelect, LabeledInput, Card, RcButton, Banner, FileTree, DiffView
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
      MESSAGE_LINE,
      MESSAGE_LINES,
      files:    [],
      branches: [],
      branch:   '',
      commits:  [],
      changes:  0,
      selected: '',
      contents: '',
      message:  '',
      loading:  true,
      error:    '',
      // The commit whose diff is on screen, and the diff itself. Opening one replaces the file
      // view, because they are the same question - what does this look like - about two
      // different things, and two panes of it would halve both.
      showing:  '',
      diff:     '',
      diffLoading: false,
      allCommits:  false,
    };
  },

  computed: {
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

    visibleCommits() {
      return this.allCommits ? this.commits : this.commits.slice(0, COMMITS_SHOWN);
    },

    hiddenCommits() {
      return Math.max(0, this.commits.length - COMMITS_SHOWN);
    },

    /**
     * The diff, split so each line can be coloured.
     *
     * Four kinds, which is all a unified diff needs: the file headers, the hunk markers, and the
     * two directions. `+++` and `---` are checked before `+` and `-` or every file header would
     * be painted as an added and a removed line.
     */
    /** The subject of the commit being shown, for the line above its diff. */
    showingSubject() {
      return this.commits.find((entry) => entry.sha === this.showing)?.subject || '';
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

    /** Show a commit instead of a file. */
    async openCommit(sha) {
      this.showing = sha;
      this.diff = '';
      this.diffLoading = true;

      try {
        this.diff = await showCommit(this.extension, sha);
      } catch (e) {
        this.error = e.message || String(e);
      } finally {
        this.diffLoading = false;
      }
    },

    async open(path) {
      // Opening a file puts the diff away: the pane shows one thing at a time.
      this.showing = '';
      this.selected = path;
      this.contents = await readExtensionFile(this.extension, path);
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

            <div
              class="ext-files__commits"
              :class="{ 'ext-files__commits--all': allCommits }"
            >
              <div class="ext-files__heading">
                Commits on {{ branch }}
              </div>
              <ol>
                <li
                  v-for="entry in visibleCommits"
                  :key="entry.sha"
                >
                  <button
                    type="button"
                    class="ext-files__commit-row"
                    :class="{ 'ext-files__commit-row--current': entry.sha === showing }"
                    @click="openCommit(entry.sha)"
                  >
                    <span class="ext-files__sha">{{ entry.sha }}</span>
                    <span class="ext-files__subject">{{ entry.subject }}</span>
                    <span class="ext-files__when">{{ entry.when }}</span>
                  </button>
                </li>
              </ol>
              <div
                v-if="!commits.length"
                class="text-muted"
              >
                None yet.
              </div>
              <button
                v-if="hiddenCommits || allCommits"
                type="button"
                class="ext-files__more"
                @click="allCommits = !allCommits"
              >
                {{ allCommits ? 'Show fewer' : `Show all ${ commits.length }` }}
              </button>
            </div>

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

          </div>

          <div class="ext-files__editor">
            <!--
              The commit and what it is about, over the file being edited rather than in the
              footer beside Close. A message describes work in this pane, and down there it was
              as far from that work as the dialog allowed.
            -->
            <div
              v-if="changes"
              class="ext-files__commit"
            >
              <!--
                Labelled, like the branch box across from it. A LabeledSelect carrying a label
                is a two-row control and a placeholder-only input is one, so without this they
                were different heights side by side for a structural reason rather than a
                stylistic one.

                It grows downward over the file view rather than pushing it, which is what the
                absolute positioning below is for: a commit message that runs to a paragraph is
                normal, and the file underneath sliding down every time somebody presses return
                is not something to do to a person who is reading it.
              -->
              <LabeledInput
                v-model:value="message"
                class="ext-files__message"
                type="multiline"
                :label="`Commit message (${ changes } changed file${ changes === 1 ? '' : 's' })`"
                :compact-input="true"
                :min-height="MESSAGE_LINE"
                :max-height="MESSAGE_LINE * MESSAGE_LINES"
              />
              <AsyncButton
                mode="edit"
                action-label="Commit"
                waiting-label="Committing"
                success-label="Committed"
                @click="commit"
              />
            </div>
            <label
              class="ext-files__path"
              for="ext-file-body"
            >{{ showing ? `commit ${ showing }` : (selected || 'Nothing open') }}</label>

            <div
              v-if="showing"
              class="ext-files__view"
            >
              <div
                v-if="diffLoading"
                class="text-muted"
              >
                Reading the commit
              </div>
              <DiffView
                v-else
                :patch="diff"
                :subject="showingSubject"
              />
            </div>

            <!--
              Read-only. This is a browser for what is in the pod, not an editor: the editing
              happens in the pane behind this dialog, by the thing running there, and a second
              place to change the same files is a second place for them to disagree.
            -->
            <pre
              v-else
              class="ext-files__view ext-files__file-body"
            >{{ contents }}</pre>
          </div>
        </div>
      </template>

      <template #actions>
        <div class="ext-files__actions">
          <RcButton
            variant="tertiary"
            @click="$emit('close')"
          >
            Close
          </RcButton>
        </div>
      </template>
    </Card>
  </AppModal>
</template>

<style lang="scss" scoped>
// One gap between the boxes in this dialog. The two columns had 10px, 8px and 5px between
// their own, which is what made the left and right sides look out of step with each other.
$gap: 10px;
$message-line: 20;
// What the Commit button beside the message needs, so the message can stop short of it.
$commit-button-width: 110px;

.ext-files {
  &__panes {
    display: flex;
    gap: 15px;
    // Tall enough to be an editor and short enough to leave the modal on the screen.
    height: 65vh;
  }

  &__side {
    flex:           0 0 300px;
    display:        flex;
    flex-direction: column;
    gap:            $gap;
    min-height:     0;
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

  // Three commits by default and no scroll: at three it is a glance rather than a list, and it
  // leaves the room to the tree, which is the thing being navigated.
  &__commits {
    flex:          0 0 auto;
    overflow-y:    auto;
    border:        1px solid var(--border);
    border-radius: var(--border-radius);
    padding:       5px;

    // Expanded, it scrolls rather than growing without limit, so the tree keeps a usable share
    // of the pane however long the history is.
    &--all {
      max-height: 40%;
    }

    ol {
      list-style: none;
      margin:     0;
      padding:    0;
    }
  }

  &__commit-row {
    display:       flex;
    gap:           6px;
    align-items:   baseline;
    width:         100%;
    padding:       1px 4px;
    border:        none;
    border-radius: var(--border-radius);
    background:    none;
    text-align:    left;
    font-size:     11px;
    line-height:   20px;
    // Both, because the shell puts a minimum height on every button for touch targets, which
    // here would make three commits as tall as the tree.
    height:        22px;
    min-height:    0;
    white-space:   nowrap;
    cursor:        pointer;

    &:hover {
      background: var(--nav-hover, var(--accent-btn));
    }

    &--current {
      background:  var(--accent-btn);
      font-weight: 600;
    }
  }

  &__more {
    display:         block;
    margin:          2px 0 0 4px;
    padding:         0;
    border:          none;
    min-height:      0;
    background:      none;
    color:           var(--link);
    font-size:       11px;
    cursor:          pointer;
    text-decoration: underline;
  }

  // One box for both: the file and a commit's diff are the same question about two things, and
  // switching between them should not also change the shape of the pane.
  &__view {
    flex:          1 1 auto;
    min-height:    0;
    overflow:      auto;
    margin:        0;
    padding:       8px 10px;
    border:        1px solid var(--border);
    border-radius: var(--border-radius);
    background:    var(--body-bg);
  }

  &__file-body {
    font-family: monospace;
    font-size:   12px;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break:  break-word;
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
    flex:           1 1 auto;
    min-width:      0;
    display:        flex;
    flex-direction: column;
    gap:            5px;
  }

  &__path {
    font-size: 11px;
    font-family: monospace;
    color: var(--muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  &__actions {
    display: flex;
    gap: 10px;
    align-items: center;
    justify-content: flex-end;
    width: 100%;
  }

  &__commit {
    position:      relative;
    display:       flex;
    // Against the middle of the box beside it, which is where it looks like it belongs while
    // that box is one line tall - and it stays there when the box grows over the view below,
    // because the row's own height does not change.
    align-items:   center;
    justify-content: flex-end;
    gap:           $gap;
    margin-bottom: $gap;
    // The height of the box at one line. Fixed, so the row keeps its size while the box inside
    // it grows over what is below.
    height:        61px;
  }

  &__message {
    // Out of the flow, so growing changes nothing about the layout around it. The right edge
    // stops short of the button, which stays where it is.
    //
    // A width rather than a `right`, because LabeledInput sets `width: 100%` on itself: left,
    // right and width together over-constrain the box, and the rule is that `right` is the one
    // dropped. The symptom was the message lying across the Commit button and hiding it.
    position: absolute;
    top:      0;
    left:     0;
    width:    calc(100% - #{$commit-button-width});
    z-index:  10;

    // Only the line height and the resize grip. The `min-height: 0 !important` that used to be
    // here was me overriding the shell's layout rather than reading it: LabeledInput makes room
    // for its floating label with the field's own padding, and zeroing the minimum collapsed
    // that, so the text started at the same height as the label it was supposed to sit under.
    // The minimum belongs on the component's own prop, which is where it is.
    :deep(textarea) {
      line-height: #{$message-line}px;
      resize:      none;
    }

    // Only once it has outgrown one line: a box that casts a shadow while it is the same size
    // as everything else looks like a mistake rather than like something on top.
    &:focus-within,
    &.ext-files__message--tall {
      box-shadow:    0 4px 12px rgba(0, 0, 0, 0.15);
      border-radius: var(--border-radius);
    }
  }
}
</style>
