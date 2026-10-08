'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Sidebar review-progress badge
//
// Shows, to the left of each project's name, either the count of hunks that
// still have no review status, or a ✓ once every hunk has one. The active
// project's count is derived directly from app.parsedDiff (already parsed
// and hashed in memory), which is cheap and always exact. Any other project
// has to be parsed and hashed from its saved diff text, which is async
// (Web Crypto) — so each project's parsed hunk keys (file path + hash, not
// the counts themselves) are cached, and only recomputed when that project's
// saved diff text changes (saveFileContent()/deleteFileContent() drop the
// entry). The counts are always derived from the current reviews, so a
// review change elsewhere (reset, import, or another member of the same
// collection sharing the hunk) never leaves a badge stale.
// Each collection's group header in the sidebar likewise shows the remaining
// count across its members' *distinct* hunks (a hunk shared by two members
// counts once), once every member's hunk keys are known.
// ─────────────────────────────────────────────────────────────────────────────
const projectProgressCache = new Map(); // projectId -> { files: [{ filePath, hunks: [{ hash }] }] }
/** Sidebar collection-header badge elements keyed by collectionId, populated during renderProjectList. */
const collectionBadgeEls = new Map();

function invalidateProjectProgressCache(projectId) {
  projectProgressCache.delete(projectId);
}

/** Count reviewed vs. total hunks across an already-parsed(+hashed) diff. */
function countHunkProgress(parsedFiles, projectReviews) {
  let total = 0, reviewed = 0;
  for (const file of parsedFiles) {
    const fileReviews = projectReviews[file.filePath] || Object.create(null);
    for (const h of file.hunks) {
      total++;
      if (fileReviews[h.hash]) reviewed++;
    }
  }
  return { total, reviewed };
}

/**
 * Paint one project's badge element from a {total, reviewed} progress count,
 * or hide it when `progress` is null (nothing known yet — no saved diff
 * text, or its parse+hash is still in flight). A project whose diff text
 * parses to zero hunks still gets a (trivially complete) ✓, since there is
 * nothing left to review.
 */
function renderProjectProgressBadge(el, progress) {
  if (!el) return;
  if (!progress) {
    el.hidden = true;
    return;
  }
  const remaining = progress.total - progress.reviewed;
  el.hidden = false;
  if (remaining > 0) {
    el.textContent = String(remaining);
    el.title = `残り ${remaining} / ${progress.total} hunk 未レビュー`;
    el.className = 'proj-progress-badge badge-remaining';
  } else {
    el.textContent = '✓';
    el.title = `${progress.total} hunk すべてレビュー済み`;
    el.className = 'proj-progress-badge badge-complete';
  }
}

/**
 * A project's parsed hunk keys if known synchronously (the active project's
 * in-memory diff, or a cache entry matching its saved diff text), else null.
 * `undefined` instead means there's no saved diff text at all.
 */
function getKnownProjectHunkFiles(projectId) {
  if (projectId === app.currentProjectId && app.parsedDiff) return app.parsedDiff;
  // saveFileContent()/deleteFileContent() drop the entry whenever the saved
  // text changes, so a cached entry can be trusted without re-reading (and
  // re-hashing) the whole saved diff text on every review click.
  const cached = projectProgressCache.get(projectId);
  if (cached) return cached.files;
  return loadFileContent(projectId) == null ? undefined : null;
}

/**
 * Resolve (synchronously when possible) and paint one project's sidebar
 * review-progress badge. `el` must still be the badge element currently
 * rendered for `projectId` (i.e. from app.projectBadgeEls) — for the async
 * (non-active-project) path, the result is only ever applied through a
 * fresh app.projectBadgeEls lookup, so a render that happened in the
 * meantime can't be clobbered with a stale element.
 */
