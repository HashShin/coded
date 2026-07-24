'use strict';

// ── autocomplete.js ───────────────────────────────────────────────────────────
// Context-aware suggestion engine: per-language completion that understands
// WHERE the caret is (HTML tag vs attribute, CSS property vs value, code
// identifier) instead of blindly matching words.
//
// Exports: window.acSuggestions(text, caretPos, lang)
//   → { prefix, items: [{label, insert, caret}] } | null
//     label  — text shown in the popup
//     insert — text that replaces the typed prefix (defaults to label)
//     caret  — how many chars to step BACK from the end of insert after accept

// ── HTML data ─────────────────────────────────────────────────────────────────

const AC_HTML_TAGS = [
  'a','abbr','address','article','aside','audio','b','blockquote','body','br',
  'button','canvas','caption','code','col','colgroup','datalist','dd','details',
  'dialog','div','dl','dt','em','embed','fieldset','figcaption','figure','footer',
  'form','h1','h2','h3','h4','h5','h6','head','header','hr','html','i','iframe',
  'img','input','label','legend','li','link','main','map','mark','menu','meta',
  'nav','noscript','object','ol','optgroup','option','output','p','picture','pre',
  'progress','q','script','section','select','small','source','span','strong',
  'style','sub','summary','sup','table','tbody','td','template','textarea',
  'tfoot','th','thead','time','title','tr','track','u','ul','video','wbr',
];

// Tags that never get a closing tag.
const AC_VOID_TAGS = new Set([
  'area','base','br','col','embed','hr','img','input','link','meta','source',
  'track','wbr',
]);

// Attributes valid on (almost) any element.
const AC_GLOBAL_ATTRS = [
  'class','id','style','title','hidden','tabindex','role','lang','dir',
  'contenteditable','draggable','onclick','onchange','oninput','onsubmit',
  'data-','aria-label',
];

// Extra attributes for specific tags.
const AC_TAG_ATTRS = {
  a:        ['href','target','rel','download'],
  img:      ['src','alt','width','height','loading'],
  input:    ['type','name','value','placeholder','required','disabled','checked','min','max','step','autocomplete'],
  button:   ['type','disabled','name','value'],
  form:     ['action','method','enctype','novalidate'],
  link:     ['rel','href','type','media'],
  script:   ['src','type','defer','async'],
  select:   ['name','multiple','required','disabled'],
  option:   ['value','selected','disabled'],
  textarea: ['name','rows','cols','placeholder','required'],
  label:    ['for'],
  iframe:   ['src','width','height','allow','sandbox'],
  video:    ['src','controls','autoplay','loop','muted','poster'],
  audio:    ['src','controls','autoplay','loop'],
  source:   ['src','type','media'],
  meta:     ['name','content','charset'],
  td:       ['colspan','rowspan'],
  th:       ['colspan','rowspan','scope'],
  ol:       ['start','reversed','type'],
  time:     ['datetime'],
  details:  ['open'],
  canvas:   ['width','height'],
};

// Attributes that are boolean (inserted without ="").
const AC_BOOL_ATTRS = new Set([
  'required','disabled','checked','selected','multiple','hidden','defer',
  'async','controls','autoplay','loop','muted','open','novalidate','reversed',
  'contenteditable','draggable',
]);

// ── CSS data ──────────────────────────────────────────────────────────────────

const AC_CSS_PROPS = [
  'align-items','align-content','align-self','animation','background',
  'background-color','background-image','background-position','background-size',
  'border','border-radius','border-bottom','border-top','border-left',
  'border-right','border-color','border-style','border-width','bottom',
  'box-shadow','box-sizing','color','cursor','display','flex','flex-direction',
  'flex-wrap','flex-grow','flex-shrink','flex-basis','float','font-family',
  'font-size','font-style','font-weight','gap','grid','grid-template-columns',
  'grid-template-rows','grid-gap','height','justify-content','justify-items',
  'left','letter-spacing','line-height','list-style','margin','margin-top',
  'margin-bottom','margin-left','margin-right','max-height','max-width',
  'min-height','min-width','object-fit','opacity','outline','overflow',
  'overflow-x','overflow-y','padding','padding-top','padding-bottom',
  'padding-left','padding-right','position','right','text-align',
  'text-decoration','text-overflow','text-transform','top','transform',
  'transition','vertical-align','visibility','white-space','width','word-break',
  'z-index',
];

