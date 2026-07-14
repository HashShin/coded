'use strict';

// ── tokenize.js ───────────────────────────────────────────────────────────────
// Exports a single function: tokenize(text, lang) → [{type, text}, ...]
// Token types: kw, str, num, cmt, fn, type, op, plain

/**
 * Escape text for safe HTML insertion.
 * @param {string} s
 * @returns {string}
 */
function escHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── Helper: regex-based tokenizer builder ─────────────────────────────────────

/**
 * Build a tokenizer from an ordered list of [type, regex] pairs.
 * The regex must have the 'y' (sticky) flag — or we use lastIndex manually.
 * We use the 'd' flag if available but fall back gracefully.
 *
 * @param {Array<[string, RegExp]>} rules  Ordered list of [type, pattern].
 * @returns {function(string): Array<{type:string, text:string}>}
 */
function makeTokenizer(rules) {
  // Combine into a single alternation regex with named groups.
  // We label each alternative with a marker we can identify.
  return function tokenize(text) {
    const tokens = [];
    let pos = 0;
    const len = text.length;

    while (pos < len) {
      let matched = false;

      for (const [type, re] of rules) {
        re.lastIndex = pos;
        const m = re.exec(text);
        if (m && m.index === pos) {
          tokens.push({ type, text: m[0] });
          pos += m[0].length;
          matched = true;
          break;
        }
      }

      if (!matched) {
        // Consume one character as plain.
        tokens.push({ type: 'plain', text: text[pos] });
        pos++;
      }
    }

    return tokens;
  };
}

// ── Go tokenizer ──────────────────────────────────────────────────────────────

const GO_KEYWORDS = new Set([
  'func','var','type','struct','interface','if','else','for','range','return',
  'package','import','const','map','chan','go','defer','select','switch','case',
  'default','break','continue','fallthrough','goto','make','new','nil','true','false',
]);

const GO_TYPES = new Set([
  'int','int8','int16','int32','int64','uint','uint8','uint16','uint32','uint64',
  'float32','float64','complex64','complex128','bool','string','byte','rune','error',
  'uintptr',
]);

const goRules = [
  // Line comment
  ['cmt',  /\/\/[^\n]*/y],
  // Block comment
  ['cmt',  /\/\*[\s\S]*?\*\//y],
  // Raw string (backtick)
  ['str',  /`[^`]*`/y],
  // Interpreted string
  ['str',  /"(?:[^"\\]|\\.)*"/y],
  // Rune literal
  ['str',  /'(?:[^'\\]|\\.)*'/y],
  // Number (hex, float, int)
  ['num',  /0[xX][0-9a-fA-F]+|0[oO][0-7]+|0[bB][01]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y],
  // Identifier or keyword
  ['plain', /[A-Za-z_]\w*/y],
  // Operators / punctuation
  ['op',   /[{}()\[\].,;:=+\-*/%&|^!<>~?]/y],
  // Whitespace
  ['plain', /\s+/y],
];

function tokenizeGo(text) {
  const raw = makeTokenizer(goRules)(text);
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    const tok = raw[i];
    if (tok.type === 'plain' && /^[A-Za-z_]\w*$/.test(tok.text)) {
      if (GO_KEYWORDS.has(tok.text)) {
        out.push({ type: 'kw', text: tok.text });
      } else if (GO_TYPES.has(tok.text)) {
        out.push({ type: 'type', text: tok.text });
      } else {
        // Check if followed by '(' for function name
        const next = raw[i + 1];
        if (next && next.text === '(') {
          out.push({ type: 'fn', text: tok.text });
        } else {
          out.push({ type: 'plain', text: tok.text });
        }
      }
    } else {
      out.push(tok);
    }
  }
  return out;
}

// ── JavaScript/TypeScript tokenizer ───────────────────────────────────────────

const JS_KEYWORDS = new Set([
  'function','var','let','const','if','else','for','while','return','class',
  'import','export','from','async','await','new','this','typeof','instanceof',
  'null','undefined','true','false','void','delete','in','of','throw','try',
  'catch','finally','switch','case','default','break','continue','yield','static',
  'extends','super','do','debugger',
]);

const jsRules = [
  // Line comment
  ['cmt',  /\/\/[^\n]*/y],
  // Block comment
  ['cmt',  /\/\*[\s\S]*?\*\//y],
  // Template literal
  ['str',  /`(?:[^`\\]|\\.)*`/y],
  // Double-quoted string
  ['str',  /"(?:[^"\\]|\\.)*"/y],
  // Single-quoted string
  ['str',  /'(?:[^'\\]|\\.)*'/y],
  // Number
  ['num',  /0[xX][0-9a-fA-F]+|0[bB][01]+|0[oO][0-7]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?n?/y],
  // Identifier
  ['plain', /[A-Za-z_$][\w$]*/y],
  // Operators
  ['op',   /[{}()\[\].,;:=+\-*/%&|^!<>~?]/y],
  // Whitespace
  ['plain', /\s+/y],
];

