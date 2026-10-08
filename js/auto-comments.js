'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Auto line comments
//
// Each rule pairs a keyword (comma-separated, OR — parsed via parseKeywords())
// with a comment text. Every added/removed diff line matching the rule (the
// same matching as keyword line extraction: plain substring search,
// case-insensitive unless `caseSensitive`, optional `addedOnly` and
// `fileFilter`) gets a line comment with that text, marked with the rule's id
// (LineComment.autoRuleId). Rules run automatically whenever a diff file is
// loaded/reloaded into a project (createNewProject()/updateExistingProject()),
// and manually via the modal's "今すぐ適用" button.
//
// Repeated runs must not add the same comment twice, and a comment the user
// deleted must not come back, so applyAutoLineComments() skips a
// (rule, filePath, hunk hash, line index) when any of these holds:
// - SK_AUTO_COMMENT_APPLIED already records that rule for that line;
// - the line already has a comment from the same rule;
// - the line already has a comment with exactly the same text.
// Each line a rule matched is recorded in SK_AUTO_COMMENT_APPLIED (even when
// skipped for the latter two reasons). Because the key includes the hunk
// hash, a hunk whose content changed counts as new and is commented again.
//
// Rules have the same global/project scope split as extraction keywords:
// SK_AUTO_COMMENT_RULES holds a JSON-encoded array of
// { id, keyword, comment, fileFilter, caseSensitive, addedOnly, enabled }
// rules, SK_PROJECT_AUTO_COMMENT_RULES a { [projectId]: rule[] } map.
// ─────────────────────────────────────────────────────────────────────────────

