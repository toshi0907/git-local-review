'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Line comments — review comments attached to a single diff line. A comment
// is anchored by (filePath, hunk hash, line index within hunk.lines), so like
// review statuses it follows its hunk across line-number shifts as long as
// the hunk's content is unchanged. Comments whose hunk no longer exists in
// the current diff are kept and listed as orphans in the memo panel.
// ─────────────────────────────────────────────────────────────────────────────
function generateLineCommentId() {
  return `lc_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

/** The current project's { [filePath]: { [hunkHash]: { [lineIdx]: LineComment[] } } } map. */
function getProjectLineComments() {
  if (!app.currentProjectId) return Object.create(null);
  return loadAllLineComments()[currentStateOwnerId()] || Object.create(null);
}

function lineCommentsForHunk(projectLineComments, filePath, hash) {
  const hashMap = projectLineComments[filePath];
  return (hashMap && hashMap[hash]) || null;
}

function getHunkLineComments(filePath, hash) {
  return lineCommentsForHunk(getProjectLineComments(), filePath, hash);
}

function countLineComments(lineMap) {
  if (!lineMap) return 0;
  let n = 0;
  for (const idx of Object.keys(lineMap)) n += lineMap[idx].length;
  return n;
}

/** "L12" for new-side/context lines, "旧L12" for removed lines. */
function formatLineCommentLabel(lineType, oldLabel, newLabel) {
  return lineType === '-' ? `旧L${oldLabel}` : `L${newLabel}`;
}

function findParsedHunk(filePath, hash) {
  if (!app.parsedDiff) return null;
  for (const file of app.parsedDiff) {
    if (file.filePath !== filePath) continue;
    const hunk = file.hunks.find(h => h.hash === hash);
    if (hunk) return hunk;
  }
  return null;
}

/** Adds a comment on `record` (a computeLineRecords() entry). Returns the new comment, or null. */
function addLineComment(filePath, hash, record, text) {
  const trimmed = text.trim();
  if (!app.currentProjectId || !trimmed) return null;
  const all = loadAllLineComments();
  const list = ensureChild(ensureChild(ensureChild(ensureChild(all, currentStateOwnerId()), filePath), hash), record.idx, true);
  const comment = createLineCommentObject(record, trimmed);
  list.push(comment);
  saveAllLineComments(all);
  return comment;
}

/** A new stored LineComment for `record` with already-trimmed `text`; `autoRuleId` marks one added by an auto rule. */
function createLineCommentObject(record, text, autoRuleId = '') {
  const now = Date.now();
  return {
    id: generateLineCommentId(),
    text,
    createdAt: now,
    updatedAt: now,
    done: false,
    lineType: record.type,
    lineText: record.content.slice(0, LINE_COMMENT_SNAPSHOT_MAX),
    oldLabel: record.oldLabel,
    newLabel: record.newLabel,
    autoRuleId,
  };
}

function findStoredLineComment(all, filePath, hash, idx, commentId) {
  const pidMap = all[currentStateOwnerId()];
  const list = pidMap && pidMap[filePath] && pidMap[filePath][hash] && pidMap[filePath][hash][idx];
  return list ? list.find(c => c.id === commentId) || null : null;
}

/** Updates a comment's text. Returns the updated comment, or null if not found / empty. */
function editLineComment(filePath, hash, idx, commentId, text) {
  const trimmed = text.trim();
  if (!app.currentProjectId || !trimmed) return null;
  const all = loadAllLineComments();
  const comment = findStoredLineComment(all, filePath, hash, idx, commentId);
  if (!comment) return null;
  comment.text = trimmed;
  comment.updatedAt = Date.now();
  saveAllLineComments(all);
  return comment;
}

/** Sets a comment's checked (done) state, like a memo's checkbox. Returns the updated comment, or null if not found. */
function setLineCommentDone(filePath, hash, idx, commentId, done) {
  if (!app.currentProjectId) return null;
  const all = loadAllLineComments();
  const comment = findStoredLineComment(all, filePath, hash, idx, commentId);
  if (!comment) return null;
  comment.done = !!done;
  saveAllLineComments(all);
  return comment;
}

/** Deletes a comment, pruning any maps left empty. Returns whether one was removed. */
function deleteLineComment(filePath, hash, idx, commentId) {
  if (!app.currentProjectId) return false;
  const all = loadAllLineComments();
  const pidMap = all[currentStateOwnerId()];
  const hashMap = pidMap && pidMap[filePath];
  const lineMap = hashMap && hashMap[hash];
  const list = lineMap && lineMap[idx];
  if (!list) return false;
  const pos = list.findIndex(c => c.id === commentId);
  if (pos === -1) return false;
  list.splice(pos, 1);
  if (list.length === 0) delete lineMap[idx];
  if (Object.keys(lineMap).length === 0) delete hashMap[hash];
  if (Object.keys(hashMap).length === 0) delete pidMap[filePath];
  if (Object.keys(pidMap).length === 0) delete all[currentStateOwnerId()];
  saveAllLineComments(all);
  return true;
}

function formatLineCommentTime(ts) {
  if (!ts) return ''; // unknown (imported data without timestamps)
  const d = new Date(ts);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function updateHunkCommentBadge(badge, count) {
  badge.textContent = `💬 ${count}`;
  badge.title = `行コメント ${count} 件`;
  badge.hidden = count === 0;
}

/**
 * Reflects app.hideDoneLineComments / app.hideAllLineComments (issue #124)
 * on the diff container's classes (CSS hides the rows, so no re-render is
 * needed and the hunk filters/badges are unaffected) and on the top-bar controls.
 */
function applyLineCommentVisibility() {
  const container = document.getElementById('diff-container');
  container.classList.toggle('hide-done-line-comments', app.hideDoneLineComments);
  container.classList.toggle('hide-all-line-comments', app.hideAllLineComments);
  const checkbox = document.getElementById('hide-done-line-comments-checkbox');
  if (checkbox) checkbox.checked = app.hideDoneLineComments;
  const btn = document.getElementById('hide-all-line-comments-btn');
  if (btn) btn.setAttribute('aria-pressed', String(app.hideAllLineComments));
}

/** The "+" button shown on hover in a line's line-number cell. */
function buildLineCommentAddButton(record) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'line-comment-add-btn';
  btn.dataset.lineIdx = String(record.idx);
  btn.title = 'この行にコメント（キーボード: c）';
  btn.setAttribute('aria-label', 'この行にコメントを追加');
  btn.textContent = '+';
  return btn;
}

/**
 * Appends the saved comment rows for each of `records` (in order) to `tbody`,
 * right after the line row that was just appended. `colSpan` is the table's
 * column count (3 for unified, 4 for split).
 */
function appendLineCommentRows(tbody, records, lineComments, colSpan) {
  if (!lineComments) return;
  for (const record of records) {
    const list = lineComments[record.idx];
    if (!list) continue;
    for (const comment of list) tbody.appendChild(buildLineCommentRow(record.idx, comment, colSpan));
  }
}

/** The checked-state checkbox shown on a line comment (in the diff and in the memo panel list). */
function buildLineCommentDoneCheckbox(done) {
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.className = 'line-comment-done-cb';
  cb.checked = !!done;
  cb.title = 'チェック（対応済み）';
  cb.setAttribute('aria-label', '行コメントをチェック済みにする');
  return cb;
}

/** Reflects a comment's checked state on its rendered diff row (if any). */
function applyLineCommentDoneToRow(row, done) {
  row.classList.toggle('done', done);
  const cb = row.querySelector('.line-comment-done-cb');
  if (cb) cb.checked = done;
}

/**
 * A rendered (read-only) comment row. Its edit/delete buttons are handled by
 * the hunk card's delegated click listener (handleLineCommentCardClick).
 */
function buildLineCommentRow(idx, comment, colSpan) {
  const tr = document.createElement('tr');
  tr.className = 'line-attached-row line-comment-row' + (comment.done ? ' done' : '');
  tr.dataset.lineIdx = String(idx);
  tr.dataset.commentId = comment.id;

  const td = document.createElement('td');
  td.colSpan = colSpan;
  td.className = 'line-comment-cell';

  const box = document.createElement('div');
  box.className = 'line-comment-box';

  const head = document.createElement('div');
  head.className = 'line-comment-head';

  const doneCb = buildLineCommentDoneCheckbox(comment.done);

  const label = document.createElement('span');
  label.className = 'line-comment-label';
  label.textContent = `💬 ${formatLineCommentLabel(comment.lineType, comment.oldLabel, comment.newLabel)}`;
  if (comment.autoRuleId) {
    const autoTag = document.createElement('span');
    autoTag.className = 'line-comment-auto-tag';
    autoTag.textContent = '🤖 自動';
    autoTag.title = '自動行コメントのルールによって追加されたコメントです';
    label.appendChild(autoTag);
  }

  const time = document.createElement('span');
  time.className = 'line-comment-time';
  time.textContent = formatLineCommentTime(comment.updatedAt) + (comment.updatedAt !== comment.createdAt ? '（編集済み）' : '');

  const editBtn = document.createElement('button');
  editBtn.type = 'button';
  editBtn.className = 'line-comment-edit-btn';
  editBtn.title = '編集';
  editBtn.setAttribute('aria-label', 'コメントを編集');
  editBtn.textContent = '✏';

  const delBtn = document.createElement('button');
  delBtn.type = 'button';
  delBtn.className = 'line-comment-delete-btn';
  delBtn.title = '削除';
  delBtn.setAttribute('aria-label', 'コメントを削除');
  delBtn.textContent = '🗑';

  head.appendChild(doneCb);
  head.appendChild(label);
  head.appendChild(time);
  head.appendChild(editBtn);
  head.appendChild(delBtn);

  const body = document.createElement('div');
  body.className = 'line-comment-text';
  body.textContent = comment.text;

  box.appendChild(head);
  box.appendChild(body);
  td.appendChild(box);
  tr.appendChild(td);
  return tr;
}

/**
 * A textarea form used both for new comments (composer) and for editing an
 * existing one. Ctrl/Cmd+Enter submits, Escape cancels (without bubbling to
 * the document-level Escape handler that closes the memo panel).
 */
function buildLineCommentForm(initialText, submitLabel, onSubmit, onCancel) {
  const form = document.createElement('form');
  form.className = 'line-comment-form';

  const textarea = document.createElement('textarea');
  textarea.maxLength = 5000;
  textarea.value = initialText;
  textarea.placeholder = 'コメントを入力（Ctrl+Enterで保存、Escでキャンセル）';
  textarea.setAttribute('aria-label', '行コメント');
  form.appendChild(textarea);

  const actions = document.createElement('div');
  actions.className = 'line-comment-form-actions';

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'memo-edit-cancel';
  cancelBtn.textContent = 'キャンセル';
  cancelBtn.addEventListener('click', onCancel);

  const saveBtn = document.createElement('button');
  saveBtn.type = 'submit';
  saveBtn.className = 'memo-edit-save';
  saveBtn.textContent = submitLabel;

  actions.appendChild(cancelBtn);
  actions.appendChild(saveBtn);
  form.appendChild(actions);

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    onSubmit(textarea.value);
  });
  form.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      form.requestSubmit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    }
  });
  return form;
}

function focusTextareaAtEnd(textarea) {
  textarea.focus();
  textarea.setSelectionRange(textarea.value.length, textarea.value.length);
}

function getCardColSpan(card) {
  const table = card.querySelector('.diff-table');
  return table && table.classList.contains('diff-table-split') ? 4 : 3;
}

function findLineAnchorRow(card, idx) {
  return card.querySelector(`tr[data-anchor-idx~="${idx}"]`);
}

/**
 * Inserts a newly saved comment row for line `idx` after the last existing
 * comment row of a line at or before `idx` that is attached to the same
 * anchor row (so comments stay ordered by line, then by creation), or
 * directly after the anchor row if there is none.
 */
function insertLineCommentRow(anchor, row, idx) {
  let ref = anchor;
  for (let sib = anchor.nextElementSibling; sib && sib.classList.contains('line-attached-row'); sib = sib.nextElementSibling) {
    if (sib.classList.contains('line-comment-row') && Number(sib.dataset.lineIdx) <= idx) ref = sib;
  }
  ref.after(row);
}

/**
 * After any line-comment change in `card`: persist to the settings folder,
 * refresh the hunk's comment badge and the memo panel list, and re-render
 * the whole diff if the "コメントありのみ" filter would now hide this hunk.
 */
function afterLineCommentsChanged(card) {
  scheduleSettingsAutoSave();
  refreshMemoBadge();
  if (card) {
    const count = countLineComments(getHunkLineComments(card.dataset.filePath, card.dataset.hunkHash));
    const badge = card.querySelector('.hunk-comment-badge');
    if (badge) updateHunkCommentBadge(badge, count);
    if (app.commentFilter && count === 0) {
      renderDiff();
      return;
    }
  }
  if (isMemoPanelOpen()) renderLineCommentList();
}

/**
 * Opens (or focuses, if already open) the new-comment form below line `idx`
 * of `card` and returns its textarea. `focus: false` (used when restoring
 * drafts after a re-render) skips scrolling to and focusing it.
 */
function openLineCommentComposer(card, idx, { focus = true } = {}) {
  const anchor = findLineAnchorRow(card, idx);
  if (!anchor) return null;
  if (card.classList.contains('collapsed')) setHunkCollapsedState(card, false);

  const existing = card.querySelector(`.line-comment-composer[data-line-idx="${idx}"] textarea`);
  if (existing) {
    if (focus) {
      existing.scrollIntoView({ block: 'nearest' });
      focusTextareaAtEnd(existing);
    }
    return existing;
  }

  const filePath = card.dataset.filePath;
  const hash = card.dataset.hunkHash;
  const hunk = findParsedHunk(filePath, hash);
  const record = hunk ? computeLineRecords(hunk)[idx] : null;
  if (!record || record.type === '\\') return null;

  const tr = document.createElement('tr');
  tr.className = 'line-attached-row line-comment-composer';
  tr.dataset.lineIdx = String(idx);
  const td = document.createElement('td');
  td.colSpan = getCardColSpan(card);
  td.className = 'line-comment-cell';

  const label = document.createElement('div');
  label.className = 'line-comment-label';
  label.textContent = `💬 ${formatLineCommentLabel(record.type, record.oldLabel, record.newLabel)} にコメント`;

  const form = buildLineCommentForm('', 'コメント', (text) => {
    const comment = addLineComment(filePath, hash, record, text);
    if (!comment) return;
    tr.remove();
    insertLineCommentRow(anchor, buildLineCommentRow(idx, comment, getCardColSpan(card)), idx);
    afterLineCommentsChanged(card);
  }, () => tr.remove());

  const box = document.createElement('div');
  box.className = 'line-comment-box';
  box.appendChild(label);
  box.appendChild(form);
  td.appendChild(box);
  tr.appendChild(td);

  // Composers go after every row attached to the anchor (saved comments
  // and other open composers).
  let last = anchor;
  while (last.nextElementSibling && last.nextElementSibling.classList.contains('line-attached-row')) {
    last = last.nextElementSibling;
  }
  last.after(tr);

  const textarea = form.querySelector('textarea');
  if (focus) {
    tr.scrollIntoView({ block: 'nearest' });
    textarea.focus();
  }
  return textarea;
}

/** Swaps a rendered comment row's content for an inline edit form and returns its textarea. */
function startEditingLineComment(card, row, { focus = true } = {}) {
  const filePath = card.dataset.filePath;
  const hash = card.dataset.hunkHash;
  const idx = Number(row.dataset.lineIdx);
  const commentId = row.dataset.commentId;
  const comment = findStoredLineComment(loadAllLineComments(), filePath, hash, idx, commentId);
  if (!comment) return null;

  const box = row.querySelector('.line-comment-box');
  const label = box.querySelector('.line-comment-label').cloneNode(true);
  const restore = () => {
    const fresh = findStoredLineComment(loadAllLineComments(), filePath, hash, idx, commentId);
    if (fresh) row.replaceWith(buildLineCommentRow(idx, fresh, getCardColSpan(card)));
    else row.remove();
  };
  const form = buildLineCommentForm(comment.text, '保存', (text) => {
    if (editLineComment(filePath, hash, idx, commentId, text)) {
      restore();
      afterLineCommentsChanged(card);
    }
  }, restore);

  box.replaceChildren(label, form);
  const textarea = form.querySelector('textarea');
  if (focus) focusTextareaAtEnd(textarea);
  return textarea;
}

/**
 * Snapshot of every open line-comment form (new-comment composers and
 * in-progress edits) in the diff, so renderDiff() can rebuild the cards
 * without discarding unsaved text.
 */
function captureLineCommentDrafts() {
  const drafts = [];
  const container = document.getElementById('diff-container');
  for (const textarea of container.querySelectorAll('.line-comment-form textarea')) {
    const row = textarea.closest('tr');
    const card = textarea.closest('.hunk-card');
    if (!row || !card) continue;
    drafts.push({
      filePath: card.dataset.filePath,
      hash: card.dataset.hunkHash,
      idx: Number(row.dataset.lineIdx),
      commentId: row.classList.contains('line-comment-row') ? row.dataset.commentId : null,
      text: textarea.value,
      focused: document.activeElement === textarea,
      selection: [textarea.selectionStart, textarea.selectionEnd],
    });
  }
  return drafts;
}

/** Re-opens the forms captured by captureLineCommentDrafts() on the freshly rendered cards. */
function restoreLineCommentDrafts(drafts) {
  if (drafts.length === 0) return;
  const cards = getHunkCards();
  for (const d of drafts) {
    const card = cards.find(c => c.dataset.filePath === d.filePath && c.dataset.hunkHash === d.hash);
    if (!card) continue; // hunk hidden by the current filters
    let textarea = null;
    if (d.commentId) {
      const row = Array.from(card.querySelectorAll('.line-comment-row')).find(r => r.dataset.commentId === d.commentId);
      if (row) textarea = startEditingLineComment(card, row, { focus: false });
    } else {
      textarea = openLineCommentComposer(card, d.idx, { focus: false });
    }
    if (!textarea) continue;
    textarea.value = d.text;
    if (d.focused) {
      textarea.focus();
      textarea.setSelectionRange(d.selection[0], d.selection[1]);
    }
  }
}

/** Delegated click handler on each hunk card for the line-comment controls. */
function handleLineCommentCardClick(e) {
  const card = e.currentTarget;

  // Remember the last clicked line so the `c` shortcut knows where to comment.
  const lineEl = e.target.closest('[data-line-idx]');
  if (lineEl && card.contains(lineEl)) card.dataset.activeLineIdx = lineEl.dataset.lineIdx;

  // A mouse click on a comment's checkbox shouldn't leave focus on it, or the
  // keydown listener would treat it as typing and ignore j/k/c etc. afterwards.
  if (e.target.classList.contains('line-comment-done-cb') && e.detail > 0) e.target.blur();

  const addBtn = e.target.closest('.line-comment-add-btn');
  if (addBtn) {
    openLineCommentComposer(card, Number(addBtn.dataset.lineIdx));
    return;
  }

  const row = e.target.closest('.line-comment-row');
  if (!row) return;
  if (e.target.closest('.line-comment-edit-btn')) {
    startEditingLineComment(card, row);
  } else if (e.target.closest('.line-comment-delete-btn')) {
    if (!confirm('この行コメントを削除しますか？')) return;
    if (deleteLineComment(card.dataset.filePath, card.dataset.hunkHash, Number(row.dataset.lineIdx), row.dataset.commentId)) {
      row.remove();
      afterLineCommentsChanged(card);
    }
  }
}

/** Delegated change handler on each hunk card for the line comments' checkboxes. */
function handleLineCommentCardChange(e) {
  const cb = e.target.closest('.line-comment-done-cb');
  if (!cb) return;
  const card = e.currentTarget;
  const row = cb.closest('.line-comment-row');
  if (!row) return;
  const comment = setLineCommentDone(card.dataset.filePath, card.dataset.hunkHash, Number(row.dataset.lineIdx), row.dataset.commentId, cb.checked);
  if (!comment) {
    cb.checked = !cb.checked; // not found in storage: revert
    return;
  }
  applyLineCommentDoneToRow(row, comment.done);
  afterLineCommentsChanged(card);
}

/**
 * `c` shortcut: opens a comment form on the focused hunk's last clicked line,
 * falling back to its first added/removed line (or first line of any kind).
 */
function openLineCommentComposerForFocusedHunk() {
  const cards = getHunkCards();
  if (app.focusedHunkIndex < 0 || app.focusedHunkIndex >= cards.length) return;
  const card = cards[app.focusedHunkIndex];

  let idx = card.dataset.activeLineIdx !== undefined ? Number(card.dataset.activeLineIdx) : NaN;
  if (Number.isNaN(idx) || !findLineAnchorRow(card, idx)) {
    const hunk = findParsedHunk(card.dataset.filePath, card.dataset.hunkHash);
    if (!hunk) return;
    const records = computeLineRecords(hunk).filter(r => r.type !== '\\');
    const target = records.find(r => r.type === '+' || r.type === '-') || records[0];
    if (!target) return;
    idx = target.idx;
  }
  openLineCommentComposer(card, idx);
}

/** Scrolls to a comment in the diff (expanding/focusing its hunk) from the memo panel list. */
function jumpToLineComment(filePath, hash, commentId) {
  const card = getHunkCards().find(c => c.dataset.filePath === filePath && c.dataset.hunkHash === hash);
  if (!card) {
    alert('このコメントのハンクは現在の表示フィルターで非表示になっています。');
    return;
  }
  if (!WIDE_LAYOUT_MEDIA_QUERY.matches && isMemoPanelOpen()) closeMemoPanel();
  if (card.classList.contains('collapsed')) setHunkCollapsedState(card, false);
  setFocusedHunk(getHunkCards().indexOf(card), { scroll: false });

  // Release focus from the clicked list button so the memo-panel focus guard
  // in the keydown listener doesn't swallow j/k/c etc. right after a jump.
  if (document.activeElement && document.getElementById('memo-panel').contains(document.activeElement)) {
    document.activeElement.blur();
  }

  const row = Array.from(card.querySelectorAll('.line-comment-row')).find(r => r.dataset.commentId === commentId);
  // A row hidden by the line-comment visibility toggles (issue #124) has no
  // layout box, so scroll to the commented line itself instead.
  if (row && row.getClientRects().length === 0) {
    (findLineAnchorRow(card, Number(row.dataset.lineIdx)) || card).scrollIntoView({ block: 'center' });
    return;
  }
  const target = row || card;
  target.scrollIntoView({ block: 'center' });
  if (row) {
    row.classList.remove('flash');
    void row.offsetWidth; // restart the animation if it's already running
    row.classList.add('flash');
  }
}

/**
 * One memo-panel list item. `loc` is { filePath, hash, idx } and `live`
 * says whether the comment's hunk exists in the current diff (orphans
 * aren't clickable, since there's nowhere to jump to).
 */
function buildLineCommentListItem(loc, comment, live) {
  const li = document.createElement('li');
  li.className = 'line-comment-item' + (live ? '' : ' orphan') + (comment.done ? ' done' : '');

  const doneCb = buildLineCommentDoneCheckbox(comment.done);
  doneCb.addEventListener('change', () => {
    const updated = setLineCommentDone(loc.filePath, loc.hash, loc.idx, comment.id, doneCb.checked);
    if (!updated) {
      doneCb.checked = !doneCb.checked;
      return;
    }
    const card = getHunkCards().find(c => c.dataset.filePath === loc.filePath && c.dataset.hunkHash === loc.hash);
    if (card) {
      const row = Array.from(card.querySelectorAll('.line-comment-row')).find(r => r.dataset.commentId === comment.id);
      if (row) applyLineCommentDoneToRow(row, updated.done);
    }
    afterLineCommentsChanged(card || null);
  });

  const main = document.createElement(live ? 'button' : 'div');
  main.className = 'line-comment-item-main';
  if (live) {
    main.type = 'button';
    main.title = 'このコメントへ移動';
    main.addEventListener('click', () => jumpToLineComment(loc.filePath, loc.hash, comment.id));
  }

  const location = document.createElement('div');
  location.className = 'line-comment-item-loc';
  location.textContent = `${loc.filePath}:${formatLineCommentLabel(comment.lineType, comment.oldLabel, comment.newLabel)}`;
  location.title = location.textContent;

  const snippet = document.createElement('div');
  snippet.className = 'line-comment-item-snippet';
  snippet.textContent = `${comment.lineType}${comment.lineText}`;

  const text = document.createElement('div');
  text.className = 'line-comment-item-text';
  text.textContent = comment.text;

  main.appendChild(location);
  main.appendChild(snippet);
  main.appendChild(text);

  const delBtn = document.createElement('button');
  delBtn.type = 'button';
  delBtn.className = 'memo-item-delete';
  delBtn.title = '削除';
  delBtn.setAttribute('aria-label', '行コメントを削除');
  delBtn.textContent = '🗑';
  delBtn.addEventListener('click', () => {
    if (!confirm('この行コメントを削除しますか？')) return;
    if (!deleteLineComment(loc.filePath, loc.hash, loc.idx, comment.id)) return;
    const card = getHunkCards().find(c => c.dataset.filePath === loc.filePath && c.dataset.hunkHash === loc.hash);
    if (card) {
      const row = Array.from(card.querySelectorAll('.line-comment-row')).find(r => r.dataset.commentId === comment.id);
      if (row) row.remove();
    }
    afterLineCommentsChanged(card || null);
  });

  li.appendChild(doneCb);
  li.appendChild(main);
  li.appendChild(delBtn);
  return li;
}

/**
 * Re-render the memo panel's 行コメント list: comments in diff order, then
 * orphans (whose hunk/line isn't in the current diff, e.g. after reloading
 * a changed diff file) under their own heading.
 */
function renderLineCommentList() {
  const section = document.getElementById('line-comment-section');
  const listEl  = document.getElementById('line-comment-list');
  const emptyEl = document.getElementById('line-comment-empty');
  const countEl = document.getElementById('line-comment-count');
  listEl.innerHTML = '';

  if (!app.currentProjectId) {
    section.hidden = true;
    return;
  }
  section.hidden = false;

  const projectComments = getProjectLineComments();
  const live = [];
  const seen = new Map(); // "filePath\0hash" -> hunk, for hunks present in the current diff
  for (const file of app.parsedDiff || []) {
    for (const hunk of file.hunks) {
      const key = file.filePath + '\0' + hunk.hash;
      if (seen.has(key)) continue;
      seen.set(key, hunk);
      const lineMap = lineCommentsForHunk(projectComments, file.filePath, hunk.hash);
      if (!lineMap) continue;
      const idxs = Object.keys(lineMap).map(Number).filter(i => i < hunk.lines.length).sort((a, b) => a - b);
      for (const idx of idxs) {
        for (const c of lineMap[idx]) live.push({ loc: { filePath: file.filePath, hash: hunk.hash, idx }, comment: c });
      }
    }
  }

  const orphans = [];
  for (const filePath of Object.keys(projectComments)) {
    for (const hash of Object.keys(projectComments[filePath])) {
      const hunk = seen.get(filePath + '\0' + hash) || null;
      const lineMap = projectComments[filePath][hash];
      for (const idxKey of Object.keys(lineMap)) {
        const idx = Number(idxKey);
        if (hunk && idx < hunk.lines.length) continue;
        for (const c of lineMap[idxKey]) orphans.push({ loc: { filePath, hash, idx }, comment: c });
      }
    }
  }

  const total = live.length + orphans.length;
  const doneCount = live.concat(orphans).filter(e => e.comment.done).length;
  countEl.textContent = total > 0 ? `（${doneCount}/${total}）` : '';
  countEl.title = total > 0 ? `チェック済み ${doneCount} 件 / 全 ${total} 件` : '';
  if (total === 0) {
    emptyEl.textContent = '行コメントはまだありません。行番号にマウスを乗せて「+」で追加できます。';
    emptyEl.style.display = 'block';
    return;
  }
  emptyEl.style.display = 'none';

  for (const { loc, comment } of live) listEl.appendChild(buildLineCommentListItem(loc, comment, true));
  if (orphans.length > 0) {
    const divider = document.createElement('li');
    divider.className = 'memo-list-divider';
    if (getCurrentCollectionId()) {
      // Shared comments include those on hunks that only exist in another
      // member's diff (e.g. per-commit hunks merged into one by git diff).
      divider.textContent = `このプロジェクトの diff にないコメント（${orphans.length}）`;
      divider.title = 'コレクション内の他のプロジェクトの diff にあるハンクへのコメントや、diff の再読み込み等でハンクの内容が変わり、元の行が見つからなくなったコメントです';
    } else {
      divider.textContent = `現在の diff に見つからないコメント（${orphans.length}）`;
      divider.title = 'diff の再読み込み等でハンクの内容が変わり、元の行が見つからなくなったコメントです';
    }
    listEl.appendChild(divider);
    for (const { loc, comment } of orphans) listEl.appendChild(buildLineCommentListItem(loc, comment, false));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Review memos — free-form per-project checklist notes shown in a slide-in
// panel, unrelated to any specific file/hunk (see loadAllReviews for that).
// ─────────────────────────────────────────────────────────────────────────────
function generateMemoId() {
  return `memo_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function getCurrentProjectMemos() {
  if (!app.currentProjectId) return [];
  return loadAllMemos()[currentStateOwnerId()] || [];
}

/** Number of the current project's line comments that aren't checked yet. */
function countOpenLineComments() {
  const projectComments = getProjectLineComments();
  let n = 0;
  for (const filePath of Object.keys(projectComments)) {
    for (const hash of Object.keys(projectComments[filePath])) {
      const lineMap = projectComments[filePath][hash];
      for (const idx of Object.keys(lineMap)) n += lineMap[idx].filter(c => !c.done).length;
    }
  }
  return n;
}

/** Refresh the always-visible topbar badge (count of not-yet-done memos + unchecked line comments). */
function refreshMemoBadge() {
  const badge = document.getElementById('memo-badge');
  if (!badge) return;
  const openMemos = getCurrentProjectMemos().filter(m => !m.done).length;
  const openComments = countOpenLineComments();
  const openCount = openMemos + openComments;
  badge.textContent = String(openCount);
  badge.hidden = openCount === 0;
  // The badge sits inside the icon-only toggle button, so its breakdown goes
  // into the button's custom tooltip rather than a native title.
  const toggleBtn = document.getElementById('memo-toggle-btn');
  if (toggleBtn) {
    toggleBtn.dataset.tooltip = openCount === 0
      ? 'レビューメモ'
      : `レビューメモ（未完了: メモ ${openMemos} 件 / 行コメント ${openComments} 件）`;
  }
  refreshTopbarTooltip();
}

/** id of the memo currently being edited inline, or null. Reset whenever
 *  the list is rebuilt for a different reason (project switch, panel
 *  close) so a stale edit form never reappears for the wrong memo. */
let editingMemoId = null;

function buildMemoEditForm(memo) {
  const li = document.createElement('li');
  li.className = 'memo-item editing';

  const form = document.createElement('form');
  form.className = 'memo-edit-form';

  const textarea = document.createElement('textarea');
  textarea.maxLength = 5000;
  textarea.value = memo.text;
  textarea.setAttribute('aria-label', 'メモ本文を編集');
  form.appendChild(textarea);

  const actions = document.createElement('div');
  actions.className = 'memo-edit-actions';

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'memo-edit-cancel';
  cancelBtn.textContent = 'キャンセル';
  cancelBtn.addEventListener('click', () => {
    editingMemoId = null;
    renderMemoList();
  });

  const saveBtn = document.createElement('button');
  saveBtn.type = 'submit';
  saveBtn.className = 'memo-edit-save';
  saveBtn.textContent = '保存';

  actions.appendChild(cancelBtn);
  actions.appendChild(saveBtn);
  form.appendChild(actions);

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    editMemo(memo.id, textarea.value);
  });
  form.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      form.requestSubmit();
    } else if (e.key === 'Escape') {
      // Cancel just this edit rather than letting the keystroke bubble up
      // to the document-level handler that closes the whole memo panel.
      // Listening on the form (not just the textarea) so Escape also works
      // when focus is on the save/cancel button.
      e.preventDefault();
      e.stopPropagation();
      editingMemoId = null;
      renderMemoList();
    }
  });

  li.appendChild(form);
  return li;
}

