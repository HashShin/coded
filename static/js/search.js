'use strict';

// ── search.js ─────────────────────────────────────────────────────────────────
// Self-contained find/replace and folder-search module.
// Depends on: editor (window.editor set by app.js), openFile (window.openFile).

const Search = (() => {

  // ── State ──────────────────────────────────────────────────────────────────

  let _matches = [];      // [{start, end, line}]
  let _current = -1;      // index into _matches for current match

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

    // Walk all text nodes and wrap match ranges.
    // We iterate matches in order and walk the text node tree in parallel.
    const walker = document.createTreeWalker(editorInner, NodeFilter.SHOW_TEXT, null);
    const textNodes = [];
    let node;
    while ((node = walker.nextNode()) !== null) {
      textNodes.push(node);
    }

    // Build a list of (globalOffset, textNode) pairs.
    let offset = 0;
    const nodeRanges = textNodes.map(tn => {
      const start = offset;
      offset += tn.nodeValue.length;
      return { node: tn, start, end: offset };
    });

    // Apply matches in reverse order to avoid offset invalidation.
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
    // Find all text nodes that overlap [match.start, match.end).
    for (let i = nodeRanges.length - 1; i >= 0; i--) {
      const nr = nodeRanges[i];
      if (nr.end <= match.start) break;    // no more overlap possible going left
      if (nr.start >= match.end) continue; // this node is fully after match

      // Overlap: [overlapStart, overlapEnd) within text node.
      const overlapStart = Math.max(match.start, nr.start) - nr.start;
      const overlapEnd   = Math.min(match.end,   nr.end)   - nr.start;

      const tn = nr.node;
      const text = tn.nodeValue;

      // Split: before | match | after
      const before = text.slice(0, overlapStart);
      const matched = text.slice(overlapStart, overlapEnd);
      const after   = text.slice(overlapEnd);

      const mark = document.createElement('mark');
      mark.className = 'search-match' + (isCurrent ? ' current' : '');
      mark.textContent = matched;

      const parent = tn.parentNode;
      if (!parent) continue;

      // Replace the text node with before + mark + after.
      const frag = document.createDocumentFragment();
      if (before)  frag.appendChild(document.createTextNode(before));
      frag.appendChild(mark);
      if (after)   frag.appendChild(document.createTextNode(after));

      parent.replaceChild(frag, tn);

      // Update nodeRanges entry so future iterations don't re-process.
      // (We process right-to-left so earlier nodes are still valid.)
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
    const query = _el('find-input').value;
    const isRegex = _el('find-regex').checked;
    const text = ed.getValue();
    _matches = findMatches(text, query, isRegex);
    _current = _matches.length > 0 ? 0 : -1;
    _updateCount();
    applyHighlights();
    _scrollToCurrent();
  }

  function _updateCount() {
    const countEl = _el('find-count');
    if (!countEl) return;
    if (_matches.length === 0) {
      countEl.textContent = _el('find-input').value ? 'No results' : '';
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
    const replaceVal = _el('replace-input').value;
    const match = _matches[_current];
    const text = ed.getValue();
    const newText = text.slice(0, match.start) + replaceVal + text.slice(match.end);
    ed.setValue(newText, ed._lang);
    _reSearch();
  }

  function _replaceAll() {
    const ed = window.editor;
    if (!ed || _matches.length === 0) return;
    const replaceVal = _el('replace-input').value;
    const query = _el('find-input').value;
    const isRegex = _el('find-regex').checked;
    let text = ed.getValue();
    let re;
    try {
      re = isRegex
        ? new RegExp(query, 'g')
        : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    } catch (e) { return; }
    text = text.replace(re, replaceVal);
    ed.setValue(text, ed._lang);
    _reSearch();
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  function openFind() {
    _el('find-panel').style.display = 'flex';
    _el('find-input').focus();
    _el('find-input').select();
    _reSearch();
  }

  function openFindReplace() {
    _el('find-panel').style.display = 'flex';
    _el('replace-input').focus();
    _el('replace-input').select();
    _reSearch();
  }

  function closeFind() {
    _el('find-panel').style.display = 'none';
    _matches = [];
    _current = -1;
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

  // ── Init ───────────────────────────────────────────────────────────────────

  function init() {
    // Wire find panel controls.
    _el('find-input').addEventListener('keyup', (e) => {
      if (e.key === 'Escape') { closeFind(); return; }
      if (e.key === 'Enter') { _navigate(1); return; }
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

  return { openFind, openFindReplace, openFolderSearch, closeFind, findMatches };
})();

window.Search = Search;
