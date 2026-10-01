'use strict';
// ===========================================================================
// Support Sim builder: the conversation as a list of steps, and the two-way
// conversion between steps and LT event code.
//
// Every step turns into one or two lines of event code. Code the builder
// doesn't model (any command or option it has no controls for) becomes a
// "code" step and is kept exactly as written, so nothing is ever lost when
// switching between the builder and hand-written code.
//
// Output follows lava-medallion-conversion-spec.md: s; e; bop; mirror; uu;
// multi_remove_portrait; transition;close;1000; music_clear;2000; end;
// ===========================================================================

const POSITIONS = [['FarLeft', 'Far left'], ['Left', 'Left'], ['CenterLeft', 'Center left'], ['CenterRight', 'Center right'], ['Right', 'Right'], ['FarRight', 'Far right']];
const EXPRESSIONS = [['Smile', 'Smile'], ['CloseEyes', 'Eyes closed'], ['HalfCloseEyes', 'Eyes half shut'], ['OpenMouth', 'Mouth open'],
  ['LeftWink', 'Wink (left eye)'], ['RightWink', 'Wink (right eye)'], ['OpenEyes', 'Never blinks']];
const VALID_EXPR = new Set(['NoSmile', 'Smile', 'NormalBlink', 'CloseEyes', 'HalfCloseEyes', 'LeftWink', 'RightWink', 'FarWink', 'NearWink', 'OpenEyes', 'OpenMouth']);

const KINDS = {
  line:       { label: 'Line',              group: 'talk' },
  enter:      { label: 'Enters',            group: 'cast' },
  enterMany:  { label: 'Enter together',    group: 'cast' },
  leave:      { label: 'Leaves',            group: 'cast' },
  leaveMany:  { label: 'Leave together',    group: 'cast' },
  move:       { label: 'Moves',             group: 'cast' },
  expr:       { label: 'Expression',        group: 'cast' },
  bop:        { label: 'Bop',               group: 'cast' },
  mirror:     { label: 'Turns around',      group: 'cast' },
  bg:         { label: 'Background',        group: 'scene' },
  transition: { label: 'Fade',              group: 'scene' },
  card:       { label: 'Location card',     group: 'scene' },
  shake:      { label: 'Screen shake',      group: 'scene' },
  wait:       { label: 'Pause',             group: 'scene' },
  music:      { label: 'Music',             group: 'sound' },
  musicOff:   { label: 'Music stops',       group: 'sound' },
  sound:      { label: 'Sound effect',      group: 'sound' },
  choice:     { label: 'Choice',            group: 'flow' },
  if:         { label: 'Branch',            group: 'flow' },
  elif:       { label: 'Or if',             group: 'flow' },
  else:       { label: 'Otherwise',         group: 'flow' },
  join:       { label: 'Rejoin',            group: 'flow' },
  note:       { label: 'Note',              group: 'code' },
  raw:        { label: 'Code',              group: 'code' },
  end:        { label: 'End',               group: 'code' },
};

let _uid = 1;
function newId() { return _uid++; }
function autoMirror(pos) { return parsePosition(pos).mirror; }
function isOffscreen(pos) { return /^Offscreen(Left|Right)$/.test(String(pos || '')); }
function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function fmtNum(n) { return String(+(+n).toFixed(3)); }
const flagStr = fl => fl.filter(Boolean).map(f => ';' + f).join('');

// ---------------------------------------------------------------------------
// Keyword colouring ("every House in blue"): applied when code is generated,
// removed again when code is read back, so the step text stays clean.
// ---------------------------------------------------------------------------
function applyOneWord(text, word, color) {
  const re = new RegExp(`(^|[^A-Za-z0-9_'])(${escRe(word)})(?=$|[^A-Za-z0-9_'])`, 'gi');
  let depth = 0;
  return text.split(TAG_SPLIT).map(t => {
    if (!t) return t;
    if (t.startsWith('</')) { depth = Math.max(0, depth - 1); return t; }
    if (t[0] === '<' && t.endsWith('>')) { depth++; return t; }
    if (t[0] === '{' && t.endsWith('}')) return t;
    if (depth > 0) return t;
    return t.replace(re, (m, pre, w) => `${pre}<${color}>${w}</>`);
  }).join('');
}
function applyWords(text, words) {
  for (const { w, c } of words || []) if (w && w.trim() && c) text = applyOneWord(text, w.trim(), c);
  return text;
}
function unapplyWords(text, words) {
  for (const { w, c } of words || []) if (w && w.trim() && c) text = text.replace(new RegExp(`<${escRe(c)}>(${escRe(w.trim())})</>`, 'gi'), '$1');
  return text;
}

