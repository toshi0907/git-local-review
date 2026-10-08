'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Keyword categories (issue #10, #50, scoped in #68): each category row lets
// the user edit its keyword list, background color, scope (global vs. the
// active project only), and — via the leading checkbox (issue #71) — whether
// the category's highlight is enabled at all; persists across
// reloads/projects and re-renders the currently displayed diff (debounced)
// whenever a category's content changes. Adding/removing/moving a category
// rebuilds the row list immediately (no debounce needed, and no in-progress
// input to lose focus on); the sidebar list itself is also rebuilt on
// project switch, since project-scoped categories change with the active
// project.
// ─────────────────────────────────────────────────────────────────────────────
/** Count badge text for a category row: empty unless counting is on and a diff is loaded. */
function keywordCategoryCountBadgeText(category) {
  if (!category.countEnabled || !app.parsedDiff) return '';
  return `${countKeywordMatches(parseKeywords(category.keywords), category.caseSensitive)}件`;
}

function buildKeywordCategoryRow(category) {
  const row = document.createElement('div');
  row.className = 'keyword-category-row';
  if (category.enabled === false) row.classList.add('keyword-category-disabled');

  // Enabled toggle (issue #71): lets a category's highlight be switched off
  // without clearing its keyword text, e.g. to temporarily silence a noisy
  // category while reviewing. Purely a highlight switch — it does not affect
  // the count toggle/badge below, which keeps counting regardless.
  const enabledToggle = document.createElement('input');
  enabledToggle.type = 'checkbox';
  enabledToggle.className = 'keyword-category-enabled-toggle';
  enabledToggle.checked = category.enabled !== false;
  enabledToggle.title = 'このカテゴリのハイライトを有効にする';
  enabledToggle.setAttribute('aria-label', 'このカテゴリのハイライトを有効にする');
  enabledToggle.addEventListener('change', () => {
    updateKeywordCategory(category.id, { enabled: enabledToggle.checked });
    row.classList.toggle('keyword-category-disabled', !enabledToggle.checked);
  });

  const colorInput = document.createElement('input');
  colorInput.type = 'color';
  colorInput.className = 'keyword-category-color';
  colorInput.value = category.color;
  colorInput.title = '背景色';
  colorInput.setAttribute('aria-label', '背景色');
  colorInput.addEventListener('input', () => {
    updateKeywordCategory(category.id, { color: colorInput.value });
  });

  const keywordsInput = document.createElement('input');
  keywordsInput.type = 'text';
  keywordsInput.className = 'keyword-category-keywords';
  keywordsInput.value = category.keywords;
  keywordsInput.placeholder = '例: TODO, FIXME, XXX';
  keywordsInput.title = 'カンマ区切りで複数指定できます（大文字小文字の区別は右の「Aa」で切り替えられます）';
  keywordsInput.setAttribute('aria-label', 'キーワード（カンマ区切り）');
  keywordsInput.addEventListener('input', () => {
    updateKeywordCategory(category.id, { keywords: keywordsInput.value });
  });

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'keyword-category-remove-btn';
  removeBtn.title = 'このカテゴリを削除';
  removeBtn.setAttribute('aria-label', 'カテゴリを削除');
  removeBtn.textContent = '×';
  removeBtn.addEventListener('click', () => deleteKeywordCategory(category.id));

  row.appendChild(enabledToggle);
  row.appendChild(colorInput);
  row.appendChild(keywordsInput);

  // Scope selector (issue #68): choose whether this category is shared by
  // every project ('global', stored in SK_KEYWORDS), by the active project's
  // collection ('collection', stored in SK_PROJECT_KEYWORDS under the
  // collection ID), or private to the currently active project ('project',
  // stored in SK_PROJECT_KEYWORDS). Unavailable options are disabled (see
  // appendSettingScopeOptions()) — a category can only move into a
  // project's/collection's store while that project is selected. Labels are kept short (vs. the bulk-registration form's
  // spelled-out "全体設定"/"このプロジェクトのみ") since this row packs
  // every control onto a single line; the title attribute carries the
  // full explanation.
  const scopeSelect = document.createElement('select');
  scopeSelect.className = 'keyword-category-scope-select';
  scopeSelect.setAttribute('aria-label', '適用範囲（全体設定・このコレクション・このプロジェクトのみ）');
  scopeSelect.title = '全体設定にするか、現在のコレクション・プロジェクトだけの設定にするかを選べます';
  appendSettingScopeOptions(scopeSelect);

  scopeSelect.value = category.scope;
  scopeSelect.addEventListener('change', () => {
    moveKeywordCategoryScope(category.id, scopeSelect.value);
  });

  row.appendChild(scopeSelect);

  // Count toggle (issue #59): per-category opt-in match counter across the
  // whole loaded diff, e.g. "TODO はカウントする、NOTE はカウントしない".
  const countRow = document.createElement('label');
  countRow.className = 'keyword-category-count-row';
  countRow.title = '登録したキーワードが全差分内で一致した回数をカウントします';

  const countToggle = document.createElement('input');
  countToggle.type = 'checkbox';
  countToggle.className = 'keyword-category-count-toggle';
  countToggle.checked = !!category.countEnabled;
  countToggle.setAttribute('aria-label', 'このカテゴリの一致回数をカウントする');

  const countBadge = document.createElement('span');
  countBadge.className = 'keyword-category-count-badge';
  countBadge.dataset.categoryId = category.id;
  countBadge.textContent = keywordCategoryCountBadgeText(category);

  // Case-sensitivity toggle (issue #95): off (the default, and the app's
  // historical behavior) matches keywords ignoring case; on matches their
  // exact case. Affects both the highlight itself (via getActiveKeywordGroups())
  // and this row's own count badge below.
  const caseRow = document.createElement('label');
  caseRow.className = 'keyword-category-case-row';
  caseRow.title = 'オンにすると、キーワードの大文字小文字を区別して一致させます（オフなら区別しません）';

  const caseToggle = document.createElement('input');
  caseToggle.type = 'checkbox';
  caseToggle.className = 'keyword-category-case-toggle';
  caseToggle.checked = !!category.caseSensitive;
  caseToggle.setAttribute('aria-label', 'このカテゴリで大文字小文字を区別する');

  caseRow.appendChild(caseToggle);
  caseRow.appendChild(document.createTextNode('Aa'));

  countToggle.addEventListener('change', () => {
    updateKeywordCategory(category.id, { countEnabled: countToggle.checked });
    // Use keywordsInput.value (not category.keywords, which is a snapshot from
    // when this row was built) so a keyword edited just before toggling counts
    // with the current text rather than briefly showing a stale count.
    countBadge.textContent = keywordCategoryCountBadgeText({ keywords: keywordsInput.value, countEnabled: countToggle.checked, caseSensitive: caseToggle.checked });
  });

  caseToggle.addEventListener('change', () => {
    updateKeywordCategory(category.id, { caseSensitive: caseToggle.checked });
    countBadge.textContent = keywordCategoryCountBadgeText({ keywords: keywordsInput.value, countEnabled: countToggle.checked, caseSensitive: caseToggle.checked });
  });

  countRow.appendChild(countToggle);
  countRow.appendChild(document.createTextNode('件数'));
  countRow.appendChild(countBadge);

  row.appendChild(countRow);
  row.appendChild(caseRow);
  row.appendChild(removeBtn);
  return row;
}

