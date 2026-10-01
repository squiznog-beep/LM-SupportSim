'use strict';
// ===========================================================================
// Support Sim builder: the page. Steps chain on the left, preview and step
// editor in the middle, live event code on the right.
// ===========================================================================
const $ = id => document.getElementById(id);
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function el(tag, props, ...kids) {
  const e = document.createElement(tag);
  if (props) for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k === 'value') e.value = v;
    else if (k === 'checked') e.checked = !!v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return e;
}
// Scrolls only the panel the element lives in, never the page (on phones the
// page itself scrolls, and yanking it around while a scene plays is awful).
function keepVisible(elm) {
  if (!elm) return;
  let c = elm.parentElement;
  while (c && c !== document.body) {
    const oy = getComputedStyle(c).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && c.scrollHeight > c.clientHeight + 2) break;
    c = c.parentElement;
  }
  if (!c || c === document.body) return;
  const r = elm.getBoundingClientRect(), cr = c.getBoundingClientRect();
  if (r.top < cr.top) c.scrollTop -= cr.top - r.top + 8;
  else if (r.bottom > cr.bottom) c.scrollTop += r.bottom - cr.bottom + 8;
}
const isPhone = () => matchMedia('(max-width: 760px)').matches;
function setTab(name) {
  document.body.dataset.mtab = name;
  document.querySelectorAll('.mtabs [data-tab]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  try { localStorage.setItem('supportSim.tab', name); } catch (e) { /* ignore */ }
}
let toastTimer = null;
function toast(msg) { const t = $('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 2800); }
async function copyText(text, what) {
  try { await navigator.clipboard.writeText(text); toast(`Copied ${what}`); return; } catch (e) { /* fall through */ }
  const ta = el('textarea', { style: 'position:fixed;left:-9999px' }); ta.value = text; document.body.append(ta); ta.select();
  let ok = false; try { ok = document.execCommand('copy'); } catch (e) { /* ignore */ }
  ta.remove();
  toast(ok ? `Copied ${what}` : 'Copy was blocked here. Use Edit code, select all and press Ctrl+C.');
}

// ---------------------------------------------------------------------------
// State, undo/redo, draft
// ---------------------------------------------------------------------------
let doc = { name: '', steps: [], words: [], whisper: 'grey' };
let sel = 0;
let gen = { code: '', ranges: [], lineStep: [] };
let problems = [], problemsByStep = new Map();
let mode = 'still';            // still | play | ended
let codeEditing = false, editLineMap = [];
let needsStill = true;

// Saved conversations (in this browser). Each is stored under its event name,
// so the same embed on several Notion pages can hold several conversations.
const LIB_KEY = 'supportSim.library.v2';
let lib = { current: null, items: {} };
let currentKey = null;
let draftTimer = null;
function readLib() { try { const t = localStorage.getItem(LIB_KEY); if (t) lib = JSON.parse(t); } catch (e) { /* storage blocked */ } lib.items = lib.items || {}; }
function writeLib() { try { localStorage.setItem(LIB_KEY, JSON.stringify(lib)); } catch (e) { /* storage blocked: fine */ } }
function keyFor(name) { return (name || '').trim() || 'Untitled'; }
function saveDraftNow() {
  let key = keyFor(doc.name);
  if (currentKey && key !== currentKey) {
    // renamed: move the entry; never overwrite a different saved conversation
    if (lib.items[key]) { let n = 2; while (lib.items[key + '_' + n]) n++; key = key + '_' + n; }
    delete lib.items[currentKey];
  }
  currentKey = key;
  lib.items[key] = { snap: snap(), updated: Date.now() };
  lib.current = key;
  writeLib();
  renderConvSel();
}
function saveDraftSoon() { clearTimeout(draftTimer); draftTimer = setTimeout(saveDraftNow, 300); }
function renderConvSel() {
  const s = $('convSel'); if (!s) return;
  const names = Object.keys(lib.items).sort((a, b) => (lib.items[b].updated || 0) - (lib.items[a].updated || 0));
  s.innerHTML = '';
  s.append(el('option', { value: '' }, `Saved conversations (${names.length})`));
  for (const n of names) s.append(el('option', { value: n }, (n === currentKey ? '● ' : '') + n));
  s.value = '';
}
function openConversation(key) {
  const item = lib.items[key]; if (!item) return;
  clearTimeout(draftTimer); saveDraftNow();
  loadSnap(item.snap); currentKey = key; lib.current = key; writeLib();
  hist.past = []; hist.future = [];
  refresh(); toast('Opened ' + key);
}
function snap() { return JSON.stringify({ name: doc.name, steps: doc.steps, words: doc.words, whisper: doc.whisper, preview: doc.preview || {}, sel }); }
function loadSnap(t) {
  const o = JSON.parse(t);
  doc = { name: o.name || '', steps: (o.steps || []).map(s => ({ ...s, id: newId() })), words: o.words || [], whisper: o.whisper || 'grey', preview: o.preview || {} };
  sel = o.sel || 0;
}
const hist = { past: [], future: [], key: null, time: 0 };
function change(fn, opts) {
  opts = opts || {};
  const now = Date.now();
  if (!(opts.key && opts.key === hist.key && now - hist.time < 1500)) {
    hist.past.push(snap()); if (hist.past.length > 300) hist.past.shift();
  }
  hist.future = []; hist.key = opts.key || null; hist.time = now;
  fn();
  refresh(opts);
}
function undo() { if (!hist.past.length) return; hist.future.push(snap()); loadSnap(hist.past.pop()); hist.key = null; refresh(); toast('Undone'); }
function redo() { if (!hist.future.length) return; hist.past.push(snap()); loadSnap(hist.future.pop()); hist.key = null; refresh(); toast('Redone'); }

// ---------------------------------------------------------------------------
// Assets: thumbnails
// ---------------------------------------------------------------------------
const thumbCache = new Map();
function portraitAsset(nid) { return portraitFor(nid); }
function faceURL(nid, expr, full) {
  const key = 'f|' + nid + '|' + (expr || []).join(',') + '|' + (full ? 1 : 0);
  if (thumbCache.has(key)) return thumbCache.get(key);
  const a = portraitAsset(nid); if (!a) return null;
  const buf = document.createElement('canvas');
  composeFace(buf, a, nid, new Set(expr || []), -1, 0);
  let url;
  if (full) url = buf.toDataURL();
  else { const c = document.createElement('canvas'); c.width = 48; c.height = 48; c.getContext('2d').drawImage(buf, 24, 8, 48, 48, 0, 0, 48, 48); url = c.toDataURL(); }
  thumbCache.set(key, url); return url;
}
function bgURL(nid, w) {
  w = w || 60;
  const key = 'b|' + nid + '|' + w; if (thumbCache.has(key)) return thumbCache.get(key);
  const k = ciFind(A.backgrounds, nid); if (!k) return null;
  const c = document.createElement('canvas'); c.width = w; c.height = Math.round(w * 2 / 3);
  const g = c.getContext('2d'); g.imageSmoothingEnabled = w < 120; g.drawImage(A.backgrounds[k], 0, 0, c.width, c.height);
  const url = c.toDataURL(); thumbCache.set(key, url); return url;
}
function paletteCss(color) {
  const f = A.fonts.convo; const p = (f && f.palettes && f.palettes[color]) || EXTRA_PALETTES[color];
  return p ? `rgb(${p[0].join(',')})` : null;
}
function lightColor(color) { const f = A.fonts.convo; const p = (f && f.palettes && f.palettes[color]) || EXTRA_PALETTES[color]; if (!p) return false; const [r, g, b] = p[0]; return (0.299 * r + 0.587 * g + 0.114 * b) > 170; }
function colorNames() {
  const f = A.fonts.convo; const names = f ? Object.keys(f.palettes || {}) : [];
  for (const k of Object.keys(EXTRA_PALETTES)) if (!names.includes(k)) names.push(k);
  return names;
}
function fontHasColor(color) { const f = A.fonts.convo; return !!(f && f.palettes && f.palettes[color]); }
const posLabel = p => (POSITIONS.find(x => x[0] === p) || [p, p])[1];

// ---------------------------------------------------------------------------
// Rendering helpers: step summaries
// ---------------------------------------------------------------------------
const ICONS = { line: '“', enter: '→', enterMany: '⇉', leave: '←', leaveMany: '⇇', move: '↔', expr: '☺', bop: '↥', mirror: '⇄',
  bg: '▦', transition: '◐', card: '⌖', shake: '≋', wait: '⏸', music: '♪', musicOff: '♪', sound: '◎', note: '✎', raw: '{}', end: '■',
  choice: '☰', if: '⑂', elif: '⑂', else: '⑂', join: '⤙' };
const HOW_ENTER = [['fade', 'Fade in'], ['slideL', 'Slide in from left'], ['slideR', 'Slide in from right'], ['walkL', 'Walk in from left edge'], ['walkR', 'Walk in from right edge'], ['instant', 'Appear instantly']];
const HOW_LEAVE = [['fade', 'Fade out'], ['slideL', 'Slide out left'], ['slideR', 'Slide out right'], ['walkL', 'Walk off left'], ['walkR', 'Walk off right'], ['instant', 'Vanish instantly']];
const VOICES = [['normal', 'Normal'], ['whisper', 'Whisper'], ['italic', 'Italic'], ['shout', 'Bold'], ['thought', 'Thought bubble'], ['narration', 'Narration box']];
const exprLabel = ex => ex && ex.length ? ex.map(x => (EXPRESSIONS.find(e => e[0] === x) || [x, x])[1]).join(', ') : 'Normal face';

function styledHtml(text, font, color) {
  const items = styleText(String(text || '').replace(/\r?\n/g, '|'), font || 'convo', color || null);
  let out = '', prevW = false;
  for (const it of items) {
    if (it.cmd) { if (it.cmd === 'w') { out += ' <span class="wait-mark" title="waits for a click">▸</span> '; prevW = true; } else if (it.cmd === 'br' && !prevW) out += ' '; else if (it.cmd === 'clear') out += ' ⟲ '; continue; }
    prevW = false;
    const st = [];
    if (it.color && it.color !== (A.fonts.convo && A.fonts.convo.default_color)) { const c = paletteCss(it.color); if (c) st.push('color:' + c); if (lightColor(it.color)) st.push('text-shadow:0 0 1px #000,0 0 1px #000'); }
    if (it.font === 'iconvo') st.push('font-style:italic');
    if (it.font === 'bconvo') st.push('font-weight:700');
    const cls = it.fx ? (it.fx.startsWith('jitter') ? 'fx-jitter' : 'fx-wave') : '';
    out += st.length || cls ? `<span${cls ? ` class="${cls}"` : ''}${st.length ? ` style="${st.join(';')}"` : ''}>${esc(it.ch)}</span>` : esc(it.ch);
  }
  return out;
}
function voiceOf(s) {
  if (s.box === 'thought') return 'thought';
  if (s.box === 'narration') return 'narration';
  const f = s.font || 'convo';
  if (!s.color && f === 'iconvo') return 'italic';
  if (!s.color && f === 'bconvo') return 'shout';
  if (s.color && s.color === doc.whisper && f === 'convo') return 'whisper';
  if (!s.color && f === 'convo') return 'normal';
  return 'custom';
}
function summaryHtml(s) {
  const b = x => `<span class="who">${esc(x || '?')}</span>`;
  const sp = x => x ? ` · speed ×${x}` : '';
  switch (s.k) {
    case 'line': {
      const v = voiceOf(s); const tag = v !== 'normal' ? ` <span class="hint">(${esc((VOICES.find(x => x[0] === v) || ['', 'styled'])[1].toLowerCase())})</span>` : '';
      const txt = s.text ? styledHtml(applyWords(s.text, doc.words), s.font, s.color || (s.box === 'narration' ? null : null)) : '<span class="hint">(no text yet)</span>';
      return `${b(s.who)}${tag} ${txt}${s.silent ? ' <span class="hint">· mouth still</span>' : ''}`;
    }
    case 'enter': return `${b(s.who)} enters · ${esc(posLabel(s.pos))} · ${esc((HOW_ENTER.find(h => h[0] === s.how) || ['', 'fade in'])[1].toLowerCase())}${s.expr && s.expr.length ? ' · ' + esc(exprLabel(s.expr).toLowerCase()) : ''}${sp(s.speed)}`;
    case 'enterMany': return (s.list || []).map(p => `${b(p.who)} <span class="hint">${esc(posLabel(p.pos))}</span>`).join(' and ') + ' enter';
    case 'leave': return `${b(s.who)} · ${esc((HOW_LEAVE.find(h => h[0] === s.how) || ['', 'fade out'])[1].toLowerCase())}${sp(s.speed)}`;
    case 'leaveMany': return (s.list || []).map(b).join(', ') + ' leave';
    case 'move': return `${b(s.who)} moves to ${esc(posLabel(s.pos))}${sp(s.speed)}`;
    case 'expr': return `${b(s.who)}: ${esc(exprLabel(s.expr))}`;
    case 'bop': return `${b(s.who)} bops${s.n && s.n !== 2 ? ' ×' + s.n : ''}${s.ms ? ` (${s.ms} ms each)` : ''}`;
    case 'mirror': return `${b(s.who)} turns around`;
    case 'bg': return s.bg ? esc(s.bg) + (s.keep ? ' <span class="hint">(keeps portraits)</span>' : '') : '<span class="hint">(pick a background)</span>';
    case 'transition': return (s.dir === 'open' ? 'Fade in from black' : 'Fade to black') + (s.ms ? ` · ${s.ms} ms` : '');
    case 'card': return s.text ? `“${esc(s.text)}”` : '<span class="hint">(no text yet)</span>';
    case 'shake': return `${s.ms || 300} ms`;
    case 'wait': return `${s.ms || 500} ms`;
    case 'music': return s.nid ? `${esc(s.nid)}${s.fade != null ? ` <span class="hint">· fade in ${s.fade} ms</span>` : ''}` : '<span class="hint">(pick a track)</span>';
    case 'musicOff': return `${s.mode === 'back' ? 'Back to the previous track' : 'Fades out'}${s.fade != null ? ` · ${s.fade} ms` : ''}`;
    case 'sound': return s.nid ? esc(s.nid) + (s.vol != null ? ` <span class="hint">· volume ${s.vol}</span>` : '') : '<span class="hint">(pick a sound)</span>';
    case 'note': return `<span class="hint">${esc(s.text || '')}</span>`;
    case 'raw': return `<code>${esc(s.code || '')}</code>`;
    case 'end': return 'End of event';
    case 'choice': return `${s.title ? `“${esc(s.title)}” ` : ''}<span class="hint">→</span> ${(s.options || []).map(o => `<b>${esc(o)}</b>`).join(' / ') || '<span class="hint">(no options)</span>'}`;
    case 'if': case 'elif': return condHtml(s.cond);
    case 'else': return 'Anything else';
    case 'join': return 'Paths meet';
  }
  return '';
}
// A condition in words (falls back to the code for anything custom)
function condHtml(cond) {
  const p = parseCond(cond);
  if (p.type === 'var') {
    const ch = doc.steps.find(x => x.k === 'choice' && x.nid === p.name);
    if (ch) return `${p.op === '==' ? 'Picked' : 'Didn’t pick'} <b>${esc(p.value)}</b>`;
    return `<b>${esc(p.name)}</b> ${p.op === '==' ? 'is' : 'isn’t'} <b>${esc(p.value)}</b>`;
  }
  if (p.type === 'alive') return `<span class="who">${esc(p.who)}</span> is alive`;
  if (p.type === 'dead') return `<span class="who">${esc(p.who)}</span> is dead`;
  if (p.type === 'const') return p.value ? 'Always' : 'Never';
  return `<code>${esc(cond || '')}</code>`;
}
function visualHtml(s) {
  if (s.who || (s.k === 'enterMany' && s.list && s.list[0])) {
    const who = s.who || s.list[0].who;
    const u = faceURL(who, s.k === 'expr' ? s.expr : s.k === 'enter' ? s.expr : null);
    if (u) return `<img class="face" src="${u}" alt="">`;
  }
  if (s.k === 'bg' && s.bg) { const u = bgURL(s.bg); if (u) return `<img class="bgthumb" src="${u}" alt="">`; }
  return `<span class="ic" aria-hidden="true">${esc(ICONS[s.k] || '•')}</span>`;
}

// ---------------------------------------------------------------------------
// Refresh
// ---------------------------------------------------------------------------
function clampSel() { sel = Math.max(0, Math.min(sel, doc.steps.length - 1)); }
function refresh(opts) {
  opts = opts || {};
  clampSel();
  gen = genCode(doc);
  chainFlow = stepFlow(doc);
  setPreviewVars();
  validateDoc();
  renderChain();
  renderBranchBar();
  if (!codeEditing) renderCode();
  renderProblems();
  if (!opts.keepInspector) renderInspector();
  renderOnStage();
  renderQuick();
  if (document.activeElement !== $('evName')) $('evName').value = doc.name || '';
  $('bUndo').disabled = !hist.past.length; $('bRedo').disabled = !hist.future.length;
  if (mode !== 'still') stopPlay();
  needsStill = true;
  saveDraftSoon();
}
function select(i, opts) {
  opts = opts || {};
  if (!doc.steps.length) return;
  sel = Math.max(0, Math.min(i, doc.steps.length - 1));
  if (mode !== 'still' && !opts.keepPlaying) stopPlay();
  renderChain(); if (!codeEditing) renderCode(); renderInspector(); renderOnStage(); renderQuick();
  needsStill = true;
  centerSelected(true);
  keepVisible($('codeView').querySelector('.cl.sel'));
  saveDraftSoon();
}

// ---------------------------------------------------------------------------
// Steps chain
// ---------------------------------------------------------------------------
function renderChain() {
  // keep focus (and the caret) in the chain's inline editor across re-renders
  const ae = document.activeElement;
  const q = ae && ae.closest && ae.closest('#chain .qe') ? ae.dataset.q : null;
  let ss = null, se = null; try { ss = ae.selectionStart; se = ae.selectionEnd; } catch (e) { /* not a text field */ }
  const flow = chainFlow || stepFlow(doc);
  const parts = chainRange(0, doc.steps.length - 1, flow);
  if (!doc.steps.length) parts.push('<li class="empty">No steps yet. Press <b>New conversation…</b> or the + above.</li>');
  document.body.classList.toggle('has-branches', flow.blocks.some(b => b.end != null));
  $('chain').innerHTML = parts.join('');
  const b = $('chain').querySelector('.bub.sel');
  if (b && doc.steps[sel]) b.querySelector('.body').append(quickEditor(doc.steps[sel], sel));
  $('stepCount').textContent = doc.steps.length ? `${doc.steps.length}` : '';
  $('mtStepCount').textContent = doc.steps.length ? `(${doc.steps.length})` : '';
  if (q) {
    const n = $('chain').querySelector(`.qe [data-q="${q}"]`);
    if (n) { n.focus({ preventScroll: true }); try { if (ss != null) n.setSelectionRange(ss, se); } catch (e) { /* number input */ } }
  }
}
let chainFlow = null;
// Steps from..to at one level; a complete branch becomes one block with a
// lane per path (and its steps inside).
function chainRange(from, to, flow) {
  const parts = [gapHtml(from, false)];
  let i = from;
  while (i <= to) {
    const s = doc.steps[i];
    const b = s.k === 'if' ? flow.byStart.get(i) : null;
    if (b && b.end != null && b.end <= to) { parts.push(branchHtml(b, flow)); i = b.end + 1; }
    else { parts.push(bubbleHtml(s, i)); i++; }
    const prev = doc.steps[i - 1];
    parts.push(gapHtml(i, prev && prev.together && i <= to));
  }
  return parts;
}
function branchHtml(b, flow) {
  const taken = previewArm(doc, b);
  const lanes = b.arms.map((a, k) => `<div class="lane${k === taken ? ' taken' : ''}"><span class="cn cn-l"></span><span class="cn cn-r"></span><ol class="lane-steps">${bubbleHtml(doc.steps[a.head], a.head)}${chainRange(a.from, a.to, flow).join('')}</ol></div>`).join('');
  return `<li class="branch" data-b="${b.start}"><div class="lanes">${lanes}</div><ol class="lane-steps join-at">${bubbleHtml(doc.steps[b.end], b.end)}</ol></li>`;
}
function gapHtml(at, together) {
  return `<li class="gap${together ? ' together' : ''}" data-at="${at}"><button class="ins" data-ins="${at}" title="Insert a step here" aria-label="Insert a step here">+</button>${together ? '<span class="tog">same time</span>' : ''}</li>`;
}
function bubbleHtml(s, i) {
  const K = KINDS[s.k] || KINDS.raw; const pr = problemsByStep.get(i);
  const grip = s.k === 'elif' || s.k === 'else' ? '' : s.k === 'join'
    ? `<span class="grip" data-grip title="Drag to rejoin later or earlier" aria-hidden="true">⇆</span>`
    : `<span class="grip" data-grip title="${s.k === 'if' ? 'Drag to move the whole branch' : 'Drag to move this step'}" aria-hidden="true">⠿</span>`;
  const flowCls = s.k === 'if' || s.k === 'elif' || s.k === 'else' ? ' arm-head' : s.k === 'join' ? ' join' : '';
  return `<li class="bub g-${K.group}${flowCls}${i === sel ? ' sel' : ''}" data-i="${i}" aria-current="${i === sel}">` + grip +
    `${visualHtml(s)}<div class="body"><div class="kind">${esc(K.label)}${pr ? `<span class="warn" title="${esc(pr.join('\n'))}">⚠ ${pr.length}</span>` : ''}</div>` +
    `<div class="txt">${summaryHtml(s)}</div></div><span class="num">${i + 1}</span></li>`;
}

// ---------------------------------------------------------------------------
// Inline editor inside the selected step: the settings you usually touch,
// plus move / duplicate / delete. Everything else is under "More options".
// ---------------------------------------------------------------------------
let lastSurface = 'chain';
const qUpd = (fn, key) => upd(fn, { key: key ? key + doc.steps[sel].id : null, keepInspector: false });
function qLab(label, ctrl) { return el('label', { class: 'ql' }, el('span', {}, label), ctrl); }
function qSel(key, options, value, onChange, label) {
  const s = el('select', { 'data-q': key, 'aria-label': label || key, onchange: e => onChange(e.target.value) },
    ...options.map(([v, l]) => el('option', { value: v }, l)));
  s.value = value == null ? '' : String(value);
  if (s.value !== String(value == null ? '' : value) && value != null && value !== '') { s.append(el('option', { value }, String(value))); s.value = value; }
  return s;
}
function qNum(key, value, onChange, opts) {
  opts = opts || {};
  return el('input', { type: 'number', 'data-q': key, value: value == null ? '' : value, min: opts.min, step: opts.step, placeholder: opts.placeholder, 'aria-label': opts.label || key,
    oninput: e => { const v = e.target.value === '' ? null : Number(e.target.value); if (v === null || Number.isFinite(v)) onChange(v); } });
}
function qText(key, value, onChange, placeholder) {
  return el('input', { type: 'text', 'data-q': key, value: value || '', placeholder, style: 'flex:1;min-width:140px', oninput: e => onChange(e.target.value) });
}
function qWho(value, onChange, at) {
  const on = [...sceneAfter(doc, at).keys()];
  const names = [...new Set([...on, ...castOf(doc), value].filter(Boolean))];
  const s = el('select', { 'data-q': 'who', 'aria-label': 'Who', onchange: e => {
    if (e.target.value === '__other') { e.target.value = value || ''; openPicker('portrait', value, onChange); } else onChange(e.target.value);
  } }, ...names.map(n => el('option', { value: n }, n + (on.includes(n) ? '' : ' (off stage)'))), el('option', { value: '__other' }, 'Other…'));
  s.value = value || '';
  return s;
}
const POS_OPTS = POSITIONS.map(([v, l]) => [v, l]);
function qTogether(s) {
  return el('label', { class: 'ql' }, el('input', { type: 'checkbox', 'data-q': 'tog', checked: !!s.together, onchange: e => qUpd(x => { x.together = e.target.checked; }) }), el('span', {}, 'same time as next'));
}
function qAssetBtn(kind, value, onPick) {
  const u = kind === 'bg' ? bgURL(value, 60) : null;
  return el('button', { 'data-q': 'asset' + kind, onclick: () => openPicker(kind, value, onPick) }, u ? el('img', { src: u, alt: '', class: 'qthumb' }) : null, value ? `${value} · change…` : 'Choose…');
}
const QUICK = {
  line(s, at) {
    const on = [...sceneAfter(doc, at).keys()];
    const names = [...new Set([...on, s.who].filter(Boolean))];
    const chips = el('div', { class: 'qrow' }, ...names.map(n => {
      const u = faceURL(n);
      return el('button', { class: 'chip' + (u ? '' : ' text'), 'data-q': 'spk' + n, 'aria-pressed': String(n === s.who), onclick: () => qUpd(x => { x.who = n; }) }, u ? el('img', { src: u, alt: '' }) : null, n);
    }), el('button', { class: 'chip text', onclick: () => openPicker('portrait', s.who, v => qUpd(x => { x.who = v; })) }, 'Other…'));
    const ta = el('textarea', { 'data-q': 'text', value: s.text || '', rows: 2, placeholder: `What does ${s.who || 'they'} say? (Enter = next line)`, 'aria-label': 'Line text' });
    ta.addEventListener('input', () => qUpd(x => { x.text = ta.value; }, 'qt'));
    ta.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        if (/^(\.{2,}|…)$/.test(ta.value.trim())) qUpd(x => { x.silent = true; x.text = '...'; });
        lastSurface = 'chain';
        addStep('line', sel + 1);
      }
    });
    return [chips, ta, el('div', { class: 'qrow' },
      qLab('Voice', qSel('voice', VOICES.concat(voiceOf(s) === 'custom' ? [['custom', 'Custom']] : []), voiceOf(s), v => qUpd(x => {
        if (v === 'custom') return;
        x.font = 'convo'; x.color = ''; x.box = '';
        if (v === 'whisper') x.color = doc.whisper || 'grey'; if (v === 'italic') x.font = 'iconvo'; if (v === 'shout') x.font = 'bconvo';
        if (v === 'thought') x.box = 'thought'; if (v === 'narration') x.box = 'narration';
      }), 'Voice')),
      el('label', { class: 'ql' }, el('input', { type: 'checkbox', 'data-q': 'silent', checked: !!s.silent, onchange: e => qUpd(x => { x.silent = e.target.checked; }) }), el('span', {}, 'mouth still')),
      qTogether(s))];
  },
  enter(s, at) {
    return [el('div', { class: 'qrow' },
      qLab('Who', qWho(s.who, v => qUpd(x => { x.who = v; }), at)),
      qLab('Where', qSel('pos', POS_OPTS, s.pos, v => qUpd(x => { x.pos = v; }), 'Where')),
      qLab('How', qSel('how', HOW_ENTER, s.how || 'fade', v => qUpd(x => { x.how = v; }), 'How')),
      s.how !== 'instant' ? qLab('Speed ×', qNum('speed', s.speed, v => qUpd(x => { x.speed = v; }, 'qs'), { step: 0.1, min: 0.1, placeholder: '1', label: 'Speed' })) : null,
      s.how !== 'instant' ? qTogether(s) : null)];
  },
  enterMany(s, at) {
    return (s.list || []).map((p, j) => el('div', { class: 'qrow' },
      qLab('Who', qWho(p.who, v => qUpd(x => { x.list[j].who = v; }), at)),
      qSel('pos' + j, POS_OPTS, p.pos, v => qUpd(x => { x.list[j].pos = v; }), 'Where')));
  },
  leave(s, at) {
    return [el('div', { class: 'qrow' },
      qLab('Who', qWho(s.who, v => qUpd(x => { x.who = v; }), at)),
      qLab('How', qSel('how', HOW_LEAVE, s.how || 'fade', v => qUpd(x => { x.how = v; }), 'How')),
      s.how !== 'instant' ? qLab('Speed ×', qNum('speed', s.speed, v => qUpd(x => { x.speed = v; }, 'qs'), { step: 0.1, min: 0.1, placeholder: '1', label: 'Speed' })) : null,
      s.how !== 'instant' ? qTogether(s) : null)];
  },
  leaveMany(s, at) {
    const names = [...new Set([...sceneAfter(doc, at).keys(), ...castOf(doc)])].filter(Boolean);
    return [el('div', { class: 'qrow' }, ...names.map(n => el('button', { class: 'chip text', 'data-q': 'lv' + n, 'aria-pressed': String((s.list || []).includes(n)),
      onclick: () => qUpd(x => { x.list = x.list.includes(n) ? x.list.filter(w => w !== n) : [...x.list, n]; }) }, n)))];
  },
  move(s, at) {
    return [el('div', { class: 'qrow' },
      qLab('Who', qWho(s.who, v => qUpd(x => { x.who = v; }), at)),
      qLab('To', qSel('pos', POS_OPTS, s.pos, v => qUpd(x => { x.pos = v; }), 'To')),
      qLab('Speed ×', qNum('speed', s.speed, v => qUpd(x => { x.speed = v; }, 'qs'), { step: 0.1, min: 0.1, placeholder: '1', label: 'Speed' })),
      qTogether(s))];
  },
  expr(s, at) {
    const ex = s.expr || [];
    const eyes = ['CloseEyes', 'HalfCloseEyes', 'LeftWink', 'RightWink', 'OpenEyes'];
    const tog = v => qUpd(x => { const e = x.expr || []; x.expr = e.includes(v) ? e.filter(y => y !== v) : [...e.filter(y => !(eyes.includes(v) && eyes.includes(y))), v]; });
    return [el('div', { class: 'qrow' }, qLab('Who', qWho(s.who, v => qUpd(x => { x.who = v; }), at))),
      el('div', { class: 'qrow' },
        el('button', { 'data-q': 'exN', 'aria-pressed': String(!ex.length), onclick: () => qUpd(x => { x.expr = []; }) }, 'Normal'),
        ...[['Smile', 'Smile'], ['CloseEyes', 'Eyes closed'], ['HalfCloseEyes', 'Half shut'], ['OpenMouth', 'Mouth open']].map(([v, l]) =>
          el('button', { 'data-q': 'ex' + v, 'aria-pressed': String(ex.includes(v)), onclick: () => tog(v) }, l)))];
  },
  bop(s, at) {
    return [el('div', { class: 'qrow' },
      qLab('Who', qWho(s.who, v => qUpd(x => { x.who = v; }), at)),
      qLab('Times', qNum('n', s.n || 2, v => qUpd(x => { x.n = v || 2; }, 'qn'), { min: 1, label: 'Number of bops' })),
      qLab('Speed (ms)', qNum('ms', s.ms, v => qUpd(x => { x.ms = v; }, 'qm'), { min: 1, placeholder: '132', label: 'Milliseconds per bop' })),
      qTogether(s))];
  },
  mirror(s, at) { return [el('div', { class: 'qrow' }, qLab('Who', qWho(s.who, v => qUpd(x => { x.who = v; }), at)))]; },
  bg(s) {
    return [el('div', { class: 'qrow' }, qAssetBtn('bg', s.bg, v => qUpd(x => { x.bg = v; })),
      el('label', { class: 'ql' }, el('input', { type: 'checkbox', 'data-q': 'keep', checked: !!s.keep, onchange: e => qUpd(x => { x.keep = e.target.checked; }) }), el('span', {}, 'keep portraits')))];
  },
  transition(s) {
    return [el('div', { class: 'qrow' }, qSel('dir', [['close', 'Fade to black'], ['open', 'Fade in from black']], s.dir, v => qUpd(x => { x.dir = v; }), 'Direction'),
      qLab('ms', qNum('ms', s.ms, v => qUpd(x => { x.ms = v; }, 'qm'), { min: 0, step: 50, label: 'Milliseconds' })), qTogether(s))];
  },
  card(s) { return [el('div', { class: 'qrow' }, qText('text', s.text, v => qUpd(x => { x.text = v; }, 'qt'), 'e.g. The training yard'))]; },
  shake(s) { return [el('div', { class: 'qrow' }, qLab('ms', qNum('ms', s.ms, v => qUpd(x => { x.ms = v || 300; }, 'qm'), { min: 1, step: 50, label: 'Milliseconds' })), qTogether(s))]; },
  wait(s) { return [el('div', { class: 'qrow' }, qLab('ms', qNum('ms', s.ms, v => qUpd(x => { x.ms = v || 500; }, 'qm'), { min: 1, step: 50, label: 'Milliseconds' })))]; },
  music(s) {
    return [el('div', { class: 'qrow' }, qAssetBtn('music', s.nid, v => qUpd(x => { x.nid = v; })),
      s.nid ? el('button', { onclick: () => { if (audio.musicNid && audio.musicNid.toLowerCase() === s.nid.toLowerCase()) audio.stopMusic(300); else audio.playMusic(s.nid, 300, s.vol); } }, '▶ / ■') : null,
      qLab('Fade in ms', qNum('fade', s.fade, v => qUpd(x => { x.fade = v; }, 'qf'), { min: 0, step: 50, label: 'Fade in' }))),
    el('div', { class: 'qrow' }, musicVolumeControl(s, true))];
  },
  musicOff(s) {
    return [el('div', { class: 'qrow' }, qSel('mode', [['clear', 'Fade out'], ['back', 'Back to previous track']], s.mode || 'clear', v => qUpd(x => { x.mode = v; }), 'Mode'),
      qLab('ms', qNum('fade', s.fade, v => qUpd(x => { x.fade = v; }, 'qf'), { min: 0, step: 100, label: 'Fade' })))];
  },
  sound(s) {
    return [el('div', { class: 'qrow' }, qAssetBtn('sfx', s.nid, v => qUpd(x => { x.nid = v; })),
      s.nid ? el('button', { onclick: () => audio.playSfx(s.nid, s.vol) }, '▶') : null,
      qLab('Volume', el('input', { type: 'range', 'data-q': 'vol', min: 0, max: 1, step: 0.05, value: s.vol == null ? 1 : s.vol, style: 'width:90px;accent-color:var(--ember)',
        onchange: e => qUpd(x => { x.vol = +e.target.value === 1 ? null : +e.target.value; }) })))];
  },
  note(s) { return [el('div', { class: 'qrow' }, qText('text', s.text, v => qUpd(x => { x.text = v; }, 'qt'), 'A note for yourself'))]; },
  raw(s) { return [el('div', { class: 'qrow' }, el('input', { type: 'text', 'data-q': 'code', class: 'codeish', value: s.code || '', style: 'flex:1;min-width:160px', spellcheck: 'false', oninput: e => qUpd(x => { x.code = e.target.value; }, 'qc') }))]; },
  end() { return []; },
  choice(s, at) { return choiceEditor(s, at + 1); },
  if(s, at) { return armEditor(s, at + 1); },
  elif(s, at) { return armEditor(s, at + 1); },
  else(s, at) { return armEditor(s, at + 1); },
  join(s, at) { return joinEditor(s, at + 1); },
};