const AC_CSS_VALUES = {
  'display':         ['flex','grid','block','inline','inline-block','inline-flex','none','table','contents'],
  'position':        ['relative','absolute','fixed','sticky','static'],
  'justify-content': ['center','flex-start','flex-end','space-between','space-around','space-evenly'],
  'align-items':     ['center','flex-start','flex-end','stretch','baseline'],
  'align-content':   ['center','flex-start','flex-end','space-between','stretch'],
  'flex-direction':  ['row','column','row-reverse','column-reverse'],
  'flex-wrap':       ['wrap','nowrap','wrap-reverse'],
  'text-align':      ['left','center','right','justify'],
  'font-weight':     ['normal','bold','400','500','600','700'],
  'font-style':      ['normal','italic'],
  'text-transform':  ['none','uppercase','lowercase','capitalize'],
  'text-decoration': ['none','underline','line-through'],
  'overflow':        ['hidden','auto','scroll','visible'],
  'overflow-x':      ['hidden','auto','scroll','visible'],
  'overflow-y':      ['hidden','auto','scroll','visible'],
  'cursor':          ['pointer','default','text','move','not-allowed','grab'],
  'visibility':      ['visible','hidden'],
  'white-space':     ['nowrap','normal','pre','pre-wrap'],
  'box-sizing':      ['border-box','content-box'],
  'object-fit':      ['contain','cover','fill','none'],
  'border-style':    ['solid','dashed','dotted','none'],
  'vertical-align':  ['middle','top','bottom','baseline'],
  'word-break':      ['break-word','break-all','normal'],
  'background-size': ['cover','contain','auto'],
  'float':           ['left','right','none'],
};

// ── Code keywords (identifier languages) ─────────────────────────────────────

