'use strict';

// ── search.js ─────────────────────────────────────────────────────────────────
// Self-contained find/replace and folder-search module.
// Depends on: editor (window.editor set by app.js), openFile (window.openFile).

const Search = (() => {

  // ── State ──────────────────────────────────────────────────────────────────

  let _matches = [];      // [{start, end, line}]
  let _current = -1;      // index into _matches for current match
  let _query = '';         // raw query string (may contain newlines)
  let _replaceQuery = '';  // raw replace string (may contain newlines)

  // ── DOM refs (lazily resolved after DOMContentLoaded) ─────────────────────

  function _el(id) { return document.getElementById(id); }

  // ── Find panel ─────────────────────────────────────────────────────────────

  /**
   * Compute all match positions in `text` for `query`.
   * Returns [{start, end, line}] where start/end are char offsets in text.
   * @param {string} text
   * @param {string} query
   * @param {boolean} isRegex
   * @returns {Array<{start:number,end:number,line:number}>}
   */
  function findMatches(text, query, isRegex) {
    if (!query) return [];
    const results = [];
    let re;
    try {
      re = isRegex
        ? new RegExp(query, 'g')
        : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    } catch (e) {
      return [];
    }
    let m;
    while ((m = re.exec(text)) !== null) {
      // Compute 1-indexed line number.
      const line = text.slice(0, m.index).split('\n').length;
      results.push({ start: m.index, end: m.index + m[0].length, line });
      // Guard against zero-length matches looping forever.
      if (m[0].length === 0) re.lastIndex++;
    }
    return results;
  }

  /**
   * Collect text nodes from the editor inner in the same order/space as
   * getPlainText / getValue() — skipping fold-pills (contenteditable=false)
   * and inserting a synthetic '\n' boundary between block divs, so that
   * character offsets from findMatches() map 1-to-1 onto DOM positions.
   *
   * Returns [{node, start, end, synthetic}] where synthetic nodes are
   * placeholder objects representing the '\n' between line divs (no real
   * DOM node to wrap, we just need to account for their length).
   */
  function _buildNodeRanges(editorInner) {
    const ranges = [];
    let offset = 0;
    let seenFirstBlock = false;

    function isTrailingBr(brNode, blockEl) {
      let n = brNode;
      while (n && n !== blockEl) {
        if (n.nextSibling) return false;
        n = n.parentNode;
      }
      return true;
    }

    function walk(node, blockEl) {
      if (node.nodeType === Node.TEXT_NODE) {
        const len = node.nodeValue.length;
        if (len > 0) {
          ranges.push({ node, start: offset, end: offset + len });
          offset += len;
        }
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;

      // Skip fold-pills and other contenteditable=false elements —
      // they contribute nothing to getValue() output.
      if (node.getAttribute && node.getAttribute('contenteditable') === 'false') return;

      const tag = node.tagName.toUpperCase();

      if (tag === 'BR') {
        if (!isTrailingBr(node, blockEl)) {
          ranges.push({ node: null, start: offset, end: offset + 1, br: node });
          offset += 1;
        }
        return;
      }

      const isBlock = (tag === 'DIV' || tag === 'P');
      if (isBlock && node !== editorInner) {
        if (seenFirstBlock || offset > 0) {
          // Newline boundary between blocks — synthetic, no real text node.
          ranges.push({ node: null, start: offset, end: offset + 1, newline: true });
          offset += 1;
        }
        seenFirstBlock = true;
        blockEl = node;
      }

      for (const child of node.childNodes) {
        walk(child, blockEl);
      }
    }

    walk(editorInner, editorInner);
    return ranges;
  }

  /**
   * Apply <mark> highlights to the editor DOM for all current matches.
   * Called after every render so marks survive re-renders.
   */
  function applyHighlights() {
    const editorInner = document.querySelector('.editor-inner');
    if (!editorInner) return;

    // Remove any existing marks first.
    const existing = editorInner.querySelectorAll('mark.search-match');
    for (const m of existing) {
      const parent = m.parentNode;
      parent.replaceChild(document.createTextNode(m.textContent), m);
      parent.normalize();
    }

    if (_matches.length === 0) return;

    // Build offset map that mirrors getValue() exactly.
    const nodeRanges = _buildNodeRanges(editorInner);

    // Apply matches in reverse order to avoid invalidating earlier offsets.
    const toApply = _matches.slice().reverse();
    for (let mi = 0; mi < toApply.length; mi++) {
      const match = toApply[mi];
      const origIdx = _matches.length - 1 - mi;
      _wrapMatchInNodes(nodeRanges, match, origIdx === _current);
    }
  }

  /**
   * Wrap a single match (by char offsets) in <mark> elements.
   * @param {Array<{node,start,end}>} nodeRanges
   * @param {{start:number,end:number}} match
   * @param {boolean} isCurrent
   */
  function _wrapMatchInNodes(nodeRanges, match, isCurrent) {
    for (let i = nodeRanges.length - 1; i >= 0; i--) {
      const nr = nodeRanges[i];
      if (nr.end <= match.start) break;    // no more overlap possible going left
      if (nr.start >= match.end) continue; // fully after match
      if (!nr.node) continue;              // synthetic newline boundary — skip

      const overlapStart = Math.max(match.start, nr.start) - nr.start;
      const overlapEnd   = Math.min(match.end,   nr.end)   - nr.start;

      const tn = nr.node;
      const text = tn.nodeValue;

      const before  = text.slice(0, overlapStart);
      const matched = text.slice(overlapStart, overlapEnd);
      const after   = text.slice(overlapEnd);

      const mark = document.createElement('mark');
      mark.className = 'search-match' + (isCurrent ? ' current' : '');
      mark.textContent = matched;

      const parent = tn.parentNode;
      if (!parent) continue;

      const frag = document.createDocumentFragment();
      if (before)  frag.appendChild(document.createTextNode(before));
      frag.appendChild(mark);
      if (after)   frag.appendChild(document.createTextNode(after));

      parent.replaceChild(frag, tn);

      nodeRanges.splice(i, 1,
        { node: document.createTextNode(before), start: nr.start, end: nr.start + before.length },
        { node: mark.firstChild || mark, start: nr.start + before.length, end: nr.start + before.length + matched.length },
        { node: document.createTextNode(after), start: nr.start + before.length + matched.length, end: nr.end }
      );
    }
  }

  /**
   * Re-run search from current find-input value, update count display.
   */
  function _reSearch() {
    const ed = window.editor;
    if (!ed) return;
    const isRegex = _el('find-regex').checked;
    const text = ed.getValue();
    _matches = findMatches(text, _query, isRegex);
    _current = _matches.length > 0 ? 0 : -1;
    _updateCount();
    applyHighlights();
    _scrollToCurrent();
  }

  function _updateCount() {
    const countEl = _el('find-count');
    if (!countEl) return;
    if (_matches.length === 0) {
      countEl.textContent = _query ? 'No results' : '';
    } else {
      countEl.textContent = (_current + 1) + ' of ' + _matches.length;
    }
  }

  function _scrollToCurrent() {
    if (_current < 0 || _current >= _matches.length) return;
    const editorInner = document.querySelector('.editor-inner');
    if (!editorInner) return;
    const marks = editorInner.querySelectorAll('mark.search-match');
    if (marks[_current]) {
      marks[_current].scrollIntoView({ block: 'center', inline: 'nearest' });
    }
  }

  function _navigate(delta) {
    if (_matches.length === 0) return;
    _current = ((_current + delta) % _matches.length + _matches.length) % _matches.length;
    _updateCount();
    // Re-apply highlights to update .current class.
    applyHighlights();
    _scrollToCurrent();
  }

  function _replaceCurrent() {
    const ed = window.editor;
    if (!ed || _current < 0 || _current >= _matches.length) return;
    const match = _matches[_current];
    const text = ed.getValue();
    const newText = text.slice(0, match.start) + _replaceQuery + text.slice(match.end);
    ed.replaceContent(newText);
    _reSearch();
  }

  function _replaceAll() {
    const ed = window.editor;
    if (!ed || _matches.length === 0) return 0;
    const count = _matches.length;
    const isRegex = _el('find-regex').checked;
    let text = ed.getValue();
    let re;
    try {
      re = isRegex
        ? new RegExp(_query, 'g')
        : new RegExp(_query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    } catch (e) { return 0; }
    text = text.replace(re, _replaceQuery);
    ed.replaceContent(text);
    _reSearch();
    return count;
  }

  let _toastTimer = null;
  function _showToast(msg) {
    let toast = _el('search-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'search-toast';
      document.body.appendChild(toast);
    }
    toast.textContent = msg;
    toast.classList.add('visible');
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => toast.classList.remove('visible'), 2500);
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  function openFind() {
    _el('find-replace-row').style.display = 'none';
    _el('find-panel').style.display = 'flex';
    if (!navigator.maxTouchPoints) { _el('find-input').focus(); _el('find-input').select(); }
    _reSearch();
  }

  function openFindReplace() {
    _el('find-replace-row').style.display = 'flex';
    _el('find-panel').style.display = 'flex';
    if (!navigator.maxTouchPoints) { _el('find-input').focus(); _el('find-input').select(); }
    _reSearch();
  }

  function closeFind() {
    _el('find-panel').style.display = 'none';
    _matches = [];
    _current = -1;
    _query = '';
    _replaceQuery = '';
    // Clear highlights.
    const editorInner = document.querySelector('.editor-inner');
    if (editorInner) {
      const marks = editorInner.querySelectorAll('mark.search-match');
      for (const m of marks) {
        const parent = m.parentNode;
        parent.replaceChild(document.createTextNode(m.textContent), m);
        parent.normalize();
      }
    }
    _el('find-count').textContent = '';
  }

  // ── Folder search ──────────────────────────────────────────────────────────

  function openFolderSearch() {
    const panel = _el('folder-search-panel');
    panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
    if (panel.style.display === 'block') {
      _el('folder-search-input').focus();
    }
  }

  async function _runFolderSearch() {
    const query = _el('folder-search-input').value.trim();
    if (!query) return;
    const isRegex = _el('folder-search-regex').checked ? '1' : '0';
    const resultsEl = _el('folder-search-results');
    resultsEl.textContent = 'Searching…';

    try {
      const res = await fetch(
        '/api/search?q=' + encodeURIComponent(query) + '&regex=' + isRegex
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        resultsEl.textContent = 'Error: ' + (body.error || res.status);
        return;
      }
      const data = await res.json();
      const results = data.results || [];
      if (results.length === 0) {
        resultsEl.textContent = 'No results.';
        return;
      }
      resultsEl.textContent = '';
      for (const r of results) {
        const item = document.createElement('div');
        item.className = 'search-result-item';
        item.textContent = r.file + ':' + r.line + ': ' + r.text.trim();
        item.title = r.file + ' line ' + r.line;
        item.addEventListener('click', () => {
          if (typeof window.openFile === 'function') {
            window.openFile(r.file).then(() => {
              // Scroll editor to line after file opens.
              _scrollEditorToLine(r.line);
            });
          }
        });
        resultsEl.appendChild(item);
      }
    } catch (e) {
      resultsEl.textContent = 'Network error: ' + e.message;
    }
  }

  function _scrollEditorToLine(lineNum) {
    // Give the editor a moment to render, then scroll to the line div.
    setTimeout(() => {
      const editorInner = document.querySelector('.editor-inner');
      if (!editorInner) return;
      const lineDivs = editorInner.querySelectorAll('div');
      const target = lineDivs[lineNum - 1];
      if (target) target.scrollIntoView({ block: 'center' });
    }, 100);
  }

  // ── Search modal ───────────────────────────────────────────────────────────

  function openSearchModal() {
    const overlay = _el('search-overlay');
    overlay.style.display = 'flex';
    // Pre-fill with current find-input value if any.
    const modalInput = _el('search-modal-input');
    modalInput.value = _el('find-input').value;
    if (!navigator.maxTouchPoints) { modalInput.focus(); modalInput.select(); }
  }

  function _closeSearchModal() {
    _el('search-overlay').style.display = 'none';
  }

  function _searchModalSearch() {
    _query = _el('search-modal-input').value;
    _replaceQuery = _el('search-modal-replace').value;
    _closeSearchModal();
    // Show read-only label: Search "query" (show first line if multiline)
    const displayQuery = _query.split('\n')[0] + (_query.includes('\n') ? '…' : '');
    const label = _el('find-label');
    label.innerHTML = '<span class="find-label-prefix">Search</span>"' + displayQuery.replace(/"/g, '&quot;') + '"';
    _el('find-replace-row').style.display = 'none';
    _el('find-panel').style.display = 'flex';
    _reSearch();
  }

  function _searchModalReplaceAll() {
    _query = _el('search-modal-input').value;
    _replaceQuery = _el('search-modal-replace').value;
    if (!_query) return;
    _closeSearchModal();
    // Blur any focused element on touch to prevent keyboard from opening.
    if (navigator.maxTouchPoints && document.activeElement) document.activeElement.blur();
    _reSearch();
    const count = _replaceAll();
    _showToast(count > 0 ? 'Replaced ' + count + ' occurrence' + (count === 1 ? '' : 's') : 'No matches found');
  }

  // ── Init ───────────────────────────────────────────────────────────────────

  function init() {
    // Wire find panel controls.
    _el('find-input').addEventListener('keyup', (e) => {
      if (e.key === 'Escape') { closeFind(); return; }
      if (e.key === 'Enter') { _navigate(e.shiftKey ? -1 : 1); return; }
      _reSearch();
    });
    _el('find-regex').addEventListener('change', _reSearch);
    _el('btn-find-prev').addEventListener('click', () => _navigate(-1));
    _el('btn-find-next').addEventListener('click', () => _navigate(1));
    _el('btn-replace-one').addEventListener('click', _replaceCurrent);
    _el('btn-replace-all').addEventListener('click', _replaceAll);
    _el('btn-find-close').addEventListener('click', closeFind);

    _el('replace-input').addEventListener('keyup', (e) => {
      if (e.key === 'Escape') { closeFind(); return; }
      if (e.key === 'Enter') { _replaceCurrent(); return; }
    });

    // Wire search modal.
    _el('search-modal-search').addEventListener('click', _searchModalSearch);
    _el('search-modal-replace-all').addEventListener('click', _searchModalReplaceAll);
    _el('search-overlay').addEventListener('click', (e) => {
      if (e.target === _el('search-overlay')) _closeSearchModal();
    });
    _el('search-modal-input').addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); _closeSearchModal(); return; }
      if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); _searchModalSearch(); return; }
    });
    _el('search-modal-replace').addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); _closeSearchModal(); return; }
      if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); _searchModalReplaceAll(); return; }
    });

    // Wire folder search.
    _el('btn-folder-search').addEventListener('click', _runFolderSearch);
    _el('folder-search-input').addEventListener('keyup', (e) => {
      if (e.key === 'Enter') _runFolderSearch();
    });

    // Hook into editor after-render to reapply highlights.
    // editor is set by app.js; wait a tick in case init order varies.
    setTimeout(() => {
      if (window.editor) {
        window.editor.onAfterRender = applyHighlights;
      }
    }, 0);
  }

  document.addEventListener('DOMContentLoaded', init);

  return { openFind, openFindReplace, openFolderSearch, openSearchModal, closeFind, findMatches };
})();

window.Search = Search;
