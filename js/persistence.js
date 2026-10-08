'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Export / Import
// ─────────────────────────────────────────────────────────────────────────────

/** Keep only well-formed project entries; drop anything with an unexpected shape. */
function sanitizeImportedProjects(rawProjects) {
  if (!Array.isArray(rawProjects)) return [];
  const result = [];
  for (const p of rawProjects) {
    if (!p || typeof p !== 'object') continue;
    if (typeof p.id !== 'string' || typeof p.fileName !== 'string') continue;
    const createdAt = typeof p.createdAt === 'number' ? p.createdAt : Date.now();
    const lastUpdated = typeof p.lastUpdated === 'number' ? p.lastUpdated : createdAt;
    const encoding = normalizeEncoding(p.encoding);
    const resolvedEncoding = ['utf-8', 'shift_jis', 'euc-jp'].includes(p.resolvedEncoding) ? p.resolvedEncoding : undefined;
    const resolvedMessageEncoding = ['utf-8', 'shift_jis', 'euc-jp'].includes(p.resolvedMessageEncoding) ? p.resolvedMessageEncoding : undefined;
    // Only meaningful together with a FileSystemFileHandle for the same ID
    // in this browser's IndexedDB (see checkProjectFileUpdates()) — carried
    // through as-is so a same-machine settings-folder reload doesn't lose
    // the external-update-check baseline; harmless dead data otherwise.
    const fileLastModified = typeof p.fileLastModified === 'number' ? p.fileLastModified : undefined;
    const collectionId = typeof p.collectionId === 'string' && COLLECTION_ID_RE.test(p.collectionId) ? p.collectionId : undefined;
    result.push({ id: p.id, fileName: p.fileName, createdAt, lastUpdated, encoding, resolvedEncoding, resolvedMessageEncoding, fileLastModified, collectionId });
  }
  return result;
}

/**
 * Restores the collection invariants after an import: a project pointing at
 * a collection that doesn't exist gets a placeholder one (so the state stored
 * under that ID stays reachable), state imported under a member's own ID
 * (e.g. from a pre-v8 export) is folded into its collection's (the
 * collection's review statuses win), and a collection with no members is
 * deleted together with its stored state.
 */
function reconcileCollections() {
  const projects = loadProjects();
  const collections = loadCollections();
  const missing = [...new Set(projects.map(p => p.collectionId).filter(id => id && !collections.some(c => c.id === id)))];
  if (missing.length > 0) {
    saveCollections([...collections, ...missing.map(id => ({ id, name: 'コレクション', createdAt: Date.now() }))]);
  }
  for (const p of projects) {
    if (p.collectionId) mergeStateIntoOwner(p.id, p.collectionId);
  }
  for (const c of loadCollections()) {
    if (getCollectionMemberIds(c.id, projects).length === 0) deleteCollectionData(c.id);
  }
}

/**
 * Build the app-data payload shared by manual export and folder-based settings save.
 * schemaVersion 2 (issue #51): `reviews` hunk values changed from a boolean
 * to a status string (see REVIEW_STATUSES). schemaVersion 3 (issue #58):
 * added `keywordCategories` (the SK_KEYWORDS category/color list).
 * schemaVersion 4 (issue #68): added `projectKeywordCategories` (the
 * SK_PROJECT_KEYWORDS per-project category map) alongside `keywordCategories`,
 * which now holds only global-scoped categories. Imports are version-agnostic
 * — sanitizeReviewsData()/normalizeReviewStatus() coerce both the old boolean
 * shape and the new string shape on read, and `keywordCategories`/
 * `projectKeywordCategories` are simply absent from pre-#58/#68 exports — so
 * schemaVersion is informational only and isn't itself checked on import.
 * schemaVersion 5 (issue #79): added `extractKeywords`/`projectExtractKeywords`
 * (the SK_EXTRACT_KEYWORDS/SK_PROJECT_EXTRACT_KEYWORDS keyword-line-extraction
 * stores — a separate feature from keyword highlighting above), following the
 * same global/per-project split as `keywordCategories`/`projectKeywordCategories`.
 * schemaVersion 6: added `lineComments` (SK_LINE_COMMENTS per-line review
 * comments), merged per project on import the same way as `memos`.
 * schemaVersion 7: added `autoCommentRules`/`projectAutoCommentRules` (auto
 * line comment rules, merged by id like `extractKeywords`) and
 * `autoCommentApplied` (SK_AUTO_COMMENT_APPLIED, replaced per project on
 * import together with `lineComments`).
 * schemaVersion 8: added `collections` (SK_COLLECTIONS) and each project's
 * `collectionId`. A collection's shared reviews/memos/lineComments/
 * autoCommentApplied and its collection-scoped settings are stored under the
 * collection ID inside the existing per-ID maps, so they need no new fields.
 */
