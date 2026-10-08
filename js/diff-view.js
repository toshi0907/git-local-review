'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Render: stat summary (git diff --stat style)
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Build and display a `git diff --stat`-like summary above the diff cards.
 * Each file row shows the filename (clickable to scroll to the section),
 * +additions / -deletions counts, and a visual bar of coloured squares.
 * @param {Array<{filePath:string, hunks:Array<{lines:string[]}>}>} files
 */
function renderStatSummary(files) {
  const panel = document.getElementById('stat-summary');
  panel.innerHTML = '';

  if (!files || files.length === 0) {
    panel.style.display = 'none';
    return;
  }

  // Compute per-file add/del counts
  const stats = files.map(file => {
    let add = 0, del = 0;
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.startsWith('+')) add++;
        else if (line.startsWith('-')) del++;
      }
    }
    return { filePath: file.filePath, add, del };
  });

  const totalAdd = stats.reduce((s, r) => s + r.add, 0);
  const totalDel = stats.reduce((s, r) => s + r.del, 0);
  const maxChange = Math.max(...stats.map(r => r.add + r.del), 1);
  const BAR_MAX = 10; // maximum squares per file

  // Header
  const header = document.createElement('div');
  header.className = 'stat-summary-header';
  header.textContent = `${files.length} ファイル変更`;
  panel.appendChild(header);

  // Per-file rows
  for (const stat of stats) {
    const row = document.createElement('div');
    row.className = 'stat-row';

    const nameEl = document.createElement('span');
    nameEl.className = 'stat-filename';
    nameEl.textContent = stat.filePath;
    nameEl.title = stat.filePath;
    nameEl.addEventListener('click', () => {
      // Find the corresponding file-section by matching its file-path text
      const sections = document.querySelectorAll('#diff-container .file-section');
      for (const sec of sections) {
        const pathEl = sec.querySelector('.file-path');
        if (pathEl && pathEl.textContent === stat.filePath) {
          sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
          break;
        }
      }
    });

    const countEl = document.createElement('span');
    countEl.className = 'stat-counts';
    countEl.innerHTML =
      `<span class="stat-add">+${stat.add}</span>` +
      `<span class="stat-del">-${stat.del}</span>`;

    const addBars = Math.round((stat.add / maxChange) * BAR_MAX);
    const delBars = Math.round((stat.del / maxChange) * BAR_MAX);
    const barEl = document.createElement('span');
    barEl.className = 'stat-bar';
    barEl.innerHTML =
      '<span class="stat-bar-add"></span>'.repeat(addBars) +
      '<span class="stat-bar-del"></span>'.repeat(delBars);

    row.appendChild(nameEl);
    row.appendChild(countEl);
    row.appendChild(barEl);
    panel.appendChild(row);
  }

  // Total row
  const totalRow = document.createElement('div');
  totalRow.className = 'stat-row stat-total';
  totalRow.innerHTML =
    `<span style="flex:1">合計</span>` +
    `<span class="stat-counts">` +
    `<span class="stat-add">+${totalAdd}</span>` +
    `<span class="stat-del">-${totalDel}</span>` +
    `</span>`;
  panel.appendChild(totalRow);

  panel.style.display = '';
}

