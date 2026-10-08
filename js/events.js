'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Event listeners
// ─────────────────────────────────────────────────────────────────────────────
document.getElementById('load-btn').addEventListener('click', async () => {
  const encodingPref = document.getElementById('encoding-select').value;

  if (!supportsFileSystemAccess) {
    document.getElementById('file-input').click();
    return;
  }

  const pickerOptions = {
    types: [{
      description: 'Diff files',
      accept: { 'text/plain': ['.diff', '.patch', '.txt'] },
    }],
    excludeAcceptAllOption: false,
    multiple: true,
  };

  const openFolderHandle = await loadFolderHandle(FOLDER_KEY_OPEN);
  if (openFolderHandle) pickerOptions.startIn = openFolderHandle;

  let handles;
  try {
    handles = await window.showOpenFilePicker(pickerOptions);
  } catch (err) {
    if (err.name === 'AbortError') return;
    if (openFolderHandle) {
      // The remembered default folder may be stale (moved/deleted/revoked
      // permission); retry once without it rather than blocking file loading.
      delete pickerOptions.startIn;
      try {
        handles = await window.showOpenFilePicker(pickerOptions);
      } catch (err2) {
        if (err2.name !== 'AbortError') console.error('showOpenFilePicker failed', err2);
        return;
      }
    } else {
      console.error('showOpenFilePicker failed', err);
      return;
    }
  }

  const files = await Promise.all(handles.map(h => h.getFile()));
  await loadDiffFiles(files, encodingPref, handles);
});

document.getElementById('open-folder-set-btn').addEventListener('click', async () => {
  try {
    const handle = await window.showDirectoryPicker({ id: 'gitLocalReviewOpenFolder' });
    await saveFolderHandle(FOLDER_KEY_OPEN, handle);
    await refreshOpenFolderUI();
  } catch (err) {
    if (err.name !== 'AbortError') console.error('showDirectoryPicker failed', err);
  }
});

document.getElementById('open-folder-clear-btn').addEventListener('click', async () => {
  await deleteFolderHandleRecord(FOLDER_KEY_OPEN);
  await refreshOpenFolderUI();
});

document.getElementById('settings-folder-set-btn').addEventListener('click', async () => {
  try {
    const handle = await window.showDirectoryPicker({ id: 'gitLocalReviewSettingsFolder', mode: 'readwrite' });
    settingsFileKnownModified = null; // new folder: drop any baseline from the previous one
    hideSettingsExternalUpdateNotice();
    await saveFolderHandle(FOLDER_KEY_SETTINGS, handle);
    await refreshSettingsFolderUI();
    await maybeLoadExistingSettingsAfterFolderPick(handle);
  } catch (err) {
    if (err.name !== 'AbortError') console.error('showDirectoryPicker failed', err);
  }
});

document.getElementById('settings-folder-clear-btn').addEventListener('click', async () => {
  await deleteFolderHandleRecord(FOLDER_KEY_SETTINGS);
  await refreshSettingsFolderUI();
  clearTimeout(settingsAutoSaveTimer);
  settingsAutoSaveTimer = null;
  settingsFileKnownModified = null;
  hideSettingsExternalUpdateNotice();
  const statusEl = document.getElementById('settings-save-status');
  if (statusEl) statusEl.textContent = '';
});

document.getElementById('settings-save-btn').addEventListener('click', saveSettingsToFolder);
document.getElementById('settings-load-btn').addEventListener('click', reloadSettingsFromFolderManually);
document.getElementById('settings-reload-btn').addEventListener('click', reloadSettingsFromFolderManually);

document.getElementById('file-input').addEventListener('change', async (e) => {
  const files = Array.from(e.target.files);
  if (files.length === 0) return;
  const encodingPref = document.getElementById('encoding-select').value;
  e.target.value = ''; // allow re-selecting the same file(s)
  await loadDiffFiles(files, encodingPref);
});

document.getElementById('view-mode-unified').addEventListener('click', () => setViewMode('unified'));
document.getElementById('view-mode-split').addEventListener('click', () => setViewMode('split'));
document.getElementById('word-diff-checkbox').addEventListener('change', e => setWordDiff(e.target.checked));

document.getElementById('export-btn').addEventListener('click', exportAppData);

document.getElementById('import-btn').addEventListener('click', () => {
  document.getElementById('import-input').click();
});

document.getElementById('import-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  e.target.value = ''; // allow re-selecting the same file
  await importAppData(file);
});

document.getElementById('project-sort-select').addEventListener('change', (e) => {
  saveProjectSort(e.target.value);
  renderProjectList();
});

