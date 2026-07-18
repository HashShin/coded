'use strict';
// Node-based unit test for getPlainText in editor.js.
// Uses a minimal DOM shim (no browser needed). Run: node static/js/editor_test.js

// ── Minimal DOM shim ─────────────────────────────────────────────────────────
global.Node = {
  TEXT_NODE: 3,
  ELEMENT_NODE: 1,
  DOCUMENT_POSITION_PRECEDING: 2,
  DOCUMENT_POSITION_FOLLOWING: 4,
};
global.window = {};

// Depth-first list of all nodes under root (document order).
function allNodes(root) {
  const out = [];
  (function rec(n) {
    out.push(n);
    for (const c of n.childNodes) rec(c);
  })(root);
  return out;
}
function treeRoot(n) {
  while (n.parentNode) n = n.parentNode;
  return n;
}

const nodeProto = {
  contains(other) {
    let n = other;
    while (n) {
      if (n === this) return true;
      n = n.parentNode;
    }
    return false;
  },
  compareDocumentPosition(other) {
    const order = allNodes(treeRoot(this));
    const a = order.indexOf(this);
    const b = order.indexOf(other);
    if (b > a) return Node.DOCUMENT_POSITION_FOLLOWING;
    if (b < a) return Node.DOCUMENT_POSITION_PRECEDING;
    return 0;
  },
};

function text(value) {
  return Object.assign(Object.create(nodeProto), {
    nodeType: 3, nodeValue: value, childNodes: [], parentNode: null, nextSibling: null,
  });
}
function el(tag, ...children) {
  const node = Object.assign(Object.create(nodeProto), {
    nodeType: 1, tagName: tag.toUpperCase(), childNodes: children, parentNode: null, nextSibling: null,
    children: children.filter(c => c.nodeType === 1),
  });
  for (let i = 0; i < children.length; i++) {
    children[i].parentNode = node;
    children[i].nextSibling = children[i + 1] || null;
  }
  return node;
}
const br = () => el('br');

// TreeWalker shim: editor.js only uses SHOW_TEXT walkers with nextNode().
global.NodeFilter = { SHOW_TEXT: 4 };
global.document = {
  createTreeWalker(root) {
    const nodes = allNodes(root).filter(n => n.nodeType === Node.TEXT_NODE);
    let i = -1;
    return { nextNode() { i++; return nodes[i] || null; } };
  },
};

// ── Load editor.js ───────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, 'editor.js'), 'utf8');
// Evaluate in this context; expose getPlainText via a trailing hook.
eval(src + '\nglobal.__getPlainText = getPlainText;\nglobal.__nodeOffsetToChar = nodeOffsetToChar;\nglobal.__remapLines = remapLines;');
const getPlainText = global.__getPlainText;
const nodeOffsetToChar = global.__nodeOffsetToChar;
const remapLines = global.__remapLines;

// Build an editor root as _render would: one div per line, <div><br></div> for empty.
function editorFromLines(...lines) {
  const divs = lines.map(l => (l === '' ? el('div', br()) : el('div', text(l))));
  return el('div', ...divs);
}

// ── Tests ────────────────────────────────────────────────────────────────────
let failures = 0;
function check(name, actual, expected) {
  if (actual === expected) {
    console.log('PASS  ' + name);
  } else {
    failures++;
    console.log('FAIL  ' + name + '\n      expected ' + JSON.stringify(expected) + '\n      got      ' + JSON.stringify(actual));
  }
}

// Round-trip: DOM rendered from text must read back as the same text.
check('single line',            getPlainText(editorFromLines('abc')), 'abc');
check('two lines',              getPlainText(editorFromLines('abc', 'def')), 'abc\ndef');
check('trailing empty line',    getPlainText(editorFromLines('abc', '')), 'abc\n');
check('two trailing empties',   getPlainText(editorFromLines('abc', '', '')), 'abc\n\n');
check('empty line in middle',   getPlainText(editorFromLines('abc', '', 'def')), 'abc\n\ndef');
check('two empties in middle',  getPlainText(editorFromLines('abc', '', '', 'def')), 'abc\n\n\ndef');
check('leading empty line',     getPlainText(editorFromLines('', 'abc')), '\nabc');
check('two leading empties',    getPlainText(editorFromLines('', '', 'abc')), '\n\nabc');
check('only one empty line',    getPlainText(editorFromLines('')), '');
check('only empty lines',       getPlainText(editorFromLines('', '', '')), '\n\n');

