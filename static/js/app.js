'use strict';

// ── State ────────────────────────────────────────────────────────────────────

/** @type {Map<string, {content: string, dirty: boolean, savedContent: string}>} */
const openFiles = new Map();

/** Currently active tab path, or null. */
let activeTab = null;

/** The Editor instance (created on DOMContentLoaded). */
let editor = null;

/** Autosave debounce timer handle. */
let _saveSessionTimer = null;

// ── DOM refs ─────────────────────────────────────────────────────────────────

const fileTree       = document.getElementById('file-tree');
const tabBar         = document.getElementById('tab-bar');
const editorPane     = document.getElementById('editor-pane');
const editorContainer = document.getElementById('editor-container');
const welcome        = document.getElementById('welcome');
const statusPath     = document.getElementById('status-path');

// ── Language detection ────────────────────────────────────────────────────────

/**
 * Map a file path's extension to a language string for the tokenizer.
 * @param {string} filePath
 * @returns {string}
 */
function langFromPath(filePath) {
  const ext = filePath.split('.').pop().toLowerCase();
  const map = {
    go:   'go',
    js:   'js',
    ts:   'ts',
    jsx:  'jsx',
    tsx:  'tsx',
    py:   'py',
    json: 'json',
    html: 'html',
    htm:  'html',
    css:  'css',
    md:   'md',
    sh:   'sh',
    bash: 'bash',
  };
  return map[ext] || 'plain';
}

// ── Tree ─────────────────────────────────────────────────────────────────────

/**
 * Fetch one directory level and return the entry array.
 * @param {string} relPath  Relative path within root ('' = root).
 * @returns {Promise<Array<{name:string,isDir:boolean,size:number}>>}
 */
async function fetchTree(relPath) {
  const url = '/api/tree' + (relPath ? '?path=' + encodeURIComponent(relPath) : '');
  const res = await fetch(url);
  if (!res.ok) throw new Error('tree fetch failed: ' + res.status);
  return res.json();
}

/**
 * Build a <ul> of tree items for the given entries under parentPath.
 * @param {Array} entries
 * @param {string} parentPath  The directory these entries live in ('').
 * @returns {HTMLUListElement}
 */
function buildTreeList(entries, parentPath) {
  const ul = document.createElement('ul');
  ul.className = 'tree-children';

  for (const entry of entries) {
    const itemPath = parentPath ? parentPath + '/' + entry.name : entry.name;
    const li = document.createElement('li');

    const row = document.createElement('div');
    row.className = 'tree-item';
    row.dataset.path = itemPath;
    row.dataset.isdir = entry.isDir ? '1' : '0';

    // Indentation based on depth (count slashes).
    const depth = itemPath.split('/').length - 1;
    row.style.paddingLeft = (8 + depth * 14) + 'px';

    const icon = document.createElement('span');
    icon.className = 'tree-icon';
    icon.textContent = entry.isDir ? '▶' : ' ';

    const label = document.createElement('span');
    label.textContent = entry.name;

    row.appendChild(icon);
    row.appendChild(label);
    li.appendChild(row);

    if (entry.isDir) {
      row.addEventListener('click', () => toggleDir(row, itemPath, icon));
    } else {
      row.addEventListener('click', () => openFile(itemPath, row));
    }

    ul.appendChild(li);
  }

  return ul;
}

/**
 * Toggle a directory open/closed.
 * @param {HTMLElement} row
 * @param {string} dirPath
 * @param {HTMLElement} icon
 */
async function toggleDir(row, dirPath, icon) {
  // If already expanded, collapse.
  const existing = row.nextElementSibling;
  if (existing && existing.classList.contains('tree-children')) {
    existing.remove();
    icon.textContent = '▶';
    return;
  }

  icon.textContent = '…';
  try {
    const entries = await fetchTree(dirPath);
    const childList = buildTreeList(entries, dirPath);
    row.parentElement.appendChild(childList);
    icon.textContent = '▼';
  } catch (e) {
    icon.textContent = '▶';
    console.error('Failed to expand dir:', dirPath, e);
  }
}

/**
 * Render the root file tree into #file-tree.
 */
async function loadRootTree() {
  fileTree.textContent = '';
  try {
    const entries = await fetchTree('');
    const ul = buildTreeList(entries, '');
    // Move children of ul into fileTree directly.
    while (ul.firstChild) fileTree.appendChild(ul.firstChild);
  } catch (e) {
    const li = document.createElement('li');
    li.textContent = 'Error loading tree';
    li.style.color = '#f44';
    li.style.padding = '8px';
    fileTree.appendChild(li);
    console.error(e);
  }
}

// ── Tabs ─────────────────────────────────────────────────────────────────────

/**
 * Save the current editor content back into openFiles for the active tab.
 * Call this before switching away from a tab.
 */
function saveActiveTabContent() {
  if (activeTab && editor) {
    const file = openFiles.get(activeTab);
    if (file) {
      file.content = editor.getValue();
    }
  }
}

/**
 * Create or activate a tab for the given path.
 * @param {string} filePath
 */
