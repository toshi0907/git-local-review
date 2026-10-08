'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Storage keys
// ─────────────────────────────────────────────────────────────────────────────
const SK_PROJECTS         = 'gitLocalReview_projects';
const SK_REVIEWS          = 'gitLocalReview_reviews';
const SK_MEMOS            = 'gitLocalReview_memos';
const SK_CURRENT          = 'gitLocalReview_currentProject';
const SK_FILES            = 'gitLocalReview_files';
const SK_VIEW_MODE        = 'gitLocalReview_viewMode';
/** Word-level (git --word-diff-style) highlighting toggle, independent of SK_VIEW_MODE. */
const SK_WORD_DIFF        = 'gitLocalReview_wordDiff';
const SK_REVIEW_FILTER    = 'gitLocalReview_reviewFilter';
/** Pre-#51 boolean-only "未レビューのみ表示" toggle, read once for migration into SK_REVIEW_FILTER. */
const SK_UNREVIEWED_ONLY_LEGACY = 'gitLocalReview_unreviewedOnly';
const SK_PROJECT_SORT     = 'gitLocalReview_projectSort';
const SK_KEYWORDS         = 'gitLocalReview_keywords';
/** Per-project keyword categories (issue #68): { [projectId]: category[] }, same category shape as SK_KEYWORDS. */
const SK_PROJECT_KEYWORDS = 'gitLocalReview_projectKeywords';
/** Global keyword-line-extraction keywords (issue #79): a separate feature from SK_KEYWORDS' highlighting. */
const SK_EXTRACT_KEYWORDS = 'gitLocalReview_extractKeywords';
/** Per-project keyword-line-extraction keywords (issue #79): { [projectId]: entry[] }, same entry shape as SK_EXTRACT_KEYWORDS. */
const SK_PROJECT_EXTRACT_KEYWORDS = 'gitLocalReview_projectExtractKeywords';
/** Delimiter line used to split bulk-registered memos (issue #104), shared across all projects. */
const SK_MEMO_BULK_DELIMITER = 'gitLocalReview_memoBulkDelimiter';
/** Per-line review comments: { [projectId]: { [filePath]: { [hunkHash]: { [lineIdx]: LineComment[] } } } }. */
const SK_LINE_COMMENTS    = 'gitLocalReview_lineComments';
/** "コメントありのみ" diff filter toggle ('true' | 'false'), independent of SK_REVIEW_FILTER. */
const SK_COMMENT_FILTER   = 'gitLocalReview_commentFilter';
/** "チェック済み非表示" toggle for line comments in the diff ('true' | 'false'); issue #124. */
const SK_HIDE_DONE_LINE_COMMENTS = 'gitLocalReview_hideDoneLineComments';
/** Global auto line-comment rules: keyword → comment text added to matching diff lines. */
const SK_AUTO_COMMENT_RULES = 'gitLocalReview_autoCommentRules';
/** Per-project auto line-comment rules: { [projectId]: rule[] }, same rule shape as SK_AUTO_COMMENT_RULES. */
const SK_PROJECT_AUTO_COMMENT_RULES = 'gitLocalReview_projectAutoCommentRules';
/** Which auto rules already ran on which line: { [projectId]: { [filePath]: { [hunkHash]: { [lineIdx]: ruleId[] } } } }. */
const SK_AUTO_COMMENT_APPLIED = 'gitLocalReview_autoCommentApplied';
/** Project collections: [{ id, name, createdAt }]. Membership lives on each project's `collectionId`. */
const SK_COLLECTIONS      = 'gitLocalReview_collections';

const VALID_PROJECT_SORTS = ['updated-desc', 'updated-asc', 'name-asc', 'name-desc'];
const DEFAULT_PROJECT_SORT = 'updated-desc';

/**
 * Hunk review statuses (issue #51). A hunk's stored value in `reviews` is one
 * of these strings, or absent entirely for "unreviewed". Order here also
 * defines the Space-key cycle order and the number-key shortcuts (1/2/3).
 */
const REVIEW_STATUSES = [
  { value: 'approved',      label: '承認',   icon: '✓', key: '1' },
  { value: 'needs_changes', label: '要修正', icon: '✎', key: '2' },
  { value: 'on_hold',       label: '保留',   icon: '⏸', key: '3' },
];
const VALID_REVIEW_STATUS_VALUES = REVIEW_STATUSES.map(s => s.value);

/**
 * Review-filter checkbox keys shown in the top bar (issue #56). 'unreviewed'
 * represents hunks with no stored status; the rest match REVIEW_STATUSES'
 * values. app.reviewFilter is a { [key]: boolean } map — a hunk is shown
 * when the key matching its status is true (OR across all checked keys).
 */