const AC_KEYWORDS = {
  go:   ['func','package','import','type','struct','interface','map','chan','go','defer',
         'return','if','else','for','range','switch','case','default','break','continue',
         'var','const','nil','true','false','error','string','int','int32','int64','uint',
         'uint64','float32','float64','bool','byte','rune','any','make','new','len','cap',
         'append','copy','delete','panic','recover','close','select','fallthrough','goto',
         'iota'],
  js:   ['function','const','let','var','return','if','else','for','while','do','switch',
         'case','default','break','continue','class','extends','constructor','new','this',
         'typeof','instanceof','in','of','try','catch','finally','throw','async','await',
         'import','export','from','yield','delete','void','null','undefined','true','false',
         'document','window','console','JSON','Promise','Array','Object','String','Number',
         'Math','Map','Set','Symbol','RegExp','Error','Date','Boolean','fetch','setTimeout',
         'setInterval','clearTimeout','clearInterval','parseInt','parseFloat','isNaN',
         'encodeURIComponent','decodeURIComponent','localStorage','sessionStorage',
         'requestAnimationFrame','addEventListener','require','module','exports'],
  py:   ['def','class','return','if','elif','else','for','while','break','continue','pass',
         'import','from','as','with','try','except','finally','raise','lambda','yield',
         'global','nonlocal','assert','del','not','and','or','in','is','None','True','False',
         'self','async','await','match','case','__init__','__name__','__main__','__str__',
         '__repr__','__len__'],
  rust: ['fn','let','mut','const','struct','enum','impl','trait','pub','use','mod','match',
         'if','else','for','while','loop','return','break','continue','self','Self','super',
         'crate','where','async','await','move','ref','dyn','unsafe','static','type','as',
         'in','Some','None','Ok','Err','String','Vec','Box','Rc','Arc','Option','Result',
         'HashMap','i32','i64','u32','u64','f32','f64','usize','isize','bool','str','char',
         'println','vec','panic','unwrap','expect','clone','into','From','Into'],
  c:    ['int','char','float','double','void','long','short','unsigned','signed','struct',
         'union','enum','typedef','static','extern','const','return','if','else','for',
         'while','do','switch','case','default','break','continue','sizeof','NULL'],
  cpp:  ['class','namespace','template','typename','public','private','protected','virtual',
         'override','new','delete','this','nullptr','auto','bool','std','string','vector',
         'map','set','include','using','return','if','else','for','while','do','switch',
         'case','break','continue','const','static','void','int','char','float','double',
         'long','unsigned','struct','enum','try','catch','throw','size_t','cout','cin','endl'],
  clike: ['public','private','protected','class','interface','extends','implements','static',
          'final','void','int','boolean','String','new','this','super','return','if','else',
          'for','while','do','switch','case','break','continue','try','catch','finally',
          'throw','throws','import','package','null','true','false','abstract','instanceof',
          'var','val','fun','func','let','enum','record','override','lazy','guard'],
  ruby: ['def','end','class','module','require','include','attr_accessor','attr_reader',
         'attr_writer','puts','print','if','elsif','else','unless','case','when','while',
         'until','for','do','begin','rescue','ensure','raise','yield','return','break',
         'next','redo','retry','self','nil','true','false','and','or','not','then','new',
         'lambda','proc','each','map','select','reject','reduce','initialize','super'],
  php:  ['echo','function','class','public','private','protected','static','const','return',
         'if','else','elseif','foreach','for','while','do','switch','case','break','continue',
         'new','this','array','isset','empty','unset','null','true','false','require',
         'require_once','include','namespace','use','try','catch','finally','throw','extends',
         'implements','interface','abstract','final','global','strlen','count','array_map',
         'array_filter','implode','explode','print_r','var_dump','str_replace','sprintf'],
  sh:   ['echo','if','then','else','elif','fi','for','while','do','done','case','esac',
         'function','local','export','return','exit','source','read','printf','shift',
         'break','continue','test','set','unset','trap','eval','exec','cd','pwd','grep',
         'sed','awk','cut','sort','uniq','head','tail','xargs','find','chmod','mkdir'],
  sql:  ['SELECT','FROM','WHERE','INSERT','INTO','VALUES','UPDATE','SET','DELETE','JOIN',
         'LEFT','RIGHT','INNER','OUTER','FULL','CROSS','ON','GROUP','BY','ORDER','HAVING',
         'LIMIT','OFFSET','CREATE','TABLE','ALTER','DROP','INDEX','VIEW','DISTINCT','AS',
         'AND','OR','NOT','NULL','IS','IN','BETWEEN','LIKE','EXISTS','UNION','ALL','CASE',
         'WHEN','THEN','ELSE','END','COUNT','SUM','AVG','MIN','MAX','PRIMARY','KEY',
         'FOREIGN','REFERENCES','UNIQUE','DEFAULT','CONSTRAINT','CASCADE'],
  yaml: ['name','version','services','image','ports','volumes','environment','depends_on',
         'build','command','restart','networks','steps','runs-on','uses','with','jobs',
         'true','false','null'],
  toml: ['name','version','dependencies','features','package','edition','authors',
         'true','false'],
  docker: ['FROM','RUN','CMD','COPY','ADD','WORKDIR','EXPOSE','ENV','ARG','ENTRYPOINT',
           'VOLUME','USER','LABEL','HEALTHCHECK','SHELL','STOPSIGNAL','ONBUILD','AS'],
};
// ts/tsx/jsx share the JS list with TypeScript-specific additions.
AC_KEYWORDS.ts = AC_KEYWORDS.js.concat(['type','interface','enum','implements','declare',
  'readonly','namespace','abstract','never','unknown','any','void','number','string',
  'boolean','keyof','as','satisfies','public','private','protected']);
