'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Keyword highlight (issue #10, categorised in issue #50, scoped in issue #68)
//
// Users can register any number of keyword categories in the sidebar, each
// with its own comma-separated keyword list and background color. Any diff
// line whose content contains one of a category's keywords gets its
// matching substring wrapped in <mark class="keyword-hit"> using that
// category's color, so keywords of different intent (e.g. TODO vs SECURITY)
// stay visually distinct while reviewing. Matching is a plain
// case-insensitive substring search (no RegExp), so there is no need to
// escape user input and no ReDoS risk.
//
// Each category has a scope, chosen per-category in the sidebar:
// - 'global'  — applies to every project, stored in SK_KEYWORDS.
// - 'project' — applies only while the category's owning project is active,
//               stored in SK_PROJECT_KEYWORDS under that project's id.
// loadKeywordCategories() returns the merged, scope-tagged view (global +
// the current project's own categories) that highlighting/rendering use;
// loadGlobalKeywordCategories()/loadProjectKeywordCategories() read the two
// stores individually and are what settings UI writes (add/edit/delete/move
// between scopes) go through.
//
// Storage: SK_KEYWORDS holds a JSON-encoded array of
// { id, keywords, color, countEnabled, enabled } category objects. Older
// data was a bare comma-separated keyword string (pre-#50);
// loadGlobalKeywordCategories() transparently migrates that into a single
// yellow category on read. `enabled` (issue #71) toggles whether the
// category's keywords are actually highlighted in the diff, independent of
// its `keywords` text — unchecking it hides that category's highlight
// without losing the typed keyword list; it defaults to true so pre-#71 data
// keeps highlighting as before.
// SK_PROJECT_KEYWORDS holds a JSON-encoded { [projectId]: category[] } map
// using the same category shape.
// ─────────────────────────────────────────────────────────────────────────────
const DEFAULT_KEYWORD_COLOR = '#fff000';
const KEYWORD_CATEGORY_COLOR_PALETTE = ['#fff000', '#ffadad', '#a0c4ff', '#caffbf', '#ffd6a5', '#bdb2ff'];

function generateKeywordCategoryId() {
  return `kwcat_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

/** Converts an HSL color (h in degrees, s/l in percent) to a lowercase '#rrggbb' hex string. */
function hslToHex(h, s, l) {
  s /= 100; l /= 100;
  const k = n => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const toHex = x => Math.round(255 * x).toString(16).padStart(2, '0');
  return `#${toHex(f(0))}${toHex(f(8))}${toHex(f(4))}`;
}

/**
 * Picks a color for a newly-registered keyword category that doesn't clash
 * with any color already in use (case-insensitive). Tries the curated
 * KEYWORD_CATEGORY_COLOR_PALETTE first so small keyword sets keep the
 * original hand-picked look; once that's exhausted, generates further pastel
 * colors by walking the hue wheel in golden-angle (~137.508°) steps, which
 * spreads consecutive hues apart so their hex values stay distinct even
 * across hundreds of categories.
 * @param {string[]} existingColors
 * @returns {string}
 */
function pickUnusedKeywordColor(existingColors) {
  const used = new Set(existingColors.map(c => c.toLowerCase()));
  for (const color of KEYWORD_CATEGORY_COLOR_PALETTE) {
    if (!used.has(color.toLowerCase())) return color;
  }
  const GOLDEN_ANGLE = 137.508;
  for (let i = 0; i < 100000; i++) {
    const color = hslToHex((i * GOLDEN_ANGLE) % 360, 65, 78);
    if (!used.has(color.toLowerCase())) return color;
  }
  return DEFAULT_KEYWORD_COLOR;
}

/**
 * Keep only well-formed category entries; drop anything with an unexpected shape.
 * `countEnabled` (issue #59) toggles whether this category's keyword-match
 * count is shown; it defaults to false so pre-#59 data (and new categories)
 * don't start counting unasked.
 * `enabled` (issue #71) toggles whether this category's keywords are
 * highlighted at all; it defaults to true so pre-#71 data (and new
 * categories) keep highlighting as before.
 */
