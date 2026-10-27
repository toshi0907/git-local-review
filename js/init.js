'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Top bar tooltips
// ─────────────────────────────────────────────────────────────────────────────
// The top bar controls are icon-only, so their descriptions (data-tooltip) are
// shown immediately on hover / keyboard focus in a single shared element that
// is clamped to the viewport (the right-most buttons would otherwise overflow).
// Hover wins over keyboard focus; programmatic focus (e.g. a modal handing focus
// back to its button) is ignored unless it is :focus-visible.
// refreshTopbarTooltip() lives in js/utils.js (see there); initTopbarTooltips()
// attaches its renderer as refreshTopbarTooltip.render.

function initTopbarTooltips() {
  const topbar = document.querySelector('.topbar');
  const tooltip = document.getElementById('topbar-tooltip');
  if (!topbar || !tooltip) return;
  let hovered = null;
  let focused = null;
  let current = null;

  // A <label> host describes its checkbox; other hosts describe themselves.
  const describedEl = (host) => (host.matches('label') ? host.querySelector('input') : host);

  const render = () => {
    const target = hovered || focused;
    if (current && current !== target) {
      const el = describedEl(current);
      if (el) el.removeAttribute('aria-describedby');
    }
    current = target;
    if (!target) {
      tooltip.hidden = true;
      return;
    }
    tooltip.textContent = target.dataset.tooltip;
    tooltip.hidden = false;
    const rect = target.getBoundingClientRect();
    const tipRect = tooltip.getBoundingClientRect();
    const margin = 8;
    const left = Math.min(
      rect.left + rect.width / 2 - tipRect.width / 2,
      window.innerWidth - tipRect.width - margin
    );
    tooltip.style.left = `${Math.max(margin, left)}px`;
    tooltip.style.top = `${rect.bottom + 6}px`;
    // Only point at the tooltip when it adds something beyond the accessible
    // name, so screen readers don't announce the same text twice.
    const el = describedEl(target);
    if (el && el.getAttribute('aria-label') !== target.dataset.tooltip) {
      el.setAttribute('aria-describedby', 'topbar-tooltip');
    } else if (el) {
      el.removeAttribute('aria-describedby');
    }
  };
  refreshTopbarTooltip.render = render;

  topbar.addEventListener('mouseover', (e) => {
    const target = e.target.closest('[data-tooltip]');
    if (target === hovered) return;
    hovered = target;
    render();
  });
  topbar.addEventListener('mouseleave', () => { hovered = null; render(); });
  topbar.addEventListener('focusin', (e) => {
    const target = e.target.closest('[data-tooltip]');
    focused = target && e.target.matches(':focus-visible') ? target : null;
    render();
  });
  topbar.addEventListener('focusout', () => { focused = null; render(); });
  // Clicking opens modals / re-renders; drop the tooltip so it doesn't linger.
  topbar.addEventListener('click', () => { hovered = null; focused = null; render(); });
  // Capture phase, so it still runs when a control stops Escape's propagation
  // (e.g. the text filter clearing its box).
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { hovered = null; focused = null; render(); }
  }, true);
  window.addEventListener('resize', render);
}

// ─────────────────────────────────────────────────────────────────────────────
// Top bar text filter
// ─────────────────────────────────────────────────────────────────────────────
// Typing in the text box re-renders the diff (debounced) to show only hunks
// with a line containing the query; the Aa / .* checkboxes toggle case
// sensitivity and regular-expression matching. Nothing is persisted. An
// invalid regular expression marks the box as invalid and keeps the previous
// filter applied, so the view doesn't flip to unfiltered mid-typing.

const TEXT_FILTER_DEBOUNCE_MS = 150;

function initTextFilter() {
  const input = document.getElementById('text-filter-input');
  const caseCheckbox = document.getElementById('text-filter-case-checkbox');
  const regexCheckbox = document.getElementById('text-filter-regex-checkbox');
  const errorEl = document.getElementById('text-filter-error');
  const defaultTooltip = input.dataset.tooltip;
  let timer = null;

  const apply = () => {
    clearTimeout(timer);
    timer = null;
    const next = {
      query: input.value,
      caseSensitive: caseCheckbox.checked,
      regex: regexCheckbox.checked,
    };
    const invalid = next.regex && next.query !== '' && !compileTextFilterRegex(next);
    input.classList.toggle('invalid', invalid);
    input.setAttribute('aria-invalid', invalid ? 'true' : 'false');
    // Shown inline as well: the tooltip isn't visible after a mouse click.
    errorEl.hidden = !invalid;
    input.dataset.tooltip = invalid ? '正規表現が正しくありません（直前の条件で絞り込んでいます）' : defaultTooltip;
    refreshTopbarTooltip();
    if (invalid) return;

    const prev = app.textFilter;
    app.textFilter = next;
    // Re-render only when the visible result can change (the options are
    // irrelevant while the query is empty).
    const unchanged = prev.query === next.query &&
      (next.query === '' || (prev.caseSensitive === next.caseSensitive && prev.regex === next.regex));
    if (!unchanged) renderDiff();
  };

  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(apply, TEXT_FILTER_DEBOUNCE_MS);
  });
  input.addEventListener('keydown', (e) => {
    // e.isComposing: Escape that cancels an IME conversion must not clear the box.
    if (e.key === 'Escape' && !e.isComposing && input.value !== '') {
      // Clearing the box is this Escape's only effect (don't also close the memo panel).
      e.stopPropagation();
      input.value = '';
      apply();
    }
  });
  caseCheckbox.addEventListener('change', apply);
  regexCheckbox.addEventListener('change', apply);
}