// ---------------------------------------------------------------------------
// Branch editors (used inline in the chain and in the step panel)
// ---------------------------------------------------------------------------
function setPreviewVars() {
  const v = {}; for (const [k, x] of Object.entries(doc.preview || {})) if (x !== '' && x != null) v[k] = x;
  const changed = JSON.stringify(v) !== JSON.stringify(PREVIEW_VARS);
  PREVIEW_VARS = v;
  if (changed) thumbCache.clear();   // looks can change faces
}
// Look variables (from the project's events) that matter here: they change
// someone in this conversation.
function lookVarsHere() {
  const cast = new Set(castOf(doc).map(n => { const u = unitFor(n); return (u ? u.nid : n).toLowerCase(); }));
  const out = new Map();
  for (const l of A.looks || []) {
    if (l.unit && !cast.has(String(l.unit).toLowerCase())) continue;
    if (!l.unit && !doc.steps.some(x => x.k === 'line' && String(x.text || '').includes('{v:' + l.setVar[0]))) continue;
    if (!out.has(l.var)) out.set(l.var, new Set());
    out.get(l.var).add(l.value);
  }
  return out;
}
function knownVars() {
  // variables the conversation tests, with the values it compares them to
  const vars = new Map();
  const add = (n, v) => { if (!n) return; if (!vars.has(n)) vars.set(n, new Set()); if (v != null && v !== '') vars.get(n).add(v); };
  for (const x of doc.steps) {
    if (x.k === 'choice') { add(x.nid); for (const o of x.options || []) add(x.nid, o); }
    if (x.k === 'if' || x.k === 'elif') { const p = parseCond(x.cond); if (p.type === 'var') add(p.name, p.value); }
  }
  for (const [n, vals] of lookVarsHere()) for (const x of vals) add(n, x);
  if (!vars.size) add('YuelGender');
  return vars;
}
function datalist(id, values) { return el('datalist', { id }, ...[...values].map(v => el('option', { value: v }))); }
function blockOf(i) { const b = (chainFlow || stepFlow(doc)).owner[i]; return b && b.end != null ? b : null; }
function previewButton(i) {
  const b = blockOf(i); if (!b) return null;
  const k = b.heads.indexOf(i), head = doc.steps[b.start];
  const on = head.pv === k;
  return el('button', { 'data-q': 'pv', 'aria-pressed': String(on), title: 'Show this path in the preview when it can’t tell which one runs',
    onclick: () => change(() => { head.pv = on ? null : k; }, { keepInspector: false }) }, on ? '◉ Previewing this path' : '○ Preview this path');
}
function armEditor(s, i) {
  const b = blockOf(i);
  const out = [];
  const choiceIdx = b && b.start > 0 && doc.steps[b.start - 1].k === 'choice' && branchForChoice(doc, b.start - 1) ? b.start - 1 : -1;
  if (s.k === 'else') out.push(el('div', { class: 'qrow hint' }, 'Runs when none of the paths above do.'));
  else if (choiceIdx >= 0 && parseCond(s.cond).type === 'var') {
    out.push(el('div', { class: 'qrow' }, el('span', {}, 'When they pick '), el('b', {}, parseCond(s.cond).value || '?')),
      el('div', { class: 'qrow hint' }, 'Change the answers on the choice step (just before this branch).'));
  } else out.push(...condEditor(s, i));
  const acts = el('div', { class: 'qrow' }, previewButton(i));
  if (b) {
    acts.append(el('button', { 'data-q': 'addarm', title: 'Another path in this branch', onclick: () => {
      if (choiceIdx >= 0) {
        const c = doc.steps[choiceIdx];
        change(() => { let n = c.options.length + 1; while (c.options.includes('Answer ' + n)) n++; c.options.push('Answer ' + n); syncChoiceArms(doc, choiceIdx); sel = choiceIdx; });
        toast('Added an answer to the choice, with its own path.');
      } else change(() => { const at = addArm(doc, i, condFor('YuelGender', 'Male')); if (typeof at === 'number') sel = at; });
    } }, '+ Add path'));
    if (!b.hasElse && choiceIdx < 0) acts.append(el('button', { 'data-q': 'addelse', onclick: () => change(() => { doc.steps.splice(b.end, 0, { id: newId(), k: 'else' }); sel = b.end; }) }, '+ Otherwise'));
  }
  out.push(acts);
  return out;
}
function condEditor(s, i) {
  const p = parseCond(s.cond);
  const mode = s.custom ? 'custom' : p.type === 'var' ? 'var' : (p.type === 'alive' || p.type === 'dead') ? 'alive' : 'custom';
  const setCond = (c, key, extra) => qUpd(x => { x.cond = c; Object.assign(x, extra || {}); }, key);
  const vars = knownVars();
  const row = el('div', { class: 'qrow' }, qLab('Checks', qSel('cmode', [['var', 'A variable'], ['alive', 'A character'], ['custom', 'Code']], mode, v => {
    if (v === 'var') setCond(condFor(p.type === 'var' ? p.name : [...vars.keys()][0], p.type === 'var' ? p.value : ([...(vars.values().next().value || [])][0] || 'Female')), null, { custom: false });
    else if (v === 'alive') setCond(`game.check_alive('${(castOf(doc)[0] || 'Yuel').replace(/'/g, '')}')`, null, { custom: false });
    else setCond(s.cond, null, { custom: true });
  }, 'What this path checks')));
  const out = [row];
  if (mode === 'var') {
    const name = p.type === 'var' ? p.name : '', value = p.type === 'var' ? p.value : '', op = p.type === 'var' ? p.op : '==';
    const listN = 'vn' + s.id, listV = 'vv' + s.id;
    out.push(el('div', { class: 'qrow' },
      el('input', { type: 'text', 'data-q': 'vname', value: name, list: listN, placeholder: 'e.g. YuelGender', style: 'width:130px', 'aria-label': 'Variable',
        oninput: e => setCond(condFor(e.target.value.trim(), value, op), 'vn') }), datalist(listN, vars.keys()),
      qSel('vop', [['==', 'is'], ['!=', 'isn’t']], op, v => setCond(condFor(name, value, v)), 'is / isn’t'),
      el('input', { type: 'text', 'data-q': 'vval', value, list: listV, placeholder: 'e.g. Female', style: 'width:110px', 'aria-label': 'Value',
        oninput: e => setCond(condFor(name, e.target.value, op), 'vv') }), datalist(listV, vars.get(name) || [])));
  } else if (mode === 'alive') {
    const who = p.who || '';
    const cast = [...new Set([...castOf(doc), who].filter(Boolean))];
    out.push(el('div', { class: 'qrow' },
      qSel('awho', cast.map(n => [n, n]), who, v => setCond(`game.check_${p.type === 'dead' ? 'dead' : 'alive'}('${v.replace(/'/g, '')}')`), 'Who'),
      qSel('aok', [['alive', 'is alive'], ['dead', 'is dead']], p.type === 'dead' ? 'dead' : 'alive', v => setCond(`game.check_${v}('${who.replace(/'/g, '')}')`), 'Alive or dead')));
  } else {
    out.push(el('div', { class: 'qrow' }, el('input', { type: 'text', 'data-q': 'cond', class: 'codeish', value: s.cond || '', style: 'flex:1;min-width:180px', spellcheck: 'false',
      'aria-label': 'Condition (Python, as in LT)', placeholder: "e.g. game.get_unit('Dito').level > 5", oninput: e => setCond(e.target.value, 'cc') })),
      el('div', { class: 'qrow hint' }, 'Any LT condition. The preview can’t work it out, so use “Preview this path” to pick what it shows.'));
  }
  return out;
}
function choiceEditor(s, i) {
  const setOpts = (fn, key) => change(() => { const c = doc.steps[i]; fn(c); syncChoiceArms(doc, i); }, { key: key ? key + s.id : null });
  const out = [el('div', { class: 'qrow' }, qText('ctitle', s.title, v => qUpd(x => { x.title = v; }, 'ct'), 'The question (optional)'))];
  const list = el('div', { class: 'qrow opts' });
  (s.options || []).forEach((o, n) => list.append(el('span', { class: 'opt' },
    el('input', { type: 'text', 'data-q': 'opt' + n, value: o, style: 'width:110px', 'aria-label': 'Answer ' + (n + 1),
      oninput: e => setOpts(c => { c.options[n] = e.target.value.replace(/[;,]/g, ' '); }, 'o' + n) }),
    el('button', { class: 'x', title: 'Remove this answer (and its path)', disabled: s.options.length <= 2, onclick: () => setOpts(c => { c.options.splice(n, 1); }) }, '×'))));
  list.append(el('button', { 'data-q': 'addopt', onclick: () => setOpts(c => { let n = c.options.length + 1; while (c.options.includes('Answer ' + n)) n++; c.options.push('Answer ' + n); }) }, '+ Answer'));
  out.push(list);
  out.push(el('div', { class: 'qrow' }, qLab('Remembered as', el('input', { type: 'text', 'data-q': 'cnid', class: 'codeish', value: s.nid || '', style: 'width:120px', spellcheck: 'false',
    title: 'The game variable that holds the answer (for later events too)',
    oninput: e => {
      const nid = e.target.value.replace(/[^A-Za-z0-9_]/g, '');
      change(() => {
        const c = doc.steps[i], old = c.nid, b = branchForChoice(doc, i);
        c.nid = nid;
        if (b) for (const h of b.heads) { const x = doc.steps[h]; const q = parseCond(x.cond); if (x.k !== 'else' && q.type === 'var' && q.name === old) x.cond = condFor(nid, q.value, q.op); }
      }, { key: 'cn' + s.id });
    } }))));
  if (!branchForChoice(doc, i)) out.push(el('div', { class: 'qrow' }, el('button', { onclick: () => change(() => {
    const c = doc.steps[i];
    const arms = choiceBranchSteps({ nid: c.nid, options: c.options }).slice(1);
    doc.steps.splice(i + 1, 0, ...arms);
  }) }, '+ A path for each answer')));
  return out;
}
function joinEditor(s, i) {
  return [el('div', { class: 'qrow' },
    el('button', { 'data-q': 'earlier', title: 'Steps every path ends with move out after the branch', onclick: () => moveJoin(i, i - 1) }, '◂ Rejoin earlier'),
    el('button', { 'data-q': 'later', title: 'The next step moves into every path, so each can change it', onclick: () => moveJoin(i, i + 2) }, 'Rejoin later ▸')),
  el('div', { class: 'qrow hint' }, 'Or drag ⇆ along the timeline. Later copies the next steps into every path; earlier merges steps they all end with.')];
}
function renderBranchBar() {
  const bar = $('branchBar'); if (!bar) return;
  bar.innerHTML = '';
  const conds = doc.steps.filter(x => x.k === 'if' || x.k === 'elif').map(x => parseCond(x.cond));
  const choices = doc.steps.filter(x => x.k === 'choice');
  const looks = lookVarsHere();
  if (!conds.length && !choices.length && !looks.size) { bar.hidden = true; return; }
  bar.hidden = false;
  doc.preview = doc.preview || {};
  bar.append(el('span', { class: 'lbl' }, 'Preview as:'));
  const set = (k, v) => change(() => { doc.preview[k] = v; }, { keepInspector: true });
  const choiceNids = new Set(choices.map(c => c.nid));
  for (const [name, values] of knownVars()) {
    if (!conds.some(p => p.type === 'var' && p.name === name) && !choiceNids.has(name) && !looks.has(name)) continue;
    const isChoice = choiceNids.has(name);
    const opts = (isChoice ? [['', 'ask me']] : [['', '(not set)']]).concat([...values].map(v => [v, v]));
    const cur = doc.preview[name] == null ? '' : doc.preview[name];
    bar.append(el('label', { class: 'bv' }, el('span', {}, name + ' '), qSel('pv_' + name, opts, cur, v => set(name, v), name)));
  }
  const people = [...new Set(conds.filter(p => p.type === 'alive' || p.type === 'dead').map(p => p.who))];
  for (const who of people) {
    bar.append(el('label', { class: 'bv' }, el('input', { type: 'checkbox', checked: doc.preview['alive:' + who] !== false, onchange: e => set('alive:' + who, e.target.checked) }), ` ${who} alive`));
  }
}
function quickEditor(s, i) {
  const f = QUICK[s.k] || QUICK.raw;
  const box = el('div', { class: 'qe' });
  box.append(...[].concat(f(s, i - 1)).filter(Boolean));
  box.append(el('div', { class: 'qacts' },
    el('button', { 'data-q': 'up', disabled: i === 0, title: 'Move up (Alt+↑)', onclick: () => nudge(i, -1) }, '↑'),
    el('button', { 'data-q': 'down', disabled: i >= doc.steps.length - 1, title: 'Move down (Alt+↓)', onclick: () => nudge(i, 1) }, '↓'),
    el('button', { 'data-q': 'dup', title: 'Duplicate (Ctrl+D)', onclick: () => duplicateStep(i) }, 'Duplicate'),
    el('button', { 'data-q': 'del', class: 'danger', title: 'Delete (Del)', onclick: () => deleteStep(i) }, 'Delete'),
    el('span', { class: 'spacer' }),
    el('button', { 'data-q': 'more', title: 'Every setting for this step', onclick: () => { if (isPhone()) { setTab('edit'); window.scrollTo(0, 0); } else { lastSurface = 'inspector'; focusInspector(); } } }, 'More options ›')));
  return box;
}

