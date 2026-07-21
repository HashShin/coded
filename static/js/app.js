'use strict';

// ── State ────────────────────────────────────────────────────────────────────

/** @type {Map<string, {content: string, dirty: boolean, savedContent: string}>} */
const openFiles = new Map();

/** Currently active tab path, or null. */
let activeTab = null;

/** The Editor instance (created on DOMContentLoaded). */
let editor = null;

/** Autosave debounce timer handle. */
let _saveSessionTimer = null;

/** Per-file fold state: path -> number[] (collapsed start lines). */
const foldStates = new Map();

/** Whether to show dotfiles/dotdirs in tree and quick-open. */
let showHidden = false;

/** Path currently showing the external-change banner, or null. */
let _bannerPath = null;
/** Path currently showing the deleted-file banner, or null. */
let _deletedBannerPath = null;

/** Shows/hides the topbar run button; assigned after DOM ready. */
let updateRunButton = null;

/** True while a focus-triggered file-change check is in flight. */
let _changeCheckInFlight = false;
let _explorerRefreshInFlight = false;

/** The currently selected directory for New File / New Folder actions. '' = root. */
let selectedDir = '';

/** Clipboard for cut/copy/paste: { path, isDir, mode: 'cut'|'copy' } or null. */
let clipboard = null;

/** Explorer multi-selection state: path -> isDirectory. */
let selectionMode = false;
const selectedItems = new Map();

// ── DOM refs ─────────────────────────────────────────────────────────────────

const fileTree       = document.getElementById('file-tree');
const tabBar         = document.getElementById('topbar-tabs');
const editorPane     = document.getElementById('editor-pane');
const editorContainer = document.getElementById('editor-container');
const welcome        = document.getElementById('welcome');
const statusPath     = document.getElementById('status-path');

// ── Language detection ────────────────────────────────────────────────────────

/**
 * Map a file path's extension to a language string for the tokenizer.
 * @param {string} filePath
 * @returns {string}
 */
const IMAGE_EXTS = new Set(['png','jpg','jpeg','gif','svg','webp','bmp','ico','avif']);
function extOf(filePath) {
  const base = filePath.split('/').pop();
  const i = base.lastIndexOf('.');
  return i < 0 ? '' : base.slice(i + 1).toLowerCase();
}
function isImagePath(fp) { return IMAGE_EXTS.has(extOf(fp)); }
function isHtmlPath(fp)  { const e = extOf(fp); return e === 'html' || e === 'htm'; }
function isMdPath(fp)    { const e = extOf(fp); return e === 'md' || e === 'markdown'; }

function langFromPath(filePath) {
  const base = filePath.split('/').pop();
  // Exact filename matches (no extension).
  const nameMap = {
    'Makefile': 'sh', 'makefile': 'sh',
    'Dockerfile': 'docker', 'dockerfile': 'docker',
    'Jenkinsfile': 'clike',
    '.gitconfig': 'ini', 'COMMIT_EDITMSG': 'git',
    '.bashrc': 'sh', '.zshrc': 'sh', '.profile': 'sh',
    '.gitignore': 'plain', '.gitattributes': 'plain',
    'README': 'md',
  };
  if (nameMap[base]) return nameMap[base];

  // Extension-based detection.
  const dotIdx = base.lastIndexOf('.');
  if (dotIdx === -1) return 'plain'; // no extension
  const ext = base.slice(dotIdx + 1).toLowerCase();
  const map = {
    go: 'go',
    js: 'js', mjs: 'js', cjs: 'js',
    ts: 'ts', tsx: 'tsx', jsx: 'jsx',
    py: 'py', pyw: 'py',
    json: 'json', jsonc: 'json',
    html: 'html', htm: 'html', svg: 'html', xml: 'html',
    css: 'css', scss: 'css', less: 'css',
    md: 'md', markdown: 'md',
    sh: 'sh', bash: 'sh', zsh: 'sh', fish: 'sh',
    yaml: 'yaml', yml: 'yaml',
    toml: 'toml', ini: 'ini', env: 'ini',
    rs: 'rust',
    c: 'c', h: 'c',
    cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp',
    java: 'clike', kt: 'clike', swift: 'clike',
    rb: 'ruby',
    php: 'php',
    sql: 'sql',
    dockerfile: 'docker',
  };
  return map[ext] || 'plain';
}

// ── Tree ─────────────────────────────────────────────────────────────────────

/**
 * Fetch one directory level and return the entry array.
 * @param {string} relPath  Relative path within root ('' = root).
 * @returns {Promise<Array<{name:string,isDir:boolean,size:number}>>}
 */
async function fetchTree(relPath) {
  const params = [];
  if (relPath) params.push('path=' + encodeURIComponent(relPath));
  if (showHidden) params.push('hidden=1');
  const url = '/api/tree' + (params.length ? '?' + params.join('&') : '');
  const res = await fetch(url);
  if (!res.ok) throw new Error('tree fetch failed: ' + res.status);
  return res.json();
}