function updateProjectProgressBadge(projectId, el) {
  if (!el) return;

  const known = getKnownProjectHunkFiles(projectId);
  if (known === undefined) {
    renderProjectProgressBadge(el, null);
    return;
  }
  if (known) {
    renderProjectProgressBadge(el, countHunkProgress(known, loadAllReviews()[getStateOwnerId(projectId)] || Object.create(null)));
    return;
  }

  const rawText = loadFileContent(projectId);

  // Hide rather than show a stale count while the (async) parse+hash for
  // the new content is in flight.
  el.hidden = true;

  (async () => {
    let parsed;
    try {
      parsed = parseDiff(rawText);
      await computeAllHashes(parsed);
    } catch (e) {
      console.error('Failed to compute review progress for project', projectId, e);
      return;
    }
    // The saved text may have been replaced while hashing was in flight;
    // don't cache keys computed from the old text.
    if (loadFileContent(projectId) !== rawText) return;
    projectProgressCache.set(projectId, {
      files: parsed.map(f => ({ filePath: f.filePath, hunks: f.hunks.map(h => ({ hash: h.hash })) })),
    });
    // Reviews (or the project's collection) may have changed while hashing
    // was in flight, so re-read rather than reuse anything captured earlier;
    // and only paint whichever badge element is currently live for this
    // project — renderProjectList() may have rebuilt the list since this
    // computation started.
    updateProjectProgressBadge(projectId, app.projectBadgeEls.get(projectId));
    const collectionId = getProjectCollectionId(projectId);
    if (collectionId) updateCollectionProgressBadge(collectionId);
  })();
}

/**
 * Paint a collection header's badge: remaining unreviewed hunks across its
 * members' distinct hunks (file path + hash). Hidden until every member's
 * hunk keys are known (their own badges' async computation fills the cache
 * and calls back here). Members with no saved diff text are skipped.
 */
function updateCollectionProgressBadge(collectionId) {
  const el = collectionBadgeEls.get(collectionId);
  if (!el) return;
  const reviews = loadAllReviews()[collectionId] || Object.create(null);
  const seen = new Set();
  let total = 0, reviewed = 0;
  for (const pid of getCollectionMemberIds(collectionId)) {
    const files = getKnownProjectHunkFiles(pid);
    if (files === undefined) continue;
    if (files === null) {
      renderProjectProgressBadge(el, null);
      return;
    }
    for (const file of files) {
      const fileReviews = reviews[file.filePath] || Object.create(null);
      for (const h of file.hunks) {
        const key = file.filePath + '\0' + h.hash;
        if (seen.has(key)) continue;
        seen.add(key);
        total++;
        if (fileReviews[h.hash]) reviewed++;
      }
    }
  }
  renderProjectProgressBadge(el, { total, reviewed });
}

/** Repaint every sidebar badge affected by a review change in the active project (all members of its collection, if any). */
function refreshActiveProjectProgressBadges() {
  const collectionId = getCurrentCollectionId();
  const ids = collectionId ? getCollectionMemberIds(collectionId) : [app.currentProjectId];
  for (const pid of ids) updateProjectProgressBadge(pid, app.projectBadgeEls.get(pid));
  if (collectionId) updateCollectionProgressBadge(collectionId);
}

// ─────────────────────────────────────────────────────────────────────────────
// Render: sidebar project list
// ─────────────────────────────────────────────────────────────────────────────
function renderProjectList() {
  const listEl = document.getElementById('project-list');
  const projects = loadProjects();
  const collections = loadCollections();

  app.projectBadgeEls.clear();
  collectionBadgeEls.clear();
  // Drop selections of projects that no longer exist.
  for (const id of [...selectedProjectIds]) {
    if (!projects.some(p => p.id === id)) selectedProjectIds.delete(id);
  }
  renderProjectSelectBar(collections);

  if (projects.length === 0) {
    listEl.innerHTML = '<div class="project-empty">プロジェクトなし</div>';
    return;
  }

  listEl.innerHTML = '';
  const sorted = sortProjects(projects, loadProjectSort());

  // A collection is shown as one group at the position of its first member
  // in the sorted list, with all its members (in sorted order) inside it
  // (the same order getSidebarProjectOrder() returns).
  const renderedCollectionIds = new Set();
  for (const proj of sorted) {
    const collection = proj.collectionId && collections.find(c => c.id === proj.collectionId);
    if (!collection) {
      listEl.appendChild(buildProjectItem(proj));
      updateProjectProgressBadge(proj.id, app.projectBadgeEls.get(proj.id));
      continue;
    }
    if (renderedCollectionIds.has(collection.id)) continue;
    renderedCollectionIds.add(collection.id);
    const members = sorted.filter(p => p.collectionId === collection.id);
    listEl.appendChild(buildCollectionGroup(collection, members));
    for (const member of members) updateProjectProgressBadge(member.id, app.projectBadgeEls.get(member.id));
    updateCollectionProgressBadge(collection.id);
  }
}