// ---------------------------------------------------------------------------
// Drag to reorder (grip handle; works with mouse, pen and touch)
// ---------------------------------------------------------------------------
const drag = { from: null, to: null, id: null, bub: null, raf: 0, x: 0, y: 0 };
const isTimeline = () => document.body.classList.contains('timeline') && !isPhone();
function dropIndexAt(x, y) {
  const hit = document.elementFromPoint(x, y);
  const b = hit && hit.closest && hit.closest('#chain .bub');
  if (b) {
    const r = b.getBoundingClientRect();
    const before = isTimeline() ? x < r.left + r.width / 2 : y < r.top + r.height / 2;
    return { idx: +b.dataset.i + (before ? 0 : 1), b, before };
  }
  const g = hit && hit.closest && hit.closest('#chain .gap');
  if (g) return { idx: +g.dataset.at, b: null };
  return null;
}
function clearDropMarks() { $('chain').querySelectorAll('.drop-before,.drop-after').forEach(x => x.classList.remove('drop-before', 'drop-after')); }
function dragAutoScroll() {
  if (drag.from == null) return;
  const wrap = $('chainWrap'), edge = 60, v = 14;
  if (isTimeline()) {
    const r = wrap.getBoundingClientRect();
    if (drag.x < r.left + edge) wrap.scrollLeft -= v; else if (drag.x > r.right - edge) wrap.scrollLeft += v;
  } else if (wrap.scrollHeight > wrap.clientHeight + 2 && getComputedStyle(wrap).overflowY !== 'visible') {
    const r = wrap.getBoundingClientRect();
    if (drag.y < r.top + edge) wrap.scrollTop -= v; else if (drag.y > r.bottom - edge) wrap.scrollTop += v;
  } else {
    const top = isPhone() ? $('stage').getBoundingClientRect().bottom : 0;
    if (drag.y < top + edge) window.scrollBy(0, -v); else if (drag.y > innerHeight - edge) window.scrollBy(0, v);
  }
  drag.raf = requestAnimationFrame(dragAutoScroll);
}
function wireChain() {
  const ol = $('chain');
  ol.addEventListener('click', e => {
    const ins = e.target.closest('[data-ins]');
    if (ins) { lastSurface = 'chain'; openInsertMenu(+ins.dataset.ins, ins); return; }
    if (e.target.closest('.qe') || e.target.closest('[data-grip]')) return;
    const b = e.target.closest('.bub'); if (b) { lastSurface = 'chain'; select(+b.dataset.i); }
  });
  ol.addEventListener('dblclick', e => { if (e.target.closest('.bub') && !e.target.closest('.qe')) focusEditor(); });
  ol.addEventListener('focusin', e => { if (e.target.closest('.qe')) lastSurface = 'chain'; });
  ol.addEventListener('pointerdown', e => {
    const g = e.target.closest('[data-grip]'); if (!g) return;
    e.preventDefault();
    const b = g.closest('.bub');
    Object.assign(drag, { from: +b.dataset.i, to: null, id: e.pointerId, bub: b, x: e.clientX, y: e.clientY });
    try { g.setPointerCapture(e.pointerId); } catch (x) { /* ignore */ }
    b.classList.add('dragging'); document.body.classList.add('is-dragging');
    drag.raf = requestAnimationFrame(dragAutoScroll);
  });
  ol.addEventListener('pointermove', e => {
    if (drag.from == null || e.pointerId !== drag.id) return;
    drag.x = e.clientX; drag.y = e.clientY;
    clearDropMarks();
    const d = dropIndexAt(e.clientX, e.clientY); drag.to = d ? d.idx : null;
    if (d && d.b) d.b.classList.add(d.before ? 'drop-before' : 'drop-after');
    else if (d) { const nb = ol.querySelector(`.bub[data-i="${d.idx}"]`); if (nb) nb.classList.add('drop-before'); }
  });
  const end = e => {
    if (drag.from == null || (e && e.pointerId !== drag.id)) return;
    cancelAnimationFrame(drag.raf); clearDropMarks();
    document.body.classList.remove('is-dragging');
    const { from, to } = drag; drag.from = null;
    if (drag.bub) drag.bub.classList.remove('dragging');
    if (e && e.type === 'pointerup' && to != null) moveStep(from, to);
  };
  ol.addEventListener('pointerup', end);
  ol.addEventListener('pointercancel', end);
  // timeline: the mouse wheel scrolls sideways
  $('chainWrap').addEventListener('wheel', e => {
    if (!isTimeline() || e.target.closest('textarea')) return;
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) { e.preventDefault(); $('chainWrap').scrollLeft += e.deltaY; }
  }, { passive: false });
}
function centerSelected(smooth) {
  const wrap = $('chainWrap');
  const b = $('chain').querySelector(`.bub[data-i="${sel}"]`); if (!b) return;
  if (isTimeline()) {
    const r = b.getBoundingClientRect(), wr = wrap.getBoundingClientRect();
    wrap.scrollTo({ left: wrap.scrollLeft + (r.left - wr.left) - (wrap.clientWidth - r.width) / 2,
      top: wrap.scrollTop + (r.top - wr.top) - Math.max(0, (wrap.clientHeight - r.height) / 2), behavior: smooth ? 'smooth' : 'auto' });
  }
  else if (isPhone()) {
    if (document.body.dataset.mtab !== 'steps') return;
    // the person just picked this step: bring it (and its editor) up under the pinned preview
    const top = $('stage').getBoundingClientRect().bottom + 8, r = b.getBoundingClientRect();
    if (r.top < top || r.top > innerHeight - 120) window.scrollBy({ top: r.top - top, behavior: smooth ? 'smooth' : 'auto' });
  } else keepVisible(b);
}
// The steps that move together with step i: a branch moves whole (with the
// choice in front of it).
function moveRange(i) {
  const s = doc.steps[i]; let a = i, b = i;
  const flow = stepFlow(doc);
  if (s.k === 'if') { const blk = flow.byStart.get(i); if (blk && blk.end != null) { b = blk.end; if (i > 0 && doc.steps[i - 1].k === 'choice' && branchForChoice(doc, i - 1, flow)) a = i - 1; } }
  else if (s.k === 'choice') { const blk = branchForChoice(doc, i, flow); if (blk && blk.end != null) b = blk.end; }
  return [a, b];
}
function moveStep(from, to) {
  const s = doc.steps[from]; if (!s) return;
  if (s.k === 'join') { moveJoin(from, to); return; }
  if (s.k === 'elif' || s.k === 'else') { toast('Paths move with their branch: drag the branch by its first step.'); return; }
  const [a, b] = moveRange(from);
  if (to >= a && to <= b + 1) return;
  change(() => {
    const block = doc.steps.splice(a, b - a + 1);
    const dest = to > b ? to - block.length : to;
    doc.steps.splice(dest, 0, ...block); sel = dest + (from - a);
  });
}
// Alt+arrows and the ↑ ↓ buttons: one place up or down (a branch jumps over
// the neighbouring step).
function nudge(i, dir) {
  const s = doc.steps[i]; if (!s) return;
  if (s.k === 'join') { moveJoin(i, dir < 0 ? i - 1 : i + 2); return; }
  const [a, b] = moveRange(i);
  moveStep(i, dir < 0 ? a - 1 : b + 2);
}
function moveJoin(from, to) {
  // try it on a copy first, so a refusal changes nothing (and adds no undo)
  const trial = { ...doc, steps: JSON.parse(JSON.stringify(doc.steps)) };
  let at = from, err = null;
  if (to > from + 1) { const r = rejoinLater(trial, from, to - from - 1); if (typeof r === 'string') err = r; else at = r; }
  else if (to <= from) {
    for (let n = from - to; n > 0; n--) { const r = rejoinEarlier(trial, at); if (typeof r === 'string') { err = r; break; } at = r; }
  } else return;
  if (trial.steps.length !== doc.steps.length || at !== from) change(() => { doc.steps = trial.steps; sel = at; });
  if (err) toast(err);
}

