'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Unified diff parser
// ─────────────────────────────────────────────────────────────────────────────
// Matches a `git log` commit header line, e.g. "commit abc1234...".
// Accepts 7-64 hex chars: a short hash, a full SHA-1 (40 chars), or a full
// SHA-256 (64 chars, repos initialized with --object-format=sha256).
// (`--decorate`/other --pretty formats are not recognised; only the default
// `git log -p` header format is supported.)
const GIT_LOG_COMMIT_LINE_RE = /^commit ([0-9a-f]{7,64})\b/;

/**
 * Parse unified diff text into an array of files, each with its hunks.
 *
 * Also recognises `git log -p` output: a `commit <hash>` line (plus the
 * following `Author:` / `Date:` / `Merge:` header lines and the first line
 * of the indented commit message) attaches a `commit` descriptor to every
 * file that follows it, up to the next `commit` line. `git show <commit>`'s
 * default output has the same `commit <hash>` header as a single `git log -p`
 * entry, so it is recognised the same way and gets a commit heading too.
 * Plain `git diff` output never emits a `commit ` line, so its files' `commit`
 * stays null and behavior there is unchanged from before commit-awareness
 * was added. A commit with no diff (e.g. a merge commit, since `git log -p`
 * omits merge diffs by default) simply produces no file entries and is
 * dropped — there is nothing to review for it.
 */
function parseDiff(text) {
  const lines = text.split(/\r?\n/);
  const files = [];
  let curFile = null;
  let curHunk = null;
  let curCommit = null;      // current git-log commit descriptor, or null for plain diff input
  let awaitingSubject = false; // true between a "commit " line and the first line of its message body

  function commitHunk() {
    if (curHunk && curFile) {
      for (const h of splitLargeHunk(curHunk)) curFile.hunks.push(h);
      curHunk = null;
    }
  }
  function commitFile() {
    commitHunk();
    if (curFile && curFile.hunks.length > 0) files.push(curFile);
    curFile = null;
  }

  for (const line of lines) {
    const commitMatch = line.match(GIT_LOG_COMMIT_LINE_RE);
    if (commitMatch) {
      commitFile();
      curCommit = { hash: commitMatch[1], shortHash: commitMatch[1].slice(0, 7), author: '', date: '', subject: '' };
      awaitingSubject = true;
      continue;
    }

    if (curCommit && awaitingSubject) {
      if (line.startsWith('Author:')) { curCommit.author = line.slice(7).trim(); continue; }
      if (line.startsWith('Date:'))   { curCommit.date   = line.slice(5).trim(); continue; }
      if (line.startsWith('Merge:'))  { continue; }
      if (line.trim() !== '' && !line.startsWith('diff --git ')) {
        // First non-blank line of the indented commit message → its subject.
        curCommit.subject = line.trim();
        awaitingSubject = false;
        continue;
      }
      if (line.trim() === '') continue; // blank line within the commit header/message
    }

    if (line.startsWith('diff --git ')) {
      commitFile();
      awaitingSubject = false;
      const m = line.match(/^diff --git a\/.+ b\/(.+)$/);
      curFile = { filePath: m ? m[1] : '', hunks: [], commit: curCommit };

    } else if (line.startsWith('+++ ') && curFile) {
      // "+++ b/path" → prefer this for the file path (handles renames)
      const m = line.match(/^\+\+\+ b\/(.+)$/);
      if (m) curFile.filePath = m[1];
      // "+++ /dev/null" → deleted file; keep path from diff --git line

    } else if (line.startsWith('@@ ') && curFile) {
      commitHunk();
      curHunk = { header: line, lines: [] };

    } else if (curHunk) {
      if (
        line.startsWith('+') ||
        line.startsWith('-') ||
        line.startsWith(' ') ||
        line.startsWith('\\')          // "\ No newline at end of file"
      ) {
        curHunk.lines.push(line);
      }
    }
  }

  commitFile();
  return files;
}

// ─────────────────────────────────────────────────────────────────────────────
// Large-hunk splitting
// ─────────────────────────────────────────────────────────────────────────────
// A newly-added file is emitted by git as a single hunk containing every
// line of the file. Because the hunk's review hash covers all of its lines,
// touching even one line later invalidates the review status of the entire
// file. Splitting oversized hunks into smaller ones at blank-line
// boundaries keeps a small follow-up edit from re-invalidating an
// already-reviewed hunk that it doesn't actually touch.

/** Hunks with more than this many diff lines become eligible for splitting. */
const HUNK_SPLIT_LINE_THRESHOLD = 20;
/** A run of at least this many consecutive blank diff lines is a split point. */
const HUNK_SPLIT_BLANK_RUN = 2;

/**
 * A diff line is "blank" for split-boundary purposes when it carries no
 * content beyond its +/-/space prefix (i.e. the original source line was
 * empty). "\ No newline at end of file" marker lines are never blank.
 * @param {string} line
 * @returns {boolean}
 */
function isBlankDiffLine(line) {
  return line.length <= 1 && !line.startsWith('\\');
}

/**
 * Split a single hunk into several smaller hunks wherever a run of
 * HUNK_SPLIT_BLANK_RUN or more consecutive blank lines occurs, but only if
 * the hunk's total line count exceeds HUNK_SPLIT_LINE_THRESHOLD. Each blank
 * run is kept as trailing context of the sub-hunk that precedes it.
 * @param {{header:string, lines:string[]}} hunk
 * @returns {Array<{header:string, lines:string[]}>}
 */
function splitLargeHunk(hunk) {
  if (hunk.lines.length <= HUNK_SPLIT_LINE_THRESHOLD) return [hunk];

  const groups = [];
  let current = [];
  let i = 0;
  while (i < hunk.lines.length) {
    current.push(hunk.lines[i]);
    if (isBlankDiffLine(hunk.lines[i])) {
      let runLen = 1;
      while (i + runLen < hunk.lines.length && isBlankDiffLine(hunk.lines[i + runLen])) runLen++;
      for (let j = 1; j < runLen; j++) current.push(hunk.lines[i + j]);
      i += runLen;
      if (runLen >= HUNK_SPLIT_BLANK_RUN && i < hunk.lines.length) {
        groups.push(current);
        current = [];
      }
      continue;
    }
    i++;
  }
  if (current.length > 0) groups.push(current);

  if (groups.length <= 1) return [hunk];

  // Recompute each sub-hunk's old/new starting line number and line count
  // from the original hunk's header so line numbers stay correct even
  // though the sub-hunk headers are synthetic (not present in the source diff).
  const { oldStart, newStart } = parseHunkHeader(hunk.header);
  let oldN = oldStart, newN = newStart;
  return groups.map((groupLines, idx) => {
    const gOldStart = oldN, gNewStart = newN;
    let oldCount = 0, newCount = 0;
    for (const line of groupLines) {
      if (line.startsWith('\\')) continue;
      if (line[0] === '+') newCount++;
      else if (line[0] === '-') oldCount++;
      else { oldCount++; newCount++; }
    }
    oldN += oldCount;
    newN += newCount;
    return {
      header: `@@ -${gOldStart},${oldCount} +${gNewStart},${newCount} @@ (${idx + 1}/${groups.length})`,
      lines: groupLines,
    };
  });
}