function sanitizeKeywordCategories(rawCategories) {
  if (!Array.isArray(rawCategories)) return [];
  const result = [];
  for (const c of rawCategories) {
    if (!c || typeof c !== 'object' || typeof c.keywords !== 'string') continue;
    const color = typeof c.color === 'string' && /^#[0-9a-f]{6}$/i.test(c.color) ? c.color : DEFAULT_KEYWORD_COLOR;
    const id = typeof c.id === 'string' && c.id ? c.id : generateKeywordCategoryId();
    const countEnabled = c.countEnabled === true;
    const enabled = c.enabled !== false;
    // caseSensitive (issue #95): defaults to false (= ignore case, the
    // app's historical behavior) for both new categories and any saved
    // before this field existed.
    const caseSensitive = c.caseSensitive === true;
    result.push({ id, keywords: c.keywords, color, countEnabled, enabled, caseSensitive });
  }
  return result;
}

function loadGlobalKeywordCategories() {
  let raw;
  try {
    raw = localStorage.getItem(SK_KEYWORDS);
  } catch (e) {
    console.error('Failed to load keywords from localStorage:', e);
    return [];
  }
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return sanitizeKeywordCategories(parsed);
  } catch (e) {
    // Not JSON — fall through to the legacy plain-string migration below.
  }

  // Legacy format (pre-#50): a bare comma-separated keyword string. Persist
  // the migrated array immediately so its generated id stays stable across
  // subsequent loads — otherwise every loadGlobalKeywordCategories() call
  // would mint a new id and break edits/deletes for these rows (they look up
  // the category by an id from a previous load).
  const migrated = [{ id: generateKeywordCategoryId(), keywords: raw, color: DEFAULT_KEYWORD_COLOR, countEnabled: false, enabled: true, caseSensitive: false }];
  saveGlobalKeywordCategories(migrated);
  return migrated;
}

function saveGlobalKeywordCategories(categories) {
  try {
    localStorage.setItem(SK_KEYWORDS, JSON.stringify(categories));
  } catch (e) {
    console.error('Failed to save keywords to localStorage:', e);
    alert('キーワードの保存に失敗しました。ストレージの容量が不足している可能性があります。');
  }
}

// Rebuild with a null-prototype object and per-project sanitizeKeywordCategories(),
// mirroring sanitizeReviewsData()'s/sanitizeMemosData()'s prototype-pollution
// defense — project IDs and category arrays here may originate from imported
// JSON. Projects left with no valid categories are dropped.
function sanitizeProjectKeywordCategoriesMap(parsed) {
  const safe = Object.create(null);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return safe;
  for (const pid of Object.keys(parsed)) {
    const categories = sanitizeKeywordCategories(parsed[pid]);
    if (categories.length > 0) safe[pid] = categories;
  }
  return safe;
}

function loadAllProjectKeywordCategories() {
  try {
    return sanitizeProjectKeywordCategoriesMap(JSON.parse(localStorage.getItem(SK_PROJECT_KEYWORDS) || '{}'));
  } catch (e) {
    console.error('Failed to load project keywords from localStorage:', e);
    return Object.create(null);
  }
}

function saveAllProjectKeywordCategories(byProjectId) {
  try {
    localStorage.setItem(SK_PROJECT_KEYWORDS, JSON.stringify(byProjectId));
  } catch (e) {
    console.error('Failed to save project keywords to localStorage:', e);
    alert('キーワードの保存に失敗しました。ストレージの容量が不足している可能性があります。');
  }
}

function loadProjectKeywordCategories(projectId) {
  if (!projectId) return [];
  // loadAllProjectKeywordCategories() already sanitizes each project's list.
  return loadAllProjectKeywordCategories()[projectId] || [];
}