function generateAutoCommentRuleId() {
  return `acr_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

/** Keep only well-formed rules; drop anything with an unexpected shape. */
function sanitizeAutoCommentRules(rawList) {
  if (!Array.isArray(rawList)) return [];
  const result = [];
  for (const r of rawList) {
    if (!r || typeof r !== 'object' || typeof r.keyword !== 'string') continue;
    result.push({
      id: typeof r.id === 'string' && r.id ? r.id : generateAutoCommentRuleId(),
      keyword: r.keyword,
      comment: typeof r.comment === 'string' ? r.comment : '',
      fileFilter: typeof r.fileFilter === 'string' ? r.fileFilter : '',
      caseSensitive: r.caseSensitive === true,
      addedOnly: r.addedOnly === true,
      enabled: r.enabled !== false,
    });
  }
  return result;
}

function loadGlobalAutoCommentRules() {
  try {
    return sanitizeAutoCommentRules(JSON.parse(localStorage.getItem(SK_AUTO_COMMENT_RULES) || '[]'));
  } catch (e) {
    console.error('Failed to load auto comment rules from localStorage:', e);
    return [];
  }
}

function saveGlobalAutoCommentRules(rules) {
  try {
    localStorage.setItem(SK_AUTO_COMMENT_RULES, JSON.stringify(rules));
  } catch (e) {
    console.error('Failed to save auto comment rules to localStorage:', e);
    alert('自動行コメントのルールの保存に失敗しました。ストレージの容量が不足している可能性があります。');
  }
}

// Same prototype-pollution defense as sanitizeProjectExtractKeywordsMap().
function sanitizeProjectAutoCommentRulesMap(parsed) {
  const safe = Object.create(null);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return safe;
  for (const pid of Object.keys(parsed)) {
    const rules = sanitizeAutoCommentRules(parsed[pid]);
    if (rules.length > 0) safe[pid] = rules;
  }
  return safe;
}

function loadAllProjectAutoCommentRules() {
  try {
    return sanitizeProjectAutoCommentRulesMap(JSON.parse(localStorage.getItem(SK_PROJECT_AUTO_COMMENT_RULES) || '{}'));
  } catch (e) {
    console.error('Failed to load project auto comment rules from localStorage:', e);
    return Object.create(null);
  }
}

function saveAllProjectAutoCommentRules(byProjectId) {
  try {
    localStorage.setItem(SK_PROJECT_AUTO_COMMENT_RULES, JSON.stringify(byProjectId));
  } catch (e) {
    console.error('Failed to save project auto comment rules to localStorage:', e);
    alert('自動行コメントのルールの保存に失敗しました。ストレージの容量が不足している可能性があります。');
  }
}

function loadProjectAutoCommentRules(projectId) {
  if (!projectId) return [];
  return loadAllProjectAutoCommentRules()[projectId] || [];
}

function saveProjectAutoCommentRules(projectId, rules) {
  if (!projectId) return;
  const all = loadAllProjectAutoCommentRules();
  all[projectId] = rules;
  saveAllProjectAutoCommentRules(all);
}

/** Merged, scope-tagged view (global + the active project's collection's + its own rules), like loadExtractKeywords(). */
function loadAutoCommentRules() {
  const result = loadGlobalAutoCommentRules().map(r => ({ ...r, scope: 'global' }));
  for (const scope of OWNED_SETTING_SCOPES) {
    const ownerId = scopeOwnerId(scope);
    if (ownerId) result.push(...loadProjectAutoCommentRules(ownerId).map(r => ({ ...r, scope })));
  }
  return result;
}

/**
 * Rebuild the applied-rule log with validated shapes and null-prototype maps
 * (it may come from imported JSON). Same nesting as SK_LINE_COMMENTS, with
 * a de-duplicated rule-id array as each leaf; empty leaves are dropped.
 */
function sanitizeAutoCommentAppliedData(parsed) {
  const safe = Object.create(null);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return safe;
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
          const ids = [...new Set(lineMap[idx].filter(id => typeof id === 'string' && id))];
          if (ids.length > 0) safeLines[idx] = ids;
        }
        if (Object.keys(safeLines).length > 0) safeHashes[h] = safeLines;
      }
      if (Object.keys(safeHashes).length > 0) safeFiles[fp] = safeHashes;
    }
    if (Object.keys(safeFiles).length > 0) safe[pid] = safeFiles;
  }
  return safe;
}

function loadAllAutoCommentApplied() {
  try {
    return sanitizeAutoCommentAppliedData(JSON.parse(localStorage.getItem(SK_AUTO_COMMENT_APPLIED) || '{}'));
  } catch (e) {
    console.error('Failed to load auto comment log from localStorage:', e);
    return Object.create(null);
  }
}

function saveAllAutoCommentApplied(applied) {
  try {
    localStorage.setItem(SK_AUTO_COMMENT_APPLIED, JSON.stringify(applied));
  } catch (e) {
    console.error('Failed to save auto comment log to localStorage:', e);
    alert('自動行コメントの適用履歴の保存に失敗しました。ストレージの容量が不足している可能性があります。\n削除した自動コメントが再び追加されることがあります。');
  }
}

/** Drops a deleted project's own auto rules and applied-rule log; global rules are untouched. */
function deleteAutoCommentDataForProject(projectId) {
  const rules = loadAllProjectAutoCommentRules();
  if (projectId in rules) {
    delete rules[projectId];
    saveAllProjectAutoCommentRules(rules);
  }
  const applied = loadAllAutoCommentApplied();
  if (projectId in applied) {
    delete applied[projectId];
    saveAllAutoCommentApplied(applied);
  }
}

/** Returns obj[key], creating it as a null-prototype object (or `[]` when `asArray`) first if missing. */
function ensureChild(obj, key, asArray = false) {
  if (!obj[key]) obj[key] = asArray ? [] : Object.create(null);
  return obj[key];
}

/**
 * Runs every enabled, non-empty auto rule against the current project's
 * loaded diff (app.parsedDiff) and adds the resulting line comments,
 * skipping lines already handled (see this section's header comment).
 * Saves only when something changed. Does not re-render.
 * @returns {number} number of comments added
 */
function applyAutoLineComments() {
  const pid = currentStateOwnerId();
  if (!pid || !app.parsedDiff) return 0;
  const rules = loadAutoCommentRules()
    .map(r => {
      const keywords = parseKeywords(r.keyword);
      return {
        ...r,
        matchKeywords: r.caseSensitive ? keywords : keywords.map(kw => kw.toLowerCase()),
        lowerFileFilter: r.fileFilter.trim().toLowerCase(),
        text: r.comment.trim(),
      };
    })
    .filter(r => r.enabled && r.matchKeywords.length > 0 && r.text);
  if (rules.length === 0) return 0;

  const allComments = loadAllLineComments();
  const allApplied = loadAllAutoCommentApplied();
  let added = 0;
  let logChanged = false;

  for (const file of app.parsedDiff) {
    const lowerPath = file.filePath.toLowerCase();
    const fileRules = rules.filter(r => !r.lowerFileFilter || lowerPath.includes(r.lowerFileFilter));
    if (fileRules.length === 0) continue;
    for (const hunk of file.hunks) {
      for (const record of computeLineRecords(hunk)) {
        if (record.type !== '+' && record.type !== '-') continue;
        let lowerContent = null;
        for (const rule of fileRules) {
          if (rule.addedOnly && record.type !== '+') continue;
          let content = record.content;
          if (!rule.caseSensitive) {
            if (lowerContent === null) lowerContent = record.content.toLowerCase();
            content = lowerContent;
          }
          if (!rule.matchKeywords.some(kw => content.includes(kw))) continue;

          const appliedIds = ensureChild(ensureChild(ensureChild(ensureChild(allApplied, pid), file.filePath), hunk.hash), record.idx, true);
          if (appliedIds.includes(rule.id)) continue;
          appliedIds.push(rule.id);
          logChanged = true;

          const projectComments = allComments[pid];
          const existing = (projectComments && projectComments[file.filePath] && projectComments[file.filePath][hunk.hash] &&
            projectComments[file.filePath][hunk.hash][record.idx]) || [];
          if (existing.some(c => c.autoRuleId === rule.id || c.text === rule.text)) continue;

          const list = ensureChild(ensureChild(ensureChild(ensureChild(allComments, pid), file.filePath), hunk.hash), record.idx, true);
          list.push(createLineCommentObject(record, rule.text, rule.id));
          added++;
        }
      }
    }
  }

  // Comments first: if they fail to save, don't record those lines as done,
  // so the next run can still add them.
  if (added > 0 && !saveAllLineComments(allComments)) return 0;
  if (logChanged) saveAllAutoCommentApplied(allApplied);
  if (logChanged || added > 0) scheduleSettingsAutoSave();
  return added;
}

// ─────────────────────────────────────────────────────────────────────────────
// Auto line comments UI: a modal listing every rule (global + the active
// project's own), editable in place like the extraction keyword rows, plus
// a "今すぐ適用" button that runs applyAutoLineComments() on demand.
// ─────────────────────────────────────────────────────────────────────────────

/** Which store (global, the active project's collection's, or its own) an auto rule id currently lives in, or null if none. */
function findAutoCommentRuleScope(id) {
  if (loadGlobalAutoCommentRules().some(r => r.id === id)) return 'global';
  for (const scope of OWNED_SETTING_SCOPES) {
    const ownerId = scopeOwnerId(scope);
    if (ownerId && loadProjectAutoCommentRules(ownerId).some(r => r.id === id)) return scope;
  }
  return null;
}

/** Updates a single rule's fields in place without rebuilding the row list, so the input being edited keeps focus. */
function updateAutoCommentRule(id, patch) {
  const scope = findAutoCommentRuleScope(id);
  if (scope === 'global') {
    const rules = loadGlobalAutoCommentRules();
    const rule = rules.find(r => r.id === id);
    if (!rule) return;
    Object.assign(rule, patch);
    saveGlobalAutoCommentRules(rules);
  } else if (scope) {
    const ownerId = scopeOwnerId(scope);
    const rules = loadProjectAutoCommentRules(ownerId);
    const rule = rules.find(r => r.id === id);
    if (!rule) return;
    Object.assign(rule, patch);
    saveProjectAutoCommentRules(ownerId, rules);
  } else {
    return;
  }
  scheduleSettingsAutoSave();
}

/** Moves a rule between the global, collection and project stores, keeping its id (so its applied log still matches). */
function moveAutoCommentRuleScope(id, newScope) {
  const fromScope = findAutoCommentRuleScope(id);
  if (!fromScope || fromScope === newScope) return;
  if (newScope !== 'global' && !scopeOwnerId(newScope)) return;

  const fromOwnerId = scopeOwnerId(fromScope);
  const fromRules = fromScope === 'global' ? loadGlobalAutoCommentRules() : loadProjectAutoCommentRules(fromOwnerId);
  const idx = fromRules.findIndex(r => r.id === id);
  if (idx === -1) return;
  const [rule] = fromRules.splice(idx, 1);
  if (fromScope === 'global') saveGlobalAutoCommentRules(fromRules);
  else saveProjectAutoCommentRules(fromOwnerId, fromRules);

  if (newScope === 'global') {
    saveGlobalAutoCommentRules([...loadGlobalAutoCommentRules(), rule]);
  } else {
    const toOwnerId = scopeOwnerId(newScope);
    saveProjectAutoCommentRules(toOwnerId, [...loadProjectAutoCommentRules(toOwnerId), rule]);
  }
  scheduleSettingsAutoSave();
  renderAutoCommentRuleList();
}

/** Deletes a rule. Comments it already added are kept (they're ordinary line comments from then on). */
function deleteAutoCommentRule(id) {
  const scope = findAutoCommentRuleScope(id);
  if (scope === 'global') {
    saveGlobalAutoCommentRules(loadGlobalAutoCommentRules().filter(r => r.id !== id));
  } else if (scope) {
    const ownerId = scopeOwnerId(scope);
    saveProjectAutoCommentRules(ownerId, loadProjectAutoCommentRules(ownerId).filter(r => r.id !== id));
  }
  scheduleSettingsAutoSave();
  renderAutoCommentRuleList();
}

/** New rules always start global; move them to the active project via the scope selector afterwards. */
function addAutoCommentRule() {
  const rules = loadGlobalAutoCommentRules();
  rules.push({ id: generateAutoCommentRuleId(), keyword: '', comment: '', fileFilter: '', caseSensitive: false, addedOnly: false, enabled: true });
  saveGlobalAutoCommentRules(rules);
  scheduleSettingsAutoSave();
  renderAutoCommentRuleList();
}

/** A labelled checkbox (e.g. "Aa", "+のみ") bound to one boolean rule field. */
function buildAutoCommentRuleToggle(rule, field, text, title, ariaLabel) {
  const label = document.createElement('label');
  label.className = 'extract-keyword-case-label';
  label.title = title;
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.className = 'extract-keyword-case-toggle';
  cb.checked = !!rule[field];
  cb.setAttribute('aria-label', ariaLabel);
  cb.addEventListener('change', () => updateAutoCommentRule(rule.id, { [field]: cb.checked }));
  label.appendChild(cb);
  label.appendChild(document.createTextNode(text));
  return label;
}

function buildAutoCommentRuleRow(rule) {
  const wrap = document.createElement('div');
  wrap.className = 'auto-comment-rule';
  if (!rule.enabled) wrap.classList.add('extract-keyword-row-disabled');

  const row = document.createElement('div');
  row.className = 'extract-keyword-row';

  const enableToggle = document.createElement('input');
  enableToggle.type = 'checkbox';
  enableToggle.className = 'extract-keyword-enable-toggle';
  enableToggle.checked = rule.enabled;
  enableToggle.title = 'このルールを有効にする';
  enableToggle.setAttribute('aria-label', 'このルールを有効にする');
  enableToggle.addEventListener('change', () => {
    updateAutoCommentRule(rule.id, { enabled: enableToggle.checked });
    wrap.classList.toggle('extract-keyword-row-disabled', !enableToggle.checked);
  });

  const keywordInput = document.createElement('input');
  keywordInput.type = 'text';
  keywordInput.className = 'extract-keyword-input';
  keywordInput.value = rule.keyword;
  keywordInput.placeholder = 'キーワード 例: TODO, FIXME';
  keywordInput.title = 'カンマ区切りで複数指定できます（いずれかに一致した行が対象）';
  keywordInput.setAttribute('aria-label', 'キーワード（カンマ区切り）');
  keywordInput.addEventListener('input', () => updateAutoCommentRule(rule.id, { keyword: keywordInput.value }));

  const fileFilterInput = document.createElement('input');
  fileFilterInput.type = 'text';
  fileFilterInput.className = 'extract-keyword-file-input';
  fileFilterInput.value = rule.fileFilter;
  fileFilterInput.placeholder = '対象ファイル名（任意）';
  fileFilterInput.title = 'ファイルパスの部分一致で絞り込みます（大文字小文字は区別しません）。未入力なら全ファイルが対象です';
  fileFilterInput.setAttribute('aria-label', '対象ファイル名（部分一致、未入力なら全ファイル）');
  fileFilterInput.addEventListener('input', () => updateAutoCommentRule(rule.id, { fileFilter: fileFilterInput.value }));

  const scopeSelect = document.createElement('select');
  scopeSelect.className = 'extract-keyword-scope-select';
  scopeSelect.setAttribute('aria-label', '適用範囲（全体設定・このコレクション・このプロジェクトのみ）');
  scopeSelect.title = '全体設定にするか、現在のコレクション・プロジェクトだけの設定にするかを選べます';
  appendSettingScopeOptions(scopeSelect);
  scopeSelect.value = rule.scope;
  scopeSelect.addEventListener('change', () => moveAutoCommentRuleScope(rule.id, scopeSelect.value));

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'extract-keyword-remove-btn';
  removeBtn.title = 'このルールを削除（追加済みのコメントは残ります）';
  removeBtn.setAttribute('aria-label', 'ルールを削除');
  removeBtn.textContent = '×';
  removeBtn.addEventListener('click', () => deleteAutoCommentRule(rule.id));

  row.appendChild(enableToggle);
  row.appendChild(keywordInput);
  row.appendChild(buildAutoCommentRuleToggle(rule, 'caseSensitive', 'Aa',
    'オンにすると、キーワードの大文字小文字を区別して一致させます（オフなら区別しません）', 'このルールで大文字小文字を区別する'));
  row.appendChild(buildAutoCommentRuleToggle(rule, 'addedOnly', '+のみ',
    'オンにすると、追加された行（+ で始まる行）のみを対象にします', 'このルールで追加された行のみを対象にする'));
  row.appendChild(fileFilterInput);
  row.appendChild(scopeSelect);
  row.appendChild(removeBtn);

  const commentInput = document.createElement('textarea');
  commentInput.className = 'auto-comment-text-input';
  commentInput.rows = 2;
  commentInput.maxLength = 5000;
  commentInput.value = rule.comment;
  commentInput.placeholder = '一致した行に追加するコメント';
  commentInput.setAttribute('aria-label', '追加するコメント');
  commentInput.addEventListener('input', () => updateAutoCommentRule(rule.id, { comment: commentInput.value }));

  wrap.appendChild(row);
  wrap.appendChild(commentInput);
  return wrap;
}

function renderAutoCommentRuleList() {
  const container = document.getElementById('auto-comment-rules');
  container.innerHTML = '';
  document.getElementById('auto-comment-apply-btn').disabled = !app.parsedDiff;
  const rules = loadAutoCommentRules();
  if (rules.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'extract-keywords-empty';
    empty.textContent = 'ルールがありません。「+ ルール」から追加してください。';
    container.appendChild(empty);
    return;
  }
  for (const rule of rules) container.appendChild(buildAutoCommentRuleRow(rule));
}

/** "今すぐ適用": runs the rules on the current diff and reports how many comments were added. */
function runAutoLineCommentsManually() {
  if (!app.parsedDiff) return;
  const added = applyAutoLineComments();
  if (added > 0) {
    renderDiff();
    refreshMemoBadge();
  }
  const status = document.getElementById('auto-comment-apply-status');
  status.textContent = added > 0 ? `${added} 件の行コメントを追加しました。` : '新たに追加する行コメントはありませんでした。';
}

renderAutoCommentRuleList();
document.getElementById('auto-comment-add-btn').addEventListener('click', addAutoCommentRule);
document.getElementById('auto-comment-apply-btn').addEventListener('click', runAutoLineCommentsManually);

// Auto line comment modal open/close: its own overlay/backdrop-click/Escape handling.
const autoCommentModalOverlay = document.getElementById('auto-comment-modal-overlay');

function isAutoCommentModalOpen() {
  return autoCommentModalOverlay.classList.contains('active');
}

function openAutoCommentModal() {
  autoCommentModalOverlay.classList.add('active');
  document.getElementById('auto-comment-apply-status').textContent = '';
  renderAutoCommentRuleList();
  document.getElementById('auto-comment-modal-open-btn').setAttribute('aria-expanded', 'true');
  document.getElementById('auto-comment-modal-close').focus();
}

function closeAutoCommentModal() {
  autoCommentModalOverlay.classList.remove('active');
  const openBtn = document.getElementById('auto-comment-modal-open-btn');
  openBtn.setAttribute('aria-expanded', 'false');
  if (autoCommentModalOverlay.contains(document.activeElement)) openBtn.focus();
}

document.getElementById('auto-comment-modal-open-btn').addEventListener('click', openAutoCommentModal);
document.getElementById('auto-comment-modal-close').addEventListener('click', closeAutoCommentModal);
autoCommentModalOverlay.addEventListener('click', (e) => {
  if (e.target === autoCommentModalOverlay) closeAutoCommentModal();
});