/** One project's sidebar entry (also used inside a collection group). */
function buildProjectItem(proj) {
  const isActive = proj.id === app.currentProjectId;
  const isExpanded = expandedProjectIds.has(proj.id);
  const hasExternalUpdate = projectsWithExternalFileUpdate.has(proj.id);
  const isSelected = selectedProjectIds.has(proj.id);
  const item = document.createElement('div');
  item.className = 'project-item' + (isActive ? ' active' : '') + (isExpanded ? ' expanded' : '') + (isSelected ? ' selected' : '');

  const updated = new Date(proj.lastUpdated || proj.createdAt).toLocaleString('ja-JP', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });

  const topRowEl = document.createElement('div'); topRowEl.className = 'proj-top-row';
  const progressBadgeEl = document.createElement('span');
  progressBadgeEl.className = 'proj-progress-badge';
  progressBadgeEl.hidden = true;
  app.projectBadgeEls.set(proj.id, progressBadgeEl);
  const nameEl   = document.createElement('div'); nameEl.className = 'proj-name'; nameEl.title = proj.id; nameEl.textContent = proj.fileName;
  if (hasExternalUpdate) {
    const updateBadge = document.createElement('span');
    updateBadge.className = 'proj-update-badge';
    updateBadge.textContent = '🆕';
    updateBadge.title = 'ファイルがディスク上で更新されています。再読み込みしてください。';
    nameEl.prepend(updateBadge);
  }
  const idEl     = document.createElement('div'); idEl.className = 'proj-id'; idEl.textContent = proj.id;
  const metaEl   = document.createElement('div'); metaEl.className = 'proj-meta'; metaEl.textContent = `更新: ${updated}`;
  const detailsEl = document.createElement('div'); detailsEl.className = 'proj-details';
  const actEl    = document.createElement('div'); actEl.className = 'proj-actions';

  const toggleBtn = document.createElement('button');
  toggleBtn.type = 'button';
  toggleBtn.className = 'proj-expand-toggle';
  toggleBtn.textContent = isExpanded ? '▾' : '▸';
  toggleBtn.title = isExpanded ? '詳細を閉じる' : '詳細を表示（ID・文字コード・リセット・削除）';
  toggleBtn.setAttribute('aria-expanded', String(isExpanded));
  toggleBtn.addEventListener('click', e => {
    e.stopPropagation();
    if (isExpanded) expandedProjectIds.delete(proj.id);
    else expandedProjectIds.add(proj.id);
    renderProjectList();
  });

  const encEl = document.createElement('div');
  encEl.className = 'proj-encoding';
  const encLabel = document.createElement('span');
  encLabel.textContent = '文字コード:';
  const encSelect = document.createElement('select');
  encSelect.title = 'このプロジェクトのdiffファイルの文字コードを指定（自動判定を誤った場合の上書き用）';
  encSelect.setAttribute('aria-label', `${proj.fileName} の文字コード`);
  for (const val of VALID_ENCODINGS) {
    const opt = document.createElement('option');
    opt.value = val;
    if (val === 'auto' && proj.resolvedEncoding) {
      const sourceLabel = ENCODING_LABELS[proj.resolvedEncoding] || proj.resolvedEncoding;
      // git log -p / git show input can carry a commit message encoded
      // differently from the diffed source (see decodeGitLog()); when
      // that was detected, show both instead of just the source's.
      opt.textContent = (proj.resolvedMessageEncoding && proj.resolvedMessageEncoding !== proj.resolvedEncoding)
        ? `${ENCODING_LABELS.auto}（ソース: ${sourceLabel} / コミットメッセージ: ${ENCODING_LABELS[proj.resolvedMessageEncoding] || proj.resolvedMessageEncoding}）`
        : `${ENCODING_LABELS.auto}（${sourceLabel}）`;
    } else {
      opt.textContent = ENCODING_LABELS[val];
    }
    encSelect.appendChild(opt);
  }
  // Normalize against the allow-list: a corrupted/legacy/manually-edited
  // localStorage value must not leave the <select> on an option that
  // doesn't exist, nor get handed to decodeBytes() as a bogus encoding.
  encSelect.value = normalizeEncoding(proj.encoding);
  encSelect.addEventListener('click', e => e.stopPropagation());
  encSelect.addEventListener('change', e => {
    e.stopPropagation();
    changeProjectEncoding(proj.id, e.target.value);
  });
  encEl.appendChild(encLabel);
  encEl.appendChild(encSelect);

  const resetBtn = document.createElement('button');
  resetBtn.className = 'btn btn-reset';
  resetBtn.textContent = '🔄 リセット';
  resetBtn.title = 'チェック状態をリセット';
  resetBtn.addEventListener('click', e => { e.stopPropagation(); resetProject(proj.id); });

  const delBtn = document.createElement('button');
  delBtn.className = 'btn btn-delete';
  delBtn.textContent = '🗑 削除';
  delBtn.title = 'プロジェクトを削除';
  delBtn.addEventListener('click', e => { e.stopPropagation(); deleteProject(proj.id); });

  // The reload button stays in the always-visible bottom row (not
  // .proj-details) since it's the one action the compact list (#83) is
  // meant to keep reachable without expanding — the badge above signals
  // when it's actually worth pressing. The project name gets its own row
  // and the reload button sits next to the updated time below it (#85).
  const bottomRowEl = document.createElement('div'); bottomRowEl.className = 'proj-bottom-row';
  if (projectIdsWithHandles.has(proj.id)) {
    const reloadBtn = document.createElement('button');
    reloadBtn.className = 'btn btn-reload' + (hasExternalUpdate ? ' btn-reload-update' : '');
    reloadBtn.textContent = '🔃 再読み込み';
    reloadBtn.title = hasExternalUpdate
      ? 'ディスク上のファイルが更新されています。クリックして再読み込み'
      : '同じファイルをディスクから再読み込み';
    reloadBtn.addEventListener('click', e => { e.stopPropagation(); reloadProjectFile(proj.id); });
    bottomRowEl.appendChild(reloadBtn);
  }
  bottomRowEl.appendChild(metaEl);
  bottomRowEl.appendChild(toggleBtn);

  actEl.appendChild(resetBtn);
  actEl.appendChild(delBtn);
  detailsEl.appendChild(idEl);
  detailsEl.appendChild(encEl);
  detailsEl.appendChild(actEl);

  if (projectSelectMode) {
    const selectBox = document.createElement('input');
    selectBox.type = 'checkbox';
    selectBox.className = 'proj-select-checkbox';
    selectBox.checked = isSelected;
    selectBox.setAttribute('aria-label', `${proj.fileName} を選択`);
    // The whole item toggles selection in select mode (see below), so the
    // checkbox itself just mirrors it.
    selectBox.tabIndex = -1;
    selectBox.addEventListener('click', e => e.preventDefault());
    topRowEl.appendChild(selectBox);
  }
  topRowEl.appendChild(progressBadgeEl);
  topRowEl.appendChild(nameEl);
  item.appendChild(topRowEl);
  item.appendChild(bottomRowEl);
  item.appendChild(detailsEl);

  item.addEventListener('click', () => {
    if (projectSelectMode) toggleProjectSelected(proj.id);
    else activateProject(proj.id);
  });
  return item;
}

