'use strict';

// ── editor.js ─────────────────────────────────────────────────────────────────
// A contenteditable-based code editor with live syntax highlighting.
// Depends on tokenize.js being loaded first (window.tokenize).

// ── Caret utilities ───────────────────────────────────────────────────────────

/**
 * Walk all TEXT_NODE descendants of `root` in document order using TreeWalker.
 * @param {Element} root
 * @returns {TreeWalker}
 */
function textWalker(root) {
  return document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
}

/**
 * Get the character offset of a (node, offset) pair within `root`.
 *
 * Handles two cases:
 *   1. targetNode is a TEXT_NODE — walk and sum lengths until found.
 *   2. targetNode is an ELEMENT_NODE (e.g. a <div> containing only <br>) —
 *      the browser places the caret at childOffset within the element. We sum
 *      up all text-node characters that come before that child position.
 *
 * @param {Element} root
 * @param {Node}    targetNode
 * @param {number}  targetOffset
 * @returns {number}
 */
function nodeOffsetToChar(root, targetNode, targetOffset) {
  // Case 1: text node — fast path via TreeWalker.
  if (targetNode && targetNode.nodeType === Node.TEXT_NODE) {
    const walker = textWalker(root);
    let count = 0;
    let node;
    while ((node = walker.nextNode()) !== null) {
      if (node === targetNode) {
        return count + targetOffset;
      }
      count += node.nodeValue.length;
    }
    // Not found — return total.
    return count;
  }

  // Case 2: element node (browser placed caret at child index targetOffset).
  // Count all text characters before the child at targetOffset inside targetNode.
  if (targetNode && targetNode.nodeType === Node.ELEMENT_NODE) {
    // Special case: caret is between line-divs directly inside the editor root.
    // childOffset === N means the caret is at the start of line N (0-based).
    // Return sum of lengths of lines 0..N-1 plus N newline characters.
    if (targetNode === root) {
      const lines = getPlainText(root).split('\n');
      let count = 0;
      for (let i = 0; i < targetOffset && i < lines.length; i++) {
        count += lines[i].length + 1; // +1 for the '\n' between lines
      }
      return count;
    }

    // General element case: count text before targetNode in the document,
    // then add characters of children[0..targetOffset-1] inside targetNode.
    const walker = textWalker(root);
    let count = 0;
    let node;
    let insideTarget = false;
    let childCharCount = 0;

    while ((node = walker.nextNode()) !== null) {
      if (targetNode.contains(node)) {
        // We're inside the target element.
        if (!insideTarget) insideTarget = true;
        // Count only children before targetOffset.
        // Find which direct child of targetNode this text node belongs to.
        let ancestor = node;
        while (ancestor.parentNode !== targetNode) {
          ancestor = ancestor.parentNode;
        }
        // ancestor is a direct child of targetNode.
        // Determine its index.
        const idx = Array.prototype.indexOf.call(targetNode.childNodes, ancestor);
        if (idx < targetOffset) {
          childCharCount += node.nodeValue.length;
        }
      } else if (!insideTarget) {
        count += node.nodeValue.length;
      }
    }
    return count + childCharCount;
  }

  // Fallback: root itself or unknown.
  const walker = textWalker(root);
  let count = 0;
  let node;
  while ((node = walker.nextNode()) !== null) count += node.nodeValue.length;
  return count;
}

/**
 * Save the current selection offsets relative to `root`.
 * Returns {anchor, focus} as character offsets, or null if no selection.
 *
 * @param {Element} root
 * @returns {{anchor:number, focus:number}|null}
 */
function getCaretOffset(root) {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;

  // Check that the selection is inside our editor.
  const range = sel.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return null;

  const anchor = nodeOffsetToChar(root, sel.anchorNode, sel.anchorOffset);
  const focus  = nodeOffsetToChar(root, sel.focusNode,  sel.focusOffset);

  return { anchor, focus };
}

/**
 * Restore the selection from character offsets relative to `root`.
 *
 * @param {Element} root
 * @param {number}  anchorOff
 * @param {number}  focusOff
 */
