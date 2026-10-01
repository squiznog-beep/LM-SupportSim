// node tools/support_sim/test/model.test.js
const fs = require('fs'), vm = require('vm'), path = require('path'), assert = require('assert');
const ctx = { console, performance: { now: () => 0 }, module: {} };
vm.createContext(ctx);
for (const f of ['sim-engine.js', 'builder-model.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), ctx, { filename: f });
const M = ctx.module.exports;
const doc = { words: [{ w: 'Renais', c: 'blue' }], steps: [] };
let fails = 0;
const J = v => JSON.parse(JSON.stringify(v));
function check(name, fn) { try { fn(); console.log('ok  ', name); } catch (e) { fails++; console.log('FAIL', name, '\n    ', e.message); } }

const spec = `change_background;House
music;Healing;FadeIn=50
location_card;The training yard
uu;Seth;Left;Eirika;Right
s;Eirika;Seth! You're up early.|Again.
s;Seth;...;no_talk
e;Eirika;Smile
e;Seth;NoSmile
e;Seth;CloseEyes,OpenMouth
bop;Seth;5;15
bop;Seth;3
bop;Seth
mirror;Seth;5
mirror;Seth
move_portrait;Seth;OffscreenRight;0.4
move_portrait;Eirika;OffscreenRight;0.6
move_portrait;Eirika;CenterLeft
screen_shake;400
screen_shake;300;no_block
sound;Item
sound;Item;0.5
remove_portrait;Seth;immediate
add_portrait;Seth;Right;immediate
add_portrait;Seth;Right
add_portrait;Seth;Right;Slide=right;ExpressionList=Smile;no_block
add_portrait;Ross;OffscreenLeft;mirror;immediate
move_portrait;Ross;Right;0.5
remove_portrait;Ross;Slide=left
s;Eirika;Welcome to <blue>Renais</>, <red>friend</>.
s;Seth;I remember Renais.;FontType=iconvo
s;Seth;Psst.;FontColor=grey;no_block
s;Eirika;Hmm...;StyleNid=thought_bubble
wait;500
transition;open;500
multi_remove_portrait;Seth;Eirika
transition;close;1000
music_clear;2000
music_fade_back;400
# a note
# second note line
end;`;

check('spec lines become structured steps (no raw code)', () => {
  const steps = M.codeToSteps(spec, doc);
  const raw = steps.filter(s => s.k === 'raw');
  assert.deepStrictEqual(J(raw.map(s => s.code)), []);
});
check('code -> steps -> code is unchanged', () => {
  const steps = M.codeToSteps(spec, doc);
  const back = M.genCode({ ...doc, steps }).code;
  // "I remember Renais." gains the keyword colour; everything else identical
  const expect = spec.replace('I remember Renais.', 'I remember <blue>Renais</>.');
  assert.strictEqual(back, expect);
});
check('walk-in pair is one step', () => {
  const steps = M.codeToSteps('add_portrait;Ross;OffscreenLeft;mirror;immediate\nmove_portrait;Ross;Right;0.5', doc);
  assert.strictEqual(steps.length, 1); assert.strictEqual(steps[0].how, 'walkL'); assert.strictEqual(steps[0].pos, 'Right'); assert.strictEqual(steps[0].mirror, false);
});
check('walk-in from left to a left spot needs no mirror flag', () => {
  const lines = M.stepToLines({ k: 'enter', who: 'A', pos: 'Left', how: 'walkL' }, doc);
  assert.deepStrictEqual(J(lines), ['add_portrait;A;OffscreenLeft;immediate', 'move_portrait;A;Left']);
  const lines2 = M.stepToLines({ k: 'enter', who: 'A', pos: 'Right', how: 'walkL' }, doc);
  assert.deepStrictEqual(J(lines2), ['add_portrait;A;OffscreenLeft;mirror;immediate', 'move_portrait;A;Right']);
});
check('unknown commands and options stay exactly as typed', () => {
  const src = 'give_item;Eirika;Vulnerary\ns;Eirika;Hi;TextPosition=center\nspeak;Eirika;Long form\nadd_portrait;Seth;Left;;Smile\nbop;Seth;2';
  const steps = M.codeToSteps(src, doc);
  assert.deepStrictEqual(J(steps.map(s => s.k)), ['raw', 'raw', 'raw', 'raw', 'raw']);
  assert.strictEqual(M.genCode({ ...doc, steps }).code, src);
});
check('keyword colour not applied inside existing tags or twice', () => {
  assert.strictEqual(M.applyWords('Renais and <red>Renais</> and Renaissance', doc.words), '<blue>Renais</> and <red>Renais</> and Renaissance');
  assert.strictEqual(M.applyWords(M.applyWords('Renais', doc.words), doc.words), '<blue>Renais</>');
});
check('semicolons in text cannot break the command', () => {
  assert.strictEqual(M.stepToLines({ k: 'line', who: 'A', text: 'one; two' }, doc)[0], 's;A;one, two');
});
check('newline in a line becomes |', () => {
  assert.strictEqual(M.stepToLines({ k: 'line', who: 'A', text: 'one\ntwo' }, doc)[0], 's;A;one|two');
});
check('new conversation follows the spec boilerplate', () => {
  const steps = M.newConversationSteps({ left: 'Wood', right: 'Dualipa', bg: 'House', music: 'Healing' });
  assert.strictEqual(M.genCode({ ...doc, steps }).code,
    'change_background;House\nmusic;Healing;FadeIn=50\nuu;Wood;Left;Dualipa;Right\nmulti_remove_portrait;Wood;Dualipa\ntransition;close;1000\nmusic_clear;2000\nend;');
});
check('next speaker alternates', () => {
  const d = { ...doc, steps: M.codeToSteps('uu;A;Left;B;Right\ns;A;hi', doc) };
  assert.strictEqual(M.nextSpeaker(d, 1), 'B');
});
check('replace all', () => {
  const d = { ...doc, steps: M.codeToSteps('uu;A;Left;B;Right\ns;A;hi\ne;A;Smile\nmulti_remove_portrait;A;B', doc) };
  assert.strictEqual(M.replaceAsset(d, 'who', 'A', 'C'), 4);
  assert.strictEqual(M.genCode(d).code, 'uu;C;Left;B;Right\ns;C;hi\ne;C;Smile\nmulti_remove_portrait;C;B');
});

// ---- branches ----------------------------------------------------------
const branchy = `uu;YuelM;Left;Dito;Right
choice;Mood;How do you feel?;Good,Bad
if;game.game_vars.get('Mood') == 'Good'
s;YuelM;Great!
e;YuelM;Smile
elif;game.game_vars.get('Mood') == 'Bad'
s;YuelM;Ugh.
if;game.check_alive('Dito')
s;Dito;Dito?
end
end
if;game.game_vars['YuelGender'] == 'Female'
s;YuelM;As a woman...
else
s;YuelM;As a man...
end;
s;Dito;Dito.
end;`;
check('branches round-trip exactly, and none of it becomes raw code', () => {
  const steps = M.codeToSteps(branchy, doc);
  const d = { ...doc, steps };
  assert.strictEqual(M.genCode(d).code, branchy);
  assert.deepStrictEqual(steps.filter(s => s.k === 'raw').length, 0);
  assert.deepStrictEqual(J(steps.map(s => s.k)).filter(k => ['choice', 'if', 'elif', 'else', 'join', 'end'].includes(k)),
    ['choice', 'if', 'elif', 'if', 'join', 'join', 'if', 'else', 'join', 'end']);
  const f = M.stepFlow(d);
  assert.strictEqual(f.errors.length, 0);
  assert.strictEqual(f.blocks.length, 3);
});
check('the path to a step takes the arm that holds it', () => {
  const d = { ...doc, steps: M.codeToSteps(branchy, doc) };
  const iUgh = d.steps.findIndex(s => s.text === 'Ugh.');
  const path = M.pathTo(d, iUgh).map(i => d.steps[i]);
  assert.ok(!path.some(s => s.text === 'Great!'));
  // after the branch, the preview's variables pick the arm
  const last = d.steps.length - 2;
  d.preview = { YuelGender: 'Female', Mood: 'Good' };
  const p1 = J(M.pathTo(d, last).map(i => d.steps[i].text).filter(Boolean));
  assert.deepStrictEqual(p1, ['Great!', 'As a woman...', 'Dito.']);
  d.preview = { YuelGender: 'Male', Mood: 'Bad' };
  const p2 = J(M.pathTo(d, last).map(i => d.steps[i].text).filter(Boolean));
  assert.deepStrictEqual(p2, ['Ugh.', 'Dito?', 'As a man...', 'Dito.']);
});
check('new choice branch writes choice + if/elif + end', () => {
  const steps = M.choiceBranchSteps({ nid: 'Pick', title: 'Which?', options: ['A', 'B'] });
  assert.strictEqual(M.genCode({ ...doc, steps }).code,
    "choice;Pick;Which?;A,B\nif;game.game_vars.get('Pick') == 'A'\nelif;game.game_vars.get('Pick') == 'B'\nend");
});
check('editing a choice keeps each option’s steps', () => {
  const d = { ...doc, steps: M.codeToSteps("choice;P;Q;A,B\nif;game.game_vars.get('P') == 'A'\ns;X;one\nelif;game.game_vars.get('P') == 'B'\ns;X;two\nend", doc) };
  const old = [...d.steps[0].options];
  d.steps[0].options = ['B', 'Alpha', 'C'];   // reorder, rename A -> Alpha, add C
  assert.ok(M.syncChoiceArms(d, 0, old));
  assert.strictEqual(M.genCode(d).code,
    "choice;P;Q;B,Alpha,C\nif;game.game_vars.get('P') == 'B'\ns;X;two\nelif;game.game_vars.get('P') == 'Alpha'\ns;X;one\nelif;game.game_vars.get('P') == 'C'\nend");
});
check('rejoin later copies the next steps into every path (adding Otherwise)', () => {
  const d = { ...doc, steps: M.codeToSteps("if;game.game_vars.get('G') == 'F'\ns;Y;she\nend\ns;D;hello\ns;D;bye", doc) };
  const e = M.rejoinLater(d, 2, 1);
  assert.strictEqual(typeof e, 'number');
  assert.strictEqual(M.genCode(d).code, "if;game.game_vars.get('G') == 'F'\ns;Y;she\ns;D;hello\nelse\ns;D;hello\nend\ns;D;bye");
  assert.strictEqual(d.steps[e].k, 'join');
  // and back: the paths end the same, so they can rejoin earlier again
  const e2 = M.rejoinEarlier(d, e);
  assert.strictEqual(typeof e2, 'number');
  assert.strictEqual(M.genCode(d).code, "if;game.game_vars.get('G') == 'F'\ns;Y;she\nelse\nend\ns;D;hello\ns;D;bye");
  // different endings can't
  const d2 = { ...doc, steps: M.codeToSteps("if;x\ns;A;1\nelse\ns;A;2\nend", doc) };
  assert.strictEqual(typeof M.rejoinEarlier(d2, 4), 'string');
});
check('rejoin later refuses to cut through another branch', () => {
  const d = { ...doc, steps: M.codeToSteps("if;a\nelse\nend\nif;b\ns;A;x\nend", doc) };
  assert.strictEqual(typeof M.rejoinLater(d, 2, 2), 'string');
  assert.strictEqual(typeof M.rejoinLater(d, 2, 3), 'number');   // the whole second branch moves in
});
check('removing a branch keeps one path; removing an arm drops its steps', () => {
  const src = "choice;P;Q;A,B\nif;game.game_vars.get('P') == 'A'\ns;X;one\nelif;game.game_vars.get('P') == 'B'\ns;X;two\nend\ns;X;after";
  const d = { ...doc, steps: M.codeToSteps(src, doc) };
  M.removeArm(d, 1);
  assert.strictEqual(M.genCode(d).code, "choice;P;Q;A,B\nif;game.game_vars.get('P') == 'B'\ns;X;two\nend\ns;X;after");
  const d2 = { ...doc, steps: M.codeToSteps(src, doc) };
  M.removeBranch(d2, 1, 1);
  assert.strictEqual(M.genCode(d2).code, 's;X;two\ns;X;after');
});
check('a choice covers every answer, so rejoining later adds no Otherwise', () => {
  const d = { ...doc, steps: M.codeToSteps("choice;P;Q;A,B\nif;game.game_vars.get('P') == 'A'\nelif;game.game_vars.get('P') == 'B'\nend\ns;X;hi", doc) };
  const e = M.rejoinLater(d, 3, 1);
  assert.strictEqual(M.genCode(d).code, "choice;P;Q;A,B\nif;game.game_vars.get('P') == 'A'\ns;X;hi\nelif;game.game_vars.get('P') == 'B'\ns;X;hi\nend");
  assert.strictEqual(typeof M.rejoinEarlier(d, e), 'number');
  assert.strictEqual(M.genCode(d).code, "choice;P;Q;A,B\nif;game.game_vars.get('P') == 'A'\nelif;game.game_vars.get('P') == 'B'\nend\ns;X;hi");
});
check('looks come from the project events (YuelSetup), including the else branch', () => {
  const src = ["choice;YuelGender;Who?;Male,Female", "if;game.game_vars.get('YuelGender') == 'Female'", "change_portrait;Yuel;FemYuel",
    "set_unit_field;Yuel;voice_pitch;3", "game_var;YuelHe;'she'", "else", "game_var;YuelHe;\"he\"", "end"];
  const looks = J(vm.runInContext('looksFromEvents', ctx)([{ name: 'YuelSetup', _source: src }]));
  assert.deepStrictEqual(looks, [
    { var: 'YuelGender', value: 'Female', unit: 'Yuel', portrait: 'FemYuel' },
    { var: 'YuelGender', value: 'Female', unit: 'Yuel', field: ['voice_pitch', '3'] },
    { var: 'YuelGender', value: 'Female', unit: null, setVar: ['YuelHe', 'she'] },
    { var: 'YuelGender', value: 'Male', unit: null, setVar: ['YuelHe', 'he'] }]);
  assert.strictEqual(vm.runInContext('substituteVars', ctx)('I am {v:YuelHe}, {var:Nope}', { YuelHe: 'she' }), 'I am she, {var:Nope}');
});
process.exit(fails ? 1 : 0);