function buildMemoItem(memo) {
  if (memo.id === editingMemoId) return buildMemoEditForm(memo);

  const li = document.createElement('li');
  li.className = 'memo-item' + (memo.done ? ' done' : '');

  const label = document.createElement('label');
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = memo.done;
  cb.addEventListener('change', () => toggleMemoDone(memo.id, cb.checked));

  const text = document.createElement('span');
  text.className = 'memo-text';
  text.textContent = memo.text;

  label.appendChild(cb);
  label.appendChild(text);

  const editBtn = document.createElement('button');
  editBtn.type = 'button';
  editBtn.className = 'memo-item-edit';
  editBtn.title = '編集';
  editBtn.setAttribute('aria-label', 'メモを編集');
  editBtn.textContent = '✏';
  editBtn.addEventListener('click', () => {
    editingMemoId = memo.id;
    renderMemoList();
  });

  const delBtn = document.createElement('button');
  delBtn.type = 'button';
  delBtn.className = 'memo-item-delete';
  delBtn.title = '削除';
  delBtn.setAttribute('aria-label', 'メモを削除');
  delBtn.textContent = '🗑';
  delBtn.addEventListener('click', () => deleteMemo(memo.id));

  li.appendChild(label);
  li.appendChild(editBtn);
  li.appendChild(delBtn);
  return li;
}