function saveProjectKeywordCategories(projectId, categories) {
  if (!projectId) return;
  const all = loadAllProjectKeywordCategories();
  all[projectId] = categories;
  saveAllProjectKeywordCategories(all);
}

/** Drops a deleted project's own keyword categories; its global categories are untouched. */
function deleteProjectKeywordCategories(projectId) {
  const all = loadAllProjectKeywordCategories();
  if (!(projectId in all)) return;
  delete all[projectId];
  saveAllProjectKeywordCategories(all);
}

/**
 * Merged, scope-tagged view used by highlighting and the settings list:
 * every global category, plus (when a project is active) its collection's
 * categories (if it's in one) and that project's own categories. `scope` on
 * each entry ('global'|'collection'|'project') tells the settings UI which
 * store an edit/delete/move should go through (see scopeOwnerId()).
 */
function loadKeywordCategories() {
  const result = loadGlobalKeywordCategories().map(c => ({ ...c, scope: 'global' }));
  for (const scope of OWNED_SETTING_SCOPES) {
    const ownerId = scopeOwnerId(scope);
    if (ownerId) result.push(...loadProjectKeywordCategories(ownerId).map(c => ({ ...c, scope })));
  }
  return result;
}

// Parses a category's raw comma-separated input into a de-duplicated list of
// non-empty, trimmed keywords. Whitespace-only entries are dropped, so an
// empty/blank input yields an empty array (= no highlighting).
function parseKeywords(raw) {
  if (!raw) return [];
  const seen = new Set();
  const result = [];
  for (const part of raw.split(',')) {
    const kw = part.trim();
    if (!kw || seen.has(kw.toLowerCase())) continue;
    seen.add(kw.toLowerCase());
    result.push(kw);
  }
  return result;
}

/**
 * Returns the active keyword categories with their raw keyword string
 * already parsed, dropping categories with no keywords and categories whose
 * `enabled` toggle (issue #71) is off. Order matches the saved category
 * order and determines highlight priority when two categories match
 * overlapping text (earlier category wins — see findKeywordRanges).
 * @returns {Array<{color:string, keywords:string[], caseSensitive:boolean}>}
 */
function getActiveKeywordGroups() {
  return loadKeywordCategories()
    .filter(cat => cat.enabled)
    .map(cat => ({ color: cat.color, keywords: parseKeywords(cat.keywords), caseSensitive: cat.caseSensitive }))
    .filter(g => g.keywords.length > 0);
}

function mergeRanges(ranges) {
  if (ranges.length === 0) return [];
  ranges.sort((a, b) => a.start - b.start);
  const merged = [ranges[0]];
  for (let i = 1; i < ranges.length; i++) {
    const last = merged[merged.length - 1];
    const cur  = ranges[i];
    if (cur.start <= last.end) {
      last.end = Math.max(last.end, cur.end);
    } else {
      merged.push(cur);
    }
  }
  return merged;
}

// Finds all (merged, non-overlapping) match ranges of a single set of
// same-color keywords within `text`. Case-insensitive by default, matching
// the app's historical behavior; pass caseSensitive: true (issue #95) to
// match keywords' exact case instead.
function findRawKeywordRanges(text, keywords, caseSensitive = false) {
  const haystack = caseSensitive ? text : text.toLowerCase();
  const ranges = [];
  for (const kw of keywords) {
    const needle = caseSensitive ? kw : kw.toLowerCase();
    if (!needle) continue;
    let from = 0;
    while (true) {
      const idx = haystack.indexOf(needle, from);
      if (idx === -1) break;
      ranges.push({ start: idx, end: idx + needle.length });
      from = idx + needle.length;
    }
  }
  return mergeRanges(ranges);
}