function renderKeywordCategoryList() {
  const container = document.getElementById('keyword-categories');
  container.innerHTML = '';
  for (const scope of OWNED_SETTING_SCOPES) {
    const unavailable = !scopeOwnerId(scope);
    document.getElementById(`keyword-category-enable-all-${scope}-btn`).disabled = unavailable;
    document.getElementById(`keyword-category-disable-all-${scope}-btn`).disabled = unavailable;
  }
  document.getElementById('keyword-category-collection-toggle-group').hidden = !scopeOwnerId('collection');
  const categories = loadKeywordCategories();
  if (categories.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'keyword-categories-empty';
    empty.textContent = 'カテゴリがありません。「+ カテゴリ」から追加してください。';
    container.appendChild(empty);
    return;
  }
  for (const category of categories) {
    container.appendChild(buildKeywordCategoryRow(category));
  }
}

/**
 * Recomputes and updates every rendered category's count badge in place
 * (without rebuilding the rows/losing focus). Called after renderDiff() so
 * counts stay in sync whenever the loaded diff changes.
 */
function refreshKeywordCounts() {
  // Match badges by dataset.categoryId in JS rather than interpolating
  // category.id into a querySelector() string — ids can come from imported
  // JSON (sanitizeKeywordCategories() accepts any non-empty string), and one
  // containing '"' or ']' would otherwise throw a DOMException.
  const badgesById = new Map();
  for (const el of document.querySelectorAll('.keyword-category-count-badge')) {
    badgesById.set(el.dataset.categoryId, el);
  }
  for (const category of loadKeywordCategories()) {
    const badge = badgesById.get(category.id);
    if (badge) badge.textContent = keywordCategoryCountBadgeText(category);
  }
}

/**
 * Every color currently in use across the global category store and every
 * project's own category store (not just the active project's). A new
 * *global* category is merged into every project's view (see
 * loadKeywordCategories()), so its auto-picked color has to avoid every
 * project's own categories too, not only the ones visible right now —
 * otherwise it could still collide once a different project is opened.
 */
function collectAllKeywordColors() {
  const colors = loadGlobalKeywordCategories().map(c => c.color);
  const allProjects = loadAllProjectKeywordCategories();
  for (const pid of Object.keys(allProjects)) {
    for (const c of allProjects[pid]) colors.push(c.color);
  }
  return colors;
}