/** Re-render the memo list inside the panel for the current project. */
function renderMemoList() {
  const listEl  = document.getElementById('memo-list');
  const emptyEl = document.getElementById('memo-empty');
  const input   = document.getElementById('memo-input');
  const addBtn  = document.querySelector('.memo-add-btn');
  const bulkToggleBtn = document.getElementById('memo-bulk-toggle-btn');
  listEl.innerHTML = '';
  renderLineCommentList();

  if (!app.currentProjectId) {
    input.disabled = true;
    addBtn.disabled = true;
    bulkToggleBtn.disabled = true;
    emptyEl.textContent = 'プロジェクトを開くとメモを追加できます。';
    emptyEl.style.display = 'block';
    return;
  }
  input.disabled = false;
  addBtn.disabled = false;
  bulkToggleBtn.disabled = false;

  const memos = getCurrentProjectMemos();
  if (memos.length === 0) {
    emptyEl.textContent = 'メモはまだありません。';
    emptyEl.style.display = 'block';
    return;
  }
  emptyEl.style.display = 'none';

  const pending = memos.filter(m => !m.done);
  const done    = memos.filter(m => m.done);

  for (const m of pending) listEl.appendChild(buildMemoItem(m));
  if (done.length > 0) {
    const divider = document.createElement('li');
    divider.className = 'memo-list-divider';
    divider.textContent = `対応済み（${done.length}）`;
    listEl.appendChild(divider);
    for (const m of done) listEl.appendChild(buildMemoItem(m));
  }

  if (editingMemoId) {
    const editTextarea = listEl.querySelector('.memo-edit-form textarea');
    if (editTextarea) {
      editTextarea.focus();
      editTextarea.setSelectionRange(editTextarea.value.length, editTextarea.value.length);
    }
  }
}

