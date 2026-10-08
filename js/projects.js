'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Project actions
// ─────────────────────────────────────────────────────────────────────────────

/** Switch active project selection in the sidebar and restore its last diff, if saved */
async function activateProject(projectId) {
  if (app.currentProjectId === projectId) return;
  const proj = loadProjects().find(p => p.id === projectId);
  if (!proj) return;

  app.currentProjectId = projectId;
  app.parsedDiff = null;
  localStorage.setItem(SK_CURRENT, projectId);
  refreshMemoUI();
  // The active project's own keyword categories (issue #68) join the global
  // ones in the merged view, so the sidebar list changes with the project.
  renderKeywordCategoryList();
  // Same reasoning applies to the extraction modal's own keyword list (issue #79)
  // and the auto line comment rules.
  renderExtractKeywordList();
  renderAutoCommentRuleList();

  renderProjectList();
  // Clear the previous project's diff (and its checkboxes) immediately so
  // there's no window where the visible hunks belong to a different project
  // than app.currentProjectId while restoreProjectDiff's hashing is pending.
  showEmptyState(`
    <span class="icon" aria-hidden="true">⏳</span>
    プロジェクト「${esc(proj.fileName)}」を読み込み中…
  `);
  await restoreProjectDiff(proj);
}

/**
 * Try to re-render a project's diff from its saved file content.
 * Falls back to the "please reload the file" prompt if nothing was saved
 * (e.g. projects created before this feature, or a failed save due to quota).
 */
async function restoreProjectDiff(proj) {
  const savedText = loadFileContent(proj.id);
  if (savedText != null) {
    try {
      const parsed = parseDiff(savedText);
      if (parsed.length > 0) {
        await computeAllHashes(parsed);
        // If the user switched to a different project while hashing was in
        // flight, don't clobber whatever is now on screen with stale results.
        if (app.currentProjectId !== proj.id) return;
        app.parsedDiff = parsed;
        renderDiff();
        return;
      }
    } catch (e) {
      // Corrupted saved content or a hashing failure shouldn't leave the UI
      // stuck on the "読み込み中…" state; fall through to the reload prompt.
      console.error('Failed to restore saved diff content for project', proj.id, e);
    }
  }

  if (app.currentProjectId !== proj.id) return;
  app.parsedDiff = null;
  showEmptyState(`
    <span class="icon" aria-hidden="true">📂</span>
    プロジェクト「${esc(proj.fileName)}」を選択中<br>
    同じdiffファイルを再度読み込むと、レビュー済み状態が復元されます
  `);
}

/** Reset all review checkboxes for a project (for a collection member: the whole collection's shared review state) */
function resetProject(projectId) {
  const proj = loadProjects().find(p => p.id === projectId);
  const collectionId = getProjectCollectionId(projectId);
  const collection = collectionId && loadCollections().find(c => c.id === collectionId);
  if (!confirm(collection
    ? `プロジェクト「${proj ? proj.id : projectId}」はコレクション「${collection.name}」に入っています。
コレクション内で共有しているチェック状態（すべてのプロジェクト分）をリセットしますか？`
    : `プロジェクト「${proj ? proj.id : projectId}」のチェック状態をリセットしますか？`)) return;

  const ownerId = getStateOwnerId(projectId);
  const allReviews = loadAllReviews();
  delete allReviews[ownerId];
  saveAllReviews(allReviews);
  scheduleSettingsAutoSave();

  if (app.parsedDiff && getStateOwnerId(app.currentProjectId) === ownerId) renderDiff();
  renderProjectList();
}