function activateTab(filePath) {
  // Save content of current tab before leaving it.
  saveActiveTabContent();

  // Deactivate current.
  if (activeTab) {
    const prev = tabBar.querySelector('.tab[data-path="' + CSS.escape(activeTab) + '"]');
    if (prev) prev.classList.remove('active');
    // Also deactivate tree item.
    const prevTree = fileTree.querySelector('.tree-item.active');
    if (prevTree) prevTree.classList.remove('active');
  }

  activeTab = filePath;

  // Activate tab element.
  let tab = tabBar.querySelector('.tab[data-path="' + CSS.escape(filePath) + '"]');
  if (!tab) {
    tab = createTab(filePath);
    tabBar.appendChild(tab);
  }
  tab.classList.add('active');
  tab.scrollIntoView({ block: 'nearest', inline: 'nearest' });

  // Activate tree item.
  const treeItem = fileTree.querySelector('.tree-item[data-path="' + CSS.escape(filePath) + '"]');
  if (treeItem) treeItem.classList.add('active');

  // Show content in editor.
  const file = openFiles.get(filePath);
  showContent(filePath, file ? file.content : '');

  scheduleSaveSession();
}

/**
 * Build a tab element.
 * @param {string} filePath
 * @returns {HTMLElement}
 */
function createTab(filePath) {
  const parts = filePath.split('/');
  const name = parts[parts.length - 1];

  const tab = document.createElement('div');
  tab.className = 'tab';
  tab.dataset.path = filePath;
  tab.title = filePath;

  const label = document.createElement('span');
  label.className = 'tab-label';
  label.textContent = name;

  const closeBtn = document.createElement('button');
  closeBtn.className = 'tab-close';
  closeBtn.textContent = '×';
  closeBtn.title = 'Close';
  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    closeTab(filePath);
  });

  tab.appendChild(label);
  tab.appendChild(closeBtn);
  tab.addEventListener('click', () => activateTab(filePath));

  return tab;
}

/**
 * Update the dirty indicator on the tab for filePath.
 * @param {string} filePath
 */
function updateTabDirty(filePath) {
  const file = openFiles.get(filePath);
  const tab = tabBar.querySelector('.tab[data-path="' + CSS.escape(filePath) + '"]');
  if (!tab || !file) return;
  if (file.dirty) {
    tab.classList.add('dirty');
  } else {
    tab.classList.remove('dirty');
  }
}

/**
 * Update dirty state for the given path based on current text.
 * @param {string} filePath
 * @param {string} text
 */
function updateDirtyState(filePath, text) {
  const file = openFiles.get(filePath);
  if (!file) return;
  file.content = text;
  file.dirty = (text !== file.savedContent);
  updateTabDirty(filePath);
}

/**
 * Save the current file to disk via PUT /api/file.
 */
async function saveCurrentFile() {
  if (!activeTab || !editor) return;
  const filePath = activeTab;
  const content = editor.getValue();

  try {
    const res = await fetch('/api/file?path=' + encodeURIComponent(filePath), {
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      body: content,
    });
    if (!res.ok) {
      let msg = 'Error ' + res.status;
      try {
        const body = await res.json();
        msg = body.error || msg;
      } catch (_) {}
      console.error('Save failed:', msg);
      if (statusPath) statusPath.textContent = filePath + '  [save failed: ' + msg + ']';
      return;
    }
    // Success: mark clean.
    const file = openFiles.get(filePath);
    if (file) {
      file.savedContent = content;
      file.content = content;
      file.dirty = false;
      updateTabDirty(filePath);
    }
  } catch (e) {
    console.error('Save network error:', e);
  }
}

/**
 * Close a tab.
 * @param {string} filePath
 */
function closeTab(filePath) {
  // Save content before closing, in case we switch to another tab.
  if (activeTab === filePath) {
    saveActiveTabContent();
  }

  openFiles.delete(filePath);

  const tab = tabBar.querySelector('.tab[data-path="' + CSS.escape(filePath) + '"]');
  if (!tab) return;

  // Find adjacent tab to switch to.
  const allTabs = Array.from(tabBar.querySelectorAll('.tab'));
  const idx = allTabs.indexOf(tab);
  tab.remove();

  // Also remove active tree highlight.
  const treeItem = fileTree.querySelector('.tree-item[data-path="' + CSS.escape(filePath) + '"]');
  if (treeItem) treeItem.classList.remove('active');

  if (activeTab === filePath) {
    activeTab = null;
    // Switch to adjacent tab.
    const remaining = Array.from(tabBar.querySelectorAll('.tab'));
    if (remaining.length > 0) {
      const next = remaining[Math.min(idx, remaining.length - 1)];
      activateTab(next.dataset.path);
    } else {
      showWelcome();
      scheduleSaveSession();
    }
  }
}

// ── Content display ───────────────────────────────────────────────────────────

/**
 * Show file content in the editor.
 * @param {string} filePath
 * @param {string} content
 */