function tokenizeJs(text) {
  const raw = makeTokenizer(jsRules)(text);
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    const tok = raw[i];
    if (tok.type === 'plain' && /^[A-Za-z_$][\w$]*$/.test(tok.text)) {
      if (JS_KEYWORDS.has(tok.text)) {
        out.push({ type: 'kw', text: tok.text });
      } else {
        // Function name: identifier followed by '('
        const next = raw[i + 1];
        if (next && next.text === '(') {
          out.push({ type: 'fn', text: tok.text });
        } else {
          out.push({ type: 'plain', text: tok.text });
        }
      }
    } else {
      out.push(tok);
    }
  }
  return out;
}

// ── Python tokenizer ──────────────────────────────────────────────────────────

const PY_KEYWORDS = new Set([
  'def','class','if','elif','else','for','while','return','import','from','as',
  'with','try','except','finally','raise','pass','break','continue','lambda',
  'yield','and','or','not','in','is','None','True','False','global','nonlocal',
  'del','assert','async','await',
]);

const pyRules = [
  // Triple-quoted strings (before single-quoted)
  ['str',  /"""[\s\S]*?"""/y],
  ['str',  /'''[\s\S]*?'''/y],
  // Line comment
  ['cmt',  /#[^\n]*/y],
  // Double-quoted string
  ['str',  /"(?:[^"\\]|\\.)*"/y],
  // Single-quoted string
  ['str',  /'(?:[^'\\]|\\.)*'/y],
  // Number
  ['num',  /0[xX][0-9a-fA-F]+|0[bB][01]+|0[oO][0-7]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?[jJ]?/y],
  // Identifier
  ['plain', /[A-Za-z_]\w*/y],
  // Operators
  ['op',   /[{}()\[\].,;:=+\-*/%&|^!<>~?@]/y],
  // Whitespace
  ['plain', /\s+/y],
];

function tokenizePy(text) {
  const raw = makeTokenizer(pyRules)(text);
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    const tok = raw[i];
    if (tok.type === 'plain' && /^[A-Za-z_]\w*$/.test(tok.text)) {
      if (PY_KEYWORDS.has(tok.text)) {
        out.push({ type: 'kw', text: tok.text });
      } else {
        const next = raw[i + 1];
        if (next && next.text === '(') {
          out.push({ type: 'fn', text: tok.text });
        } else {
          out.push({ type: 'plain', text: tok.text });
        }
      }
    } else {
      out.push(tok);
    }
  }
  return out;
}

// ── JSON tokenizer ────────────────────────────────────────────────────────────

const jsonRules = [
  ['str',  /"(?:[^"\\]|\\.)*"/y],
  ['num',  /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y],
  ['kw',   /\b(?:true|false|null)\b/y],
  ['op',   /[{}\[\]:,]/y],
  ['plain', /\s+/y],
];

const tokenizeJson = makeTokenizer(jsonRules);

// ── HTML tokenizer ────────────────────────────────────────────────────────────

