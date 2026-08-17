<script>
// A unified diff, rendered the way a pull request renders one.
//
// The first version of this was `git show` in a `pre` with four colours on it, which is readable
// and is not what anybody means by a diff view: no line numbers, no file boundaries, and a
// header block of `index 4adc0ae..5c05c67 100644` at the top of every file that carries nothing
// for a person. So this parses the patch instead - files, then hunks, then lines - and renders
// what a reviewer expects: a bar per file, a gutter of old and new line numbers, and the two
// directions coloured across the whole row rather than only on the text.
//
// Unified rather than side by side. Side by side needs twice the width to say the same thing,
// and this is a pane inside a dialog inside a pane.

/**
 * Split a patch into files, and each file into hunks.
 *
 * Deliberately tolerant: anything it does not recognise before the first `diff --git` is skipped,
 * and a line inside a hunk that is none of ' ', '+' or '-' is kept as context. A patch that
 * confuses this should render as something slightly wrong rather than as nothing at all.
 */
function parsePatch(patch) {
  const files = [];
  let file = null;
  let hunk = null;
  let oldNo = 0;
  let newNo = 0;

  for (const line of (patch || '').split('\n')) {
    if (line.startsWith('diff --git')) {
      // `diff --git a/path b/path`, and the b-side is the one worth showing: for a rename it is
      // where the file ended up, and for everything else the two are the same.
      const match = line.match(/ b\/(.+)$/);

      file = { path: match ? match[1] : line.slice('diff --git '.length), hunks: [] };
      files.push(file);
      hunk = null;
      continue;
    }

    if (!file) {
      continue;
    }

    if (line.startsWith('@@')) {
      // `@@ -oldStart,oldCount +newStart,newCount @@ trailing context`
      const match = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);

      oldNo = match ? Number(match[1]) : 0;
      newNo = match ? Number(match[2]) : 0;
      hunk = { header: match ? match[3].trim() : '', lines: [] };
      file.hunks.push(hunk);
      continue;
    }

    // Everything between the file header and the first hunk: `index`, `--- a/x`, `+++ b/x`,
    // `new file mode`, and so on. None of it is worth a row.
    if (!hunk) {
      continue;
    }

    if (line.startsWith('+')) {
      hunk.lines.push({
        kind: 'add', old: null, new: newNo++, text: line.slice(1)
      });
    } else if (line.startsWith('-')) {
      hunk.lines.push({
        kind: 'remove', old: oldNo++, new: null, text: line.slice(1)
      });
    } else if (line.startsWith('\\')) {
      // "\ No newline at end of file", which belongs to the line before it.
      hunk.lines.push({
        kind: 'note', old: null, new: null, text: line.slice(2)
      });
    } else {
      hunk.lines.push({
        kind: 'context', old: oldNo++, new: newNo++, text: line.slice(1)
      });
    }
  }

  return files;
}

export default {
  name: 'DiffView',

  props: {
    /** The output of `git show` or `git diff`. */
    patch: {
      type:    String,
      default: '',
    },

    /** Shown above the diff: the commit's own message, when there is one. */
    subject: {
      type:    String,
      default: '',
    },
  },

  computed: {
    files() {
      return parsePatch(this.patch);
    },

    /**
     * Added and removed across the whole patch.
     *
     * Counted here rather than read from `--stat`, so this component takes one input and the
     * caller does not have to pass a summary alongside the thing it summarises.
     */
    totals() {
      let added = 0;
      let removed = 0;

      for (const file of this.files) {
        for (const hunk of file.hunks) {
          for (const line of hunk.lines) {
            if (line.kind === 'add') {
              added++;
            } else if (line.kind === 'remove') {
              removed++;
            }
          }
        }
      }

      return { added, removed };
    },
  },

  methods: {
    counts(file) {
      let added = 0;
      let removed = 0;

      for (const hunk of file.hunks) {
        for (const line of hunk.lines) {
          if (line.kind === 'add') {
            added++;
          } else if (line.kind === 'remove') {
            removed++;
          }
        }
      }

      return { added, removed };
    },

    sign(kind) {
      return { add: '+', remove: '-' }[kind] || ' ';
    },
  },
};
</script>