AC_KEYWORDS.tsx = AC_KEYWORDS.jsx = AC_KEYWORDS.ts;
AC_KEYWORDS.yml = AC_KEYWORDS.yaml;
AC_KEYWORDS.dockerfile = AC_KEYWORDS.docker;

// Common methods suggested after "." in JS/TS (arrays, strings, objects, DOM).
const AC_JS_DOT_METHODS = [
  'length','push()','pop()','shift()','unshift()','slice()','splice()','map()',
  'filter()','reduce()','forEach()','find()','findIndex()','some()','every()',
  'includes()','indexOf()','join()','concat()','sort()','reverse()','flat()',
  'keys()','values()','entries()','split()','trim()','toLowerCase()',
  'toUpperCase()','replace()','replaceAll()','startsWith()','endsWith()',
  'padStart()','charAt()','match()','toString()','toFixed()','then()','catch()',
  'finally()','addEventListener()','removeEventListener()','querySelector()',
  'querySelectorAll()','getElementById()','createElement()','appendChild()',
  'removeChild()','setAttribute()','getAttribute()','classList','style',
  'dataset','textContent','innerHTML','value','stringify()','parse()','log()',
  'error()','warn()',
];

// Statement snippets: label → {insert, caret} per language. Suggested alongside
// keywords; ranked above them when the prefix matches exactly.
const AC_SNIPPETS = {
  go: {
    'func':   { insert: 'func name() {\n  \n}', caret: 2 },
    'fori':   { insert: 'for i := 0; i < n; i++ {\n  \n}', caret: 2 },
    'forr':   { insert: 'for _, v := range items {\n  \n}', caret: 2 },
    'iferr':  { insert: 'if err != nil {\n  return err\n}', caret: 0 },
    'struct': { insert: 'type Name struct {\n  \n}', caret: 2 },
  },
  js: {
    'func':  { insert: 'function name() {\n  \n}', caret: 2 },
    'afunc': { insert: 'async function name() {\n  \n}', caret: 2 },
    'arrow': { insert: '() => {\n  \n}', caret: 2 },
    'fori':  { insert: 'for (let i = 0; i < n; i++) {\n  \n}', caret: 2 },
    'forof': { insert: 'for (const item of items) {\n  \n}', caret: 2 },
    'tryc':  { insert: 'try {\n  \n} catch (e) {\n  \n}', caret: 19 },
  },
  py: {
    'def':   { insert: 'def name():\n    ', caret: 0 },
    'adef':  { insert: 'async def name():\n    ', caret: 0 },
    'fori':  { insert: 'for i in range(n):\n    ', caret: 0 },
    'ifmain': { insert: "if __name__ == '__main__':\n    main()", caret: 0 },
    'tryex': { insert: 'try:\n    \nexcept Exception as e:\n    ', caret: 28 },
  },
};
AC_SNIPPETS.ts = AC_SNIPPETS.tsx = AC_SNIPPETS.jsx = AC_SNIPPETS.js;

// ── Helpers ───────────────────────────────────────────────────────────────────

function acItem(label, insert, caret) {
  return { label, insert: insert !== undefined ? insert : label, caret: caret || 0 };
}

function acFilter(prefix, words) {
  const lower = prefix.toLowerCase();
  return words.filter(w => w.toLowerCase().startsWith(lower) && w !== prefix);
}

// ── HTML context ──────────────────────────────────────────────────────────────