/**
 * Counts how many times a category's keywords occur across every line of the
 * currently loaded diff (app.parsedDiff), regardless of the active review
 * filter — this reflects "全差分" (issue #59), not just the currently
 * rendered/filtered subset. Reuses findRawKeywordRanges() (merged,
 * non-overlapping matches, case-insensitive unless `caseSensitive` is set —
 * issue #95) per line, so it counts the same matches applyKeywordHighlight()
 * would find for this category on its own — unlike findKeywordRanges(),
 * there's no cross-category overlap trimming here since each category's
 * count is independent of the others.
 * @param {string[]} keywords
 * @param {boolean} [caseSensitive]
 * @returns {number}
 */
function countKeywordMatches(keywords, caseSensitive = false) {
  if (!keywords || keywords.length === 0 || !app.parsedDiff) return 0;
  let total = 0;
  for (const file of app.parsedDiff) {
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.startsWith('\\')) continue; // "\ No newline at end of file" marker, not diff content
        const content = line.length > 1 ? line.slice(1) : '';
        total += findRawKeywordRanges(content, keywords, caseSensitive).length;
      }
    }
  }
  return total;
}

// Subtracts `claimed` (sorted, non-overlapping) intervals from `ranges`
// (sorted, non-overlapping), returning the remaining pieces of `ranges`
// that don't overlap any claimed interval.
function subtractRanges(ranges, claimed) {
  if (claimed.length === 0) return ranges;
  const result = [];
  for (const r of ranges) {
    let segments = [{ start: r.start, end: r.end }];
    for (const c of claimed) {
      const next = [];
      for (const seg of segments) {
        if (c.end <= seg.start || c.start >= seg.end) {
          next.push(seg);
          continue;
        }
        if (c.start > seg.start) next.push({ start: seg.start, end: Math.min(c.start, seg.end) });
        if (c.end < seg.end) next.push({ start: Math.max(c.end, seg.start), end: seg.end });
      }
      segments = next;
    }
    result.push(...segments);
  }
  return result;
}

/**
 * Finds all match ranges of the given keyword groups within `text` (plain
 * substring search, no RegExp) — case-insensitively unless a group's own
 * `caseSensitive` flag (issue #95) says otherwise. Each returned range
 * carries the color of the category it matched. When two categories'
 * keywords match overlapping text, the earlier group in `groups` wins the
 * overlap — its range is kept whole and later groups are trimmed around it.
 * @param {string} text
 * @param {Array<{color:string, keywords:string[], caseSensitive?:boolean}>} groups
 * @returns {Array<{start:number, end:number, color:string}>} sorted, non-overlapping
 */
function findKeywordRanges(text, groups) {
  if (!groups || groups.length === 0 || !text) return [];
  let claimed = [];
  const colored = [];
  for (const group of groups) {
    const raw = findRawKeywordRanges(text, group.keywords, group.caseSensitive);
    if (raw.length === 0) continue;
    for (const p of subtractRanges(raw, claimed)) colored.push({ start: p.start, end: p.end, color: group.color });
    claimed = mergeRanges([...claimed, ...raw]);
  }
  colored.sort((a, b) => a.start - b.start);
  return colored;
}

/** Picks black or white text for readable contrast against a hex background color. */
function contrastTextColor(hexColor) {
  const hex = hexColor.replace('#', '');
  if (hex.length !== 6) return '#24292e';
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  const luminance = (r * 299 + g * 587 + b * 114) / 1000; // ITU-R BT.601 perceived luminance
  return luminance > 150 ? '#24292e' : '#ffffff';
}