/** New categories always start global; move them to the active project via the scope selector afterwards. */
function addKeywordCategory() {
  const color = pickUnusedKeywordColor(collectAllKeywordColors());
  const categories = loadGlobalKeywordCategories();
  categories.push({ id: generateKeywordCategoryId(), keywords: '', color, countEnabled: false, enabled: true, caseSensitive: false });
  saveGlobalKeywordCategories(categories);
  renderKeywordCategoryList();
}

/**
 * Bulk-registers one new category per non-empty line of `text` (each line
 * becomes a category's comma-separated `keywords` string, so a line can
 * itself list several keywords sharing one color/settings). Every new
 * category gets a color that doesn't clash with any existing category's
 * color, nor with another category created earlier in the same batch.
 * `scope === 'project'` / `'collection'` puts every new category into the
 * active project's own / its collection's store (the caller disables those
 * options when unavailable) — for a project's own store, only the colors
 * shown together with it matter (loadKeywordCategories()). Anything else
 * registers them as global; global and collection categories reach several
 * projects, so those avoid every stored color (collectAllKeywordColors()).
 * @returns {number} how many categories were created
 */
function bulkAddKeywordCategories(text, scope) {
  const lines = text.split(/\r\n|\r|\n/).map(line => line.trim()).filter(line => line.length > 0);
  if (lines.length === 0) return 0;

  const ownerId = scope === 'project' || scope === 'collection' ? scopeOwnerId(scope) : null;
  // A project's own categories are only ever shown with global + that
  // project's (and its collection's) ones; collection- and global-scoped
  // ones reach several projects, so avoid every stored color for those.
  const usedColors = ownerId && scope === 'project' ? loadKeywordCategories().map(c => c.color) : collectAllKeywordColors();
  const newCategories = lines.map(line => {
    const color = pickUnusedKeywordColor(usedColors);
    usedColors.push(color);
    return { id: generateKeywordCategoryId(), keywords: line, color, countEnabled: false, enabled: true, caseSensitive: false };
  });

  if (ownerId) {
    const categories = loadProjectKeywordCategories(ownerId);
    categories.push(...newCategories);
    saveProjectKeywordCategories(ownerId, categories);
  } else {
    const categories = loadGlobalKeywordCategories();
    categories.push(...newCategories);
    saveGlobalKeywordCategories(categories);
  }
  return newCategories.length;
}

let keywordDebounceTimer = null;
function scheduleKeywordDiffRerender() {
  clearTimeout(keywordDebounceTimer);
  keywordDebounceTimer = setTimeout(() => {
    if (app.parsedDiff) renderDiff();
  }, 200);
}

/** Which store (global, the active project's collection's, or its own) a category id currently lives in, or null if none. */
function findKeywordCategoryScope(id) {
  if (loadGlobalKeywordCategories().some(c => c.id === id)) return 'global';
  for (const scope of OWNED_SETTING_SCOPES) {
    const ownerId = scopeOwnerId(scope);
    if (ownerId && loadProjectKeywordCategories(ownerId).some(c => c.id === id)) return scope;
  }
  return null;
}

/** Updates a single category's fields in place without rebuilding the row list, so the input being edited keeps focus. */
function updateKeywordCategory(id, patch) {
  const scope = findKeywordCategoryScope(id);
  if (!scope) return;
  if (scope === 'global') {
    const categories = loadGlobalKeywordCategories();
    const category = categories.find(c => c.id === id);
    if (!category) return;
    Object.assign(category, patch);
    saveGlobalKeywordCategories(categories);
  } else {
    const ownerId = scopeOwnerId(scope);
    const categories = loadProjectKeywordCategories(ownerId);
    const category = categories.find(c => c.id === id);
    if (!category) return;
    Object.assign(category, patch);
    saveProjectKeywordCategories(ownerId, categories);
  }
  scheduleKeywordDiffRerender();
}

/** Moves a category between the global, collection and project stores, keeping its id/keywords/color/countEnabled/enabled/caseSensitive. */
function moveKeywordCategoryScope(id, newScope) {
  const fromScope = findKeywordCategoryScope(id);
  if (!fromScope || fromScope === newScope) return;
  if (newScope !== 'global' && !scopeOwnerId(newScope)) return;

  let category;
  if (fromScope === 'global') {
    const categories = loadGlobalKeywordCategories();
    const idx = categories.findIndex(c => c.id === id);
    if (idx === -1) return;
    [category] = categories.splice(idx, 1);
    saveGlobalKeywordCategories(categories);
  } else {
    const ownerId = scopeOwnerId(fromScope);
    const categories = loadProjectKeywordCategories(ownerId);
    const idx = categories.findIndex(c => c.id === id);
    if (idx === -1) return;
    [category] = categories.splice(idx, 1);
    saveProjectKeywordCategories(ownerId, categories);
  }

  if (newScope === 'global') {
    const categories = loadGlobalKeywordCategories();
    categories.push(category);
    saveGlobalKeywordCategories(categories);
  } else {
    const ownerId = scopeOwnerId(newScope);
    const categories = loadProjectKeywordCategories(ownerId);
    categories.push(category);
    saveProjectKeywordCategories(ownerId, categories);
  }

  renderKeywordCategoryList();
  scheduleKeywordDiffRerender();
}