function buildExportData() {
  return {
    schemaVersion: 8,
    exportedAt: new Date().toISOString(),
    projects: loadProjects(),
    collections: loadCollections(),
    reviews: loadAllReviews(),
    memos: loadAllMemos(),
    lineComments: loadAllLineComments(),
    keywordCategories: loadGlobalKeywordCategories(),
    projectKeywordCategories: loadAllProjectKeywordCategories(),
    extractKeywords: loadGlobalExtractKeywords(),
    projectExtractKeywords: loadAllProjectExtractKeywords(),
    autoCommentRules: loadGlobalAutoCommentRules(),
    projectAutoCommentRules: loadAllProjectAutoCommentRules(),
    autoCommentApplied: loadAllAutoCommentApplied(),
  };
}

/**
 * Merge imported keyword categories (issue #58, scoped per-project in #68)
 * into localStorage: same-ID categories are overwritten, other existing
 * categories are kept — same merge policy as projects in mergeImportedData().
 * `rawGlobal`/`rawByProjectId` are absent on pre-#58/#68 exports, in which
 * case the corresponding merge is a no-op.
 */
function mergeImportedKeywordCategories(rawGlobal, rawByProjectId) {
  const importedGlobal = sanitizeKeywordCategories(rawGlobal);
  if (importedGlobal.length > 0) {
    const byId = new Map(loadGlobalKeywordCategories().map(c => [c.id, c]));
    for (const c of importedGlobal) byId.set(c.id, c);
    saveGlobalKeywordCategories([...byId.values()]);
  }

  // sanitizeProjectKeywordCategoriesMap() rejects arrays/non-plain-objects
  // (so e.g. a stray top-level array doesn't get treated as a projectId map
  // via its numeric indices) and rebuilds into a null-prototype object,
  // guarding against a "__proto__"-named project id in the imported JSON.
  const importedByProject = sanitizeProjectKeywordCategoriesMap(rawByProjectId);
  if (Object.keys(importedByProject).length === 0) return;
  const allProjectCategories = loadAllProjectKeywordCategories();
  for (const pid of Object.keys(importedByProject)) {
    const byId = new Map((allProjectCategories[pid] || []).map(c => [c.id, c]));
    for (const c of importedByProject[pid]) byId.set(c.id, c);
    allProjectCategories[pid] = [...byId.values()];
  }
  saveAllProjectKeywordCategories(allProjectCategories);
}

/**
 * Merge imported keyword-line-extraction keywords (issue #79) into
 * localStorage: same-ID entries are overwritten, other existing entries are
 * kept — same merge policy as mergeImportedKeywordCategories() above.
 * `rawGlobal`/`rawByProjectId` are absent on pre-#79 exports, in which case
 * the corresponding merge is a no-op.
 */