function acHtml(text, caretPos) {
  const before = text.slice(0, caretPos);

  // Closing tag: "</di" → suggest matching tag, insert "div>".
  const closeM = before.match(/<\/([a-zA-Z][a-zA-Z0-9-]*)$/);
  if (closeM) {
    const prefix = closeM[1];
    const items = acFilter(prefix, AC_HTML_TAGS).map(t => acItem(t, t + '>'));
    return items.length ? { prefix, items: items.slice(0, 8) } : null;
  }

  // Opening tag: "<di" → suggest "div", insert "div></div>" caret inside.
  const tagM = before.match(/<([a-zA-Z][a-zA-Z0-9-]*)$/);
  if (tagM) {
    const prefix = tagM[1];
    const items = acFilter(prefix, AC_HTML_TAGS).map(t => {
      if (AC_VOID_TAGS.has(t)) return acItem(t, t + '>');
      return acItem(t, t + '></' + t + '>', t.length + 3); // caret between > and </t>
    });
    return items.length ? { prefix, items: items.slice(0, 8) } : null;
  }

  // Attribute: inside an unclosed tag, typing a name.
  const lastOpen = before.lastIndexOf('<');
  const lastClose = before.lastIndexOf('>');
  if (lastOpen > lastClose) {
    const tagText = before.slice(lastOpen);
    const tagNameM = tagText.match(/^<([a-zA-Z][a-zA-Z0-9-]*)/);
    const attrM = tagText.match(/\s([a-zA-Z-]+)$/);
    if (tagNameM && attrM) {
      const prefix = attrM[1];
      const tagName = tagNameM[1].toLowerCase();
      const pool = [...(AC_TAG_ATTRS[tagName] || []), ...AC_GLOBAL_ATTRS];
      const items = acFilter(prefix, pool).map(a => {
        if (AC_BOOL_ATTRS.has(a) || a.endsWith('-')) return acItem(a);
        return acItem(a, a + '=""', 1); // caret inside quotes
      });
      return items.length ? { prefix, items: items.slice(0, 8) } : null;
    }
    return null;
  }

  // Text content: Emmet-style expansion — a bare word suggests the matching
  // tag and expands to a full element (di → <div></div>).
  // '!' or 'html' at document start offers the HTML5 boilerplate.
  const bareM = before.match(/(^|[\s>])(!|[a-zA-Z][a-zA-Z0-9-]*)$/);
  if (bareM) {
    const prefix = bareM[2];
    const items = [];
    const docIsEmpty = text.trim().length === prefix.trim().length;
    if (docIsEmpty && (prefix === '!' || 'html'.startsWith(prefix.toLowerCase()))) {
      const boiler = '<!DOCTYPE html>\n<html lang="en">\n<head>\n  <meta charset="UTF-8">\n' +
        '  <meta name="viewport" content="width=device-width, initial-scale=1.0">\n' +
        '  <title>Document</title>\n</head>\n<body>\n  \n</body>\n</html>';
      items.push(acItem('html:5 boilerplate', boiler, 16)); // caret inside <body>
    }
    if (prefix !== '!' && prefix.length >= 2) {
      for (const t of acFilter(prefix, AC_HTML_TAGS)) {
        items.push(AC_VOID_TAGS.has(t)
          ? acItem(t, '<' + t + '>')
          : acItem(t, '<' + t + '></' + t + '>', t.length + 3));
      }
    }
    return items.length ? { prefix, items: items.slice(0, 8) } : null;
  }
  return null;
}

// ── CSS context ───────────────────────────────────────────────────────────────