// ── File-type badges ─────────────────────────────────────────────────────────
// Extension → {label, color, icon?}. Colors follow each language's brand
// color. `icon` is a slug into window.FILE_ICON_PATHS (fileicons.js) — when
// present the real language logo is rendered; otherwise a text chip.
const FILE_BADGES = {
  go:     { label: 'GO', color: '#00add8', icon: 'go' },
  rs:     { label: 'RS', color: '#f74c00', icon: 'rust' },
  py:     { label: 'PY', color: '#4b8bbe', icon: 'python' },
  pyw:    { label: 'PY', color: '#4b8bbe', icon: 'python' },
  js:     { label: 'JS', color: '#f7df1e', icon: 'javascript' },
  mjs:    { label: 'JS', color: '#f7df1e', icon: 'javascript' },
  cjs:    { label: 'JS', color: '#f7df1e', icon: 'javascript' },
  ts:     { label: 'TS', color: '#3178c6', icon: 'typescript' },
  tsx:    { label: 'TX', color: '#3178c6', icon: 'react' },
  jsx:    { label: 'JX', color: '#61dafb', icon: 'react' },
  c:      { label: 'C',  color: '#5c9dd6', icon: 'c' },
  h:      { label: 'H',  color: '#5c9dd6', icon: 'c' },
  cpp:    { label: 'C+', color: '#659ad2', icon: 'cplusplus' },
  cc:     { label: 'C+', color: '#659ad2', icon: 'cplusplus' },
  hpp:    { label: 'H+', color: '#659ad2', icon: 'cplusplus' },
  java:   { label: 'JV', color: '#e76f00', icon: 'openjdk' },
  kt:     { label: 'KT', color: '#a97bff', icon: 'kotlin' },
  kts:    { label: 'KT', color: '#a97bff', icon: 'kotlin' },
  swift:  { label: 'SW', color: '#f05138', icon: 'swift' },
  rb:     { label: 'RB', color: '#cc342d', icon: 'ruby' },
  php:    { label: 'PH', color: '#777bb3', icon: 'php' },
  cs:     { label: 'C#', color: '#b180d7', icon: 'sharp' },
  html:   { label: '<>', color: '#e34c26', icon: 'html5' },
  htm:    { label: '<>', color: '#e34c26', icon: 'html5' },
  css:    { label: '#',  color: '#42a5f5', icon: 'css3' },
  scss:   { label: '#',  color: '#cd6799', icon: 'sass' },
  sass:   { label: '#',  color: '#cd6799', icon: 'sass' },
  less:   { label: '#',  color: '#6b8cc4', icon: 'less' },
  json:   { label: '{}', color: '#cbcb41', icon: 'json' },
  yaml:   { label: 'YM', color: '#cb171e', icon: 'yaml' },
  yml:    { label: 'YM', color: '#cb171e', icon: 'yaml' },
  toml:   { label: 'TM', color: '#9c4221', icon: 'toml' },
  xml:    { label: 'XM', color: '#50bee8', rawSvg: '<svg viewBox="96 0 384 512" width="12" height="15" aria-hidden="true" xmlns="http://www.w3.org/2000/svg"><path fill="#e2e5e7" d="M128,0c-17.6,0-32,14.4-32,32v448c0,17.6,14.4,32,32,32h320c17.6,0,32-14.4,32-32V128L352,0H128z"/><path fill="#b0b7bd" d="M384,128h96L352,0v96C352,113.6,366.4,128,384,128z"/><polygon fill="#cad1d8" points="480,224 384,128 480,128"/><path fill="#50bee8" d="M416,416c0,8.8-7.2,16-16,16H48c-8.8,0-16-7.2-16-16V256c0-8.8,7.2-16,16-16h352c8.8,0,16,7.2,16,16V416z"/><path fill="#fff" d="M131.28,326.176l22.272-27.888c6.64-8.688,19.568,2.432,12.288,10.752c-7.664,9.088-15.728,18.944-23.424,29.024l26.112,32.496c7.024,9.6-7.04,18.816-13.952,9.344l-23.536-30.192l-23.152,30.832c-6.528,9.328-20.992-1.152-13.68-9.856l25.712-32.624c-8.064-10.096-15.872-19.936-23.664-29.024c-8.064-9.6,6.912-19.44,12.784-10.48L131.28,326.176z"/><path fill="#fff" d="M201.264,327.84v47.328c0,5.648-4.608,8.832-9.2,8.832c-4.096,0-7.68-3.184-7.68-8.832v-72.016c0-6.656,5.648-8.848,7.68-8.848c3.696,0,5.872,2.192,8.048,4.624l28.16,37.984l29.152-39.408c4.24-5.232,14.592-3.2,14.592,5.648v72.016c0,5.648-3.584,8.832-7.664,8.832c-4.608,0-8.192-3.184-8.192-8.832V327.84l-21.248,26.864c-4.592,5.648-10.352,5.648-14.576,0L201.264,327.84z"/><path fill="#fff" d="M294.288,303.152c0-4.224,3.584-7.808,8.064-7.808c4.096,0,7.552,3.6,7.552,7.808v64.096h34.8c12.528,0,12.8,16.752,0,16.752h-42.336c-4.48,0-8.064-3.184-8.064-7.808v-73.04H294.288z"/><path fill="#cad1d8" d="M400,432H96v16h304c8.8,0,16-7.2,16-16v-16C416,424.8,408.8,432,400,432z"/></svg>' },
  md:     { label: 'MD', color: '#8a9199', icon: 'markdown' },
  txt:    { txtGlyph: true, color: '#e8ecf0' },
  sh:     { label: '$',  color: '#89e051', svg: '<rect x="3" y="5" width="17" height="14" rx="2" stroke="currentColor" stroke-width="2"/><path d="M7 10L9 12L7 14" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M12 14H16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>' },
  bash:   { label: '$',  color: '#89e051', svg: '<rect x="3" y="5" width="17" height="14" rx="2" stroke="currentColor" stroke-width="2"/><path d="M7 10L9 12L7 14" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M12 14H16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>' },
  zsh:    { label: '$',  color: '#89e051', svg: '<rect x="3" y="5" width="17" height="14" rx="2" stroke="currentColor" stroke-width="2"/><path d="M7 10L9 12L7 14" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M12 14H16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>' },
  ps1:    { label: 'PS', color: '#5391fe', svg: '<rect x="3" y="5" width="17" height="14" rx="2" stroke="currentColor" stroke-width="2"/><path d="M7 9L11 12L7 15" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M12 15H16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>' },
  psm1:   { label: 'PS', color: '#5391fe', svg: '<rect x="3" y="5" width="17" height="14" rx="2" stroke="currentColor" stroke-width="2"/><path d="M7 9L11 12L7 15" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M12 15H16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>' },
  sql:    { label: 'SQ', color: '#e38c00', svg: '<ellipse cx="12" cy="7" rx="8" ry="3" stroke="currentColor" stroke-width="1.5"/><path d="M4 7v5c0 1.657 3.582 3 8 3s8-1.343 8-3V7" stroke="currentColor" stroke-width="1.5"/><path d="M4 12v5c0 1.657 3.582 3 8 3s8-1.343 8-3v-5" stroke="currentColor" stroke-width="1.5"/>' },
  lua:    { label: 'LU', color: '#6b9aff', icon: 'lua' },
  dart:   { label: 'DA', color: '#00b4ab', icon: 'dart' },
  vue:    { label: 'VU', color: '#41b883', icon: 'vuedotjs' },
  svelte: { label: 'SV', color: '#ff3e00', icon: 'svelte' },
  svg:    { label: 'SVG', color: '#f7b84e', rawSvg: '<svg viewBox="96 0 384 512" width="12" height="15" aria-hidden="true" xmlns="http://www.w3.org/2000/svg"><path fill="#e2e5e7" d="M128,0c-17.6,0-32,14.4-32,32v448c0,17.6,14.4,32,32,32h320c17.6,0,32-14.4,32-32V128L352,0H128z"/><path fill="#b0b7bd" d="M384,128h96L352,0v96C352,113.6,366.4,128,384,128z"/><polygon fill="#cad1d8" points="480,224 384,128 480,128"/><path fill="#f7b84e" d="M416,416c0,8.8-7.2,16-16,16H48c-8.8,0-16-7.2-16-16V256c0-8.8,7.2-16,16-16h352c8.8,0,16,7.2,16,16V416z"/><path fill="#fff" d="M96.816,314.656c2.944-24.816,40.416-29.28,58.08-15.712c8.704,7.024-0.512,18.16-8.192,12.528c-9.472-6.016-30.96-8.832-33.648,4.464c-3.456,20.992,52.192,8.976,51.312,42.992c-0.896,32.496-47.984,33.264-65.648,18.672c-4.224-3.44-4.096-9.056-1.792-12.528c3.328-3.312,7.04-4.464,11.392-0.896c10.48,7.168,37.488,12.544,39.392-5.648C146.064,339.616,92.848,351.008,96.816,314.656z"/><path fill="#fff" d="M209.12,378.256l-33.776-70.752c-4.992-10.112,10.112-18.416,15.728-7.808l11.392,25.712l14.704,33.776l14.448-33.776l11.392-25.712c5.12-9.712,19.952-3.584,15.616,7.04L226,378.256C223.056,386.32,213.984,388.224,209.12,378.256z"/><path fill="#fff" d="M345.76,374.16c-9.088,7.536-20.224,10.752-31.472,10.752c-26.88,0-45.936-15.36-45.936-45.808c0-25.84,20.096-45.92,47.072-45.92c10.112,0,21.232,3.456,29.168,11.264c7.792,7.664-3.456,19.056-11.12,12.288c-4.736-4.624-11.392-8.064-18.048-8.064c-15.472,0-30.432,12.4-30.432,30.432c0,18.944,12.528,30.448,29.296,30.448c7.792,0,14.448-2.304,19.184-5.76V348.08h-19.184c-11.392,0-10.24-15.632,0-15.632h25.584c4.736,0,9.072,3.6,9.072,7.568v27.248C348.96,369.552,347.936,371.712,345.76,374.16z"/><path fill="#cad1d8" d="M400,432H96v16h304c8.8,0,16-7.2,16-16v-16C416,424.8,408.8,432,400,432z"/></svg>' },
  png:    { label: 'IMG', color: '#a074c4' },
  jpg:    { label: 'IMG', color: '#a074c4' },
  jpeg:   { label: 'IMG', color: '#a074c4' },
  gif:    { label: 'IMG', color: '#a074c4' },
  mod:    { label: 'GO', color: '#00add8', icon: 'go' }, // go.mod
  sum:    { label: 'GO', color: '#00add8', icon: 'go' }, // go.sum
  lock:   { label: 'LK', color: '#8a9199', svg: '<rect x="5" y="11" width="14" height="10" rx="2" stroke="currentColor" stroke-width="1.5"/><path d="M8 11V7a4 4 0 0 1 8 0v4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="12" cy="16" r="1.5" fill="currentColor"/>' },
  cfg:    { label: 'CF', color: '#99b8c4', rawSvg: '<svg viewBox="0 0 32 32" width="15" height="15" aria-hidden="true" xmlns="http://www.w3.org/2000/svg"><path fill="currentColor" d="M23.265,24.381l.9-.894c4.164.136,4.228-.01,4.411-.438l1.144-2.785L29.805,20l-.093-.231c-.049-.122-.2-.486-2.8-2.965V15.5c3-2.89,2.936-3.038,2.765-3.461L28.538,9.225c-.171-.422-.236-.587-4.37-.474l-.9-.93a20.166,20.166,0,0,0-.141-4.106l-.116-.263-2.974-1.3c-.438-.2-.592-.272-3.4,2.786l-1.262-.019c-2.891-3.086-3.028-3.03-3.461-2.855L9.149,3.182c-.433.175-.586.237-.418,4.437l-.893.89c-4.162-.136-4.226.012-4.407.438L2.285,11.733,2.195,12l.094.232c.049.12.194.48,2.8,2.962l0,1.3c-3,2.89-2.935,3.038-2.763,3.462l1.138,2.817c.174.431.236.584,4.369.476l.9.935a20.243,20.243,0,0,0,.137,4.1l.116.265,2.993,1.308c.435.182.586.247,3.386-2.8l1.262.016c2.895,3.09,3.043,3.03,3.466,2.859l2.759-1.115C23.288,28.644,23.44,28.583,23.265,24.381ZM11.407,17.857a4.957,4.957,0,1,1,6.488,2.824A5.014,5.014,0,0,1,11.407,17.857Z"/></svg>' },
  conf:   { label: 'CF', color: '#99b8c4', rawSvg: '<svg viewBox="0 0 32 32" width="15" height="15" aria-hidden="true" xmlns="http://www.w3.org/2000/svg"><path fill="currentColor" d="M23.265,24.381l.9-.894c4.164.136,4.228-.01,4.411-.438l1.144-2.785L29.805,20l-.093-.231c-.049-.122-.2-.486-2.8-2.965V15.5c3-2.89,2.936-3.038,2.765-3.461L28.538,9.225c-.171-.422-.236-.587-4.37-.474l-.9-.93a20.166,20.166,0,0,0-.141-4.106l-.116-.263-2.974-1.3c-.438-.2-.592-.272-3.4,2.786l-1.262-.019c-2.891-3.086-3.028-3.03-3.461-2.855L9.149,3.182c-.433.175-.586.237-.418,4.437l-.893.89c-4.162-.136-4.226.012-4.407.438L2.285,11.733,2.195,12l.094.232c.049.12.194.48,2.8,2.962l0,1.3c-3,2.89-2.935,3.038-2.763,3.462l1.138,2.817c.174.431.236.584,4.369.476l.9.935a20.243,20.243,0,0,0,.137,4.1l.116.265,2.993,1.308c.435.182.586.247,3.386-2.8l1.262.016c2.895,3.09,3.043,3.03,3.466,2.859l2.759-1.115C23.288,28.644,23.44,28.583,23.265,24.381ZM11.407,17.857a4.957,4.957,0,1,1,6.488,2.824A5.014,5.014,0,0,1,11.407,17.857Z"/></svg>' },
  ini:    { label: 'IN', color: '#99b8c4', rawSvg: '<svg viewBox="0 0 32 32" width="15" height="15" aria-hidden="true" xmlns="http://www.w3.org/2000/svg"><path fill="currentColor" d="M23.265,24.381l.9-.894c4.164.136,4.228-.01,4.411-.438l1.144-2.785L29.805,20l-.093-.231c-.049-.122-.2-.486-2.8-2.965V15.5c3-2.89,2.936-3.038,2.765-3.461L28.538,9.225c-.171-.422-.236-.587-4.37-.474l-.9-.93a20.166,20.166,0,0,0-.141-4.106l-.116-.263-2.974-1.3c-.438-.2-.592-.272-3.4,2.786l-1.262-.019c-2.891-3.086-3.028-3.03-3.461-2.855L9.149,3.182c-.433.175-.586.237-.418,4.437l-.893.89c-4.162-.136-4.226.012-4.407.438L2.285,11.733,2.195,12l.094.232c.049.12.194.48,2.8,2.962l0,1.3c-3,2.89-2.935,3.038-2.763,3.462l1.138,2.817c.174.431.236.584,4.369.476l.9.935a20.243,20.243,0,0,0,.137,4.1l.116.265,2.993,1.308c.435.182.586.247,3.386-2.8l1.262.016c2.895,3.09,3.043,3.03,3.466,2.859l2.759-1.115C23.288,28.644,23.44,28.583,23.265,24.381ZM11.407,17.857a4.957,4.957,0,1,1,6.488,2.824A5.014,5.014,0,0,1,11.407,17.857Z"/></svg>' },
  zig:    { label: 'ZG', color: '#f7a41d', icon: 'zig' },
  ex:     { label: 'EX', color: '#6e4a7e', icon: 'elixir' },
  exs:    { label: 'EX', color: '#6e4a7e', icon: 'elixir' },
  hs:     { label: 'HS', color: '#5e5086', icon: 'haskell' },
  r:      { label: 'R',  color: '#276dc3', icon: 'r' },
  // Binaries / compiled artifacts.
  exe:    { label: '01', color: '#9e9e9e' },
  bin:    { label: '01', color: '#9e9e9e' },
  dll:    { label: '01', color: '#9e9e9e' },
  so:     { label: '01', color: '#9e9e9e' },
  dylib:  { label: '01', color: '#9e9e9e' },
  o:      { label: '01', color: '#9e9e9e' },
  a:      { label: '01', color: '#9e9e9e' },
  wasm:   { label: 'WA', color: '#654ff0' },
  class:  { label: '01', color: '#9e9e9e' },
  pyc:    { label: '01', color: '#9e9e9e' },
  apk:    { label: 'APK', color: '#3ddc84' },
  jar:    { label: 'JAR', color: '#e76f00', icon: 'openjdk' },
  // Archives.
  zip:    { label: 'ZIP', color: '#b8a038' },
  tar:    { label: 'ZIP', color: '#b8a038' },
  gz:     { label: 'ZIP', color: '#b8a038' },
  xz:     { label: 'ZIP', color: '#b8a038' },
  bz2:    { label: 'ZIP', color: '#b8a038' },
  '7z':   { label: 'ZIP', color: '#b8a038' },
  rar:    { label: 'ZIP', color: '#b8a038' },
  // Documents.
  pdf:    { label: 'PDF', color: '#e53935' },
};
// Special full filenames (no useful extension).
const FILE_BADGES_BY_NAME = {
  'makefile':   { label: 'MK', color: '#6d8086', rawSvg: '<svg viewBox="10 5 108 118" width="13" height="16" aria-hidden="true" xmlns="http://www.w3.org/2000/svg"><path fill="currentColor" d="m 29.09375,11.234375 c -3.183804,0 -5.71875,2.566196 -5.71875,5.75 l 0,94.031255 c 0,3.1838 2.534946,5.75 5.71875,5.75 l 69.8125,0 c 3.1838,0 5.71875,-2.5662 5.71875,-5.75 l 0,-70.656255 -21.03125,0 c -4.306108,0 -8.0625,-3.141109 -8.0625,-7.3125 l 0,-21.8125 -46.4375,0 z m 50.4375,0 0,21.8125 c 0,1.714122 1.631968,3.3125 4.0625,3.3125 l 21.03125,0 -25.09375,-25.125 z m -32.34375,29.3125 1.71875,0 1.65625,3.5 0.03125,0.75 -0.53125,2.4375 3.25,1.3125 1.3125,-2.0625 0.59375,-0.53125 3.59375,-1.25 1.25,1.21875 -1.28125,3.59375 -0.5,0.59375 -2.0625,1.3125 1.3125,3.28125 2.40625,-0.5625 0.78125,0.03125 3.46875,1.65625 0,1.75 -3.46875,1.65625 -0.78125,0 -2.40625,-0.5 -1.3125,3.21875 2.0625,1.375 0.5,0.59375 1.28125,3.59375 -1.25,1.25 -3.59375,-1.28125 -0.59375,-0.5625 -1.3125,-2.0625 -3.25,1.34375 0.53125,2.40625 -0.03125,0.78125 -1.65625,3.4375 -1.71875,0 -1.65625,-3.4375 -0.0625,-0.78125 0.53125,-2.40625 -3.25,-1.34375 -1.3125,2.0625 -0.59375,0.5625 -3.59375,1.28125 -1.25,-1.25 1.28125,-3.59375 0.5625,-0.59375 2.0625,-1.375 -1.34375,-3.21875 -2.40625,0.5 -0.8125,0 -3.46875,-1.65625 0,-1.75 3.46875,-1.65625 0.8125,-0.03125 2.40625,0.5625 1.34375,-3.28125 -2.0625,-1.3125 -0.5625,-0.59375 L 36,45.921875 l 1.25,-1.21875 3.59375,1.25 0.59375,0.53125 1.3125,2.0625 3.25,-1.3125 -0.53125,-2.4375 0.0625,-0.75 1.65625,-3.5 z m 0.875,10.875 c -2.927972,0 -5.34375,2.353278 -5.34375,5.28125 0,2.927972 2.415778,5.3125 5.34375,5.3125 2.927972,0 5.28125,-2.384528 5.28125,-5.3125 0,-2.927972 -2.353278,-5.28125 -5.28125,-5.28125 z m 18.15625,10.3125 3.09375,3.34375 0.46875,1.15625 0.40625,2.75 4.46875,0 0.40625,-2.75 0.4375,-1.15625 3.125,-3.34375 2.25,0.71875 0.53125,4.53125 -0.28125,1.21875 -1.3125,2.4375 3.625,2.65625 1.90625,-2 1.0625,-0.625 4.5,-0.90625 1.375,1.90625 -2.21875,3.96875 -0.96875,0.8125 -2.46875,1.1875 1.40625,4.28125 2.71875,-0.46875 1.21875,0.09375 4.15625,1.90625 0,2.34375 -4.15625,1.9375 -1.21875,0.09375 -2.71875,-0.46875 -1.40625,4.25 2.46875,1.21875 0.96875,0.78125 2.21875,4.03125 -1.375,1.875 -4.5,-0.875 -1.0625,-0.65625 -1.90625,-2 -3.625,2.65625 1.3125,2.406255 0.28125,1.21875 -0.53125,4.5625 -2.25,0.75 -3.125,-3.40625 -0.4375,-1.125 -0.40625,-2.71875 -4.46875,0 -0.40625,2.71875 -0.46875,1.125 -3.09375,3.40625 -2.25,-0.75 -0.53125,-4.5625 0.3125,-1.21875 1.28125,-2.406255 -3.625,-2.65625 -1.9375,2 -1.0625,0.65625 -4.46875,0.875 -1.375,-1.875 2.21875,-4.03125 0.9375,-0.78125 2.46875,-1.21875 -1.34375,-4.25 -2.71875,0.46875 -1.21875,-0.09375 -4.1875,-1.9375 0,-2.34375 4.1875,-1.90625 1.21875,-0.09375 2.71875,0.46875 1.34375,-4.28125 -2.46875,-1.1875 -0.9375,-0.8125 -2.21875,-3.96875 1.375,-1.90625 4.46875,0.90625 1.0625,0.625 1.9375,2 3.625,-2.65625 -1.28125,-2.4375 -0.3125,-1.21875 0.53125,-4.53125 2.25,-0.71875 z m 6.1875,14.09375 c -4.866236,0 -8.8125,3.946264 -8.8125,8.8125 0,4.866238 3.946264,8.8125 8.8125,8.8125 4.866237,0 8.8125,-3.946262 8.8125,-8.8125 0,-4.866236 -3.946263,-8.8125 -8.8125,-8.8125 z"/></svg>' },
  'dockerfile': { label: 'DK', color: '#2496ed', icon: 'docker' },
  'license':    { label: '§',  color: '#d0bf41', svg: '<path opacity="0.15" d="M12 17H7C5.89543 17 5 16.1046 5 15V5C5 3.89543 5.89543 3 7 3H16C17.1046 3 18 3.89543 18 5V19C18 20.1046 17.1046 21 16 21C14.8954 21 14 20.1046 14 19C14 17.8954 13.1046 17 12 17Z" fill="currentColor"/><path d="M19 3H9C7.11438 3 6.17157 3 5.58579 3.58579C5 4.17157 5 5.11438 5 7V10.5V17" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M14 17V19C14 20.1046 14.8954 21 16 21C17.1046 21 18 20.1046 18 19V9V4.5C18 3.67157 18.6716 3 19.5 3C20.3284 3 21 3.67157 21 4.5C21 5.32843 20.3284 6 19.5 6H18.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M16 21H5C3.89543 21 3 20.1046 3 19C3 17.8954 3.89543 17 5 17H14" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M9 7H14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M9 11H14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>' },
};
const FILE_BADGE_DEFAULT = { fileGlyph: true, color: '#b8bec8' };
const FILE_BADGE_EXEC    = { fileGlyph: true, color: '#ffffff' };