/** Permanently delete a project */
function deleteProject(projectId) {
  const proj = loadProjects().find(p => p.id === projectId);
  const collectionId = getProjectCollectionId(projectId);
  const isLastMember = collectionId && getCollectionMemberIds(collectionId).length === 1;
  let message = `プロジェクト「${proj ? proj.id : projectId}」を削除しますか？\nチェック状態も合わせて削除されます。`;
  if (isLastMember) {
    message = `プロジェクト「${proj ? proj.id : projectId}」を削除しますか？\nコレクションの最後のプロジェクトのため、コレクションと共有しているチェック状態・行コメント・メモ・コレクション範囲の設定も合わせて削除されます。`;
  } else if (collectionId) {
    message = `プロジェクト「${proj ? proj.id : projectId}」を削除しますか？\nコレクションで共有しているチェック状態は、コレクションに残ります。`;
  }
  if (!confirm(message)) return;

  // Leave its collection without copying the shared state (it's about to be
  // deleted anyway); the shared state stays with the remaining members.
  detachProjectFromCollection(projectId, false);
  const allReviews = loadAllReviews();
  delete allReviews[projectId];
  saveAllReviews(allReviews);
  deleteMemosForProject(projectId);
  deleteLineCommentsForProject(projectId);
  deleteProjectKeywordCategories(projectId);
  deleteProjectExtractKeywords(projectId);
  deleteAutoCommentDataForProject(projectId);
  deleteFileContent(projectId);
  deleteFileHandleRecord(projectId);
  invalidateProjectProgressCache(projectId);

  saveProjects(loadProjects().filter(p => p.id !== projectId));
  scheduleSettingsAutoSave();

  if (app.currentProjectId === projectId) {
    app.currentProjectId = null;
    app.parsedDiff = null;
    localStorage.removeItem(SK_CURRENT);
    showEmptyState('<span class="icon" aria-hidden="true">📄</span>Diffファイルを読み込んでください');
    renderKeywordCategoryList();
    renderExtractKeywordList();
    renderAutoCommentRuleList();
  }
  refreshMemoUI();

  renderProjectList();
}

/**
 * Create a brand-new project and display its diff.
 * `encodingPref` is the user's encoding choice ('auto' or an explicit
 * override) persisted for future loads/reloads; `resolvedEncoding` is the
 * concrete encoding actually used to decode this file, shown in the UI.
 * `resolvedMessageEncoding` is the commit message section's own resolved
 * encoding when it was detected separately from the source (see
 * decodeGitLog()); undefined when no such separate detection applied.
 */
function createNewProject(fileName, parsed, rawText, fileHandle = null, encodingPref = 'auto', resolvedEncoding = 'utf-8', resolvedMessageEncoding = undefined) {
  const id  = generateProjectId(fileName);
  const now = Date.now();
  const projects = loadProjects();
  projects.push({ id, fileName, createdAt: now, lastUpdated: now, encoding: encodingPref, resolvedEncoding, resolvedMessageEncoding });
  saveProjects(projects);
  scheduleSettingsAutoSave();
  saveFileContent(id, rawText);
  if (fileHandle) saveFileHandle(id, fileHandle).then(() => recordProjectFileBaseline(id, fileHandle)).then(renderProjectList);

  app.currentProjectId = id;
  app.parsedDiff = parsed;
  localStorage.setItem(SK_CURRENT, id);
  applyAutoLineComments();
  refreshMemoUI();
  renderKeywordCategoryList();
  renderExtractKeywordList();
  renderAutoCommentRuleList();

  renderProjectList();
  renderDiff();
  return id;
}