/**
 * Adds multiple memos in a single localStorage write + re-render (issue
 * #104's bulk registration), instead of calling addMemo() once per segment.
 * Blank/whitespace-only segments are dropped. Returns how many were added.
 */
function addMemos(texts) {
  if (!app.currentProjectId) return 0;
  const trimmedTexts = texts.map(t => t.trim()).filter(Boolean);
  if (trimmedTexts.length === 0) return 0;

  const ownerId = currentStateOwnerId();
  const all = loadAllMemos();
  if (!all[ownerId]) all[ownerId] = [];
  const now = Date.now();
  for (const text of trimmedTexts) {
    all[ownerId].push({ id: generateMemoId(), text, done: false, createdAt: now, updatedAt: now });
  }
  saveAllMemos(all);
  scheduleSettingsAutoSave();

  renderMemoList();
  refreshMemoBadge();
  return trimmedTexts.length;
}

function addMemo(text) {
  addMemos([text]);
}

/**
 * Splits bulk-registration memo text (issue #104) into individual memo
 * strings at lines that exactly match `delimiter`. The matching delimiter
 * line is kept as the trailing line of the segment that precedes it, per
 * the issue's spec ("デリミタに一致した行もメモに含める"), so only the
 * text after the last delimiter line (if any) ends up without one.
 */