const htmlRules = [
  // HTML comment
  ['cmt',  /<!--[\s\S]*?-->/y],
  // Opening/closing tags (simplified)
  ['op',   /<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^>]*)?\/?>/y],
  // Attribute values
  ['str',  /"[^"]*"/y],
  ['str',  /'[^']*'/y],
  // Plain text
  ['plain', /[^<"']+/y],
  ['plain', /./y],
];

const tokenizeHtml = makeTokenizer(htmlRules);

// ── CSS tokenizer ─────────────────────────────────────────────────────────────

const cssRules = [
  // Block comment
  ['cmt',  /\/\*[\s\S]*?\*\//y],
  // String
  ['str',  /"[^"]*"/y],
  ['str',  /'[^']*'/y],
  // At-rule
  ['kw',   /@[A-Za-z-]+/y],
  // Selector / property / value
  ['num',  /-?\d+(?:\.\d+)?(?:px|em|rem|%|vh|vw|s|ms|deg|fr)?/y],
  // Color hex
  ['num',  /#[0-9a-fA-F]{3,8}/y],
  // Property name (word followed by colon)
  ['fn',   /[A-Za-z-]+(?=\s*:)/y],
  // Identifier
  ['plain', /[A-Za-z_-][\w-]*/y],
  // Structural
  ['op',   /[{}();:,]/y],
  ['plain', /\s+/y],
  ['plain', /./y],
];

const tokenizeCss = makeTokenizer(cssRules);

// ── Markdown tokenizer ────────────────────────────────────────────────────────

const mdRules = [
  // Fenced code block
  ['str',  /```[\s\S]*?```/y],
  // Heading
  ['kw',   /^#{1,6} [^\n]*/ym],
  // Bold
  ['fn',   /\*\*[^*]+\*\*/y],
  ['fn',   /__[^_]+__/y],
  // Italic
  ['type', /\*[^*]+\*/y],
  ['type', /_[^_]+_/y],
  // Inline code
  ['str',  /`[^`]+`/y],
  // Link
  ['num',  /\[[^\]]+\]\([^)]+\)/y],
  // Plain
  ['plain', /[^\n`*_#\[]+/y],
  ['plain', /./y],
];

const tokenizeMd = makeTokenizer(mdRules);

// ── Shell tokenizer ───────────────────────────────────────────────────────────

const SH_KEYWORDS = new Set([
  'if','then','else','elif','fi','for','do','done','while','case','esac',
  'function','return','export','local','echo','exit','in','source','.',
]);

const shRules = [
  // Comment
  ['cmt',  /#[^\n]*/y],
  // Double-quoted string
  ['str',  /"(?:[^"\\$]|\\.|\$[^{]|\$\{[^}]*\})*"/y],
  // Single-quoted string
  ['str',  /'[^']*'/y],
  // Variable ${VAR} or $VAR
  ['type', /\$\{[A-Za-z_]\w*\}/y],
  ['type', /\$[A-Za-z_]\w*/y],
  // Number
  ['num',  /\b\d+\b/y],
  // Identifier
  ['plain', /[A-Za-z_]\w*/y],
  // Operators
  ['op',   /[{}()\[\]|&;><]/y],
  ['plain', /\s+/y],
  ['plain', /./y],
];

function tokenizeSh(text) {
  const raw = makeTokenizer(shRules)(text);
  const out = [];
  for (const tok of raw) {
    if (tok.type === 'plain' && /^[A-Za-z_]\w*$/.test(tok.text)) {
      if (SH_KEYWORDS.has(tok.text)) {
        out.push({ type: 'kw', text: tok.text });
      } else {
        out.push(tok);
      }
    } else {
      out.push(tok);
    }
  }
  return out;
}

// ── Plain tokenizer ───────────────────────────────────────────────────────────

function tokenizePlain(text) {
  return [{ type: 'plain', text }];
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Tokenize text for the given language.
 * @param {string} text   Full file content (multi-line).
 * @param {string} lang   Language key (go, js, ts, py, json, html, css, md, sh, bash, plain).
 * @returns {Array<{type:string, text:string}>}
 */
function tokenize(text, lang) {
  switch (lang) {
    case 'go':           return tokenizeGo(text);
    case 'js':
    case 'ts':
    case 'jsx':
    case 'tsx':          return tokenizeJs(text);
    case 'py':           return tokenizePy(text);
    case 'json':         return tokenizeJson(text);
    case 'html':
    case 'htm':          return tokenizeHtml(text);
    case 'css':          return tokenizeCss(text);
    case 'md':
    case 'markdown':     return tokenizeMd(text);
    case 'sh':
    case 'bash':         return tokenizeSh(text);
    default:             return tokenizePlain(text);
  }
}

// Expose globally (no ES module bundler in this project).
window.tokenize = tokenize;