// ---------------------------------------------------------------------------
// Adding steps
// ---------------------------------------------------------------------------
function focusWhoAt(at) {
  const on = sceneAfter(doc, at - 1);
  const cur = doc.steps[sel];
  if (cur && cur.who && on.has(cur.who)) return cur.who;
  const last = lastSpeakerBefore(doc, at - 1);
  if (last && on.has(last)) return last;
  return [...on.keys()][0] || '';
}
function freeSide(scene) {
  const xs = [...scene.values()].map(v => parsePosition(v.pos).x);
  const leftUsed = xs.some(x => x < W / 2 - 48), rightUsed = xs.some(x => x >= W / 2 - 48);
  return leftUsed && !rightUsed ? 'Right' : 'Left';
}
function makeStep(k, at, o) {
  o = o || {};
  const scene = sceneAfter(doc, at - 1);
  const who = o.who != null ? o.who : focusWhoAt(at);
  const T = { together: false };
  switch (k) {
    case 'line': return { k, who: o.who != null ? o.who : nextSpeaker(doc, at - 1), text: o.text || '', font: 'convo', color: '', box: '', silent: false, hold: false, ...T };
    case 'enter': return { k, who: o.who || '', pos: o.pos || freeSide(scene), how: 'fade', expr: [], mirror: false, speed: null, ...T };
    case 'enterMany': return { k, list: [{ who: '', pos: 'Left' }, { who: '', pos: 'Right' }] };
    case 'leave': return { k, who, how: o.how || 'fade', speed: null, ...T };
    case 'leaveMany': return { k, list: [...scene.keys()] };
    case 'move': { const cur = scene.get(who); const x = cur ? parsePosition(cur.pos).x : 0; return { k, who, pos: o.pos || (x < W / 2 - 48 ? 'CenterLeft' : 'CenterRight'), speed: null, ...T }; }
    case 'expr': return { k, who, expr: o.expr || ['Smile'] };
    case 'bop': return { k, who, n: 2, ms: null, ...T };
    case 'mirror': return { k, who, speed: null };
    case 'bg': return { k, bg: o.bg || '', keep: false };
    case 'transition': { let dir = 'close'; for (let j = at - 1; j >= 0; j--) if (doc.steps[j].k === 'transition') { dir = doc.steps[j].dir === 'close' ? 'open' : 'close'; break; } return { k, dir, ms: 1000, ...T }; }
    case 'card': return { k, text: '' };
    case 'shake': return { k, ms: 300, ...T };
    case 'wait': return { k, ms: 500 };
    case 'music': return { k, nid: o.nid || '', fade: 50 };
    case 'musicOff': return { k, mode: 'clear', fade: 2000 };
    case 'sound': return { k, nid: o.nid || '', vol: null };
    case 'note': return { k, text: '' };
    case 'raw': return { k, code: '' };
    case 'end': return { k };
  }
}
const NEEDS_PICK = { enter: 'portrait', bg: 'bg', music: 'music', sound: 'sfx' };
function addStep(k, at, o, after) {
  o = o || {};
  const needs = NEEDS_PICK[k];
  const field = { enter: 'who', bg: 'bg', music: 'nid', sound: 'nid' }[k];
  if (needs && !o[field]) {
    openPicker(needs, '', v => addStep(k, at, { ...o, [field]: v }, after));
    return;
  }
  if (at == null) at = doc.steps.length ? sel + 1 : 0;
  const s = { id: newId(), ...makeStep(k, at, o), ...(o.extra || {}) };
  change(() => { doc.steps.splice(at, 0, s); sel = o.keepSel != null ? o.keepSel : at; });
  if (isPhone() && document.body.dataset.mtab !== 'steps') setTab('edit');
  centerSelected(true);
  if (after) after(); else if (k === 'line' || k === 'note' || k === 'raw' || k === 'card') focusEditor();
}
function deleteStep(i) {
  const s = doc.steps[i]; if (!s) return;
  if (s.k === 'join') { toast('A branch needs its Rejoin. To remove the whole branch, delete its first step.'); return; }
  if (s.k === 'if' || s.k === 'elif' || s.k === 'else') {
    const blk = stepFlow(doc).owner[i];
    if (blk && blk.end != null) {
      const keep = s.k === 'if' ? Math.max(0, previewArm(doc, blk)) : null;
      change(() => { if (s.k === 'if') removeBranch(doc, i, keep); else removeArm(doc, i); sel = Math.min(i, doc.steps.length - 1); });
      toast(s.k === 'if' ? 'Removed the branch and kept the path the preview shows. Ctrl+Z to undo.' : 'Removed that path and its steps. Ctrl+Z to undo.');
      return;
    }
  }
  change(() => { doc.steps.splice(i, 1); sel = Math.min(i, doc.steps.length - 1); });
}
function duplicateStep(i) {
  const s = doc.steps[i]; if (!s) return;
  if (s.k === 'elif' || s.k === 'else' || s.k === 'join') { toast('Use “+ Add path” to add another path to this branch.'); return; }
  const [a, b] = moveRange(i);
  change(() => {
    const copy = doc.steps.slice(a, b + 1).map(x => ({ ...JSON.parse(JSON.stringify(x)), id: newId() }));
    doc.steps.splice(b + 1, 0, ...copy); sel = b + 1 + (i - a);
  });
}
// New branches from the + menu
function uniqueChoiceNid() {
  const used = new Set(doc.steps.filter(x => x.k === 'choice').map(x => x.nid));
  let n = 1; while (used.has('Choice' + n)) n++; return 'Choice' + n;
}
function addBranch(kind, at) {
  if (at == null) at = doc.steps.length ? sel + 1 : 0;
  const steps = kind === 'branchChoice'
    ? choiceBranchSteps({ nid: uniqueChoiceNid(), title: 'What do you say?', options: ['Yes', 'No'] })
    : ifBranchSteps({ name: 'YuelGender', value: 'Female' });
  change(() => { doc.steps.splice(at, 0, ...steps); sel = at; });
  centerSelected(true);
  toast(kind === 'branchChoice' ? 'Added a choice with a path per answer. Use + inside a path to add its steps.' : 'Added a branch. Set what it checks, then fill each path with +.');
}
// Put the cursor where the person is working: the step's inline editor in the
// chain, or the full editor.
function focusEditor() {
  const chainVisible = isPhone() ? document.body.dataset.mtab === 'steps' : true;
  if (lastSurface === 'chain' && chainVisible) {
    setTimeout(() => {
      const f = $('chain').querySelector('.qe textarea, .qe input[type="text"], .qe select, .qe input');
      if (f) { f.focus({ preventScroll: true }); if (f.setSelectionRange && f.value != null) try { f.setSelectionRange(f.value.length, f.value.length); } catch (e) { /* ignore */ } centerSelected(false); }
    }, 0);
    return;
  }
  focusInspector();
}
function focusInspector() {
  setTimeout(() => {
    const f = $('insp').querySelector('textarea.linetext, textarea, input[type="text"]');
    if (isPhone()) {
      // bring the step editor up under the pinned preview (the user just asked for it)
      const top = $('insp').getBoundingClientRect().top + scrollY - $('stage').getBoundingClientRect().height - 8;
      window.scrollTo({ top: Math.max(0, top) });
    }
    if (f) { f.focus({ preventScroll: isPhone() }); if (f.setSelectionRange) f.setSelectionRange(f.value.length, f.value.length); }
  }, 0);
}

// Insert menu (the + between steps, and "More…")
const MENU = [
  ['Talk', [['line', 'Line']]],
  ['Characters', [['enter', 'Enters'], ['leave', 'Leaves'], ['move', 'Moves'], ['expr', 'Expression'], ['bop', 'Bop'], ['mirror', 'Turns around'], ['enterMany', 'Enter together'], ['leaveMany', 'Leave together']]],
  ['Scene', [['bg', 'Background'], ['transition', 'Fade'], ['card', 'Location card'], ['shake', 'Screen shake'], ['wait', 'Pause']]],
  ['Sound', [['music', 'Music'], ['musicOff', 'Music stops'], ['sound', 'Sound effect']]],
  ['Branch', [['branchChoice', 'Player choice'], ['branchIf', 'If… otherwise…']]],
  ['Other', [['note', 'Note'], ['raw', 'Code line'], ['end', 'End']]],
];
let menuAt = null;
function openInsertMenu(at, anchor) {
  const m = $('insMenu');
  menuAt = at;
  m.innerHTML = MENU.map(([g, items]) => `<div class="grp"><div class="gl">${esc(g)}</div><div class="row">${items.map(([k, l]) => `<button role="menuitem" data-k="${k}">${esc(l)}</button>`).join('')}</div></div>`).join('') +
    `<div class="row"><span class="hint" style="flex:1">Inserts ${at === 0 ? 'at the start' : at >= doc.steps.length ? 'at the end' : `between steps ${at} and ${at + 1}`}.</span><button class="menu-close" data-close="1">Close</button></div>`;
  m.hidden = false;
  const r = anchor.getBoundingClientRect(); const mw = m.offsetWidth, mh = m.offsetHeight;
  let x = r.right + 8, y = r.top - 10;
  if (x + mw > innerWidth - 8) x = Math.max(8, r.left - mw - 8);
  if (x < 8) x = 8;
  if (y + mh > innerHeight - 8) y = Math.max(8, innerHeight - mh - 8);
  m.style.left = x + 'px'; m.style.top = y + 'px';
  const first = m.querySelector('button'); if (first) first.focus({ preventScroll: true });
  document.querySelectorAll('.gap.open').forEach(g => g.classList.remove('open'));
  const gap = anchor.closest('.gap'); if (gap) gap.classList.add('open');
}
function closeInsertMenu() { $('insMenu').hidden = true; menuAt = null; document.querySelectorAll('.gap.open').forEach(g => g.classList.remove('open')); }

// ---------------------------------------------------------------------------
// Quick add + characters on stage
// ---------------------------------------------------------------------------
function renderQuick() {
  const q = $('quick'); q.innerHTML = '';
  const at = doc.steps.length ? sel + 1 : 0;
  q.append(el('span', { class: 'lbl' }, doc.steps.length ? `Add after step ${sel + 1}:` : 'Add:'));
  for (const [k, l] of [['line', '“ Line'], ['enter', '→ Enters'], ['leave', '← Leaves'], ['move', '↔ Moves'], ['expr', '☺ Expression'], ['bop', '↥ Bop'],
    ['music', '♪ Music'], ['sound', '◎ Sound'], ['bg', '▦ Background'], ['shake', '≋ Shake'], ['wait', '⏸ Pause']])
    q.append(el('button', { onclick: () => addStep(k, at) }, l));
  q.append(el('button', { onclick: e => openInsertMenu(at, e.currentTarget) }, 'More…'));
}
function renderOnStage() {
  const box = $('onstage'); box.innerHTML = '';
  if (!doc.steps.length) return;
  const at = sel + 1;
  const on = sceneAfter(doc, sel);
  for (const [who, st] of on) {
    const ex = st.expr || [];
    const face = faceURL(who, ex);
    const has = x => ex.includes(x);
    const exprStep = next => addStep('expr', at, { who, expr: next });
    const toggled = x => has(x) ? ex.filter(e => e !== x) : [...ex.filter(e => !['CloseEyes', 'HalfCloseEyes', 'LeftWink', 'RightWink'].includes(e) || !['CloseEyes', 'HalfCloseEyes', 'LeftWink', 'RightWink'].includes(x)), x];
    const moveBtn = el('button', { title: 'Move to another spot', onclick: e => openPosMenu(e.currentTarget, pos => addStep('move', at, { who, pos })) }, 'Move…');
    box.append(el('div', { class: 'card' },
      face ? el('img', { class: 'face', src: face, alt: '' }) : el('span', { class: 'face' }),
      el('div', { class: 'nm' }, who, el('span', {}, posLabel(st.pos) + (ex.length ? ' · ' + exprLabel(ex).toLowerCase() : ''))),
      el('div', { class: 'acts' },
        el('button', { class: 'primary', title: `Add a line for ${who}`, onclick: () => addStep('line', at, { who }) }, 'Says…'),
        el('button', { 'aria-pressed': String(has('Smile')), onclick: () => exprStep(toggled('Smile')) }, 'Smile'),
        el('button', { 'aria-pressed': String(has('CloseEyes')), onclick: () => exprStep(toggled('CloseEyes')) }, 'Eyes closed'),
        ex.length ? el('button', { onclick: () => exprStep([]) }, 'Normal face') : null,
        el('button', { onclick: () => addStep('bop', at, { who }) }, 'Bop'),
        moveBtn,
        el('button', { onclick: () => addStep('mirror', at, { who }) }, 'Turn'),
        el('button', { onclick: () => addStep('leave', at, { who }) }, 'Leave'))));
  }
  box.append(el('button', { class: 'card add', onclick: () => addStep('enter', at) }, '+ Bring someone in'));
}
function openPosMenu(anchor, cb) {
  const m = $('insMenu');
  m.innerHTML = `<div class="grp"><div class="gl">Move to</div><div class="row">${POSITIONS.map(([p, l]) => `<button data-pos="${p}">${esc(l)}</button>`).join('')}</div></div><div class="row"><span style="flex:1"></span><button class="menu-close" data-close="1">Close</button></div>`;
  m.hidden = false; menuAt = { pos: cb };
  const r = anchor.getBoundingClientRect();
  m.style.left = Math.max(8, Math.min(r.left, innerWidth - m.offsetWidth - 8)) + 'px';
  m.style.top = Math.min(r.bottom + 6, innerHeight - m.offsetHeight - 8) + 'px';
  m.querySelector('button').focus({ preventScroll: true });
}

// ---------------------------------------------------------------------------
// Inspector: controls
// ---------------------------------------------------------------------------
function upd(fn, opts) { const i = sel; change(() => fn(doc.steps[i]), opts); }
function fld(label, ...controls) { return el('div', { class: 'fld' }, el('div', { class: 'lab' }, label), ...controls); }
function seg(options, current, onPick, opts) {
  opts = opts || {};
  const d = el('div', { class: 'seg', role: 'group' });
  for (const [v, l] of options) d.append(el('button', { 'aria-pressed': String(v === current || (v == null && current == null)), title: opts.titles ? opts.titles[v] : null, onclick: () => onPick(v) }, l));
  return d;
}
function check(label, value, onChange) {
  const id = 'c' + Math.random().toString(36).slice(2);
  return el('label', { class: 'check', for: id }, el('input', { type: 'checkbox', id, checked: value, onchange: e => onChange(e.target.checked) }), el('span', {}, label));
}
function numInput(value, onChange, opts) {
  opts = opts || {};
  return el('input', { type: 'number', value: value == null ? '' : value, min: opts.min, max: opts.max, step: opts.step, placeholder: opts.placeholder, 'aria-label': opts.label,
    oninput: e => { const v = e.target.value === '' ? null : Number(e.target.value); if (v === null || Number.isFinite(v)) onChange(v); } });
}
function textInput(value, onInput, opts) {
  opts = opts || {};
  return el('input', { type: 'text', value: value || '', placeholder: opts.placeholder, spellcheck: opts.spell ? 'true' : 'false', style: 'width:100%', 'aria-label': opts.label, oninput: e => onInput(e.target.value) });
}
function assetButton(kind, value, onPick) {
  let img = null;
  if (kind === 'portrait') { const u = faceURL(value, null, true); if (u) img = el('img', { src: u, alt: '' }); }
  if (kind === 'bg') { const u = bgURL(value, 120); if (u) img = el('img', { src: u, alt: '' }); }
  const missing = value && ((kind === 'portrait' && !portraitAsset(value)) || (kind === 'bg' && !ciFind(A.backgrounds, value)) ||
    (kind === 'music' && !ciIn(A.manifest.music, value)) || (kind === 'sfx' && !ciIn(A.manifest.sfx, value)));
  return el('button', { class: 'assetbtn', onclick: () => openPicker(kind, value, onPick) }, img,
    el('span', {}, el('div', { class: 'an' }, value || 'Choose…'), el('div', { class: 'ch' }, missing ? 'not in the loaded assets · change…' : value ? 'Change…' : '')));
}
// Character chooser: everyone in this conversation, stage first, plus "Other…"
function whoPicker(value, onPick, at) {
  const on = [...sceneAfter(doc, at).keys()];
  const names = [...new Set([...on, ...castOf(doc)])].filter(Boolean);
  const d = el('div', { class: 'chips' });
  for (const n of names) {
    const u = faceURL(n);
    d.append(el('button', { class: 'chip' + (u ? '' : ' text'), 'aria-pressed': String(n === value), title: on.includes(n) ? 'On stage' : 'Not on stage at this point', onclick: () => onPick(n) },
      u ? el('img', { src: u, alt: '' }) : null, n + (on.includes(n) ? '' : ' ·off')));
  }
  d.append(el('button', { class: 'chip text', onclick: () => openPicker('portrait', value, onPick) }, 'Other…'));
  return d;
}
function exprPicker(who, expr, onPick) {
  const cv = el('canvas', { width: 96, height: 80, 'aria-label': 'Face preview' });
  const a = portraitAsset(who);
  const draw = ex => { const buf = document.createElement('canvas'); composeFace(buf, a, who, new Set(ex), -1, 0); cv.width = buf.width; cv.height = buf.height; cv.getContext('2d').drawImage(buf, 0, 0); };
  draw(expr);
  const toggles = el('div', { class: 'seg' },
    el('button', { 'aria-pressed': String(!expr.length), onclick: () => onPick([]) }, 'Normal'),
    ...EXPRESSIONS.map(([v, l]) => el('button', { 'aria-pressed': String(expr.includes(v)),
      onclick: () => {
        const eyes = ['CloseEyes', 'HalfCloseEyes', 'LeftWink', 'RightWink', 'OpenEyes'];
        let next = expr.includes(v) ? expr.filter(x => x !== v) : [...expr.filter(x => !(eyes.includes(v) && eyes.includes(x))), v];
        onPick(next);
      } }, l)));
  return el('div', { class: 'facepv' }, a ? cv : null, toggles);
}
function stepFoot(i) {
  return el('div', { class: 'foot' },
    el('button', { disabled: i === 0, onclick: () => nudge(i, -1), title: 'Move up (Alt+↑)' }, '↑ Up'),
    el('button', { disabled: i >= doc.steps.length - 1, onclick: () => nudge(i, 1), title: 'Move down (Alt+↓)' }, '↓ Down'),
    el('button', { onclick: () => duplicateStep(i) }, 'Duplicate'),
    el('span', { class: 'spacer' }),
    el('button', { class: 'danger', onclick: () => deleteStep(i), title: 'Delete (Del)' }, 'Delete'));
}
function togetherCheck(s) {
  return check('Happens at the same time as the next step (doesn’t wait for this to finish)', !!s.together, v => upd(x => { x.together = v; }));
}