function deleteKeywordCategory(id) {
  const scope = findKeywordCategoryScope(id);
  if (scope === 'global') {
    saveGlobalKeywordCategories(loadGlobalKeywordCategories().filter(c => c.id !== id));
  } else if (scope) {
    const ownerId = scopeOwnerId(scope);
    saveProjectKeywordCategories(ownerId, loadProjectKeywordCategories(ownerId).filter(c => c.id !== id));
  }
  renderKeywordCategoryList();
  scheduleKeywordDiffRerender();
}

/**
 * Sets `enabled` on categories currently visible in the modal (issue #111,
 * extended by issue #113 with a `scope` to target just one store): `scope`
 * 'all' (default) covers every global category plus (when a project is
 * active) its collection's and its own categories — i.e. all entries
 * loadKeywordCategories() would return; 'global' / 'collection' / 'project'
 * restrict the change to just that store (a call for an unavailable scope
 * is a no-op). Writes the affected store(s) in one pass rather than calling
 * updateKeywordCategory() per entry, then re-renders the whole row list and
 * diff in one go.
 */
function setAllKeywordCategoriesEnabled(enabled, scope = 'all') {
  if (scope === 'all' || scope === 'global') {
    const globalCategories = loadGlobalKeywordCategories();
    if (globalCategories.length > 0) {
      for (const c of globalCategories) c.enabled = enabled;
      saveGlobalKeywordCategories(globalCategories);
    }
  }
  for (const owned of OWNED_SETTING_SCOPES) {
    const ownerId = scopeOwnerId(owned);
    if ((scope !== 'all' && scope !== owned) || !ownerId) continue;
    const ownedCategories = loadProjectKeywordCategories(ownerId);
    if (ownedCategories.length > 0) {
      for (const c of ownedCategories) c.enabled = enabled;
      saveProjectKeywordCategories(ownerId, ownedCategories);
    }
  }
  renderKeywordCategoryList();
  scheduleKeywordDiffRerender();
}

renderKeywordCategoryList();
document.getElementById('keyword-category-add-btn').addEventListener('click', addKeywordCategory);
document.getElementById('keyword-category-enable-all-btn').addEventListener('click', () => setAllKeywordCategoriesEnabled(true));
document.getElementById('keyword-category-disable-all-btn').addEventListener('click', () => setAllKeywordCategoriesEnabled(false));
document.getElementById('keyword-category-enable-all-global-btn').addEventListener('click', () => setAllKeywordCategoriesEnabled(true, 'global'));
document.getElementById('keyword-category-disable-all-global-btn').addEventListener('click', () => setAllKeywordCategoriesEnabled(false, 'global'));
document.getElementById('keyword-category-enable-all-project-btn').addEventListener('click', () => setAllKeywordCategoriesEnabled(true, 'project'));
document.getElementById('keyword-category-disable-all-project-btn').addEventListener('click', () => setAllKeywordCategoriesEnabled(false, 'project'));
document.getElementById('keyword-category-enable-all-collection-btn').addEventListener('click', () => setAllKeywordCategoriesEnabled(true, 'collection'));
document.getElementById('keyword-category-disable-all-collection-btn').addEventListener('click', () => setAllKeywordCategoriesEnabled(false, 'collection'));

// Bulk keyword registration: a collapsible form (toggled by "一括登録") that
// splits its textarea into one new category per line and registers them all
// as either global or (if a project is active) that project's own categories.
const keywordBulkForm = document.getElementById('keyword-bulk-form');
const keywordBulkTextarea = document.getElementById('keyword-bulk-textarea');
const keywordBulkScopeSelect = document.getElementById('keyword-bulk-scope-select');

function openKeywordBulkForm() {
  for (const scope of OWNED_SETTING_SCOPES) {
    const option = keywordBulkScopeSelect.querySelector(`option[value="${scope}"]`);
    option.disabled = !scopeOwnerId(scope);
    if (scope === 'collection') option.hidden = option.disabled;
  }
  if (keywordBulkScopeSelect.selectedOptions[0].disabled) keywordBulkScopeSelect.value = 'global';
  keywordBulkTextarea.value = '';
  keywordBulkForm.hidden = false;
  keywordBulkTextarea.focus();
}

function closeKeywordBulkForm() {
  keywordBulkForm.hidden = true;
}

document.getElementById('keyword-category-bulk-btn').addEventListener('click', () => {
  if (keywordBulkForm.hidden) openKeywordBulkForm(); else closeKeywordBulkForm();
});

document.getElementById('keyword-bulk-cancel-btn').addEventListener('click', closeKeywordBulkForm);

document.getElementById('keyword-bulk-submit-btn').addEventListener('click', () => {
  const scope = keywordBulkScopeSelect.value !== 'global' && scopeOwnerId(keywordBulkScopeSelect.value) ? keywordBulkScopeSelect.value : 'global';
  const count = bulkAddKeywordCategories(keywordBulkTextarea.value, scope);
  if (count === 0) return;
  closeKeywordBulkForm();
  renderKeywordCategoryList();
  scheduleKeywordDiffRerender();
});