function mergeImportedExtractKeywords(rawGlobal, rawByProjectId) {
  const importedGlobal = sanitizeExtractKeywords(rawGlobal);
  if (importedGlobal.length > 0) {
    const byId = new Map(loadGlobalExtractKeywords().map(k => [k.id, k]));
    for (const k of importedGlobal) byId.set(k.id, k);
    saveGlobalExtractKeywords([...byId.values()]);
  }

  const importedByProject = sanitizeProjectExtractKeywordsMap(rawByProjectId);
  if (Object.keys(importedByProject).length === 0) return;
  const allProjectKeywords = loadAllProjectExtractKeywords();
  for (const pid of Object.keys(importedByProject)) {
    const byId = new Map((allProjectKeywords[pid] || []).map(k => [k.id, k]));
    for (const k of importedByProject[pid]) byId.set(k.id, k);
    allProjectKeywords[pid] = [...byId.values()];
  }
  saveAllProjectExtractKeywords(allProjectKeywords);
}

/** Merge imported auto line comment rules by id, same policy as mergeImportedExtractKeywords(). */
function mergeImportedAutoCommentRules(rawGlobal, rawByProjectId) {
  const importedGlobal = sanitizeAutoCommentRules(rawGlobal);
  if (importedGlobal.length > 0) {
    const byId = new Map(loadGlobalAutoCommentRules().map(r => [r.id, r]));
    for (const r of importedGlobal) byId.set(r.id, r);
    saveGlobalAutoCommentRules([...byId.values()]);
  }

  const importedByProject = sanitizeProjectAutoCommentRulesMap(rawByProjectId);
  if (Object.keys(importedByProject).length === 0) return;
  const allProjectRules = loadAllProjectAutoCommentRules();
  for (const pid of Object.keys(importedByProject)) {
    const byId = new Map((allProjectRules[pid] || []).map(r => [r.id, r]));
    for (const r of importedByProject[pid]) byId.set(r.id, r);
    allProjectRules[pid] = [...byId.values()];
  }
  saveAllProjectAutoCommentRules(allProjectRules);
}

/**
 * Merge parsed app-data (projects + reviews + keyword categories + extraction
 * keywords) into localStorage: same-ID projects/categories/keywords are
 * overwritten, other existing ones are kept. Shared by importAppData() and
 * the settings-folder load flow.
 * @returns {number} number of projects merged in
 */
function mergeImportedData(data) {
  const importedProjects = sanitizeImportedProjects(data.projects);
  const importedReviews  = sanitizeReviewsData(data.reviews);
  const importedMemos    = sanitizeMemosData(data.memos);
  const importedLineComments = sanitizeLineCommentsData(data.lineComments);
  // Independent of projects, so merge it even when there's nothing else to import
  // (e.g. an auto-saved settings file written before any project was loaded).
  mergeImportedKeywordCategories(data.keywordCategories, data.projectKeywordCategories);
  mergeImportedExtractKeywords(data.extractKeywords, data.projectExtractKeywords);
  mergeImportedAutoCommentRules(data.autoCommentRules, data.projectAutoCommentRules);
  if (importedProjects.length === 0) return 0;

  const byId = new Map(loadProjects().map(p => [p.id, p]));
  for (const p of importedProjects) {
    // An imported project without a collectionId (a pre-v8 export, or a stale
    // settings file) keeps its local membership: dropping it would empty the
    // collection and reconcileCollections() would delete its shared state.
    const local = byId.get(p.id);
    if (!p.collectionId && local && local.collectionId) p.collectionId = local.collectionId;
    byId.set(p.id, p);
  }
  saveProjects([...byId.values()]);

  const collectionsById = new Map(loadCollections().map(c => [c.id, c]));
  for (const c of sanitizeCollections(data.collections)) collectionsById.set(c.id, c);
  saveCollections([...collectionsById.values()]);

  // The progress-badge cache holds hunk keys, not counts, so replacing
  // reviews needs no cache invalidation.
  const reviews = loadAllReviews();
  for (const pid of Object.keys(importedReviews)) {
    reviews[pid] = importedReviews[pid];
  }
  saveAllReviews(reviews);

  const memos = loadAllMemos();
  for (const pid of Object.keys(importedMemos)) {
    memos[pid] = importedMemos[pid];
  }
  saveAllMemos(memos);

  const lineComments = loadAllLineComments();
  for (const pid of Object.keys(importedLineComments)) {
    lineComments[pid] = importedLineComments[pid];
  }
  saveAllLineComments(lineComments);

  // Keep each project's applied log in step with its (replaced) line comments:
  // a project whose comments were replaced but has no imported log (e.g. a
  // pre-v7 export) gets its local log dropped, so its auto comments can be
  // re-added on the next load instead of being blocked by a stale log.
  const importedApplied = sanitizeAutoCommentAppliedData(data.autoCommentApplied);
  const applied = loadAllAutoCommentApplied();
  for (const pid of new Set([...Object.keys(importedLineComments), ...Object.keys(importedApplied)])) {
    if (importedApplied[pid]) applied[pid] = importedApplied[pid];
    else delete applied[pid];
  }
  saveAllAutoCommentApplied(applied);

  // Last, so it also cleans up / folds in the state written just above.
  reconcileCollections();

  return importedProjects.length;
}

