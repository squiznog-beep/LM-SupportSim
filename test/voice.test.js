// node tools/support_sim/test/voice.test.js
// The sim's voices must sound like the game's: same maths as
// app/utilities/voice.py (fixture made by make_voice_ref.py).
const fs = require('fs'), vm = require('vm'), path = require('path');
const ctx = { console, performance: { now: () => 0 }, module: {}, Float32Array, Math };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'sim-engine.js'), 'utf8'), ctx, { filename: 'sim-engine.js' });
const ref = JSON.parse(fs.readFileSync(path.join(__dirname, 'voice_ref.json'), 'utf8'));
let fails = 0;
for (const c of ref.cases) {
  const [volume, pitch, tone] = c.voice;
  const got = vm.runInContext('voiceProcess', ctx)([Float32Array.from(ref.signal)], ref.rate, { volume, pitch, tone })[0];
  let worst = 0;
  if (got.length !== c.out.length) { fails++; console.log('FAIL', c.voice, 'length', got.length, 'vs', c.out.length); continue; }
  for (let i = 0; i < got.length; i++) worst = Math.max(worst, Math.abs(got[i] - c.out[i]));
  // Float32 vs Python float: tiny rounding differences only
  if (worst > 1e-4) { fails++; console.log('FAIL', c.voice, 'max diff', worst); } else console.log('ok  ', 'voice', c.voice.join(','), 'max diff', worst.toExponential(1));
}
process.exit(fails ? 1 : 0);