// ─────────────────────────────────────────────────────────────────────────────
// Initialise
// ─────────────────────────────────────────────────────────────────────────────
(async function init() {
  initTopbarTooltips();
  app.viewMode = loadViewMode();
  updateViewModeButtons();
  app.wordDiff = loadWordDiff();
  updateWordDiffCheckbox();

  for (const key of REVIEW_FILTER_KEYS) {
    const checkbox = document.getElementById(`review-filter-${key}`);
    checkbox.checked = !!app.reviewFilter[key];
    checkbox.addEventListener('change', () => {
      app.reviewFilter[key] = checkbox.checked;
      saveReviewFilter(app.reviewFilter);
      renderDiff();
    });
  }

  app.commentFilter = loadCommentFilter();
  const commentFilterCheckbox = document.getElementById('comment-filter-checkbox');
  commentFilterCheckbox.checked = app.commentFilter;
  commentFilterCheckbox.addEventListener('change', () => {
    app.commentFilter = commentFilterCheckbox.checked;
    saveCommentFilter(app.commentFilter);
    renderDiff();
  });

  initTextFilter();

  app.hideDoneLineComments = loadHideDoneLineComments();
  applyLineCommentVisibility();
  // The settings checkbox and the memo panel's toggle share one state (issue #138).
  const setHideDoneLineComments = (enabled) => {
    app.hideDoneLineComments = enabled;
    saveHideDoneLineComments(enabled);
    applyLineCommentVisibility();
  };
  document.getElementById('hide-done-line-comments-checkbox').addEventListener('change', (e) => {
    setHideDoneLineComments(e.target.checked);
  });
  document.getElementById('memo-hide-done-btn').addEventListener('click', () => {
    setHideDoneLineComments(!app.hideDoneLineComments);
  });
  document.getElementById('hide-all-line-comments-btn').addEventListener('click', () => {
    app.hideAllLineComments = !app.hideAllLineComments;
    applyLineCommentVisibility();
  });

  initDiffFontSettings();

  const collectionInitialStateSelect = document.getElementById('collection-initial-state-select');
  collectionInitialStateSelect.value = loadCollectionInitialState();
  // Only affects the next page load; the current open/closed state is left as is.
  collectionInitialStateSelect.addEventListener('change', () => saveCollectionInitialState(collectionInitialStateSelect.value));

  document.getElementById('project-sort-select').value = loadProjectSort();
  await refreshHandleIndex();

  if (supportsFileSystemAccess) {
    await refreshOpenFolderUI();
    await refreshSettingsFolderUI();
    await loadSettingsFromFolderOnStartup();
    startSettingsExternalChangeWatcher();
    startProjectFileUpdateWatcher();
  } else {
    document.getElementById('open-folder-row').style.display = 'none';
    document.getElementById('settings-folder-row').style.display = 'none';
    document.getElementById('settings-save-section').style.display = 'none';
  }

  // Issue #130: with the 'closed' initial state, start every collection
  // collapsed except the one holding the project about to be restored.
  if (loadCollectionInitialState() === 'closed') {
    const activeCollectionId = getProjectCollectionId(localStorage.getItem(SK_CURRENT));
    collapsedCollectionIds = new Set(loadCollections().map(c => c.id).filter(id => id !== activeCollectionId));
  }

  renderProjectList();

  // Restore the last active project selection, and its diff if a copy of the
  // last uploaded file was saved for it.
  const lastId = localStorage.getItem(SK_CURRENT);
  if (lastId) {
    const proj = loadProjects().find(p => p.id === lastId);
    if (proj) {
      app.currentProjectId = lastId;
      renderProjectList();
      // The restored project may have its own keyword categories (issue #68)
      // and extraction keywords (issue #79), which the initial
      // (pre-currentProjectId) renderKeywordCategoryList()/
      // renderExtractKeywordList() calls at script load couldn't have shown yet.
      renderKeywordCategoryList();
      renderExtractKeywordList();
      renderAutoCommentRuleList();
      await restoreProjectDiff(proj);
    }
  } else {
    showEmptyState('<span class="icon" aria-hidden="true">📄</span>Diffファイルを読み込んでください');
  }
  refreshMemoUI();
})();