/** Download all projects + review state as a single JSON file. */
function exportAppData() {
  const data = buildExportData();

  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');

  const a = document.createElement('a');
  a.href = url;
  a.download = `git-local-review-export_${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Restore projects + review state from a previously exported JSON file. */
async function importAppData(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch (err) {
    alert(`インポートファイルの読み込みに失敗しました:\n${err.message}`);
    return;
  }

  if (!data || typeof data !== 'object' || !Array.isArray(data.projects)) {
    alert('インポートファイルの形式が正しくありません。');
    return;
  }

  const importedCount = sanitizeImportedProjects(data.projects).length;
  if (importedCount === 0) {
    alert('インポート可能なプロジェクトが見つかりませんでした。');
    return;
  }

  if (!confirm(
    `${importedCount} 件のプロジェクトをインポートします。\n` +
    `同じIDの既存プロジェクトは上書きされます。よろしいですか？`
  )) return;

  mergeImportedData(data);
  renderProjectList();
  if (app.currentProjectId && app.parsedDiff) renderDiff();
  refreshMemoUI();
  alert(`${importedCount} 件のプロジェクトをインポートしました。`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Settings folder — save/auto-load projects + review state to/from a
// user-chosen local folder (File System Access API), independent of the
// manual export/import flow above.
// ─────────────────────────────────────────────────────────────────────────────

/** Refresh the settings-folder name shown in the sidebar. */
async function refreshSettingsFolderUI() {
  const nameEl = document.getElementById('settings-folder-name');
  if (!nameEl) return;
  const handle = await loadFolderHandle(FOLDER_KEY_SETTINGS);
  nameEl.textContent = handle ? handle.name : '未設定';
  nameEl.title = handle ? handle.name : '';

  // Proactively surface the auto-save warning (issue #60) as soon as we know
  // a folder is configured but write permission isn't currently granted —
  // rather than waiting for the next debounced auto-save attempt to notice.
  if (!handle) {
    hideAutoSaveWarning();
  } else if (!(await verifyHandlePermission(handle, 'readwrite', /* requestIfNeeded */ false))) {
    showAutoSaveWarning('保存先フォルダへの書き込みアクセスが許可されていません。自動保存は実行されません。');
  } else {
    hideAutoSaveWarning();
  }
}

/** mtime (ms) of the settings file in `dirHandle`, or null if it doesn't exist. */
async function statSettingsFile(dirHandle) {
  try {
    const fileHandle = await dirHandle.getFileHandle(SETTINGS_FILE_NAME);
    const file = await fileHandle.getFile();
    return file.lastModified;
  } catch (err) {
    if (err.name !== 'NotFoundError') console.error('Failed to stat settings file', err);
    return null;
  }
}

function showSettingsExternalUpdateNotice() {
  const el = document.getElementById('settings-external-update-notice');
  if (el) el.style.display = '';
}

function hideSettingsExternalUpdateNotice() {
  const el = document.getElementById('settings-external-update-notice');
  if (el) el.style.display = 'none';
}

/**
 * Top-of-page warning (issue #60), shown only while a settings auto-save
 * folder is configured AND auto-save isn't actually able to run — write
 * permission was lost/never granted, or the last write attempt threw. It is
 * deliberately separate from showSettingsExternalUpdateNotice() above: an
 * externally-changed file is an intentional, already-explained skip (its own
 * sidebar notice tells the user why and offers a "読み込む" action), not a
 * failure to warn about here.
 */
function showAutoSaveWarning(message) {
  const banner = document.getElementById('autosave-warning-banner');
  const textEl = document.getElementById('autosave-warning-text');
  if (textEl) {
    textEl.textContent = message;
    // The text is truncated with an ellipsis on narrow viewports/long
    // messages (e.g. an error's message text) — title exposes the full text.
    textEl.title = message;
  }
  if (banner) banner.style.display = 'flex';
  document.documentElement.style.setProperty('--autosave-warning-height', `${AUTOSAVE_WARNING_HEIGHT_PX}px`);
}

function hideAutoSaveWarning() {
  const banner = document.getElementById('autosave-warning-banner');
  if (banner) banner.style.display = 'none';
  document.documentElement.style.setProperty('--autosave-warning-height', '0px');
}

/** Write current projects + review state to the settings file in the chosen folder. */
async function saveSettingsToFolder() {
  const statusEl = document.getElementById('settings-save-status');
  const dirHandle = await loadFolderHandle(FOLDER_KEY_SETTINGS);
  if (!dirHandle) {
    alert('先に設定の保存先フォルダを選択してください。');
    return;
  }

  if (!(await verifyHandlePermission(dirHandle, 'readwrite'))) {
    alert('フォルダへの書き込みアクセスが許可されませんでした。');
    return;
  }

  // Same external-change guard autoSaveSettingsToFolder() applies, but as a
  // confirm() rather than a silent skip — a manual save is an explicit user
  // action, so the user gets the final call instead of always being blocked.
  // currentModified === null covers both "no file yet" and "deleted since we
  // last saw it", so the wording is phrased to cover update/create/delete
  // rather than assuming "updated".
  const currentModified = await statSettingsFile(dirHandle);
  if (currentModified !== settingsFileKnownModified) {
    const situation = currentModified === null
      ? '設定ファイルが見つかりません。他の環境で削除された可能性があります。'
      : settingsFileKnownModified === null
        ? '保存先フォルダに、このタブがまだ読み込んでいない設定ファイルがあります。他の環境で作成された可能性があります。'
        : '設定ファイルが他の環境で更新されています。';
    const proceed = confirm(
      `${situation}上書きすると、その内容が失われる可能性があります。\n` +
      '先に「読み込む」で最新の内容を反映してから保存し直すことをおすすめします。\n\n' +
      'このまま上書きしますか？'
    );
    if (!proceed) {
      showSettingsExternalUpdateNotice();
      return;
    }
  }

  clearTimeout(settingsAutoSaveTimer);
  settingsAutoSaveTimer = null;

  try {
    const fileHandle = await dirHandle.getFileHandle(SETTINGS_FILE_NAME, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(JSON.stringify(buildExportData(), null, 2));
    await writable.close();
    settingsFileKnownModified = (await fileHandle.getFile()).lastModified;
    hideSettingsExternalUpdateNotice();
    hideAutoSaveWarning();
    if (statusEl) {
      const stamp = new Date().toLocaleString('ja-JP', {
        year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
      });
      statusEl.textContent = `${stamp} に保存しました`;
    }
  } catch (err) {
    console.error('Failed to save settings to folder', err);
    alert(`設定の保存に失敗しました:\n${err.message}`);
    // A manual save uses the same write path auto-save does, so a failure
    // here means auto-save would fail the same way — keep the top warning
    // up as a persistent reminder beyond this one-time alert.
    showAutoSaveWarning(`保存先フォルダへの自動保存に失敗しています（${err.message}）。`);
  }
}

/**
 * Debounced auto-save, called after a project/review change. Waits for a
 * quiet moment so rapid successive changes (e.g. toggling many checkboxes)
 * result in one write rather than one per change.
 */
function scheduleSettingsAutoSave() {
  if (!supportsFileSystemAccess) return;
  clearTimeout(settingsAutoSaveTimer);
  settingsAutoSaveTimer = setTimeout(() => {
    settingsAutoSaveTimer = null;
    autoSaveSettingsToFolder();
  }, SETTINGS_AUTO_SAVE_DEBOUNCE_MS);
}

/**
 * Silently write current state to the settings folder, if one is configured
 * and write permission is already granted (no user gesture is available
 * here, so a not-yet-granted permission is skipped rather than prompted
 * for). Bails out without writing if the on-disk file changed since we last
 * saved/loaded it — that means another environment wrote data we haven't
 * seen yet, and auto-saving would silently discard it.
 */
async function autoSaveSettingsToFolder() {
  const dirHandle = await loadFolderHandle(FOLDER_KEY_SETTINGS);
  if (!dirHandle) return;
  if (!(await verifyHandlePermission(dirHandle, 'readwrite', /* requestIfNeeded */ false))) {
    showAutoSaveWarning('保存先フォルダへの書き込みアクセスが許可されていません。自動保存は実行されません。');
    return;
  }

  const currentModified = await statSettingsFile(dirHandle);
  if (currentModified !== settingsFileKnownModified) {
    // Covers both "changed since we last saw it" and "we've never seen it
    // but it now exists" (e.g. another environment created it first). This
    // is an intentional, already-explained skip (see showSettingsExternalUpdateNotice()),
    // not a failure, so it doesn't trigger showAutoSaveWarning().
    showSettingsExternalUpdateNotice();
    return;
  }

  try {
    const fileHandle = await dirHandle.getFileHandle(SETTINGS_FILE_NAME, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(JSON.stringify(buildExportData(), null, 2));
    await writable.close();
    settingsFileKnownModified = (await fileHandle.getFile()).lastModified;
    hideSettingsExternalUpdateNotice();
    hideAutoSaveWarning();
    const statusEl = document.getElementById('settings-save-status');
    if (statusEl) {
      const stamp = new Date().toLocaleString('ja-JP', {
        year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
      });
      statusEl.textContent = `${stamp} に自動保存しました`;
    }
  } catch (err) {
    console.error('Failed to auto-save settings to folder', err);
    showAutoSaveWarning(`保存先フォルダへの自動保存に失敗しています（${err.message}）。`);
  }
}

/**
 * Poll the settings file so edits made from another browser/environment are
 * noticed even without a local change triggering autoSaveSettingsToFolder.
 * Only ever shows a notice — never loads automatically.
 */
async function checkSettingsFileExternalChange() {
  const dirHandle = await loadFolderHandle(FOLDER_KEY_SETTINGS);
  if (!dirHandle) return;
  if (!(await verifyHandlePermission(dirHandle, 'read', /* requestIfNeeded */ false))) return;

  const currentModified = await statSettingsFile(dirHandle);
  if (currentModified === null) return;
  if (currentModified !== settingsFileKnownModified) {
    showSettingsExternalUpdateNotice();
  }
}

function startSettingsExternalChangeWatcher() {
  clearInterval(settingsExternalCheckTimer);
  settingsExternalCheckTimer = setInterval(checkSettingsFileExternalChange, SETTINGS_EXTERNAL_CHECK_INTERVAL_MS);
}

/**
 * If the chosen settings folder already contains a settings file, offer to
 * load it right away. Called right after the user picks a folder, so
 * permission is already granted from that same gesture.
 */
async function maybeLoadExistingSettingsAfterFolderPick(dirHandle) {
  let fileHandle;
  try {
    fileHandle = await dirHandle.getFileHandle(SETTINGS_FILE_NAME);
  } catch (err) {
    return; // no existing settings file in this folder
  }

  try {
    const file = await fileHandle.getFile();
    settingsFileKnownModified = file.lastModified;
    const data = JSON.parse(await file.text());
    if (!data || typeof data !== 'object' || !Array.isArray(data.projects)) return;
    if (!confirm('選択したフォルダに既存の設定ファイルが見つかりました。読み込みますか？')) return;
    const count = mergeImportedData(data);
    hideSettingsExternalUpdateNotice();
    renderProjectList();
    if (app.currentProjectId && app.parsedDiff) renderDiff();
    refreshMemoUI();
    alert(`${count} 件のプロジェクトを読み込みました。`);
  } catch (err) {
    console.error('Failed to load existing settings file', err);
  }
}

/**
 * On page load, silently restore projects + review state from the settings
 * folder if one is configured and permission is already granted (no user
 * gesture is available yet, so a not-yet-granted permission is skipped
 * rather than prompted for).
 */
async function loadSettingsFromFolderOnStartup() {
  const dirHandle = await loadFolderHandle(FOLDER_KEY_SETTINGS);
  if (!dirHandle) return;
  if (!(await verifyHandlePermission(dirHandle, 'read', /* requestIfNeeded */ false))) return;

  let fileHandle;
  try {
    fileHandle = await dirHandle.getFileHandle(SETTINGS_FILE_NAME);
  } catch (err) {
    if (err.name !== 'NotFoundError') console.error('Failed to look up settings file', err);
    return;
  }

  try {
    const file = await fileHandle.getFile();
    settingsFileKnownModified = file.lastModified;
    const data = JSON.parse(await file.text());
    if (!data || typeof data !== 'object' || !Array.isArray(data.projects)) return;
    mergeImportedData(data);
  } catch (err) {
    console.error('Failed to load settings from folder', err);
  }
}

/**
 * Manually reload from the settings folder on demand — the counterpart to
 * the auto-save skip/notice in autoSaveSettingsToFolder(): loading itself
 * always stays an explicit user action, never automatic.
 *
 * Also secures readwrite (not just read) access on this same user gesture
 * (issue #88) — the button is reachable even when write permission was
 * never granted or was reset (e.g. a fresh browser session), and without
 * this the read succeeds but auto-save keeps failing silently until some
 * other action happens to (re-)request write access. refreshSettingsFolderUI()
 * immediately syncs the auto-save warning banner/watchers to the
 * now-granted permission instead of waiting for the next debounced
 * auto-save attempt to notice.
 */
async function reloadSettingsFromFolderManually() {
  const dirHandle = await loadFolderHandle(FOLDER_KEY_SETTINGS);
  if (!dirHandle) {
    // Reachable from the always-visible "設定読込" button (issue #83),
    // unlike the external-update notice's "読み込む" button, which only ever
    // shows once a folder (and a file in it) is already known to exist.
    alert('先に設定の保存先フォルダを選択してください。');
    return;
  }

  if (!(await verifyHandlePermission(dirHandle, 'readwrite'))) {
    alert('フォルダへの読み取り・書き込みアクセスが許可されませんでした。');
    return;
  }
  await refreshSettingsFolderUI();

  let fileHandle;
  try {
    fileHandle = await dirHandle.getFileHandle(SETTINGS_FILE_NAME);
  } catch (err) {
    // Nothing to load; reset the baseline so a future auto-save is free to
    // create the file, instead of being skipped forever as "conflicting".
    settingsFileKnownModified = null;
    hideSettingsExternalUpdateNotice();
    alert('保存先フォルダに設定ファイルが見つかりませんでした。');
    return;
  }

  try {
    const file = await fileHandle.getFile();
    const data = JSON.parse(await file.text());
    if (!data || typeof data !== 'object' || !Array.isArray(data.projects)) {
      alert('設定ファイルの形式が正しくありません。');
      return;
    }
    const count = mergeImportedData(data);
    settingsFileKnownModified = file.lastModified;
    hideSettingsExternalUpdateNotice();
    renderProjectList();
    if (app.currentProjectId && app.parsedDiff) renderDiff();
    refreshMemoUI();
    alert(`${count} 件のプロジェクトを読み込みました。`);
  } catch (err) {
    console.error('Failed to reload settings from folder', err);
    alert(`設定の読み込みに失敗しました:\n${err.message}`);
  }
}
