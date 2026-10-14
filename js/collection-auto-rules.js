'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Collection auto-add rules — data layer (issue #132)
// ─────────────────────────────────────────────────────────────────────────────
// Global list of regular expressions matched, top to bottom, against a newly
// created project's file name (extension included). The first rule that
// matches names the collection: its capture group 1, or the whole match when
// the pattern has no groups (trimmed; an empty name counts as no match). The
// project joins the oldest collection with exactly that name, or a new one.
// Only createNewProject() runs the rules automatically; projects already in a
// collection are left alone, and existing projects can be matched in bulk
// from the settings modal.
// ─────────────────────────────────────────────────────────────────────────────
function generateCollectionAutoRuleId() {
  return `car_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

/** Compiles a rule pattern (no flags); throws a SyntaxError for an invalid one. */
function compileCollectionAutoRulePattern(pattern) {
  return new RegExp(pattern);
}

function sanitizeCollectionAutoRules(raw) {
  if (!Array.isArray(raw)) return [];
  const seenIds = new Set();
  const result = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object' || typeof r.id !== 'string' || !r.id || seenIds.has(r.id)) continue;
    if (typeof r.pattern !== 'string' || !r.pattern) continue;
    try {
      compileCollectionAutoRulePattern(r.pattern);
    } catch (e) {
      continue;
    }
    seenIds.add(r.id);
    result.push({ id: r.id, pattern: r.pattern });
  }
  return result;
}

function loadCollectionAutoRules() {
  try {
    return sanitizeCollectionAutoRules(JSON.parse(localStorage.getItem(SK_COLLECTION_AUTO_RULES) || '[]'));
  } catch (e) {
    console.error('Failed to parse collection auto rules from localStorage:', e);
    return [];
  }
}

function saveCollectionAutoRules(rules) {
  try {
    localStorage.setItem(SK_COLLECTION_AUTO_RULES, JSON.stringify(rules));
  } catch (e) {
    console.error('Failed to save collection auto rules to localStorage:', e);
    alert('コレクション自動追加ルールの保存に失敗しました。ストレージの容量が不足している可能性があります。');
  }
}

/** Merges imported rules by id (same policy as the other global settings). */
function mergeImportedCollectionAutoRules(raw) {
  const imported = sanitizeCollectionAutoRules(raw);
  if (imported.length === 0) return;
  const byId = new Map(loadCollectionAutoRules().map(r => [r.id, r]));
  for (const r of imported) byId.set(r.id, r);
  saveCollectionAutoRules([...byId.values()]);
}

/** Collection name one regex yields for a file name, or null when it doesn't match (or yields an empty name). */
function collectionNameFromRegex(regex, fileName) {
  const m = fileName.match(regex);
  if (!m) return null;
  const raw = m.length > 1 ? m[1] : m[0];
  const name = typeof raw === 'string' ? raw.trim() : '';
  return name || null;
}

/** First rule that names a collection for the file name: { index, rule, name }, or null. */
function matchCollectionAutoRules(fileName, rules = loadCollectionAutoRules()) {
  for (let i = 0; i < rules.length; i++) {
    let regex;
    try {
      regex = compileCollectionAutoRulePattern(rules[i].pattern);
    } catch (e) {
      continue;
    }
    const name = collectionNameFromRegex(regex, fileName);
    if (name) return { index: i, rule: rules[i], name };
  }
  return null;
}

/** ID of the oldest collection named exactly `name`, creating one if there's none. */
function findOrCreateCollectionByName(name) {
  const collections = loadCollections();
  const existing = collections
    .filter(c => c.name === name)
    .sort((a, b) => a.createdAt - b.createdAt)[0];
  if (existing) return existing.id;
  const collection = { id: generateCollectionId(), name, createdAt: Date.now() };
  saveCollections([...collections, collection]);
  return collection.id;
}

/**
 * Puts a project that isn't in a collection yet into the one its file name
 * maps to. Returns the collection name, or null when nothing was done.
 * Callers re-render (refreshAfterCollectionChange() or their own renders).
 */
function applyCollectionAutoRulesToProject(projectId, rules = loadCollectionAutoRules()) {
  if (rules.length === 0 || getProjectCollectionId(projectId)) return null;
  const proj = loadProjects().find(p => p.id === projectId);
  if (!proj) return null;
  const match = matchCollectionAutoRules(proj.fileName, rules);
  if (!match) return null;
  attachProjectToCollection(projectId, findOrCreateCollectionByName(match.name));
  return match.name;
}

/** Applies the rules to every project not in a collection (oldest first, so the oldest one's review statuses win), after a confirm(). */
function applyCollectionAutoRulesToExistingProjects() {
  const rules = loadCollectionAutoRules();
  if (rules.length === 0) {
    alert('コレクション自動追加ルールが登録されていません。');
    return;
  }
  const targets = loadProjects()
    .filter(p => !getProjectCollectionId(p.id))
    .sort((a, b) => a.createdAt - b.createdAt)
    .map(p => ({ project: p, match: matchCollectionAutoRules(p.fileName, rules) }))
    .filter(t => t.match);
  if (targets.length === 0) {
    alert('ルールにマッチする、コレクション未所属のプロジェクトはありません。');
    return;
  }
  const PREVIEW_LIMIT = 10;
  const lines = targets.slice(0, PREVIEW_LIMIT).map(t => `・${t.project.fileName} → ${t.match.name}`);
  if (targets.length > PREVIEW_LIMIT) lines.push(`…ほか ${targets.length - PREVIEW_LIMIT} 件`);
  if (!confirm(
    `コレクション未所属の ${targets.length} 件のプロジェクトをルールに従ってコレクションに追加します。\n` +
    'レビュー状態・行コメント・メモはコレクションに統合されます（同じハンクのレビュー状態はコレクション側を優先）。\n\n' +
    lines.join('\n') + '\n\nよろしいですか？'
  )) return;
  for (const t of targets) applyCollectionAutoRulesToProject(t.project.id, rules);
  refreshAfterCollectionChange();
  alert(`${targets.length} 件のプロジェクトをコレクションに追加しました。`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Collection auto-add rules — settings modal UI
// ─────────────────────────────────────────────────────────────────────────────
function setCollectionAutoRuleError(message) {
  const el = document.getElementById('collection-auto-rule-error');
  el.textContent = message;
  el.hidden = !message;
}

function renderCollectionAutoRuleList() {
  const rules = loadCollectionAutoRules();
  const listEl = document.getElementById('collection-auto-rule-list');
  listEl.innerHTML = '';
  rules.forEach((rule, i) => {
    const li = document.createElement('li');
    li.className = 'collection-auto-rule-item';

    const indexEl = document.createElement('span');
    indexEl.className = 'collection-auto-rule-index';
    indexEl.textContent = `${i + 1}.`;
    const patternEl = document.createElement('code');
    patternEl.className = 'collection-auto-rule-pattern';
    patternEl.textContent = rule.pattern;
    patternEl.title = rule.pattern;
    li.append(indexEl, patternEl);

    const addBtn = (label, ariaLabel, disabled, onClick) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'folder-btn collection-auto-rule-btn';
      btn.textContent = label;
      btn.setAttribute('aria-label', ariaLabel);
      btn.title = ariaLabel;
      btn.disabled = disabled;
      btn.addEventListener('click', onClick);
      li.appendChild(btn);
    };
    addBtn('↑', `ルール${i + 1}を上へ移動`, i === 0, () => moveCollectionAutoRule(rule.id, -1));
    addBtn('↓', `ルール${i + 1}を下へ移動`, i === rules.length - 1, () => moveCollectionAutoRule(rule.id, 1));
    addBtn('✕', `ルール${i + 1}を削除`, false, () => deleteCollectionAutoRule(rule.id));
    listEl.appendChild(li);
  });
  document.getElementById('collection-auto-rule-empty').hidden = rules.length > 0;
  document.getElementById('collection-auto-rule-apply-btn').disabled = rules.length === 0;
  renderCollectionAutoRuleTest();
}

/** Shows which registered rule (and the pattern being typed, if valid) the test file name maps to. */
function renderCollectionAutoRuleTest() {
  const fileName = document.getElementById('collection-auto-rule-test-input').value;
  const resultEl = document.getElementById('collection-auto-rule-test-result');
  if (!fileName) {
    resultEl.textContent = '';
    resultEl.hidden = true;
    return;
  }
  const lines = [];
  const match = matchCollectionAutoRules(fileName);
  lines.push(match
    ? `→ ルール${match.index + 1}にマッチ：コレクション「${match.name}」`
    : '→ 登録済みのルールにはマッチしません');
  const pattern = document.getElementById('collection-auto-rule-input').value;
  if (pattern) {
    try {
      const name = collectionNameFromRegex(compileCollectionAutoRulePattern(pattern), fileName);
      lines.push(name
        ? `→ 入力中の正規表現：コレクション「${name}」`
        : '→ 入力中の正規表現：マッチしません');
    } catch (e) {
      // The error itself is reported on submit; just skip the preview.
    }
  }
  resultEl.textContent = lines.join('\n');
  resultEl.hidden = false;
}

function addCollectionAutoRule() {
  const input = document.getElementById('collection-auto-rule-input');
  const pattern = input.value;
  if (!pattern.trim()) {
    setCollectionAutoRuleError('正規表現を入力してください。');
    return;
  }
  try {
    compileCollectionAutoRulePattern(pattern);
  } catch (e) {
    setCollectionAutoRuleError(`不正な正規表現です: ${e.message}`);
    return;
  }
  const rules = loadCollectionAutoRules();
  if (rules.some(r => r.pattern === pattern)) {
    setCollectionAutoRuleError('同じ正規表現が既に登録されています。');
    return;
  }
  saveCollectionAutoRules([...rules, { id: generateCollectionAutoRuleId(), pattern }]);
  scheduleSettingsAutoSave();
  input.value = '';
  setCollectionAutoRuleError('');
  renderCollectionAutoRuleList();
}

function moveCollectionAutoRule(ruleId, delta) {
  const rules = loadCollectionAutoRules();
  const i = rules.findIndex(r => r.id === ruleId);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= rules.length) return;
  [rules[i], rules[j]] = [rules[j], rules[i]];
  saveCollectionAutoRules(rules);
  scheduleSettingsAutoSave();
  renderCollectionAutoRuleList();
}

function deleteCollectionAutoRule(ruleId) {
  const rules = loadCollectionAutoRules();
  const rule = rules.find(r => r.id === ruleId);
  if (!rule || !confirm(`ルール「${rule.pattern}」を削除しますか？\n（既にコレクションに追加されたプロジェクトはそのままです）`)) return;
  saveCollectionAutoRules(rules.filter(r => r.id !== ruleId));
  scheduleSettingsAutoSave();
  renderCollectionAutoRuleList();
}

document.getElementById('collection-auto-rule-add-btn').addEventListener('click', addCollectionAutoRule);
document.getElementById('collection-auto-rule-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.isComposing) {
    e.preventDefault();
    addCollectionAutoRule();
  }
});
document.getElementById('collection-auto-rule-input').addEventListener('input', () => {
  setCollectionAutoRuleError('');
  renderCollectionAutoRuleTest();
});
document.getElementById('collection-auto-rule-test-input').addEventListener('input', renderCollectionAutoRuleTest);
document.getElementById('collection-auto-rule-apply-btn').addEventListener('click', applyCollectionAutoRulesToExistingProjects);
renderCollectionAutoRuleList();
