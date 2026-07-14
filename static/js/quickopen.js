'use strict';

// ── Quick Open (Ctrl+P) + Go-to-Line (Ctrl+G) ────────────────────────────────

const QuickOpen = (() => {
  // ── State ──────────────────────────────────────────────────────────────────

  /** Cached flat file list from /api/files. */
  let _fileCache = null;

  /** Currently highlighted result index. */
  let _selectedIdx = 0;

  // ── DOM creation ───────────────────────────────────────────────────────────

  function _ensureDOM() {
    if (document.getElementById('quickopen-overlay')) return;

    // Quick-open overlay
    const overlay = document.createElement('div');
    overlay.id = 'quickopen-overlay';
    overlay.style.display = 'none';

    const modal = document.createElement('div');
    modal.id = 'quickopen-modal';

    const input = document.createElement('input');
    input.id = 'quickopen-input';
    input.type = 'text';
    input.placeholder = 'Go to file\u2026 (type to filter)';
    input.autocomplete = 'off';
    input.spellcheck = false;

    const results = document.createElement('div');
    results.id = 'quickopen-results';

    modal.appendChild(input);
    modal.appendChild(results);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    // Close when clicking outside the modal
    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay) _close();
    });

    // Go-to-line prompt
    const gotoPrompt = document.createElement('div');
    gotoPrompt.id = 'gotoline-prompt';
    gotoPrompt.style.display = 'none';
    gotoPrompt.innerHTML =
      '<span>Go to line: </span><input id="gotoline-input" type="number" min="1">';
    document.body.appendChild(gotoPrompt);

    const gotoInput = gotoPrompt.querySelector('#gotoline-input');
    gotoInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        _goToLine(parseInt(gotoInput.value, 10) || 1);
        _closeGoToLine();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        _closeGoToLine();
      }
    });
  }

  // ── Fuzzy scoring ──────────────────────────────────────────────────────────

  function fuzzyScore(path, query) {
    if (!query) return 1; // show all when empty
    const p = path.toLowerCase(), q = query.toLowerCase();
    let pi = 0, qi = 0, score = 0, consecutive = 0;
    while (pi < p.length && qi < q.length) {
      if (p[pi] === q[qi]) {
        score += 1 + consecutive * 2;
        consecutive++;
        qi++;
      } else {
        consecutive = 0;
      }
      pi++;
    }
    if (qi < q.length) return -1; // no match
    // bonus: query matches filename (not just path)
    const fname = p.split('/').pop();
    if (fname.includes(q)) score += 20;
    return score;
  }

  // ── Internal helpers ───────────────────────────────────────────────────────

  async function _loadFiles() {
    if (_fileCache !== null) return _fileCache;
    try {
      const res = await fetch('/api/files');
      if (!res.ok) throw new Error('status ' + res.status);
      const data = await res.json();
      _fileCache = data.files || [];
    } catch (e) {
      console.error('QuickOpen: failed to load file list', e);
      _fileCache = [];
    }
    return _fileCache;
  }

  function _renderResults(query) {
    const resultsEl = document.getElementById('quickopen-results');
    if (!resultsEl) return;

    const files = _fileCache || [];
    let scored = files
      .map(f => ({ path: f, score: fuzzyScore(f, query) }))
      .filter(x => x.score >= 0);

    // Sort by descending score; ties broken alphabetically
    scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));

    const top = scored.slice(0, 50);
    _selectedIdx = top.length > 0 ? 0 : -1;

    resultsEl.innerHTML = '';
    top.forEach((item, idx) => {
      const div = document.createElement('div');
      div.className = 'quickopen-item' + (idx === 0 ? ' selected' : '');
      div.textContent = item.path;
      div.addEventListener('mousedown', (e) => {
        e.preventDefault(); // don't blur the input
        _openItem(item.path);
      });
      resultsEl.appendChild(div);
    });
  }

  function _moveSelection(delta) {
    const resultsEl = document.getElementById('quickopen-results');
    if (!resultsEl) return;
    const items = resultsEl.querySelectorAll('.quickopen-item');
    if (items.length === 0) return;

    items[_selectedIdx]?.classList.remove('selected');
    _selectedIdx = (_selectedIdx + delta + items.length) % items.length;
    const sel = items[_selectedIdx];
    sel.classList.add('selected');
    sel.scrollIntoView({ block: 'nearest' });
  }

  function _openItem(path) {
    _close();
    if (typeof window.openFile === 'function') {
      window.openFile(path, null);
    }
  }

  function _close() {
    const overlay = document.getElementById('quickopen-overlay');
    if (overlay) overlay.style.display = 'none';
    const input = document.getElementById('quickopen-input');
    if (input) input.value = '';
  }

  function _closeGoToLine() {
    const prompt = document.getElementById('gotoline-prompt');
    if (prompt) prompt.style.display = 'none';
  }

  function _goToLine(lineNum) {
    if (!window.editor) return;
    const content = window.editor.getValue();
    if (!content) return;

    const lines = content.split('\n');
    const target = Math.max(1, Math.min(lineNum, lines.length));

    // Sum lengths of lines 0..target-2 plus newlines
    let offset = 0;
    for (let i = 0; i < target - 1; i++) {
      offset += lines[i].length + 1; // +1 for the \n
    }

    window.editor.setCaretOffset(offset, offset);

    // Scroll the line into view by finding the caret in the DOM
    requestAnimationFrame(() => {
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0) {
        const range = sel.getRangeAt(0);
        const rect = range.getBoundingClientRect();
        if (rect) {
          const editorPane = document.getElementById('editor-pane');
          if (editorPane) {
            const paneRect = editorPane.getBoundingClientRect();
            if (rect.top < paneRect.top || rect.bottom > paneRect.bottom) {
              editorPane.scrollTop += rect.top - paneRect.top - paneRect.height / 2;
            }
          }
        }
      }
    });
  }

  // ── Wire up input events once overlay exists ───────────────────────────────

  function _wireInput() {
    const input = document.getElementById('quickopen-input');
    if (!input || input._wired) return;
    input._wired = true;

    input.addEventListener('input', () => {
      _renderResults(input.value.trim());
    });

    input.addEventListener('keydown', (e) => {
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          _moveSelection(1);
          break;
        case 'ArrowUp':
          e.preventDefault();
          _moveSelection(-1);
          break;
        case 'Enter': {
          e.preventDefault();
          const resultsEl = document.getElementById('quickopen-results');
          const items = resultsEl ? resultsEl.querySelectorAll('.quickopen-item') : [];
          if (items[_selectedIdx]) {
            _openItem(items[_selectedIdx].textContent);
          }
          break;
        }
        case 'Escape':
          e.preventDefault();
          _close();
          break;
      }
    });
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  async function open() {
    _ensureDOM();
    _wireInput();

    const overlay = document.getElementById('quickopen-overlay');
    const input = document.getElementById('quickopen-input');
    if (!overlay || !input) return;

    overlay.style.display = 'flex';
    input.value = '';
    input.focus();

    // Load (or use cached) file list, then render
    await _loadFiles();
    _renderResults('');
  }

  function openGoToLine() {
    _ensureDOM();
    const prompt = document.getElementById('gotoline-prompt');
    const gotoInput = document.getElementById('gotoline-input');
    if (!prompt || !gotoInput) return;

    prompt.style.display = 'flex';
    gotoInput.value = '';
    gotoInput.focus();
  }

  // Invalidate cache (call when files change)
  function invalidateCache() {
    _fileCache = null;
  }

  return { open, openGoToLine, invalidateCache };
})();

window.QuickOpen = QuickOpen;
