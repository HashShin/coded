'use strict';

// ── State ────────────────────────────────────────────────────────────────────

/** @type {Map<string, {content: string, dirty: boolean}>} */
const openFiles = new Map();

/** Currently active tab path, or null. */
let activeTab = null;

/** The Editor instance (created on DOMContentLoaded). */
let editor = null;

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
    openFiles.set(filePath, { content, dirty: false });
    activateTab(filePath);
  } catch (e) {
    alert('Network error: ' + e.message);
    console.error(e);
  } finally {
    if (treeRow) treeRow.style.opacity = '';
  }
}

// ── Init ─────────────────────────────────────────────────────────────────────

function init() {
  // Initialize the editor in the container div.
  editor = Editor.init(editorContainer);

  showWelcome();
  loadRootTree();
}

document.addEventListener('DOMContentLoaded', init);