/**
 * Get the badge descriptor for a file name.
 * @param {string} name
 * @param {boolean} [isExec]  True if the server flagged the file executable.
 * @returns {{label:string, color:string, icon?:string}}
 */
function badgeForFile(name, isExec) {
  const lower = name.toLowerCase();
  if (FILE_BADGES_BY_NAME[lower]) return FILE_BADGES_BY_NAME[lower];
  const dot = lower.lastIndexOf('.');
  if (dot > 0 && dot < lower.length - 1) {
    const ext = lower.slice(dot + 1);
    if (FILE_BADGES[ext]) return FILE_BADGES[ext];
  }
  // No known extension: executables get the binary badge.
  if (isExec) return FILE_BADGE_EXEC;
  return FILE_BADGE_DEFAULT;
}

/**
 * Build a <ul> of tree items for the given entries under parentPath.
 * @param {Array} entries
 * @param {string} parentPath  The directory these entries live in ('').
 * @returns {HTMLUListElement}
 */

const FOLDER_CLOSED_SVG =
  '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">' +
  '<path d="M1.5 3.5 A 1 1 0 0 1 2.5 2.5 H 6 L 7.5 4 H 13.5 A 1 1 0 0 1 14.5 5 V 12.5 A 1 1 0 0 1 13.5 13.5 H 2.5 A 1 1 0 0 1 1.5 12.5 Z" fill="currentColor"/></svg>';
const FOLDER_OPEN_SVG =
  '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">' +
  '<path d="M1.5 3.5 A 1 1 0 0 1 2.5 2.5 H 6 L 7.5 4 H 13 A 1 1 0 0 1 14 5 V 6 H 4.5 L 2.8 12.5 H 2.5 A 1 1 0 0 1 1.5 11.5 Z" fill="currentColor" opacity="0.75"/>' +
  '<path d="M4.5 6.5 H 15 L 13.3 12.8 A 1 1 0 0 1 12.35 13.5 H 2.5 A 1 1 0 0 1 1.55 12.8 Z" fill="currentColor"/></svg>';

function buildTreeList(entries, parentPath) {
  const ul = document.createElement('ul');
  ul.className = 'tree-children';

  for (const entry of entries) {
    const itemPath = parentPath ? parentPath + '/' + entry.name : entry.name;
    const li = document.createElement('li');

    const row = document.createElement('div');
    row.className = 'tree-item';
    row.dataset.path = itemPath;
    row.dataset.isdir = entry.isDir ? '1' : '0';

    // Indentation based on depth (count slashes).
    const depth = itemPath.split('/').length - 1;
    row.style.paddingLeft = (4 + depth * 14) + 'px';

    const icon = document.createElement('span');
    icon.className = 'tree-icon';
    icon.textContent = '';

    const label = document.createElement('span');
    label.textContent = entry.name;
    label.className = 'tree-label';

    row.appendChild(icon);
    if (!entry.isDir) {
      const badge = badgeForFile(entry.name, !!entry.exec);
      const iconPath = badge.icon && window.FILE_ICON_PATHS && window.FILE_ICON_PATHS[badge.icon];
      const chip = document.createElement('span');
      if (badge.rawSvg) {
        // Full SVG markup (custom viewBox, multi-color).
        chip.className = 'file-logo';
        chip.innerHTML = badge.rawSvg;
      } else if (badge.svg) {
        // Raw multi-element SVG (e.g. stroke-based icons).
        chip.className = 'file-logo';
        chip.style.color = badge.color;
        chip.innerHTML =
          '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" aria-hidden="true">' +
          badge.svg + '</svg>';
      } else if (iconPath) {
        // Real language logo (simple-icons path, 24x24 viewBox).
        chip.className = 'file-logo';
        chip.style.color = badge.color;
        chip.innerHTML =
          '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">' +
          '<path d="' + iconPath + '" fill="currentColor"/></svg>';
      } else if (badge.txtGlyph) {
        // Document icon with "TXT" label for .txt files.
        chip.className = 'file-logo';
        chip.style.color = badge.color;
        chip.innerHTML =
          '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">' +
          '<path fill="currentColor" d="M4.5 1.5h5L13 5v8.5a1 1 0 0 1-1 1H4.5a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1Z" opacity="0.8"/>' +
          '<path fill="currentColor" d="M9.5 1.5 13 5H9.5Z"/>' +
          '<path fill="#1e1e1e" d="M4.8 8.2h2.2v0.65H6.05v2H5.75V8.85H4.8zM9.5 8.2h2.2v0.65H10.75v2H10.45V8.85H9.5zM7.6 8.2l0.65 1.1 0.65-1.1h0.45l-0.87 1.4 0.87 1.4H8.9l-0.65-1.05-0.65 1.05H7.15l0.87-1.4-0.87-1.4z"/>' +
          '</svg>';
      } else if (badge.fileGlyph) {
        // Generic document icon for files with no/unknown extension.
        chip.className = 'file-logo';
        chip.style.color = badge.color;
        chip.innerHTML =
          '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">' +
          '<path fill="currentColor" d="M4.5 1.5h5L13 5v8.5a1 1 0 0 1-1 1H4.5a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1Z" opacity="0.75"/>' +
          '<path fill="currentColor" d="M9.5 1.5 13 5H9.5Z"/></svg>';
      } else {
        chip.className = 'file-badge';
        chip.textContent = badge.label;
        chip.style.setProperty('--badge-color', badge.color);
      }
      row.appendChild(chip);
    } else {
      const chip = document.createElement('span');
      chip.className = 'folder-icon';
      chip.innerHTML = FOLDER_CLOSED_SVG;
      row.appendChild(chip);
    }
    row.appendChild(label);
    li.appendChild(row);

    if (entry.isDir) {
      row.addEventListener('click', (e) => {
        if (e._fromLongPress) return;
        if (selectionMode) { toggleSelectedItem(row); return; }
        selectedDir = itemPath;
        setSelectedRow(row);
        toggleDir(row, itemPath);
      });
    } else {
      row.addEventListener('click', (e) => {
        if (e._fromLongPress) return;
        if (selectionMode) { toggleSelectedItem(row); return; }
        selectedDir = itemPath.includes('/') ? itemPath.slice(0, itemPath.lastIndexOf('/')) : '';
        setSelectedRow(row);
        openFile(itemPath, row);
      });
    }

    // Right-click context menu.
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (selectionMode) { toggleSelectedItem(row); return; }
      showContextMenu(itemPath, entry.isDir, e.clientX, e.clientY);
    });

    // Long-press context menu (touch).
    let _lpTimer = null;
    row.addEventListener('touchstart', (e) => {
      _lpTimer = setTimeout(() => {
        _lpTimer = null;
        if (selectionMode) { toggleSelectedItem(row); return; }
        const t = e.touches[0];
        const fakeEvt = { _fromLongPress: true };
        showContextMenu(itemPath, entry.isDir, t.clientX, t.clientY);
      }, 500);
    }, { passive: true });
    row.addEventListener('touchmove', () => { clearTimeout(_lpTimer); _lpTimer = null; }, { passive: true });
    row.addEventListener('touchend', () => { clearTimeout(_lpTimer); _lpTimer = null; }, { passive: true });

    ul.appendChild(li);
  }

  return ul;
}

/**
 * Toggle a directory open/closed.
 * @param {HTMLElement} row
 * @param {string} dirPath
 * @param {HTMLElement} icon
 */
async function toggleDir(row, dirPath) {
  const folderChip = row.querySelector('.folder-icon');
  // If already expanded, collapse.
  const existing = row.nextElementSibling;
  if (existing && existing.classList.contains('tree-children')) {
    existing.remove();
    if (folderChip) folderChip.innerHTML = FOLDER_CLOSED_SVG;
    return;
  }

  try {
    const entries = await fetchTree(dirPath);
    const childList = buildTreeList(entries, dirPath);
    row.parentElement.appendChild(childList);
    if (folderChip) folderChip.innerHTML = FOLDER_OPEN_SVG;
  } catch (e) {
    if (folderChip) folderChip.innerHTML = FOLDER_CLOSED_SVG;
    console.error('Failed to expand dir:', dirPath, e);
  }
}

/**
 * Render the root file tree into #file-tree.
 */
async function loadRootTree() {
  fileTree.textContent = '';
  try {
    const entries = await fetchTree('');
    const ul = buildTreeList(entries, '');
    // Move children of ul into fileTree directly.
    while (ul.firstChild) fileTree.appendChild(ul.firstChild);
  } catch (e) {
    const li = document.createElement('li');
    li.textContent = 'Error loading tree';
    li.style.color = '#f44';
    li.style.padding = '8px';
    fileTree.appendChild(li);
    console.error(e);
  }
}

// ── Selected row ─────────────────────────────────────────────────────────────

function setSelectedRow(row) {
  const prev = fileTree.querySelector('.tree-item.selected');
  if (prev) prev.classList.remove('selected');
  if (row) row.classList.add('selected');
}

function updateSelectionUI() {
  const sidebar = document.getElementById('sidebar');
  const toggle = document.getElementById('btn-selection-toggle');
  const count = document.getElementById('selection-count');
  const deleteBtn = document.getElementById('btn-delete-selected');
  const copyBtn = document.getElementById('btn-copy-selected');
  const moveBtn = document.getElementById('btn-move-selected');
  if (sidebar) sidebar.classList.toggle('selection-mode', selectionMode);
  if (toggle) {
    const label = selectionMode ? 'Cancel selection' : 'Select multiple files';
    toggle.classList.toggle('active', selectionMode);
    toggle.setAttribute('aria-pressed', String(selectionMode));
    toggle.setAttribute('aria-label', label);
    toggle.title = label;
  }
  if (count) count.textContent = `${selectedItems.size} selected`;
  if (deleteBtn) deleteBtn.disabled = selectedItems.size === 0;
  if (copyBtn) copyBtn.disabled = selectedItems.size === 0;
  if (moveBtn) moveBtn.disabled = selectedItems.size === 0;
}

function toggleSelectedItem(row) {
  const path = row.dataset.path;
  if (selectedItems.has(path)) {
    selectedItems.delete(path);
    row.classList.remove('multi-selected');
  } else {
    selectedItems.set(path, row.dataset.isdir === '1');
    row.classList.add('multi-selected');
  }
  updateSelectionUI();
}

function setSelectionMode(enabled) {
  selectionMode = enabled;
  if (!enabled) {
    selectedItems.clear();
    fileTree.querySelectorAll('.multi-selected').forEach(row => row.classList.remove('multi-selected'));
  }
  updateSelectionUI();
}

function updateClipboardUI() {
  const sidebar = document.getElementById('sidebar');
  const text = document.getElementById('clipboard-hint-text');
  if (!sidebar || !text) return;
  sidebar.classList.toggle('clipboard-pending', !!clipboard);
  if (!clipboard) {
    text.textContent = '';
    return;
  }
  const count = clipboard.items ? clipboard.items.length : 1;
  const action = clipboard.mode === 'cut' ? 'ready to move' : 'copied';
  text.textContent = `${count} item${count === 1 ? '' : 's'} ${action} · Long-press folder to paste`;
}

// ── Tree refresh preserving expanded state ────────────────────────────────────

/**
 * Attach pre-fetched children into a tree-children <ul> that was built by
 * buildTreeList, for every dir row that was previously expanded and whose
 * data is present in the prefetched map. Operates recursively, fully
 * synchronous once all data is prefetched.
 * @param {HTMLUListElement} ul - the <ul> built by buildTreeList
 * @param {Set<string>} expanded - set of dir paths that were expanded
 * @param {Map<string, Array>} prefetched - map of dirPath → entries array
 */
function _attachExpandedChildren(ul, expanded, prefetched) {
  ul.querySelectorAll('.tree-item').forEach(row => {
    if (row.dataset.isdir !== '1') return;
    const dirPath = row.dataset.path;
    if (!expanded.has(dirPath)) return;
    const entries = prefetched.get(dirPath);
    if (!entries) return; // dir was deleted or fetch failed — skip

    // Mark folder chip as open.
    const chip = row.querySelector('.folder-icon');
    if (chip) chip.innerHTML = FOLDER_OPEN_SVG;

    // Build child list and attach to the <li> (same as toggleDir does).
    const childList = buildTreeList(entries, dirPath);
    _attachExpandedChildren(childList, expanded, prefetched); // recurse
    row.parentElement.appendChild(childList);
  });
}

async function refreshTreePreservingState() {
  // 1. Snapshot expanded paths and selected path before touching the DOM.
  const expanded = new Set();
  fileTree.querySelectorAll('.tree-item').forEach(row => {
    if (row.nextElementSibling && row.nextElementSibling.classList.contains('tree-children')) {
      expanded.add(row.dataset.path);
    }
  });
  const selectedPath = fileTree.querySelector('.tree-item.selected')?.dataset.path ?? null;

  // 2. Fetch all needed data in parallel (root + every expanded dir).
  const pathsToFetch = ['', ...expanded];
  const results = await Promise.all(pathsToFetch.map(p => fetchTree(p).catch(() => null)));
  const prefetched = new Map();
  pathsToFetch.forEach((p, i) => { if (results[i]) prefetched.set(p, results[i]); });

  // 3. Build new tree entirely off-screen.
  const rootEntries = prefetched.get('') || [];
  const newUl = buildTreeList(rootEntries, '');
  _attachExpandedChildren(newUl, expanded, prefetched);

  // 4. Swap in one synchronous DOM operation — no blank frame.
  fileTree.replaceChildren(...newUl.childNodes);

  // 5. Restore selection highlight.
  if (selectedPath) {
    const sel = fileTree.querySelector(`.tree-item[data-path="${CSS.escape(selectedPath)}"]`);
    if (sel) sel.classList.add('selected');
  }
  if (selectionMode) {
    Array.from(selectedItems.keys()).forEach(path => {
      const row = fileTree.querySelector(`.tree-item[data-path="${CSS.escape(path)}"]`);
      if (row) row.classList.add('multi-selected');
      else selectedItems.delete(path);
    });
    updateSelectionUI();
  }
}