const REVIEW_FILTER_KEYS = ['unreviewed', ...VALID_REVIEW_STATUS_VALUES];

/** All review-filter checkboxes checked = no filtering applied. */
function defaultReviewFilter() {
  const filter = Object.create(null);
  for (const key of REVIEW_FILTER_KEYS) filter[key] = true;
  return filter;
}

/**
 * Whether the review filter is actually narrowing what's shown. All checkboxes
 * checked (nothing to exclude) and all checkboxes unchecked (nothing selected,
 * so there's no meaningful filter to apply) both mean "show everything" per #56.
 */
function isReviewFilterActive(filter) {
  const checkedCount = REVIEW_FILTER_KEYS.filter(key => filter[key]).length;
  return checkedCount !== 0 && checkedCount !== REVIEW_FILTER_KEYS.length;
}

// ─────────────────────────────────────────────────────────────────────────────
// Application state
// ─────────────────────────────────────────────────────────────────────────────
const app = {
  /** @type {string|null} Active project ID */
  currentProjectId: null,
  /** @type {Array<{filePath:string, hunks:Array<{header:string,lines:string[],hash:string}>}>|null} */
  parsedDiff: null,
  /** Holds progress badge elements keyed by filePath, populated during renderDiff */
  fileProgressEls: new Map(),
  /** Holds sidebar review-progress badge elements keyed by projectId, populated during renderProjectList */
  projectBadgeEls: new Map(),
  /** @type {'unified'|'split'} Current diff view mode ('split' = side-by-side) */
  viewMode: 'unified',
  /** @type {boolean} Word-level (git --word-diff-style) highlighting of changed lines, independent of viewMode */
  wordDiff: false,
  /** @type {{[key: string]: boolean}} Which review-status hunks renderDiff() shows, keyed by REVIEW_FILTER_KEYS; see loadReviewFilter() */
  reviewFilter: loadReviewFilter(),
  /** @type {boolean} When true, renderDiff() shows only hunks with at least one line comment (AND-ed with reviewFilter) */
  commentFilter: false,
  /** @type {boolean} When true, checked (done) line comments are hidden in the diff (persisted, SK_HIDE_DONE_LINE_COMMENTS) */
  hideDoneLineComments: false,
  /** @type {boolean} When true, every line comment is temporarily hidden in the diff (not persisted; resets on reload) */
  hideAllLineComments: false,
  /** Index into the flat, document-order list of currently rendered hunk cards
   *  that has keyboard focus (j/k to move, Space to cycle its review status). -1 = none. */
  focusedHunkIndex: -1,
};

/**
 * Read the diff-list review filter checkboxes from localStorage (defaults to
 * all keys checked, i.e. no filtering). Migrates two older formats on first
 * read, writing the migrated value back to SK_REVIEW_FILTER so migration
 * only needs to run once, not on every page load:
 *  - pre-#56 single-select string ('all' | 'unreviewed' | 'needs_changes')
 *  - pre-#51 boolean-only "未レビューのみ表示" toggle (SK_UNREVIEWED_ONLY_LEGACY)
 */
function loadReviewFilter() {
  try {
    const raw = localStorage.getItem(SK_REVIEW_FILTER);
    if (raw === 'all' || raw === 'unreviewed' || raw === 'needs_changes') {
      const migrated = defaultReviewFilter();
      if (raw !== 'all') {
        for (const key of REVIEW_FILTER_KEYS) migrated[key] = (key === raw);
      }
      saveReviewFilter(migrated);
      return migrated;
    }
    if (raw !== null) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        const filter = defaultReviewFilter();
        for (const key of REVIEW_FILTER_KEYS) {
          if (typeof parsed[key] === 'boolean') filter[key] = parsed[key];
        }
        return filter;
      }
    }
  } catch (e) {
    console.error('Failed to load review filter preference:', e);
    return defaultReviewFilter();
  }

  try {
    if (localStorage.getItem(SK_UNREVIEWED_ONLY_LEGACY) === '1') {
      const migrated = defaultReviewFilter();
      for (const key of REVIEW_FILTER_KEYS) migrated[key] = (key === 'unreviewed');
      saveReviewFilter(migrated);
      localStorage.removeItem(SK_UNREVIEWED_ONLY_LEGACY);
      return migrated;
    }
  } catch (e) {
    console.error('Failed to migrate legacy review filter preference:', e);
  }
  return defaultReviewFilter();
}