function splitBulkMemoText(text, delimiter) {
  const lines = text.split(/\r\n|\r|\n/);
  const segments = [];
  let current = [];
  for (const line of lines) {
    current.push(line);
    if (delimiter && line === delimiter) {
      segments.push(current.join('\n'));
      current = [];
    }
  }
  if (current.some(line => line.trim() !== '')) segments.push(current.join('\n'));
  return segments.map(s => s.trim()).filter(Boolean);
}

function toggleMemoDone(memoId, done) {
  if (!app.currentProjectId) return;
  const all  = loadAllMemos();
  const list = all[currentStateOwnerId()] || [];
  const memo = list.find(m => m.id === memoId);
  if (!memo) return;
  memo.done = done;
  memo.updatedAt = Date.now();
  saveAllMemos(all);
  scheduleSettingsAutoSave();

  renderMemoList();
  refreshMemoBadge();
}

function editMemo(memoId, text) {
  if (!app.currentProjectId) return;
  const trimmed = text.trim();
  if (!trimmed) return;
  const all  = loadAllMemos();
  const list = all[currentStateOwnerId()] || [];
  const memo = list.find(m => m.id === memoId);
  if (!memo) return;
  memo.text = trimmed;
  memo.updatedAt = Date.now();
  saveAllMemos(all);
  scheduleSettingsAutoSave();

  editingMemoId = null;
  renderMemoList();
  refreshMemoBadge();
}