/** Update an existing project's metadata and display its (new) diff */
function updateExistingProject(projectId, parsed, rawText, fileHandle = null, encodingPref = undefined, resolvedEncoding = undefined, resolvedMessageEncoding = undefined) {
  const projects = loadProjects();
  const proj = projects.find(p => p.id === projectId);
  if (proj) {
    proj.lastUpdated = Date.now();
    if (encodingPref !== undefined) proj.encoding = encodingPref;
    // Set together with resolvedEncoding (always passed as a pair from
    // decodeGitLog()'s result) so a stale message-encoding note from a
    // previous mixed-encoding load is cleared once it no longer applies.
    if (resolvedEncoding !== undefined) {
      proj.resolvedEncoding = resolvedEncoding;
      proj.resolvedMessageEncoding = resolvedMessageEncoding;
    }
    saveProjects(projects);
    scheduleSettingsAutoSave();
  }
  saveFileContent(projectId, rawText);
  if (fileHandle) saveFileHandle(projectId, fileHandle).then(() => recordProjectFileBaseline(projectId, fileHandle)).then(renderProjectList);

  app.currentProjectId = projectId;
  app.parsedDiff = parsed;
  localStorage.setItem(SK_CURRENT, projectId);
  applyAutoLineComments();
  refreshMemoUI();
  renderKeywordCategoryList();
  renderExtractKeywordList();
  renderAutoCommentRuleList();

  renderProjectList();
  renderDiff();
}

/**
 * Change a project's encoding preference and, if possible, immediately
 * re-decode its file with the new setting. Requires a remembered
 * FileSystemFileHandle (File System Access API); otherwise the preference
 * is saved and applied the next time the file is (re-)selected.
 */