/** Persist the diff-list review filter checkboxes. */
function saveReviewFilter(filter) {
  try {
    localStorage.setItem(SK_REVIEW_FILTER, JSON.stringify(filter));
  } catch (e) {
    console.error('Failed to save review filter preference:', e);
  }
}

// Modal transient state
let modalFileName    = '';
let modalParsedDiff  = null;
let modalRawText     = null;
let modalSelectedId  = null;
let modalFileHandle  = null;
let modalEncoding    = 'auto';
let modalResolvedEncoding = 'utf-8';
let modalResolvedMessageEncoding = undefined;
/** Resolver for the Promise returned by showConflictModal(), so callers can await the user's choice. */
let modalResolve     = null;

// ─────────────────────────────────────────────────────────────────────────────
// localStorage helpers
// ─────────────────────────────────────────────────────────────────────────────
function loadProjects() {
  try {
    return JSON.parse(localStorage.getItem(SK_PROJECTS) || '[]');
  } catch (e) {
    console.error('Failed to parse projects from localStorage:', e);
    return [];
  }
}

function saveProjects(projects) {
  try {
    localStorage.setItem(SK_PROJECTS, JSON.stringify(projects));
  } catch (e) {
    console.error('Failed to save projects to localStorage:', e);
    alert('プロジェクトの保存に失敗しました。ストレージの容量が不足している可能性があります。');
  }
}

function loadProjectSort() {
  try {
    const val = localStorage.getItem(SK_PROJECT_SORT);
    return VALID_PROJECT_SORTS.includes(val) ? val : DEFAULT_PROJECT_SORT;
  } catch (e) {
    console.error('Failed to load project sort preference from localStorage:', e);
    return DEFAULT_PROJECT_SORT;
  }
}

function saveProjectSort(sortKey) {
  try {
    localStorage.setItem(SK_PROJECT_SORT, VALID_PROJECT_SORTS.includes(sortKey) ? sortKey : DEFAULT_PROJECT_SORT);
  } catch (e) {
    console.error('Failed to save project sort preference to localStorage:', e);
  }
}

// Sort a copy of the projects array according to the given sort key.
// Falls back to the default (newest updated first) for unknown keys.
function sortProjects(projects, sortKey) {
  const list = [...projects];
  const fileName = p => typeof p.fileName === 'string' ? p.fileName : '';
  switch (sortKey) {
    case 'updated-asc':
      return list.sort((a, b) => (a.lastUpdated || a.createdAt) - (b.lastUpdated || b.createdAt));
    case 'name-asc':
      return list.sort((a, b) => fileName(a).localeCompare(fileName(b), 'ja', { numeric: true, sensitivity: 'base' }));
    case 'name-desc':
      return list.sort((a, b) => fileName(b).localeCompare(fileName(a), 'ja', { numeric: true, sensitivity: 'base' }));
    case 'updated-desc':
    default:
      return list.sort((a, b) => (b.lastUpdated || b.createdAt) - (a.lastUpdated || a.createdAt));
  }
}

/**
 * Normalizes a stored review leaf value to a valid status string, or null
 * for "unreviewed". Coerces the pre-#51 boolean format (`true` → the
 * default 'approved' status) so old localStorage data and old exported
 * JSON files keep working; anything else invalid is dropped.
 */
function normalizeReviewStatus(value) {
  if (value === true) return 'approved';
  return VALID_REVIEW_STATUS_VALUES.includes(value) ? value : null;
}

// Rebuild with null-prototype objects to prevent prototype pollution
// from diff-derived (or imported) file paths used as object keys.
function sanitizeReviewsData(parsed) {
  const safe = Object.create(null);
  if (!parsed || typeof parsed !== 'object') return safe;
  for (const pid of Object.keys(parsed)) {
    safe[pid] = Object.create(null);
    const fileMap = parsed[pid];
    if (fileMap && typeof fileMap === 'object') {
      for (const fp of Object.keys(fileMap)) {
        safe[pid][fp] = Object.create(null);
        const hashMap = fileMap[fp];
        if (hashMap && typeof hashMap === 'object') {
          for (const h of Object.keys(hashMap)) {
            const status = normalizeReviewStatus(hashMap[h]);
            if (status) safe[pid][fp][h] = status;
          }
        }
      }
    }
  }
  return safe;
}

function loadAllReviews() {
  try {
    const parsed = JSON.parse(localStorage.getItem(SK_REVIEWS) || '{}');
    return sanitizeReviewsData(parsed);
  } catch (e) {
    console.error('Failed to parse reviews from localStorage:', e);
    return Object.create(null);
  }
}

