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
  // Case 1: text node — walk line-divs in order, counting one '\n' per line
  // boundary, then text-node lengths within the containing line-div.
  // This matches the coordinate space of getPlainText / offsetToDomPosition.
  if (targetNode && targetNode.nodeType === Node.TEXT_NODE) {
    let count = 0;
    for (let li = 0; li < root.children.length; li++) {
      const lineDiv = root.children[li];
      // Walk text nodes inside this line div.
      const w = textWalker(lineDiv);
      let node;
      let lineLen = 0;
      let found = false;
      while ((node = w.nextNode()) !== null) {
        if (node === targetNode) {
          return count + lineLen + targetOffset;
        }
        lineLen += node.nodeValue.length;
      }
      // targetNode not in this line; add line length + 1 for the '\n'.
      count += lineLen + 1;
    }
    // Not found — return total accumulated count.
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

    // General element case: the caret element lives inside one of the line
    // divs (e.g. an empty line's <div> at child-offset 0). Count full lines
    // before that div — INCLUDING one '\n' per line boundary, to stay in the
    // same coordinate space as getPlainText — then the text within the line
    // div that precedes the caret.
    let lineDiv = targetNode;
    while (lineDiv && lineDiv.parentNode !== root) {
      lineDiv = lineDiv.parentNode;
    }
    if (!lineDiv) return 0; // targetNode not inside root

    let count = 0;
    for (let li = 0; li < root.children.length; li++) {
      const div = root.children[li];
      if (div === lineDiv) break;
      const w = textWalker(div);
      let node;
      while ((node = w.nextNode()) !== null) count += node.nodeValue.length;
      count += 1; // '\n' at this line boundary
    }

    // Within the line div, count text nodes preceding the caret position.
    const w = textWalker(lineDiv);
    let node;
    let within = 0;
    while ((node = w.nextNode()) !== null) {
      if (targetNode.contains(node)) {
        // Text inside the target element: count only direct children of
        // targetNode that come before child index targetOffset.
        let ancestor = node;
        while (ancestor.parentNode !== targetNode) {
          ancestor = ancestor.parentNode;
        }
        const idx = Array.prototype.indexOf.call(targetNode.childNodes, ancestor);
        if (idx < targetOffset) within += node.nodeValue.length;
      } else if (targetNode.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_PRECEDING) {
        // Text in the same line div but before the target element.
        within += node.nodeValue.length;
      }
    }
    return count + within;
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
 * Convert a character offset (in the same space as nodeOffsetToChar) to a
 * DOM {node, offset} pair suitable for Selection/Range APIs.
 *
 * This is the true inverse of nodeOffsetToChar: both count one '\n' per line
 * boundary. Empty lines (<div><br></div>) are handled by returning the div
 * element itself at child-offset 0 (before the <br>), which is the only way
 * to place a cursor on an empty contenteditable line.
 *
 * Relies on the editor's render invariant: root.children[i] === line i div.
 *
 * @param {Element} root   The editor-inner element.
 * @param {number}  off    Character offset to resolve.
 * @returns {{node: Node, offset: number}}
 */
function offsetToDomPosition(root, off) {
  const text  = getPlainText(root);
  const lines = text.split('\n');

  // Clamp to valid range.
  const maxOff = text.length;
  off = Math.max(0, Math.min(off, maxOff));

  // Find which line and column the offset falls in.
  let lineIndex = 0;
  let remaining = off;
  for (let i = 0; i < lines.length; i++) {
    const lineLen = lines[i].length;
    if (remaining <= lineLen) {
      lineIndex = i;
      break;
    }
    remaining -= lineLen + 1; // +1 for the '\n'
    lineIndex = i + 1;        // may be past last line if off === text.length
  }
  lineIndex = Math.min(lineIndex, lines.length - 1);
  const column = remaining;

  // Get the corresponding line div.
  const lineDiv = root.children[lineIndex];
  if (!lineDiv) {
    // No children at all — editor is empty; nothing to target.
    return null;
  }

  // Empty line: <div><br></div> — no text node. Place caret at child-offset 0
  // inside the div (before the <br>). This is how browsers expect it.
  const lineText = lines[lineIndex];
  if (lineText.length === 0) {
    return { node: lineDiv, offset: 0 };
  }

  // Non-empty line: walk text nodes inside lineDiv and find the one containing
  // the target column.
  const walker = textWalker(lineDiv);
  let count = 0;
  let node;
  let lastNode = null;
  while ((node = walker.nextNode()) !== null) {
    lastNode = node;
    const len = node.nodeValue.length;
    if (count + len >= column) {
      return { node, offset: column - count };
    }
    count += len;
  }

  // column is past all text nodes (shouldn't happen if render is correct, but
  // guard: place at end of last text node).
  if (lastNode) {
    return { node: lastNode, offset: lastNode.nodeValue.length };
  }

  // Final fallback: element position.
  return { node: lineDiv, offset: 0 };
}

/**
 * Restore the selection from character offsets relative to `root`.
 * Uses offsetToDomPosition which correctly accounts for line boundaries and
 * empty lines — making this a true inverse of nodeOffsetToChar.
 *
 * @param {Element} root
 * @param {number}  anchorOff
 * @param {number}  focusOff
 */
function setCaretOffset(root, anchorOff, focusOff) {
  const a = offsetToDomPosition(root, anchorOff);
  if (!a) return; // empty editor

  const f = (focusOff === anchorOff) ? a : (offsetToDomPosition(root, focusOff) || a);

  const sel = window.getSelection();
  if (!sel) return;

  try {
    sel.setBaseAndExtent(a.node, a.offset, f.node, f.offset);
  } catch (e) {
    try {
      const range = document.createRange();
      range.setStart(a.node, a.offset);
      range.setEnd(f.node, f.offset);
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
function _hexSwatchColor(hex) {
  const h = hex.slice(1);
  if (h.length === 3) return '#' + h[0]+h[0] + h[1]+h[1] + h[2]+h[2];
  if (h.length === 4) return '#' + h[0]+h[0] + h[1]+h[1] + h[2]+h[2] + h[3]+h[3];
  return hex;
}

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
  let result = '';
  // Each block (line div) after the first contributes exactly ONE '\n' at its
  // opening — unconditionally. Deduplicating here (the old ensureNewline
  // approach) collapsed consecutive empty lines, because an empty line's only
  // contribution IS its boundary newline.
  let seenFirstBlock = false;

  /**
   * A <br> that is the last visible node of its containing block is a
   * placeholder the browser needs to give an empty line height — it does NOT
   * represent an extra newline (the block boundary already provides one).
   * Only <br>s followed by more content within the block are real breaks.
   */
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
      result += node.nodeValue;
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;

    const tag = node.tagName.toUpperCase();

    if (tag === 'BR') {
      if (!isTrailingBr(node, blockEl)) {
        result += '\n';
      }
      return;
    }

    const isBlock = (tag === 'DIV' || tag === 'P');

    if (isBlock && node !== editorEl) {
      if (seenFirstBlock || result.length > 0) {
        // Boundary before every block except the very first (stray text at
        // the root before the first block also needs a separator).
        result += '\n';
      }
      seenFirstBlock = true;
      blockEl = node; // this block scopes trailing-<br> detection
    }

    for (const child of node.childNodes) {
      walk(child, blockEl);
    }
  }

  walk(editorEl, editorEl);
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

/**
 * Given old and new text, return a mapper: old 1-indexed line → new 1-indexed line or null.
 * Lines before the first change are unshifted; lines after shift by the line-count delta;
 * lines inside the changed block map to null (fold dissolved).
 * @param {string} oldText
 * @param {string} newText
 * @returns {function(number): number|null}
 */
function remapLines(oldText, newText) {
  const o = oldText.split('\n'), nw = newText.split('\n');
  let pre = 0;
  while (pre < o.length && pre < nw.length && o[pre] === nw[pre]) pre++;
  let suf = 0;
  while (suf < (o.length - pre) && suf < (nw.length - pre) &&
         o[o.length - 1 - suf] === nw[nw.length - 1 - suf]) suf++;
  const oldChangedEnd = o.length - suf; // exclusive, 0-indexed
  const delta = nw.length - o.length;
  return (line1) => {
    const i = line1 - 1; // 0-indexed
    if (i < pre) return line1;               // before change: unchanged
    if (i >= oldChangedEnd) return line1 + delta; // after change: shifted
    return null;                             // inside changed block: dissolve
  };
}

function computeFoldRanges(text) {
  const lines = text.split('\n');
  const n = lines.length;

  // Map from start line (1-indexed) -> range, for deduplication.
  const byStart = new Map();

  // ── Delimiter-based folding (braces and parens) ──────────────────────────
  // Stack entries: {line, open, close}. A closing char only pops a matching opener.
  const stack = [];
  for (let i = 0; i < n; i++) {
    const lineNum = i + 1;
    const trimmed = lines[i].trimEnd();
    if (trimmed.endsWith('{')) {
      stack.push({ line: lineNum, open: '{', close: '}' });
    } else if (trimmed.endsWith('(')) {
      stack.push({ line: lineNum, open: '(', close: ')' });
    }
    // Walk character by character; each closer pops the nearest matching opener.
    for (let ci = 0; ci < lines[i].length; ci++) {
      const ch = lines[i][ci];
      if (ch !== '}' && ch !== ')') continue;
      let si = stack.length - 1;
      while (si >= 0 && stack[si].close !== ch) si--; // nearest matching opener
      if (si < 0) continue;                            // unmatched closer, ignore
      const openEntry = stack.splice(si, 1)[0];
      const start = openEntry.line, end = lineNum;
      if (end > start + 1) {
        // Delimiter-based wins over indent-based for the same start.
        byStart.set(start, {
          start, end, brace: true,
          open: openEntry.open, close: openEntry.close,
        });
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

  // Return sorted array of {start, end, open, close}.
  const ranges = [];
  for (const r of byStart.values()) {
    ranges.push({ start: r.start, end: r.end, open: r.open, close: r.close });
  }
  ranges.sort((a, b) => a.start - b.start);
  return ranges;
}

// ── Bracket matching helpers ──────────────────────────────────────────────────

const BRACKET_PAIRS = { '(': ')', '[': ']', '{': '}', '<': '>' };
const BRACKET_CLOSE = { ')': '(', ']': '[', '}': '{', '>': '<' };
const ALL_BRACKETS = new Set(['(', ')', '[', ']', '{', '}', '<', '>']);
// Auto-close pairs (used by both _onKeydown for physical keyboards and _onInput
// for soft/touch keyboards where keydown doesn't carry the typed character).
// Note: '{' is intentionally excluded — '}' is inserted on Enter, not on typing '{'.
const AUTO_PAIRS = { '(': ')', '[': ']', '"': '"', "'": "'" };

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
    this._largeMode = false;
    this._bracketMatchSpans = []; // Currently highlighted bracket spans.
    this._foldedRanges = new Set(); // Set of fold-start line numbers (1-indexed).
    this._foldRanges = []; // Current computed fold ranges [{start,end}].

    // Autocomplete state.
    this._acItems = [];       // current suggestion strings
    this._acPrefix = '';      // prefix being completed
    this._acIndex = 0;        // selected index
    this._acEl = null;        // popup DOM element (lazy)
    this._acSuppress = false; // true after Escape until the current word ends

    // Custom undo/redo history (native history is destroyed by innerHTML re-render).
    this._history = [];       // [{text, caret:{anchor,focus}}]
    this._historyIndex = -1;  // Points to current state in _history.
    this._lastSnapshotTime = 0;

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

    // Very large files use one native textarea instead of creating and
    // highlighting hundreds of thousands of DOM line nodes.
    const large = document.createElement('textarea');
    large.className = 'large-file-editor';
    large.spellcheck = false;
    large.setAttribute('autocorrect', 'off');
    large.setAttribute('autocapitalize', 'off');
    large.style.display = 'none';
    containerEl.appendChild(large);
    this._large = large;
    this._onLargeInput = () => {
      const text = large.value;
      this._lastText = text;
      if (typeof this.onchange === 'function') this.onchange(text);
      if (typeof this.onUndoRedoChange === 'function') this.onUndoRedoChange();
    };
    large.addEventListener('input', this._onLargeInput);

    // Bind event handlers.
    this._onInput    = this._onInput.bind(this);
    this._onKeydown  = this._onKeydown.bind(this);
    this._onSelChange = this._onSelChange.bind(this);

    inner.addEventListener('input',   this._onInput);
    inner.addEventListener('keydown', this._onKeydown);
    // Tapping the "…" preview pill on a folded line expands it.
    inner.addEventListener('click', (e) => {
      const pill = e.target.closest && e.target.closest('.fold-pill');
      if (pill) {
        e.preventDefault();
        this.toggleFold(parseInt(pill.dataset.foldStart, 10));
      }
    });
    document.addEventListener('selectionchange', this._onSelChange);

    // Intercept beforeinput historyUndo/Redo so the browser doesn't attempt
    // native undo (which is always empty because innerHTML re-render wipes it).
    // Our custom undo/redo is handled in _onKeydown and the topbar buttons.
    inner.addEventListener('beforeinput', (e) => {
      if (e.inputType === 'historyUndo') { e.preventDefault(); this.undo(); }
      if (e.inputType === 'historyRedo') { e.preventDefault(); this.redo(); }
    });

    // Hide the autocomplete popup when the editor pane scrolls (its fixed
    // position would drift from the caret otherwise).
    const pane = document.getElementById('editor-pane');
    if (pane) pane.addEventListener('scroll', () => this._hideAutocomplete(), { passive: true });

    // No scroll sync needed: the gutter and the editable area are siblings in
    // #editor-wrap and scroll together inside the single #editor-pane
    // scroll container.
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
    this._hideAutocomplete();
    this._acSuppress = false;
    // Reset per-file history so undo can't cross file boundaries.
    this._history = [{ text, caret: { anchor: 0, focus: 0 } }];
    this._historyIndex = 0;
    this._lastSnapshotTime = 0;
    if (this._shouldUseLargeMode(text)) {
      this._largeMode = true;
      this._wrap.style.display = 'none';
      this._large.style.display = 'block';
      this._large.value = text;
      this._foldedRanges.clear();
      this._foldRanges = [];
      if (!navigator.maxTouchPoints) this._large.focus();
      this._large.setSelectionRange(0, 0);
      return;
    }
    this._largeMode = false;
    this._large.style.display = 'none';
    this._large.value = '';
    this._wrap.style.display = 'flex';
    this._render(text);
    // Place caret at start. Don't focus or set a selection on touch — either one
    // pops the on-screen keyboard, which is unwanted when just switching tabs.
    if (!navigator.maxTouchPoints) {
      this._inner.focus();
      setCaretOffset(this._inner, 0, 0);
    }
  }

  /**
   * Get the current plain text content.
   * @returns {string}
   */
  getValue() {
    if (this._largeMode) return this._large.value;
    return getPlainText(this._inner);
  }

  isLargeFileMode() { return this._largeMode; }

  /**
   * Replace editor content while preserving undo history.
   * Use this instead of setValue() for programmatic edits (find/replace).
   * @param {string} text
   */
  replaceContent(text) {
    this._lastText = text;
    if (this._largeMode || this._shouldUseLargeMode(text)) {
      this._largeMode = true;
      this._wrap.style.display = 'none';
      this._large.style.display = 'block';
      this._large.value = text;
      if (typeof this.onchange === 'function') this.onchange(text);
      if (typeof this.onUndoRedoChange === 'function') this.onUndoRedoChange();
      return;
    }
    this._render(text);
    const pos = Math.min(0, text.length);
    this._pushHistory(text, { anchor: pos, focus: pos });
    // Don't steal focus on touch — prevents keyboard from popping up.
    if (navigator.maxTouchPoints && document.activeElement && document.activeElement !== document.body) {
      document.activeElement.blur();
    }
    if (typeof this.onchange === 'function') this.onchange(text);
    if (typeof this.onUndoRedoChange === 'function') this.onUndoRedoChange();
  }

  /**
   * Get the current caret position as {anchor, focus} character offsets.
   * Returns null if the selection is not inside the editor.
   * @returns {{anchor:number, focus:number}|null}
   */
  getCaretOffset() {
    if (this._largeMode) return { anchor: this._large.selectionStart, focus: this._large.selectionEnd };
    return getCaretOffset(this._inner);
  }

  /**
   * Set the caret to the given character offsets.
   * @param {number} anchor
   * @param {number} focus
   */
  setCaretOffset(anchor, focus) {
    if (this._largeMode) {
      this._large.setSelectionRange(anchor, focus);
      return;
    }
    setCaretOffset(this._inner, anchor, focus);
  }

  // ── Fold commands ────────────────────────────────────────────────────────────

  /** Return the current collapsed start-line numbers as an array. */
  getFoldStates() { return this._largeMode ? [] : Array.from(this._foldedRanges); }

  /**
   * Restore a previously saved fold state (array of start-line numbers).
   * Silently ignores invalid entries; re-renders.
   * @param {number[]} arr
   */
  setFoldStates(arr) {
    if (this._largeMode) return;
    this._foldedRanges = new Set((arr || []).filter(n => Number.isInteger(n) && n > 0));
    const text = this._lastText !== null ? this._lastText : this.getValue();
    this._render(text);
  }

  /** Collapse every foldable range in the current file. */
  foldAll() {
    if (this._largeMode) return;
    for (const r of this._foldRanges) this._foldedRanges.add(r.start);
    this._render(this._lastText !== null ? this._lastText : this.getValue());
  }

  /** Expand every fold in the current file. */
  unfoldAll() {
    if (this._largeMode) return;
    this._foldedRanges.clear();
    this._render(this._lastText !== null ? this._lastText : this.getValue());
  }

  /**
   * Collapse folds at nesting depth === level (1-based).
   * Depth is how many other ranges strictly contain this range.
   * @param {number} level
   */
  foldLevel(level) {
    if (this._largeMode) return;
    this._foldedRanges.clear();
    for (const r of this._foldRanges) {
      let depth = 1;
      for (const o of this._foldRanges) {
        if (o !== r && o.start < r.start && o.end >= r.end) depth++;
      }
      if (depth === level) this._foldedRanges.add(r.start);
    }
    this._render(this._lastText !== null ? this._lastText : this.getValue());
  }

  /**
   * Collapse a fold and all fold ranges it contains.
   * @param {number} startLine  1-indexed fold start.
   */
  foldRecursively(startLine) {
    if (this._largeMode) return;
    const parent = this._foldRanges.find(r => r.start === startLine);
    if (!parent) return;
    for (const r of this._foldRanges) {
      if (r.start >= parent.start && r.end <= parent.end) this._foldedRanges.add(r.start);
    }
    this._render(this._lastText !== null ? this._lastText : this.getValue());
  }

  // ── Undo / Redo ─────────────────────────────────────────────────────────────

  /**
   * Push a snapshot onto the history stack.
   * Snapshots taken within HISTORY_COALESCE_MS of the previous one are merged
   * so rapid typing collapses into a single undo step.
   * @param {string} text
   * @param {{anchor:number,focus:number}|null} caret
   */
  _pushHistory(text, caret) {
    const HISTORY_COALESCE_MS = 400;
    const HISTORY_GROUP_MAX_MS = 1000;
    const MAX_HISTORY = 200;
    const now = Date.now();
    const snap = { text, caret: caret || { anchor: 0, focus: 0 } };

    // Truncate any redo tail.
    this._history.length = this._historyIndex + 1;

    const last = this._history[this._historyIndex];
    // Break the undo group when the user just typed a newline, so each line
    // becomes its own undo step.
    const c = snap.caret.anchor;
    const typedNewline = c > 0 && text[c - 1] === '\n';
    // Coalesce burst typing into the current snapshot, but:
    //  - never into the baseline (index 0) — it must stay pristine
    //  - only within a short pause window (400ms since last keystroke)
    //  - only up to 1s per group, so long typing runs stay granular
    if (last && this._historyIndex > 0 && !typedNewline &&
        (now - this._lastSnapshotTime) < HISTORY_COALESCE_MS &&
        (now - (this._groupStartTime || 0)) < HISTORY_GROUP_MAX_MS) {
      // Replace the latest snapshot (coalesce burst typing).
      this._history[this._historyIndex] = snap;
    } else {
      this._history.push(snap);
      this._historyIndex++;
      this._groupStartTime = now;
      // Cap size.
      if (this._history.length > MAX_HISTORY) {
        this._history.shift();
        this._historyIndex--;
      }
    }
    this._lastSnapshotTime = now;
  }

  /** @returns {boolean} */
  canUndo() { return !this._largeMode && this._historyIndex > 0; }

  /** @returns {boolean} */
  canRedo() { return !this._largeMode && this._historyIndex < this._history.length - 1; }

  /**
   * Undo one step. Returns true if an undo was applied.
   * @returns {boolean}
   */
  undo() {
    if (!this.canUndo()) return false;
    this._historyIndex--;
    this._lastSnapshotTime = 0;
    const snap = this._history[this._historyIndex];
    this._lastText = snap.text;
    this._render(snap.text);
    if (navigator.maxTouchPoints) {
      // On touch: don't set caret (avoids keyboard), just scroll to change position.
      this._scrollToOffset(snap.caret.anchor);
    } else {
      setCaretOffset(this._inner, snap.caret.anchor, snap.caret.focus);
    }
    if (typeof this.onchange === 'function') this.onchange(snap.text);
    return true;
  }

  /**
   * Redo one step. Returns true if a redo was applied.
   * @returns {boolean}
   */
  redo() {
    if (!this.canRedo()) return false;
    this._historyIndex++;
    this._lastSnapshotTime = 0;
    const snap = this._history[this._historyIndex];
    this._lastText = snap.text;
    this._render(snap.text);
    if (navigator.maxTouchPoints) {
      this._scrollToOffset(snap.caret.anchor);
    } else {
      setCaretOffset(this._inner, snap.caret.anchor, snap.caret.focus);
    }
    if (typeof this.onchange === 'function') this.onchange(snap.text);
    return true;
  }

  /**
   * Scroll the editor pane so that the given character offset is visible.
   * @param {number} offset
   */
  _scrollToOffset(offset) {
    const text = this._lastText || '';
    const line = text.slice(0, offset).split('\n').length - 1;
    requestAnimationFrame(() => {
      const lineDivs = this._inner.querySelectorAll('div');
      const target = lineDivs[line];
      if (target) target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
  }

  /**
   * Change the language and re-highlight without changing content.
   * @param {string} lang
   */
  setLang(lang) {
    this._lang = lang || 'plain';
    if (this._largeMode) return;
    const text = this.getValue();
    const caret = getCaretOffset(this._inner);
    this._render(text);
    if (caret) setCaretOffset(this._inner, caret.anchor, caret.focus);
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  refreshGutter() {
    if (this._largeMode) return;
    this._syncGutterHeights();
  }

  _shouldUseLargeMode(text) {
    if (text.length > 2 * 1024 * 1024) return true;
    let lines = 1;
    for (let i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) === 10 && ++lines > 50000) return true;
    }
    return false;
  }

  _syncGutterHeights() {
    // Position each line number at its code line's ACTUAL rendered position.
    // Absolute anchoring cannot accumulate drift, and — unlike height-mirroring
    // — it gives .fold-marker a positioned parent and lets folded rows collapse
    // via display:none rather than stacking as zero-height flow boxes.
    const codeDivs   = this._inner.children;
    const gutterDivs = this._gutter.children;
    const n = Math.min(codeDivs.length, gutterDivs.length);
    const gutterTop = this._gutter.getBoundingClientRect().top;
    // Read all positions first (single reflow), then write.
    const tops = [];
    for (let i = 0; i < n; i++) {
      const rect = codeDivs[i].getBoundingClientRect();
      tops.push(rect.height > 0 ? rect.top - gutterTop : -1);
    }
    for (let i = 0; i < n; i++) {
      const g = gutterDivs[i];
      if (tops[i] >= 0) {
        g.style.display = '';
        g.style.top = tops[i] + 'px';
      } else {
        g.style.display = 'none'; // folded/hidden line
      }
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
    const hiddenLines = new Set(); // 1-indexed line numbers to hide
    // For folded ranges: startLine -> closing delimiter ('}', ')', or '' for indent folds).
    const foldClose = new Map();
    for (const range of this._foldRanges) {
      if (this._foldedRanges.has(range.start)) {
        for (let ln = range.start + 1; ln <= range.end; ln++) {
          hiddenLines.add(ln);
        }
        foldClose.set(range.start, range.close || '');
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

    const isCssLang = this._lang === 'css' || this._lang === 'scss' || this._lang === 'less';

    // Hanging indent for wrapped lines: continuation rows align under the
    // line's leading whitespace instead of snapping back to column 0.
    // Implemented purely in CSS (padding-left + negative text-indent), so it
    // adds NO text nodes and cannot affect caret math or getPlainText.
    const rawLines = text.split('\n');
    const TAB_CH = 2;       // must match tab-size in app.css
    const MAX_HANG = 32;    // cap so deep indents can't push text off-screen
    const HANG_EXTRA = 2;   // extra ch beyond the line's own indent, so a
                            // wrapped row reads as a continuation, not a new
                            // deeper line (VS Code wrappingIndent:"indent")

    const divs = [];
    for (let li = 0; li < lines.length; li++) {
      const lineNum = li + 1;
      const lineTokens = lines[li];
      const hidden = hiddenLines.has(lineNum);
      const classAttr = hidden ? ' class="folded-line"' : '';

      // Compute leading-whitespace width in ch units (tab = TAB_CH).
      let styleAttr = '';
      const raw = rawLines[li] || '';
      let w = 0;
      for (let ci = 0; ci < raw.length; ci++) {
        if (raw[ci] === ' ') w += 1;
        else if (raw[ci] === '\t') w += TAB_CH;
        else break;
      }
      if (w > MAX_HANG) w = MAX_HANG;
      const hang = w + HANG_EXTRA;
      styleAttr = ' style="padding-left:' + hang + 'ch;text-indent:-' + hang + 'ch"';

      if (lineTokens.length === 0) {
        divs.push('<div' + classAttr + '><br></div>');
      } else {
        let inner = '';
        for (const tok of lineTokens) {
          const escaped = esc(tok.text);
          if (tok.type === 'plain') {
            inner += escaped;
          } else {
            let spanContent = escaped;
            if (isCssLang && tok.type === 'num' && /^#[0-9a-fA-F]{3,8}$/.test(tok.text)) {
              const sc = _hexSwatchColor(tok.text);
              spanContent = '<span class="color-swatch" style="background:' + sc + '" contenteditable="false"></span>' + escaped;
            }
            inner += '<span class="tok-' + tok.type + '">' + spanContent + '</span>';
          }
        }
        // Folded start line: append a click-to-expand "...}" / "...)" preview pill.
        // The pill is an EMPTY element — its visible content comes from CSS
        // pseudo-elements (content/attr), so it adds NO text nodes and cannot
        // corrupt getPlainText or caret-offset TreeWalker math.
        if (foldClose.has(lineNum)) {
          const close = esc(foldClose.get(lineNum)).replace(/"/g, '&quot;');
          inner += '<span class="fold-pill" contenteditable="false"'
            + ' data-fold-start="' + lineNum + '" data-close="' + close + '"></span>';
        }
        divs.push('<div' + classAttr + styleAttr + '>' + inner + '</div>');
      }
    }

    this._inner.innerHTML = divs.join('');
    this._updateLineNumbers(text);
    this._syncGutterHeights();

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

    // Size the gutter to fit the widest number, so multi-digit numbers never
    // overflow/wrap (see: lines 10+ vanishing when the gutter was a fixed
    // 2.5em). ~0.33em per digit (0.85em-scaled monospace) + 6px horizontal
    // padding. Fold chevrons are absolutely positioned on the divider and
    // take no in-flow space.
    const digits = String(lineCount).length;
    this._gutter.style.width = 'calc(' + digits + 'ch + 8px)';

    // Build a map from start line -> end for fast lookup.
    const foldableMap = new Map(); // startLine -> end
    for (const range of this._foldRanges) {
      foldableMap.set(range.start, range.end);
    }

    let html = '';
    for (let i = 1; i <= lineCount; i++) {
      if (foldableMap.has(i)) {
        const isFolded = this._foldedRanges.has(i);
        // Modern chevron: points right when folded, rotates down when expanded.
        const chevron = '<svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true">'
          + '<path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.8" '
          + 'stroke-linecap="round" stroke-linejoin="round"/></svg>';
        html += '<div>'
          + i
          + '<span class="fold-marker' + (isFolded ? '' : ' expanded') + '" data-fold-start="' + i + '">' + chevron + '</span>'
          + '</div>';
      } else {
        html += '<div>' + i + '</div>';
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
    if (this._largeMode) return;
    if (this._foldedRanges.has(startLine)) {
      this._foldedRanges.delete(startLine);
    } else {
      this._foldedRanges.add(startLine);
    }
    // Re-render using the last known text (getValue() reads DOM, works fine).
    const text = this._lastText !== null ? this._lastText : this.getValue();
    this._render(text);
    if (typeof this.onfoldchange === 'function') this.onfoldchange();
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
   * Handle input events: save caret, re-render, restore caret.
   */
  _onInput() {
    const text = this.getValue();
    const prev = this._lastText;

    // ── Soft-keyboard auto-close ────────────────────────────────────────────
    // Physical keyboards handle auto-close in _onKeydown via preventDefault, so
    // the input event never fires for those insertions. Soft/touch keyboards
    // (Android GBoard, etc.) fire keydown with e.key==='Unidentified', so the
    // character arrives here instead. Detect a single opening-pair char inserted
    // at the caret and insert the matching close char after it.
    const acCaret = getCaretOffset(this._inner);
    if (prev !== null && acCaret !== null && acCaret.anchor === acCaret.focus &&
        text.length === prev.length + 1) {
      const pos = acCaret.focus;        // caret is just after the inserted char
      const inserted = text[pos - 1];
      // Verify this is a pure single-char insertion (not paste or IME commit).
      if (AUTO_PAIRS.hasOwnProperty(inserted) &&
          text.slice(0, pos - 1) === prev.slice(0, pos - 1) &&
          text.slice(pos) === prev.slice(pos - 1)) {
        const nextChar = text[pos] || '';
        const nextIsWsOrEnd = nextChar === '' || /[\s\n\r]/.test(nextChar) ||
                              ')]}"\''.includes(nextChar);
        const isQuote = inserted === '"' || inserted === "'";
        const prevChar = pos >= 2 ? text[pos - 2] : '';
        if (nextIsWsOrEnd && !(isQuote && prevChar === inserted)) {
          const closing = AUTO_PAIRS[inserted];
          const newText = text.slice(0, pos) + closing + text.slice(pos);
          this._lastText = newText;
          this._render(newText);
          setCaretOffset(this._inner, pos, pos);
          this._pushHistory(newText, { anchor: pos, focus: pos });
          if (typeof this.onchange === 'function') this.onchange(newText);
          this._updateAutocomplete();
          return;
        }
      }
    }

    // Normalize DOM structure even when plain text hasn't changed: the browser
    // may have injected extra divs/spans that leave the DOM in a messy state
    // without altering the text projection. Re-render if line-div count drifts.
    const expectedLines = text === '' ? 1 : text.split('\n').length;
    const structureDirty = this._inner.children.length !== expectedLines;

    // Skip re-render if content hasn't changed AND structure is clean.
    if (text === this._lastText && !structureDirty) return;

    // Remap collapsed fold start-lines to account for insertions/deletions above
    // them. Lines inside the changed block dissolve (map to null).
    if (this._foldedRanges.size > 0 && this._lastText !== null) {
      const map = remapLines(this._lastText, text);
      const next = new Set();
      for (const s of this._foldedRanges) {
        const m = map(s);
        if (m !== null) next.add(m);
      }
      this._foldedRanges = next;
    }

    this._lastText = text;

    // Save caret before re-render.
    const caret = getCaretOffset(this._inner);

    // Re-render.
    this._render(text);

    // Restore caret.
    if (caret !== null) {
      setCaretOffset(this._inner, caret.anchor, caret.focus);
    }

    // Push to custom history stack (native history is wiped by innerHTML re-render).
    this._pushHistory(text, caret);

    // Notify change listeners.
    if (typeof this.onchange === 'function') {
      this.onchange(text);
    }

    // Update autocomplete for the word at the caret.
    this._updateAutocomplete();
  }

  /**
   * Remove event listeners and detach the inner element from the DOM.
   */
  destroy() {
    if (this._acEl && this._acEl.parentNode) this._acEl.parentNode.removeChild(this._acEl);
    this._acEl = null;
    this._inner.removeEventListener('input',   this._onInput);
    this._inner.removeEventListener('keydown', this._onKeydown);
    this._large.removeEventListener('input', this._onLargeInput);
    document.removeEventListener('selectionchange', this._onSelChange);
    if (this._wrap.parentNode) {
      this._wrap.parentNode.removeChild(this._wrap);
    }
    if (this._large.parentNode) this._large.parentNode.removeChild(this._large);
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

  // ── Autocomplete ────────────────────────────────────────────────────────────

  /** Recompute suggestions for the word at the caret and show/hide the popup. */
  _updateAutocomplete() {
    if (this._acSuppress) { this._hideAutocomplete(); return; }
    const caret = getCaretOffset(this._inner);
    if (!caret || caret.anchor !== caret.focus) { this._hideAutocomplete(); return; }
    const text = this._lastText !== null ? this._lastText : this.getValue();
    const s = window.acSuggestions ? window.acSuggestions(text, caret.focus, this._lang) : null;
    if (!s) { this._hideAutocomplete(); return; }
    this._acItems = s.items;
    this._acPrefix = s.prefix;
    this._acIndex = 0;
    this._renderAcPopup();
  }

  /** Render the popup at the caret position. */
  _renderAcPopup() {
    if (!this._acEl) {
      this._acEl = document.createElement('div');
      this._acEl.className = 'ac-popup';
      document.body.appendChild(this._acEl);
    }
    const el = this._acEl;
    el.innerHTML = '';
    this._acItems.forEach((sug, i) => {
      const item = document.createElement('div');
      item.className = 'ac-item' + (i === this._acIndex ? ' selected' : '');
      const b = document.createElement('b');
      b.textContent = sug.label.slice(0, this._acPrefix.length);
      item.appendChild(b);
      item.appendChild(document.createTextNode(sug.label.slice(this._acPrefix.length)));
      // mousedown (not click) so the editor doesn't lose the caret first.
      item.addEventListener('mousedown', (e) => { e.preventDefault(); this._acceptSuggestion(sug); });
      el.appendChild(item);
    });

    // Position at the caret. Collapsed ranges at line start can have no rect —
    // fall back to the focused element's rect.
    const sel = window.getSelection();
    let rect = null;
    if (sel && sel.rangeCount > 0) {
      const r = sel.getRangeAt(0).cloneRange();
      const rects = r.getClientRects();
      if (rects.length) {
        rect = rects[rects.length - 1];
      } else {
        const p = r.startContainer.nodeType === Node.ELEMENT_NODE
          ? r.startContainer : r.startContainer.parentElement;
        if (p && p.getBoundingClientRect) rect = p.getBoundingClientRect();
      }
    }
    if (!rect) { this._hideAutocomplete(); return; }
    el.style.display = 'block';
    const popRect = el.getBoundingClientRect();
    let left = Math.min(rect.left, window.innerWidth - popRect.width - 8);
    let top = rect.bottom + 2;
    if (top + popRect.height > window.innerHeight) top = rect.top - popRect.height - 2; // flip above
    el.style.left = Math.max(4, left) + 'px';
    el.style.top = Math.max(4, top) + 'px';
  }

  /** Hide the popup and clear suggestion state. */
  _hideAutocomplete() {
    this._acItems = [];
    if (this._acEl) this._acEl.style.display = 'none';
  }

  /**
   * Replace the typed prefix with the chosen suggestion (same pipeline as Tab
   * insert: render + caret + history + onchange). Suggestion items carry an
   * `insert` string and a `caret` back-step (e.g. to land inside <div></div>).
   * @param {{label:string, insert:string, caret:number}} sug
   */
  _acceptSuggestion(sug) {
    const caret = getCaretOffset(this._inner);
    if (!caret) { this._hideAutocomplete(); return; }
    const text = this.getValue();
    const pos = caret.focus;
    const start = pos - this._acPrefix.length;
    const insert = sug.insert !== undefined ? sug.insert : sug.label;
    const newText = text.slice(0, start) + insert + text.slice(pos);
    const newPos = start + insert.length - (sug.caret || 0);
    this._lastText = newText;
    this._render(newText);
    setCaretOffset(this._inner, newPos, newPos);
    this._pushHistory(newText, { anchor: newPos, focus: newPos });
    if (typeof this.onchange === 'function') this.onchange(newText);
    this._hideAutocomplete();
  }

  /**
   * Handle keydown events.
   * - Tab:   insert 2 spaces.
   * - Enter: auto-indent.
   * - Auto-close pairs: (, [, {, ", '
   */
  _onKeydown(e) {
    // ── Autocomplete popup navigation (runs before all editing keys) ───────
    if (this._acItems.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        this._acIndex = (this._acIndex + 1) % this._acItems.length;
        this._renderAcPopup();
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        this._acIndex = (this._acIndex - 1 + this._acItems.length) % this._acItems.length;
        this._renderAcPopup();
        return;
      }
      if (e.key === 'Tab' || e.key === 'Enter') {
        e.preventDefault();
        this._acceptSuggestion(this._acItems[this._acIndex]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        this._hideAutocomplete();
        this._acSuppress = true;
        return;
      }
    }
    // Any non-identifier key ends Escape-suppression (next word suggests again).
    if (this._acSuppress && !/^[A-Za-z0-9_$]$/.test(e.key)) this._acSuppress = false;

    // ── Ctrl/Cmd+Z: undo, Ctrl/Cmd+Shift+Z / Ctrl+Y: redo ──────────────────
    if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.altKey) {
      e.preventDefault();
      if (e.shiftKey) { this.redo(); } else { this.undo(); }
      if (typeof this.onUndoRedoChange === 'function') this.onUndoRedoChange();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'y' && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      this.redo();
      if (typeof this.onUndoRedoChange === 'function') this.onUndoRedoChange();
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
      const tabText = this.getValue();
      const tabCaret = getCaretOffset(this._inner);
      if (tabCaret === null) return;
      const tabAnchor = Math.min(tabCaret.anchor, tabCaret.focus);
      const tabFocus  = Math.max(tabCaret.anchor, tabCaret.focus);
      const newText = tabText.slice(0, tabAnchor) + '  ' + tabText.slice(tabFocus);
      const newPos  = tabAnchor + 2;
      this._lastText = newText;
      this._render(newText);
      setCaretOffset(this._inner, newPos, newPos);
      this._pushHistory(newText, { anchor: newPos, focus: newPos });
      if (typeof this.onchange === 'function') this.onchange(newText);
      return;
    }

    // ── Auto-close pairs ─────────────────────────────────────────────────────
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
          const pairText = this.getValue();
          const pairCaret = getCaretOffset(this._inner);
          if (pairCaret === null) return;
          const pairAnchor = Math.min(pairCaret.anchor, pairCaret.focus);
          const pairFocus  = Math.max(pairCaret.anchor, pairCaret.focus);
          const newText = pairText.slice(0, pairAnchor) + e.key + closing + pairText.slice(pairFocus);
          const newPos  = pairAnchor + 1; // between the pair
          this._lastText = newText;
          this._render(newText);
          setCaretOffset(this._inner, newPos, newPos);
          this._pushHistory(newText, { anchor: newPos, focus: newPos });
          if (typeof this.onchange === 'function') this.onchange(newText);
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

      // When pressing Enter right after '{', insert an indented line AND a
      // closing '}' on the line below, placing the caret on the middle line.
      const selEnd = Math.max(caretPos.anchor, caretPos.focus);
      if (lastChar === '{') {
        const inserted = '\n' + indent + '\n' + leadingWs + '}';
        const newText  = text.slice(0, pos) + inserted + text.slice(selEnd);
        const newCaret = pos + 1 + indent.length; // on the blank indented line
        this._lastText = newText;
        this._render(newText);
        setCaretOffset(this._inner, newCaret, newCaret);
        this._pushHistory(newText, { anchor: newCaret, focus: newCaret });
        if (typeof this.onchange === 'function') this.onchange(newText);
        return;
      }

      // Build the new text directly (avoids DOM-read trailing-newline ambiguity).
      const inserted = '\n' + indent;
      const newText = text.slice(0, pos) + inserted + text.slice(selEnd);
      const newCaret = pos + inserted.length;
      this._lastText = newText;
      this._render(newText);
      setCaretOffset(this._inner, newCaret, newCaret);
      this._pushHistory(newText, { anchor: newCaret, focus: newCaret });
      if (typeof this.onchange === 'function') this.onchange(newText);
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
    // Hide the autocomplete popup when the caret moves away from the word
    // being completed (e.g. click/tap elsewhere).
    if (this._acItems.length > 0) {
      const c = getCaretOffset(this._inner);
      const t = this.getValue();
      if (!c || c.anchor !== c.focus || !t.slice(0, c.focus).endsWith(this._acPrefix)) {
        this._hideAutocomplete();
      }
    }

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