// ---------------------------------------------------------------------------
// Inspector per step kind
// ---------------------------------------------------------------------------
function renderInspector() {
  const box = $('insp'); box.innerHTML = '';
  const s = doc.steps[sel];
  if (!s) {
    box.append(el('div', { class: 'empty' }, 'Nothing here yet. Start with ', el('b', {}, 'New conversation…'), ' at the top, or add a step with the buttons above.'));
    return;
  }
  const K = KINDS[s.k] || KINDS.raw;
  box.append(el('h3', {}, K.label, el('span', { class: 'n' }, `step ${sel + 1} of ${doc.steps.length}`)));
  const at = sel - 1; // stage as it is before this step
  const f = INSPECTORS[s.k] || INSPECTORS.raw;
  box.append(...[].concat(f(s, at)).filter(Boolean));
  box.append(stepFoot(sel));
}
const INSPECTORS = {
  line(s, at) {
    const ta = el('textarea', { class: 'linetext', value: s.text || '', placeholder: `What does ${s.who || 'they'} say?`, 'aria-label': 'Line text', spellcheck: 'true' });
    ta.addEventListener('input', () => upd(x => { x.text = ta.value; }, { key: 'text' + s.id, keepInspector: true }));
    ta.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        const t = ta.value.trim();
        if (/^(\.{2,}|…)$/.test(t)) upd(x => { x.silent = true; x.text = '...'; }, { keepInspector: true });
        addStep('line', sel + 1);
      }
    });
    const wrap = (open, close) => {
      const a = ta.selectionStart, b = ta.selectionEnd;
      if (a === b) { toast('Select some words in the line first'); ta.focus(); return; }
      ta.value = ta.value.slice(0, a) + open + ta.value.slice(a, b) + close + ta.value.slice(b);
      ta.setSelectionRange(a + open.length, b + open.length); ta.focus();
      ta.dispatchEvent(new Event('input'));
    };
    const clear = () => {
      let a = ta.selectionStart, b = ta.selectionEnd; if (a === b) { a = 0; b = ta.value.length; }
      ta.value = ta.value.slice(0, a) + ta.value.slice(a, b).replace(/<[^<>]*>/g, '') + ta.value.slice(b);
      ta.focus(); ta.dispatchEvent(new Event('input'));
    };
    const bar = el('div', { class: 'stylebar' });
    for (const c of colorNames()) {
      if (c === (A.fonts.convo && A.fonts.convo.default_color)) continue;
      bar.append(el('button', { class: 'sw', style: `background:${paletteCss(c)}`, title: c + (fontHasColor(c) ? '' : ' (the game font needs this colour added)'), 'aria-label': 'Colour ' + c,
        onmousedown: e => e.preventDefault(), onclick: () => wrap(`<${c}>`, '</>') }));
    }
    bar.append(el('span', { class: 'sep' }),
      el('button', { title: 'Italic font', onmousedown: e => e.preventDefault(), onclick: () => wrap('<iconvo>', '</>') }, el('i', {}, 'Italic')),
      el('button', { title: 'Bold font', onmousedown: e => e.preventDefault(), onclick: () => wrap('<bconvo>', '</>') }, el('b', {}, 'Bold')),
      el('button', { title: 'Wavy text', onmousedown: e => e.preventDefault(), onclick: () => wrap('<wave>', '</>') }, '∿ Wave'),
      el('button', { title: 'Shaky text', onmousedown: e => e.preventDefault(), onclick: () => wrap('<jitter>', '</>') }, '≈ Shaky'),
      el('button', { title: 'Short pause while typing', onmousedown: e => e.preventDefault(), onclick: () => { const a = ta.selectionStart; ta.value = ta.value.slice(0, a) + '{p}' + ta.value.slice(a); ta.focus(); ta.dispatchEvent(new Event('input')); } }, '⏸ Pause'),
      el('button', { title: 'Remove styling from the selection (or the whole line)', onmousedown: e => e.preventDefault(), onclick: clear }, 'Clear style'));
    const voice = voiceOf(s);
    const setVoice = v => upd(x => {
      x.font = 'convo'; x.color = ''; x.box = '';
      if (v === 'whisper') x.color = doc.whisper || 'grey';
      if (v === 'italic') x.font = 'iconvo';
      if (v === 'shout') x.font = 'bconvo';
      if (v === 'thought') x.box = 'thought';
      if (v === 'narration') x.box = 'narration';
    });
    const colorSel = el('select', { 'aria-label': 'Whole line colour', onchange: e => upd(x => { x.color = e.target.value; }) },
      el('option', { value: '' }, 'Default colour'), ...colorNames().map(c => el('option', { value: c, selected: c === s.color ? true : null }, c + (fontHasColor(c) ? '' : ' *'))));
    colorSel.value = s.color || '';
    const fontSel = el('select', { 'aria-label': 'Whole line font', onchange: e => upd(x => { x.font = e.target.value; }) },
      ...[['convo', 'Regular font'], ['iconvo', 'Italic font'], ['bconvo', 'Bold font'], ['nconvo', 'Narrow font']].map(([v, l]) => el('option', { value: v }, l)));
    fontSel.value = s.font || 'convo';
    const before = el('div', { class: 'row' }, el('span', { class: 'hint' }, 'Before this line:'),
      ...[['Smile', ['Smile']], ['Normal face', []], ['Eyes closed', ['CloseEyes']]].map(([l, ex]) =>
        el('button', { onclick: () => addStep('expr', sel, { who: s.who, expr: ex, keepSel: sel + 1 }, () => {}) }, l)),
      el('button', { onclick: () => addStep('bop', sel, { who: s.who, keepSel: sel + 1 }, () => {}) }, 'Bop'),
      el('button', { onclick: () => addStep('sound', sel, { keepSel: sel + 1 }, () => {}) }, 'Sound'));
    return [
      fld('Who speaks', whoPicker(s.who, v => upd(x => { x.who = v; }), at)),
      fld('Line', bar, ta, el('div', { class: 'hint' }, el('kbd', {}, 'Enter'), ' next line (the other person) · ', el('kbd', {}, 'Shift'), '+', el('kbd', {}, 'Enter'), ' new line in the box (waits for a click) · select words, then click a colour or style')),
      fld('Voice', seg(VOICES, voice, setVoice), el('div', { class: 'row' }, fontSel, colorSel,
        s.color && !fontHasColor(s.color) ? el('span', { class: 'hint' }, `* “${s.color}” isn’t in the game font yet`) : null)),
      fld('Options',
        check('Mouth doesn’t move (a silent “...”)', !!s.silent, v => upd(x => { x.silent = v; })),
        check('Bubble stays up after this line', !!s.hold, v => upd(x => { x.hold = v; })),
        togetherCheck(s)),
      before,
    ];
  },
  enter(s, at) {
    return [
      fld('Who', el('div', { class: 'row' }, assetButton('portrait', s.who, v => upd(x => { x.who = v; })))),
      fld('Where', seg(POSITIONS, s.pos, v => upd(x => { x.pos = v; }))),
      fld('How they come in', seg(HOW_ENTER, s.how || 'fade', v => upd(x => { x.how = v; }))),
      s.how !== 'instant' ? fld('Speed', el('div', { class: 'row' }, seg([[0.5, 'Slow'], [null, 'Normal'], [2, 'Fast']], s.speed, v => upd(x => { x.speed = v; })),
        numInput(s.speed, v => upd(x => { x.speed = v; }, { key: 'sp' + s.id, keepInspector: true }), { step: 0.1, min: 0.1, placeholder: '×1', label: 'Speed multiplier' }))) : null,
      fld('Face', exprPicker(s.who, s.expr || [], v => upd(x => { x.expr = v; }))),
      fld('Options', check('Faces the other way', !!s.mirror, v => upd(x => { x.mirror = v; })), s.how !== 'instant' ? togetherCheck(s) : null),
    ];
  },
  enterMany(s, at) {
    const rows = (s.list || []).map((p, j) => el('div', { class: 'row' },
      assetButton('portrait', p.who, v => upd(x => { x.list[j].who = v; })),
      seg(POSITIONS, p.pos, v => upd(x => { x.list[j].pos = v; })),
      s.list.length > 1 ? el('button', { class: 'ghost', title: 'Remove', onclick: () => upd(x => { x.list.splice(j, 1); }) }, '✕') : null));
    return [fld('Who comes in together', ...rows,
      (s.list || []).length < 4 ? el('div', {}, el('button', { onclick: () => upd(x => { x.list.push({ who: '', pos: 'Left' }); }) }, '+ Add someone')) : null)];
  },
  leave(s, at) {
    return [
      fld('Who', whoPicker(s.who, v => upd(x => { x.who = v; }), at)),
      fld('How they leave', seg(HOW_LEAVE, s.how || 'fade', v => upd(x => { x.how = v; }))),
      s.how !== 'instant' ? fld('Speed', el('div', { class: 'row' }, seg([[0.4, 'Storm off'], [0.6, 'Slow'], [null, 'Normal'], [2, 'Fast']], s.speed, v => upd(x => { x.speed = v; })),
        numInput(s.speed, v => upd(x => { x.speed = v; }, { key: 'sp' + s.id, keepInspector: true }), { step: 0.1, min: 0.1, placeholder: '×1', label: 'Speed multiplier' }))) : null,
      (s.how === 'walkL' || s.how === 'walkR') ? el('div', { class: 'hint' }, 'Walking off keeps them just off screen (your storm-off pattern); the closing “leave together” step removes them.') : null,
      s.how !== 'instant' ? fld('Options', togetherCheck(s)) : null,
    ];
  },
  leaveMany(s, at) {
    const on = [...new Set([...sceneAfter(doc, at).keys(), ...castOf(doc)])].filter(Boolean);
    return [fld('Who leaves together', el('div', { class: 'chips' }, ...on.map(n => el('button', { class: 'chip text', 'aria-pressed': String((s.list || []).includes(n)),
      onclick: () => upd(x => { x.list = x.list.includes(n) ? x.list.filter(w => w !== n) : [...x.list, n]; }) }, n))))];
  },
  move(s, at) {
    return [
      fld('Who', whoPicker(s.who, v => upd(x => { x.who = v; }), at)),
      fld('Moves to', seg(POSITIONS, s.pos, v => upd(x => { x.pos = v; }))),
      fld('Speed', el('div', { class: 'row' }, seg([[0.5, 'Slow'], [null, 'Normal'], [2, 'Fast']], s.speed, v => upd(x => { x.speed = v; })),
        numInput(s.speed, v => upd(x => { x.speed = v; }, { key: 'sp' + s.id, keepInspector: true }), { step: 0.1, min: 0.1, placeholder: '×1', label: 'Speed multiplier' }))),
      fld('Options', togetherCheck(s)),
    ];
  },
  expr(s, at) {
    return [fld('Who', whoPicker(s.who, v => upd(x => { x.who = v; }), at)),
      fld('Face', exprPicker(s.who, s.expr || [], v => upd(x => { x.expr = v; })))];
  },
  bop(s, at) {
    return [fld('Who', whoPicker(s.who, v => upd(x => { x.who = v; }), at)),
      fld('Bops', el('div', { class: 'row' }, seg([[1, '1'], [2, '2'], [3, '3 (shock)'], [5, '5']], s.n || 2, v => upd(x => { x.n = v; })),
        numInput(s.n, v => upd(x => { x.n = v || 2; }, { key: 'n' + s.id, keepInspector: true }), { min: 1, max: 20, label: 'Number of bops' }))),
      fld('Speed of each bop (ms)', el('div', { class: 'row' }, seg([[15, 'Frantic (15)'], [null, 'Normal'], [250, 'Slow (250)']], s.ms, v => upd(x => { x.ms = v; })),
        numInput(s.ms, v => upd(x => { x.ms = v; }, { key: 'ms' + s.id, keepInspector: true }), { min: 1, placeholder: '132', label: 'Milliseconds per bop' }))),
      fld('Options', togetherCheck(s))];
  },
  mirror(s, at) {
    return [fld('Who', whoPicker(s.who, v => upd(x => { x.who = v; }), at)),
      fld('Speed', numInput(s.speed, v => upd(x => { x.speed = v; }, { key: 'sp' + s.id, keepInspector: true }), { step: 0.5, min: 0.1, placeholder: 'normal', label: 'Speed' }))];
  },
  bg(s) {
    return [fld('Background', el('div', { class: 'row' }, assetButton('bg', s.bg, v => upd(x => { x.bg = v; })))),
      fld('Options', check('Keep the portraits that are on screen', !!s.keep, v => upd(x => { x.keep = v; })))];
  },
  transition(s) {
    return [fld('Direction', seg([['close', 'Fade to black'], ['open', 'Fade in from black']], s.dir, v => upd(x => { x.dir = v; }))),
      fld('Length (ms)', el('div', { class: 'row' }, seg([[500, '500'], [1000, '1000'], [2000, '2000']], s.ms, v => upd(x => { x.ms = v; })),
        numInput(s.ms, v => upd(x => { x.ms = v; }, { key: 'ms' + s.id, keepInspector: true }), { min: 0, step: 50, label: 'Milliseconds' }))),
      fld('Options', togetherCheck(s))];
  },
  card(s) { return [fld('Text', textInput(s.text, v => upd(x => { x.text = v; }, { key: 't' + s.id, keepInspector: true }), { placeholder: 'e.g. The training yard', spell: true }))]; },
  shake(s) {
    return [fld('Length (ms)', el('div', { class: 'row' }, seg([[300, 'Rumble (300)'], [400, 'Shock (400)'], [800, 'Big (800)']], s.ms, v => upd(x => { x.ms = v; })),
      numInput(s.ms, v => upd(x => { x.ms = v || 300; }, { key: 'ms' + s.id, keepInspector: true }), { min: 1, step: 50, label: 'Milliseconds' }))), fld('Options', togetherCheck(s))];
  },
  wait(s) {
    return [fld('Pause (ms)', el('div', { class: 'row' }, seg([[250, 'Beat (250)'], [500, '500'], [1000, '1000']], s.ms, v => upd(x => { x.ms = v; })),
      numInput(s.ms, v => upd(x => { x.ms = v || 500; }, { key: 'ms' + s.id, keepInspector: true }), { min: 1, step: 50, label: 'Milliseconds' })))];
  },
  music(s) {
    return [fld('Track', el('div', { class: 'row' }, assetButton('music', s.nid, v => upd(x => { x.nid = v; })),
      s.nid ? el('button', { onclick: () => { if (audio.musicNid && audio.musicNid.toLowerCase() === s.nid.toLowerCase()) audio.stopMusic(300); else audio.playMusic(s.nid, 300); } }, '▶ / ■ Listen') : null)),
    fld('Fade in (ms)', el('div', { class: 'row' }, seg([[50, 'Project standard (50)'], [null, 'None'], [1000, '1000']], s.fade, v => upd(x => { x.fade = v; })),
      numInput(s.fade, v => upd(x => { x.fade = v; }, { key: 'f' + s.id, keepInspector: true }), { min: 0, step: 50, label: 'Milliseconds' }))),
    fld('Volume this time', musicVolumeControl(s, false))];
  },
  musicOff(s) {
    return [fld('What happens', seg([['clear', 'Music fades out'], ['back', 'Back to the previous track']], s.mode || 'clear', v => upd(x => { x.mode = v; }))),
      fld('Fade (ms)', el('div', { class: 'row' }, seg([[2000, 'Project standard (2000)'], [400, '400'], [null, 'Default']], s.fade, v => upd(x => { x.fade = v; })),
        numInput(s.fade, v => upd(x => { x.fade = v; }, { key: 'f' + s.id, keepInspector: true }), { min: 0, step: 100, label: 'Milliseconds' })))];
  },
  sound(s) {
    return [fld('Sound', el('div', { class: 'row' }, assetButton('sfx', s.nid, v => upd(x => { x.nid = v; })),
      s.nid ? el('button', { onclick: () => audio.playSfx(s.nid, s.vol) }, '▶ Listen') : null)),
    fld('Volume', el('div', { class: 'row' }, el('input', { type: 'range', min: 0, max: 1, step: 0.05, value: s.vol == null ? 1 : s.vol, style: 'accent-color:var(--ember)',
      oninput: e => upd(x => { x.vol = +e.target.value === 1 ? null : +e.target.value; }, { key: 'v' + s.id, keepInspector: true }) }),
      el('span', { class: 'hint' }, 'full volume unless lowered')))];
  },
  note(s) {
    const ta = el('textarea', { value: s.text || '', placeholder: 'A reminder for yourself. Goes into the code as a # comment and does nothing in game.', 'aria-label': 'Note' });
    ta.addEventListener('input', () => upd(x => { x.text = ta.value; }, { key: 'n' + s.id, keepInspector: true }));
    return [fld('Note', ta)];
  },
  raw(s) {
    const ta = el('textarea', { class: 'code', value: s.code || '', spellcheck: 'false', placeholder: 'Any event command, e.g. give_item;Eirika;Vulnerary', 'aria-label': 'Event code' });
    ta.addEventListener('input', () => upd(x => { x.code = ta.value; }, { key: 'r' + s.id, keepInspector: true }));
    return [fld('Event code', ta, el('div', { class: 'hint' }, 'Kept exactly as written. If it’s something the builder knows, use Edit code → Done and it becomes a normal step.'))];
  },
  end() { return [el('div', { class: 'hint' }, 'Ends the event. Anything after this won’t run.')]; },
  choice(s, at) { return [el('div', { class: 'hint' }, 'Shows a menu; the answer picks which path runs next.'), ...choiceEditor(s, at + 1)]; },
  if(s, at) { return armEditor(s, at + 1); },
  elif(s, at) { return armEditor(s, at + 1); },
  else(s, at) { return armEditor(s, at + 1); },
  join(s, at) { return joinEditor(s, at + 1); },
};