function saveAllReviews(reviews) {
  try {
    localStorage.setItem(SK_REVIEWS, JSON.stringify(reviews));
  } catch (e) {
    console.error('Failed to save reviews to localStorage:', e);
    alert('レビュー状態の保存に失敗しました。ストレージの容量が不足している可能性があります。');
  }
}

// Rebuild with validated shapes, mirroring sanitizeReviewsData's defense
// against malformed/prototype-polluting imported data.
function sanitizeMemosData(parsed) {
  const safe = Object.create(null);
  if (!parsed || typeof parsed !== 'object') return safe;
  for (const pid of Object.keys(parsed)) {
    const list = parsed[pid];
    if (!Array.isArray(list)) continue;
    safe[pid] = list
      .filter(m => m && typeof m === 'object' && typeof m.id === 'string' && typeof m.text === 'string')
      .map(m => ({
        id: m.id,
        text: m.text,
        done: !!m.done,
        createdAt: typeof m.createdAt === 'number' ? m.createdAt : Date.now(),
        updatedAt: typeof m.updatedAt === 'number' ? m.updatedAt : Date.now(),
      }));
  }
  return safe;
}

function loadAllMemos() {
  try {
    const parsed = JSON.parse(localStorage.getItem(SK_MEMOS) || '{}');
    return sanitizeMemosData(parsed);
  } catch (e) {
    console.error('Failed to parse memos from localStorage:', e);
    return Object.create(null);
  }
}

function saveAllMemos(memos) {
  try {
    localStorage.setItem(SK_MEMOS, JSON.stringify(memos));
  } catch (e) {
    console.error('Failed to save memos to localStorage:', e);
    alert('メモの保存に失敗しました。ストレージの容量が不足している可能性があります。');
  }
}

/** Max stored length of a line comment's snapshot of the commented line's text (shown for orphaned comments). */
const LINE_COMMENT_SNAPSHOT_MAX = 500;
const VALID_LINE_COMMENT_TYPES = ['+', '-', ' '];

/**
 * Rebuild line comments with validated shapes and null-prototype maps, for
 * the same prototype-pollution reasons as sanitizeReviewsData(). Line index
 * keys must be non-negative integers; empty leaves are dropped.
 */
function sanitizeLineCommentsData(parsed) {
  const safe = Object.create(null);
  if (!parsed || typeof parsed !== 'object') return safe;
  for (const pid of Object.keys(parsed)) {
    const fileMap = parsed[pid];
    if (!fileMap || typeof fileMap !== 'object') continue;
    const safeFiles = Object.create(null);
    for (const fp of Object.keys(fileMap)) {
      const hashMap = fileMap[fp];
      if (!hashMap || typeof hashMap !== 'object') continue;
      const safeHashes = Object.create(null);
      for (const h of Object.keys(hashMap)) {
        const lineMap = hashMap[h];
        if (!lineMap || typeof lineMap !== 'object') continue;
        const safeLines = Object.create(null);
        for (const idx of Object.keys(lineMap)) {
          if (!/^\d+$/.test(idx) || !Array.isArray(lineMap[idx])) continue;
          const list = lineMap[idx]
            .filter(c => c && typeof c === 'object' && typeof c.id === 'string' && typeof c.text === 'string' && c.text.trim() !== '')
            .map(c => {
              // Missing timestamps fall back to a fixed 0 (not Date.now()) so
              // they stay stable across loads, and updatedAt falls back to
              // createdAt so such a comment isn't shown as "（編集済み）".
              const createdAt = typeof c.createdAt === 'number' ? c.createdAt : 0;
              return {
                id: c.id,
                text: c.text,
                createdAt,
                updatedAt: typeof c.updatedAt === 'number' ? c.updatedAt : createdAt,
                done: !!c.done,
                lineType: VALID_LINE_COMMENT_TYPES.includes(c.lineType) ? c.lineType : ' ',
                lineText: typeof c.lineText === 'string' ? c.lineText.slice(0, LINE_COMMENT_SNAPSHOT_MAX) : '',
                oldLabel: typeof c.oldLabel === 'number' ? c.oldLabel : '',
                newLabel: typeof c.newLabel === 'number' ? c.newLabel : '',
                // Set only on comments added by an auto line-comment rule.
                autoRuleId: typeof c.autoRuleId === 'string' ? c.autoRuleId : '',
              };
            });
          if (list.length > 0) safeLines[idx] = list;
        }
        if (Object.keys(safeLines).length > 0) safeHashes[h] = safeLines;
      }
      if (Object.keys(safeHashes).length > 0) safeFiles[fp] = safeHashes;
    }
    if (Object.keys(safeFiles).length > 0) safe[pid] = safeFiles;
  }
  return safe;
}