async function syncExplorerOnce() {
  if (_explorerRefreshInFlight || document.hidden) return;
  _explorerRefreshInFlight = true;
  try {
    await refreshTreePreservingState();
  } catch (err) {
    console.error('Explorer refresh failed:', err);
  } finally {
    _explorerRefreshInFlight = false;
  }
}

// ── Prompt modal ──────────────────────────────────────────────────────────────

/**
 * Show a text-input prompt modal and return the entered value, or null if cancelled.
 * @param {{title:string, label:string, initialValue?:string, confirmLabel?:string, allowEmpty?:boolean}} opts
 * @returns {Promise<string|null>}
 */
function promptModal(opts) {
  return new Promise((resolve) => {
    const overlay = document.getElementById('prompt-overlay');
    const titleEl = document.getElementById('prompt-title');
    const labelEl = document.getElementById('prompt-label');
    const input   = document.getElementById('prompt-input');
    const btnOk   = document.getElementById('prompt-ok');
    const btnCancel = document.getElementById('prompt-cancel');
    if (!overlay) { resolve(null); return; }

    titleEl.textContent = opts.title || 'Input';
    labelEl.textContent = opts.label || 'Name';
    input.value = opts.initialValue || '';
    btnOk.textContent = opts.confirmLabel || 'OK';

    overlay.style.display = 'flex';
    setTimeout(() => { input.focus(); input.select(); }, 50);

    function finish(val) {
      overlay.style.display = 'none';
      btnOk.removeEventListener('click', onOk);
      btnCancel.removeEventListener('click', onCancel);
      overlay.removeEventListener('mousedown', onBg);
      input.removeEventListener('keydown', onKey);
      resolve(val);
    }
    function onOk() {
      const v = input.value.trim();
      if (!v && !opts.allowEmpty) { input.focus(); return; }
      finish(v);
    }
    function onCancel() { finish(null); }
    function onBg(e) { if (e.target === overlay) finish(null); }
    function onKey(e) {
      if (e.key === 'Enter') { e.preventDefault(); onOk(); }
      if (e.key === 'Escape') { e.preventDefault(); finish(null); }
    }
    btnOk.addEventListener('click', onOk);
    btnCancel.addEventListener('click', onCancel);
    overlay.addEventListener('mousedown', onBg);
    input.addEventListener('keydown', onKey);
  });
}

// ── Context menu ──────────────────────────────────────────────────────────────

function showContextMenu(itemPath, isDir, x, y) {
  // Remove any existing menu.
  const existing = document.getElementById('tree-context-menu');
  if (existing) existing.remove();

  const menu = document.createElement('div');
  menu.id = 'tree-context-menu';
  menu.className = 'tree-context-menu';

  function addItem(label, fn) {
    const btn = document.createElement('button');
    btn.className = 'ctx-menu-item';
    btn.textContent = label;
    btn.addEventListener('click', () => { menu.remove(); fn(); });
    menu.appendChild(btn);
  }

  const createDir = isDir ? itemPath : (itemPath.includes('/') ? itemPath.slice(0, itemPath.lastIndexOf('/')) : '');
  addItem('New File',   () => createEntry(createDir, false));
  addItem('New Folder', () => createEntry(createDir, true));
  const sep = document.createElement('div');
  sep.className = 'ctx-menu-sep';
  menu.appendChild(sep);
  addItem('Rename', () => renameEntry(itemPath, isDir));
  addItem('Delete', () => deleteEntry(itemPath, isDir));
  const sep2 = document.createElement('div');
  sep2.className = 'ctx-menu-sep';
  menu.appendChild(sep2);
  addItem('Cut',  () => cutEntry(itemPath, isDir));
  addItem('Copy', () => copyEntry(itemPath, isDir));
  if (clipboard) {
    const pasteDir = isDir ? itemPath : (itemPath.includes('/') ? itemPath.slice(0, itemPath.lastIndexOf('/')) : '');
    addItem('Paste', () => pasteEntry(pasteDir));
  }

  // Position the menu, keeping it within the viewport.
  menu.style.left = '0';
  menu.style.top = '0';
  document.body.appendChild(menu);
  const rect = menu.getBoundingClientRect();
  const left = Math.min(x, window.innerWidth - rect.width - 4);
  const top  = Math.min(y, window.innerHeight - rect.height - 4);
  menu.style.left = left + 'px';
  menu.style.top  = top + 'px';

  function dismiss(e) {
    if (!menu.contains(e.target)) {
      menu.remove();
      document.removeEventListener('mousedown', dismiss, true);
      document.removeEventListener('touchstart', dismiss, true);
    }
  }
  setTimeout(() => {
    document.addEventListener('mousedown', dismiss, true);
    document.addEventListener('touchstart', dismiss, true);
  }, 0);
}

function showRootContextMenu(x, y) {
  const existing = document.getElementById('tree-context-menu');
  if (existing) existing.remove();
  const menu = document.createElement('div');
  menu.id = 'tree-context-menu';
  menu.className = 'tree-context-menu';
  function addItem(label, fn) {
    const btn = document.createElement('button');
    btn.className = 'ctx-menu-item';
    btn.textContent = label;
    btn.addEventListener('click', () => { menu.remove(); fn(); });
    menu.appendChild(btn);
  }
  addItem('New File',   () => createEntry('', false));
  addItem('New Folder', () => createEntry('', true));
  if (clipboard) {
    const sep2 = document.createElement('div');
    sep2.className = 'ctx-menu-sep';
    menu.appendChild(sep2);
    addItem('Paste', () => pasteEntry(''));
  }
  menu.style.left = '0'; menu.style.top = '0';
  document.body.appendChild(menu);
  const rect = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, window.innerWidth  - rect.width  - 4) + 'px';
  menu.style.top  = Math.min(y, window.innerHeight - rect.height - 4) + 'px';
  setTimeout(() => {
    function dismiss(e) { if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('mousedown', dismiss, true); document.removeEventListener('touchstart', dismiss, true); } }
    document.addEventListener('mousedown', dismiss, true);
    document.addEventListener('touchstart', dismiss, true);
  }, 0);
}

// ── File CRUD actions ─────────────────────────────────────────────────────────

function _crudError(msg) {
  // Reuse confirmModal as a simple alert.
  const overlay = document.getElementById('confirm-overlay');
  const msgEl   = document.getElementById('confirm-message');
  const titleEl = overlay && overlay.querySelector('.confirm-title');
  const discard = document.getElementById('confirm-discard');
  const cancel  = document.getElementById('confirm-cancel');
  if (!overlay) { alert(msg); return; }
  if (titleEl) titleEl.textContent = 'Error';
  if (msgEl) msgEl.textContent = msg;
  if (discard) discard.style.display = 'none';
  if (cancel) cancel.textContent = 'OK';
  overlay.style.display = 'flex';
  function close() {
    overlay.style.display = 'none';
    if (discard) discard.style.display = '';
    if (cancel) cancel.textContent = 'Cancel';
    cancel.removeEventListener('click', close);
  }
  cancel.addEventListener('click', close);
}

async function createEntry(parentDir, isDir) {
  const name = await promptModal({
    title: isDir ? 'New Folder' : 'New File',
    label: 'Name',
    confirmLabel: 'Create',
  });
  if (!name) return;
  if (name.includes('/') || name === '..' || name === '.') {
    _crudError('Invalid name.'); return;
  }
  const path = parentDir ? parentDir + '/' + name : name;
  const res = await fetch('/api/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, isDir }),
  });
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    _crudError(j.error || 'Create failed.'); return;
  }
  await refreshTreePreservingState();
}

async function renameEntry(itemPath, isDir) {
  const oldName = itemPath.split('/').pop();
  const newName = await promptModal({
    title: 'Rename',
    label: 'New name',
    initialValue: oldName,
    confirmLabel: 'Rename',
  });
  if (!newName || newName === oldName) return;
  if (newName.includes('/') || newName === '..' || newName === '.') {
    _crudError('Invalid name.'); return;
  }
  const parent = itemPath.includes('/') ? itemPath.slice(0, itemPath.lastIndexOf('/')) : '';
  const to = parent ? parent + '/' + newName : newName;
  const res = await fetch('/api/rename', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: itemPath, to }),
  });
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    _crudError(j.error || 'Rename failed.'); return;
  }
  _updateTabsAfterRename(itemPath, to, isDir);
  await refreshTreePreservingState();
}

async function deleteEntry(itemPath, isDir) {
  const label = isDir ? `"${itemPath}" and all its contents` : `"${itemPath}"`;
  const ok = await new Promise((resolve) => {
    const overlay = document.getElementById('confirm-overlay');
    const msgEl   = document.getElementById('confirm-message');
    const titleEl = overlay && overlay.querySelector('.confirm-title');
    const discard = document.getElementById('confirm-discard');
    const cancel  = document.getElementById('confirm-cancel');
    if (!overlay) { resolve(false); return; }
    if (titleEl) titleEl.textContent = 'Delete';
    if (msgEl) msgEl.textContent = `Delete ${label}?`;
    if (discard) { discard.textContent = 'Delete'; discard.style.display = ''; }
    overlay.style.display = 'flex';
    function close(val) {
      overlay.style.display = 'none';
      if (discard) discard.textContent = 'Discard';
      if (cancel) cancel.textContent = 'Cancel';
      discard && discard.removeEventListener('click', onDiscard);
      cancel && cancel.removeEventListener('click', onCancel);
      resolve(val);
    }
    function onDiscard() { close(true); }
    function onCancel()  { close(false); }
    discard && discard.addEventListener('click', onDiscard);
    cancel  && cancel.addEventListener('click', onCancel);
  });
  if (!ok) return;
  const res = await fetch('/api/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: itemPath }),
  });
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    _crudError(j.error || 'Delete failed.'); return;
  }
  _closeTabsUnder(itemPath, isDir);
  await refreshTreePreservingState();
}

async function deleteSelectedItems() {
  if (selectedItems.size === 0) return;
  // If a selected folder contains another selected item, deleting the folder
  // already covers the child; only send the top-level request.
  const items = Array.from(selectedItems, ([path, isDir]) => ({ path, isDir }))
    .filter(item => !Array.from(selectedItems.keys()).some(parent =>
      parent !== item.path && item.path.startsWith(parent + '/') && selectedItems.get(parent)));
  const ok = await confirmModal({
    title: 'Delete selected items',
    message: `Delete ${selectedItems.size} selected item${selectedItems.size === 1 ? '' : 's'}? This cannot be undone.`,
    confirmLabel: 'Delete',
    danger: true,
  });
  if (!ok) return;

  for (const item of items) {
    const res = await fetch('/api/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: item.path }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      await refreshTreePreservingState();
      _crudError(body.error || `Could not delete "${item.path}".`);
      return;
    }
    _closeTabsUnder(item.path, item.isDir);
  }
  setSelectionMode(false);
  await refreshTreePreservingState();
}

function stageSelectedItems(mode) {
  if (selectedItems.size === 0) return;
  const items = Array.from(selectedItems, ([path, isDir]) => ({ path, isDir }))
    .filter(item => !Array.from(selectedItems.keys()).some(parent =>
      parent !== item.path && item.path.startsWith(parent + '/') && selectedItems.get(parent)));
  clipboard = { items, mode };
  setSelectionMode(false);
  updateClipboardUI();
}

function cutEntry(itemPath, isDir) {
  clipboard = { path: itemPath, isDir, mode: 'cut' };
  updateClipboardUI();
}

function copyEntry(itemPath, isDir) {
  clipboard = { path: itemPath, isDir, mode: 'copy' };
  updateClipboardUI();
}

async function pasteEntry(targetDir) {
  if (!clipboard) return;
  if (clipboard.items) {
    await pasteSelectedEntries(targetDir);
    return;
  }
  const { path: src, isDir, mode } = clipboard;
  let name = src.split('/').pop();
  let dest = targetDir ? targetDir + '/' + name : name;
  if (isDir && dest.startsWith(src + '/')) {
    _crudError('Cannot paste a folder into itself.'); return;
  }
  if (mode === 'cut' && dest === src) {
    _crudError('Cannot move a folder into itself.'); return;
  }
  const endpoint = mode === 'cut' ? '/api/rename' : '/api/copy';
  let res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: src, to: dest }),
  });
  if (res.status === 409) {
    const newName = await promptModal({
      title: 'Name already exists',
      label: 'New name',
      initialValue: name,
      confirmLabel: mode === 'cut' ? 'Move' : 'Copy',
    });
    if (!newName) return;
    if (newName.includes('/') || newName === '..' || newName === '.') {
      _crudError('Invalid name.'); return;
    }
    dest = targetDir ? targetDir + '/' + newName : newName;
    res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: src, to: dest }),
    });
  }
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    _crudError(j.error || 'Paste failed.');
    return;
  }
  if (mode === 'cut') {
    _updateTabsAfterRename(src, dest, isDir);
  }
  clipboard = null;
  updateClipboardUI();
  await refreshTreePreservingState();
}