async function changeProjectEncoding(projectId, newEncoding) {
  const projects = loadProjects();
  const proj = projects.find(p => p.id === projectId);
  if (!proj) return;
  proj.encoding = newEncoding;
  saveProjects(projects);

  if (projectIdsWithHandles.has(projectId)) {
    await reloadProjectFile(projectId);
  } else {
    renderProjectList();
    alert(
      '文字コードの設定を保存しました。\n' +
      '「📂 Diffファイルを開く」から同じファイルを選び直すと、新しい設定で再読み込みされます。'
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Collection actions — create/add/remove/rename/dissolve, and moving a
// project's review state into/out of its collection (see "Collections —
// data layer" for the storage model).
//  - Joining merges the project's own reviews/line comments/memos/auto-comment
//    log into the collection's (the collection's existing review status wins
//    on a conflict) and drops the project's own copy. Its project-scoped
//    settings stay where they are.
//  - Leaving copies the collection's state back under the project's own ID,
//    and copies the collection-scoped settings into the project's own
//    settings (with fresh IDs). A collection left with no members is deleted.
// ─────────────────────────────────────────────────────────────────────────────

/** JSON round-trip copy (every store here is plain JSON data). */
function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

/** Merges `fromId`'s reviews/line comments/memos/auto-comment log into `toId`'s, then removes `fromId`'s. Existing `toId` review statuses win. */
function mergeStateIntoOwner(fromId, toId) {
  const reviews = loadAllReviews();
  if (reviews[fromId]) {
    const target = ensureChild(reviews, toId);
    for (const fp of Object.keys(reviews[fromId])) {
      const targetFile = ensureChild(target, fp);
      for (const h of Object.keys(reviews[fromId][fp])) {
        if (!targetFile[h]) targetFile[h] = reviews[fromId][fp][h];
      }
    }
    delete reviews[fromId];
    saveAllReviews(reviews);
  }

  const comments = loadAllLineComments();
  if (comments[fromId]) {
    const target = ensureChild(comments, toId);
    for (const fp of Object.keys(comments[fromId])) {
      for (const h of Object.keys(comments[fromId][fp])) {
        for (const idx of Object.keys(comments[fromId][fp][h])) {
          const list = ensureChild(ensureChild(ensureChild(target, fp), h), idx, true);
          // Skip the same comment, and an auto comment the same rule already
          // added to this line on the collection's side (each member ran
          // the rule on its own before joining).
          for (const c of comments[fromId][fp][h][idx]) {
            if (list.some(t => t.id === c.id || (c.autoRuleId && t.autoRuleId === c.autoRuleId))) continue;
            list.push(c);
          }
        }
      }
    }
    delete comments[fromId];
    saveAllLineComments(comments);
  }

  const memos = loadAllMemos();
  if (memos[fromId]) {
    const list = ensureChild(memos, toId, true);
    const ids = new Set(list.map(m => m.id));
    for (const m of memos[fromId]) if (!ids.has(m.id)) list.push(m);
    delete memos[fromId];
    saveAllMemos(memos);
  }

  const applied = loadAllAutoCommentApplied();
  if (applied[fromId]) {
    const target = ensureChild(applied, toId);
    for (const fp of Object.keys(applied[fromId])) {
      for (const h of Object.keys(applied[fromId][fp])) {
        for (const idx of Object.keys(applied[fromId][fp][h])) {
          const list = ensureChild(ensureChild(ensureChild(target, fp), h), idx, true);
          for (const ruleId of applied[fromId][fp][h][idx]) if (!list.includes(ruleId)) list.push(ruleId);
        }
      }
    }
    delete applied[fromId];
    saveAllAutoCommentApplied(applied);
  }
}

/** Replaces `toId`'s reviews/line comments/memos/auto-comment log with a copy of `fromId`'s (`fromId` is left untouched). */
function copyStateToOwner(fromId, toId) {
  const stores = [
    [loadAllReviews, saveAllReviews],
    [loadAllLineComments, saveAllLineComments],
    [loadAllMemos, saveAllMemos],
    [loadAllAutoCommentApplied, saveAllAutoCommentApplied],
  ];
  for (const [load, save] of stores) {
    const all = load();
    if (!all[fromId] && !all[toId]) continue;
    if (all[fromId]) all[toId] = cloneJson(all[fromId]);
    else delete all[toId];
    save(all);
  }
}

/**
 * Appends copies of a collection's own highlight categories, extraction
 * keywords and auto-comment rules to a project's own settings, each with a
 * fresh ID (so they never clash with the originals if the project rejoins).
 * The project's auto-comment log is rewritten to the new rule IDs, so lines
 * the copied rules already handled stay handled.
 */
function copyCollectionSettingsToProject(collectionId, projectId) {
  const categories = loadProjectKeywordCategories(collectionId);
  if (categories.length > 0) {
    saveProjectKeywordCategories(projectId, [
      ...loadProjectKeywordCategories(projectId),
      ...categories.map(c => ({ ...c, id: generateKeywordCategoryId() })),
    ]);
  }

  const keywords = loadProjectExtractKeywords(collectionId);
  if (keywords.length > 0) {
    saveProjectExtractKeywords(projectId, [
      ...loadProjectExtractKeywords(projectId),
      ...keywords.map(k => ({ ...k, id: generateExtractKeywordId() })),
    ]);
  }

  const rules = loadProjectAutoCommentRules(collectionId);
  if (rules.length > 0) {
    const newIds = new Map(rules.map(r => [r.id, generateAutoCommentRuleId()]));
    saveProjectAutoCommentRules(projectId, [
      ...loadProjectAutoCommentRules(projectId),
      ...rules.map(r => ({ ...r, id: newIds.get(r.id) })),
    ]);
    const applied = loadAllAutoCommentApplied();
    const log = applied[projectId];
    if (log) {
      for (const fp of Object.keys(log)) {
        for (const h of Object.keys(log[fp])) {
          for (const idx of Object.keys(log[fp][h])) {
            log[fp][h][idx] = log[fp][h][idx].map(id => newIds.get(id) || id);
          }
        }
      }
      saveAllAutoCommentApplied(applied);
    }
  }
}

/** Removes a collection and everything stored under its ID (its members must already have left). */
function deleteCollectionData(collectionId) {
  const reviews = loadAllReviews();
  if (collectionId in reviews) {
    delete reviews[collectionId];
    saveAllReviews(reviews);
  }
  deleteMemosForProject(collectionId);
  deleteLineCommentsForProject(collectionId);
  deleteProjectKeywordCategories(collectionId);
  deleteProjectExtractKeywords(collectionId);
  deleteAutoCommentDataForProject(collectionId);
  saveCollections(loadCollections().filter(c => c.id !== collectionId));
  collapsedCollectionIds.delete(collectionId);
}

/**
 * Takes a project out of its collection (no-op if it isn't in one). With
 * `copyState`, the collection's state and collection-scoped settings are
 * copied to the project first (skipped when the project is being deleted).
 * Deletes the collection once it has no members left.
 */
function detachProjectFromCollection(projectId, copyState = true) {
  const projects = loadProjects();
  const proj = projects.find(p => p.id === projectId);
  if (!proj || !proj.collectionId) return;
  const collectionId = proj.collectionId;
  const exists = loadCollections().some(c => c.id === collectionId);
  if (copyState && exists) {
    copyStateToOwner(collectionId, projectId);
    copyCollectionSettingsToProject(collectionId, projectId);
  }
  delete proj.collectionId;
  saveProjects(projects);
  if (exists && getCollectionMemberIds(collectionId, projects).length === 0) deleteCollectionData(collectionId);
}

/** Puts a project into a collection, first leaving any other collection it's in, and merges its state into the collection's. */
function attachProjectToCollection(projectId, collectionId) {
  if (getProjectCollectionId(projectId) === collectionId) return;
  detachProjectFromCollection(projectId);
  mergeStateIntoOwner(projectId, collectionId);
  const projects = loadProjects();
  const proj = projects.find(p => p.id === projectId);
  if (!proj) return;
  proj.collectionId = collectionId;
  saveProjects(projects);
}

/** File name without its last extension, as a default collection name. */
function defaultCollectionName(fileName) {
  return fileName.replace(/\.[^.]+$/, '') || fileName;
}

/** Re-render everything that depends on which collection (if any) the active project is in. */
function refreshAfterCollectionChange() {
  scheduleSettingsAutoSave();
  refreshMemoUI();
  renderKeywordCategoryList();
  renderExtractKeywordList();
  renderAutoCommentRuleList();
  renderProjectList();
  if (app.currentProjectId && app.parsedDiff) renderDiff();
}

/** Creates a collection named via a prompt and moves the given projects into it (merged in order, so the first one's review statuses win). */
function createCollectionFromProjects(projectIds) {
  const projects = loadProjects();
  const ids = projectIds.filter(id => projects.some(p => p.id === id));
  if (ids.length === 0) return false;
  const first = projects.find(p => p.id === ids[0]);
  const input = prompt(
    `選択した ${ids.length} 件のプロジェクトで新しいコレクションを作成します。\n` +
    'コレクション内ではレビュー状態・行コメント・メモが共有されます。\n\nコレクション名:',
    defaultCollectionName(first.fileName)
  );
  if (input === null) return false;
  const name = input.trim() || defaultCollectionName(first.fileName);

  const collection = { id: generateCollectionId(), name, createdAt: Date.now() };
  saveCollections([...loadCollections(), collection]);
  for (const id of ids) attachProjectToCollection(id, collection.id);
  refreshAfterCollectionChange();
  return true;
}

/** Moves the given projects into an existing collection. */
function addProjectsToCollection(projectIds, collectionId) {
  const collection = loadCollections().find(c => c.id === collectionId);
  if (!collection) return false;
  const ids = projectIds.filter(id => getProjectCollectionId(id) !== collectionId);
  if (ids.length === 0) return false;
  if (!confirm(
    `${ids.length} 件のプロジェクトをコレクション「${collection.name}」に追加します。\n` +
    'レビュー状態・行コメント・メモはコレクションに統合されます（同じハンクのレビュー状態はコレクション側を優先）。\n' +
    '別のコレクションに入っているプロジェクトは、そのコレクションから外したうえで移動します。よろしいですか？'
  )) return false;
  for (const id of ids) attachProjectToCollection(id, collectionId);
  refreshAfterCollectionChange();
  return true;
}

/** Takes the given projects out of their collections, copying the shared state back to each. */
function removeProjectsFromCollections(projectIds) {
  const ids = projectIds.filter(id => getProjectCollectionId(id));
  if (ids.length === 0) {
    alert('選択したプロジェクトはコレクションに入っていません。');
    return false;
  }
  if (!confirm(
    `${ids.length} 件のプロジェクトをコレクションから外します。\n` +
    'コレクションのレビュー状態・行コメント・メモと、コレクション範囲の設定は各プロジェクトにコピーされます。\n' +
    'プロジェクトがなくなったコレクションは自動で削除されます。よろしいですか？'
  )) return false;
  for (const id of ids) detachProjectFromCollection(id);
  refreshAfterCollectionChange();
  return true;
}

function renameCollection(collectionId) {
  const collections = loadCollections();
  const collection = collections.find(c => c.id === collectionId);
  if (!collection) return;
  const input = prompt('コレクション名:', collection.name);
  if (input === null || !input.trim() || input.trim() === collection.name) return;
  collection.name = input.trim();
  saveCollections(collections);
  scheduleSettingsAutoSave();
  renderProjectList();
}

/** Takes every member out of a collection (copying its state to each), which deletes it. */
function dissolveCollection(collectionId) {
  const collection = loadCollections().find(c => c.id === collectionId);
  if (!collection) return;
  if (!confirm(
    `コレクション「${collection.name}」を解散しますか？\n` +
    'レビュー状態・行コメント・メモと、コレクション範囲の設定は各プロジェクトにコピーされます。'
  )) return;
  for (const id of getCollectionMemberIds(collectionId)) detachProjectFromCollection(id);
  refreshAfterCollectionChange();
}

// ─────────────────────────────────────────────────────────────────────────────
// Conflict modal (same filename detected)
// ─────────────────────────────────────────────────────────────────────────────
function showConflictModal(fileName, existingProjects, parsed, rawText, fileHandle = null, encodingPref = 'auto', resolvedEncoding = 'utf-8', resolvedMessageEncoding = undefined) {
  modalFileName   = fileName;
  modalParsedDiff = parsed;
  modalRawText    = rawText;
  modalFileHandle = fileHandle;
  modalEncoding   = encodingPref;
  modalResolvedEncoding = resolvedEncoding;
  modalResolvedMessageEncoding = resolvedMessageEncoding;

  document.getElementById('modal-desc').textContent =
    `ファイル名「${fileName}」の既存プロジェクトが ${existingProjects.length} 件あります。` +
    `更新するプロジェクトを選択するか、新規プロジェクトとして作成してください。`;

  const listEl = document.getElementById('modal-proj-list');
  listEl.innerHTML = '';

  // Pre-select the most recently updated project
  const sorted = [...existingProjects].sort((a, b) => (b.lastUpdated || b.createdAt) - (a.lastUpdated || a.createdAt));
  modalSelectedId = sorted[0]?.id ?? null;

  for (const proj of sorted) {
    const div = document.createElement('div');
    div.className = 'proj-option' + (proj.id === modalSelectedId ? ' selected' : '');
    div.tabIndex = 0;

    const updated = new Date(proj.lastUpdated || proj.createdAt).toLocaleString('ja-JP', {
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    });

    const idEl   = document.createElement('div'); idEl.className = 'opt-id';   idEl.textContent = proj.id;
    const metaEl = document.createElement('div'); metaEl.className = 'opt-meta'; metaEl.textContent = `更新: ${updated}`;
    div.appendChild(idEl);
    div.appendChild(metaEl);

    div.addEventListener('click', () => {
      listEl.querySelectorAll('.proj-option').forEach(el => el.classList.remove('selected'));
      div.classList.add('selected');
      modalSelectedId = proj.id;
    });

    div.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        div.click();
      }
    });

    listEl.appendChild(div);
  }

  document.getElementById('modal-overlay').classList.add('active');

  // Focus on the primary button for keyboard/screen-reader accessibility.
  // Timeout ensures the modal is fully rendered before focusing.
  setTimeout(() => {
    document.getElementById('modal-btn-update').focus();
  }, 100);

  // Resolved once the user makes a choice (or dismisses the modal), so
  // callers such as loadDiffFile() can await the outcome before moving on
  // to the next file in a batch.
  return new Promise((resolve) => {
    modalResolve = resolve;
  });
}