// Project selection mode / collection actions (see "Sidebar project selection mode").
document.getElementById('project-select-mode-btn').addEventListener('click', () => setProjectSelectMode(!projectSelectMode));
document.getElementById('collection-create-btn').addEventListener('click', () => {
  if (createCollectionFromProjects(getSelectedProjectIdsInOrder())) setProjectSelectMode(false);
});
document.getElementById('collection-add-select').addEventListener('change', (e) => {
  const collectionId = e.target.value;
  if (!collectionId) return;
  if (addProjectsToCollection(getSelectedProjectIdsInOrder(), collectionId)) setProjectSelectMode(false);
  else e.target.value = '';
});
document.getElementById('collection-remove-btn').addEventListener('click', () => {
  if (removeProjectsFromCollections(getSelectedProjectIdsInOrder())) setProjectSelectMode(false);
});

document.getElementById('modal-btn-new').addEventListener('click', () => {
  const fn      = modalFileName;
  const parsed  = modalParsedDiff;
  const rawText = modalRawText;
  const handle  = modalFileHandle;
  const encPref = modalEncoding;
  const encResolved = modalResolvedEncoding;
  const encMessageResolved = modalResolvedMessageEncoding;
  hideModal();
  createNewProject(fn, parsed, rawText, handle, encPref, encResolved, encMessageResolved);
  resolvePendingModal();
});

document.getElementById('modal-btn-update').addEventListener('click', () => {
  if (!modalSelectedId) { alert('更新するプロジェクトを選択してください。'); return; }
  const id      = modalSelectedId;
  const parsed  = modalParsedDiff;
  const rawText = modalRawText;
  const handle  = modalFileHandle;
  const encPref = modalEncoding;
  const encResolved = modalResolvedEncoding;
  const encMessageResolved = modalResolvedMessageEncoding;
  hideModal();
  updateExistingProject(id, parsed, rawText, handle, encPref, encResolved, encMessageResolved);
  resolvePendingModal();
});

// Close modal by clicking the backdrop
const modalOverlay = document.getElementById('modal-overlay');
modalOverlay.addEventListener('click', (e) => {
  if (e.target === modalOverlay) {
    hideModal();
    resolvePendingModal();
  }
});

// Settings modal (issue #61): consolidates the default-open-folder,
// settings-auto-save-folder, and encoding controls (moved here from the
// sidebar) behind a single dialog. The keyword-category controls it also
// used to hold moved out into their own modal below (issue #93). Independent
// of the conflict modal above — its own overlay/backdrop-click/Escape handling.
const settingsModalOverlay = document.getElementById('settings-modal-overlay');

function isSettingsModalOpen() {
  return settingsModalOverlay.classList.contains('active');
}

function openSettingsModal() {
  settingsModalOverlay.classList.add('active');
  document.getElementById('settings-modal-open-btn').setAttribute('aria-expanded', 'true');
  // Move focus into the dialog (matching the conflict modal's behavior of
  // focusing its primary button) so keyboard/screen-reader users land inside
  // it rather than on a now-hidden-behind-the-overlay trigger button.
  document.getElementById('settings-modal-close').focus();
}

function closeSettingsModal() {
  settingsModalOverlay.classList.remove('active');
  const openBtn = document.getElementById('settings-modal-open-btn');
  openBtn.setAttribute('aria-expanded', 'false');
  // Return focus to the trigger button so it doesn't stay stranded on a
  // now-hidden element inside the modal (e.g. after Escape or a backdrop click).
  if (settingsModalOverlay.contains(document.activeElement)) openBtn.focus();
}

document.getElementById('settings-modal-open-btn').addEventListener('click', openSettingsModal);
document.getElementById('settings-modal-close').addEventListener('click', closeSettingsModal);
settingsModalOverlay.addEventListener('click', (e) => {
  if (e.target === settingsModalOverlay) closeSettingsModal();
});

// Keyword highlight modal (issue #93): the keyword-category controls used to
// live inside the settings modal above; they now get their own top-bar
// button and dialog, mirroring the keyword line extraction modal further
// below. Independent overlay/backdrop-click/Escape handling.
const keywordModalOverlay = document.getElementById('keyword-modal-overlay');

function isKeywordModalOpen() {
  return keywordModalOverlay.classList.contains('active');
}

function openKeywordModal() {
  keywordModalOverlay.classList.add('active');
  document.getElementById('keyword-modal-open-btn').setAttribute('aria-expanded', 'true');
  document.getElementById('keyword-modal-close').focus();
}