// ─────────────────────────────────────────────────────────────────────────────
// Render: full diff view
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Build the heading element shown once before the first file of a
 * `git log -p` commit group (see parseDiff()'s `commit` field). Never called
 * for plain `git diff` input, where every file's commit is null.
 * @param {{shortHash:string, subject:string, author:string, date:string}} commit
 */
function buildCommitSectionHeader(commit) {
  const header = document.createElement('div');
  header.className = 'commit-section-header';

  const hashEl = document.createElement('span');
  hashEl.className = 'commit-hash';
  hashEl.textContent = commit.shortHash;
  header.appendChild(hashEl);

  const subjectEl = document.createElement('span');
  subjectEl.className = 'commit-subject';
  subjectEl.textContent = commit.subject;
  header.appendChild(subjectEl);

  if (commit.author || commit.date) {
    const metaEl = document.createElement('span');
    metaEl.className = 'commit-meta';
    metaEl.textContent = [commit.author, commit.date].filter(Boolean).join(' · ');
    header.appendChild(metaEl);
  }

  return header;
}

function renderDiff() {
  const container  = document.getElementById('diff-container');
  const emptyState = document.getElementById('empty-state');
  // Open line-comment forms are part of the DOM being rebuilt; carry their
  // unsaved text over to the new cards (see restoreLineCommentDrafts()).
  const lineCommentDrafts = captureLineCommentDrafts();
  container.innerHTML = '';
  app.fileProgressEls.clear();

  const files = app.parsedDiff;
  if (!files || files.length === 0) {
    emptyState.style.display = 'block';
    clearOverallProgress();
    app.focusedHunkIndex = -1;
    renderStatSummary(null);
    refreshKeywordCounts();
    renderExtractResults();
    if (isMemoPanelOpen()) renderLineCommentList();
    return;
  }

  emptyState.style.display = 'none';

  const allReviews     = loadAllReviews();
  const ownerId        = currentStateOwnerId();
  const projectReviews = ownerId ? (allReviews[ownerId] || Object.create(null)) : Object.create(null);
  const projectLineComments = getProjectLineComments();

  const filter = app.reviewFilter;
  const reviewFilterActive = isReviewFilterActive(filter);
  const filterActive = reviewFilterActive || app.commentFilter;
  let totalHunks = 0, totalReviewed = 0, totalNeedsChanges = 0, totalOnHold = 0;
  let renderedSections = 0;

  // Whether a hunk passes both the review-status filter and the
  // "コメントありのみ" filter (AND-ed together).
  const hunkVisible = (filePath, hunk, status) =>
    (!reviewFilterActive || hunkPassesReviewFilter(status, filter)) &&
    (!app.commentFilter || countLineComments(lineCommentsForHunk(projectLineComments, filePath, hunk.hash)) > 0);

  // Collect files that will actually be rendered (respects the filters)
  const visibleFiles = filterActive
    ? files.filter(f => {
        const rev = projectReviews[f.filePath] || Object.create(null);
        return f.hunks.some(h => hunkVisible(f.filePath, h, rev[h.hash] || null));
      })
    : files;

  renderStatSummary(visibleFiles.length > 0 ? visibleFiles : null);

  let lastCommitHash; // undefined = no commit group started yet; distinct from a real hash and from null (plain-diff files)

  for (const file of files) {
    const fileReviews = projectReviews[file.filePath] || Object.create(null);
    let reviewedCnt = 0, needsChangesCnt = 0, onHoldCnt = 0;
    for (const h of file.hunks) {
      const status = fileReviews[h.hash] || null;
      if (status) reviewedCnt++;
      if (status === 'needs_changes') needsChangesCnt++;
      if (status === 'on_hold') onHoldCnt++;
    }
    totalHunks        += file.hunks.length;
    totalReviewed      += reviewedCnt;
    totalNeedsChanges  += needsChangesCnt;
    totalOnHold        += onHoldCnt;

    // Skip files with no hunk matching the active filter.
    const hasVisibleHunk = !filterActive || file.hunks.some(h => hunkVisible(file.filePath, h, fileReviews[h.hash] || null));
    if (!hasVisibleHunk) continue;

    // git-log input: show a commit heading before the first file of each
    // commit group (never for plain `git diff` input, where commit is null).
    if (file.commit && file.commit.hash !== lastCommitHash) {
      container.appendChild(buildCommitSectionHeader(file.commit));
    }
    lastCommitHash = file.commit ? file.commit.hash : null;

    const section = document.createElement('div');
    section.className = 'file-section';

    // File header
    const fileHeader = document.createElement('div');
    fileHeader.className = 'file-header';

    const pathEl = document.createElement('span');
    pathEl.className = 'file-path';
    pathEl.textContent = file.filePath;

    const progressEl = document.createElement('span');
    progressEl.className = 'file-progress' + (reviewedCnt === file.hunks.length ? ' complete' : '');
    progressEl.textContent = `${reviewedCnt} / ${file.hunks.length} hunk レビュー済み`;
    app.fileProgressEls.set(file.filePath, progressEl);

    fileHeader.appendChild(pathEl);
    fileHeader.appendChild(progressEl);
    section.appendChild(fileHeader);

    // Hunks (skip ones that don't match the active filter)
    const fileLanguage = detectLanguage(file.filePath);
    for (const hunk of file.hunks) {
      const status = fileReviews[hunk.hash] || null;
      if (filterActive && !hunkVisible(file.filePath, hunk, status)) continue;
      section.appendChild(buildHunkCard(file.filePath, hunk, status, fileLanguage,
        lineCommentsForHunk(projectLineComments, file.filePath, hunk.hash)));
    }

    container.appendChild(section);
    renderedSections++;
  }

  if (filterActive && renderedSections === 0) {
    const msg = document.createElement('div');
    msg.className = 'empty-state';
    const onlyNeedsChanges = !app.commentFilter && filter.needs_changes && !filter.unreviewed && !filter.approved && !filter.on_hold;
    if (onlyNeedsChanges) {
      msg.innerHTML = '<span class="icon" aria-hidden="true">🎉</span>「要修正」のハンクはありません';
    } else {
      msg.innerHTML = totalHunks > 0
        ? '<span class="icon" aria-hidden="true">🎉</span>フィルタ条件に一致するハンクはありません'
        : '<span class="icon" aria-hidden="true">📄</span>表示できるハンクがありません';
    }
    container.appendChild(msg);
  }

  setOverallProgress(totalReviewed, totalHunks, totalNeedsChanges, totalOnHold);
  refreshKeywordCounts();
  renderExtractResults();
  if (isMemoPanelOpen()) renderLineCommentList();

  // Reset keyboard hunk focus to the first hunk of the freshly rendered diff
  // (the previous focus index may point at an element that no longer exists).
  setFocusedHunk(0, { scroll: false });
  restoreLineCommentDrafts(lineCommentDrafts);
}

/**
 * Whether a hunk with the given review status should be shown under the
 * current review filter. `status` is one of REVIEW_STATUSES' values, or
 * null/undefined for "unreviewed". `filter` is an app.reviewFilter-shaped
 * { [key]: boolean } map.
 */
function hunkPassesReviewFilter(status, filter) {
  return !!filter[status || 'unreviewed'];
}

// ─────────────────────────────────────────────────────────────────────────────
// Word-level diff highlighting (git --word-diff-style), toggled by app.wordDiff
//
// Applies only to a removed/added line pair that a "replace" block within a
// hunk pairs up — the very same pairing the side-by-side view already uses
// (buildSplitTbody's pendingDel/pendingAdd grouping): consecutive '-' lines
// paired index-for-index with consecutive '+' lines, extras left unpaired.
// A paired line is tokenized and diffed at the word level; the changed
// tokens are wrapped in .worddiff-del / .worddiff-add, unchanged tokens
// render as plain text. Lines with no counterpart (pure add/delete) and
// context lines are unaffected — there is nothing to word-diff them against.
// Word-diffed cells render as plain text rather than through
// highlightHunkLines()'s syntax-highlighted HTML, since merging two
// independent inline-markup sources (syntax highlighting + word-diff spans)
// char-by-char is not attempted here.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Split a line into word / whitespace-run / single-punctuation tokens for
 * word-level diffing. Uses Unicode property escapes (\p{L}/\p{N}) rather
 * than \w so runs of non-Latin letters (e.g. Japanese comments) group into
 * one token instead of one token per character.
 */
function tokenizeForWordDiff(text) {
  return text.match(/[\p{L}\p{N}_]+|[^\S\r\n]+|[^\p{L}\p{N}_\s]/gu) || [];
}

/**
 * LCS-based token diff. Returns an ordered list of {type: 'equal'|'del'|'add', token}.
 * Guards against pathological (e.g. minified) lines, where an O(n*m) DP
 * table would be too large, by falling back to a whole-line replace.
 */
function diffWordTokens(oldTokens, newTokens) {
  const n = oldTokens.length, m = newTokens.length;
  if (n * m > 200000) {
    const ops = oldTokens.map(token => ({ type: 'del', token }));
    for (const token of newTokens) ops.push({ type: 'add', token });
    return ops;
  }

  const dp = new Array(n + 1);
  for (let i = 0; i <= n; i++) dp[i] = new Uint32Array(m + 1);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = oldTokens[i] === newTokens[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const ops = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (oldTokens[i] === newTokens[j]) { ops.push({ type: 'equal', token: oldTokens[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ type: 'del', token: oldTokens[i] }); i++; }
    else { ops.push({ type: 'add', token: newTokens[j] }); j++; }
  }
  while (i < n) { ops.push({ type: 'del', token: oldTokens[i] }); i++; }
  while (j < m) { ops.push({ type: 'add', token: newTokens[j] }); j++; }
  return ops;
}

/**
 * Filter a diffWordTokens() op list down to one side ('del' or 'add'),
 * merging adjacent same-state runs into {text, changed} segments ready for rendering.
 */
function buildWordDiffSegments(ops, side) {
  const segments = [];
  for (const op of ops) {
    let changed;
    if (op.type === 'equal') changed = false;
    else if (op.type === side) changed = true;
    else continue; // belongs to the other side
    const last = segments[segments.length - 1];
    if (last && last.changed === changed) last.text += op.token;
    else segments.push({ text: op.token, changed });
  }
  return segments;
}

/**
 * Pair up '-'/'+' line records within a hunk the same way buildSplitTbody()
 * visually pairs them (consecutive del-run × consecutive add-run, matched
 * index-for-index; a second replace block within the hunk starts a new
 * pairing group). Returns a Map<idx, partnerIdx> covering only paired lines.
 */
function computeWordDiffPairs(records) {
  const pairs = new Map();
  let delGroup = [], addGroup = [];
  const flush = () => {
    const n = Math.min(delGroup.length, addGroup.length);
    for (let k = 0; k < n; k++) {
      pairs.set(delGroup[k].idx, addGroup[k].idx);
      pairs.set(addGroup[k].idx, delGroup[k].idx);
    }
    delGroup = []; addGroup = [];
  };
  for (const r of records) {
    if (r.type === '-') { if (addGroup.length > 0) flush(); delGroup.push(r); }
    else if (r.type === '+') { addGroup.push(r); }
    else flush();
  }
  flush();
  return pairs;
}

// ─────────────────────────────────────────────────────────────────────────────
// Build a single hunk card element
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Walk a hunk's raw diff lines once and compute, for every line, its type
 * ('+' / '-' / ' ' / '\\' for "no newline at end of file"), stripped content,
 * and old/new file line numbers. Both the unified and side-by-side renderers
 * are built on top of this shared list so line numbering is identical (and
 * reviewed/hash identity, which is derived from hunk.lines directly, is
 * completely unaffected by which renderer is used).
 * @param {{header:string, lines:string[]}} hunk
 * @returns {Array<{idx:number, type:string, content:string, oldLabel:(number|''), newLabel:(number|'')}>}
 */
function computeLineRecords(hunk) {
  const { oldStart, newStart } = parseHunkHeader(hunk.header);
  let oldN = oldStart, newN = newStart;
  const records = [];

  hunk.lines.forEach((line, idx) => {
    if (line.startsWith('\\')) {
      records.push({ idx, type: '\\', content: line, oldLabel: '', newLabel: '' });
      return;
    }

    const type    = line[0];
    const content = line.length > 1 ? line.slice(1) : '';
    let oldLabel = '', newLabel = '';
    if (type === '+') {
      newLabel = newN++;
    } else if (type === '-') {
      oldLabel = oldN++;
    } else {
      oldLabel = oldN++;
      newLabel = newN++;
    }

    records.push({ idx, type, content, oldLabel, newLabel });
  });

  return records;
}

/**
 * Build a <td class="line-content"> cell for a single diff line record,
 * reusing the pre-computed highlight.js output when available.
 * @param {{idx:number,type:string,content:string}|null} record
 * @param {string[]|null} hlLines
 * @param {string|null} extraCls - additional CSS class(es) for this cell, or null for none
 * @param {Array<{color:string, keywords:string[]}>} [keywordGroups] - active keyword categories to highlight within this cell's text (see applyKeywordHighlight)
 * @param {Array<{text:string, changed:boolean}>|null} [wordDiffSegments] - when set (word-diff mode, paired del/add line), renders these segments instead of hlLines/plain content
 * @returns {HTMLTableCellElement}
 */
function buildContentCell(record, hlLines, extraCls, keywordGroups, wordDiffSegments) {
  const td = document.createElement('td');
  td.className = 'line-content' + (extraCls ? ' ' + extraCls : '');
  if (!record) return td;

  const pfx = document.createElement('span');
  pfx.className = 'line-prefix';
  pfx.textContent = record.type === '\\' ? '' : record.type;
  td.appendChild(pfx);

  if (wordDiffSegments) {
    const side = record.type === '-' ? 'worddiff-del' : 'worddiff-add';
    for (const seg of wordDiffSegments) {
      if (seg.changed) {
        const span = document.createElement('span');
        span.className = side;
        span.textContent = seg.text;
        td.appendChild(span);
      } else {
        td.appendChild(document.createTextNode(seg.text));
      }
    }
  } else if (hlLines && record.idx < hlLines.length && htmlFragmentRange) {
    // Use a Range-based fragment parse to safely convert highlighted HTML
    // into DOM nodes (avoiding direct innerHTML assignment) without losing
    // leading indentation whitespace — see htmlFragmentRange's doc comment.
    const codeSpan = document.createElement('span');
    codeSpan.appendChild(htmlFragmentRange.createContextualFragment(hlLines[record.idx]));
    td.appendChild(codeSpan);
  } else {
    td.appendChild(document.createTextNode(record.content));
  }

  if (keywordGroups && keywordGroups.length) applyKeywordHighlight(td, keywordGroups);

  return td;
}

/**
 * Build the <tbody> for the current (single-column) unified diff view.
 * `lineComments` is this hunk's { [lineIdx]: LineComment[] } map (or null),
 * whose comments are rendered as rows right below the line they belong to.
 */
function buildUnifiedTbody(hunk, hlLines, keywordGroups, lineComments) {
  const tbody = document.createElement('tbody');
  const records = computeLineRecords(hunk);
  const wordDiffPairs = app.wordDiff ? computeWordDiffPairs(records) : null;
  const wordDiffOpsCache = new Map(); // pair key (min of the two idx) -> diffWordTokens() ops

  for (const record of records) {
    const tr = document.createElement('tr');

    if (record.type === '\\') {
      const td = document.createElement('td');
      td.colSpan = 3;
      td.className = 'line-content line-no-newline';
      td.textContent = record.content;
      if (keywordGroups && keywordGroups.length) applyKeywordHighlight(td, keywordGroups);
      tr.appendChild(td);
      tbody.appendChild(tr);
      continue;
    }

    const cls = record.type === '+' ? 'line-add' : record.type === '-' ? 'line-del' : 'line-context';
    tr.className = cls;

    let wordDiffSegments = null;
    if (wordDiffPairs && wordDiffPairs.has(record.idx)) {
      const partnerIdx = wordDiffPairs.get(record.idx);
      const cacheKey = Math.min(record.idx, partnerIdx);
      let ops = wordDiffOpsCache.get(cacheKey);
      if (!ops) {
        const delRec = record.type === '-' ? record : records[partnerIdx];
        const addRec = record.type === '+' ? record : records[partnerIdx];
        ops = diffWordTokens(tokenizeForWordDiff(delRec.content), tokenizeForWordDiff(addRec.content));
        wordDiffOpsCache.set(cacheKey, ops);
      }
      wordDiffSegments = buildWordDiffSegments(ops, record.type === '-' ? 'del' : 'add');
    }

    const tdOld = document.createElement('td'); tdOld.className = 'line-num'; tdOld.textContent = String(record.oldLabel);
    const tdNew = document.createElement('td'); tdNew.className = 'line-num'; tdNew.textContent = String(record.newLabel);
    const tdCon = buildContentCell(record, hlLines, null, keywordGroups, wordDiffSegments);
    tdOld.appendChild(buildLineCommentAddButton(record));
    for (const td of [tdOld, tdNew, tdCon]) td.dataset.lineIdx = String(record.idx);
    tr.dataset.anchorIdx = String(record.idx);

    tr.appendChild(tdOld); tr.appendChild(tdNew); tr.appendChild(tdCon);
    tbody.appendChild(tr);
    appendLineCommentRows(tbody, [record], lineComments, 3);
  }

  return tbody;
}

/**
 * Build the <tbody> for the side-by-side (split) diff view: removed lines on
 * the left, added lines on the right, context lines spanning both sides.
 *
 * Pairing strategy: consecutive runs of '-' lines and consecutive runs of
 * '+' lines within a hunk are grouped and paired row-by-row (the shorter
 * side is padded with an empty cell). This is a simple, standard approach
 * for side-by-side diff views and does not require a full realignment
 * (Myers-style) of old vs. new content.
 */
function buildSplitTbody(hunk, hlLines, keywordGroups, lineComments) {
  const tbody = document.createElement('tbody');
  const records = computeLineRecords(hunk);

  let pendingDel = [];
  let pendingAdd = [];

  function emitPairedRow(delRec, addRec) {
    const tr = document.createElement('tr');
    tr.className = 'line-split-row';

    const oldCls = delRec ? 'line-del' : 'line-empty';
    const newCls = addRec ? 'line-add' : 'line-empty';

    let delSegments = null, addSegments = null;
    if (app.wordDiff && delRec && addRec) {
      const ops = diffWordTokens(tokenizeForWordDiff(delRec.content), tokenizeForWordDiff(addRec.content));
      delSegments = buildWordDiffSegments(ops, 'del');
      addSegments = buildWordDiffSegments(ops, 'add');
    }

    const tdOldNum = document.createElement('td');
    tdOldNum.className = 'line-num ' + oldCls;
    tdOldNum.textContent = delRec ? String(delRec.oldLabel) : '';

    const tdOldContent = buildContentCell(delRec, hlLines, oldCls, keywordGroups, delSegments);

    const tdNewNum = document.createElement('td');
    tdNewNum.className = 'line-num col-divider ' + newCls;
    tdNewNum.textContent = addRec ? String(addRec.newLabel) : '';

    const tdNewContent = buildContentCell(addRec, hlLines, newCls, keywordGroups, addSegments);

    if (delRec) {
      tdOldNum.appendChild(buildLineCommentAddButton(delRec));
      tdOldNum.dataset.lineIdx = tdOldContent.dataset.lineIdx = String(delRec.idx);
    }
    if (addRec) {
      tdNewNum.appendChild(buildLineCommentAddButton(addRec));
      tdNewNum.dataset.lineIdx = tdNewContent.dataset.lineIdx = String(addRec.idx);
    }
    tr.dataset.anchorIdx = [delRec, addRec].filter(Boolean).map(r => r.idx).join(' ');

    tr.appendChild(tdOldNum);
    tr.appendChild(tdOldContent);
    tr.appendChild(tdNewNum);
    tr.appendChild(tdNewContent);
    tbody.appendChild(tr);
    appendLineCommentRows(tbody, [delRec, addRec].filter(Boolean), lineComments, 4);
  }

  function flushPending() {
    const rows = Math.max(pendingDel.length, pendingAdd.length);
    for (let i = 0; i < rows; i++) {
      emitPairedRow(pendingDel[i] || null, pendingAdd[i] || null);
    }
    pendingDel = [];
    pendingAdd = [];
  }

  function emitContextRow(record) {
    const tr = document.createElement('tr');
    tr.className = 'line-context';

    const tdOldNum = document.createElement('td');
    tdOldNum.className = 'line-num';
    tdOldNum.textContent = String(record.oldLabel);

    // Context rows show identical content on both sides; build it once and
    // clone the node for the second column instead of re-parsing the same
    // highlighted HTML twice.
    const tdOldContent = buildContentCell(record, hlLines, null, keywordGroups);

    const tdNewNum = document.createElement('td');
    tdNewNum.className = 'line-num col-divider';
    tdNewNum.textContent = String(record.newLabel);

    const tdNewContent = tdOldContent.cloneNode(true);

    tdOldNum.appendChild(buildLineCommentAddButton(record));
    for (const td of [tdOldNum, tdOldContent, tdNewNum, tdNewContent]) td.dataset.lineIdx = String(record.idx);
    tr.dataset.anchorIdx = String(record.idx);

    tr.appendChild(tdOldNum);
    tr.appendChild(tdOldContent);
    tr.appendChild(tdNewNum);
    tr.appendChild(tdNewContent);
    tbody.appendChild(tr);
    appendLineCommentRows(tbody, [record], lineComments, 4);
  }

  function emitMarkerRow(record) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 4;
    td.className = 'line-content line-no-newline';
    td.textContent = record.content;
    if (keywordGroups && keywordGroups.length) applyKeywordHighlight(td, keywordGroups);
    tr.appendChild(td);
    tbody.appendChild(tr);
  }

  for (const record of records) {
    if (record.type === '-') {
      // A new deletion block starting after an already-collected addition
      // block (i.e. a second replace within the same hunk) — flush first so
      // the two blocks don't get paired against each other.
      if (pendingAdd.length > 0) flushPending();
      pendingDel.push(record);
    } else if (record.type === '+') {
      pendingAdd.push(record);
    } else {
      flushPending();
      if (record.type === '\\') {
        emitMarkerRow(record);
      } else {
        emitContextRow(record);
      }
    }
  }
  flushPending();

  return tbody;
}

/**
 * `lineComments` is this hunk's { [lineIdx]: LineComment[] } map, or
 * undefined to look it up from localStorage (renderDiff() passes it in so
 * line comments are only read once per render).
 */
function buildHunkCard(filePath, hunk, status, language = null, lineComments = undefined) {
  if (lineComments === undefined) lineComments = getHunkLineComments(filePath, hunk.hash);
  const card = document.createElement('div');
  const startsCollapsed = status === 'approved';
  card.className = 'hunk-card' + (status ? ' status-' + status : '') + (startsCollapsed ? ' collapsed' : '');
  card.dataset.filePath = filePath;
  card.dataset.hunkHash = hunk.hash;

  // ── Header bar ──────────────────────────────────────
  const bar = document.createElement('div');
  bar.className = 'hunk-header-bar';

  const toggleBtn = document.createElement('button');
  toggleBtn.className = 'hunk-toggle-btn';
  toggleBtn.title = startsCollapsed ? '展開' : '折りたたむ';
  toggleBtn.textContent = startsCollapsed ? '▶' : '▼';
  toggleBtn.addEventListener('click', () => {
    setHunkCollapsedState(card, !card.classList.contains('collapsed'));
  });

  const headerText = document.createElement('span');
  headerText.className = 'hunk-header-text';
  headerText.textContent = hunk.header;

  const statusGroup = document.createElement('div');
  statusGroup.className = 'review-status-group';
  statusGroup.setAttribute('role', 'group');
  statusGroup.setAttribute('aria-label', 'レビュー状態');
  for (const s of REVIEW_STATUSES) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'review-status-btn status-' + s.value + (status === s.value ? ' active' : '');
    btn.dataset.status = s.value;
    btn.title = `${s.label}（キーボード: ${s.key}）`;
    btn.setAttribute('aria-pressed', String(status === s.value));
    btn.textContent = `${s.icon} ${s.label}`;
    btn.addEventListener('click', () => {
      const nextStatus = btn.classList.contains('active') ? null : s.value;
      setHunkReviewStatus(card, filePath, hunk.hash, nextStatus);
    });
    statusGroup.appendChild(btn);
  }

  const commentBadge = document.createElement('span');
  commentBadge.className = 'hunk-comment-badge';
  updateHunkCommentBadge(commentBadge, countLineComments(lineComments));

  bar.appendChild(toggleBtn);
  bar.appendChild(headerText);
  bar.appendChild(commentBadge);
  bar.appendChild(statusGroup);
  card.appendChild(bar);

  // ── Diff table ──────────────────────────────────────
  const body = document.createElement('div');
  body.className = 'hunk-body';

  const table = document.createElement('table');
  const isSplit = app.viewMode === 'split';
  table.className = 'diff-table' + (isSplit ? ' diff-table-split' : '');

  // Pre-compute highlighted lines for this hunk (may be null if unavailable).
  // When language is null, highlightHunkLines returns immediately (O(1)).
  const hlLines = highlightHunkLines(hunk.lines, language, filePath);

  // Keyword categories are read once per hunk render; changing them
  // re-renders the whole diff (see the keyword-categories listeners below),
  // so this always reflects the latest configured list.
  const keywordGroups = getActiveKeywordGroups();

  if (isSplit) {
    const thead = document.createElement('thead');
    const trHead = document.createElement('tr');
    const thOld = document.createElement('th'); thOld.colSpan = 2; thOld.textContent = '変更前';
    const thNew = document.createElement('th'); thNew.colSpan = 2; thNew.className = 'col-divider'; thNew.textContent = '変更後';
    trHead.appendChild(thOld); trHead.appendChild(thNew);
    thead.appendChild(trHead);
    table.appendChild(thead);
    table.appendChild(buildSplitTbody(hunk, hlLines, keywordGroups, lineComments));
  } else {
    table.appendChild(buildUnifiedTbody(hunk, hlLines, keywordGroups, lineComments));
  }

  body.appendChild(table);
  card.appendChild(body);

  // Clicking anywhere in the hunk (header bar or diff body) focuses it, so
  // it can be reviewed with the mouse-click + Space keyboard shortcut flow
  // alongside j/k navigation. Skip when the click is the end of a text
  // selection drag within this card (e.g. copying diff text) rather than a
  // plain click — a leftover selection elsewhere on the page shouldn't block
  // focusing this hunk.
  card.addEventListener('click', handleLineCommentCardClick);
  card.addEventListener('change', handleLineCommentCardChange);
  card.addEventListener('click', () => {
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed &&
        card.contains(selection.anchorNode) && card.contains(selection.focusNode)) {
      return;
    }
    const index = getHunkCards().indexOf(card);
    if (index !== -1) setFocusedHunk(index, { scroll: false });
  });

  return card;
}