/** Settle the pending showConflictModal() promise, if any, then clear it. */
function resolvePendingModal() {
  if (modalResolve) {
    const resolve = modalResolve;
    modalResolve = null;
    resolve();
  }
}

function hideModal() {
  document.getElementById('modal-overlay').classList.remove('active');
  modalFileName   = '';
  modalParsedDiff = null;
  modalRawText    = null;
  modalSelectedId = null;
  modalFileHandle = null;
  modalEncoding   = 'auto';
  modalResolvedEncoding = 'utf-8';
  modalResolvedMessageEncoding = undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// File loading
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Load and parse a single diff File, then either create a new project or
 * (when a same-named project already exists) resolve the conflict.
 *
 * In normal (interactive) mode a conflict opens the confirmation modal and
 * waits for the user's choice. In batch mode (used when multiple files are
 * uploaded at once) the modal is skipped and the most recently updated
 * same-named project is updated automatically, so a whole batch can be
 * processed without blocking on per-file dialogs; the caller is told a
 * conflict occurred so it can summarize this for the user afterwards.
 *
 * `batchCreatedIds`, when given, is a Set (shared across the whole batch by
 * the caller) of project IDs already created earlier in this same batch.
 * Those projects are excluded from auto-update candidates so that two
 * files sharing a name within one batch still become two separate
 * projects, instead of the second silently overwriting the first.
 *
 * @returns {Promise<{conflict: boolean}>}
 */