/** A collection's sidebar group: a collapsible header (badge, name, member count, rename/dissolve) followed by its members. */
function buildCollectionGroup(collection, members) {
  const isCollapsed = collapsedCollectionIds.has(collection.id);
  const hasActive = members.some(p => p.id === app.currentProjectId);
  const group = document.createElement('div');
  group.className = 'collection-group' + (isCollapsed ? ' collapsed' : '') + (hasActive ? ' has-active' : '');

  const header = document.createElement('div');
  header.className = 'collection-header';
  header.title = 'コレクション（レビュー状態・行コメント・メモを共有）';

  if (projectSelectMode) {
    const selectBox = document.createElement('input');
    selectBox.type = 'checkbox';
    selectBox.className = 'proj-select-checkbox';
    const selectedCount = members.filter(p => selectedProjectIds.has(p.id)).length;
    selectBox.checked = selectedCount === members.length;
    selectBox.indeterminate = selectedCount > 0 && selectedCount < members.length;
    selectBox.setAttribute('aria-label', `コレクション「${collection.name}」のプロジェクトをすべて選択`);
    selectBox.addEventListener('click', e => {
      e.stopPropagation();
      for (const p of members) {
        if (selectBox.checked) selectedProjectIds.add(p.id);
        else selectedProjectIds.delete(p.id);
      }
      renderProjectList();
    });
    header.appendChild(selectBox);
  }

  const toggleBtn = document.createElement('button');
  toggleBtn.type = 'button';
  toggleBtn.className = 'collection-toggle';
  toggleBtn.textContent = isCollapsed ? '▸' : '▾';
  toggleBtn.setAttribute('aria-expanded', String(!isCollapsed));
  toggleBtn.setAttribute('aria-label', isCollapsed ? 'コレクションを開く' : 'コレクションを折りたたむ');
  header.appendChild(toggleBtn);

  const badgeEl = document.createElement('span');
  badgeEl.className = 'proj-progress-badge';
  badgeEl.hidden = true;
  collectionBadgeEls.set(collection.id, badgeEl);
  header.appendChild(badgeEl);

  const nameEl = document.createElement('span');
  nameEl.className = 'collection-name';
  nameEl.textContent = `📁 ${collection.name}`;
  header.appendChild(nameEl);

  const countEl = document.createElement('span');
  countEl.className = 'collection-count';
  countEl.textContent = `${members.length}件`;
  header.appendChild(countEl);

  const renameBtn = document.createElement('button');
  renameBtn.type = 'button';
  renameBtn.className = 'collection-action-btn';
  renameBtn.textContent = '✏️';
  renameBtn.title = 'コレクション名を変更';
  renameBtn.setAttribute('aria-label', `コレクション「${collection.name}」の名前を変更`);
  renameBtn.addEventListener('click', e => { e.stopPropagation(); renameCollection(collection.id); });
  header.appendChild(renameBtn);

  const dissolveBtn = document.createElement('button');
  dissolveBtn.type = 'button';
  dissolveBtn.className = 'collection-action-btn';
  dissolveBtn.textContent = '✕';
  dissolveBtn.title = 'コレクションを解散（状態は各プロジェクトにコピー）';
  dissolveBtn.setAttribute('aria-label', `コレクション「${collection.name}」を解散`);
  dissolveBtn.addEventListener('click', e => { e.stopPropagation(); dissolveCollection(collection.id); });
  header.appendChild(dissolveBtn);

  header.addEventListener('click', () => {
    if (isCollapsed) collapsedCollectionIds.delete(collection.id);
    else collapsedCollectionIds.add(collection.id);
    renderProjectList();
  });
  group.appendChild(header);

  const membersEl = document.createElement('div');
  membersEl.className = 'collection-members';
  for (const member of members) membersEl.appendChild(buildProjectItem(member));
  group.appendChild(membersEl);
  return group;
}

