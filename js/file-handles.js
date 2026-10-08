'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// File System Access API — remembered file handles (IndexedDB)
//
// FileSystemFileHandle objects are structured-cloneable but not JSON-
// serializable, so they can't live in localStorage alongside the rest of
// the app state. IndexedDB is used instead, keyed by project ID. When a
// handle is available for a project, the "reload" button can re-read the
// file straight from disk instead of asking the user to pick it again.
// ─────────────────────────────────────────────────────────────────────────────
const supportsFileSystemAccess = typeof window.showOpenFilePicker === 'function';
const HANDLE_DB_NAME = 'gitLocalReview_handles';
const HANDLE_STORE   = 'fileHandles';
const FOLDER_STORE   = 'folderHandles';

/** IDs of projects that currently have a stored file handle (kept in sync via refreshHandleIndex). */
let projectIdsWithHandles = new Set();

/**
 * UI-only state for the compact project list (issue #83): IDs of projects
 * whose collapsed details (ID, encoding, reset/delete) are expanded, and IDs
 * flagged by checkProjectFileUpdates() as changed on disk since we last read
 * them. Neither is persisted — both simply reset to empty on page load.
 */
let expandedProjectIds = new Set();
let projectsWithExternalFileUpdate = new Set();
/** Collection groups collapsed in the sidebar (UI-only, not persisted). */
let collapsedCollectionIds = new Set();
/** Sidebar multi-select mode for building collections, and the IDs selected in it (UI-only, not persisted). */
let projectSelectMode = false;
let selectedProjectIds = new Set();

function openHandleDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(HANDLE_DB_NAME, 2);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(HANDLE_STORE)) {
        req.result.createObjectStore(HANDLE_STORE);
      }
      if (!req.result.objectStoreNames.contains(FOLDER_STORE)) {
        req.result.createObjectStore(FOLDER_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveFileHandle(projectId, handle) {
  try {
    const db = await openHandleDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(HANDLE_STORE, 'readwrite');
      tx.objectStore(HANDLE_STORE).put(handle, projectId);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    projectIdsWithHandles.add(projectId);
  } catch (e) {
    console.error('Failed to save file handle for', projectId, e);
  }
}

async function loadFileHandle(projectId) {
  try {
    const db = await openHandleDB();
    return await new Promise((resolve, reject) => {
      const req = db.transaction(HANDLE_STORE, 'readonly').objectStore(HANDLE_STORE).get(projectId);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch (e) {
    console.error('Failed to load file handle for', projectId, e);
    return null;
  }
}

async function deleteFileHandleRecord(projectId) {
  try {
    const db = await openHandleDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(HANDLE_STORE, 'readwrite');
      tx.objectStore(HANDLE_STORE).delete(projectId);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {
    console.error('Failed to delete file handle for', projectId, e);
  } finally {
    projectIdsWithHandles.delete(projectId);
  }
}

/** Repopulate projectIdsWithHandles from IndexedDB (called once at init). */
async function refreshHandleIndex() {
  if (!supportsFileSystemAccess) return;
  try {
    const db = await openHandleDB();
    const keys = await new Promise((resolve, reject) => {
      const req = db.transaction(HANDLE_STORE, 'readonly').objectStore(HANDLE_STORE).getAllKeys();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    projectIdsWithHandles = new Set(keys);
  } catch (e) {
    console.error('Failed to refresh file handle index', e);
  }
}

/**
 * Record the on-disk mtime of a project's file right after it was read (on
 * create, update, or manual reload — anywhere createNewProject()/
 * updateExistingProject() are given a fileHandle) as the baseline for
 * checkProjectFileUpdates() below. Persisted on the project record itself
 * (proj.fileLastModified) rather than kept only in memory, so a page reload
 * doesn't lose the baseline and falsely flag an unchanged file as updated.
 */
async function recordProjectFileBaseline(projectId, fileHandle) {
  let lastModified;
  try {
    lastModified = (await fileHandle.getFile()).lastModified;
  } catch (e) {
    return;
  }
  const projects = loadProjects();
  const proj = projects.find(p => p.id === projectId);
  if (!proj) return;
  proj.fileLastModified = lastModified;
  saveProjects(projects);
  projectsWithExternalFileUpdate.delete(projectId);
}

/**
 * Poll every project with a remembered file handle for changes made outside
 * this tab (issue #83) — e.g. re-running `git diff` and overwriting the same
 * file. Only ever flags the project (🆕 badge + highlighted reload button in
 * renderProjectList()); reloading the content stays an explicit user action
 * via the existing "🔃 再読み込み" button. Never requests permission — a
 * background timer has no user gesture to justify a prompt — so a project
 * whose read permission isn't currently granted is silently skipped until
 * the user next interacts with it.
 */
async function checkProjectFileUpdates() {
  if (projectIdsWithHandles.size === 0) return;
  const projects = loadProjects();
  let changed = false;
  for (const projectId of projectIdsWithHandles) {
    if (projectsWithExternalFileUpdate.has(projectId)) continue;
    const proj = projects.find(p => p.id === projectId);
    if (!proj || typeof proj.fileLastModified !== 'number') continue;

    let handle;
    try {
      handle = await loadFileHandle(projectId);
    } catch (e) {
      continue;
    }
    if (!handle) continue;

    let permission;
    try {
      permission = await handle.queryPermission({ mode: 'read' });
    } catch (e) {
      continue;
    }
    if (permission !== 'granted') continue;

    let file;
    try {
      file = await handle.getFile();
    } catch (e) {
      continue; // likely moved/deleted; reloadProjectFile() surfaces that when the user acts
    }

    // Re-read the baseline instead of reusing `proj` from before the awaits
    // above: a manual reload of this exact project (recordProjectFileBaseline())
    // could have landed while we were waiting on the handle/permission/file,
    // and comparing against the now-stale `proj.fileLastModified` would
    // re-flag a file that was actually already brought up to date.
    const currentProj = loadProjects().find(p => p.id === projectId);
    if (!currentProj || typeof currentProj.fileLastModified !== 'number') continue;
    if (file.lastModified !== currentProj.fileLastModified) {
      projectsWithExternalFileUpdate.add(projectId);
      changed = true;
    }
  }
  if (changed) renderProjectList();
}

function startProjectFileUpdateWatcher() {
  clearInterval(projectFileCheckTimer);
  projectFileCheckTimer = setInterval(checkProjectFileUpdates, PROJECT_FILE_CHECK_INTERVAL_MS);
}

// ─────────────────────────────────────────────────────────────────────────────
// File System Access API — remembered directory handles (IndexedDB)
//
// Used for two independent features, each keyed by a fixed string in the
// same object store: a default folder to start the diff-file picker in,
// and a folder to save/auto-load the app's settings (projects + review
// state) to/from disk, outside of the manual export/import flow.
// ─────────────────────────────────────────────────────────────────────────────
const FOLDER_KEY_OPEN     = 'defaultOpenFolder';
const FOLDER_KEY_SETTINGS = 'settingsFolder';
const SETTINGS_FILE_NAME  = 'git-local-review-settings.json';

/** Quiet period after a project/review change before auto-saving to the settings folder. */
const SETTINGS_AUTO_SAVE_DEBOUNCE_MS = 1500;
/** How often to poll the settings file for edits made from another environment. */
const SETTINGS_EXTERNAL_CHECK_INTERVAL_MS = 60000;
/** Height (px) the top-of-page auto-save warning banner occupies when visible; kept in sync with .autosave-warning-banner's CSS height. */
const AUTOSAVE_WARNING_HEIGHT_PX = 32;

/**
 * mtime (ms) of the settings file as last seen by this tab, because we
 * wrote it ourselves or read/inspected it. Compared against the file's
 * current mtime to detect edits made from another browser/environment.
 */
let settingsFileKnownModified = null;
let settingsAutoSaveTimer = null;
let settingsExternalCheckTimer = null;

/** How often to poll each project's remembered file handle for external changes (issue #83). */
const PROJECT_FILE_CHECK_INTERVAL_MS = 60000;
let projectFileCheckTimer = null;

async function saveFolderHandle(key, handle) {
  try {
    const db = await openHandleDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(FOLDER_STORE, 'readwrite');
      tx.objectStore(FOLDER_STORE).put(handle, key);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {
    console.error('Failed to save folder handle for', key, e);
  }
}

async function loadFolderHandle(key) {
  try {
    const db = await openHandleDB();
    return await new Promise((resolve, reject) => {
      const req = db.transaction(FOLDER_STORE, 'readonly').objectStore(FOLDER_STORE).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch (e) {
    console.error('Failed to load folder handle for', key, e);
    return null;
  }
}

async function deleteFolderHandleRecord(key) {
  try {
    const db = await openHandleDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(FOLDER_STORE, 'readwrite');
      tx.objectStore(FOLDER_STORE).delete(key);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {
    console.error('Failed to delete folder handle for', key, e);
  }
}

/**
 * Check (and, if needed, request) permission on a stored handle. Requesting
 * permission requires a user gesture, so callers running outside of one
 * (e.g. page-load auto-restore) should pass requestIfNeeded=false and treat
 * a non-granted result as "skip silently".
 */
async function verifyHandlePermission(handle, mode, requestIfNeeded = true) {
  const opts = { mode };
  try {
    if ((await handle.queryPermission(opts)) === 'granted') return true;
    if (requestIfNeeded && (await handle.requestPermission(opts)) === 'granted') return true;
  } catch (e) {
    console.error('Permission check failed', e);
  }
  return false;
}

/** Refresh the default-open-folder name shown in the sidebar. */
async function refreshOpenFolderUI() {
  const nameEl = document.getElementById('open-folder-name');
  if (!nameEl) return;
  const handle = await loadFolderHandle(FOLDER_KEY_OPEN);
  nameEl.textContent = handle ? handle.name : '未設定';
  nameEl.title = handle ? handle.name : '';
}