// ---------------------------------------------------------------------------
// Steps -> code
// ---------------------------------------------------------------------------
function stepToLines(s, doc) {
  const T = s.together ? 'no_block' : null;
  const who = s.who || '';
  switch (s.k) {
    case 'line': {
      const text = applyWords(String(s.text || '').replace(/\r?\n/g, '|').replace(/;/g, ','), doc.words);
      let out = `s;${who};${text}`;
      if (s.box === 'thought') out += ';StyleNid=thought_bubble';
      else if (s.box === 'narration') out += ';StyleNid=narration';
      if (s.font && s.font !== 'convo') out += `;FontType=${s.font}`;
      if (s.color) out += `;FontColor=${s.color}`;
      return [out + flagStr([s.silent && 'no_talk', s.hold && 'hold', T])];
    }
    case 'enter': {
      const pos = s.pos || 'Left';
      const ex = s.expr && s.expr.length ? `;ExpressionList=${s.expr.join(',')}` : '';
      if (s.how === 'walkL' || s.how === 'walkR') {
        const off = s.how === 'walkL' ? 'OffscreenLeft' : 'OffscreenRight';
        const flip = (autoMirror(off) !== autoMirror(pos)) !== !!s.mirror;
        return [`add_portrait;${who};${off}${ex}` + flagStr([flip && 'mirror', 'immediate']),
          `move_portrait;${who};${pos}${s.speed ? ';' + fmtNum(s.speed) : ''}` + flagStr([T])];
      }
      const slide = s.how === 'slideL' ? ';Slide=left' : s.how === 'slideR' ? ';Slide=right' : '';
      const sp = s.speed && s.how !== 'instant' ? `;SpeedMult=${fmtNum(s.speed)}` : '';
      return [`add_portrait;${who};${pos}${slide}${ex}${sp}` + flagStr([s.mirror && 'mirror', s.how === 'instant' ? 'immediate' : T])];
    }
    case 'enterMany': return ['uu;' + (s.list || []).map(p => `${p.who || ''};${p.pos || 'Left'}`).join(';')];
    case 'leave': {
      if (s.how === 'walkL' || s.how === 'walkR')
        return [`move_portrait;${who};${s.how === 'walkL' ? 'OffscreenLeft' : 'OffscreenRight'}${s.speed ? ';' + fmtNum(s.speed) : ''}` + flagStr([T])];
      if (s.how === 'instant') return [`remove_portrait;${who};immediate`];
      const slide = s.how === 'slideL' ? ';Slide=left' : s.how === 'slideR' ? ';Slide=right' : '';
      return [`remove_portrait;${who}${s.speed ? ';SpeedMult=' + fmtNum(s.speed) : ''}${slide}` + flagStr([T])];
    }
    case 'leaveMany': return ['multi_remove_portrait;' + (s.list || []).join(';')];
    case 'move': return [`move_portrait;${who};${s.pos || 'Left'}${s.speed ? ';' + fmtNum(s.speed) : ''}` + flagStr([T])];
    case 'expr': return [`e;${who};${s.expr && s.expr.length ? s.expr.join(',') : 'NoSmile'}`];
    case 'bop': {
      const n = s.n || 2;
      return [`bop;${who}` + (n !== 2 || s.ms ? `;${n}` : '') + (s.ms ? `;${s.ms}` : '') + flagStr([T])];
    }
    case 'mirror': return [`mirror;${who}` + (s.speed ? `;${fmtNum(s.speed)}` : '')];
    case 'bg': return [`change_background;${s.bg || ''}` + flagStr([s.keep && 'keep_portraits'])];
    case 'transition': return [`transition;${s.dir === 'open' ? 'open' : 'close'}${s.ms ? ';' + s.ms : ''}` + flagStr([T])];
    case 'card': return [`location_card;${String(s.text || '').replace(/;/g, ',')}`];
    case 'shake': return [`screen_shake;${s.ms || 300}` + flagStr([T])];
    case 'wait': return [`wait;${s.ms || 500}`];
    case 'music': return [`music;${s.nid || ''}` + (s.fade != null && s.fade !== '' ? `;FadeIn=${s.fade}` : '') + (s.vol != null && s.vol !== 1 ? `;Volume=${fmtNum(s.vol)}` : '')];
    case 'musicOff': return [`${s.mode === 'back' ? 'music_fade_back' : 'music_clear'}` + (s.fade != null && s.fade !== '' ? `;${s.fade}` : '')];
    case 'sound': return [`sound;${s.nid || ''}` + (s.vol != null && s.vol !== 1 ? `;${fmtNum(s.vol)}` : '')];
    case 'choice': {
      const clean = v => String(v || '').replace(/[;,]/g, ' ').trim();
      return [`choice;${clean(s.nid)};${String(s.title || '').replace(/;/g, ',')};${(s.options || []).map(clean).filter(Boolean).join(',')}`];
    }
    case 'if': return [`if;${s.cond || 'True'}`];
    case 'elif': return [`elif;${s.cond || 'True'}`];
    case 'else': return [s.semi ? 'else;' : 'else'];
    case 'join': return [s.semi ? 'end;' : 'end'];
    case 'note': return String(s.text || '').split(/\r?\n/).map(t => '# ' + t);
    case 'end': return ['end;'];
    case 'raw': default: return String(s.code || '').split(/\r?\n/);
  }
}
function genCode(doc) {
  const lines = [], ranges = [], lineStep = [];
  doc.steps.forEach((s, i) => {
    const L = stepToLines(s, doc);
    ranges.push([lines.length, lines.length + L.length - 1]);
    for (const l of L) { lineStep.push(i); lines.push(l); }
  });
  return { code: lines.join('\n'), ranges, lineStep };
}

