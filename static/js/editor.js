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
   * @param {string} text
   */
  _render(text) {
    const tokens = window.tokenize(text, this._lang);
    const html   = tokensToHtml(tokens);
    this._inner.innerHTML = html;
    this._updateLineNumbers(text);
  }

  /**
   * Update the line number gutter to match the current text.
   * @param {string} text
   */
  _updateLineNumbers(text) {
    const lineCount = text === '' ? 1 : text.split('\n').length;
    let html = '';
    for (let i = 1; i <= lineCount; i++) {
      html += '<div>' + i + '</div>';
    }
    this._gutter.innerHTML = html;
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