function closeKeywordModal() {
  keywordModalOverlay.classList.remove('active');
  const openBtn = document.getElementById('keyword-modal-open-btn');
  openBtn.setAttribute('aria-expanded', 'false');
  if (keywordModalOverlay.contains(document.activeElement)) openBtn.focus();
}

document.getElementById('keyword-modal-open-btn').addEventListener('click', openKeywordModal);
document.getElementById('keyword-modal-close').addEventListener('click', closeKeywordModal);
keywordModalOverlay.addEventListener('click', (e) => {
  if (e.target === keywordModalOverlay) closeKeywordModal();
});

// Review memo panel: toggle button, close button, backdrop click, and the
// add-memo form.
document.getElementById('memo-toggle-btn').addEventListener('click', () => {
  if (isMemoPanelOpen()) closeMemoPanel(); else openMemoPanel();
});
document.getElementById('memo-panel-close').addEventListener('click', closeMemoPanel);
document.getElementById('memo-panel-overlay').addEventListener('click', closeMemoPanel);

// Bulk memo registration (issue #104): toggling "一括登録" reveals a
// delimiter input; submitting the form then splits #memo-input's text into
// one memo per segment (splitBulkMemoText()) instead of adding it as a
// single memo. The delimiter itself persists across sessions (SK_MEMO_BULK_DELIMITER).
const memoBulkToggleBtn      = document.getElementById('memo-bulk-toggle-btn');
const memoBulkOptions        = document.getElementById('memo-bulk-options');
const memoBulkDelimiterInput = document.getElementById('memo-bulk-delimiter');
const memoAddBtn             = document.getElementById('memo-add-btn');
let memoBulkModeOn = false;

function setMemoBulkMode(on) {
  memoBulkModeOn = on;
  memoBulkToggleBtn.setAttribute('aria-pressed', String(on));
  memoBulkOptions.hidden = !on;
  memoAddBtn.textContent = on ? '一括登録' : '追加';
  if (on) memoBulkDelimiterInput.value = loadMemoBulkDelimiter();
}

memoBulkToggleBtn.addEventListener('click', () => setMemoBulkMode(!memoBulkModeOn));

document.getElementById('memo-add-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = document.getElementById('memo-input');
  if (memoBulkModeOn) {
    const delimiter = memoBulkDelimiterInput.value.trim() || DEFAULT_MEMO_BULK_DELIMITER;
    saveMemoBulkDelimiter(delimiter);
    addMemos(splitBulkMemoText(input.value, delimiter));
  } else {
    addMemo(input.value);
  }
  input.value = '';
  input.focus();
});
// Ctrl+Enter (Cmd+Enter on macOS) in the memo textarea submits the add-memo
// form without requiring a mouse click on the "追加" button.
document.getElementById('memo-input').addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    const form = document.getElementById('memo-add-form');
    if (typeof form.requestSubmit === 'function') form.requestSubmit();
    else form.dispatchEvent(new Event('submit', { cancelable: true }));
  }
});
initMemoPanelResizer();
initSidebarResizer();
// Keep the panel's content in sync when the viewport crosses the
// WIDE_LAYOUT_MEDIA_QUERY breakpoint (e.g. the memo list wasn't rendered
// while narrow and closed, but must be populated once it docks open).
WIDE_LAYOUT_MEDIA_QUERY.addEventListener('change', refreshMemoUI);