async function loadDiffFile(file, fileHandle = null, encodingPref = 'auto', { batchMode = false, batchCreatedIds = null } = {}) {
  let buffer;
  try {
    buffer = await file.arrayBuffer();
  } catch (err) {
    alert(`ファイルの読み込みに失敗しました:\n${err.message}`);
    return { conflict: false };
  }

  const { text, encoding, messageEncoding } = decodeGitLog(buffer, encodingPref);

  const parsed = parseDiff(text);
  if (parsed.length === 0) {
    alert(
      `「${file.name}」: 有効なdiff（unified diff形式）が見つかりませんでした。\n` +
      'git diff / git show / git log -p の出力を保存したファイルをご利用ください。\n' +
      '文字コードの判定・指定が誤っている可能性もあります。'
    );
    return { conflict: false };
  }

  // Compute SHA-256 hashes for all hunks (async, uses Web Crypto API)
  await computeAllHashes(parsed);

  const fileName = file.name;
  const existing = projectsByFileName(fileName);

  if (existing.length > 0) {
    if (batchMode) {
      // Don't block a multi-file upload on a per-file modal: update the
      // most recently updated same-named project automatically (matching
      // the modal's default pre-selection), and let the caller inform the
      // user afterwards. Projects created earlier in this same batch are
      // excluded so same-named files within one batch don't overwrite
      // each other.
      const updatable = batchCreatedIds
        ? existing.filter(p => !batchCreatedIds.has(p.id))
        : existing;
      if (updatable.length > 0) {
        const mostRecent = [...updatable].sort(
          (a, b) => (b.lastUpdated || b.createdAt) - (a.lastUpdated || a.createdAt)
        )[0];
        updateExistingProject(mostRecent.id, parsed, text, fileHandle, encodingPref, encoding, messageEncoding);
        return { conflict: true };
      }
    } else {
      await showConflictModal(fileName, existing, parsed, text, fileHandle, encodingPref, encoding, messageEncoding);
      return { conflict: true };
    }
  }

  const newId = createNewProject(fileName, parsed, text, fileHandle, encodingPref, encoding, messageEncoding);
  if (batchCreatedIds) batchCreatedIds.add(newId);
  return { conflict: false };
}