// ---------------------------------------------------------------------------
// Code -> steps (strict: anything not fully understood stays as code)
// ---------------------------------------------------------------------------
function numOrNull(v) { if (v == null || v === '') return undefined; const n = Number(v); return Number.isFinite(n) ? n : null; }
function cmdToStep(c, doc) {
  const a = c.args, kw = c.kw, f = c.flags;
  const flagsOk = (...ok) => [...f].every(x => ok.includes(x));
  const kwOk = (...ok) => Object.keys(kw).every(x => ok.includes(x));
  const T = f.has('no_block');
  switch (c.name) {
    case 'speak': {
      if (a.length > 2 || !a[0] || !kwOk('StyleNid', 'FontType', 'FontColor') || !flagsOk('no_talk', 'hold', 'no_block')) return null;
      if (kw.StyleNid && !['thought_bubble', 'narration'].includes(kw.StyleNid)) return null;
      if (c.alias !== 's') return null;
      const text = unapplyWords(a[1] || '', doc.words).replace(/\|/g, '\n');
      return { k: 'line', who: a[0], text, font: kw.FontType || 'convo', color: kw.FontColor || '',
        box: kw.StyleNid === 'thought_bubble' ? 'thought' : kw.StyleNid === 'narration' ? 'narration' : '',
        silent: f.has('no_talk'), hold: f.has('hold'), together: T };
    }
    case 'add_portrait': {
      if (c.alias !== 'add_portrait' || a.length > 2 || !a[0] || !a[1] || !kwOk('Slide', 'ExpressionList', 'SpeedMult') || !flagsOk('mirror', 'immediate', 'no_block')) return null;
      const slide = (kw.Slide || '').toLowerCase();
      if (slide && slide !== 'left' && slide !== 'right') return null;
      const sp = numOrNull(kw.SpeedMult); if (sp === null) return null;
      const expr = kw.ExpressionList ? kw.ExpressionList.split(',').map(x => x.trim()) : [];
      if (expr.some(x => !VALID_EXPR.has(x)) || (f.has('immediate') && (slide || T || sp))) return null;
      return { k: 'enter', who: a[0], pos: a[1], how: f.has('immediate') ? 'instant' : slide === 'left' ? 'slideL' : slide === 'right' ? 'slideR' : 'fade',
        expr, mirror: f.has('mirror'), together: T, speed: sp || null };
    }
    case 'multi_add_portrait': {
      if (c.alias !== 'uu' || a.length < 2 || a.length % 2 || Object.keys(kw).length || f.size) return null;
      const list = []; for (let i = 0; i < a.length; i += 2) list.push({ who: a[i], pos: a[i + 1] });
      return { k: 'enterMany', list };
    }
    case 'remove_portrait': {
      if (c.alias !== 'remove_portrait' || a.length !== 1 || !kwOk('SpeedMult', 'Slide') || !flagsOk('immediate', 'no_block')) return null;
      const slide = (kw.Slide || '').toLowerCase(); if (slide && slide !== 'left' && slide !== 'right') return null;
      const sp = numOrNull(kw.SpeedMult); if (sp === null) return null;
      if (f.has('immediate') && (slide || sp || T)) return null;
      return { k: 'leave', who: a[0], how: f.has('immediate') ? 'instant' : slide === 'left' ? 'slideL' : slide === 'right' ? 'slideR' : 'fade', speed: sp || null, together: T };
    }
    case 'multi_remove_portrait':
      if (c.alias !== 'multi_remove_portrait' || !a.length || Object.keys(kw).length || f.size || a.some(x => !x)) return null;
      return { k: 'leaveMany', list: [...a] };
    case 'move_portrait': {
      if (c.alias !== 'move_portrait' || a.length < 2 || a.length > 3 || Object.keys(kw).length || !flagsOk('no_block')) return null;
      const sp = numOrNull(a[2]); if (sp === null) return null;
      if (isOffscreen(a[1])) return { k: 'leave', who: a[0], how: a[1] === 'OffscreenLeft' ? 'walkL' : 'walkR', speed: sp || null, together: T };
      return { k: 'move', who: a[0], pos: a[1], speed: sp || null, together: T };
    }
    case 'expression': {
      if (c.alias !== 'e' || a.length !== 2 || Object.keys(kw).length || f.size) return null;
      const expr = a[1].split(',').map(x => x.trim());
      if (expr.some(x => !VALID_EXPR.has(x))) return null;
      return { k: 'expr', who: a[0], expr: expr.length === 1 && expr[0] === 'NoSmile' ? [] : expr };
    }
    case 'bop_portrait': {
      if (c.alias !== 'bop' || !a[0] || a.length > 3 || Object.keys(kw).length || !flagsOk('no_block')) return null;
      const n = numOrNull(a[1]), ms = numOrNull(a[2]); if (n === null || ms === null) return null;
      if (n === 2 && a[1] && !a[2]) return null;   // "bop;X;2" would come back as "bop;X"
      return { k: 'bop', who: a[0], n: n || 2, ms: ms || null, together: T };
    }
    case 'mirror_portrait': {
      if (c.alias !== 'mirror' || !a[0] || a.length > 2 || Object.keys(kw).length || f.size) return null;
      const sp = numOrNull(a[1]); if (sp === null) return null;
      return { k: 'mirror', who: a[0], speed: sp || null };
    }
    case 'change_background':
      if (c.alias !== 'change_background' || a.length > 1 || Object.keys(kw).length || !flagsOk('keep_portraits')) return null;
      return { k: 'bg', bg: a[0] || '', keep: f.has('keep_portraits') };
    case 'transition': {
      if (c.alias !== 'transition' || a.length < 1 || a.length > 2 || Object.keys(kw).length || !flagsOk('no_block')) return null;
      if (!/^(open|close)$/.test(a[0])) return null;
      const ms = numOrNull(a[1]); if (ms === null) return null;
      return { k: 'transition', dir: a[0], ms: ms || null, together: T };
    }
    case 'location_card':
      if (a.length !== 1 || Object.keys(kw).length || f.size) return null;
      return { k: 'card', text: a[0] };
    case 'screen_shake': {
      if (a.length !== 1 || Object.keys(kw).length || !flagsOk('no_block')) return null;
      const ms = numOrNull(a[0]); if (!ms) return null;
      return { k: 'shake', ms, together: T };
    }
    case 'wait': {
      if (a.length !== 1 || Object.keys(kw).length || f.size) return null;
      const ms = numOrNull(a[0]); if (!ms) return null;
      return { k: 'wait', ms };
    }
    case 'music': {
      if (c.alias !== 'music' || a.length !== 1 || !kwOk('FadeIn', 'Volume') || f.size) return null;
      const fade = numOrNull(kw.FadeIn); if (fade === null) return null;
      const vol = numOrNull(kw.Volume); if (vol === null || vol === 1) return null;
      return { k: 'music', nid: a[0], fade: fade === undefined ? null : fade, vol: vol === undefined ? null : vol };
    }
    case 'music_clear': case 'music_fade_back': {
      if (c.alias !== c.name || a.length > 1 || Object.keys(kw).length || f.size) return null;
      const fade = numOrNull(a[0]); if (fade === null) return null;
      return { k: 'musicOff', mode: c.name === 'music_fade_back' ? 'back' : 'clear', fade: fade === undefined ? null : fade };
    }
    case 'sound': {
      if (a.length < 1 || a.length > 2 || Object.keys(kw).length || f.size) return null;
      const vol = numOrNull(a[1]); if (vol === null || vol === 1) return null;
      return { k: 'sound', nid: a[0], vol: vol === undefined ? null : vol };
    }
    case 'end': return c.raw === 'end;' ? { k: 'end' } : c.raw === 'end' ? { k: 'join' } : null;
    case 'choice': {
      if (c.alias !== 'choice' || a.length !== 3 || Object.keys(kw).length || f.size || !a[0]) return null;
      const options = a[2].split(',').map(x => x.trim());
      if (!options.length || options.some(x => !x)) return null;
      return { k: 'choice', nid: a[0], title: a[1], options };
    }
    case 'if': case 'elif': {
      const cond = c.raw.slice(c.raw.indexOf(';') + 1).trim();
      if (c.alias !== c.name || c.raw.indexOf(';') < 0 || !cond) return null;
      return { k: c.name, cond };
    }
    case 'else': return c.raw === 'else' || c.raw === 'else;' ? { k: 'else', semi: c.raw === 'else;' } : null;
  }
  return null;
}
function codeToSteps(src, doc) {
  const lines = String(src).split(/\r?\n/);
  const steps = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t) continue;
    if (t.startsWith('#')) {
      // consecutive comment lines become one note
      const prev = steps[steps.length - 1];
      const text = t.replace(/^#\s?/, '');
      if (prev && prev.k === 'note' && prev._line === i - 1) { prev.text += '\n' + text; prev._line = i; }
      else steps.push({ id: newId(), k: 'note', text, _line: i, _l: i });
      continue;
    }
    const start = i;
    const c = parseLine(lines[i], i);
    let st = cmdToStep(c, doc);
    if (st && st.k === 'enter' && st.how === 'instant' && isOffscreen(st.pos)) {
      // "walk in from off-screen" = add off-screen + move on screen
      let j = i + 1; while (j < lines.length && !lines[j].trim()) j++;
      const n = j < lines.length ? parseLine(lines[j], j) : null;
      const mv = n && n.name === 'move_portrait' ? cmdToStep(n, doc) : null;
      if (mv && mv.k === 'move' && mv.who === st.who) {
        const off = st.pos;
        st = { ...st, how: off === 'OffscreenLeft' ? 'walkL' : 'walkR', pos: mv.pos, speed: mv.speed, together: mv.together,
          mirror: st.mirror !== (autoMirror(off) !== autoMirror(mv.pos)) };
        i = j;
      }
    }
    if (st) {
      // keep only steps that write back exactly as they were typed
      const back = stepToLines(st, doc);
      const orig = [lines[i].trim()];
      if (st.k === 'enter' && (st.how === 'walkL' || st.how === 'walkR')) orig.unshift(null);
      const typed = st.k === 'enter' && back.length === 2 ? null : back[0];
      if (typed !== null && normalizeLine(unapplyWords(typed, doc.words)) !== normalizeLine(unapplyWords(orig[orig.length - 1], doc.words))) st = null;
    }
    steps.push(st ? { id: newId(), ...st, _l: start } : { id: newId(), k: 'raw', code: t, _l: start });
  }
  // "end;" closes a branch when one is open (LT treats end and end; alike)
  let depth = 0;
  for (const st of steps) {
    if (st.k === 'if') depth++;
    else if (st.k === 'join') depth = Math.max(0, depth - 1);
    else if (st.k === 'end' && depth > 0) { st.k = 'join'; st.semi = true; depth--; }
  }
  for (const s of steps) { if (s.k === 'note') s._l = s._l == null ? s._line : s._l; delete s._line; }
  return steps;
}
function normalizeLine(l) { return String(l).trim(); }

