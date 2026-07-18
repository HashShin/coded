'use strict';

// ── tokenize.js ───────────────────────────────────────────────────────────────
// Adapter over Prism.js (vendored in /vendor/prism/prism-bundle.min.js).
// Exports a single function: tokenize(text, lang) → [{type, text}, ...]
// Token types consumed by editor.js/app.css:
//   kw, str, num, cmt, fn, type, op, key, plain

// ── Language key → Prism grammar name ─────────────────────────────────────────
// app.js langFromPath() emits short keys; map them to Prism grammar ids.
const LANG_TO_PRISM = {
  go: 'go',
  js: 'javascript', jsx: 'jsx',
  ts: 'typescript', tsx: 'tsx',
  py: 'python',
  json: 'json',
  html: 'markup', htm: 'markup', xml: 'markup', svg: 'markup',
  css: 'css', scss: 'css', less: 'css',
  md: 'markdown', markdown: 'markdown',
  sh: 'bash', bash: 'bash',
  yaml: 'yaml', yml: 'yaml',
  toml: 'toml',
  ini: 'ini',
  sql: 'sql',
  rust: 'rust',
  c: 'c', cpp: 'cpp',
  php: 'php',
  ruby: 'ruby', rb: 'ruby',
  docker: 'docker', dockerfile: 'docker',
  clike: 'clike',
  git: 'git',
};

// ── Prism token type → editor token class ─────────────────────────────────────
// Checked in order of specificity: exact match first, then prefix rules.
const TYPE_MAP = {
  // Keywords & control
  'keyword': 'kw', 'boolean': 'kw', 'important': 'kw', 'atrule': 'kw',
  'rule': 'kw', 'directive': 'kw', 'module': 'kw', 'control-flow': 'kw',
  'null': 'kw', 'nil': 'kw',
  // Strings
  'string': 'str', 'char': 'str', 'template-string': 'str', 'regex': 'str',
  'attr-value': 'str', 'url': 'str', 'string-interpolation': 'str',
  'triple-quoted-string': 'str', 'heredoc-string': 'str',
  'template-punctuation': 'str', 'code': 'str', 'code-block': 'str',
  'code-snippet': 'str',
  // Numbers
  'number': 'num', 'hexcode': 'num', 'color': 'num', 'unit': 'num',
  // Comments
  'comment': 'cmt', 'prolog': 'cmt', 'doctype': 'cmt', 'cdata': 'cmt',
  'shebang': 'cmt', 'blockquote': 'cmt', 'hr': 'cmt',
  // Functions
  'function': 'fn', 'function-definition': 'fn', 'method': 'fn',
  'function-name': 'fn', 'bold': 'fn',
  // C/C++ preprocessor
  'macro': 'kw', 'directive-hash': 'kw',
  // Types / identifiers of note
  'class-name': 'type', 'builtin': 'type', 'type': 'type',
  'namespace': 'type', 'attr-name': 'type', 'selector': 'type',
  'variable': 'type', 'symbol': 'type', 'constant': 'const',
  'attribute': 'type', 'decorator': 'type', 'annotation': 'type',
  'italic': 'type', 'type-definition': 'type', 'lifetime-annotation': 'type',
  'attr-equals': 'op',
  // Operators / punctuation
  'operator': 'op', 'punctuation': 'op', 'arrow': 'op', 'spread': 'op',
  // Keys / properties
  'property': 'key', 'key': 'key', 'parameter': 'plain',
  // Markup
  'tag': 'kw', 'entity': 'num', 'title': 'kw', 'list': 'op',
  'url-reference': 'num', 'delimiter': 'kw',
  // Misc
  'interpolation': 'plain', 'interpolation-punctuation': 'op',
  'plain-text': 'plain',
};

/**
 * Map a Prism token type (plus optional alias) to an editor token class.
 * @param {string} type
 * @param {string|string[]|undefined} alias
 * @param {string} parentClass  Class inherited from the enclosing token.
 * @returns {string}
 */
function mapType(type, alias, parentClass) {
  if (TYPE_MAP[type]) return TYPE_MAP[type];
  // Try aliases (may be a string or array).
  if (alias) {
    const aliases = Array.isArray(alias) ? alias : [alias];
    for (const a of aliases) {
      if (TYPE_MAP[a]) return TYPE_MAP[a];
    }
  }
  // Heuristic prefixes for grammar-specific subtypes (e.g. regex-flags).
  if (type.indexOf('string') !== -1) return 'str';
  if (type.indexOf('comment') !== -1) return 'cmt';
  if (type.indexOf('number') !== -1) return 'num';
  if (type.indexOf('keyword') !== -1) return 'kw';
  if (type.indexOf('function') !== -1) return 'fn';
  if (type.indexOf('regex') !== -1) return 'str';
  if (type.indexOf('punctuation') !== -1 || type.indexOf('operator') !== -1) return 'op';
  return parentClass || 'plain';
}

/**
 * Flatten Prism's nested token stream into [{type, text}].
 * @param {Array} stream          Prism token stream (strings and Token objects).
 * @param {string} parentClass    Editor class inherited from the parent token.
 * @param {Array<{type:string,text:string}>} out
 */
function flatten(stream, parentClass, out) {
  for (const item of stream) {
    if (typeof item === 'string') {
      if (item.length > 0) out.push({ type: parentClass || 'plain', text: item });
      continue;
    }
    // Prism Token: {type, content, alias}
    const cls = mapType(item.type, item.alias, parentClass);
    const content = item.content;
    if (typeof content === 'string') {
      if (content.length > 0) out.push({ type: cls, text: content });
    } else if (Array.isArray(content)) {
      flatten(content, cls, out);
    } else if (content) {
      // Single nested Token.
      flatten([content], cls, out);
    }
  }
}

/**
 * Merge adjacent tokens with the same class to keep the DOM small.
 * @param {Array<{type:string,text:string}>} tokens
 * @returns {Array<{type:string,text:string}>}
 */
function mergeAdjacent(tokens) {
  const out = [];
  for (const tok of tokens) {
    const last = out[out.length - 1];
    if (last && last.type === tok.type) {
      last.text += tok.text;
    } else {
      out.push({ type: tok.type, text: tok.text });
    }
  }
  return out;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Tokenize text for the given language.
 * @param {string} text   Full file content (multi-line).
 * @param {string} lang   Language key (go, js, ts, py, json, html, css, ...).
 * @returns {Array<{type:string, text:string}>}
 */
function tokenize(text, lang) {
  const P = window.Prism;
  const grammarName = LANG_TO_PRISM[lang] || lang;
  const grammar = P && P.languages && P.languages[grammarName];

  if (!grammar) {
    return [{ type: 'plain', text }];
  }

  try {
    const stream = P.tokenize(text, grammar);
    const out = [];
    flatten(stream, 'plain', out);
    return mergeAdjacent(out);
  } catch (e) {
    console.warn('tokenize: Prism failed for lang=' + lang, e);
    return [{ type: 'plain', text }];
  }
}

// Expose globally (no ES module bundler in this project).
window.tokenize = tokenize;