function deleteMemo(memoId) {
  if (!app.currentProjectId) return;
  const all  = loadAllMemos();
  const list = all[currentStateOwnerId()] || [];
  const idx  = list.findIndex(m => m.id === memoId);
  if (idx === -1) return;
  list.splice(idx, 1);
  saveAllMemos(all);
  scheduleSettingsAutoSave();

  renderMemoList();
  refreshMemoBadge();
}

/** Remove all memos belonging to a permanently deleted project. */
function deleteMemosForProject(projectId) {
  const all = loadAllMemos();
  if (!(projectId in all)) return;
  delete all[projectId];
  saveAllMemos(all);
}

/**
 * Matches the CSS breakpoint (issue #57) at which the memo panel docks
 * permanently as a third flex column instead of behaving as a slide-in
 * overlay. Kept in sync with the `@media (min-width: 1200px)` rule above.
 */
const WIDE_LAYOUT_MEDIA_QUERY = window.matchMedia('(min-width: 1200px)');

function isMemoPanelOpen() {
  return WIDE_LAYOUT_MEDIA_QUERY.matches || document.getElementById('memo-panel').classList.contains('open');
}

/**
 * Called whenever the active project changes (and on init, and when crossing
 * the WIDE_LAYOUT_MEDIA_QUERY breakpoint) to keep the badge/panel in sync.
 * Also keeps aria-hidden correct: while docked open on a wide viewport,
 * openMemoPanel() is never called (its trigger, #memo-toggle-btn, is
 * CSS-hidden there), so nothing else clears the markup's default
 * aria-hidden="true" — without this, assistive tech would treat the
 * always-visible panel as hidden.
 */
