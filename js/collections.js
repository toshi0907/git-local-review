'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Project ID generation  →  "filename__proj_YYYYMMDD_NNN"
// ─────────────────────────────────────────────────────────────────────────────
function generateProjectId(fileName) {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const prefix = `${fileName}__proj_${date}_`;
  const count = loadProjects().filter(p => p.id.startsWith(prefix)).length;
  return prefix + String(count + 1).padStart(3, '0');
}

function projectsByFileName(fileName) {
  return loadProjects().filter(p => p.fileName === fileName);
}

// ─────────────────────────────────────────────────────────────────────────────
// Collections — data layer
// ─────────────────────────────────────────────────────────────────────────────
// A collection groups projects (e.g. the `git log -p` and `git diff` output
// of the same change) so they share review state. Each project belongs to at
// most one collection (its `collectionId`). While it does, its reviews, line
// comments, memos and auto-comment log are read/written under the
// collection's ID instead of its own — the "state owner" ID, see
// getStateOwnerId() — in the very same stores (SK_REVIEWS etc.), so a hunk
// with the same file path + hash is shared by every member. Collection-scoped
// highlight/extraction/auto-comment settings likewise live in the per-project
// stores (SK_PROJECT_KEYWORDS etc.) keyed by the collection ID. Collection
// IDs ("coll_…") never contain "__proj_", so they can't collide with a
// project ID. A collection left with no members is deleted automatically.
// ─────────────────────────────────────────────────────────────────────────────
const COLLECTION_ID_RE = /^coll_[0-9a-z_]+$/;

function sanitizeCollections(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const result = [];
  for (const c of raw) {
    if (!c || typeof c !== 'object' || typeof c.id !== 'string' || !COLLECTION_ID_RE.test(c.id) || seen.has(c.id)) continue;
    seen.add(c.id);
    const name = typeof c.name === 'string' && c.name.trim() ? c.name.trim() : 'コレクション';
    const createdAt = typeof c.createdAt === 'number' ? c.createdAt : Date.now();
    result.push({ id: c.id, name, createdAt });
  }
  return result;
}

function loadCollections() {
  try {
    return sanitizeCollections(JSON.parse(localStorage.getItem(SK_COLLECTIONS) || '[]'));
  } catch (e) {
    console.error('Failed to parse collections from localStorage:', e);
    return [];
  }
}

function saveCollections(collections) {
  try {
    localStorage.setItem(SK_COLLECTIONS, JSON.stringify(collections));
  } catch (e) {
    console.error('Failed to save collections to localStorage:', e);
    alert('コレクションの保存に失敗しました。ストレージの容量が不足している可能性があります。');
  }
}

function generateCollectionId() {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return `coll_${date}_${Math.random().toString(36).slice(2, 10)}`;
}

/** The collection a project belongs to, or null (also null when its collectionId points at a missing collection). */
function getProjectCollectionId(projectId, projects = loadProjects(), collections = loadCollections()) {
  const proj = projects.find(p => p.id === projectId);
  if (!proj || !proj.collectionId) return null;
  return collections.some(c => c.id === proj.collectionId) ? proj.collectionId : null;
}

/** ID that a project's reviews/line comments/memos/auto-comment log are stored under: its collection's, else its own. */
function getStateOwnerId(projectId) {
  if (!projectId) return null;
  return getProjectCollectionId(projectId) || projectId;
}

/** getStateOwnerId() for the active project (null when none is active). */
function currentStateOwnerId() {
  return getStateOwnerId(app.currentProjectId);
}

/** The active project's collection ID, or null. */
function getCurrentCollectionId() {
  return app.currentProjectId ? getProjectCollectionId(app.currentProjectId) : null;
}

/** IDs of every project in a collection. */
function getCollectionMemberIds(collectionId, projects = loadProjects()) {
  return projects.filter(p => p.collectionId === collectionId).map(p => p.id);
}

/**
 * Owner ID of a non-global settings scope: the active project ('project') or
 * its collection ('collection'). null when that scope isn't available now
 * (no active project / the project isn't in a collection).
 */
function scopeOwnerId(scope) {
  if (scope === 'project') return app.currentProjectId;
  if (scope === 'collection') return getCurrentCollectionId();
  return null;
}

/** Non-global settings scopes, in the order their entries follow the global ones. */
const OWNED_SETTING_SCOPES = ['collection', 'project'];

/** Appends the 全体/コレクション/プロジェクト options to a settings scope <select>; unavailable scopes are disabled (コレクション is also hidden). */
function appendSettingScopeOptions(select, labels = { global: '全体', collection: 'コレクション', project: 'プロジェクト' }) {
  for (const scope of ['global', ...OWNED_SETTING_SCOPES]) {
    const option = document.createElement('option');
    option.value = scope;
    option.textContent = labels[scope];
    if (scope !== 'global' && !scopeOwnerId(scope)) {
      option.disabled = true;
      if (scope === 'collection') option.hidden = true;
    }
    select.appendChild(option);
  }
}