async function pasteSelectedEntries(targetDir) {
  const mode = clipboard.mode;
  const pending = clipboard.items.slice();
  while (pending.length) {
    const item = pending[0];
    let name = item.path.split('/').pop();
    let dest = targetDir ? targetDir + '/' + name : name;
    if (item.isDir && targetDir.startsWith(item.path + '/')) {
      _crudError('Cannot paste a folder into itself.');
      return;
    }
    if (mode === 'cut' && item.isDir && targetDir === item.path) {
      _crudError('Cannot move a folder into itself.');
      return;
    }
    const endpoint = mode === 'cut' ? '/api/rename' : '/api/copy';
    let res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: item.path, to: dest }),
    });
    if (res.status === 409) {
      const newName = await promptModal({
        title: 'Name already exists',
        label: `New name for ${name}`,
        initialValue: name,
        confirmLabel: mode === 'cut' ? 'Move' : 'Copy',
      });
      if (!newName) return;
      if (newName.includes('/') || newName === '.' || newName === '..') {
        _crudError('Invalid name.'); return;
      }
      dest = targetDir ? targetDir + '/' + newName : newName;
      res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: item.path, to: dest }),
      });
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      _crudError(body.error || `Could not paste "${item.path}".`);
      return;
    }
    if (mode === 'cut') _updateTabsAfterRename(item.path, dest, item.isDir);
    pending.shift();
    clipboard.items = pending.slice();
    updateClipboardUI();
  }
  clipboard = null;
  updateClipboardUI();
  await refreshTreePreservingState();
}

// ── Tab bookkeeping helpers ───────────────────────────────────────────────────

function _closeTabsUnder(path, isDir) {
  const toClose = [];
  for (const p of openFiles.keys()) {
    if (isDir ? (p === path || p.startsWith(path + '/')) : p === path) {
      toClose.push(p);
    }
  }
  for (const p of toClose) closeTab(p);
}

function _updateTabsAfterRename(from, to, isDir) {
  // Close affected tabs — user can reopen from new path.
  _closeTabsUnder(from, isDir);
}

// ── Tabs ─────────────────────────────────────────────────────────────────────

/**
 * Save the current editor content back into openFiles for the active tab.
 * Call this before switching away from a tab.
 */
function saveActiveTabContent() {
  if (activeTab && editor) {
    const file = openFiles.get(activeTab);
    if (file && !file.isImage) {
      file.content = editor.getValue();
    }
    if (file && !file.isImage && editor.getFoldStates) foldStates.set(activeTab, editor.getFoldStates());
  }
}

/**
 * Create or activate a tab for the given path.
 * @param {string} filePath
 */
function activateTab(filePath) {
  // Hide any change/deleted banner for the tab we're leaving.
  if (activeTab && activeTab !== filePath) {
    hideChangeBanner(activeTab);
    const delBanner = document.getElementById('deleted-banner');
    if (delBanner && _deletedBannerPath === activeTab) {
      delBanner.classList.remove('visible');
      _deletedBannerPath = null;
    }
  }
  // Save content of current tab before leaving it.
  saveActiveTabContent();

  // Deactivate current.
  if (activeTab) {
    const prev = tabBar.querySelector('.tab[data-path="' + CSS.escape(activeTab) + '"]');
    if (prev) prev.classList.remove('active');
    // Also deactivate tree item.
    const prevTree = fileTree.querySelector('.tree-item.active');
    if (prevTree) prevTree.classList.remove('active');
  }

  activeTab = filePath;

  // Activate tab element.
  let tab = tabBar.querySelector('.tab[data-path="' + CSS.escape(filePath) + '"]');
  if (!tab) {
    tab = createTab(filePath);
    tabBar.appendChild(tab);
  }
  tab.classList.add('active');
  tab.scrollIntoView({ block: 'nearest', inline: 'nearest' });

  // Activate tree item.
  const treeItem = fileTree.querySelector('.tree-item[data-path="' + CSS.escape(filePath) + '"]');
  if (treeItem) treeItem.classList.add('active');

  // Show content in editor.
  const file = openFiles.get(filePath);
  showContent(filePath, file ? file.content : '');

  scheduleSaveSession();
}

/**
 * Build a tab element.
 * @param {string} filePath
 * @returns {HTMLElement}
 */
function createTab(filePath) {
  const parts = filePath.split('/');
  const name = parts[parts.length - 1];

  const tab = document.createElement('div');
  tab.className = 'tab';
  tab.dataset.path = filePath;
  tab.title = filePath;

  // File icon (same logic as explorer tree).
  const badge = badgeForFile(name, false);
  const iconPath = badge.icon && window.FILE_ICON_PATHS && window.FILE_ICON_PATHS[badge.icon];
  const iconEl = document.createElement('span');
  if (badge.rawSvg) {
    iconEl.className = 'file-logo tab-icon';
    iconEl.innerHTML = badge.rawSvg;
  } else if (badge.svg) {
    iconEl.className = 'file-logo tab-icon';
    iconEl.style.color = badge.color;
    iconEl.innerHTML =
      '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" aria-hidden="true">' +
      badge.svg + '</svg>';
  } else if (iconPath) {
    iconEl.className = 'file-logo tab-icon';
    iconEl.style.color = badge.color;
    iconEl.innerHTML =
      '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">' +
      '<path d="' + iconPath + '" fill="currentColor"/></svg>';
  } else {
    iconEl.className = 'tab-badge';
    iconEl.style.color = badge.color;
    iconEl.style.opacity = '0.75';
    iconEl.textContent = badge.label || '';
  }

  const label = document.createElement('span');
  label.className = 'tab-label';
  label.textContent = name;

  const closeBtn = document.createElement('button');
  closeBtn.className = 'tab-close';
  closeBtn.textContent = '×';
  closeBtn.title = 'Close';
  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    closeTab(filePath);
  });

  tab.appendChild(iconEl);
  tab.appendChild(label);
  tab.appendChild(closeBtn);
  tab.addEventListener('click', () => activateTab(filePath));

  return tab;
}

/**
 * Update the dirty indicator on the tab for filePath.
 * @param {string} filePath
 */
function updateTabDirty(filePath) {
  const file = openFiles.get(filePath);
  const tab = tabBar.querySelector('.tab[data-path="' + CSS.escape(filePath) + '"]');
  if (!tab || !file) return;
  if (file.dirty) {
    tab.classList.add('dirty');
  } else {
    tab.classList.remove('dirty');
  }
}

/**
 * Normalize text for dirty comparison: unify line endings and strip a single
 * trailing newline, which the contenteditable round-trip does not preserve.
 * @param {string} s
 * @returns {string}
 */
function normalizeForCompare(s) {
  return s.replace(/\r\n/g, '\n').replace(/\n$/, '');
}

/**
 * Update dirty state for the given path based on current text.
 * @param {string} filePath
 * @param {string} text
 */
function updateDirtyState(filePath, text) {
  const file = openFiles.get(filePath);
  if (!file) return;
  file.content = text;
  file.dirty = normalizeForCompare(text) !== normalizeForCompare(file.savedContent);
  updateTabDirty(filePath);
}

/**
 * Show a generic confirm modal (reuses #confirm-overlay infrastructure).
 * @param {{title:string, message:string, confirmLabel:string, danger?:boolean}} opts
 * @returns {Promise<boolean>}
 */
function confirmModal({ title, message, confirmLabel, danger }) {
  const overlay = document.getElementById('confirm-overlay');
  const titleEl = overlay.querySelector('.confirm-title');
  const msg = document.getElementById('confirm-message');
  const btnConfirm = document.getElementById('confirm-discard');
  const btnCancel = document.getElementById('confirm-cancel');
  if (titleEl) titleEl.textContent = title;
  msg.textContent = message;
  btnConfirm.textContent = confirmLabel;
  btnConfirm.className = 'confirm-btn' + (danger !== false ? ' danger' : '');
  overlay.style.display = 'flex';
  return new Promise((resolve) => {
    function cleanup(result) {
      overlay.style.display = 'none';
      btnConfirm.textContent = 'Discard';
      btnConfirm.className = 'confirm-btn danger';
      if (titleEl) titleEl.textContent = 'Unsaved changes';
      btnConfirm.removeEventListener('click', onConfirm);
      btnCancel.removeEventListener('click', onCancel);
      overlay.removeEventListener('mousedown', onBackdrop);
      document.removeEventListener('keydown', onKey);
      resolve(result);
    }
    function onConfirm() { cleanup(true); }
    function onCancel() { cleanup(false); }
    function onBackdrop(e) { if (e.target === overlay) cleanup(false); }
    function onKey(e) { if (e.key === 'Escape') cleanup(false); }
    btnConfirm.addEventListener('click', onConfirm);
    btnCancel.addEventListener('click', onCancel);
    overlay.addEventListener('mousedown', onBackdrop);
    document.addEventListener('keydown', onKey);
    if (!navigator.maxTouchPoints) btnConfirm.focus();
  });
}

/**
 * Save the current file to disk via PUT /api/file.
 */
async function saveCurrentFile() {
  if (!activeTab || !editor) return;
  const filePath = activeTab;
  const content = editor.getValue();

  // Warn if user dismissed an external-change notification without reloading.
  const fileState = openFiles.get(filePath);
  if (fileState && fileState.externalChangePending) {
    const name = filePath.split('/').pop();
    const ok = await confirmModal({
      title: 'File changed on disk',
      message: '"' + name + '" was changed on disk. Overwrite the disk version with your edits?',
      confirmLabel: 'Overwrite',
      danger: true,
    });
    if (!ok) return;
  }

  try {
    const res = await fetch('/api/file?path=' + encodeURIComponent(filePath), {
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      body: content,
    });
    if (!res.ok) {
      let msg = 'Error ' + res.status;
      try {
        const body = await res.json();
        msg = body.error || msg;
      } catch (_) {}
      console.error('Save failed:', msg);
      if (statusPath) statusPath.textContent = filePath + '  [save failed: ' + msg + ']';
      return;
    }
    // Success: mark clean.
    const file = openFiles.get(filePath);
    if (file) {
      file.savedContent = content;
      file.content = content;
      file.dirty = false;
      file.diskMtime = res.headers.get('X-File-Mtime') || file.diskMtime;
      file.externalChangePending = false;
      updateTabDirty(filePath);
    }
  } catch (e) {
    console.error('Save network error:', e);
  }
}

/**
 * Show a Discard / Cancel modal for a file with unsaved changes.
 * Resolves true if the user chose Discard, false if Cancel/backdrop/Escape.
 * @param {string} fileName
 * @returns {Promise<boolean>}
 */
function confirmDiscard(fileName) {
  const overlay = document.getElementById('confirm-overlay');
  const msg = document.getElementById('confirm-message');
  const btnDiscard = document.getElementById('confirm-discard');
  const btnCancel = document.getElementById('confirm-cancel');
  msg.textContent = '"' + fileName + '" has unsaved changes. Discard them?';
  overlay.style.display = 'flex';
  return new Promise((resolve) => {
    function cleanup(result) {
      overlay.style.display = 'none';
      btnDiscard.removeEventListener('click', onDiscard);
      btnCancel.removeEventListener('click', onCancel);
      overlay.removeEventListener('mousedown', onBackdrop);
      document.removeEventListener('keydown', onKey);
      resolve(result);
    }
    function onDiscard() { cleanup(true); }
    function onCancel() { cleanup(false); }
    function onBackdrop(e) { if (e.target === overlay) cleanup(false); }
    function onKey(e) { if (e.key === 'Escape') cleanup(false); }
    btnDiscard.addEventListener('click', onDiscard);
    btnCancel.addEventListener('click', onCancel);
    overlay.addEventListener('mousedown', onBackdrop);
    document.addEventListener('keydown', onKey);
    if (!navigator.maxTouchPoints) btnDiscard.focus();
  });
}

/**
 * Close a tab.
 * @param {string} filePath
 */
async function closeTab(filePath) {
  const file = openFiles.get(filePath);
  // Sync editor text into dirty state before checking, if this is the active tab.
  // Images have no editor text or savedContent to compare.
  if (activeTab === filePath && file && !file.isImage && editor) {
    updateDirtyState(filePath, editor.getValue());
  }
  if (file && file.dirty) {
    const name = filePath.split('/').pop();
    const ok = await confirmDiscard(name);
    if (!ok) return;
  }
  // Save content before closing, in case we switch to another tab.
  if (activeTab === filePath) {
    saveActiveTabContent();
  }

  openFiles.delete(filePath);

  const tab = tabBar.querySelector('.tab[data-path="' + CSS.escape(filePath) + '"]');
  if (!tab) return;

  // Find adjacent tab to switch to.
  const allTabs = Array.from(tabBar.querySelectorAll('.tab'));
  const idx = allTabs.indexOf(tab);
  tab.remove();

  // Also remove active tree highlight.
  const treeItem = fileTree.querySelector('.tree-item[data-path="' + CSS.escape(filePath) + '"]');
  if (treeItem) treeItem.classList.remove('active');

  if (activeTab === filePath) {
    activeTab = null;
    // Switch to adjacent tab.
    const remaining = Array.from(tabBar.querySelectorAll('.tab'));
    if (remaining.length > 0) {
      const next = remaining[Math.min(idx, remaining.length - 1)];
      activateTab(next.dataset.path);
    } else {
      showWelcome();
      scheduleSaveSession();
    }
  }
}

// ── Content display ───────────────────────────────────────────────────────────

/**
 * Show file content in the editor.
 * @param {string} filePath
 * @param {string} content
 */
function showContent(filePath, content) {
  welcome.style.display = 'none';
  const _sb = document.getElementById('status-bar');
  if (_sb) _sb.style.display = '';
  statusPath.textContent = filePath;
  if (updateRunButton) updateRunButton();
  const imgBox = document.getElementById('image-preview');
  const rec = openFiles.get(filePath);
  if (rec && rec.isImage) {
    editorContainer.style.display = 'none';
    imgBox.style.display = 'flex';
    imgBox.innerHTML = '';
    const img = document.createElement('img');
    img.src = '/api/raw?path=' + encodeURIComponent(filePath);
    img.alt = filePath;
    imgBox.appendChild(img);
    return;
  }
  if (imgBox) imgBox.style.display = 'none';
  editorContainer.style.display = 'block';
  const lang = langFromPath(filePath);
  editor.setValue(content, lang);
  if (editor.isLargeFileMode && editor.isLargeFileMode()) {
    statusPath.textContent = filePath + '  [large file mode · session backup off]';
  }
  // Restore fold state for this file (setValue clears folds via fresh render).
  const folds = foldStates.get(filePath);
  if (folds && editor.setFoldStates) editor.setFoldStates(folds);
}