function refreshMemoUI() {
  editingMemoId = null;
  const open = isMemoPanelOpen();
  document.getElementById('memo-panel').setAttribute('aria-hidden', open ? 'false' : 'true');
  refreshMemoBadge();
  if (open) renderMemoList();
}

function openMemoPanel() {
  document.getElementById('memo-panel').classList.add('open');
  document.getElementById('memo-panel').setAttribute('aria-hidden', 'false');
  document.getElementById('memo-panel-overlay').classList.add('active');
  document.getElementById('memo-toggle-btn').setAttribute('aria-expanded', 'true');
  renderMemoList();
  const input = document.getElementById('memo-input');
  if (!input.disabled) input.focus();
}

function closeMemoPanel() {
  editingMemoId = null;
  setMemoBulkMode(false);
  document.getElementById('memo-panel').classList.remove('open');
  document.getElementById('memo-panel').setAttribute('aria-hidden', 'true');
  document.getElementById('memo-panel-overlay').classList.remove('active');
  const toggleBtn = document.getElementById('memo-toggle-btn');
  toggleBtn.setAttribute('aria-expanded', 'false');
  // Return focus to the toggle button so it doesn't stay stranded on a
  // now off-screen element inside the panel (e.g. after Escape or an
  // overlay click, rather than a direct click on the close button).
  if (document.getElementById('memo-panel').contains(document.activeElement)) {
    toggleBtn.focus();
  }
}