/**
 * Load multiple diff files, one after another (never in parallel — project
 * IDs are generated from a same-day sequence counter, so concurrent loads
 * of same-named files could race and collide).
 *
 * A single file is delegated straight to loadDiffFile() in its normal
 * interactive mode, leaving that existing single-file flow (including the
 * conflict modal) completely untouched. For two or more files, conflicts
 * are auto-resolved by updating the matching existing project (see
 * loadDiffFile's batchMode) and summarized in one alert at the end, so the
 * user is always told what happened and no file is silently dropped.
 */
async function loadDiffFiles(files, encodingPref = 'auto', fileHandles = null) {
  if (files.length === 0) return;

  if (files.length === 1) {
    await loadDiffFile(files[0], fileHandles ? fileHandles[0] : null, encodingPref);
    return;
  }

  const autoUpdated = [];
  const batchCreatedIds = new Set();
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const handle = fileHandles ? fileHandles[i] : null;
    const result = await loadDiffFile(file, handle, encodingPref, { batchMode: true, batchCreatedIds });
    if (result && result.conflict) autoUpdated.push(file.name);
  }

  renderProjectList();

  if (autoUpdated.length > 0) {
    alert(
      `${files.length} 件のファイルを読み込みました。\n` +
      `うち ${autoUpdated.length} 件は同名の既存プロジェクトがあったため、そのプロジェクトを更新しました:\n` +
      autoUpdated.map(n => `・${n}`).join('\n')
    );
  } else {
    alert(`${files.length} 件のファイルをすべて新規プロジェクトとして読み込みました。`);
  }
}