function showWelcome() {
  const _sb = document.getElementById('status-bar');
  if (_sb) _sb.style.display = 'none';
  const imgBox = document.getElementById('image-preview');
  if (imgBox) {
    imgBox.style.display = 'none';
    imgBox.innerHTML = '';
  }
  editorContainer.style.display = 'none';
  welcome.style.display = 'flex';
  statusPath.textContent = '';
  if (updateRunButton) updateRunButton();
}

// ── File open ─────────────────────────────────────────────────────────────────

/**
 * Open a file: fetch content if not cached, then activate its tab.
 * @param {string} filePath
 * @param {HTMLElement} treeRow  The clicked tree row (for visual feedback).
 */
async function openFile(filePath, treeRow) {
  // If already open, just switch to it.
  if (openFiles.has(filePath)) {
    activateTab(filePath);
    if (window._closeSidebarIfMobile) window._closeSidebarIfMobile();
    return;
  }

  // Images are served as binary — use the raw endpoint via <img src> instead.
  if (isImagePath(filePath)) {
    openFiles.set(filePath, { content: null, isImage: true, dirty: false, savedContent: null, diskMtime: null, externalChangePending: false });
    activateTab(filePath);
    if (window._closeSidebarIfMobile) window._closeSidebarIfMobile();
    if (treeRow) treeRow.style.opacity = '';
    return;
  }

  if (treeRow) treeRow.style.opacity = '0.5';

  try {
    const res = await fetch('/api/file?path=' + encodeURIComponent(filePath));
    if (!res.ok) {
      let msg = 'Error ' + res.status;
      try {
        const body = await res.json();
        msg = body.error || msg;
      } catch (_) {}
      alert('Cannot open file: ' + msg);
      return;
    }
    const diskMtime = res.headers.get('X-File-Mtime');
    const content = await res.text();
    openFiles.set(filePath, { content, dirty: false, savedContent: content, diskMtime, externalChangePending: false });
    activateTab(filePath);
    if (window._closeSidebarIfMobile) window._closeSidebarIfMobile();
  } catch (e) {
    alert('Network error: ' + e.message);
    console.error(e);
  } finally {
    if (treeRow) treeRow.style.opacity = '';
  }
}

// ── External file-change detection ───────────────────────────────────────────

/**
 * Show the amber change-banner for the given file with pre-fetched disk content.
 * @param {string} filePath
 * @param {string} diskContent
 * @param {string} mtime
 */
function showChangeBanner(filePath, diskContent, mtime) {
  const banner = document.getElementById('change-banner');
  const msg = document.getElementById('change-banner-msg');
  const btnReload = document.getElementById('change-banner-reload');
  const btnDismiss = document.getElementById('change-banner-dismiss');
  if (!banner) return;

  const name = filePath.split('/').pop();
  msg.textContent = '"' + name + '" changed on disk.';
  _bannerPath = filePath;
  banner.classList.add('visible');

  // Clone buttons to drop any previous listeners.
  const newReload = btnReload.cloneNode(true);
  const newDismiss = btnDismiss.cloneNode(true);
  btnReload.replaceWith(newReload);
  btnDismiss.replaceWith(newDismiss);

  newReload.addEventListener('click', () => {
    const file = openFiles.get(filePath);
    if (file) {
      file.content = diskContent;
      file.savedContent = diskContent;
      file.dirty = false;
      file.diskMtime = mtime;
      file.externalChangePending = false;
      if (activeTab === filePath) showContent(filePath, diskContent);
      updateTabDirty(filePath);
    }
    banner.classList.remove('visible');
    _bannerPath = null;
  });

  newDismiss.addEventListener('click', () => {
    const file = openFiles.get(filePath);
    if (file) {
      file.diskMtime = mtime;
      file.externalChangePending = true;
    }
    banner.classList.remove('visible');
    _bannerPath = null;
  });
}

/**
 * Hide the change-banner if it's showing for the given path (or any path).
 * @param {string} [filePath]
 */
function hideChangeBanner(filePath) {
  if (filePath === undefined || _bannerPath === filePath) {
    const banner = document.getElementById('change-banner');
    if (banner) banner.classList.remove('visible');
    _bannerPath = null;
  }
}

/**
 * Show a red banner when the active file has been deleted from disk.
 * @param {string} filePath
 */
function showDeletedBanner(filePath) {
  if (_deletedBannerPath === filePath) return;
  const banner = document.getElementById('deleted-banner');
  const msg = document.getElementById('deleted-banner-msg');
  const btnClose = document.getElementById('deleted-banner-close');
  const btnKeep = document.getElementById('deleted-banner-keep');
  if (!banner) return;

  const name = filePath.split('/').pop();
  msg.textContent = '"' + name + '" was deleted from disk.';
  _deletedBannerPath = filePath;
  banner.classList.add('visible');

  const newClose = btnClose.cloneNode(true);
  const newKeep = btnKeep.cloneNode(true);
  btnClose.replaceWith(newClose);
  btnKeep.replaceWith(newKeep);

  newClose.addEventListener('click', () => {
    banner.classList.remove('visible');
    _deletedBannerPath = null;
    closeTab(filePath);
  });
  newKeep.addEventListener('click', () => {
    banner.classList.remove('visible');
    _deletedBannerPath = null;
  });
}

/**
 * On window focus, check if the active file was modified on disk since we loaded it.
 */
async function checkActiveFileForExternalChange() {
  if (!activeTab || _changeCheckInFlight) return;
  const file = openFiles.get(activeTab);
  if (!file) return;
  _changeCheckInFlight = true;
  try {
    const res = await fetch('/api/file?path=' + encodeURIComponent(activeTab));
    if (res.status === 404) {
      showDeletedBanner(activeTab);
      return;
    }
    if (!res.ok) return;
    const mtime = res.headers.get('X-File-Mtime');
    if (!file.diskMtime) {
      // No baseline (e.g. restored session) — adopt silently.
      file.diskMtime = mtime;
      return;
    }
    if (mtime && mtime !== file.diskMtime) {
      // File changed on disk — only show banner if not already showing for this file.
      if (_bannerPath !== activeTab) {
        const diskContent = await res.text();
        showChangeBanner(activeTab, diskContent, mtime);
      }
    }
  } catch (_) {
    // Network error — ignore silently.
  } finally {
    _changeCheckInFlight = false;
  }
}

// ── Session persistence ───────────────────────────────────────────────────────

/**
 * Persist the current session (open tabs + caret) to the server.
 */
function saveSession() {
  const tabs = [];
  const retainedPaths = new Set();
  const MAX_CLEAN_SESSION_CHARS = 1024 * 1024;
  for (const [path, file] of openFiles) {
    const contentLength = typeof file.content === 'string' ? file.content.length : 0;
    // Large files stay in memory while the app is open but are never copied
    // into session.json; serializing them can freeze the browser main thread.
    if (contentLength > MAX_CLEAN_SESSION_CHARS) continue;
    tabs.push({ path, content: file.content, savedContent: file.savedContent, dirty: file.dirty, isImage: !!file.isImage });
    retainedPaths.add(path);
  }
  const caretPositions = {};
  if (activeTab && retainedPaths.has(activeTab)) {
    const pos = editor.getCaretOffset();
    if (pos) caretPositions[activeTab] = pos;
    // Capture live fold state of the active tab.
    if (editor.getFoldStates) foldStates.set(activeTab, editor.getFoldStates());
  }
  const foldStatesObj = {};
  for (const [p, f] of foldStates) if (retainedPaths.has(p) && f && f.length) foldStatesObj[p] = f;
  const sessionActiveTab = retainedPaths.has(activeTab) ? activeTab : (tabs[0]?.path || null);
  const session = { openTabs: tabs, activeTab: sessionActiveTab, caretPositions, foldStates: foldStatesObj };
  fetch('/api/session', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(session),
  }).catch(err => console.error('session save failed:', err));
}

/**
 * Schedule a saveSession after a 2-second debounce.
 */
function scheduleSaveSession() {
  if (_saveSessionTimer !== null) clearTimeout(_saveSessionTimer);
  _saveSessionTimer = setTimeout(() => {
    _saveSessionTimer = null;
    saveSession();
  }, 2000);
}

/**
 * Load the persisted session from the server and restore open tabs.
 * Returns true if tabs were restored, false if nothing to restore.
 * @returns {Promise<boolean>}
 */
async function loadSession() {
  try {
    const res = await fetch('/api/session');
    const session = await res.json();
    if (!session.openTabs || session.openTabs.length === 0) return false;
    // Rendering/highlighting a multi-megabyte file during startup can block the
    // main thread before basic UI such as Explorer becomes interactive.
    const MAX_AUTO_RESTORE_CHARS = 1024 * 1024;
    for (const tab of session.openTabs) {
      const content = typeof tab.content === 'string' ? tab.content : '';
      const savedContent = typeof tab.savedContent === 'string' ? tab.savedContent : '';
      const dirty = typeof tab.dirty === 'boolean'
        ? tab.dirty
        : normalizeForCompare(content) !== normalizeForCompare(savedContent);
      // Clean oversized files are safe to reopen from disk and are removed
      // from the next saved session. Never drop dirty unsaved content.
      if (!dirty && content.length > MAX_AUTO_RESTORE_CHARS) continue;
      openFiles.set(tab.path, { content, savedContent, dirty, isImage: !!tab.isImage || isImagePath(tab.path), diskMtime: null, externalChangePending: false });
      // Add the tab element to the tab bar (without activating).
      const tabEl = createTab(tab.path);
      tabBar.appendChild(tabEl);
    }
    // Restore per-file fold states before activating (showContent reads foldStates).
    if (session.foldStates) {
      for (const [p, f] of Object.entries(session.foldStates)) foldStates.set(p, f);
    }
    if (openFiles.size === 0) {
      scheduleSaveSession();
      return false;
    }
    const preferred = session.activeTab || openFiles.keys().next().value;
    const preferredFile = openFiles.get(preferred);
    const fallbackTab = Array.from(openFiles.keys())[0];
    const toActivate = preferredFile && preferredFile.content.length <= MAX_AUTO_RESTORE_CHARS
      ? preferred
      : fallbackTab;
    if (!toActivate) {
      showWelcome();
      return true;
    }
    activateTab(toActivate);
    if (session.caretPositions && session.caretPositions[toActivate]) {
      const { anchor, focus } = session.caretPositions[toActivate];
      setTimeout(() => editor.setCaretOffset(anchor, focus), 50);
    }
    // Rewrites oversized sessions into the cleaned .coded format.
    scheduleSaveSession();
    return true;
  } catch (e) {
    return false;
  }
}

// ── Init ─────────────────────────────────────────────────────────────────────