// Walks the text nodes under `root` and wraps any keyword match in
// <mark class="keyword-hit">, colored per its matching category. Operates on
// the DOM directly (rather than via string/HTML manipulation) so it cannot
// corrupt highlight.js's markup.
function applyKeywordHighlight(root, groups) {
  if (!groups || groups.length === 0) return;

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const textNodes = [];
  let node;
  while ((node = walker.nextNode())) textNodes.push(node);

  for (const textNode of textNodes) {
    const text = textNode.nodeValue;
    const ranges = findKeywordRanges(text, groups);
    if (ranges.length === 0) continue;

    const frag = document.createDocumentFragment();
    let pos = 0;
    for (const r of ranges) {
      if (r.start > pos) frag.appendChild(document.createTextNode(text.slice(pos, r.start)));
      const mark = document.createElement('mark');
      mark.className = 'keyword-hit';
      mark.style.backgroundColor = r.color;
      mark.style.color = contrastTextColor(r.color);
      mark.textContent = text.slice(r.start, r.end);
      frag.appendChild(mark);
      pos = r.end;
    }
    if (pos < text.length) frag.appendChild(document.createTextNode(text.slice(pos)));

    textNode.parentNode.replaceChild(frag, textNode);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Keyword line extraction (issue #79)
//
// A separate feature from the keyword highlight above: rather than coloring
// matches in place, each registered entry collects every diff line matching
// any of its keywords into its own list, shown in the "🔎 抽出" modal. As
// with keyword highlight, an entry's `keyword` field may hold several
// comma-separated keywords (issue #91, parsed via parseKeywords()) — a line
// matches the entry if it contains at least one of them (OR, not AND).
// Extraction is limited to added/removed lines (those starting with '+' or
// '-') — context lines are not scanned. Matching is the same plain
// substring search used by keyword highlight (findRawKeywordRanges),
// applied directly to whole-line text — case-insensitive unless the entry's
// own `caseSensitive` flag (issue #95) says otherwise.
//
// Each keyword entry has a scope, chosen per-entry in the modal:
// - 'global'  — applies to every project, stored in SK_EXTRACT_KEYWORDS.
// - 'project' — applies only while the entry's owning project is active,
//               stored in SK_PROJECT_EXTRACT_KEYWORDS under that project's id.
// loadExtractKeywords() returns the merged, scope-tagged view (global + the
// current project's own entries), mirroring loadKeywordCategories().
//
// `enabled` (issue #109) toggles a single entry's extraction on/off without
// deleting it; disabled entries are skipped entirely by renderExtractResults()
// (no result section is shown for them). Defaults to true.
//
// Storage: SK_EXTRACT_KEYWORDS holds a JSON-encoded array of
// { id, keyword, fileFilter, caseSensitive, addedOnly } entries — fileFilter
// (issue #92) is an optional plain case-insensitive partial match against
// each file's path, restricting extraction to matching files; '' (the
// default, including for entries saved before #92) means every file is
// scanned. caseSensitive (issue #95) defaults to false (= ignore case, the
// app's historical behavior) for both new entries and any saved before this
// field existed. addedOnly (issue #106) defaults to false (= scan both
// added and removed lines, the app's historical behavior); when true, only
// added lines (those starting with '+') are scanned.
// SK_PROJECT_EXTRACT_KEYWORDS holds a JSON-encoded { [projectId]: entry[] }
// map using the same entry shape.
// ─────────────────────────────────────────────────────────────────────────────

function generateExtractKeywordId() {
  return `exkw_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

/** Keep only well-formed entries; drop anything with an unexpected shape. */
function sanitizeExtractKeywords(rawList) {
  if (!Array.isArray(rawList)) return [];
  const result = [];
  for (const k of rawList) {
    if (!k || typeof k !== 'object' || typeof k.keyword !== 'string') continue;
    const id = typeof k.id === 'string' && k.id ? k.id : generateExtractKeywordId();
    // fileFilter (issue #92): optional partial file-path match, defaulting to
    // '' (= no filter, extract from every file) for older saved entries.
    const fileFilter = typeof k.fileFilter === 'string' ? k.fileFilter : '';
    // caseSensitive (issue #95): defaults to false (= ignore case, the app's
    // historical behavior) for both new entries and any saved before this
    // field existed.
    const caseSensitive = k.caseSensitive === true;
    // addedOnly (issue #106): defaults to false (= scan added and removed
    // lines, the app's historical behavior) for both new entries and any
    // saved before this field existed.
    const addedOnly = k.addedOnly === true;
    // enabled (issue #109): whether this keyword's extraction is active.
    // Defaults to true for both new entries and any saved before this field
    // existed, so existing keywords keep extracting after upgrade.
    const enabled = k.enabled !== false;
    result.push({ id, keyword: k.keyword, fileFilter, caseSensitive, addedOnly, enabled });
  }
  return result;
}

function loadGlobalExtractKeywords() {
  try {
    return sanitizeExtractKeywords(JSON.parse(localStorage.getItem(SK_EXTRACT_KEYWORDS) || '[]'));
  } catch (e) {
    console.error('Failed to load extract keywords from localStorage:', e);
    return [];
  }
}

function saveGlobalExtractKeywords(keywords) {
  try {
    localStorage.setItem(SK_EXTRACT_KEYWORDS, JSON.stringify(keywords));
  } catch (e) {
    console.error('Failed to save extract keywords to localStorage:', e);
    alert('キーワードの保存に失敗しました。ストレージの容量が不足している可能性があります。');
  }
}

// Rebuild with a null-prototype object and per-project sanitizeExtractKeywords(),
// mirroring sanitizeProjectKeywordCategoriesMap()'s prototype-pollution
// defense — project IDs and entry arrays here may originate from imported
// JSON. Projects left with no valid entries are dropped.
function sanitizeProjectExtractKeywordsMap(parsed) {
  const safe = Object.create(null);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return safe;
  for (const pid of Object.keys(parsed)) {
    const keywords = sanitizeExtractKeywords(parsed[pid]);
    if (keywords.length > 0) safe[pid] = keywords;
  }
  return safe;
}

function loadAllProjectExtractKeywords() {
  try {
    return sanitizeProjectExtractKeywordsMap(JSON.parse(localStorage.getItem(SK_PROJECT_EXTRACT_KEYWORDS) || '{}'));
  } catch (e) {
    console.error('Failed to load project extract keywords from localStorage:', e);
    return Object.create(null);
  }
}

function saveAllProjectExtractKeywords(byProjectId) {
  try {
    localStorage.setItem(SK_PROJECT_EXTRACT_KEYWORDS, JSON.stringify(byProjectId));
  } catch (e) {
    console.error('Failed to save project extract keywords to localStorage:', e);
    alert('キーワードの保存に失敗しました。ストレージの容量が不足している可能性があります。');
  }
}

function loadProjectExtractKeywords(projectId) {
  if (!projectId) return [];
  // loadAllProjectExtractKeywords() already sanitizes each project's list.
  return loadAllProjectExtractKeywords()[projectId] || [];
}

function saveProjectExtractKeywords(projectId, keywords) {
  if (!projectId) return;
  const all = loadAllProjectExtractKeywords();
  all[projectId] = keywords;
  saveAllProjectExtractKeywords(all);
}

/** Drops a deleted project's own extraction keywords; its global keywords are untouched. */
function deleteProjectExtractKeywords(projectId) {
  const all = loadAllProjectExtractKeywords();
  if (!(projectId in all)) return;
  delete all[projectId];
  saveAllProjectExtractKeywords(all);
}

/**
 * Merged, scope-tagged view used by the extraction modal: every global
 * keyword, plus (when a project is active) its collection's keywords (if
 * it's in one) and that project's own keywords. `scope` on each entry
 * ('global'|'collection'|'project') tells the modal which store an
 * edit/delete/move should go through.
 */
function loadExtractKeywords() {
  const result = loadGlobalExtractKeywords().map(k => ({ ...k, scope: 'global' }));
  for (const scope of OWNED_SETTING_SCOPES) {
    const ownerId = scopeOwnerId(scope);
    if (ownerId) result.push(...loadProjectExtractKeywords(ownerId).map(k => ({ ...k, scope })));
  }
  return result;
}

/**
 * Finds every added/removed diff line (lines starting with '+' or '-';
 * context lines and the "\ No newline at end of file" marker are skipped)
 * across the whole currently loaded diff (app.parsedDiff) whose text
 * contains at least one of `raw`'s keywords (plain substring search,
 * case-insensitive unless `caseSensitive` is set — issue #95). `raw` may
 * hold several comma-separated keywords (issue #91), parsed the same way
 * keyword-highlight categories are (see parseKeywords()) — a line matches if
 * any one of them is found (OR, not AND).
 *
 * `fileFilter` (issue #92) restricts the scan to files whose path contains
 * it (always a plain case-insensitive substring match, regardless of
 * `caseSensitive` — that flag only affects keyword matching); left blank
 * (the default), every file in the diff is scanned.
 *
 * `addedOnly` (issue #106) restricts the scan to added lines (those
 * starting with '+') only, skipping removed lines; false (the default)
 * scans both.
 * @param {string} raw
 * @param {string} [fileFilter]
 * @param {boolean} [caseSensitive]
 * @param {boolean} [addedOnly]
 * @returns {Array<{filePath: string, prefix: '+'|'-', content: string}>}
 */
function extractKeywordMatches(raw, fileFilter = '', caseSensitive = false, addedOnly = false) {
  const keywords = parseKeywords(raw);
  if (keywords.length === 0 || !app.parsedDiff) return [];
  const matchKeywords = caseSensitive ? keywords : keywords.map(kw => kw.toLowerCase());
  const lowerFileFilter = fileFilter.trim().toLowerCase();
  const results = [];
  for (const file of app.parsedDiff) {
    if (lowerFileFilter && !file.filePath.toLowerCase().includes(lowerFileFilter)) continue;
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.startsWith('\\')) continue; // "\ No newline at end of file" marker, not diff content
        const prefix = line.charAt(0);
        if (prefix !== '+' && prefix !== '-') continue;
        if (addedOnly && prefix !== '+') continue;
        const content = line.length > 1 ? line.slice(1) : '';
        const matchContent = caseSensitive ? content : content.toLowerCase();
        if (matchKeywords.some(kw => matchContent.includes(kw))) {
          results.push({ filePath: file.filePath, prefix, content });
        }
      }
    }
  }
  return results;
}

function loadAllFiles() {
  try {
    return sanitizeFilesData(JSON.parse(localStorage.getItem(SK_FILES) || '{}'));
  } catch (e) {
    console.error('Failed to parse saved file contents from localStorage:', e);
    return Object.create(null);
  }
}

function saveAllFiles(files) {
  try {
    localStorage.setItem(SK_FILES, JSON.stringify(files));
  } catch (e) {
    console.error('Failed to save file content to localStorage:', e);
    alert(
      'アップロードしたファイルの保存に失敗しました。ストレージの容量が不足している可能性があります。\n' +
      '表示中のレビューはそのまま続けられますが、次回はdiffファイルの再読み込みが必要です。'
    );
  }
}

/** Get the last uploaded diff content for a project, or null if none is saved. */
function loadFileContent(projectId) {
  const files = loadAllFiles();
  return typeof files[projectId] === 'string' ? files[projectId] : null;
}

function saveFileContent(projectId, text) {
  const files = loadAllFiles();
  if (typeof text === 'string') {
    files[projectId] = text;
  } else {
    console.error('saveFileContent called with non-string content; clearing saved copy for', projectId);
    delete files[projectId];
  }
  saveAllFiles(files);
  invalidateProjectProgressCache(projectId);
}

function deleteFileContent(projectId) {
  const files = loadAllFiles();
  delete files[projectId];
  saveAllFiles(files);
  invalidateProjectProgressCache(projectId);
}