// Close modal with ESC key for keyboard accessibility, and provide keyboard
// shortcuts for hunk navigation: j/k move focus between hunks, Space cycles
// the focused hunk's review status, 1/2/3 set it directly (see
// REVIEW_STATUSES for the key-to-status mapping), and c opens a line-comment
// form on the focused hunk (see openLineCommentComposerForFocusedHunk).
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && modalOverlay.classList.contains('active')) {
    hideModal();
    resolvePendingModal();
    return;
  }

  if (e.key === 'Escape' && isSettingsModalOpen()) {
    closeSettingsModal();
    return;
  }

  if (e.key === 'Escape' && isKeywordModalOpen()) {
    closeKeywordModal();
    return;
  }

  if (e.key === 'Escape' && isExtractModalOpen()) {
    closeExtractModal();
    return;
  }

  if (e.key === 'Escape' && isAutoCommentModalOpen()) {
    closeAutoCommentModal();
    return;
  }

  if (e.key === 'Escape' && !WIDE_LAYOUT_MEDIA_QUERY.matches && isMemoPanelOpen()) {
    closeMemoPanel();
    return;
  }

  // Don't hijack keys while the user is typing into a form field, while the
  // file-conflict, settings, keyword-highlight, or extraction modal is open,
  // or while focus is inside the memo panel (its close/delete buttons can
  // hold focus without being an INPUT, which would otherwise let j/k/Space
  // leak through to hunk navigation behind it). Checking focus rather than
  // isMemoPanelOpen() matters once the panel is permanently docked open on
  // wide viewports — j/k/Space must still work for hunk navigation whenever
  // focus isn't actually inside the panel.
  const tag = e.target && e.target.tagName;
  const isTyping = tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || (e.target && e.target.isContentEditable);
  const focusInMemoPanel = document.getElementById('memo-panel').contains(e.target);
  if (isTyping || modalOverlay.classList.contains('active') || isSettingsModalOpen() || isKeywordModalOpen() || isExtractModalOpen() || isAutoCommentModalOpen() || focusInMemoPanel) return;

  if (e.key === 'j') {
    e.preventDefault();
    moveHunkFocus(1);
  } else if (e.key === 'k') {
    e.preventDefault();
    moveHunkFocus(-1);
  } else if (e.key === ' ' || e.code === 'Space') {
    e.preventDefault();
    if (e.repeat) return; // ignore key-repeat from holding Space down
    cycleFocusedHunkStatus();
  } else if (e.key === 'c' && !e.ctrlKey && !e.metaKey && !e.altKey) {
    // Plain `c` only — Ctrl/Cmd+C must keep copying selected diff text.
    e.preventDefault();
    if (e.repeat) return;
    openLineCommentComposerForFocusedHunk();
  } else {
    const statusForKey = REVIEW_STATUSES.find(s => s.key === e.key);
    if (statusForKey) {
      e.preventDefault();
      if (e.repeat) return;
      setFocusedHunkStatus(statusForKey.value);
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Drag & drop file upload — dropping one or more diff files anywhere on the
// window loads them the same way as picking them via "📂 Diffファイルを開く"
// (including the same-filename conflict modal and batch-upload summary).
// ─────────────────────────────────────────────────────────────────────────────
function dragEventHasFiles(e) {
  return !!(e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files'));
}

/**
 * Extract File objects from a drop event's DataTransfer, and — where the
 * browser supports it (Chromium) — the matching FileSystemFileHandles too,
 * so dropped files get the same "🔃 再読み込み" support as files opened via
 * the file picker. Falls back to plain File objects (no handles) elsewhere.
 */
async function filesFromDataTransfer(dataTransfer) {
  const items = dataTransfer.items;
  if (supportsFileSystemAccess && items && items.length && typeof items[0].getAsFileSystemHandle === 'function') {
    const fileItems = Array.from(items).filter(item => item.kind === 'file');
    const files = [];
    const handles = [];
    for (const item of fileItems) {
      try {
        const handle = await item.getAsFileSystemHandle();
        if (!handle || handle.kind !== 'file') continue; // skip dropped folders
        handles.push(handle);
        files.push(await handle.getFile());
      } catch (err) {
        console.error('getAsFileSystemHandle failed for dropped item', err);
      }
    }
    if (files.length > 0) return { files, handles };
  }
  return { files: Array.from(dataTransfer.files), handles: null };
}

let dragCounter = 0;
const dropOverlay = document.getElementById('drop-overlay');

window.addEventListener('dragenter', (e) => {
  if (!dragEventHasFiles(e)) return;
  e.preventDefault();
  dragCounter++;
  dropOverlay.classList.add('active');
});

window.addEventListener('dragover', (e) => {
  // preventDefault() is required here too — without it the browser rejects the drop.
  if (dragEventHasFiles(e)) e.preventDefault();
});

window.addEventListener('dragleave', (e) => {
  if (!dragEventHasFiles(e)) return;
  dragCounter = Math.max(0, dragCounter - 1);
  if (dragCounter === 0) dropOverlay.classList.remove('active');
});

window.addEventListener('drop', async (e) => {
  if (!dragEventHasFiles(e)) return;
  e.preventDefault(); // without this the browser navigates to the dropped file
  dragCounter = 0;
  dropOverlay.classList.remove('active');

  // Avoid stacking a new load on top of an already-open conflict, settings, keyword-highlight, or extraction modal.
  if (modalOverlay.classList.contains('active') || isSettingsModalOpen() || isKeywordModalOpen() || isExtractModalOpen() || isAutoCommentModalOpen()) return;

  const { files, handles } = await filesFromDataTransfer(e.dataTransfer);
  if (files.length === 0) return;

  const encodingPref = document.getElementById('encoding-select').value;
  await loadDiffFiles(files, encodingPref, handles);
});