function init() {
  // Initialize the editor in the container div.
  editor = Editor.init(editorContainer);
  window.editor = editor;

  // Cross-file autocomplete: expose other open tabs' contents to the engine.
  window.acExtraText = function() {
    const out = [];
    for (const [path, file] of openFiles) {
      if (path !== activeTab && !file.isImage && typeof file.content === 'string') {
        out.push(file.content);
      }
    }
    return out;
  };

  // Undo/Redo buttons.
  const btnUndo = document.getElementById('btn-undo');
  const btnRedo = document.getElementById('btn-redo');

  function refreshUndoButtons() {
    if (btnUndo) btnUndo.disabled = !editor.canUndo();
    if (btnRedo) btnRedo.disabled = !editor.canRedo();
  }

  if (btnUndo) btnUndo.addEventListener('click', () => { editor.undo(); refreshUndoButtons(); });
  if (btnRedo) btnRedo.addEventListener('click', () => { editor.redo(); refreshUndoButtons(); });

  // Search button → open search modal.
  const btnSearch = document.getElementById('btn-search');
  if (btnSearch) btnSearch.addEventListener('click', () => { if (window.Search) Search.openSearchModal(); });

  // Also refresh after keyboard undo/redo (editor fires onUndoRedoChange).
  editor.onUndoRedoChange = refreshUndoButtons;

  // Wire up dirty-state tracking on every editor change.
  editor.onchange = (text) => {
    if (activeTab) {
      const file = openFiles.get(activeTab);
      if (editor.isLargeFileMode && editor.isLargeFileMode()) {
        // Avoid normalizing and comparing the entire file after every keypress.
        file.content = text;
        if (!file.dirty) {
          file.dirty = true;
          updateTabDirty(activeTab);
        }
      } else {
        updateDirtyState(activeTab, text);
        scheduleSaveSession();
      }
    }
    refreshUndoButtons();
  };

  // Ctrl+S / Cmd+S to save.
  // Ctrl+F: find, Ctrl+H: find+replace, Ctrl+Shift+F: folder search.
  // Ctrl+P: quick open, Ctrl+G: go to line.
  document.addEventListener('keydown', (e) => {
    if (e.key === 's' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      saveCurrentFile();
      return;
    }
    if (e.ctrlKey && !e.metaKey) {
      if (e.shiftKey && e.key === 'F') {
        e.preventDefault();
        if (window.Search) Search.openFolderSearch();
        return;
      }
      if (!e.shiftKey && e.key === 'f') {
        e.preventDefault();
        if (window.Search) Search.openSearchModal();
        return;
      }
      if (!e.shiftKey && e.key === 'h') {
        e.preventDefault();
        if (window.Search) Search.openSearchModal();
        return;
      }
      if (!e.shiftKey && e.key === 'p') {
        e.preventDefault();
        if (window.QuickOpen) QuickOpen.open();
        return;
      }
      if (!e.shiftKey && e.key === 'g') {
        e.preventDefault();
        if (window.QuickOpen) QuickOpen.openGoToLine();
        return;
      }
    }
    // Explorer Cut/Copy/Paste — only when not in editor or input field.
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey &&
        !e.target.closest('#editor-container, input, textarea, [contenteditable]')) {
      const s = _selectedRow();
      if (e.key === 'c' && s) { e.preventDefault(); copyEntry(s.path, s.isDir); }
      else if (e.key === 'x' && s) { e.preventDefault(); cutEntry(s.path, s.isDir); }
      else if (e.key === 'v' && clipboard) { e.preventDefault(); pasteEntry(_pasteTargetDir()); }
    }
  });

  // Sidebar drawer: toggle, close button, backdrop tap.
  const btnSidebar = document.getElementById('btn-sidebar-toggle');
  const sidebar = document.getElementById('sidebar');
  const backdrop = document.getElementById('sidebar-backdrop');
  const btnSidebarClose = document.getElementById('btn-sidebar-close');
  const btnSelectionToggle = document.getElementById('btn-selection-toggle');
  const btnSelectAll = document.getElementById('btn-select-all');
  const btnDeleteSelected = document.getElementById('btn-delete-selected');
  const btnCopySelected = document.getElementById('btn-copy-selected');
  const btnMoveSelected = document.getElementById('btn-move-selected');
  const btnClipboardCancel = document.getElementById('btn-clipboard-cancel');

  function openSidebar() {
    sidebar.classList.remove('hidden');
    backdrop.classList.remove('hidden');
    // Open immediately; refresh only after the drawer has painted.
    setTimeout(syncExplorerOnce, 220);
  }
  function closeSidebar() {
    sidebar.classList.add('hidden');
    backdrop.classList.add('hidden');
  }

  if (btnSidebar) btnSidebar.addEventListener('click', () => {
    sidebar.classList.contains('hidden') ? openSidebar() : closeSidebar();
  });
  if (btnSidebarClose) btnSidebarClose.addEventListener('click', closeSidebar);
  if (backdrop) backdrop.addEventListener('click', closeSidebar);
  if (btnSelectionToggle) btnSelectionToggle.addEventListener('click', () => setSelectionMode(!selectionMode));
  if (btnSelectAll) btnSelectAll.addEventListener('click', () => {
    const rows = Array.from(fileTree.querySelectorAll('.tree-item'));
    const allSelected = rows.length > 0 && rows.every(row => selectedItems.has(row.dataset.path));
    rows.forEach(row => {
      const path = row.dataset.path;
      if (allSelected) {
        selectedItems.delete(path);
        row.classList.remove('multi-selected');
      } else {
        selectedItems.set(path, row.dataset.isdir === '1');
        row.classList.add('multi-selected');
      }
    });
    updateSelectionUI();
  });
  if (btnDeleteSelected) btnDeleteSelected.addEventListener('click', deleteSelectedItems);
  if (btnCopySelected) btnCopySelected.addEventListener('click', () => stageSelectedItems('copy'));
  if (btnMoveSelected) btnMoveSelected.addEventListener('click', () => stageSelectedItems('cut'));
  if (btnClipboardCancel) btnClipboardCancel.addEventListener('click', () => {
    clipboard = null;
    updateClipboardUI();
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && !sidebar.classList.contains('hidden')) syncExplorerOnce();
  });

  // Swipe-from-left-edge to open sidebar.
  (function() {
    const EDGE_ZONE = 24; // px from left edge that starts a swipe
    const MIN_SWIPE = 60; // minimum horizontal distance to trigger open
    let _swipeStartX = null;
    let _swipeStartY = null;
    let _swipeTracking = false;
    document.addEventListener('touchstart', (e) => {
      if (!sidebar.classList.contains('hidden')) return;
      const t = e.touches[0];
      if (t.clientX <= EDGE_ZONE) {
        _swipeStartX = t.clientX;
        _swipeStartY = t.clientY;
        _swipeTracking = true;
      }
    }, { passive: true });
    document.addEventListener('touchmove', (e) => {
      if (!_swipeTracking) return;
      const t = e.touches[0];
      const dx = t.clientX - _swipeStartX;
      const dy = Math.abs(t.clientY - _swipeStartY);
      // Cancel if mostly vertical
      if (dy > dx) { _swipeTracking = false; return; }
      if (dx >= MIN_SWIPE) {
        _swipeTracking = false;
        openSidebar();
      }
    }, { passive: true });
    document.addEventListener('touchend', () => { _swipeTracking = false; }, { passive: true });
  })();

  // Helpers for keyboard shortcuts and paste target resolution.
  function _selectedRow() {
    const el = fileTree.querySelector('.tree-item.selected');
    return el ? { path: el.dataset.path, isDir: el.dataset.isdir === '1' } : null;
  }
  function _pasteTargetDir() {
    const s = _selectedRow();
    if (!s) return '';
    return s.isDir ? s.path : (s.path.includes('/') ? s.path.slice(0, s.path.lastIndexOf('/')) : '');
  }

  // Right-click / long-press on empty tree space → create at root.
  fileTree.addEventListener('contextmenu', (e) => {
    if (e.target.closest('.tree-item')) return; // handled by row
    e.preventDefault();
    showRootContextMenu(e.clientX, e.clientY);
  });
  let _bgLpTimer = null;
  fileTree.addEventListener('touchstart', (e) => {
    if (e.target.closest('.tree-item')) return;
    _bgLpTimer = setTimeout(() => {
      _bgLpTimer = null;
      const t = e.touches[0];
      showRootContextMenu(t.clientX, t.clientY);
    }, 500);
  }, { passive: true });
  fileTree.addEventListener('touchmove',  () => { clearTimeout(_bgLpTimer); _bgLpTimer = null; }, { passive: true });
  fileTree.addEventListener('touchend',   () => { clearTimeout(_bgLpTimer); _bgLpTimer = null; }, { passive: true });

  // Close sidebar after opening a file (always — user clicked a file, they want to see it).
  window._closeSidebarIfMobile = () => { closeSidebar(); };

  // Persist folds whenever the user toggles one via gutter/pill.
  editor.onfoldchange = () => {
    if (activeTab && editor.getFoldStates) {
      foldStates.set(activeTab, editor.getFoldStates());
      scheduleSaveSession();
    }
  };


  // Save button (phones have no Ctrl+S).
  const btnSave = document.getElementById('btn-save');
  if (btnSave) {
    btnSave.addEventListener('click', () => saveCurrentFile());
  }

  // Run button — only visible for HTML files.
  const btnRun = document.getElementById('btn-run');
  if (btnRun) {
    btnRun.addEventListener('click', async () => {
      if (!activeTab) return;
      // Auto-save so the on-disk file matches the editor before previewing.
      await saveCurrentFile();

      // Markdown: render to styled HTML and open in a new tab.
      if (isMdPath(activeTab)) {
        if (!window.marked) { alert('Markdown renderer not loaded.'); return; }
        const file = openFiles.get(activeTab);
        const src = (editor && file && !file.isImage) ? editor.getValue() : (file && file.content) || '';
        const rendered = new DOMParser().parseFromString(marked.parse(src), 'text/html');
        const headingIds = new Map();
        rendered.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach(heading => {
          const baseId = heading.textContent.trim().toLowerCase()
            .replace(/[^\p{L}\p{N}\s-]/gu, '')
            .replace(/\s+/g, '-')
            .replace(/-+/g, '-');
          const count = headingIds.get(baseId) || 0;
          headingIds.set(baseId, count + 1);
          heading.id = count ? `${baseId}-${count}` : baseId;
        });
        const body = rendered.body.innerHTML;
        // A blob document cannot reliably resolve a root-relative <base> URL.
        // Use an absolute preview-server URL so images and links resolve from
        // the Markdown file's directory instead of from the blob URL.
        const dir = activeTab.includes('/') ? activeTab.slice(0, activeTab.lastIndexOf('/') + 1) : '';
        const previewDir = '/preview/' + dir.split('/').map(encodeURIComponent).join('/');
        const baseHref = new URL(previewDir, window.location.href).href;
        const doc = '<!DOCTYPE html><html><head><meta charset="utf-8">' +
          '<meta name="viewport" content="width=device-width, initial-scale=1.0">' +
          '<title>' + activeTab.split('/').pop() + '</title>' +
          '<base href="' + baseHref + '">' +
          '<style>' +
          'body{max-width:860px;margin:0 auto;padding:24px 20px;background:#1e1e1e;color:#d4d4d4;' +
          'font:16px/1.7 -apple-system,"Segoe UI",Roboto,sans-serif;}' +
          'h1,h2,h3,h4{color:#fff;line-height:1.3;margin:1.4em 0 0.5em;}' +
          'h1{border-bottom:1px solid #3c3c3c;padding-bottom:8px;}' +
          'h2{border-bottom:1px solid #2d2d2d;padding-bottom:6px;}' +
          'a{color:#4fc1ff;text-decoration:none;} a:hover{text-decoration:underline;}' +
          'code{background:#2d2d2d;padding:2px 6px;border-radius:3px;font-family:"Fira Code","Consolas",monospace;font-size:0.9em;}' +
          'pre{background:#252526;border:1px solid #3c3c3c;border-radius:4px;padding:14px;overflow-x:auto;}' +
          'pre code{background:none;padding:0;}' +
          'blockquote{border-left:3px solid #4fc1ff;margin:1em 0;padding:2px 16px;color:#9da5b0;}' +
          'table{border-collapse:collapse;width:100%;margin:1em 0;}' +
          'th,td{border:1px solid #3c3c3c;padding:8px 12px;text-align:left;}' +
          'th{background:#252526;} tr:nth-child(even){background:#232323;}' +
          'img{max-width:100%;} hr{border:none;border-top:1px solid #3c3c3c;margin:2em 0;}' +
          'ul,ol{padding-left:24px;}' +
          '</style></head><body>' + body +
          '<script>document.addEventListener("click",function(e){' +
          'var a=e.target.closest("a[href^=\\\"#\\\"]");if(!a)return;' +
          'var target=document.getElementById(decodeURIComponent(a.getAttribute("href").slice(1)));' +
          'if(target){e.preventDefault();target.scrollIntoView({behavior:"smooth"});}});<\/script>' +
          '</body></html>';
        const blob = new Blob([doc], { type: 'text/html' });
        window.open(URL.createObjectURL(blob), '_blank');
        return;
      }

      // HTML: open via the live static server — relative imports (CSS, JS,
      // images) resolve naturally at any depth without any URL rewriting.
      const url = '/preview/' + activeTab.split('/').map(encodeURIComponent).join('/');
      window.open(url, '_blank');
    });
  }
  updateRunButton = function() {
    if (!btnRun) return;
    btnRun.style.display = (activeTab && (isHtmlPath(activeTab) || isMdPath(activeTab))) ? '' : 'none';
  };

  // ── Settings modal ──────────────────────────────────────────────────────────
  const settingsOverlay = document.getElementById('settings-overlay');
  const btnSettings = document.getElementById('btn-settings');

  function openSettings() {
    if (settingsOverlay) settingsOverlay.style.display = 'flex';
    const vBadge = document.getElementById('settings-version');
    if (vBadge) {
      const v = _updateInfo && _updateInfo.current ? _updateInfo.current : null;
      vBadge.textContent = v ? 'v' + v : '—';
    }
  }

  const btnCheckUpdate = document.getElementById('btn-check-update');
  const updateStatus = document.getElementById('settings-update-status');
  if (btnCheckUpdate) {
    btnCheckUpdate.addEventListener('click', async () => {
      btnCheckUpdate.disabled = true;
      btnCheckUpdate.textContent = 'Checking\u2026';
      if (updateStatus) { updateStatus.hidden = false; updateStatus.textContent = ''; }
      try {
        // Reset cache so we hit the network fresh.
        await fetch('/api/update/refresh', { method: 'POST' });
        const res = await fetch('/api/update' + _devPkg);
        if (!res.ok) throw new Error('server error');
        const info = await res.json();
        _updateInfo = info;
        if (info.available) {
          if (updateStatus) updateStatus.hidden = true;
          closeSettings();
          showUpdateBanner(info);
        } else {
          if (updateStatus) updateStatus.textContent = 'You\u2019re up to date' + (info.current ? ' (v' + info.current + ')' : '') + '.';
        }
      } catch (_) {
        if (updateStatus) updateStatus.textContent = 'Check failed. Are you online?';
      } finally {
        btnCheckUpdate.disabled = false;
        btnCheckUpdate.textContent = 'Check for updates';
      }
    });
  }
  function closeSettings() { if (settingsOverlay) settingsOverlay.style.display = 'none'; }

  if (btnSettings) btnSettings.addEventListener('click', openSettings);
  if (settingsOverlay) {
    settingsOverlay.addEventListener('mousedown', (e) => { if (e.target === settingsOverlay) closeSettings(); });
    settingsOverlay.addEventListener('touchend', (e) => { if (e.target === settingsOverlay) closeSettings(); });
  }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSettings(); });

  // Font size controls.
  const FONT_MIN = 8, FONT_MAX = 24, FONT_DEFAULT = 12;
  const fontSizeValue = document.getElementById('font-size-value');
  function applyFontSize(px) {
    px = Math.max(FONT_MIN, Math.min(FONT_MAX, px));
    document.documentElement.style.setProperty('--editor-font-size', px + 'px');
    if (fontSizeValue) fontSizeValue.textContent = px + 'px';
    try { localStorage.setItem('editorFontSize', String(px)); } catch (e) { /* private mode */ }
    if (typeof editor !== 'undefined') editor.refreshGutter();
    return px;
  }
  let fontSize = FONT_DEFAULT;
  try {
    const stored = parseInt(localStorage.getItem('editorFontSize'), 10);
    if (!isNaN(stored)) fontSize = stored;
  } catch (e) { /* private mode */ }
  fontSize = applyFontSize(fontSize);
  const btnFontDec = document.getElementById('btn-font-dec');
  const btnFontInc = document.getElementById('btn-font-inc');
  if (btnFontDec) btnFontDec.addEventListener('click', () => { fontSize = applyFontSize(fontSize - 1); });
  if (btnFontInc) btnFontInc.addEventListener('click', () => { fontSize = applyFontSize(fontSize + 1); });

  // Line height controls.
  const LH_MIN = 1.0, LH_MAX = 2.4, LH_STEP = 0.1, LH_DEFAULT = 1.6;
  const lineHeightValue = document.getElementById('line-height-value');
  function applyLineHeight(v) {
    v = Math.round(Math.max(LH_MIN, Math.min(LH_MAX, v)) * 10) / 10;
    document.documentElement.style.setProperty('--editor-line-height', String(v));
    if (lineHeightValue) lineHeightValue.textContent = v.toFixed(1);
    try { localStorage.setItem('editorLineHeight', String(v)); } catch (e) { /* private mode */ }
    if (typeof editor !== 'undefined') editor.refreshGutter();
    return v;
  }
  let lineHeight = LH_DEFAULT;
  try {
    const stored = parseFloat(localStorage.getItem('editorLineHeight'));
    if (!isNaN(stored)) lineHeight = stored;
  } catch (e) { /* private mode */ }
  lineHeight = applyLineHeight(lineHeight);
  const btnLhDec = document.getElementById('btn-lh-dec');
  const btnLhInc = document.getElementById('btn-lh-inc');
  if (btnLhDec) btnLhDec.addEventListener('click', () => { lineHeight = applyLineHeight(lineHeight - LH_STEP); });
  if (btnLhInc) btnLhInc.addEventListener('click', () => { lineHeight = applyLineHeight(lineHeight + LH_STEP); });

  // ── Theme selector ───────────────────────────────────────────────────────
  const THEME_DEFAULT = 'monokai';
  const VALID_THEMES = ['monokai', 'pastel-on-dark', 'dracula', 'one-dark', 'catppuccin-mocha', 'catppuccin-macchiato', 'catppuccin-frappe', 'catppuccin-latte'];
  const themeSelect = document.getElementById('theme-select');
  function applyTheme(name) {
    if (!VALID_THEMES.includes(name)) name = THEME_DEFAULT;
    document.documentElement.setAttribute('data-theme', name);
    if (themeSelect) themeSelect.value = name;
    try { localStorage.setItem('editorTheme', name); } catch (e) { /* private mode */ }
    return name;
  }
  let theme = THEME_DEFAULT;
  try {
    const stored = localStorage.getItem('editorTheme');
    if (stored) theme = stored;
  } catch (e) { /* private mode */ }
  applyTheme(theme);
  if (themeSelect) themeSelect.addEventListener('change', () => applyTheme(themeSelect.value));

  // ── Editor font selector ────────────────────────────────────────────────────
  const FONT_STACKS = {
    'fira-code':       "'Fira Code V', 'Consolas', 'Menlo', monospace",
    'jetbrains-mono':  "'JetBrains Mono V', 'Consolas', 'Menlo', monospace",
    'cascadia-code':   "'Cascadia Code V', 'Consolas', 'Menlo', monospace",
    'geist-mono':      "'Geist Mono', 'Consolas', 'Menlo', monospace",
    'source-code-pro': "'Source Code Pro V', 'Consolas', 'Menlo', monospace",
    'ibm-plex-mono':   "'IBM Plex Mono V', 'Consolas', 'Menlo', monospace",
  };
  const fontSelect = document.getElementById('font-select');
  function applyFont(name) {
    if (!FONT_STACKS[name]) name = 'fira-code';
    document.documentElement.style.setProperty('--editor-font', FONT_STACKS[name]);
    if (fontSelect) fontSelect.value = name;
    try { localStorage.setItem('editorFont', name); } catch (e) { /* private mode */ }
    if (editor && editor.refreshGutter) editor.refreshGutter();
    return name;
  }
  let fontChoice = 'fira-code';
  try {
    const storedFont = localStorage.getItem('editorFont');
    if (storedFont) fontChoice = storedFont;
  } catch (e) { /* private mode */ }
  applyFont(fontChoice);
  if (fontSelect) fontSelect.addEventListener('change', () => applyFont(fontSelect.value));

  // ── Server connection indicator ───────────────────────────────────────────
  const statusConn = document.getElementById('status-conn');
  let _serverOnline = true;

  const statusBar = document.getElementById('status-bar');
  const offlineOverlay = document.getElementById('offline-overlay');
  const offlineDismiss = document.getElementById('offline-dismiss');
  let _offlineDismissed = false;

  if (offlineDismiss) offlineDismiss.addEventListener('click', () => {
    _offlineDismissed = true;
    if (offlineOverlay) offlineOverlay.style.display = 'none';
  });

  function setConnState(online) {
    if (online === _serverOnline && statusConn.textContent !== '') return;
    _serverOnline = online;
    if (statusBar) statusBar.classList.toggle('offline', !online);
    if (statusConn) statusConn.textContent = '⚠ Server disconnected — edits will not save';
    const btnSave = document.getElementById('btn-save');
    if (btnSave) btnSave.disabled = !online;
    if (offlineOverlay) {
      if (!online && !_offlineDismissed) {
        offlineOverlay.style.display = 'flex';
      } else if (online) {
        offlineOverlay.style.display = 'none';
        _offlineDismissed = false; // reset so modal shows again on next disconnect
      }
    }
  }

  async function pingServer() {
    try {
      const r = await fetch('/api/files?path=', { method: 'HEAD', cache: 'no-store' });
      setConnState(r.ok || r.status === 405); // 405 = method not allowed but server alive
    } catch (_) {
      setConnState(false);
    }
  }

  pingServer();
  setInterval(pingServer, 5000);

  // Focus-based external file-change detection.
  window.addEventListener('focus', checkActiveFileForExternalChange);

  // ── Show hidden files toggle ─────────────────────────────────────────────
  const btnHiddenToggle = document.getElementById('btn-hidden-toggle');
  try {
    if (localStorage.getItem('showHiddenFiles') === '1') showHidden = true;
  } catch (_) { /* private mode */ }
  if (btnHiddenToggle) {
    function updateHiddenToggle() {
      const label = showHidden ? 'Hide hidden files' : 'Show hidden files';
      btnHiddenToggle.classList.toggle('active', showHidden);
      btnHiddenToggle.setAttribute('aria-checked', String(showHidden));
      btnHiddenToggle.setAttribute('aria-label', label);
      btnHiddenToggle.title = label;
    }
    updateHiddenToggle();
    btnHiddenToggle.addEventListener('click', () => {
      showHidden = !showHidden;
      updateHiddenToggle();
      try { localStorage.setItem('showHiddenFiles', showHidden ? '1' : '0'); } catch (_) { /* private mode */ }
      if (window.QuickOpen) window.QuickOpen.invalidateCache();
      loadRootTree();
    });
  }
  // Expose for quickopen.js to read.
  window.getShowHidden = () => showHidden;

  loadRootTree();

  // Restore previous session; fall back to welcome screen.
  loadSession().then(restored => {
    if (!restored) showWelcome();
  });

  checkForUpdate();
}