function setCaretOffset(root, anchorOff, focusOff) {
  const walker = textWalker(root);
  let anchorNode = null, anchorLocalOff = 0;
  let focusNode  = null, focusLocalOff  = 0;
  let count = 0;
  let node;

  // We need to find nodes for BOTH offsets in one pass.
  const needAnchor = anchorOff >= 0;
  const needFocus  = focusOff  >= 0;

  while ((node = walker.nextNode()) !== null) {
    const len = node.nodeValue.length;
    const end = count + len;

    if (needAnchor && anchorNode === null && end >= anchorOff) {
      anchorNode     = node;
      anchorLocalOff = anchorOff - count;
    }
    if (needFocus && focusNode === null && end >= focusOff) {
      focusNode     = node;
      focusLocalOff = focusOff - count;
    }

    // Once both found, stop.
    if (anchorNode && focusNode) break;

    // Always advance count so the next node gets the right base.
    count = end;
  }

  // If the editor is empty or offset is past the end, place at last text node.
  if (!anchorNode) {
    // Walk again to get the last text node.
    const w2 = textWalker(root);
    let last = null;
    while ((node = w2.nextNode()) !== null) last = node;
    if (last) {
      anchorNode     = last;
      anchorLocalOff = last.nodeValue.length;
    } else {
      // Truly empty — nothing to restore to.
      return;
    }
  }
  if (!focusNode) {
    focusNode     = anchorNode;
    focusLocalOff = anchorLocalOff;
  }

  // Clamp offsets to text node lengths.
  anchorLocalOff = Math.min(anchorLocalOff, anchorNode.nodeValue.length);
  focusLocalOff  = Math.min(focusLocalOff,  focusNode.nodeValue.length);

  const sel = window.getSelection();
  if (!sel) return;

  try {
    sel.setBaseAndExtent(anchorNode, anchorLocalOff, focusNode, focusLocalOff);
  } catch (e) {
    // Fallback: use a Range.
    try {
      const range = document.createRange();
      range.setStart(anchorNode, anchorLocalOff);
      range.setEnd(focusNode, focusLocalOff);
      sel.removeAllRanges();
      sel.addRange(range);
    } catch (e2) {
      console.warn('setCaretOffset: failed to restore caret', e2);
    }
  }
}

// ── HTML rendering ────────────────────────────────────────────────────────────

/**
 * Escape a string for safe insertion as HTML text content.
 * @param {string} s
 * @returns {string}
 */
function esc(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Convert flat token list into per-line HTML.
 * Each line becomes a <div>. Tokens spanning line boundaries are split.
 * Empty lines use <div><br></div> so they have height.
 *
 * @param {Array<{type:string, text:string}>} tokens
 * @returns {string}  Inner HTML for the editor.
 */
function tokensToHtml(tokens) {
  // First, build an array of "line segments" — each line is an array of {type, text}.
  // We split tokens on newline characters.
  const lines = [[]];

  for (const tok of tokens) {
    const parts = tok.text.split('\n');
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) {
        // Start a new line.
        lines.push([]);
      }
      if (parts[i].length > 0) {
        lines[lines.length - 1].push({ type: tok.type, text: parts[i] });
      }
    }
  }

  // Build HTML.
  const divs = [];
  for (const lineTokens of lines) {
    if (lineTokens.length === 0) {
      // Empty line — needs <br> so it has height.
      divs.push('<div><br></div>');
    } else {
      let inner = '';
      for (const tok of lineTokens) {
        const escaped = esc(tok.text);
        if (tok.type === 'plain') {
          inner += escaped;
        } else {
          inner += '<span class="tok-' + tok.type + '">' + escaped + '</span>';
        }
      }
      divs.push('<div>' + inner + '</div>');
    }
  }

  return divs.join('');
}