/**
 * Drag-to-resize for the sidebar (issue #94), mirroring
 * initMemoPanelResizer() below but growing the sidebar when the handle is
 * dragged right (its resize edge, on the sidebar's right side) instead of
 * left (the memo panel's resize edge is on its left side, since the memo
 * panel itself docks on the opposite side of the screen).
 */
function initSidebarResizer() {
  const sidebar = document.getElementById('sidebar');
  const handle = document.getElementById('sidebar-resizer');
  if (!sidebar || !handle) return;

  let minWidth = 0;
  let startX = 0;
  let startWidth = 0;
  let maxWidth = 0;
  let isResizing = false;

  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    startX = e.clientX;
    startWidth = sidebar.getBoundingClientRect().width;
    minWidth = Number.parseFloat(getComputedStyle(sidebar).minWidth);
    if (!Number.isFinite(minWidth)) minWidth = 0;
    maxWidth = Number.parseFloat(getComputedStyle(sidebar).maxWidth);
    if (!Number.isFinite(maxWidth)) maxWidth = window.innerWidth;
    isResizing = true;
    handle.setPointerCapture(e.pointerId);
  });

  handle.addEventListener('pointermove', (e) => {
    if (!isResizing || !handle.hasPointerCapture(e.pointerId)) return;
    const delta = e.clientX - startX;
    const nextWidth = Math.min(maxWidth, Math.max(minWidth, startWidth + delta));
    sidebar.style.width = `${nextWidth}px`;
  });

  const stopResize = () => {
    isResizing = false;
  };
  handle.addEventListener('pointerup', stopResize);
  handle.addEventListener('pointercancel', stopResize);
  handle.addEventListener('lostpointercapture', stopResize);
}

function initMemoPanelResizer() {
  const panel = document.getElementById('memo-panel');
  const handle = document.getElementById('memo-panel-resizer');
  if (!panel || !handle) return;

  let minWidth = 0;
  let startX = 0;
  let startWidth = 0;
  let maxWidth = 0;
  let isResizing = false;

  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    startX = e.clientX;
    startWidth = panel.getBoundingClientRect().width;
    minWidth = Number.parseFloat(getComputedStyle(panel).minWidth);
    if (!Number.isFinite(minWidth)) minWidth = 0;
    maxWidth = Number.parseFloat(getComputedStyle(panel).maxWidth);
    if (!Number.isFinite(maxWidth)) maxWidth = window.innerWidth;
    isResizing = true;
    handle.setPointerCapture(e.pointerId);
  });

  handle.addEventListener('pointermove', (e) => {
    if (!isResizing || !handle.hasPointerCapture(e.pointerId)) return;
    const delta = startX - e.clientX;
    const nextWidth = Math.min(maxWidth, Math.max(minWidth, startWidth + delta));
    panel.style.width = `${nextWidth}px`;
  });

  const stopResize = () => {
    isResizing = false;
  };
  handle.addEventListener('pointerup', stopResize);
  handle.addEventListener('pointercancel', stopResize);
  handle.addEventListener('lostpointercapture', stopResize);
}