// ---------------------------------------------------------------------------
// What the stage looks like after a step (for character buttons and defaults)
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Branches in the step list
// ---------------------------------------------------------------------------
const FLOW_KIND = { if: 'if', elif: 'elif', else: 'else', join: 'end' };
const isFlow = s => !!s && (s.k in FLOW_KIND || s.k === 'choice');
function stepFlow(doc) { return analyzeFlow(doc.steps.length, i => FLOW_KIND[doc.steps[i].k] || null); }
// The arm a branch takes in the preview (and for "who's on stage" when a
// branch is entirely before the step you're looking at).
function previewArm(doc, b) {
  const conds = b.heads.map(h => doc.steps[h].k === 'else' ? null : doc.steps[h].cond);
  const pick = doc.steps[b.start].pv;   // "preview this path", saved on the branch's first step
  return decideArm(conds, b.hasElse, doc.preview || {}, pick == null ? null : pick);
}
// Steps that run, in order, to reach step `idx` (taking the arms that hold it).
function pathTo(doc, idx, flow) {
  flow = flow || stepFlow(doc);
  const forced = new Map();
  for (const { block, arm } of armsHolding(flow, idx)) forced.set(block.start, arm);
  const out = [];
  let i = 0;
  const n = doc.steps.length;
  while (i <= idx && i < n) {
    const b = flow.owner[i];
    const k = doc.steps[i].k;
    if (b && b.end != null && k === 'if') {
      const a = forced.has(i) ? forced.get(i) : previewArm(doc, b);
      if (a < 0) { i = b.end; continue; }
      i = b.arms[a].from; continue;
    }
    if (b && b.end != null && (k === 'elif' || k === 'else')) {
      if (i === idx) { out.push(i); break; }   // looking at an arm's head
      i = b.end; continue;
    }
    out.push(i); i++;
  }
  return out;
}
function sceneAfter(doc, idx) {
  const on = new Map();
  for (const j of idx < 0 ? [] : pathTo(doc, Math.min(idx, doc.steps.length - 1))) {
    const s = doc.steps[j];
    switch (s.k) {
      case 'bg': if (!s.keep) on.clear(); break;
      case 'enter': on.set(s.who, { pos: s.pos || 'Left', expr: s.expr || [] }); break;
      case 'enterMany': for (const p of s.list || []) if (p.who) on.set(p.who, { pos: p.pos || 'Left', expr: [] }); break;
      case 'leave': on.delete(s.who); break;
      case 'leaveMany': for (const w of s.list || []) on.delete(w); break;
      case 'move': if (on.has(s.who)) on.get(s.who).pos = s.pos; break;
      case 'expr': if (on.has(s.who)) on.get(s.who).expr = s.expr || []; break;
    }
  }
  return on;
}
function castOf(doc) {
  const seen = new Set();
  for (const s of doc.steps) {
    if (s.who) seen.add(s.who);
    if (s.k === 'enterMany') for (const p of s.list || []) if (p.who) seen.add(p.who);
    if (s.k === 'leaveMany') for (const w of s.list || []) if (w) seen.add(w);
  }
  return [...seen];
}
function lastSpeakerBefore(doc, idx) {
  if (idx < 0 || !doc.steps.length) return null;
  const path = pathTo(doc, Math.min(idx, doc.steps.length - 1));
  for (let p = path.length - 1; p >= 0; p--) if (doc.steps[path[p]].k === 'line') return doc.steps[path[p]].who;
  return null;
}
// Who talks next if you just keep typing: the other person on stage.
function nextSpeaker(doc, idx) {
  const on = [...sceneAfter(doc, idx).keys()];
  const last = lastSpeakerBefore(doc, idx);
  return on.find(w => w !== last) || last || on[0] || '';
}
// Everything that refers to an asset, for "swap all".
function assetUses(doc) {
  const u = { who: new Map(), bg: new Map(), music: new Map(), sound: new Map() };
  const add = (m, k) => { if (k) m.set(k, (m.get(k) || 0) + 1); };
  for (const s of doc.steps) {
    if (s.who) add(u.who, s.who);
    if (s.k === 'enterMany') for (const p of s.list || []) add(u.who, p.who);
    if (s.k === 'leaveMany') for (const w of s.list || []) add(u.who, w);
    if (s.k === 'bg') add(u.bg, s.bg);
    if (s.k === 'music') add(u.music, s.nid);
    if (s.k === 'sound') add(u.sound, s.nid);
  }
  return u;
}
function replaceAsset(doc, kind, from, to) {
  let n = 0;
  for (const s of doc.steps) {
    if (kind === 'who') {
      if (s.who === from) { s.who = to; n++; }
      if (s.k === 'enterMany') for (const p of s.list || []) if (p.who === from) { p.who = to; n++; }
      if (s.k === 'leaveMany') s.list = (s.list || []).map(w => w === from ? (n++, to) : w);
    }
    if (kind === 'bg' && s.k === 'bg' && s.bg === from) { s.bg = to; n++; }
    if (kind === 'music' && s.k === 'music' && s.nid === from) { s.nid = to; n++; }
    if (kind === 'sound' && s.k === 'sound' && s.nid === from) { s.nid = to; n++; }
  }
  return n;
}
// New branches. Options/arms start empty; the person fills each path.
function choiceBranchSteps(o) {
  const nid = o.nid || 'Choice1', options = o.options && o.options.length ? o.options : ['Yes', 'No'];
  const out = [{ k: 'choice', nid, title: o.title || '', options: [...options] }];
  options.forEach((opt, i) => out.push({ k: i ? 'elif' : 'if', cond: condFor(nid, opt) }));
  out.push({ k: 'join' });
  return out.map(s => ({ id: newId(), ...s }));
}
function ifBranchSteps(o) {
  return [{ k: 'if', cond: o.cond || condFor(o.name || 'YuelGender', o.value || 'Female') }, { k: 'else' }, { k: 'join' }]
    .map(s => ({ id: newId(), ...s }));
}
// The branch right after a choice whose conditions test that choice.
function branchForChoice(doc, ci, flow) {
  flow = flow || stepFlow(doc);
  const c = doc.steps[ci]; if (!c || c.k !== 'choice') return null;
  const b = flow.byStart.get(ci + 1);
  if (!b) return null;
  const tests = b.heads.every(h => doc.steps[h].k === 'else' || (p => p.type === 'var' && p.name === c.nid)(parseCond(doc.steps[h].cond)));
  return tests ? b : null;
}
// Keep a choice's arms matching its options (after adding, renaming or
// removing options). Existing arms keep their steps, matched by option text,
// then by position.
function syncChoiceArms(doc, ci) {
  const flow = stepFlow(doc), b = branchForChoice(doc, ci, flow), c = doc.steps[ci];
  if (!b || b.end == null) return false;
  const arms = b.arms.map(a => ({ head: doc.steps[a.head], steps: doc.steps.slice(a.from, a.to + 1) }));
  const byOpt = new Map();
  arms.forEach((a, k) => { const p = parseCond(a.head.cond); if (a.head.k !== 'else' && p.type === 'var') byOpt.set(p.value, k); });
  // exact matches first; then options that are new take (in order) the arms
  // whose option is gone, so renaming an option keeps its steps
  const assign = new Map(), used = new Set();
  c.options.forEach((opt, i) => { const k = byOpt.get(opt); if (k != null && !used.has(k)) { assign.set(i, k); used.add(k); } });
  const orphans = arms.map((a, k) => k).filter(k => !used.has(k) && arms[k].head.k !== 'else');
  c.options.forEach((opt, i) => { if (!assign.has(i) && orphans.length) { const k = orphans.shift(); assign.set(i, k); used.add(k); } });
  const rebuilt = [];
  c.options.forEach((opt, i) => {
    const k = assign.has(i) ? assign.get(i) : null;
    const steps = k != null ? arms[k].steps : [];
    const headId = k != null ? arms[k].head.id : newId();
    rebuilt.push({ id: headId, k: i ? 'elif' : 'if', cond: condFor(c.nid, opt) }, ...steps);
  });
  // an Otherwise arm stays at the end
  const els = arms.find(a => a.head.k === 'else');
  if (els) rebuilt.push(els.head, ...els.steps);
  doc.steps.splice(b.start, b.end - b.start, ...rebuilt);
  return true;
}
// Does some path always run? (an Otherwise, or a choice with a path for
// every answer)
function coversAll(doc, b, flow) {
  if (b.hasElse) return true;
  const ci = b.start - 1, c = doc.steps[ci];
  if (!c || c.k !== 'choice' || branchForChoice(doc, ci, flow) !== b) return false;
  const got = new Set(b.heads.map(h => parseCond(doc.steps[h].cond)).filter(p => p.type === 'var' && p.op === '==').map(p => p.value));
  return (c.options || []).every(o => got.has(o));
}
function stepKey(s, doc) { return stepToLines(s, doc).join('\n'); }
function cloneStep(s) { const c = JSON.parse(JSON.stringify(s)); c.id = newId(); return c; }
// Rejoin later: the n steps right after the branch now happen inside every
// arm (copied into each), so each path can change them. Adds an Otherwise
// arm first if there isn't one, so nothing stops happening for anyone.
// Returns the new index of the Rejoin step, or an error message.
function rejoinLater(doc, endIdx, n) {
  let flow = stepFlow(doc);
  let b = flow.owner[endIdx];
  if (!b || b.end !== endIdx) return 'That isn’t the end of a branch.';
  n = Math.max(1, n || 1);
  const take = doc.steps.slice(endIdx + 1, endIdx + 1 + n);
  if (take.length < n) return 'There aren’t that many steps after the branch.';
  let depth = 0;
  for (const s of take) {
    if (s.k === 'if') depth++;
    else if (s.k === 'join') { depth--; if (depth < 0) return 'That would cut through another branch.'; }
    else if ((s.k === 'elif' || s.k === 'else') && depth === 0) return 'That would cut through another branch.';
    else if (s.k === 'end' && depth === 0) return 'The End step has to stay outside branches.';
  }
  if (depth !== 0) return 'That would cut through another branch.';
  const covered = coversAll(doc, b, flow);
  doc.steps.splice(endIdx + 1, n);
  if (!covered) { doc.steps.splice(endIdx, 0, { id: newId(), k: 'else' }); endIdx++; }
  flow = stepFlow(doc); b = flow.owner[endIdx];
  // insert from the last arm backwards so earlier indices stay valid
  for (let a = b.arms.length - 1; a >= 0; a--) doc.steps.splice(b.arms[a].to + 1, 0, ...take.map(cloneStep));
  return stepFlow(doc).blocks.find(x => x.start === b.start).end;
}
// Rejoin earlier: if every arm ends with the same step, it moves out after
// the branch (once). Returns the new Rejoin index, or an error message.
function rejoinEarlier(doc, endIdx) {
  const flow = stepFlow(doc), b = flow.owner[endIdx];
  if (!b || b.end !== endIdx) return 'That isn’t the end of a branch.';
  if (!coversAll(doc, b, flow)) return 'Only branches where some path always runs (an “Otherwise”, or a choice) can rejoin earlier; otherwise some players would skip that step.';
  const lasts = b.arms.map(a => a.to >= a.from ? doc.steps[a.to] : null);
  if (lasts.some(s => !s)) return 'One of the paths is already empty.';
  if (lasts.some(s => isFlow(s) || s.k === 'end')) return 'A path ends with a branch; move that first.';
  const key = stepKey(lasts[0], doc);
  if (lasts.some(s => stepKey(s, doc) !== key)) return 'The paths end differently, so they can’t rejoin any earlier.';
  const keep = lasts[0];
  for (let a = b.arms.length - 1; a >= 0; a--) doc.steps.splice(b.arms[a].to, 1);
  const newEnd = endIdx - b.arms.length;
  doc.steps.splice(newEnd + 1, 0, keep);
  return newEnd;
}
function removeArm(doc, headIdx) {
  const flow = stepFlow(doc), b = flow.owner[headIdx];
  if (!b || b.end == null) return 'Not part of a branch.';
  const k = b.heads.indexOf(headIdx);
  if (b.arms.length <= 1) return removeBranch(doc, b.start);
  const a = b.arms[k];
  doc.steps.splice(a.head, a.to - a.head + 1);
  if (k === 0) { const nh = doc.steps[a.head]; if (nh && nh.k === 'elif') nh.k = 'if'; else if (nh && nh.k === 'else') { nh.k = 'if'; nh.cond = 'True'; } }
  return true;
}
// Remove a branch but keep one path's steps in place (default: the first).
function removeBranch(doc, ifIdx, keepArm) {
  const flow = stepFlow(doc), b = flow.byStart.get(ifIdx);
  if (!b || b.end == null) return 'Not a branch.';
  const a = b.arms[keepArm || 0];
  const kept = doc.steps.slice(a.from, a.to + 1);
  let start = b.start;
  const prev = doc.steps[start - 1];
  if (prev && prev.k === 'choice' && branchForChoice(doc, start - 1, flow)) start--;   // its choice goes too
  doc.steps.splice(start, b.end - start + 1, ...kept);
  return true;
}
function addArm(doc, afterHeadIdx, cond) {
  const flow = stepFlow(doc), b = flow.owner[afterHeadIdx];
  if (!b || b.end == null) return 'Not part of a branch.';
  const k = b.heads.indexOf(afterHeadIdx);
  // new "Or if" goes after this arm, but always before an Otherwise
  let at = b.arms[k].to + 1;
  if (b.hasElse && k === b.arms.length - 1) at = b.arms[k].head;
  doc.steps.splice(at, 0, { id: newId(), k: 'elif', cond: cond || 'True' });
  return at;
}

function newConversationSteps(o) {
  const steps = [];
  if (o.bg) steps.push({ k: 'bg', bg: o.bg, keep: false });
  if (o.music) steps.push({ k: 'music', nid: o.music, fade: 50 });
  if (o.loc) steps.push({ k: 'card', text: o.loc });
  steps.push({ k: 'enterMany', list: [{ who: o.left || '', pos: 'Left' }, { who: o.right || '', pos: 'Right' }] });
  steps.push(...(o.body || []));
  steps.push({ k: 'leaveMany', list: [o.left || '', o.right || ''].filter(Boolean) });
  steps.push({ k: 'transition', dir: 'close', ms: 1000 });
  steps.push({ k: 'musicOff', mode: 'clear', fade: 2000 });
  steps.push({ k: 'end' });
  return steps.map(s => ({ id: newId(), ...s }));
}

if (typeof module !== 'undefined') module.exports = { genCode, codeToSteps, stepToLines, sceneAfter, applyWords, unapplyWords, nextSpeaker, replaceAsset, assetUses, newConversationSteps,
  stepFlow, pathTo, previewArm, choiceBranchSteps, ifBranchSteps, syncChoiceArms, rejoinLater, rejoinEarlier, removeArm, removeBranch, addArm, branchForChoice };
