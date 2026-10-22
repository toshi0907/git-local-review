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
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { hovered = null; focused = null; render(); }
  });
  window.addEventListener('resize', render);
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