// ---------------------------------------------------------------------------
// Event code panel
// ---------------------------------------------------------------------------
function codeLineHtml(line) {
  if (!line.trim()) return '&#8203;';
  if (line.trim().startsWith('#')) return `<span class="c-cm">${esc(line)}</span>`;
  const i = line.indexOf(';');
  const cmd = i < 0 ? line : line.slice(0, i), rest = i < 0 ? '' : line.slice(i);
  const r = esc(rest).replace(/(&lt;[^&]*?&gt;|\{[^}]*\})/g, '<span class="c-tag">$1</span>').replace(/;([A-Za-z]+)=/g, ';<span class="c-kw">$1</span>=');
  return `<span class="c-cmd">${esc(cmd)}</span>${r}`;
}
function renderCode() {
  const r = gen.ranges[sel] || [-1, -2];
  $('codeView').innerHTML = gen.code.split('\n').map((l, n) => `<div class="cl${n >= r[0] && n <= r[1] ? ' sel' : ''}" data-line="${n}"><span>${codeLineHtml(l)}</span></div>`).join('');
}
let codeTimer = null;
function startCodeEdit() {
  codeEditing = true;
  hist.past.push(snap()); hist.future = []; hist.key = 'codeedit';
  const ta = $('codeEdit'); ta.value = gen.code; ta.hidden = false; $('codeWrap').hidden = true;
  $('bEditCode').textContent = 'Done'; $('bEditCode').classList.add('primary'); $('bCopy').classList.remove('primary');
  const r = gen.ranges[sel]; editLineMap = gen.ranges.map(x => x[0]);
  ta.focus();
  if (r) { const lines = ta.value.split('\n'); let pos = 0; for (let k = 0; k < r[0]; k++) pos += lines[k].length + 1; ta.setSelectionRange(pos, pos); }
}
function applyCodeEdit() {
  const ta = $('codeEdit');
  const steps = codeToSteps(ta.value, doc);
  editLineMap = steps.map(s => s._l); for (const s of steps) delete s._l;
  doc.steps = steps;
  followCursor(false);
  refresh();
}
function followCursor(render) {
  const ta = $('codeEdit');
  const line = ta.value.slice(0, ta.selectionStart).split('\n').length - 1;
  let i = 0; for (let k = 0; k < editLineMap.length; k++) if (editLineMap[k] <= line) i = k;
  if (i !== sel) { sel = i; if (render) select(i); }
}
function endCodeEdit() {
  clearTimeout(codeTimer);
  applyCodeEdit();
  codeEditing = false;
  $('codeEdit').hidden = true; $('codeWrap').hidden = false;
  $('bEditCode').textContent = 'Edit code'; $('bEditCode').classList.remove('primary'); $('bCopy').classList.add('primary');
  hist.key = null;
  refresh();
}

// ---------------------------------------------------------------------------
// Checks: things that would break or look wrong in the game
// ---------------------------------------------------------------------------
const KNOWN = new Set(['change_background', 'transition', 'add_portrait', 'multi_add_portrait', 'remove_portrait', 'multi_remove_portrait',
  'remove_all_portraits', 'move_portrait', 'bop_portrait', 'mirror_portrait', 'expression', 'speak', 'unhold', 'wait', 'music',
  'music_fade_back', 'music_clear', 'sound', 'screen_shake', 'location_card', 'end', 'if', 'elif', 'else', 'endif', 'choice']);