function showContent(filePath, content) {
  welcome.style.display = 'none';
  editorContainer.style.display = 'block';
  statusPath.textContent = filePath;

  const lang = langFromPath(filePath);
  editor.setValue(content, lang);
}

function showWelcome() {
  editorContainer.style.display = 'none';
  welcome.style.display = 'flex';
  statusPath.textContent = '';
}

// ── File open ─────────────────────────────────────────────────────────────────

/**
 * Open a file: fetch content if not cached, then activate its tab.
 * @param {string} filePath
 * @param {HTMLElement} treeRow  The clicked tree row (for visual feedback).
 */
async function openFile(filePath, treeRow) {
  // If already open, just switch to it.
  if (openFiles.has(filePath)) {
    activateTab(filePath);
    return;
  }

  if (treeRow) treeRow.style.opacity = '0.5';

  try {
    const res = await fetch('/api/file?path=' + encodeURIComponent(filePath));
    if (!res.ok) {
      let msg = 'Error ' + res.status;
      try {
        const body = await res.json();
        msg = body.error || msg;
      } catch (_) {}
      alert('Cannot open file: ' + msg);
      return;
    }
    const content = await res.text();
    openFiles.set(filePath, { content, dirty: false, savedContent: content });
    activateTab(filePath);
  } catch (e) {
    alert('Network error: ' + e.message);
    console.error(e);
  } finally {
    if (treeRow) treeRow.style.opacity = '';
  }
}

// ── Session persistence ───────────────────────────────────────────────────────

/**
 * Persist the current session (open tabs + caret) to the server.
 */
function saveSession() {
  const tabs = [];
  for (const [path, file] of openFiles) {
    tabs.push({ path, content: file.content, savedContent: file.savedContent, dirty: file.dirty });
  }
  const caretPositions = {};
  if (activeTab) {
    const pos = editor.getCaretOffset();
    if (pos) caretPositions[activeTab] = pos;
  }
  const session = { openTabs: tabs, activeTab, caretPositions };
  fetch('/api/session', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(session),
  }).catch(err => console.error('session save failed:', err));
}

/**
 * Schedule a saveSession after a 2-second debounce.
 */
function scheduleSaveSession() {
  if (_saveSessionTimer !== null) clearTimeout(_saveSessionTimer);
  _saveSessionTimer = setTimeout(() => {
    _saveSessionTimer = null;
    saveSession();
  }, 2000);
}

/**
 * Load the persisted session from the server and restore open tabs.
 * Returns true if tabs were restored, false if nothing to restore.
 * @returns {Promise<boolean>}
 */
async function loadSession() {
  try {
    const res = await fetch('/api/session');
    const session = await res.json();
    if (!session.openTabs || session.openTabs.length === 0) return false;
    for (const tab of session.openTabs) {
      openFiles.set(tab.path, { content: tab.content, savedContent: tab.savedContent, dirty: tab.dirty });
      // Add the tab element to the tab bar (without activating).
      const tabEl = createTab(tab.path);
      tabBar.appendChild(tabEl);
    }
    const toActivate = session.activeTab || session.openTabs[0].path;
    activateTab(toActivate);
    if (session.caretPositions && session.caretPositions[toActivate]) {
      const { anchor, focus } = session.caretPositions[toActivate];
      setTimeout(() => editor.setCaretOffset(anchor, focus), 50);
    }
    return true;
  } catch (e) {
    return false;
  }
}

// ── Init ─────────────────────────────────────────────────────────────────────

function init() {
  // Initialize the editor in the container div.
  editor = Editor.init(editorContainer);
  window.editor = editor;

  // Wire up dirty-state tracking on every editor change.
  editor.onchange = (text) => {
    if (activeTab) {
      updateDirtyState(activeTab, text);
      // Keep in-memory content current for session saves.
      openFiles.get(activeTab).content = text;
      scheduleSaveSession();
    }
  };

  // Ctrl+S / Cmd+S to save.
  // Ctrl+F: find, Ctrl+H: find+replace, Ctrl+Shift+F: folder search.
  document.addEventListener('keydown', (e) => {
    if (e.key === 's' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      saveCurrentFile();
      return;
    }
    if (e.ctrlKey && !e.metaKey) {
      if (e.shiftKey && e.key === 'F') {
        e.preventDefault();
        if (window.Search) Search.openFolderSearch();
        return;
      }
      if (!e.shiftKey && e.key === 'f') {
        e.preventDefault();
        if (window.Search) Search.openFind();
        return;
      }
      if (!e.shiftKey && e.key === 'h') {
        e.preventDefault();
        if (window.Search) Search.openFindReplace();
        return;
      }
    }
  });

  // Word-wrap toggle button.
  const btnWrap = document.getElementById('btn-wrap');
  if (btnWrap) {
    btnWrap.addEventListener('click', () => editor.toggleWrap());
  }

  loadRootTree();

  // Restore previous session; fall back to welcome screen.
  loadSession().then(restored => {
    if (!restored) showWelcome();
  });
}

document.addEventListener('DOMContentLoaded', init);

// Expose openFile globally so search.js can open files from results.
window.openFile = openFile;