// ─────────────────────────────────────────────────────────────────────────────
// Keyword line extraction UI (issue #79): each row lets the user edit a
// keyword's text and scope (global vs. the active project only); persists
// across reloads/projects and re-renders the extraction results (debounced)
// whenever a keyword's text changes. Adding/removing/moving a keyword
// re-renders both the row list and the results immediately.
// ─────────────────────────────────────────────────────────────────────────────

/** Which store (global, the active project's collection's, or its own) an extraction keyword id currently lives in, or null if none. */
function findExtractKeywordScope(id) {
  if (loadGlobalExtractKeywords().some(k => k.id === id)) return 'global';
  for (const scope of OWNED_SETTING_SCOPES) {
    const ownerId = scopeOwnerId(scope);
    if (ownerId && loadProjectExtractKeywords(ownerId).some(k => k.id === id)) return scope;
  }
  return null;
}

let extractResultsDebounceTimer = null;
function scheduleExtractResultsRerender() {
  clearTimeout(extractResultsDebounceTimer);
  extractResultsDebounceTimer = setTimeout(renderExtractResults, 200);
}

/** Updates a single keyword's fields in place without rebuilding the row list, so the input being edited keeps focus. */
function updateExtractKeyword(id, patch) {
  const scope = findExtractKeywordScope(id);
  if (!scope) return;
  if (scope === 'global') {
    const keywords = loadGlobalExtractKeywords();
    const entry = keywords.find(k => k.id === id);
    if (!entry) return;
    Object.assign(entry, patch);
    saveGlobalExtractKeywords(keywords);
  } else {
    const ownerId = scopeOwnerId(scope);
    const keywords = loadProjectExtractKeywords(ownerId);
    const entry = keywords.find(k => k.id === id);
    if (!entry) return;
    Object.assign(entry, patch);
    saveProjectExtractKeywords(ownerId, keywords);
  }
  scheduleExtractResultsRerender();
}

/** Moves a keyword between the global, collection and project stores, keeping its id/keyword/fileFilter/caseSensitive/addedOnly. */
function moveExtractKeywordScope(id, newScope) {
  const fromScope = findExtractKeywordScope(id);
  if (!fromScope || fromScope === newScope) return;
  if (newScope !== 'global' && !scopeOwnerId(newScope)) return;

  let entry;
  if (fromScope === 'global') {
    const keywords = loadGlobalExtractKeywords();
    const idx = keywords.findIndex(k => k.id === id);
    if (idx === -1) return;
    [entry] = keywords.splice(idx, 1);
    saveGlobalExtractKeywords(keywords);
  } else {
    const ownerId = scopeOwnerId(fromScope);
    const keywords = loadProjectExtractKeywords(ownerId);
    const idx = keywords.findIndex(k => k.id === id);
    if (idx === -1) return;
    [entry] = keywords.splice(idx, 1);
    saveProjectExtractKeywords(ownerId, keywords);
  }

  if (newScope === 'global') {
    const keywords = loadGlobalExtractKeywords();
    keywords.push(entry);
    saveGlobalExtractKeywords(keywords);
  } else {
    const ownerId = scopeOwnerId(newScope);
    const keywords = loadProjectExtractKeywords(ownerId);
    keywords.push(entry);
    saveProjectExtractKeywords(ownerId, keywords);
  }

  renderExtractKeywordList();
}

function deleteExtractKeyword(id) {
  const scope = findExtractKeywordScope(id);
  if (scope === 'global') {
    saveGlobalExtractKeywords(loadGlobalExtractKeywords().filter(k => k.id !== id));
  } else if (scope) {
    const ownerId = scopeOwnerId(scope);
    saveProjectExtractKeywords(ownerId, loadProjectExtractKeywords(ownerId).filter(k => k.id !== id));
  }
  renderExtractKeywordList();
}

/**
 * Sets `enabled` on keywords currently visible in the modal (issue #109,
 * extended by issue #113 with a `scope` to target just one store): `scope`
 * 'all' (default) covers every global keyword plus (when a project is
 * active) its collection's and its own keywords — i.e. all entries
 * loadExtractKeywords() would return; 'global' / 'collection' / 'project'
 * restrict the change to just that store (a call for an unavailable scope
 * is a no-op). Writes the affected store(s) in one pass rather than calling
 * updateExtractKeyword() per entry, then re-renders the whole row list and
 * results in one go.
 */
function setAllExtractKeywordsEnabled(enabled, scope = 'all') {
  if (scope === 'all' || scope === 'global') {
    const globalKeywords = loadGlobalExtractKeywords();
    if (globalKeywords.length > 0) {
      for (const k of globalKeywords) k.enabled = enabled;
      saveGlobalExtractKeywords(globalKeywords);
    }
  }
  for (const owned of OWNED_SETTING_SCOPES) {
    const ownerId = scopeOwnerId(owned);
    if ((scope !== 'all' && scope !== owned) || !ownerId) continue;
    const ownedKeywords = loadProjectExtractKeywords(ownerId);
    if (ownedKeywords.length > 0) {
      for (const k of ownedKeywords) k.enabled = enabled;
      saveProjectExtractKeywords(ownerId, ownedKeywords);
    }
  }
  renderExtractKeywordList();
}