function acCss(text, caretPos) {
  const before = text.slice(0, caretPos);
  const openBrace = before.lastIndexOf('{');
  const closeBrace = before.lastIndexOf('}');
  if (openBrace <= closeBrace) return null; // outside a declaration block

  // Current declaration segment (since last '{' or ';').
  const segStart = Math.max(openBrace, before.lastIndexOf(';')) + 1;
  const seg = before.slice(segStart);
  const colon = seg.indexOf(':');

  if (colon !== -1) {
    // Value position: "display: fl" → suggest values for the property.
    const prop = seg.slice(0, colon).trim().toLowerCase();
    const valM = seg.slice(colon + 1).match(/[a-zA-Z-]+$/);
    if (!valM) return null;
    const prefix = valM[0];
    const pool = AC_CSS_VALUES[prop] || ['auto','none','inherit','initial','unset','100%'];
    const items = acFilter(prefix, pool).map(v => acItem(v));
    return items.length ? { prefix, items: items.slice(0, 8) } : null;
  }

  // Property position: "disp" → insert "display: ;" caret before ';'.
  const propM = seg.match(/[a-zA-Z-]+$/);
  if (!propM || propM[0].length < 2) return null;
  const prefix = propM[0];
  const items = acFilter(prefix, AC_CSS_PROPS).map(p => acItem(p, p + ': ;', 1));
  return items.length ? { prefix, items: items.slice(0, 8) } : null;
}

// ── Code context (identifier languages) ──────────────────────────────────────

/**
 * Harvest identifiers from CODE only — strings and comments are excluded by
 * running the Prism tokenizer (same one the editor uses for highlighting).
 * Function-typed tokens are tracked separately so they rank first and
 * complete with ().
 */
function acHarvest(text, lang) {
  const counts = new Map();
  const fns = new Set();
  const idRe = /[A-Za-z_$][A-Za-z0-9_$]{1,}/g;

  let tokens = null;
  if (typeof window.tokenize === 'function' && window.Prism) {
    try { tokens = window.tokenize(text, lang); } catch (e) { tokens = null; }
  }

  if (tokens) {
    for (const tok of tokens) {
      if (tok.type === 'str' || tok.type === 'cmt') continue; // skip prose
      let m;
      while ((m = idRe.exec(tok.text)) !== null) {
        counts.set(m[0], (counts.get(m[0]) || 0) + 1);
        if (tok.type === 'fn') fns.add(m[0]);
      }
      idRe.lastIndex = 0;
    }
  } else {
    // Fallback (no Prism): plain regex harvest.
    let m;
    while ((m = idRe.exec(text)) !== null) {
      counts.set(m[0], (counts.get(m[0]) || 0) + 1);
    }
  }
  return { counts, fns };
}