/**
 * Get plain text from the editor's current DOM.
 *
 * Strategy: walk the DOM tree of editorEl, emitting text node values and
 * inserting '\n' at block boundaries (div, p, br elements). This correctly
 * handles both our rendered structure (div-per-line) and any browser-injected
 * markup from typing, Enter key, or paste.
 *
 * @param {Element} editorEl
 * @returns {string}
 */
function getPlainText(editorEl) {
  // We accumulate into an array of strings and join at the end.
  // Track whether the last character emitted was already a newline,
  // so we never emit two '\n' in a row for a single line boundary.
  let result = '';

  function ensureNewline() {
    if (result.length > 0 && result[result.length - 1] !== '\n') {
      result += '\n';
    }
  }

  function walk(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      result += node.nodeValue;
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;

    const tag = node.tagName.toUpperCase();

    if (tag === 'BR') {
      // <br> always means a newline.
      ensureNewline();
      return;
    }

    const isBlock = (tag === 'DIV' || tag === 'P');

    if (isBlock && node !== editorEl) {
      // Opening a block: ensure we're on a new line (except at very start).
      if (result.length > 0) {
        ensureNewline();
      }
    }

    for (const child of node.childNodes) {
      walk(child);
    }

    // We do NOT add a trailing '\n' after a block — the NEXT block's
    // opening ensureNewline() handles the separator. This avoids a
    // spurious trailing newline after the last line.
  }

  walk(editorEl);
  return result;
}

// ── Code folding ──────────────────────────────────────────────────────────────

/**
 * Compute foldable ranges from text.
 * Returns an array of {start, end} (1-indexed line numbers).
 * Brace-based folding takes priority over indent-based when both match the same
 * start line.
 *
 * @param {string} text
 * @returns {Array<{start:number, end:number}>}
 */
function computeFoldRanges(text) {
  const lines = text.split('\n');
  const n = lines.length;

  // Map from start line (1-indexed) -> range, for deduplication.
  const byStart = new Map();

  // ── Brace-based folding ───────────────────────────────────────────────────
  // Stack entries: {line: number (1-indexed)}
  const stack = [];
  for (let i = 0; i < n; i++) {
    const lineNum = i + 1;
    const trimmed = lines[i].trimEnd();
    if (trimmed.endsWith('{')) {
      stack.push({ line: lineNum });
    }
    // Count closing braces on this line; match from innermost outward.
    // Walk character by character to handle multiple braces on one line.
    for (let ci = 0; ci < lines[i].length; ci++) {
      if (lines[i][ci] === '}' && stack.length > 0) {
        const openEntry = stack.pop();
        const start = openEntry.line;
        const end = lineNum;
        if (end > start + 1) {
          // Brace-based wins over indent-based for the same start.
          byStart.set(start, { start, end, brace: true });
        }
      }
    }
  }

  // ── Indent-based folding ─────────────────────────────────────────────────
  // Compute indent level (number of leading spaces, treating tab=1) per line.
  function indentLevel(line) {
    let count = 0;
    for (let i = 0; i < line.length; i++) {
      if (line[i] === ' ')  { count++; }
      else if (line[i] === '\t') { count++; }
      else break;
    }
    return count;
  }

  // For each line i, find the next non-empty line's indent.
  for (let i = 0; i < n; i++) {
    const lineNum = i + 1;
    if (lines[i].trim() === '') continue; // skip empty lines

    const myIndent = indentLevel(lines[i]);

    // Find next non-empty line.
    let nextIdx = -1;
    for (let j = i + 1; j < n; j++) {
      if (lines[j].trim() !== '') { nextIdx = j; break; }
    }
    if (nextIdx === -1) continue;
    const nextIndent = indentLevel(lines[nextIdx]);

    if (nextIndent <= myIndent) continue; // not a fold start

    // Find end: last line before indent drops back to or below myIndent.
    let endIdx = nextIdx;
    for (let j = nextIdx + 1; j < n; j++) {
      if (lines[j].trim() === '') continue; // ignore empty lines
      if (indentLevel(lines[j]) > myIndent) {
        endIdx = j;
      } else {
        break;
      }
    }
    const end = endIdx + 1; // 1-indexed

    if (end > lineNum + 1) {
      // Only add if not already claimed by brace-based at this start line.
      if (!byStart.has(lineNum) || !byStart.get(lineNum).brace) {
        byStart.set(lineNum, { start: lineNum, end });
      }
    }
  }

  // Return sorted array of {start, end}.
  const ranges = [];
  for (const r of byStart.values()) {
    ranges.push({ start: r.start, end: r.end });
  }
  ranges.sort((a, b) => a.start - b.start);
  return ranges;
}