// Browser-injected structures.
check('mid-line br',            getPlainText(el('div', el('div', text('abc'), br(), text('def')))), 'abc\ndef');
check('trailing br after text', getPlainText(el('div', el('div', text('abc'), br()))), 'abc');
check('stray root text + div',  getPlainText(el('div', text('abc'), el('div', text('def')))), 'abc\ndef');
check('nested span in line',    getPlainText(el('div', el('div', el('span', text('abc'))), el('div', br()))), 'abc\n');

// ── nodeOffsetToChar: element-position carets ────────────────────────────────
// When the caret is on an empty line, browsers report (lineDiv, 0) — an
// element position. The returned offset must count newlines of all preceding
// lines, matching the coordinate space of getPlainText.

{
  // Reproduces the reported bug: 5 lines of Go code + trailing empty line.
  const lines = [
    'package main',
    'import "embed"',
    '//go:embed static',
    'var staticFiles embed.FS',
    '', // Enter was pressed at the end of the .FS line; caret sits here.
  ];
  const root = editorFromLines(...lines);
  const emptyDiv = root.childNodes[4];
  const fullText = getPlainText(root);
  check('caret on trailing empty line (element pos)',
    nodeOffsetToChar(root, emptyDiv, 0),
    fullText.length);
}

{
  // Empty line in the middle.
  const root = editorFromLines('abc', '', 'def');
  const emptyDiv = root.childNodes[1];
  check('caret on middle empty line (element pos)',
    nodeOffsetToChar(root, emptyDiv, 0),
    4); // "abc\n" → offset 4
}

{
  // Caret between line divs, reported directly on the root element.
  const root = editorFromLines('abc', 'def');
  check('caret at root child offset 1',
    nodeOffsetToChar(root, root, 1),
    4); // start of line 2
}

{
  // Text-node caret on a later line still counts earlier newlines.
  const root = editorFromLines('abc', 'defg');
  const line2Text = root.childNodes[1].childNodes[0];
  check('text-node caret on line 2',
    nodeOffsetToChar(root, line2Text, 2),
    6); // "abc\nde" → 6
}

{
  // Element caret inside a line div with children: (lineDiv, childOffset).
  const root = el('div', el('div', text('ab'), text('cd')), el('div', text('ef')));
  const lineDiv2 = root.childNodes[1];
  check('element caret in 2nd line before child 1',
    nodeOffsetToChar(root, lineDiv2, 1),
    7); // "abcd\n" (5) + "ef" before child offset 1 (2) = 7
}

// ── remapLines tests ─────────────────────────────────────────────────────────

{
  // Insert a line above a fold: start shifts +1.
  const old = 'a\nb\nc\nd'; // lines 1-4
  const nw  = 'a\nX\nb\nc\nd'; // inserted X at line 2, fold at old line 3 -> new line 4
  const map = remapLines(old, nw);
  // Inserting a new line: common prefix=1 (a), suffix=3 (b,c,d), changed block
  // in old is empty (pure insert). All old lines after 'a' shift by +1.
  check('insert above: line before insert unchanged', map(1), 1);
  check('insert above: old line 2 (b) shifts to 3', map(2), 3);
  check('insert above: old line 3 (c) shifts to 4', map(3), 4);
  check('insert above: old line 4 (d) shifts to 5', map(4), 5);
}

{
  // Delete a line above a fold: fold header shifts -1.
  const old = 'a\nb\nc\nd';
  const nw  = 'a\nc\nd'; // deleted line 2
  const map = remapLines(old, nw);
  check('delete above: line before change unchanged', map(1), 1);
  check('delete above: deleted line dissolves', map(2), null);
  check('delete above: line after change shifts -1', map(3), 2);
  check('delete above: last line shifts -1', map(4), 3);
}

{
  // Edit strictly inside a fold body: header (line 1) unchanged.
  const old = 'func foo() {\n  x := 1\n}';
  const nw  = 'func foo() {\n  x := 2\n}'; // changed body only
  const map = remapLines(old, nw);
  check('edit body: header unchanged', map(1), 1);
  check('edit body: changed line dissolves', map(2), null);
  check('edit body: closing line unchanged', map(3), 3);
}

{
  // Edit the fold header line: header dissolves.
  const old = 'func foo() {\n  x := 1\n}';
  const nw  = 'func bar() {\n  x := 1\n}'; // changed header
  const map = remapLines(old, nw);
  check('edit header: header dissolves', map(1), null);
  check('edit header: body unchanged', map(2), 2);
  check('edit header: closing unchanged', map(3), 3);
}

{
  // No change: every line maps to itself.
  const old = 'a\nb\nc';
  const map = remapLines(old, old);
  check('no change: line 1', map(1), 1);
  check('no change: line 2', map(2), 2);
  check('no change: line 3', map(3), 3);
}

process.exit(failures === 0 ? 0 : 1);