function acCode(text, caretPos, lang) {
  const before = text.slice(0, caretPos);

  // JS/TS: after "." suggest common methods/properties.
  if (lang === 'js' || lang === 'ts' || lang === 'tsx' || lang === 'jsx') {
    const dotM = before.match(/\.([a-zA-Z]*)$/);
    if (dotM && /[A-Za-z0-9_$\])]\.[a-zA-Z]*$/.test(before)) {
      const prefix = dotM[1];
      if (prefix.length === 0) return null; // wait for at least 1 char
      const items = acFilter(prefix, AC_JS_DOT_METHODS).map(mth =>
        mth.endsWith('()') ? acItem(mth, mth, 1) : acItem(mth));
      return items.length ? { prefix, items: items.slice(0, 8) } : null;
    }
  }

  // Go: after `pkg.` suggest that package's stdlib functions (from acdata.js).
  if (lang === 'go' && typeof AC_GO_PKGS !== 'undefined') {
    const pkgM = before.match(/([a-z][a-z0-9]*)\.([A-Za-z]*)$/);
    if (pkgM && AC_GO_PKGS[pkgM[1]]) {
      const prefix = pkgM[2];
      if (prefix.length === 0) return null; // wait for at least 1 char
      const items = acFilter(prefix, AC_GO_PKGS[pkgM[1]]).map(fn =>
        acItem(fn + '()', fn + '()', 1));
      return items.length ? { prefix, items: items.slice(0, 8) } : null;
    }
  }

  const m = before.match(/[A-Za-z_$][A-Za-z0-9_$]*$/);
  if (!m || m[0].length < 2) return null;
  const prefix = m[0];
  const lower = prefix.toLowerCase();

  const { counts, fns } = acHarvest(text, lang);
  if (counts.get(prefix) === 1) counts.delete(prefix); // the word being typed

  // Cross-file symbols: harvest identifiers from other open tabs (hook set by
  // app.js). Weighted below same-file matches by counting each occurrence once.
  if (typeof window.acExtraText === 'function') {
    try {
      const extras = window.acExtraText() || [];
      const idRe = /[A-Za-z_$][A-Za-z0-9_$]{1,}/g;
      for (const extra of extras) {
        let em;
        while ((em = idRe.exec(extra)) !== null) {
          if (!counts.has(em[0])) counts.set(em[0], 0.5); // below in-file rank
        }
        idRe.lastIndex = 0;
      }
    } catch (e) { /* hook failure must never break typing */ }
  }

  // PHP: functions defined in include/require'd files (hook set by app.js).
  if (lang === 'php' && typeof window.acIncludeFns === 'function') {
    try {
      const includeFns = window.acIncludeFns();
      if (includeFns) {
        for (const name of includeFns) {
          if (!counts.has(name)) counts.set(name, 0.6); // above other-tab (0.5), below in-file
          fns.add(name); // rank as functions and complete with ()
        }
      }
    } catch (e) { /* never break typing */ }
  }

  const matches = [];
  for (const w of counts.keys()) {
    if (w !== prefix && w.toLowerCase().startsWith(lower)) matches.push(w);
  }
  // Functions first, then by frequency.
  matches.sort((a, b) => {
    const fa = fns.has(a) ? 1 : 0, fb = fns.has(b) ? 1 : 0;
    if (fa !== fb) return fb - fa;
    return counts.get(b) - counts.get(a);
  });

  const seen = new Set();
  const items = [];
  // Snippets whose trigger starts with the prefix rank first.
  const snips = AC_SNIPPETS[lang] || {};
  for (const trigger of Object.keys(snips)) {
    if (trigger.startsWith(lower)) {
      // Note: trigger is NOT added to `seen` so the plain keyword (e.g. `func`)
      // is still offered alongside its snippet (`func ▸`).
      items.push(acItem(trigger + ' ▸', snips[trigger].insert, snips[trigger].caret));
    }
  }
  for (const w of matches) {
    if (seen.has(w)) continue;
    seen.add(w);
    // Known functions complete with () and caret inside.
    items.push(fns.has(w) ? acItem(w + '()', w + '()', 1) : acItem(w));
  }
  for (const w of (AC_KEYWORDS[lang] || [])) {
    if (w !== prefix && w.toLowerCase().startsWith(lower) && !seen.has(w)) {
      seen.add(w);
      items.push(acItem(w));
    }
  }
  // Python: stdlib builtins (from acdata.js) — functions accept with ().
  if (lang === 'py' && typeof AC_PY_BUILTINS !== 'undefined') {
    for (const w of AC_PY_BUILTINS) {
      if (w !== prefix && w.toLowerCase().startsWith(lower) && !seen.has(w)) {
        seen.add(w);
        // Lowercase names are callables; CamelCase are exception classes.
        items.push(/^[a-z]/.test(w) ? acItem(w + '()', w + '()', 1) : acItem(w));
      }
    }
  }
  if (items.length === 0) return null;
  return { prefix, items: items.slice(0, 8) };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Compute context-aware suggestions at caretPos.
 * @param {string} text
 * @param {number} caretPos
 * @param {string} lang  langFromPath() key
 * @returns {{prefix:string, items:Array<{label:string,insert:string,caret:number}>}|null}
 */
function acSuggestions(text, caretPos, lang) {
  if (lang === 'html') return acHtml(text, caretPos);
  if (lang === 'css') return acCss(text, caretPos);
  // Markdown / plain prose: suggestions are noise, stay quiet.
  if (lang === 'md' || lang === 'plain' || lang === 'git') return null;
  return acCode(text, caretPos, lang);
}

window.acSuggestions = acSuggestions;