// ─────────────────────────────────────────────────────────────────────────────
// Sidebar project selection mode — the "☑ 選択" button turns the project
// list into a multi-select list; the action bar then creates a collection
// from the selected projects, adds them to an existing one, or takes them
// out of theirs (see "Collection actions").
// ─────────────────────────────────────────────────────────────────────────────
function setProjectSelectMode(on) {
  projectSelectMode = on;
  selectedProjectIds.clear();
  const btn = document.getElementById('project-select-mode-btn');
  btn.setAttribute('aria-pressed', String(on));
  btn.textContent = on ? '選択を終了' : '☑ 選択';
  renderProjectList();
}

function toggleProjectSelected(projectId) {
  if (selectedProjectIds.has(projectId)) selectedProjectIds.delete(projectId);
  else selectedProjectIds.add(projectId);
  renderProjectList();
}

/** Project IDs in sidebar display order: sorted, with each collection's members pulled up to its first member's position. */
function getSidebarProjectOrder() {
  const collectionIds = new Set(loadCollections().map(c => c.id));
  const sorted = sortProjects(loadProjects(), loadProjectSort());
  const order = [];
  const seenCollections = new Set();
  for (const proj of sorted) {
    if (!proj.collectionId || !collectionIds.has(proj.collectionId)) {
      order.push(proj.id);
    } else if (!seenCollections.has(proj.collectionId)) {
      seenCollections.add(proj.collectionId);
      order.push(...sorted.filter(p => p.collectionId === proj.collectionId).map(p => p.id));
    }
  }
  return order;
}

/** Selected project IDs in the order they appear in the sidebar. */
function getSelectedProjectIdsInOrder() {
  return getSidebarProjectOrder().filter(id => selectedProjectIds.has(id));
}

function renderProjectSelectBar(collections = loadCollections()) {
  const bar = document.getElementById('project-select-bar');
  bar.hidden = !projectSelectMode;
  if (!projectSelectMode) return;
  const count = selectedProjectIds.size;
  document.getElementById('project-select-count').textContent = `${count}件選択中`;
  document.getElementById('collection-create-btn').disabled = count === 0;
  document.getElementById('collection-remove-btn').disabled = count === 0;

  const addSelect = document.getElementById('collection-add-select');
  addSelect.innerHTML = '';
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = collections.length > 0 ? '➕ 既存に追加…' : '➕ 既存に追加（コレクションなし）';
  addSelect.appendChild(placeholder);
  for (const c of collections) {
    const option = document.createElement('option');
    option.value = c.id;
    option.textContent = c.name;
    addSelect.appendChild(option);
  }
  addSelect.value = '';
  addSelect.disabled = count === 0 || collections.length === 0;
}