// ── Bracket matching helpers ──────────────────────────────────────────────────

const BRACKET_PAIRS = { '(': ')', '[': ']', '{': '}', '<': '>' };
const BRACKET_CLOSE = { ')': '(', ']': '[', '}': '{', '>': '<' };
const ALL_BRACKETS = new Set(['(', ')', '[', ']', '{', '}', '<', '>']);

/**
 * Given a string and the position of an opening bracket, find its matching
 * closing bracket position. Returns -1 if not found.
 * @param {string} text
 * @param {number} pos   position of the opening bracket
 * @returns {number}
 */
function findMatchingClose(text, pos) {
  const open = text[pos];
  const close = BRACKET_PAIRS[open];
  if (!close) return -1;
  let depth = 0;
  for (let i = pos; i < text.length; i++) {
    if (text[i] === open)  depth++;
    if (text[i] === close) depth--;
    if (depth === 0) return i;
  }
  return -1;
}

/**
 * Given a string and the position of a closing bracket, find its matching
 * opening bracket position. Returns -1 if not found.
 * @param {string} text
 * @param {number} pos   position of the closing bracket
 * @returns {number}
 */
function findMatchingOpen(text, pos) {
  const close = text[pos];
  const open  = BRACKET_CLOSE[close];
  if (!open) return -1;
  let depth = 0;
  for (let i = pos; i >= 0; i--) {
    if (text[i] === close) depth++;
    if (text[i] === open)  depth--;
    if (depth === 0) return i;
  }
  return -1;
}

// ── Editor class ──────────────────────────────────────────────────────────────