/** New keywords always start global; move them to the active project via the scope selector afterwards. */
function addExtractKeyword() {
  const keywords = loadGlobalExtractKeywords();
  keywords.push({ id: generateExtractKeywordId(), keyword: '', fileFilter: '', caseSensitive: false, addedOnly: false, enabled: true });
  saveGlobalExtractKeywords(keywords);
  renderExtractKeywordList();
}

function buildExtractKeywordRow(entry) {
  const row = document.createElement('div');
  row.className = 'extract-keyword-row';
  if (entry.enabled === false) row.classList.add('extract-keyword-row-disabled');

  // Enable/disable toggle (issue #109): lets a keyword be switched off without
  // deleting it. Disabled entries are skipped by renderExtractResults(), so
  // their "抽出結果" section disappears too.
  const enableToggle = document.createElement('input');
  enableToggle.type = 'checkbox';
  enableToggle.className = 'extract-keyword-enable-toggle';
  enableToggle.checked = entry.enabled !== false;
  enableToggle.title = 'このキーワードの抽出を有効にする';
  enableToggle.setAttribute('aria-label', 'このキーワードの抽出を有効にする');
  enableToggle.addEventListener('change', () => {
    updateExtractKeyword(entry.id, { enabled: enableToggle.checked });
    row.classList.toggle('extract-keyword-row-disabled', !enableToggle.checked);
  });

  const keywordInput = document.createElement('input');
  keywordInput.type = 'text';
  keywordInput.className = 'extract-keyword-input';
  keywordInput.value = entry.keyword;
  keywordInput.placeholder = '例: TODO, FIXME';
  keywordInput.title = 'カンマ区切りで複数指定できます（大文字小文字の区別は右の「Aa」で切り替えられます）';
  keywordInput.setAttribute('aria-label', 'キーワード（カンマ区切り）');
  keywordInput.addEventListener('input', () => {
    updateExtractKeyword(entry.id, { keyword: keywordInput.value });
  });

  // Case-sensitivity toggle (issue #95): off (the default, and the app's
  // historical behavior) matches keywords ignoring case; on matches their
  // exact case. Does not affect the fileFilter match above, which always
  // stays case-insensitive.
  const caseToggleLabel = document.createElement('label');
  caseToggleLabel.className = 'extract-keyword-case-label';
  caseToggleLabel.title = 'オンにすると、キーワードの大文字小文字を区別して一致させます（オフなら区別しません）';

  const caseToggle = document.createElement('input');
  caseToggle.type = 'checkbox';
  caseToggle.className = 'extract-keyword-case-toggle';
  caseToggle.checked = !!entry.caseSensitive;
  caseToggle.setAttribute('aria-label', 'このキーワードで大文字小文字を区別する');
  caseToggle.addEventListener('change', () => {
    updateExtractKeyword(entry.id, { caseSensitive: caseToggle.checked });
  });

  caseToggleLabel.appendChild(caseToggle);
  caseToggleLabel.appendChild(document.createTextNode('Aa'));

  // Added-lines-only toggle (issue #106): off (the default, and the app's
  // historical behavior) scans both added and removed lines; on restricts
  // extraction to added lines (those starting with '+') only.
  const addedOnlyToggleLabel = document.createElement('label');
  addedOnlyToggleLabel.className = 'extract-keyword-added-only-label';
  addedOnlyToggleLabel.title = 'オンにすると、追加された行（+ で始まる行）のみを抽出対象にします';

  const addedOnlyToggle = document.createElement('input');
  addedOnlyToggle.type = 'checkbox';
  addedOnlyToggle.className = 'extract-keyword-added-only-toggle';
  addedOnlyToggle.checked = !!entry.addedOnly;
  addedOnlyToggle.setAttribute('aria-label', 'このキーワードで追加された行のみを対象にする');
  addedOnlyToggle.addEventListener('change', () => {
    updateExtractKeyword(entry.id, { addedOnly: addedOnlyToggle.checked });
  });

  addedOnlyToggleLabel.appendChild(addedOnlyToggle);
  addedOnlyToggleLabel.appendChild(document.createTextNode('+のみ'));

  // File filter (issue #92): restricts extraction to files whose path
  // contains this text (plain case-insensitive partial match, same rule as
  // keyword matching). Left empty (the default), every file is scanned.
  const fileFilterInput = document.createElement('input');
  fileFilterInput.type = 'text';
  fileFilterInput.className = 'extract-keyword-file-input';
  fileFilterInput.value = entry.fileFilter;
  fileFilterInput.placeholder = '対象ファイル名（任意）';
  fileFilterInput.title = 'ファイルパスの部分一致で絞り込みます（大文字小文字は区別しません）。未入力なら全ファイルが対象です';
  fileFilterInput.setAttribute('aria-label', '対象ファイル名（部分一致、未入力なら全ファイル）');
  fileFilterInput.addEventListener('input', () => {
    updateExtractKeyword(entry.id, { fileFilter: fileFilterInput.value });
  });

  // Scope selector (issue #79): choose whether this keyword is shared by
  // every project ('global', stored in SK_EXTRACT_KEYWORDS) or private to
  // the currently active project ('project', stored in
  // SK_PROJECT_EXTRACT_KEYWORDS). The "プロジェクト" option is disabled with
  // no active project, mirroring the keyword-highlight category scope select.
  const scopeSelect = document.createElement('select');
  scopeSelect.className = 'extract-keyword-scope-select';
  scopeSelect.setAttribute('aria-label', '適用範囲（全体設定・このコレクション・このプロジェクトのみ）');
  scopeSelect.title = '全体設定にするか、現在のコレクション・プロジェクトだけの設定にするかを選べます';
  appendSettingScopeOptions(scopeSelect);

  scopeSelect.value = entry.scope;
  scopeSelect.addEventListener('change', () => {
    moveExtractKeywordScope(entry.id, scopeSelect.value);
  });

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'extract-keyword-remove-btn';
  removeBtn.title = 'このキーワードを削除';
  removeBtn.setAttribute('aria-label', 'キーワードを削除');
  removeBtn.textContent = '×';
  removeBtn.addEventListener('click', () => deleteExtractKeyword(entry.id));

  row.appendChild(enableToggle);
  row.appendChild(keywordInput);
  row.appendChild(caseToggleLabel);
  row.appendChild(addedOnlyToggleLabel);
  row.appendChild(fileFilterInput);
  row.appendChild(scopeSelect);
  row.appendChild(removeBtn);
  return row;
}