function loadAllLineComments() {
  try {
    const parsed = JSON.parse(localStorage.getItem(SK_LINE_COMMENTS) || '{}');
    return sanitizeLineCommentsData(parsed);
  } catch (e) {
    console.error('Failed to parse line comments from localStorage:', e);
    return Object.create(null);
  }
}

/** @returns {boolean} whether the save succeeded */
function saveAllLineComments(comments) {
  try {
    localStorage.setItem(SK_LINE_COMMENTS, JSON.stringify(comments));
    return true;
  } catch (e) {
    console.error('Failed to save line comments to localStorage:', e);
    alert('行コメントの保存に失敗しました。ストレージの容量が不足している可能性があります。');
    return false;
  }
}

/** Remove all line comments belonging to a permanently deleted project. */
function deleteLineCommentsForProject(projectId) {
  const all = loadAllLineComments();
  if (!(projectId in all)) return;
  delete all[projectId];
  saveAllLineComments(all);
}

function loadCommentFilter() {
  try {
    return localStorage.getItem(SK_COMMENT_FILTER) === 'true';
  } catch (e) {
    console.error('Failed to load comment filter preference:', e);
    return false;
  }
}

function saveCommentFilter(enabled) {
  try {
    localStorage.setItem(SK_COMMENT_FILTER, enabled ? 'true' : 'false');
  } catch (e) {
    console.error('Failed to save comment filter preference:', e);
  }
}

function loadHideDoneLineComments() {
  try {
    return localStorage.getItem(SK_HIDE_DONE_LINE_COMMENTS) === 'true';
  } catch (e) {
    console.error('Failed to load hide-done line comments preference:', e);
    return false;
  }
}

function saveHideDoneLineComments(enabled) {
  try {
    localStorage.setItem(SK_HIDE_DONE_LINE_COMMENTS, enabled ? 'true' : 'false');
  } catch (e) {
    console.error('Failed to save hide-done line comments preference:', e);
  }
}

/** Default delimiter (issue #104) used for bulk memo registration when none has been configured yet. */
const DEFAULT_MEMO_BULK_DELIMITER = '---';

function loadMemoBulkDelimiter() {
  const v = localStorage.getItem(SK_MEMO_BULK_DELIMITER);
  return typeof v === 'string' && v !== '' ? v : DEFAULT_MEMO_BULK_DELIMITER;
}

function saveMemoBulkDelimiter(delimiter) {
  try {
    localStorage.setItem(SK_MEMO_BULK_DELIMITER, delimiter);
  } catch (e) {
    console.error('Failed to save memo bulk delimiter to localStorage:', e);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Diff view mode (unified / side-by-side) — persisted so the choice survives
// page reloads. Falls back to 'unified' for any missing/corrupted value.
// ─────────────────────────────────────────────────────────────────────────────
function loadViewMode() {
  try {
    const v = localStorage.getItem(SK_VIEW_MODE);
    return v === 'split' ? 'split' : 'unified';
  } catch (e) {
    console.error('Failed to load view mode from localStorage:', e);
    return 'unified';
  }
}

function saveViewMode(mode) {
  try {
    localStorage.setItem(SK_VIEW_MODE, mode);
  } catch (e) {
    console.error('Failed to save view mode to localStorage:', e);
  }
}

/**
 * Word-level diff highlighting toggle (git --word-diff-style), persisted
 * independently of the unified/split view mode. Falls back to off (false)
 * for any missing/corrupted value.
 */
function loadWordDiff() {
  try {
    return localStorage.getItem(SK_WORD_DIFF) === 'true';
  } catch (e) {
    console.error('Failed to load word-diff setting from localStorage:', e);
    return false;
  }
}

function saveWordDiff(enabled) {
  try {
    localStorage.setItem(SK_WORD_DIFF, enabled ? 'true' : 'false');
  } catch (e) {
    console.error('Failed to save word-diff setting to localStorage:', e);
  }
}

// Rebuild with a null-prototype object for the same reason as sanitizeReviewsData:
// project IDs stored here may originate from an imported export file.
function sanitizeFilesData(parsed) {
  const safe = Object.create(null);
  if (!parsed || typeof parsed !== 'object') return safe;
  for (const pid of Object.keys(parsed)) {
    if (typeof parsed[pid] === 'string') safe[pid] = parsed[pid];
  }
  return safe;
}