function validateDoc() {
  const out = [];
  const cmds = parseScript(gen.code);
  const exists = new Set();
  const convo = A.fonts.convo; const pal = convo ? Object.keys(convo.palettes || {}) : [];
  const noColor = c => `The game font has no “${c}” colour yet, so this shows in the normal colour in game. Add a ${c} palette to the convo font, or pick another colour${c === doc.whisper ? ' for whispers under Word colors' : ''}.`;
  const cflow = analyzeFlow(cmds.length, i => { const n = cmds[i].name; return n === 'if' || n === 'elif' || n === 'else' || n === 'end' ? n : null; });
  const stack = [];   // per open branch: who was on stage before it, and after each path
  cmds.forEach((c, ci) => {
    const push = msg => out.push({ step: gen.lineStep[c.line], line: c.line, msg });
    const a = c.args;
    const blk = cflow.owner[ci];
    if (blk && blk.end != null) {
      if (c.name === 'if') { stack.push({ before: new Set(exists), after: [] }); return; }
      const top = stack[stack.length - 1];
      if (top && (c.name === 'elif' || c.name === 'else')) { top.after.push(new Set(exists)); exists.clear(); for (const x of top.before) exists.add(x); return; }
      if (top && c.name === 'end') {
        stack.pop(); top.after.push(new Set(exists));
        if (!blk.hasElse) top.after.push(top.before);
        exists.clear(); for (const set of top.after) for (const x of set) exists.add(x);   // on stage in any path counts
        return;
      }
    }
    if (c.name === 'end' && c.raw === 'end;' && stack.length) push('“End” inside a branch closes the branch in game, not the event.');
    if (!KNOWN.has(c.name) && !NO_PREVIEW.has(c.name)) push(`“${c.name}” isn’t shown in this preview (it still runs in the game if it’s a real command).`);
    switch (c.name) {
      case 'add_portrait':
        if (!a[0]) push('Choose who comes in.');
        else if (!portraitAsset(a[0])) push(`No portrait called “${a[0]}” in the loaded assets.`);
        exists.add(a[0]); break;
      case 'multi_add_portrait':
        for (let i = 0; i < a.length; i += 2) { if (!a[i]) push('Choose who comes in.'); else if (!portraitAsset(a[i])) push(`No portrait called “${a[i]}” in the loaded assets.`); exists.add(a[i]); }
        break;
      case 'remove_portrait': if (!exists.has(a[0])) push(`${a[0] || 'Someone'} isn’t on stage here.`); exists.delete(a[0]); break;
      case 'multi_remove_portrait': for (const n of a) { if (!exists.has(n)) push(`${n || 'Someone'} isn’t on stage here.`); exists.delete(n); } break;
      case 'remove_all_portraits': exists.clear(); break;
      case 'move_portrait': case 'expression': case 'bop_portrait': case 'mirror_portrait':
        if (!exists.has(a[0])) push(`${a[0] || 'Someone'} isn’t on stage here.`); break;
      case 'change_background':
        if (!a[0]) push('Choose a background.'); else if (!ciFind(A.backgrounds, a[0])) push(`Background “${a[0]}” isn’t in the loaded assets.`);
        if (!c.flags.has('keep_portraits')) exists.clear(); break;
      case 'music': if (!a[0]) push('Choose a track.'); else if (!ciIn(A.manifest.music, a[0])) push(`Music “${a[0]}” isn’t in the loaded assets.`); break;
      case 'sound': if (!a[0]) push('Choose a sound.'); else if (!ciIn(A.manifest.sfx, a[0])) push(`Sound “${a[0]}” isn’t in the loaded assets.`); break;
      case 'speak': {
        const text = a[1] || '';
        if (!text.trim()) push('This line has no text yet.');
        const narration = /^narration/.test(c.kw.StyleNid || '');
        if (a[0] && !narration && !exists.has(a[0])) push(`${a[0]} speaks but isn’t on stage, so the bubble has nobody to point at.`);
        if (c.kw.FontColor && pal.length && !pal.includes(c.kw.FontColor)) push(noColor(c.kw.FontColor));
        for (const m of text.matchAll(/<([A-Za-z_-]+)>/g)) {
          const id = m[1];
          if (A.fonts[id] || TEXT_FX.has(id) || /^[bin]?convo$/.test(id) || id === 'icon') continue;
          if (pal.includes(id)) continue;
          push(EXTRA_PALETTES[id] ? noColor(id) : `“<${id}>” isn’t a colour, font or effect the game knows.`);
        }
        const plain = text.replace(/<[^<>]*>|\{[^{}]*\}|\|/g, '');
        const miss = missingGlyphs(plain, c.kw.FontType || 'convo');
        if (miss.length) push(`The game font has no ${miss.map(ch => `“${ch}”`).join(' ')} (blank in game).`);
        break;
      }
      case 'choice': {
        const opts = String(a[2] || '').split(',').map(x => x.trim()).filter(Boolean);
        if (!a[0]) push('The choice needs an ID (the variable that remembers the answer).');
        if (opts.length < 2) push('A choice needs at least two answers.');
        break;
      }
    }
  });
  for (const e of (chainFlow || stepFlow(doc)).errors) out.push({ step: e.i, line: (gen.ranges[e.i] || [0])[0], msg: e.msg });
  problems = out;
  problemsByStep = new Map();
  for (const p of out) { if (!problemsByStep.has(p.step)) problemsByStep.set(p.step, []); problemsByStep.get(p.step).push(p.msg); }
}
function renderProblems() {
  const box = $('problems'); box.innerHTML = '';
  for (const p of problems.slice(0, 50)) box.append(el('button', { class: 'problem', onclick: () => select(p.step) }, `Step ${p.step + 1}: ${p.msg}`));
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------
const player = makePlayer($('screen'), {
  onCommand(c) { markPlaying(gen.lineStep[c.line]); },
  previewVars() { const v = {}; for (const [k, x] of Object.entries(doc.preview || {})) if (x !== '' && x != null) v[k] = x; return v; },
  armPick(line) { const s = doc.steps[gen.lineStep[line]]; return s && s.pv != null ? s.pv : null; },
  onChoice(nid, opt) { status(`Picked “${opt}”.`); },
  onEnd() { mode = 'ended'; setTransport(); status('Finished. Press ▶ to watch again.'); markPlaying(null); },
  warn: toast,
});
function status(t) { $('status').textContent = t; }
function setTransport() {
  const playing = mode === 'play';
  $('bStop').hidden = mode === 'still'; $('bNext').hidden = !playing;
}
function showStill() {
  player.load(gen.code);
  if (!doc.steps.length) { player.reset(); status(''); return; }
  const r = gen.ranges[sel];
  player.still(r ? r[1] : -1);
  const s = doc.steps[sel];
  if (s && s.k === 'card' && player.scene) { player.scene.card = s.text; player.scene.cardUntil = Infinity; }
  status(isPhone() ? `Step ${sel + 1} of ${doc.steps.length}. Tap the picture to play from here.` : `Step ${sel + 1} of ${doc.steps.length}: the scene right after this step. Click the picture or press P to play from here.`);
}
let playingStep = null;
function markPlaying(i) {
  if (playingStep === i) return;
  playingStep = i;
  document.querySelectorAll('.bub.playing, .cl.playing').forEach(x => x.classList.remove('playing'));
  if (i == null) return;
  const b = $('chain').querySelector(`.bub[data-i="${i}"]`);
  if (b) {
    b.classList.add('playing');
    if (isTimeline()) { const w = $('chainWrap'), r = b.getBoundingClientRect(), wr = w.getBoundingClientRect(); w.scrollTo({ left: w.scrollLeft + (r.left - wr.left) - (w.clientWidth - r.width) / 2, top: w.scrollTop + (r.top - wr.top) - Math.max(0, (w.clientHeight - r.height) / 2), behavior: 'smooth' }); }
    else keepVisible(b);
  }
  const r = gen.ranges[i]; if (r) for (let n = r[0]; n <= r[1]; n++) { const l = $('codeView').querySelector(`.cl[data-line="${n}"]`); if (l) l.classList.add('playing'); }
  status(isPhone() ? `Playing step ${i + 1}… tap the picture to advance.` : `Playing step ${i + 1} of ${doc.steps.length}… click the picture or press Space to advance.`);
}
function playFrom(i) {
  if (!doc.steps.length) return;
  mode = 'play'; setTransport();
  player.load(gen.code);
  const r = gen.ranges[i];
  player.start(r ? r[0] : 0);
}
function stopPlay() {
  if (mode === 'still') return;
  mode = 'still'; audio.stopAll(); markPlaying(null); setTransport(); needsStill = true;
}

// ---------------------------------------------------------------------------
// Asset picker (large previews)
// ---------------------------------------------------------------------------
const picker = { kind: null, value: null, onPick: null, pv: null, cv: null, talk: false };
const PK_TITLES = { portrait: 'Choose a portrait', bg: 'Choose a background', music: 'Choose music', sfx: 'Choose a sound effect' };
function pickerItems(kind) {
  if (kind === 'portrait') {
    // the project's characters first (what events normally name), then any
    // portrait no character uses
    const units = Object.values(A.units).filter(u => portraitFor(u.nid)).map(u => u.nid);
    const used = new Set(units.map(n => portraitKeyFor(n)));
    return units.concat(A.manifest.portraits.map(p => p.nid).filter(n => !used.has(n)));
  }
  if (kind === 'bg') return A.manifest.backgrounds.slice();
  if (kind === 'music') return A.manifest.music.slice();
  return A.manifest.sfx.slice();
}
function openPicker(kind, current, onPick) {
  closeInsertMenu();
  Object.assign(picker, { kind, value: null, onPick, talk: false, pv: null });
  $('pkTitle').textContent = PK_TITLES[kind];
  $('pkSearch').value = ''; $('pkTyped').value = '';
  const items = pickerItems(kind);
  const found = items.find(n => n.toLowerCase() === String(current || '').toLowerCase());
  if (found) picker.value = found; else if (current) $('pkTyped').value = current;
  renderPickerGrid();
  renderPickerPreview();
  $('dPicker').showModal();
  setTimeout(() => { const t = $('pkGrid').querySelector('[aria-selected="true"]') || $('pkSearch'); t.focus({ preventScroll: true }); keepVisible(t); }, 0);
}
function renderPickerGrid() {
  const q = $('pkSearch').value.trim().toLowerCase();
  const kind = picker.kind; const g = $('pkGrid');
  g.className = 'pgrid' + (kind === 'bg' ? ' wide' : kind === 'music' || kind === 'sfx' ? ' list' : '');
  g.innerHTML = '';
  for (const n of pickerItems(kind).filter(n => !q || n.toLowerCase().includes(q) || (kind === 'portrait' && displayName(n).toLowerCase().includes(q)))) {
    let vis = null;
    if (kind === 'portrait') { const u = faceURL(n, null, true); vis = u ? el('img', { src: u, alt: '' }) : null; }
    if (kind === 'bg') { const u = bgURL(n, 150); vis = u ? el('img', { src: u, alt: '' }) : null; }
    if (kind === 'music' || kind === 'sfx') vis = el('span', { 'aria-hidden': 'true' }, kind === 'music' ? '♪' : '◎');
    const t = el('button', { class: 'tile' + (kind === 'music' || kind === 'sfx' ? ' aud' : ''), role: 'option', 'aria-selected': String(n === picker.value), 'data-n': n,
      onclick: () => { picker.value = n; $('pkTyped').value = ''; g.querySelectorAll('.tile').forEach(x => x.setAttribute('aria-selected', String(x.dataset.n === n))); renderPickerPreview(); if (kind === 'sfx') audio.playSfx(n); },
      ondblclick: () => usePicker() }, vis, el('span', {}, pickLabel(kind, n)));
    g.append(t);
  }
  if (!g.children.length) g.append(el('div', { class: 'hint' }, 'Nothing matches. You can type the ID below instead.'));
}
// Volume= on a music step (0..1, on top of the track's own volume from the
// Music editor). Changes apply to what's playing right away.
function musicVolumeControl(s, quick) {
  const track = s.nid ? audio.trackVolume(s.nid) : 1;
  const cur = s.vol == null ? 1 : s.vol;
  const out = el('span', { class: 'row', style: 'gap:6px;align-items:center' },
    el('input', { type: 'range', 'data-q': 'mvol', min: 0, max: 1, step: 0.05, value: cur, style: 'width:110px;accent-color:var(--ember)', 'aria-label': 'Music volume',
      oninput: e => { const v = +e.target.value; if (audio.music && s.nid && audio.musicNid && audio.musicNid.toLowerCase() === s.nid.toLowerCase()) audio.musicScale = track * v; e.target.nextSibling.textContent = Math.round(v * 100) + '%'; },
      onchange: e => (quick ? qUpd : (fn => upd(fn)))(x => { x.vol = +e.target.value === 1 ? null : +e.target.value; }) }),
    el('span', { class: 'hint' }, Math.round(cur * 100) + '%'),
    track !== 1 ? el('span', { class: 'hint', title: 'Set in the Music editor (fork); applies every time this track plays' }, `· track itself ${Math.round(track * 100)}%`) : null);
  return out;
}
function pickLabel(kind, n) {
  if (kind !== 'portrait') return n;
  const u = unitFor(n);
  return u && u.name && u.name !== n ? `${u.name} (${n})` : n;
}
function renderPickerPreview() {
  const p = $('pkPrev'); p.innerHTML = ''; picker.pv = null; picker.cv = null;
  const n = picker.value || $('pkTyped').value.trim();
  if (!n) { p.append(el('div', { class: 'hint' }, 'Click something on the left to see it large.')); return; }
  p.append(el('div', { class: 'pn' }, pickLabel(picker.kind, n)));
  if (picker.kind === 'portrait') {
    const cv = el('canvas', { width: 96, height: 80 }); picker.cv = cv;
    if (portraitAsset(n)) {
      picker.pv = new Portrait(n, 'Right', { immediate: true }); picker.pv.mirror = false;
      p.append(cv, seg([['', 'Normal'], ['Smile', 'Smile'], ['CloseEyes', 'Eyes closed'], ['talk', 'Talking']], picker.pvMode || '', v => { picker.pvMode = v; renderPickerPreview(); }));
      picker.pv.expr = new Set(picker.pvMode && picker.pvMode !== 'talk' ? [picker.pvMode] : []);
      picker.pv.talking = picker.pvMode === 'talk';
    } else p.append(el('div', { class: 'hint' }, 'Not in the loaded assets. The code will still use this ID; the game shows it if your project has it.'));
  } else if (picker.kind === 'bg') {
    const k = ciFind(A.backgrounds, n);
    if (k) { const cv = el('canvas', { width: 240, height: 160 }); const g = cv.getContext('2d'); g.imageSmoothingEnabled = false; g.drawImage(A.backgrounds[k], 0, 0); p.append(cv); }
    else p.append(el('div', { class: 'hint' }, 'Not in the loaded assets.'));
  } else if (picker.kind === 'music') {
    p.append(musicPlayer(n));
  } else {
    p.append(el('div', { class: 'row' }, el('button', { class: 'primary', onclick: () => audio.playSfx(n) }, '▶ Listen')),
      el('div', { class: 'hint' }, 'Plays at the SFX volume set under the preview.'));
  }
}
// A small music player for the picker: play/pause, seek, time, loop, and the
// volume the track will play at (its own volume from the Music editor).
const mp = { el: null, nid: null, ui: null };
function stopMusicPlayer() { if (mp.el) { mp.el.pause(); mp.el = null; } mp.nid = null; mp.ui = null; }
function fmtTime(sec) { if (!isFinite(sec)) return '--:--'; sec = Math.max(0, sec); return Math.floor(sec / 60) + ':' + String(Math.floor(sec % 60)).padStart(2, '0'); }
function musicPlayer(n) {
  const key = ciIn(A.manifest.music, n);
  if (!key) return el('div', { class: 'hint' }, 'Not in the loaded assets.');
  audio.stopAll();
  if (mp.nid !== key) { stopMusicPlayer(); mp.el = new Audio(A.source.url('music', key)); mp.nid = key; mp.el.loop = true; }
  const track = audio.trackVolume(key);
  let vol = 1;
  const apply = () => { if (mp.el) mp.el.volume = Math.max(0, Math.min(1, audio.musicVol * track * vol)); };
  apply();
  const play = el('button', { class: 'primary', style: 'min-width:84px', onclick: () => { if (!mp.el) return; if (mp.el.paused) mp.el.play().catch(() => {}); else mp.el.pause(); } }, '▶ Play');
  const stop = el('button', { onclick: () => { if (mp.el) { mp.el.pause(); mp.el.currentTime = 0; } } }, '■ Stop');
  const seek = el('input', { type: 'range', min: 0, max: 1000, value: 0, style: 'flex:1;accent-color:var(--ember)', 'aria-label': 'Position',
    oninput: e => { if (mp.el && isFinite(mp.el.duration)) mp.el.currentTime = mp.el.duration * (+e.target.value / 1000); } });
  const time = el('span', { class: 'hint', style: 'min-width:86px;text-align:right' }, '0:00 / --:--');
  const loop = el('label', { class: 'row hint', style: 'gap:4px' }, el('input', { type: 'checkbox', checked: true, onchange: e => { if (mp.el) mp.el.loop = e.target.checked; } }), 'Loop');
  const volLabel = el('span', { class: 'hint' }, '100%');
  const volSlider = el('input', { type: 'range', min: 0, max: 1, step: 0.05, value: 1, style: 'width:110px;accent-color:var(--ember)', 'aria-label': 'Try a volume',
    oninput: e => { vol = +e.target.value; volLabel.textContent = Math.round(vol * 100) + '%'; apply(); } });
  mp.ui = { play, seek, time };
  return el('div', { style: 'display:grid;gap:8px' },
    el('div', { class: 'row' }, play, stop, loop),
    el('div', { class: 'row', style: 'gap:8px' }, seek, time),
    el('div', { class: 'row', style: 'gap:6px' }, el('span', { class: 'hint' }, 'Try at'), volSlider, volLabel),
    el('div', { class: 'hint' }, track !== 1
      ? `This track's own volume is ${Math.round(track * 100)}% (set in the Music editor); it always plays at that. “Try at” previews a Volume= on the music step too.`
      : 'Plays at the Music volume under the preview. A loud track can be turned down for good in the fork’s Music editor (Track volume), or just here and there with the music step’s volume.'));
}
function musicPlayerTick() {
  if (!mp.el || !mp.ui) return;
  const d = mp.el.duration, t = mp.el.currentTime;
  mp.ui.play.textContent = mp.el.paused ? '▶ Play' : '❚❚ Pause';
  if (document.activeElement !== mp.ui.seek && isFinite(d) && d > 0) mp.ui.seek.value = Math.round(t / d * 1000);
  mp.ui.time.textContent = fmtTime(t) + ' / ' + fmtTime(d);
}
function pickerTick(now, dt) {
  if (!$('dPicker').open) { if (mp.el) stopMusicPlayer(); return; }
  musicPlayerTick();
  if (!picker.pv || !picker.cv) return;
  picker.pv.update(now, dt); picker.pv.compose();
  const b = picker.pv.buf; picker.cv.width = b.width; picker.cv.height = b.height;
  picker.cv.getContext('2d').drawImage(b, 0, 0);
}
function usePicker() {
  const v = $('pkTyped').value.trim() || picker.value;
  if (!v) { toast('Pick something, or type an ID'); return; }
  $('dPicker').close();
  stopMusicPlayer();
  if (picker.kind === 'music') audio.stopAll();
  const cb = picker.onPick; picker.onPick = null;
  if (cb) cb(v);
}

// ---------------------------------------------------------------------------
// Swap everywhere, word colours, new conversation
// ---------------------------------------------------------------------------
function renderSwap() {
  const body = $('swBody'); body.innerHTML = '';
  const u = assetUses(doc);
  const sections = [['who', 'Characters', 'portrait'], ['bg', 'Backgrounds', 'bg'], ['music', 'Music', 'music'], ['sound', 'Sound effects', 'sfx']];
  let any = false;
  for (const [key, title, kind] of sections) {
    if (!u[key].size) continue; any = true;
    body.append(el('h3', { style: 'margin:6px 0' }, title));
    for (const [name, count] of u[key]) {
      const vis = kind === 'portrait' ? faceURL(name) : kind === 'bg' ? bgURL(name, 60) : null;
      body.append(el('div', { class: 'row', style: 'margin:4px 0' },
        vis ? el('img', { src: vis, alt: '', style: 'height:36px;border-radius:5px;image-rendering:pixelated' }) : null,
        el('b', {}, name), el('span', { class: 'hint' }, `used ${count}×`), el('span', { style: 'flex:1' }),
        el('button', { onclick: () => openPicker(kind, name, to => {
          if (to === name) return;
          let n = 0; change(() => { n = replaceAsset(doc, key, name, to); });
          toast(`Swapped ${name} → ${to} in ${n} place${n === 1 ? '' : 's'}`);
          renderSwap(); if (!$('dSwap').open) $('dSwap').showModal();
        }) }, 'Swap…')));
    }
  }
  if (!any) body.append(el('div', { class: 'hint' }, 'Nothing to swap yet.'));
  body.append(el('p', { class: 'hint' }, 'Swapping changes every step that uses it: entrances, who speaks, expressions, exits. Names written inside the dialogue itself are left alone. Undo reverses it.'));
}
function renderWords() {
  const body = $('wdBody'); body.innerHTML = '';
  const colors = colorNames();
  const colorSelect = (value, onChange) => { const s = el('select', { onchange: e => onChange(e.target.value) }, ...colors.map(c => el('option', { value: c }, c + (fontHasColor(c) ? '' : ' (add to font)')))); s.value = value; return s; };
  body.append(el('p', { class: 'hint', style: 'margin-top:0' }, 'These words are coloured automatically in every line (the code gets ', el('code', {}, '<blue>House</>'), '). Your text in the builder stays plain.'));
  const list = el('div', { class: 'words' });
  (doc.words || []).forEach((w, j) => list.append(el('div', { class: 'wr' },
    textInput(w.w, v => change(() => { doc.words[j].w = v; }, { key: 'w' + j, keepInspector: true }), { placeholder: 'Word or name', label: 'Word' }),
    colorSelect(w.c, v => { change(() => { doc.words[j].c = v; }); renderWords(); }),
    el('span', { class: 'hint', html: styledHtml(`<${w.c}>${esc(w.w || 'Example')}</>`) }),
    el('button', { class: 'ghost', title: 'Remove', onclick: () => { change(() => { doc.words.splice(j, 1); }); renderWords(); } }, '✕'))));
  body.append(list, el('div', { style: 'margin:8px 0 16px' }, el('button', { onclick: () => { change(() => { doc.words.push({ w: '', c: 'blue' }); }); renderWords(); const i = $('wdBody').querySelectorAll('.wr input'); if (i.length) i[i.length - 1].focus(); } }, '+ Add a word')));
  body.append(el('div', { class: 'fld' }, el('div', { class: 'lab' }, 'Whisper colour'),
    el('div', { class: 'row' }, colorSelect(doc.whisper || 'grey', v => {
      const old = doc.whisper; change(() => { doc.whisper = v; for (const s of doc.steps) if (s.k === 'line' && s.color === old) s.color = v; }); renderWords();
    }), el('span', { class: 'hint' }, fontHasColor(doc.whisper || 'grey') ? '' : 'Your game font has no grey yet. It previews here; in game it needs a grey palette added to the convo font (a small data change I can make).'))));
}
const newForm = { left: '', right: '', rank: 'C', bg: '', music: '', loc: '', rows: [] };
function renderNewForm() {
  const f = $('nwForm'); f.innerHTML = '';
  const set = (k, v) => { newForm[k] = v; renderNewForm(); };
  f.append(
    fld('Left character', assetButton('portrait', newForm.left, v => set('left', v))),
    fld('Right character', assetButton('portrait', newForm.right, v => set('right', v))),
    fld('Rank', seg([['C', 'C'], ['B', 'B'], ['A', 'A'], ['S', 'S']], newForm.rank, v => set('rank', v))),
    fld('Background', assetButton('bg', newForm.bg, v => set('bg', v))),
    fld('Music', assetButton('music', newForm.music, v => set('music', v))),
    fld('Location card (optional)', textInput(newForm.loc, v => { newForm.loc = v; }, { placeholder: 'e.g. The training yard', spell: true })));
  const clean = s => String(s || '').replace(/[^A-Za-z0-9]/g, '');
  $('nwNote').textContent = !doc.steps.length && doc.name ? `Event name: ${doc.name}` : newForm.left && newForm.right ? `Event name: Support${clean(newForm.left)}${clean(newForm.right)}${newForm.rank}` : 'Pick the two characters.';
}
function tableBody(rows, L, R) {
  const out = []; let pending = null;
  const flush = () => { if (pending) out.push(`s;${pending.who};${pending.lines.join('|')}`); pending = null; };
  const beat = b => {
    for (const part of b.split(/[;\n]|,(?=\s*(?:bgm|sfx|music|sound)\b)/i).map(x => x.replace(/\*/g, '').trim()).filter(Boolean)) {
      let m;
      if ((m = part.match(/^(?:bgm|music)\s*:\s*(.+)$/i))) { const k = ciIn(A.manifest.music, m[1].trim()); out.push(k ? `music;${k};FadeIn=50` : `# Beat: ${part}`); }
      else if ((m = part.match(/^(?:sfx|sound)\s*:\s*(.+)$/i))) { const k = ciIn(A.manifest.sfx, m[1].trim()); out.push(k ? `sound;${k}` : `# Beat: ${part}`); }
      else if (/screen\s*shake|rumble/i.test(part)) out.push('screen_shake;300');
      else out.push(`# Beat: ${part}`);
    }
  };
  for (const r of rows) {
    if (r.beats) { flush(); beat(r.beats); }
    for (const [who, raw] of [[L, r.lineL], [R, r.lineR]]) {
      if (!raw) continue;
      const line = normalizeQuotes(raw).replace(/\s*\n\s*/g, ' ').replace(/;/g, ',').trim();
      if (!line) continue;
      if (/^\.{2,}$/.test(line)) { flush(); out.push(`s;${who};...;no_talk`); continue; }
      if (pending && pending.who === who) pending.lines.push(line);
      else { flush(); pending = { who, lines: [line] }; }
    }
  }
  flush();
  return out.join('\n');
}
function readPastedRows(html, text) {
  let rows = [];
  if (html && /<t[dr][\s>]/i.test(html)) {
    const d = new DOMParser().parseFromString(html, 'text/html');
    rows = [...d.querySelectorAll('tr')].map(tr => [...tr.querySelectorAll('td,th')].map(td => td.textContent.trim()));
  } else if (text) {
    const lines = text.split(/\r?\n/).filter(l => l.trim());
    if (lines.some(l => l.includes('\t'))) rows = lines.map(l => l.split('\t').map(s => s.trim()));
    else if (lines.some(l => l.trim().startsWith('|'))) rows = lines.map(l => l.trim().replace(/^\||\|$/g, '').split('|').map(s => s.trim()));
  }
  rows = rows.filter(r => r.some(c => c) && !r.every(c => /^:?-{2,}:?$/.test(c) || !c));
  let map;
  const hdr = rows.findIndex(r => r.some(c => /line\s*ls|left\s*speaker/i.test(c)));
  if (hdr >= 0) {
    const h = rows[hdr].map(c => c.toLowerCase());
    map = { ls: h.findIndex(c => /left\s*speaker/.test(c)), lineL: h.findIndex(c => /line\s*ls/.test(c)), lineR: h.findIndex(c => /line\s*rs/.test(c)), rs: h.findIndex(c => /right\s*speaker/.test(c)), beats: h.findIndex(c => /beat/.test(c)) };
    rows = rows.slice(hdr + 1);
  } else {
    const n = Math.max(0, ...rows.map(r => r.length));
    map = n >= 6 ? { ls: 1, lineL: 2, lineR: 3, rs: 4, beats: 5 } : { ls: 0, lineL: 1, lineR: 2, rs: 3, beats: 4 };
  }
  const get = (r, i) => (i >= 0 && i < r.length ? r[i] : '') || '';
  return rows.map(r => ({ ls: get(r, map.ls), lineL: get(r, map.lineL), lineR: get(r, map.lineR), rs: get(r, map.rs), beats: get(r, map.beats) }));
}
function makeNewConversation() {
  const L = newForm.left, R = newForm.right;
  if (!L || !R) { toast('Pick both characters first'); return; }
  const body = newForm.rows.length ? codeToSteps(tableBody(newForm.rows, L, R), doc).map(s => { delete s._l; return s; }) : [];
  const clean = s => String(s || '').replace(/[^A-Za-z0-9]/g, '');
  const steps = newConversationSteps({ left: L, right: R, bg: newForm.bg, music: newForm.music, loc: newForm.loc, body });
  clearTimeout(draftTimer); if (doc.steps.length) saveDraftNow();
  let name = !doc.steps.length && doc.name ? doc.name : `Support${clean(L)}${clean(R)}${newForm.rank}`;
  if (lib.items[name]) { let n = 2; while (lib.items[name + '_' + n]) n++; name = name + '_' + n; }
  currentKey = null;
  change(() => {
    doc.name = name;
    doc.steps = steps;
    sel = steps.findIndex(s => s.k === 'enterMany');
  });
  hist.past = []; hist.future = []; $('bUndo').disabled = true;
  $('dNew').close();
  toast(`Started ${name}. Your other conversations are under “Saved conversations”.`);
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Project folder: read the user's .ltproj straight from disk
// ---------------------------------------------------------------------------
const PROJ = { fs: null, handle: null, files: null };
function inEmbed() { try { return window.top !== window.self; } catch (e) { return true; } }
const canPickDir = () => typeof window.showDirectoryPicker === 'function' && !inEmbed();

// A tiny IndexedDB store, only to remember the picked folder between visits
// (browsers let a page keep a folder handle there, not in localStorage).
function idb(mode, fn) {
  return new Promise((res, rej) => {
    let rq; try { rq = indexedDB.open('supportSim', 1); } catch (e) { rej(e); return; }
    rq.onupgradeneeded = () => rq.result.createObjectStore('kv');
    rq.onerror = () => rej(rq.error);
    rq.onsuccess = () => { const tx = rq.result.transaction('kv', mode); const r = fn(tx.objectStore('kv')); tx.oncomplete = () => res(r && r.result); tx.onerror = () => rej(tx.error); };
  });
}
const idbGet = k => idb('readonly', st => st.get(k)).catch(() => null);
const idbSet = (k, v) => idb('readwrite', st => st.put(v, k)).catch(() => null);
const idbDel = k => idb('readwrite', st => st.delete(k)).catch(() => null);

// .ltproj roots inside a picked folder: the folder itself, or .ltproj folders in it
function rootsInPaths(paths) {
  const roots = new Set();
  for (const p of paths) {
    const m = p.match(/^(.*?)(?:^|\/)(game_data|resources)\//);
    if (m) roots.add(m[1]);
  }
  return [...roots].sort();
}
function fsFromFileList(files, root) {
  const map = new Map();
  for (const f of files) {
    const rel = f.webkitRelativePath || f.name;
    if (root && !rel.startsWith(root + '/')) continue;
    map.set((root ? rel.slice(root.length + 1) : rel).toLowerCase(), f);
  }
  const name = (root || '').split('/').pop().replace(/\.ltproj$/i, '') || 'Project';
  return { name, file: async rel => map.get(rel.toLowerCase()) || null };
}
function fsFromHandle(dir) {
  const dirs = new Map([['', dir]]);
  async function sub(path) {
    if (dirs.has(path)) return dirs.get(path);
    const i = path.lastIndexOf('/');
    const parent = await sub(i < 0 ? '' : path.slice(0, i));
    if (!parent) return null;
    let h = null; try { h = await parent.getDirectoryHandle(path.slice(i + 1)); } catch (e) { h = null; }
    dirs.set(path, h); return h;
  }
  return {
    name: dir.name.replace(/\.ltproj$/i, ''),
    async file(rel) {
      const i = rel.lastIndexOf('/');
      const d = await sub(i < 0 ? '' : rel.slice(0, i)); if (!d) return null;
      try { return await (await d.getFileHandle(rel.slice(i + 1))).getFile(); } catch (e) { return null; }
    },
  };
}
async function projectDirIn(handle) {
  // the picked folder may be the project or the folder holding it
  try { await handle.getDirectoryHandle('game_data'); return [handle]; } catch (e) { /* not a project root */ }
  const out = [];
  for await (const [name, h] of handle.entries()) if (h.kind === 'directory' && /\.ltproj$/i.test(name)) out.push(h);
  return out;
}
async function useProjectFs(fs, how) {
  status('Reading ' + fs.name + '…');
  try {
    const m = await loadAssets(projectSource(fs, bundleSource(ASSET_BASE)));
    PROJ.fs = fs;
    thumbCache.clear();
    afterAssetsChanged();
    toast(`Using ${fs.name}: ${m.units.length} characters, ${m.portraits.length} portraits, ${m.backgrounds.length} backgrounds, ${m.music.length} tracks`);
    try { localStorage.setItem('supportSim.source', how || 'project'); } catch (e) { /* ignore */ }
    return true;
  } catch (e) {
    toast('Could not read that folder: ' + e.message);
    return false;
  } finally { status(''); }
}
async function useSampleAssets() {
  await loadAssets(bundleSource(ASSET_BASE));
  PROJ.fs = null; PROJ.handle = null; thumbCache.clear();
  try { localStorage.setItem('supportSim.source', 'bundle'); } catch (e) { /* ignore */ }
  await idbDel('projectHandle');
  afterAssetsChanged();
  toast('Using the sample assets');
}
function afterAssetsChanged() {
  $('projName').textContent = A.source && A.source.kind === 'project' ? A.source.label : 'Sample assets';
  renderProjectDialog();
  refresh();
}
async function pickProjectFolder() {
  if (canPickDir()) {
    let h; try { h = await window.showDirectoryPicker({ id: 'ltproj', mode: 'read' }); } catch (e) { return; }  // cancelled
    const found = await projectDirIn(h);
    if (!found.length) { toast('No LT project in that folder. Pick the folder that ends in .ltproj.'); return; }
    if (found.length > 1) { showRootChoices(found.map(d => ({ label: d.name, go: () => openHandle(d) }))); return; }
    await openHandle(found[0]);
  } else {
    $('projInput').value = ''; $('projInput').click();
  }
}
async function openHandle(h) {
  $('projRoots').hidden = true;
  PROJ.handle = h;
  if (await useProjectFs(fsFromHandle(h), 'handle')) await idbSet('projectHandle', h);
}
function showRootChoices(choices) {
  const box = $('projRoots'); box.innerHTML = ''; box.hidden = false;
  box.append(el('span', { class: 'hint' }, 'That folder has several projects:'));
  for (const c of choices) box.append(el('button', { onclick: c.go }, c.label));
}
function onProjectFiles(files) {
  if (!files || !files.length) return;
  PROJ.files = files;
  const roots = rootsInPaths([...files].map(f => f.webkitRelativePath || f.name));
  if (!roots.length) { toast('No LT project in that folder. Pick the folder that ends in .ltproj.'); return; }
  if (roots.length > 1) { showRootChoices(roots.map(r => ({ label: r.split('/').pop(), go: () => { $('projRoots').hidden = true; useProjectFs(fsFromFileList(files, r), 'files'); } }))); return; }
  useProjectFs(fsFromFileList(files, roots[0]), 'files');
}
async function renderProjectDialog() {
  const m = A.manifest || {};
  const proj = A.source && A.source.kind === 'project';
  $('projNow').innerHTML = '';
  $('projNow').append(proj ? el('span', {}, 'Using ', el('b', {}, A.source.label), ': ') : el('span', {}, 'Using the ', el('b', {}, 'sample assets'), ' (the engine\'s demo project): '),
    `${(m.units || []).length} characters, ${(m.portraits || []).length} portraits, ${(m.backgrounds || []).length} backgrounds, ${(m.music || []).length} music tracks, ${(m.sfx || []).length} sounds.`);
  $('projReload').hidden = !proj || !PROJ.handle;
  $('projSample').hidden = !proj;
  $('projEmbedHint').hidden = !inEmbed();
  const saved = canPickDir() ? await idbGet('projectHandle') : null;
  const rb = $('projReopen');
  rb.hidden = !saved || (proj && PROJ.handle && saved.name === PROJ.handle.name);
  if (saved) rb.textContent = 'Reopen ' + saved.name.replace(/\.ltproj$/i, '');
}
async function reopenSaved(quiet) {
  const h = await idbGet('projectHandle'); if (!h) return false;
  let perm = 'prompt';
  try { perm = await h.queryPermission({ mode: 'read' }); } catch (e) { return false; }
  if (perm !== 'granted') {
    if (quiet) return false;              // needs a click: the dialog offers "Reopen"
    try { perm = await h.requestPermission({ mode: 'read' }); } catch (e) { return false; }
    if (perm !== 'granted') return false;
  }
  await openHandle(h);
  return true;
}
function wireProject() {
  $('bProject').onclick = () => { renderProjectDialog(); $('dProject').showModal(); };
  $('projClose').onclick = () => $('dProject').close();
  $('projOpen').onclick = pickProjectFolder;
  $('projReopen').onclick = () => reopenSaved(false);
  $('projReload').onclick = () => { if (PROJ.handle) openHandle(PROJ.handle); };
  $('projSample').onclick = useSampleAssets;
  $('projInput').addEventListener('change', e => onProjectFiles(e.target.files));
}

function wire() {
  wireChain();
  wireProject();
  $('insMenu').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.close) { closeInsertMenu(); return; }
    const m = menuAt; closeInsertMenu();
    if (b.dataset.k != null && typeof m === 'number') { if (b.dataset.k.startsWith('branch')) addBranch(b.dataset.k, m); else addStep(b.dataset.k, m); }
    if (b.dataset.pos && m && m.pos) m.pos(b.dataset.pos);
  });
  document.addEventListener('mousedown', e => { if (!$('insMenu').hidden && !e.target.closest('#insMenu') && !e.target.closest('[data-ins]') && !e.target.closest('#fab')) closeInsertMenu(); });
  $('evName').addEventListener('input', e => change(() => { doc.name = e.target.value.replace(/\s+/g, ''); }, { key: 'name', keepInspector: true }));
  $('bUndo').onclick = undo; $('bRedo').onclick = redo;
  document.querySelectorAll('.mtabs [data-tab]').forEach(b => b.addEventListener('click', () => setTab(b.dataset.tab)));
  $('fab').onclick = e => openInsertMenu(doc.steps.length ? sel + 1 : 0, e.currentTarget);
  const showHelp = v => { $('help').hidden = !v; try { localStorage.setItem('supportSim.helpSeen', v ? '' : '1'); } catch (x) { /* ignore */ } };
  $('bHelp').onclick = () => { showHelp($('help').hidden); if (isPhone()) setTab('edit'); };
  $('bKeys').onclick = openShortcuts;
  $('bKeysHelp').onclick = openShortcuts;
  $('keysClose').onclick = () => $('dKeys').close();
  $('bLayout').onclick = toggleTimeline;
  let tlOn = true; try { const v = localStorage.getItem('supportSim.timeline'); if (v != null) tlOn = v === '1'; } catch (x) { /* ignore */ }
  setTimeline(tlOn);
  $('helpClose').onclick = () => showHelp(false);
  try { if (!localStorage.getItem('supportSim.helpSeen')) $('help').hidden = false; } catch (x) { $('help').hidden = false; }
  // shrink the pinned preview while the keyboard is up
  document.addEventListener('focusin', e => { if (e.target.matches('textarea, input[type="text"], input[type="number"]')) document.body.classList.add('typing'); });
  document.addEventListener('focusout', () => document.body.classList.remove('typing'));
  let tab = 'edit'; try { tab = localStorage.getItem('supportSim.tab') || 'edit'; } catch (x) { /* ignore */ }
  setTab(tab);
  $('convSel').addEventListener('change', e => { const v = e.target.value; if (v) openConversation(v); e.target.value = ''; });
  $('bPlayHere').onclick = () => playFrom(sel);
  $('bPlayAll').onclick = () => playFrom(0);
  $('bStop').onclick = () => stopPlay();
  $('bNext').onclick = () => player.advance();
  const canvasXY = e => { const r = $('screen').getBoundingClientRect(); return [(e.clientX - r.left) * W / r.width, (e.clientY - r.top) * H / r.height]; };
  $('screen').addEventListener('click', e => {
    if (mode === 'play' && player.scene && player.scene.choice) { const i = player.choiceAt(...canvasXY(e)); if (i >= 0) player.choose(i); return; }
    if (mode === 'play') player.advance(); else playFrom(sel);
  });
  $('screen').addEventListener('mousemove', e => {
    const ch = mode === 'play' && player.scene && player.scene.choice; if (!ch) return;
    const i = player.choiceAt(...canvasXY(e)); if (i >= 0) ch.sel = i;
  });
  for (const [id, key] of [['bAuto', 'autoAdvance'], ['bTyping', 'typingSound']]) {
    const b = $(id); b.onclick = () => { player[key] = !player[key]; b.setAttribute('aria-pressed', String(player[key])); };
  }
  $('volMusic').oninput = e => { audio.musicVol = +e.target.value / 100; };
  $('volSfx').oninput = e => { audio.sfxVol = +e.target.value / 100; };
  $('bCopy').onclick = () => copyText(codeEditing ? $('codeEdit').value : gen.code, 'event code');
  $('bEditCode').onclick = () => codeEditing ? endCodeEdit() : startCodeEdit();
  $('codeView').addEventListener('click', e => { const l = e.target.closest('.cl'); if (l) select(gen.lineStep[+l.dataset.line]); });
  $('codeView').addEventListener('dblclick', () => startCodeEdit());
  $('codeEdit').addEventListener('input', () => { clearTimeout(codeTimer); codeTimer = setTimeout(applyCodeEdit, 350); });
  for (const ev of ['keyup', 'click']) $('codeEdit').addEventListener(ev, () => { if (codeEditing) { const before = sel; followCursor(false); if (sel !== before) { renderChain(); renderInspector(); renderOnStage(); renderQuick(); needsStill = true; } } });
  // dialogs
  $('pkSearch').addEventListener('input', renderPickerGrid);
  $('pkSearch').addEventListener('keydown', e => { if (e.key === 'Enter') { const f = $('pkGrid').querySelector('.tile'); if (f) { f.click(); usePicker(); } } });
  $('pkTyped').addEventListener('input', () => { if ($('pkTyped').value.trim()) { picker.value = null; $('pkGrid').querySelectorAll('.tile').forEach(x => x.setAttribute('aria-selected', 'false')); } renderPickerPreview(); });
  $('pkTyped').addEventListener('keydown', e => { if (e.key === 'Enter') usePicker(); });
  $('pkUse').onclick = usePicker;
  $('pkCancel').onclick = () => { $('dPicker').close(); };
  $('dPicker').addEventListener('close', () => { picker.pv = null; if (picker.kind === 'music') audio.stopAll(); });
  $('pkGrid').addEventListener('keydown', e => {
    const tiles = [...$('pkGrid').querySelectorAll('.tile')]; const i = tiles.indexOf(document.activeElement); if (i < 0) return;
    const cols = Math.max(1, Math.round($('pkGrid').clientWidth / (tiles[0].offsetWidth + 8)));
    const d = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols, ArrowUp: -cols }[e.key];
    if (d) { e.preventDefault(); const t = tiles[Math.max(0, Math.min(tiles.length - 1, i + d))]; t.focus(); t.click(); }
    if (e.key === 'Enter') { e.preventDefault(); usePicker(); }
  });
  $('bSwap').onclick = () => { renderSwap(); $('dSwap').showModal(); };
  $('swClose').onclick = () => $('dSwap').close();
  $('bWords').onclick = () => { renderWords(); $('dWords').showModal(); };
  $('wdClose').onclick = () => { $('dWords').close(); refresh(); };
  $('bNew').onclick = () => {
    const on = [...sceneAfter(doc, doc.steps.length - 1).keys()];
    const firstUU = doc.steps.find(s => s.k === 'enterMany');
    Object.assign(newForm, { left: firstUU ? firstUU.list[0].who : on[0] || '', right: firstUU && firstUU.list[1] ? firstUU.list[1].who : on[1] || '', rows: [],
      bg: (doc.steps.find(s => s.k === 'bg') || {}).bg || '', music: (doc.steps.find(s => s.k === 'music') || {}).nid || '', loc: '' });
    $('nwPaste').textContent = 'Click here and paste (Ctrl+V)…'; $('nwTableWrap').open = false;
    renderNewForm(); $('dNew').showModal();
  };
  $('nwCancel').onclick = () => $('dNew').close();
  $('nwMake').onclick = makeNewConversation;
  const paste = $('nwPaste');
  paste.addEventListener('focus', () => { if (!newForm.rows.length) paste.textContent = ''; });
  paste.addEventListener('paste', e => {
    e.preventDefault();
    newForm.rows = readPastedRows(e.clipboardData.getData('text/html'), e.clipboardData.getData('text/plain'));
    if (!newForm.rows.length) { paste.textContent = 'Couldn’t find table rows in that. Copy the rows straight from the Notion table and try again.'; return; }
    const lines = newForm.rows.reduce((n, r) => n + (r.lineL ? 1 : 0) + (r.lineR ? 1 : 0), 0);
    paste.textContent = `${newForm.rows.length} rows pasted (${lines} lines). Beats become notes you can turn into steps.`;
    const l = newForm.rows.map(r => r.ls).find(Boolean), r = newForm.rows.map(r => r.rs).find(Boolean);
    if (!newForm.left && l) newForm.left = ciFind(A.portraits, l) || l.replace(/\s+/g, '');
    if (!newForm.right && r) newForm.right = ciFind(A.portraits, r) || r.replace(/\s+/g, '');
    renderNewForm();
  });
  // keyboard (the full list is in the Shortcuts window: press ?)
  document.addEventListener('keydown', e => {
    if (e.target.closest && e.target.closest('dialog')) return;
    const ch = mode === 'play' && player.scene && player.scene.choice;
    if (ch && !(e.target.closest && e.target.closest('input, textarea, select'))) {
      if (e.key === 'ArrowUp' || e.key === 'ArrowLeft' || e.key === 'k') { e.preventDefault(); ch.sel = (ch.sel + ch.options.length - 1) % ch.options.length; return; }
      if (e.key === 'ArrowDown' || e.key === 'ArrowRight' || e.key === 'j') { e.preventDefault(); ch.sel = (ch.sel + 1) % ch.options.length; return; }
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); player.choose(ch.sel); return; }
    }
    if (e.key === 'Escape' && !$('insMenu').hidden) { closeInsertMenu(); return; }
    const typing = e.target.closest && e.target.closest('input, textarea, select, [contenteditable="true"]');
    if (typing) {
      // Esc leaves a field so the arrow keys drive the chain again
      if (e.key === 'Escape') { e.preventDefault(); e.target.blur(); }
      return;
    }
    const k = e.key;
    if ((e.ctrlKey || e.metaKey) && !e.altKey) {
      const lk = k.toLowerCase();
      if (lk === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
      else if (lk === 'y' || (lk === 'z' && e.shiftKey)) { e.preventDefault(); redo(); }
      else if (lk === 'd') { e.preventDefault(); duplicateStep(sel); }
      return;
    }
    const tl = isTimeline();
    const prevKeys = tl ? ['ArrowUp', 'ArrowLeft', 'k'] : ['ArrowUp', 'k'];
    const nextKeys = tl ? ['ArrowDown', 'ArrowRight', 'j'] : ['ArrowDown', 'j'];
    if (e.altKey && (k === 'ArrowUp' || (tl && k === 'ArrowLeft'))) { e.preventDefault(); nudge(sel, -1); return; }
    if (e.altKey && (k === 'ArrowDown' || (tl && k === 'ArrowRight'))) { e.preventDefault(); nudge(sel, 1); return; }
    if (nextKeys.includes(k)) { e.preventDefault(); lastSurface = 'chain'; select(sel + 1); }
    else if (prevKeys.includes(k)) { e.preventDefault(); lastSurface = 'chain'; select(sel - 1); }
    else if (k === 'Home') { e.preventDefault(); select(0); }
    else if (k === 'End') { e.preventDefault(); select(doc.steps.length - 1); }
    else if (k === 'Delete' || k === 'Backspace') { e.preventDefault(); deleteStep(sel); }
    else if (k === ' ') { e.preventDefault(); if (mode === 'play') player.advance(); else playFrom(sel); }
    else if (k === 'p') playFrom(sel);
    else if (k === 'P') playFrom(0);
    else if (k === 'Escape') stopPlay();
    else if (k === 'Enter' || k === 'e') { e.preventDefault(); focusEditor(); }
    else if (k === 'l') { e.preventDefault(); lastSurface = 'chain'; addStep('line', doc.steps.length ? sel + 1 : 0); }
    else if (k === 'a' || k === '+' || k === '=') {
      e.preventDefault(); lastSurface = 'chain';
      const at = doc.steps.length ? sel + 1 : 0;
      const g = $('chain').querySelector(`.gap[data-at="${at}"] .ins`) || $('fab');
      openInsertMenu(at, g);
    }
    else if (k === '?') { e.preventDefault(); openShortcuts(); }
    else if (k === 't' && !isPhone()) toggleTimeline();
  });
}