/**
 * Copies one extraction entry's matched lines to the clipboard as plain
 * text (issue #106), one match per line formatted as `filePath: +/-content`.
 * Briefly swaps the triggering button's label to confirm success, or alerts
 * on failure (e.g. clipboard permission denied).
 */
async function copyExtractMatchesToClipboard(matches, button) {
  const text = matches.map(m => `${m.filePath}: ${m.prefix}${m.content}`).join('\n');
  try {
    await navigator.clipboard.writeText(text);
    const original = button.textContent;
    button.textContent = '✓ コピーしました';
    button.disabled = true;
    setTimeout(() => {
      button.textContent = original;
      button.disabled = false;
    }, 1500);
  } catch (e) {
    console.error('Failed to copy extraction results to clipboard:', e);
    alert('クリップボードへのコピーに失敗しました。');
  }
}

/** Builds one result section (heading + matching-line list) for a single keyword entry. */
function buildExtractResultSection(entry) {
  const section = document.createElement('div');
  section.className = 'extract-result-section';

  const matches = extractKeywordMatches(entry.keyword, entry.fileFilter, entry.caseSensitive, entry.addedOnly);

  const heading = document.createElement('div');
  heading.className = 'extract-result-heading';

  const headingText = document.createElement('span');
  headingText.className = 'extract-result-heading-text';
  const fileFilterSuffix = entry.fileFilter.trim() ? ` [対象ファイル: ${entry.fileFilter.trim()}]` : '';
  const addedOnlySuffix = entry.addedOnly ? ' [追加行のみ]' : '';
  headingText.textContent = `${entry.keyword}${fileFilterSuffix}${addedOnlySuffix}（${matches.length}件）`;
  heading.appendChild(headingText);

  // Copy-to-clipboard button (issue #106): copies this entry's matched lines
  // as plain text so they can be pasted elsewhere.
  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = 'extract-result-copy-btn';
  copyBtn.textContent = '📋 コピー';
  copyBtn.title = '抽出結果をクリップボードにコピー';
  copyBtn.setAttribute('aria-label', `${entry.keyword} の抽出結果をクリップボードにコピー`);
  copyBtn.disabled = matches.length === 0;
  copyBtn.addEventListener('click', () => copyExtractMatchesToClipboard(matches, copyBtn));
  heading.appendChild(copyBtn);

  section.appendChild(heading);

  if (matches.length === 0) {
    const none = document.createElement('div');
    none.className = 'extract-result-none';
    none.textContent = '一致する行はありません。';
    section.appendChild(none);
    return section;
  }

  const list = document.createElement('div');
  list.className = 'extract-result-list';
  for (const m of matches) {
    const line = document.createElement('div');
    line.className = `extract-result-line ${m.prefix === '+' ? 'extract-result-line-added' : 'extract-result-line-removed'}`;

    const file = document.createElement('span');
    file.className = 'extract-result-file';
    file.textContent = m.filePath;

    const text = document.createElement('span');
    text.className = 'extract-result-text';
    text.textContent = `${m.prefix}${m.content}`;

    line.appendChild(file);
    line.appendChild(text);
    list.appendChild(line);
  }
  section.appendChild(list);
  return section;
}