/**
 * Re-read a project's remembered file straight from disk via its stored
 * FileSystemFileHandle (File System Access API) and refresh its diff/review
 * state in place, without going through the file picker again.
 */
async function reloadProjectFile(projectId) {
  const proj = loadProjects().find(p => p.id === projectId);
  if (!proj) return;

  const handle = await loadFileHandle(projectId);
  if (!handle) {
    alert(
      'このプロジェクトには再読み込み用のファイル参照が保存されていません。\n' +
      '「📂 Diffファイルを開く」から選び直してください。'
    );
    return;
  }

  try {
    let permission = await handle.queryPermission({ mode: 'read' });
    if (permission !== 'granted') {
      permission = await handle.requestPermission({ mode: 'read' });
    }
    if (permission !== 'granted') {
      alert(
        'ファイルへのアクセスが許可されなかったため、保存していたファイル参照を破棄しました。\n' +
        '「📂 Diffファイルを開く」から選び直してください。'
      );
      await deleteFileHandleRecord(projectId);
      renderProjectList();
      return;
    }

    const file = await handle.getFile();
    const buffer = await file.arrayBuffer();
    const { text, encoding, messageEncoding } = decodeGitLog(buffer, normalizeEncoding(proj.encoding));
    const parsed = parseDiff(text);
    if (parsed.length === 0) {
      alert(
        '有効なdiff（unified diff形式）が見つかりませんでした。\n' +
        'ファイルの内容を確認してください。\n' +
        '文字コードの判定・指定が誤っている可能性もあります。'
      );
      return;
    }
    await computeAllHashes(parsed);
    updateExistingProject(projectId, parsed, text, handle, proj.encoding, encoding, messageEncoding);
  } catch (err) {
    console.error('Failed to reload file for project', projectId, err);
    alert(
      `ファイルの再読み込みに失敗しました:\n${err.message}\n\n` +
      'ファイルが移動または削除された可能性があります。「📂 Diffファイルを開く」から選び直してください。'
    );
    if (err.name === 'NotFoundError') {
      await deleteFileHandleRecord(projectId);
      renderProjectList();
    }
  }
}