let timelinePref = true;
function applyLayout() { document.body.classList.toggle('timeline', timelinePref && !isPhone()); }
function setTimeline(on) {
  timelinePref = !!on; applyLayout();
  $('bLayout').setAttribute('aria-pressed', String(!!on));
  $('bLayout').textContent = on ? 'Layout: timeline' : 'Layout: column';
  try { localStorage.setItem('supportSim.timeline', on ? '1' : '0'); } catch (x) { /* ignore */ }
  setTimeout(() => centerSelected(false), 0);
}
function toggleTimeline() { setTimeline(!timelinePref); }
matchMedia('(max-width: 760px)').addEventListener('change', () => { applyLayout(); renderChain(); });
function openShortcuts() { $('dKeys').showModal(); }

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
const EXAMPLE = `# Example support with the sample project's characters. Press "New conversation…" to start your own.
change_background;Clearing
music;Healing;FadeIn=50
location_card;The training yard
uu;Seth;Left;Eirika;Right
s;Eirika;Seth! You're up early.|Again.
s;Seth;A knight who sleeps in|protects no one, Princess.
e;Eirika;Smile
s;Eirika;Then teach me. For <blue>Renais</>.
bop;Seth
s;Seth;...;no_talk
e;Seth;CloseEyes
s;Seth;She grows more like the King every day.;StyleNid=thought_bubble
e;Seth;NoSmile
s;Seth;Very well. Shield up.|And keep your feet under you.
sound;Attack Hit 1
screen_shake;300
e;Eirika;NoSmile
s;Eirika;<jitter>Ow!</>
e;Seth;Smile
s;Seth;(Again.);FontColor=grey
move_portrait;Eirika;OffscreenRight;0.6
multi_remove_portrait;Seth;Eirika
transition;close;1000
music_clear;2000
end;`;
(async function init() {
  wire();
  try { await loadAssets(bundleSource(ASSET_BASE)); }
  catch (e) { status('Could not load the assets: ' + e.message); return; }
  // last time a project folder was used: reopen it if the browser still allows
  let src = 'bundle'; try { src = localStorage.getItem('supportSim.source') || 'bundle'; } catch (e) { /* ignore */ }
  if (src === 'handle' && canPickDir()) {
    if (!(await reopenSaved(true))) {
      const h = await idbGet('projectHandle');
      if (h) toast('Click 📁 to reopen ' + h.name.replace(/\.ltproj$/i, ''));
    }
  }
  $('projName').textContent = A.source && A.source.kind === 'project' ? A.source.label : 'Sample assets';
  let restored = false;
  readLib();
  const want = decodeURIComponent((location.hash || '').slice(1));
  const key = want ? (lib.items[want] ? want : null) : (lib.current && lib.items[lib.current] ? lib.current : null);
  if (key) { loadSnap(lib.items[key].snap); currentKey = key; restored = true; }
  else if (want) {
    // a link to a conversation this browser doesn't have yet: start it
    const prev = lib.current && lib.items[lib.current];
    doc = { name: want, steps: [], words: prev ? JSON.parse(prev.snap).words || [] : [], whisper: 'grey' }; restored = true;
  }
  if (!restored) {
    let v1 = null; try { v1 = localStorage.getItem('supportSim.draft'); } catch (e) { /* ignore */ }
    doc = { name: v1 ? '' : 'SupportSethEirikaC', steps: [], words: v1 ? [] : [{ w: 'Renais', c: 'blue' }], whisper: 'grey' };
    doc.steps = codeToSteps(v1 && v1.trim() ? v1 : EXAMPLE, doc).map(s => { delete s._l; return s; });
    sel = Math.max(0, doc.steps.findIndex(s => s.k === 'line'));
  }
  refresh();
  if (restored && doc.steps.length) toast('Opened ' + keyFor(doc.name));
  else if (restored) setTimeout(() => $('bNew').click(), 0);
  let last = performance.now();
  function frame(now) {
    const dt = Math.min(100, now - last); last = now;
    if (needsStill && mode === 'still') { needsStill = false; showStill(); }
    player.update(now, dt);
    player.draw(now);
    pickerTick(now, dt);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