// ─────────────────────────────────────────────────────────────────────────────
// Set collapsed state on a hunk card
// ─────────────────────────────────────────────────────────────────────────────
function setHunkCollapsedState(card, collapsed) {
  const btn = card.querySelector('.hunk-toggle-btn');
  if (collapsed) {
    card.classList.add('collapsed');
    if (btn) { btn.textContent = '▶'; btn.title = '展開'; }
  } else {
    card.classList.remove('collapsed');
    if (btn) { btn.textContent = '▼'; btn.title = '折りたたむ'; }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Review status change (issue #51)
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Sets (or clears, if `newStatus` is null) a hunk's review status, persists
 * it, updates the card's DOM in place (status classes, status buttons,
 * collapse state), and refreshes progress/filtering.
 * @param {HTMLElement} card
 * @param {string} filePath
 * @param {string} hash
 * @param {string|null} newStatus - one of REVIEW_STATUSES' values, or null for "unreviewed"
 */
function setHunkReviewStatus(card, filePath, hash, newStatus) {
  const ownerId = currentStateOwnerId();
  if (!ownerId) return;
  const allReviews = loadAllReviews();
  if (!allReviews[ownerId])           allReviews[ownerId] = Object.create(null);
  if (!allReviews[ownerId][filePath]) allReviews[ownerId][filePath] = Object.create(null);

  if (newStatus) {
    allReviews[ownerId][filePath][hash] = newStatus;
  } else {
    delete allReviews[ownerId][filePath][hash];
  }
  saveAllReviews(allReviews);
  scheduleSettingsAutoSave();

  for (const s of REVIEW_STATUSES) card.classList.remove('status-' + s.value);
  if (newStatus) card.classList.add('status-' + newStatus);

  for (const btn of card.querySelectorAll('.review-status-btn')) {
    const isActive = btn.dataset.status === newStatus;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-pressed', String(isActive));
  }
  setHunkCollapsedState(card, newStatus === 'approved');

  if (isReviewFilterActive(app.reviewFilter)) {
    // The review filter needs hunks/files to appear or disappear
    // immediately, so re-run the full render rather than a lightweight update.
    renderDiff();
  } else {
    refreshProgress();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Refresh progress badges without re-rendering the whole diff
// ─────────────────────────────────────────────────────────────────────────────
function refreshProgress() {
  if (!app.parsedDiff || !app.currentProjectId) return;

  const projectReviews = (loadAllReviews()[currentStateOwnerId()]) || Object.create(null);
  let totalHunks = 0, totalReviewed = 0, totalNeedsChanges = 0, totalOnHold = 0;

  for (const file of app.parsedDiff) {
    const fileReviews = projectReviews[file.filePath] || Object.create(null);
    let rev = 0, needsChanges = 0, onHold = 0;
    for (const h of file.hunks) {
      const status = fileReviews[h.hash] || null;
      if (status) rev++;
      if (status === 'needs_changes') needsChanges++;
      if (status === 'on_hold') onHold++;
    }
    const total = file.hunks.length;
    totalHunks        += total;
    totalReviewed      += rev;
    totalNeedsChanges  += needsChanges;
    totalOnHold        += onHold;

    const el = app.fileProgressEls.get(file.filePath);
    if (el) {
      el.textContent = `${rev} / ${total} hunk レビュー済み`;
      el.className   = 'file-progress' + (rev === total ? ' complete' : '');
    }
  }

  setOverallProgress(totalReviewed, totalHunks, totalNeedsChanges, totalOnHold);
  refreshActiveProjectProgressBadges();
}

function setOverallProgress(reviewed, total, needsChanges = 0, onHold = 0) {
  const el = document.getElementById('overall-progress');
  let text = `全体: ${reviewed} / ${total} hunk レビュー済み`;
  const breakdown = [];
  if (needsChanges > 0) breakdown.push(`要修正 ${needsChanges}`);
  if (onHold > 0) breakdown.push(`保留 ${onHold}`);
  if (breakdown.length > 0) text += `（${breakdown.join('・')}）`;
  el.textContent = text;
  el.classList.toggle('has-progress', reviewed > 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Keyboard navigation between hunks (j/k to move focus, Space to toggle
// レビュー済み on the focused hunk). See keydown listener near the bottom of
// this script for the key handling itself.
// ─────────────────────────────────────────────────────────────────────────────
function getHunkCards() {
  return Array.from(document.querySelectorAll('#diff-container .hunk-card'));
}

function updateFocusedHunkVisual() {
  const cards = getHunkCards();
  cards.forEach((card, i) => {
    card.classList.toggle('focused', i === app.focusedHunkIndex);
  });
}

// Moves keyboard focus to the hunk at `index` (clamped to the valid range of
// currently rendered hunks) and scrolls it into view unless `scroll: false`.
function setFocusedHunk(index, { scroll = true } = {}) {
  const cards = getHunkCards();
  if (cards.length === 0) {
    app.focusedHunkIndex = -1;
    return;
  }

  const clamped = Math.max(0, Math.min(index, cards.length - 1));
  app.focusedHunkIndex = clamped;
  updateFocusedHunkVisual();

  if (scroll) {
    cards[clamped].scrollIntoView({ block: 'nearest' });
  }
}

function moveHunkFocus(delta) {
  const cards = getHunkCards();
  if (cards.length === 0) return;
  const current = app.focusedHunkIndex >= 0 ? app.focusedHunkIndex : 0;
  setFocusedHunk(current + delta);
}

/** Reads the currently focused hunk card's review status from its DOM classes, or null. */
function getHunkStatus(card) {
  for (const s of REVIEW_STATUSES) {
    if (card.classList.contains('status-' + s.value)) return s.value;
  }
  return null;
}

/** Space: cycles the focused hunk's status unreviewed → approved → needs_changes → on_hold → unreviewed. */
function cycleFocusedHunkStatus() {
  const cards = getHunkCards();
  if (app.focusedHunkIndex < 0 || app.focusedHunkIndex >= cards.length) return;
  const card = cards[app.focusedHunkIndex];
  const cycle = [null, ...REVIEW_STATUSES.map(s => s.value)];
  const next = cycle[(cycle.indexOf(getHunkStatus(card)) + 1) % cycle.length];
  setHunkReviewStatus(card, card.dataset.filePath, card.dataset.hunkHash, next);
}

/** Number keys (1/2/3): directly sets the focused hunk's status, toggling off if already set. */
function setFocusedHunkStatus(value) {
  const cards = getHunkCards();
  if (app.focusedHunkIndex < 0 || app.focusedHunkIndex >= cards.length) return;
  const card = cards[app.focusedHunkIndex];
  const next = getHunkStatus(card) === value ? null : value;
  setHunkReviewStatus(card, card.dataset.filePath, card.dataset.hunkHash, next);
}

function clearOverallProgress() {
  const el = document.getElementById('overall-progress');
  el.textContent = '';
  el.classList.remove('has-progress');
}

// ─────────────────────────────────────────────────────────────────────────────
// View mode toggle (unified <-> side-by-side)
// ─────────────────────────────────────────────────────────────────────────────
function updateViewModeButtons() {
  const unifiedBtn = document.getElementById('view-mode-unified');
  const splitBtn   = document.getElementById('view-mode-split');
  if (unifiedBtn) {
    unifiedBtn.classList.toggle('active', app.viewMode === 'unified');
    unifiedBtn.setAttribute('aria-pressed', String(app.viewMode === 'unified'));
  }
  if (splitBtn) {
    splitBtn.classList.toggle('active', app.viewMode === 'split');
    splitBtn.setAttribute('aria-pressed', String(app.viewMode === 'split'));
  }
}

function setViewMode(mode) {
  if (mode !== 'unified' && mode !== 'split') return;
  if (app.viewMode === mode) return;
  app.viewMode = mode;
  saveViewMode(mode);
  updateViewModeButtons();
  // Re-render immediately so the change is visible without reloading the file.
  // The reviewed/collapsed state lives in localStorage keyed by hunk hash, not
  // by DOM state, so it is unaffected by which renderer builds the markup.
  renderDiff();
}

/** Independent of view mode (works in both unified and split): see the
 *  "Word-level diff highlighting" comment above computeWordDiffPairs(). */
function updateWordDiffCheckbox() {
  const checkbox = document.getElementById('word-diff-checkbox');
  if (checkbox) checkbox.checked = app.wordDiff;
}

function setWordDiff(enabled) {
  enabled = !!enabled;
  if (app.wordDiff === enabled) return;
  app.wordDiff = enabled;
  saveWordDiff(enabled);
  updateWordDiffCheckbox();
  renderDiff();
}

// ─────────────────────────────────────────────────────────────────────────────
// Empty state helpers
// ─────────────────────────────────────────────────────────────────────────────
function showEmptyState(html) {
  document.getElementById('diff-container').innerHTML = '';
  app.fileProgressEls.clear();
  const el = document.getElementById('empty-state');
  el.innerHTML = html;
  el.style.display = 'block';
  clearOverallProgress();
}