/**
 * Rebuilds the "抽出結果" area: one section per registered, non-empty keyword.
 * Called on every renderDiff(), but the actual keyword-matching scan is
 * skipped while the extraction modal is closed (openExtractModal() rebuilds
 * it on open via renderExtractKeywordList()), so a large diff with many
 * registered keywords doesn't pay that cost on every render. Checked via
 * getElementById() rather than isExtractModalOpen() — this function's first
 * call happens at module-init time (see renderExtractKeywordList() below),
 * before the `extractModalOverlay` const it reads is declared.
 */
function renderExtractResults() {
  const container = document.getElementById('extract-results');
  container.innerHTML = '';

  if (!document.getElementById('extract-modal-overlay').classList.contains('active')) return;

  if (!app.parsedDiff) {
    const empty = document.createElement('div');
    empty.className = 'extract-results-empty';
    empty.textContent = 'diffファイルを読み込むと抽出結果が表示されます。';
    container.appendChild(empty);
    return;
  }

  const keywords = loadExtractKeywords().filter(k => parseKeywords(k.keyword).length > 0 && k.enabled !== false);
  if (keywords.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'extract-results-empty';
    empty.textContent = 'キーワードを登録すると、一致する差分行がここに一覧表示されます。';
    container.appendChild(empty);
    return;
  }

  for (const entry of keywords) container.appendChild(buildExtractResultSection(entry));
}

function renderExtractKeywordList() {
  const container = document.getElementById('extract-keywords');
  container.innerHTML = '';
  for (const scope of OWNED_SETTING_SCOPES) {
    const unavailable = !scopeOwnerId(scope);
    document.getElementById(`extract-keyword-enable-all-${scope}-btn`).disabled = unavailable;
    document.getElementById(`extract-keyword-disable-all-${scope}-btn`).disabled = unavailable;
  }
  document.getElementById('extract-keyword-collection-toggle-group').hidden = !scopeOwnerId('collection');
  const keywords = loadExtractKeywords();
  if (keywords.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'extract-keywords-empty';
    empty.textContent = 'キーワードがありません。「+ キーワード」から追加してください。';
    container.appendChild(empty);
  } else {
    for (const entry of keywords) container.appendChild(buildExtractKeywordRow(entry));
  }
  renderExtractResults();
}

renderExtractKeywordList();
document.getElementById('extract-keyword-add-btn').addEventListener('click', addExtractKeyword);
document.getElementById('extract-keyword-enable-all-btn').addEventListener('click', () => setAllExtractKeywordsEnabled(true));
document.getElementById('extract-keyword-disable-all-btn').addEventListener('click', () => setAllExtractKeywordsEnabled(false));
document.getElementById('extract-keyword-enable-all-global-btn').addEventListener('click', () => setAllExtractKeywordsEnabled(true, 'global'));
document.getElementById('extract-keyword-disable-all-global-btn').addEventListener('click', () => setAllExtractKeywordsEnabled(false, 'global'));
document.getElementById('extract-keyword-enable-all-project-btn').addEventListener('click', () => setAllExtractKeywordsEnabled(true, 'project'));
document.getElementById('extract-keyword-disable-all-project-btn').addEventListener('click', () => setAllExtractKeywordsEnabled(false, 'project'));
document.getElementById('extract-keyword-enable-all-collection-btn').addEventListener('click', () => setAllExtractKeywordsEnabled(true, 'collection'));
document.getElementById('extract-keyword-disable-all-collection-btn').addEventListener('click', () => setAllExtractKeywordsEnabled(false, 'collection'));

// Keyword line extraction modal open/close (issue #79): independent of the
// settings modal above — its own overlay/backdrop-click/Escape handling.
const extractModalOverlay = document.getElementById('extract-modal-overlay');

function isExtractModalOpen() {
  return extractModalOverlay.classList.contains('active');
}

function openExtractModal() {
  // Mark the modal active before rendering: renderExtractKeywordList() (via
  // renderExtractResults()) only does its keyword-matching scan while the
  // modal is active (see renderExtractResults()'s doc comment).
  extractModalOverlay.classList.add('active');
  renderExtractKeywordList();
  document.getElementById('extract-modal-open-btn').setAttribute('aria-expanded', 'true');
  document.getElementById('extract-modal-close').focus();
}

function closeExtractModal() {
  extractModalOverlay.classList.remove('active');
  const openBtn = document.getElementById('extract-modal-open-btn');
  openBtn.setAttribute('aria-expanded', 'false');
  if (extractModalOverlay.contains(document.activeElement)) openBtn.focus();
}

document.getElementById('extract-modal-open-btn').addEventListener('click', openExtractModal);
document.getElementById('extract-modal-close').addEventListener('click', closeExtractModal);
extractModalOverlay.addEventListener('click', (e) => {
  if (e.target === extractModalOverlay) closeExtractModal();
});