class EditorInstance {
  /**
   * @param {Element} containerEl
   */
  constructor(containerEl) {
    this._container = containerEl;
    this._lang = 'plain';
    this._lastText = null; // Track last rendered text to skip no-op re-renders.
    this._wrapEnabled = true; // Word-wrap state.
    this._bracketMatchSpans = []; // Currently highlighted bracket spans.
    this._foldedRanges = new Set(); // Set of fold-start line numbers (1-indexed).
    this._foldRanges = []; // Current computed fold ranges [{start,end}].

    // Build the editor layout:
    //   #editor-wrap (flex row)
    //     #line-numbers
    //     .editor-inner (contenteditable)

    // Wrap div (flex row container).
    const wrap = document.createElement('div');
    wrap.id = 'editor-wrap';
    containerEl.appendChild(wrap);
    this._wrap = wrap;

    // Line number gutter.
    const gutter = document.createElement('div');
    gutter.id = 'line-numbers';
    wrap.appendChild(gutter);
    this._gutter = gutter;

    // Create the inner editable div.
    const inner = document.createElement('div');
    inner.contentEditable = 'true';
    inner.spellcheck = false;
    inner.setAttribute('autocorrect', 'off');
    inner.setAttribute('autocapitalize', 'off');
    inner.className = 'editor-inner';
    wrap.appendChild(inner);
    this._inner = inner;

    // Bind event handlers.
    this._onInput    = this._onInput.bind(this);
    this._onKeydown  = this._onKeydown.bind(this);
    this._onSelChange = this._onSelChange.bind(this);
    this._onScroll   = this._onScroll.bind(this);

    inner.addEventListener('input',   this._onInput);
    inner.addEventListener('keydown', this._onKeydown);
    inner.addEventListener('scroll',  this._onScroll);
    document.addEventListener('selectionchange', this._onSelChange);
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Load text into the editor and set the language.
   * @param {string} text
   * @param {string} lang
   */
  setValue(text, lang) {
    this._lang = lang || 'plain';
    this._lastText = text;
    this._render(text);
    // Place caret at start.
    this._inner.focus();
    setCaretOffset(this._inner, 0, 0);
  }

  /**
   * Get the current plain text content.
   * @returns {string}
   */
  getValue() {
    return getPlainText(this._inner);
  }

  /**
   * Get the current caret position as {anchor, focus} character offsets.
   * Returns null if the selection is not inside the editor.
   * @returns {{anchor:number, focus:number}|null}
   */
  getCaretOffset() {
    return getCaretOffset(this._inner);
  }

  /**
   * Set the caret to the given character offsets.
   * @param {number} anchor
   * @param {number} focus
   */
  setCaretOffset(anchor, focus) {
    setCaretOffset(this._inner, anchor, focus);
  }

  /**
   * Change the language and re-highlight without changing content.
   * @param {string} lang
   */
  setLang(lang) {
    this._lang = lang || 'plain';
    const text = this.getValue();
    const caret = getCaretOffset(this._inner);
    this._render(text);
    if (caret) setCaretOffset(this._inner, caret.anchor, caret.focus);
  }

  /**
   * Toggle word-wrap on/off.
   */
  toggleWrap() {
    this._wrapEnabled = !this._wrapEnabled;
    this._applyWrap();
    // Update button label if present.
    const btn = document.getElementById('btn-wrap');
    if (btn) btn.classList.toggle('active', this._wrapEnabled);
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  /**
   * Apply current wrap setting to the inner editor element.
   */
  _applyWrap() {
    if (this._wrapEnabled) {
      this._inner.style.whiteSpace = 'pre-wrap';
      this._inner.style.wordBreak  = 'break-all';
      this._inner.style.overflowX  = '';
    } else {
      this._inner.style.whiteSpace = 'pre';
      this._inner.style.wordBreak  = '';
      this._inner.style.overflowX  = 'auto';
    }
  }

  /**
   * Render text with syntax highlighting into the editor.
   * Applies folding: lines inside a folded range get class "folded-line".
   * @param {string} text
   */
  _render(text) {
    // Recompute fold ranges from latest text.
    this._foldRanges = computeFoldRanges(text);

    // Build a set of lines that are hidden (inside a folded range).
    // Also build a map: startLine -> end, for ranges that are folded.
    const hiddenLines = new Set(); // 1-indexed line numbers to hide
    for (const range of this._foldRanges) {
      if (this._foldedRanges.has(range.start)) {
        for (let ln = range.start + 1; ln <= range.end; ln++) {
          hiddenLines.add(ln);
        }
      }
    }

    // Tokenize and build per-line HTML, then apply folded-line class.
    const tokens = window.tokenize(text, this._lang);
    // Build lines array with fold state applied.
    const lines = [[]];
    for (const tok of tokens) {
      const parts = tok.text.split('\n');
      for (let i = 0; i < parts.length; i++) {
        if (i > 0) lines.push([]);
        if (parts[i].length > 0) {
          lines[lines.length - 1].push({ type: tok.type, text: parts[i] });
        }
      }
    }

    const divs = [];
    for (let li = 0; li < lines.length; li++) {
      const lineNum = li + 1;
      const lineTokens = lines[li];
      const hidden = hiddenLines.has(lineNum);
      const classAttr = hidden ? ' class="folded-line"' : '';
      if (lineTokens.length === 0) {
        divs.push('<div' + classAttr + '><br></div>');
      } else {
        let inner = '';
        for (const tok of lineTokens) {
          const escaped = esc(tok.text);
          if (tok.type === 'plain') {
            inner += escaped;
          } else {
            inner += '<span class="tok-' + tok.type + '">' + escaped + '</span>';
          }
        }
        divs.push('<div' + classAttr + '>' + inner + '</div>');
      }
    }

    this._inner.innerHTML = divs.join('');
    this._updateLineNumbers(text);

    // Notify search module (or any other after-render hook).
    if (typeof this.onAfterRender === 'function') {
      this.onAfterRender();
    }
  }

  /**
   * Update the line number gutter to match the current text.
   * Shows fold markers (▶/▼) next to foldable lines.
   * @param {string} text
   */
  _updateLineNumbers(text) {
    const lineCount = text === '' ? 1 : text.split('\n').length;

    // Build a map from start line -> end for fast lookup.
    const foldableMap = new Map(); // startLine -> end
    for (const range of this._foldRanges) {
      foldableMap.set(range.start, range.end);
    }

    let html = '';
    for (let i = 1; i <= lineCount; i++) {
      if (foldableMap.has(i)) {
        const isFolded = this._foldedRanges.has(i);
        const marker = isFolded ? '&#9658;' : '&#9660;'; // ▶ or ▼
        html += '<div>'
          + '<span class="fold-marker" data-fold-start="' + i + '">' + marker + '</span>'
          + i
          + '</div>';
      } else {
        html += '<div><span class="fold-marker-placeholder"></span>' + i + '</div>';
      }
    }
    this._gutter.innerHTML = html;

    // Attach click handlers to fold markers.
    const markers = this._gutter.querySelectorAll('.fold-marker');
    for (const marker of markers) {
      marker.addEventListener('click', () => {
        const startLine = parseInt(marker.dataset.foldStart, 10);
        this.toggleFold(startLine);
      });
    }
  }

  /**
   * Toggle fold state for the given start line, then re-render.
   * @param {number} startLine  1-indexed line number of the fold start.
   */
  toggleFold(startLine) {
    if (this._foldedRanges.has(startLine)) {
      this._foldedRanges.delete(startLine);
    } else {
      this._foldedRanges.add(startLine);
    }
    // Re-render using the last known text (getValue() reads DOM, works fine).
    const text = this._lastText !== null ? this._lastText : this.getValue();
    this._render(text);
  }

  /**
   * Get the fold range containing the given 1-indexed line number, or null.
   * @param {number} lineNum
   * @returns {{start:number,end:number}|null}
   */
  _foldRangeForLine(lineNum) {
    for (const range of this._foldRanges) {
      if (lineNum >= range.start && lineNum <= range.end) {
        return range;
      }
    }
    return null;
  }

  /**
   * Sync gutter scroll position to match the editor.
   */
  _onScroll() {
    this._gutter.scrollTop = this._inner.scrollTop;
  }

  /**
   * Handle input events: save caret, re-render, restore caret.
   */
  _onInput() {
    const text = this.getValue();

    // Skip re-render if content hasn't changed.
    if (text === this._lastText) return;
    this._lastText = text;

    // Save caret before re-render.
    const caret = getCaretOffset(this._inner);

    // Re-render.
    this._render(text);

    // Restore caret.
    if (caret !== null) {
      setCaretOffset(this._inner, caret.anchor, caret.focus);
    }

    // Notify change listeners.
    if (typeof this.onchange === 'function') {
      this.onchange(text);
    }
  }

  /**
   * Remove event listeners and detach the inner element from the DOM.
   */
  destroy() {
    this._inner.removeEventListener('input',   this._onInput);
    this._inner.removeEventListener('keydown', this._onKeydown);
    this._inner.removeEventListener('scroll',  this._onScroll);
    document.removeEventListener('selectionchange', this._onSelChange);
    if (this._wrap.parentNode) {
      this._wrap.parentNode.removeChild(this._wrap);
    }
  }

  /**
   * Insert text at the current caret position (replacing any selection).
   * @param {string} text
   */
  _insertAtCaret(text) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    range.deleteContents();
    const node = document.createTextNode(text);
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  /**
   * Handle keydown events.
   * - Tab:   insert 2 spaces.
   * - Enter: auto-indent.
   * - Auto-close pairs: (, [, {, ", '
   * - Alt+Z: toggle word-wrap.
   */
  _onKeydown(e) {
    // ── Alt+Z: word-wrap toggle ──────────────────────────────────────────────
    if (e.altKey && e.key === 'z') {
      e.preventDefault();
      this.toggleWrap();
      return;
    }

    // ── Ctrl+Shift+[ : fold range containing cursor ──────────────────────────
    if (e.ctrlKey && e.shiftKey && e.key === '[') {
      e.preventDefault();
      const text = this._lastText !== null ? this._lastText : this.getValue();
      const caret = getCaretOffset(this._inner);
      if (caret !== null) {
        // Determine current line number (1-indexed).
        const before = text.slice(0, caret.focus);
        const lineNum = before.split('\n').length;
        const range = this._foldRangeForLine(lineNum);
        if (range && !this._foldedRanges.has(range.start)) {
          this._foldedRanges.add(range.start);
          this._render(text);
        }
      }
      return;
    }

    // ── Ctrl+Shift+] : unfold range containing cursor ────────────────────────
    if (e.ctrlKey && e.shiftKey && e.key === ']') {
      e.preventDefault();
      const text = this._lastText !== null ? this._lastText : this.getValue();
      const caret = getCaretOffset(this._inner);
      if (caret !== null) {
        const before = text.slice(0, caret.focus);
        const lineNum = before.split('\n').length;
        const range = this._foldRangeForLine(lineNum);
        if (range && this._foldedRanges.has(range.start)) {
          this._foldedRanges.delete(range.start);
          this._render(text);
        }
      }
      return;
    }

    // ── Tab: insert 2 spaces ─────────────────────────────────────────────────
    if (e.key === 'Tab') {
      e.preventDefault();

      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return;

      const range = sel.getRangeAt(0);
      range.deleteContents();

      const spaces = document.createTextNode('  ');
      range.insertNode(spaces);

      range.setStartAfter(spaces);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);

      this._onInput();
      return;
    }

    // ── Auto-close pairs ─────────────────────────────────────────────────────
    const AUTO_PAIRS = { '(': ')', '[': ']', '{': '}', '"': '"', "'": "'" };
    if (AUTO_PAIRS.hasOwnProperty(e.key)) {
      const text     = this.getValue();
      const caretPos = getCaretOffset(this._inner);
      if (caretPos !== null) {
        const pos      = caretPos.focus;
        const nextChar = text[pos] || '';
        const prevChar = pos > 0 ? text[pos - 1] : '';

        // Smart: don't auto-close if next char is not whitespace/EOL.
        const nextIsWsOrEnd = nextChar === '' || /[\s\n\r]/.test(nextChar)
                           || nextChar === ')' || nextChar === ']'
                           || nextChar === '}' || nextChar === '"'
                           || nextChar === "'";

        // For quotes: don't auto-close if previous char is the same quote.
        const isQuote    = e.key === '"' || e.key === "'";
        const prevIsSame = prevChar === e.key;

        if (nextIsWsOrEnd && !(isQuote && prevIsSame)) {
          e.preventDefault();
          const closing = AUTO_PAIRS[e.key];
          this._insertAtCaret(e.key + closing);
          // Move caret back one position (between the pair).
          const newCaret = getCaretOffset(this._inner);
          if (newCaret !== null) {
            setCaretOffset(this._inner, newCaret.focus - 1, newCaret.focus - 1);
          }
          this._onInput();
          return;
        }
      }
    }

    // ── Enter: auto-indent ───────────────────────────────────────────────────
    if (e.key === 'Enter') {
      e.preventDefault();

      const text     = this.getValue();
      const caretPos = getCaretOffset(this._inner);
      if (caretPos === null) return;

      const pos = Math.min(caretPos.anchor, caretPos.focus);

      // Find the start of the current line.
      let lineStart = text.lastIndexOf('\n', pos - 1);
      lineStart = lineStart === -1 ? 0 : lineStart + 1;

      // Find the end of the current line.
      let lineEnd = text.indexOf('\n', pos);
      if (lineEnd === -1) lineEnd = text.length;

      const currentLine = text.slice(lineStart, lineEnd);

      // Extract leading whitespace.
      const leadingWs = currentLine.match(/^(\s*)/)[1];

      // Check if line ends (up to caret) with an indent-triggering character.
      const beforeCaret = text.slice(lineStart, pos).trimEnd();
      const lastChar    = beforeCaret[beforeCaret.length - 1] || '';
      const extraIndent = (lastChar === '{' || lastChar === '(' ||
                           lastChar === '[' || lastChar === ':')
                        ? '  ' : '';

      const indent = leadingWs + extraIndent;

      // Delete any selection, then insert newline + indent.
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return;
      const range = sel.getRangeAt(0);
      range.deleteContents();
      const node = document.createTextNode('\n' + indent);
      range.insertNode(node);
      range.setStartAfter(node);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);

      this._onInput();
      return;
    }
  }