<template>
  <div class="diff">
    <div
      v-if="subject || files.length"
      class="diff__summary"
    >
      <span
        v-if="subject"
        class="diff__subject"
      >{{ subject }}</span>
      <span class="diff__counts">
        {{ files.length }} file{{ files.length === 1 ? '' : 's' }}
        <span class="diff__added">+{{ totals.added }}</span>
        <span class="diff__removed">&minus;{{ totals.removed }}</span>
      </span>
    </div>

    <div
      v-for="file in files"
      :key="file.path"
      class="diff__file"
    >
      <div class="diff__file-head">
        <span class="diff__path">{{ file.path }}</span>
        <span class="diff__added">+{{ counts(file).added }}</span>
        <span class="diff__removed">&minus;{{ counts(file).removed }}</span>
      </div>

      <table class="diff__table">
        <tbody>
          <template
            v-for="(hunk, h) in file.hunks"
            :key="h"
          >
            <tr class="diff__hunk">
              <td
                class="diff__gutter"
                colspan="2"
              />
              <td class="diff__hunk-head">
                {{ hunk.header || '…' }}
              </td>
            </tr>
            <tr
              v-for="(line, l) in hunk.lines"
              :key="`${ h }-${ l }`"
              :class="`diff__row diff__row--${ line.kind }`"
            >
              <td class="diff__gutter">
                {{ line.old ?? '' }}
              </td>
              <td class="diff__gutter">
                {{ line.new ?? '' }}
              </td>
              <td class="diff__code"><span class="diff__sign">{{ sign(line.kind) }}</span>{{ line.text }}</td>
            </tr>
          </template>
        </tbody>
      </table>
    </div>

    <div
      v-if="!files.length"
      class="text-muted"
    >
      Nothing to show.
    </div>
  </div>
</template>

<style lang="scss" scoped>
.diff {
  font-family: monospace;
  font-size:   12px;

  &__summary {
    display:       flex;
    align-items:   baseline;
    gap:           10px;
    margin-bottom: 10px;
  }

  &__subject {
    // The commit's own words, so not the code font.
    font-family: inherit;
    font-weight: 600;
  }

  &__counts {
    margin-left: auto;
    color:       var(--muted);
    white-space: nowrap;
  }

  &__added {
    color: var(--success);
  }

  &__removed {
    color: var(--error);
  }

  &__file {
    margin-bottom: 14px;
    border:        1px solid var(--border);
    border-radius: var(--border-radius);
    overflow:      hidden;
  }

  &__file-head {
    display:       flex;
    align-items:   center;
    gap:           8px;
    padding:       5px 10px;
    background:    var(--accent-btn);
    border-bottom: 1px solid var(--border);
  }

  &__path {
    flex:          1 1 auto;
    min-width:     0;
    overflow:      hidden;
    text-overflow: ellipsis;
    white-space:   nowrap;
    font-weight:   600;
  }

  &__table {
    width:           100%;
    border-collapse: collapse;
    table-layout:    auto;
  }

  &__row,
  &__hunk {
    line-height: 18px;
  }

  // The numbers, which are chrome: fixed width, unselectable, so copying a diff copies the code
  // and not a column of integers down the left of it.
  &__gutter {
    width:         1%;
    padding:       0 8px;
    text-align:    right;
    color:         var(--muted);
    background:    var(--body-bg);
    border-right:  1px solid var(--border);
    user-select:   none;
    white-space:   nowrap;
    vertical-align: top;
  }

  &__code {
    padding:     0 10px 0 4px;
    white-space: pre-wrap;
    word-break:  break-word;
  }

  &__sign {
    display:     inline-block;
    width:       1ch;
    margin-right: 4px;
    color:       var(--muted);
    user-select: none;
  }

  &__hunk-head {
    padding:    0 10px;
    color:      var(--primary);
    background: var(--body-bg);
  }

  // The whole row, not just the text: it is the shape of the change that is read first.
  &__row--add {
    background: rgba(48, 209, 88, 0.12);
  }

  &__row--remove {
    background: rgba(255, 69, 58, 0.12);
  }

  &__row--note {
    color: var(--muted);
  }
}
</style>