/**
 * Ask the server whether a newer release is available and show a banner if so.
 */
let _updateInfo = null;

const _devPkg = location.search.includes('pkg=1') ? '?pkg=1' : '';

async function checkForUpdate() {
  try {
    const res = await fetch('/api/update' + _devPkg);
    if (!res.ok) return;
    const info = await res.json();
    _updateInfo = info;
    if (info && info.available) showUpdateBanner(info);
  } catch (err) {
    // Offline or server not ready — silently ignore.
  }
}

function fmtMB(bytes) {
  return (bytes / 1048576).toFixed(1) + ' MB';
}

function waitForServer(onGiveUp, attempt, onSuccess) {
  if (attempt === undefined) attempt = 0;
  setTimeout(() => {
    fetch('/', { cache: 'no-store' })
      .then(() => {
        if (onSuccess) onSuccess();
        setTimeout(() => location.reload(), 350);
      })
      .catch(() => {
        if (attempt === 11 && onGiveUp) onGiveUp();
        waitForServer(onGiveUp, attempt + 1, onSuccess);
      });
  }, 700);
}

/**
 * Show the update-available banner with Update now / Skip / Remind later.
 * For non-pkg installs, Update now triggers a live SSE download with progress bar.
 * @param {{current:string, latest:string, viaPkg:boolean}} info
 */
function showUpdateBanner(info) {
  const banner = document.getElementById('update-banner');
  const msg = document.getElementById('update-banner-msg');
  const btnNow = document.getElementById('update-banner-now');
  const btnSkip = document.getElementById('update-banner-skip');
  const btnLater = document.getElementById('update-banner-later');
  if (!banner) return;

  msg.textContent = 'coded ' + info.latest + ' is available (you have ' + info.current + ').';
  banner.classList.add('visible');

  // Clone buttons to drop any previous listeners.
  const newNow = btnNow.cloneNode(true);
  const newSkip = btnSkip.cloneNode(true);
  const newLater = btnLater.cloneNode(true);
  btnNow.replaceWith(newNow);
  btnSkip.replaceWith(newSkip);
  btnLater.replaceWith(newLater);

  newNow.addEventListener('click', () => {
    if (info.viaPkg) {
      // Stream pkg upgrade output into the log box.
      [newNow, newSkip, newLater].forEach(b => { b.style.display = 'none'; });
      const logBox = document.getElementById('update-log');
      if (logBox) { logBox.hidden = false; logBox.textContent = ''; }
      msg.textContent = 'Upgrading via pkg\u2026';

      const es = new EventSource('/api/update/install' + _devPkg);
      es.addEventListener('log', e => {
        try {
          const line = JSON.parse(e.data);
          if (logBox) { logBox.textContent += line + '\n'; logBox.scrollTop = logBox.scrollHeight; }
        } catch (_) {}
      });
      es.addEventListener('done', () => {
        es.close();
        if (logBox) logBox.hidden = true;
        msg.textContent = 'Update installed! Restart to apply.';
        newNow.textContent = 'Restart now';
        newNow.style.display = '';
        newLater.textContent = 'Later';
        newLater.style.display = '';
        newNow.onclick = () => {
          fetch('/api/update/restart', { method: 'POST' }).catch(() => {});
          newNow.style.display = 'none'; newLater.style.display = 'none';
          if (logBox) { logBox.hidden = false; logBox.textContent = 'Restarting\u2026'; }
          msg.textContent = 'Restarting\u2026 this page will reload automatically.';
          waitForServer(() => {
            msg.textContent = 'If this page didn\u2019t reload, re-run coded in your terminal and refresh.';
          }, undefined, () => {
            if (logBox) { logBox.textContent += '\nDone! Reloading\u2026'; logBox.scrollTop = logBox.scrollHeight; }
          });
        };
        newLater.onclick = () => { banner.classList.remove('visible'); };
      });
      es.addEventListener('error', e => {
        es.close();
        if (logBox) logBox.hidden = true;
        let errMsg = 'pkg upgrade failed.';
        try { const d = JSON.parse(e.data); if (d && d.message) errMsg = d.message; } catch (_) {}
        msg.textContent = errMsg + ' Try `pkg upgrade coded` in your terminal.';
        [newNow, newSkip, newLater].forEach(b => { b.style.display = ''; });
      });
      return;
    }

    // Hide action buttons, show progress bar.
    [newNow, newSkip, newLater].forEach(b => { b.style.display = 'none'; });
    const progress = document.getElementById('update-progress');
    const fill = document.getElementById('update-progress-fill');
    const ptext = document.getElementById('update-progress-text');
    if (progress) progress.hidden = false;
    msg.textContent = 'Downloading coded ' + info.latest + '\u2026';

    const es = new EventSource('/api/update/install');

    es.addEventListener('message', e => {
      try {
        const d = JSON.parse(e.data);
        const pct = d.total > 0 ? Math.round(d.downloaded / d.total * 100) : 0;
        if (fill) fill.style.width = pct + '%';
        if (ptext) ptext.textContent = pct + '%  ' + fmtMB(d.downloaded) + ' / ' + fmtMB(d.total);
      } catch (_) {}
    });

    es.addEventListener('done', () => {
      es.close();
      if (progress) progress.hidden = true;
      msg.textContent = 'Update installed! Restart coded to apply.';
      newNow.textContent = 'Restart now';
      newNow.style.display = '';
      newLater.textContent = 'Later';
      newLater.style.display = '';
      newNow.onclick = () => {
        // Fire restart immediately — don't wait for animation.
        fetch('/api/update/restart', { method: 'POST' }).catch(() => {});
        newNow.style.display = 'none';
        newLater.style.display = 'none';

        // Show restart progress animation.
        if (progress) progress.hidden = false;
        if (fill) { fill.style.transition = 'none'; fill.style.width = '0%'; }

        const steps = [
          'Stopping server\u2026',
          'Loading new binary\u2026',
          'Starting coded ' + info.latest + '\u2026',
          'Almost there\u2026',
          'Connecting\u2026',
        ];
        let stepIdx = 0;
        msg.textContent = steps[0];
        if (ptext) ptext.textContent = '';

        // Animate fill from 0 → 90% over ~8s (CSS transition handles smoothness).
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            if (fill) { fill.style.transition = 'width 8s cubic-bezier(0.1, 0.5, 0.5, 1)'; fill.style.width = '90%'; }
          });
        });

        // Cycle status messages every ~1.6s.
        const msgTimer = setInterval(() => {
          stepIdx = Math.min(stepIdx + 1, steps.length - 1);
          msg.textContent = steps[stepIdx];
        }, 1600);

        // Poll for server; on success flash to 100% and reload.
        waitForServer(() => {
          clearInterval(msgTimer);
          msg.textContent = 'Reload if the page doesn\u2019t refresh automatically.';
          const reloadBtn = document.createElement('button');
          reloadBtn.textContent = 'Reload';
          reloadBtn.className = newNow.className;
          newLater.after(reloadBtn);
          reloadBtn.onclick = () => location.reload();
        }, undefined, () => {
          clearInterval(msgTimer);
          if (fill) { fill.style.transition = 'width 0.3s ease'; fill.style.width = '100%'; }
          msg.textContent = 'Reloading\u2026';
        });
      };
      newLater.onclick = () => { banner.classList.remove('visible'); };
    });

    es.addEventListener('error', e => {
      es.close();
      if (progress) progress.hidden = true;
      let errMsg = 'Update failed.';
      try {
        const d = JSON.parse(e.data);
        if (d && d.message) errMsg = 'Update failed: ' + d.message;
      } catch (_) {}
      msg.textContent = errMsg + ' Try `coded update` in your terminal.';
      [newNow, newSkip, newLater].forEach(b => { b.style.display = ''; });
    });
  });

  newSkip.addEventListener('click', () => {
    fetch('/api/update/skip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: info.latest }),
    }).catch(() => {});
    banner.classList.remove('visible');
  });

  newLater.addEventListener('click', () => {
    banner.classList.remove('visible');
  });
}

document.addEventListener('DOMContentLoaded', init);

// Expose openFile globally so search.js can open files from results.
window.openFile = openFile;