  // ── Bracket match highlight ─────────────────────────────────────────────────

  /**
   * Clear any existing bracket-match highlights.
   */
  _clearBracketMatch() {
    for (const span of this._bracketMatchSpans) {
      span.classList.remove('tok-bracket-match');
    }
    this._bracketMatchSpans = [];
  }

  /**
   * Given a character offset into the plain text, find the DOM span (or text
   * node's parent) at that position and add the bracket-match class.
   * @param {string} text   full plain text
   * @param {number} charOff  character offset of the bracket
   */
  _highlightBracketAt(text, charOff) {
    // Walk text nodes to find the one containing charOff.
    const walker = textWalker(this._inner);
    let count = 0;
    let node;
    while ((node = walker.nextNode()) !== null) {
      const len = node.nodeValue.length;
      if (count + len > charOff) {
        // This text node contains our character.
        // The span to highlight is this node's closest element ancestor inside _inner.
        let el = node.parentNode;
        while (el && el !== this._inner && el.parentNode !== this._inner) {
          el = el.parentNode;
        }
        if (el && el !== this._inner) {
          el.classList.add('tok-bracket-match');
          this._bracketMatchSpans.push(el);
        }
        return;
      }
      count += len;
    }
  }

  /**
   * Handle selection change: update bracket match highlights.
   */
  _onSelChange() {
    this._clearBracketMatch();

    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    if (!this._inner.contains(range.commonAncestorContainer)) return;

    const text  = this.getValue();
    const caret = getCaretOffset(this._inner);
    if (!caret) return;

    const pos = caret.focus;

    // Check character just before caret (pos-1) and at caret (pos).
    const charBefore = pos > 0 ? text[pos - 1] : '';
    const charAt     = text[pos] || '';

    let bracketPos   = -1;
    let matchPos     = -1;

    if (ALL_BRACKETS.has(charBefore)) {
      const ch = charBefore;
      if (BRACKET_PAIRS[ch]) {
        // Opening bracket before caret.
        bracketPos = pos - 1;
        matchPos   = findMatchingClose(text, bracketPos);
      } else if (BRACKET_CLOSE[ch]) {
        // Closing bracket before caret.
        bracketPos = pos - 1;
        matchPos   = findMatchingOpen(text, bracketPos);
      }
    } else if (ALL_BRACKETS.has(charAt)) {
      const ch = charAt;
      if (BRACKET_PAIRS[ch]) {
        bracketPos = pos;
        matchPos   = findMatchingClose(text, bracketPos);
      } else if (BRACKET_CLOSE[ch]) {
        bracketPos = pos;
        matchPos   = findMatchingOpen(text, bracketPos);
      }
    }

    if (bracketPos !== -1 && matchPos !== -1) {
      this._highlightBracketAt(text, bracketPos);
      this._highlightBracketAt(text, matchPos);
    }
  }
}

// ── Public Editor object ──────────────────────────────────────────────────────

const Editor = {
  /**
   * Initialize the editor in the given container element.
   * @param {Element} containerEl
   * @returns {EditorInstance}
   */
  init(containerEl) {
    return new EditorInstance(containerEl);
  },
};

window.Editor = Editor;
