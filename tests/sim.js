/* RJ-45 - teste sem som
 *
 *   node tests/sim.js
 *
 * Renderiza o Turntable fora do navegador (nenhum som sai) com os gestos do
 * aceite, tocados do jeito que o Minilab3 manda (relatório de 2026-11-07):
 *   - pitch wheel de 14 bits, ~100 mensagens/s (intervalo de 10 ms, às vezes 20 ms);
 *   - fader em CC de 7 bits, ~100 mensagens/s, com saltos de 20+ valores.
 * As mensagens chegam ao worklet no começo do bloco de 128 amostras seguinte, como
 * no MessagePort. Mede os "degraus": saltos de velocidade do disco e saltos de ganho
 * do fader entre amostras vizinhas. Roda também o jeito errado (naive: sem mola e sem
 * rampa) para provar que o teste enxerga o degrau. Mede a latência da mão ao som e
 * confere o motor (Torque, Stop), o jog e a prioridade da mão.
 */
"use strict";
const { Turntable } = require("../js/turntable.js");
const { demoSound } = require("../js/demo-sound.js");

const SR = 48000, BLOCK = 128, SPD = SR / 200;       // SPD: amostras por grau do disco
const SOUND = demoSound(SR);
let fails = 0;
const ok = (c, msg) => { console.log("  " + (c ? "ok    " : "FALHA ") + msg); if (!c) fails++; };
let seed = 7; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const TWO_PI = 2 * Math.PI;

/* ---------------------------------------------------------------- gestos -> eventos MIDI */
const WHEEL_RANGE = 360;
const pw = deg => Math.max(0, Math.min(16383, Math.round(8192 + deg / WHEEL_RANGE * 8192)));

/** Amostra uma função do tempo (ms) como o controlador: só manda quando o valor muda. */
function sample(fn, from, to, quant, make) {
  const ev = []; let prev = null;
  for (let t = from; t < to; t += (rnd() < 0.1 ? 20 : 10) + (rnd() - 0.5) * 3) {
    const q = quant(fn(t));
    if (q !== prev) { ev.push(make(t, q)); prev = q; }
  }
  return ev;
}
const wheelEv = (fn, from, to) => sample(fn, from, to, pw, (t, q) => ({ t, k: "wheel", v: q }));
const faderEv = (fn, from, to) => sample(fn, from, to, x => Math.round(Math.max(0, Math.min(1, x)) * 127), (t, q) => ({ t, k: "xf", x: q / 127 }));
/** A mão larga o wheel no tempo T: a mola devolve ao centro em ~90 ms. */
const release = (fn, T) => t => (t < T ? fn(t) : fn(T) * Math.max(0, 1 - (t - T) / 90));
const ramp = (t, ms) => Math.min(1, t / ms);        // a mão sai do repouso acelerando, não de um tranco

function apply(tt, m) {
  switch (m.k) {
    case "wheel": tt.wheel(m.v, m.t); break;
    case "jog": tt.jog(m.s, m.t); break;
    case "xf": tt.setFader(m.x); break;
  }
}

/** Roda amostra a amostra e devolve a velocidade, o ganho e a posição de cada uma. */
function trace(events, ms, opts, setup) {
  const tt = new Turntable(SR, opts);
  tt.load(SOUND);
  if (setup) setup(tt);
  events = events.slice().sort((a, b) => a.t - b.t);
  const total = Math.ceil(ms / 1000 * SR), v = new Float32Array(total), g = new Float32Array(total), y = new Float32Array(total), pos = new Float64Array(total);
  let e = 0, last = tt.total; const one = new Float32Array(1);
  for (let s = 0; s < total; s++) {
    if (s % BLOCK === 0) { const now = s / SR * 1000; while (e < events.length && events[e].t <= now) apply(tt, events[e++]); }
    tt.process(one, 1);
    v[s] = tt.total - last; last = tt.total; g[s] = tt.g; y[s] = one[0]; pos[s] = tt.total;
  }
  return { v, g, y, pos, tt };
}
const maxAbsDiff = (a, from = 1) => { let m = 0; for (let i = Math.max(1, from); i < a.length; i++) m = Math.max(m, Math.abs(a[i] - a[i - 1])); return m; };

/* ---------------------------------------------------------------- os quatro golpes */
const HAND = { // a mão, em graus do disco, por tempo (ms)
  baby: t => 40 * Math.sin(TWO_PI * 2.5 * t / 1000) * ramp(t, 150),
  chirp: t => 45 * Math.sin(TWO_PI * ((t / 1000 * 2.5) % 1)) * ramp(t, 150),
  transformer: t => (90 * t / 1000) * ramp(t, 150) - 5,
  flare: t => { const u = (t % 800) / 800; return 40 * (1 - Math.cos(TWO_PI * u)) * ramp(t, 150) - 10; },   // ida e volta de 80° (a mão não inverte num ponto só)
};
const TEND = { "baby scratch": 1600, "chirp": 1600, "transformer": 1400, "flare 2 cliques": 1600 };
const scenarios = {
  "baby scratch": () => wheelEv(release(HAND.baby, 1600), 0, 1700),
  // chirp: a mão vai e volta; o fader só abre no começo de cada ida (um "piu" curto)
  "chirp": () => [...wheelEv(release(HAND.chirp, 1600), 0, 1700), ...faderEv(t => ((t / 1000 * 2.5) % 1 < 0.25 ? 1 : 0), 0, 1600)],
  // transformer: mão em movimento lento, o fader liga e desliga a ~12 Hz
  "transformer": () => [...wheelEv(release(HAND.transformer, 1400), 0, 1500), ...faderEv(t => (Math.floor(t / 41.7) % 2 === 0 ? 1 : 0), 0, 1400)],
  // flare de 2 cliques: uma ida e volta com dois cortes do fader durante a ida
  "flare 2 cliques": () => [...wheelEv(release(HAND.flare, 1600), 0, 1700), ...faderEv(t => {
    const u = (t % 800) / 800; return u < .08 ? 1 : u < .16 ? 0 : u < .26 ? 1 : u < .34 ? 0 : u < .5 ? 1 : 0; }, 0, 1600)],
};

// 0,02 taxa/amostra = 960 taxa/s², uns 20x o pico de um baby scratch real (~0,001).
const V_STEP = 0.02, V_START = 0.1;   // V_START: partida e soltura, onde o próprio gesto muda de velocidade em ~10 ms
// a rampa do fader é de 1 ms (48 amostras): nenhum salto de ganho acima de 1/48 (+folga)
const G_STEP = 1 / 48 + 1e-6;

console.log("RJ-45 · teste sem som (offline, " + SR + " Hz, blocos de " + BLOCK + " amostras)");
for (const [name, mk] of Object.entries(scenarios)) {
  console.log("\n" + name);
  const ev = mk(), ms = 1900;
  const good = trace(ev, ms), naive = trace(ev, ms, { naive: true });
  // três janelas: a partida (a mão sai do repouso), o gesto em andamento e a soltura (a mola do wheel
  // devolve ao centro em ~90 ms: o desenho do gesto mesmo muda de sinal)
  const a = Math.round(0.25 * SR), b = Math.round((TEND[name] - 20) / 1000 * SR), c = Math.round(TEND[name] / 1000 * SR);
  const win = (x, i, j) => maxAbsDiff(x.subarray(0, j), i);
  const dv = win(good.v, a, b), dvN = win(naive.v, a, b), dg = maxAbsDiff(good.g, 1), dgN = maxAbsDiff(naive.g, 1);
  const dvOn = win(good.v, 1, a), dvOff = maxAbsDiff(good.v, c);
  let peak = 0; for (const s of good.y) peak = Math.max(peak, Math.abs(s));
  console.log(`    maior salto de velocidade: ${dv.toFixed(4)} taxa/amostra (sem mola: ${dvN.toFixed(2)})`);
  console.log(`    partida do gesto: ${dvOn.toFixed(4)} · soltura do wheel: ${dvOff.toFixed(4)}`);
  console.log(`    maior salto de ganho:      ${dg.toFixed(4)} (rampa de 1 ms = ${(1 / 48).toFixed(4)}; sem rampa: ${dgN.toFixed(2)})`);
  ok(dv < V_STEP, "sem degrau de velocidade (< " + V_STEP + ")");
  ok(dvOn < V_START && dvOff < V_START, "partida e soltura sem degrau (< " + V_START + ")");
  ok(dg <= G_STEP, "fader com rampa de 1 ms, sem degrau de ganho");
  ok(good.y.every(Number.isFinite) && peak <= 1, "saída finita e dentro de 0 dBFS (pico " + peak.toFixed(2) + ")");
  ok(dvN > V_STEP * 10, "controle: sem mola o degrau aparece (" + dvN.toFixed(2) + "), então o teste o enxerga");
  if (name !== "baby scratch") ok(dgN > 0.5, "controle: sem rampa o ganho salta (" + dgN.toFixed(2) + ")");
}

/* ---------------------------------------------------------------- seguir a mão */
console.log("\nseguir a mão (baby scratch, 40° a 2,5 Hz)");
{
  const r = trace(wheelEv(release(HAND.baby, 1600), 0, 1700), 1600);
  // posição do disco contra a posição da mão, deslocada de tau ms: o menor erro diz o atraso
  const t0 = Math.round(0.4 * SR), base = r.pos[t0] / SPD - HAND.baby(400);
  let best = null;
  for (let tau = -5; tau <= 25; tau += 0.5) {
    let sum = 0, n = 0;
    for (let s = t0; s < r.pos.length; s += 8) { const e = r.pos[s] / SPD - base - HAND.baby(s / SR * 1000 - tau); sum += e * e; n++; }
    const rms = Math.sqrt(sum / n);
    if (!best || rms < best.rms) best = { tau, rms };
  }
  console.log(`    atraso em movimento contínuo: ${best.tau.toFixed(1)} ms · erro depois de alinhar: ${best.rms.toFixed(2)}° RMS`);
  ok(best.tau < 10, "em movimento o disco está menos de 10 ms atrás da mão (" + best.tau.toFixed(1) + " ms)");
  ok(best.rms < 3, "o disco acompanha o desenho do gesto (erro < 3° de 40°)");
}

/* ---------------------------------------------------------------- latência de degrau */
console.log("\nlatência do software (degrau de 20° no pitch wheel)");
{
  let worst = 0, sum = 0; const N = 32;
  for (let k = 0; k < N; k++) {
    const t0 = 100 + k * (BLOCK / SR * 1000) / N;                // varre onde a mensagem cai dentro do bloco
    const ev = [{ t: 50, k: "wheel", v: pw(6) }, { t: 60, k: "wheel", v: pw(6.01) }, { t: t0, k: "wheel", v: pw(26) }];
    const r = trace(ev, 250), i0 = Math.round(t0 / 1000 * SR) - 1;
    let hit = null; for (let s = i0; s < r.pos.length; s++) if ((r.pos[s] - r.pos[i0]) / SPD >= 10) { hit = s / SR * 1000 - t0; break; }
    worst = Math.max(worst, hit); sum += hit;
  }
  console.log(`    50% do degrau: média ${(sum / N).toFixed(1)} ms · pior ${worst.toFixed(1)} ms (o bloco de ${BLOCK} amostras já custa até ${(BLOCK / SR * 1000).toFixed(1)} ms)`);
  ok(worst < 10, "menos de 10 ms da mensagem ao disco, no pior caso (" + worst.toFixed(1) + " ms)");
  let fw = 0;
  for (let k = 0; k < N; k++) {
    const t0 = 100 + k * (BLOCK / SR * 1000) / N, r = trace([{ t: t0, k: "xf", x: 0 }], 200);
    let hit = null; for (let s = 0; s < r.g.length; s++) if (r.g[s] <= 0.5) { hit = s / SR * 1000 - t0; break; }
    fw = Math.max(fw, hit);
  }
  console.log(`    fechar o fader (ganho a 50%): pior ${fw.toFixed(2)} ms`);
  ok(fw < 5, "corte do fader em menos de 5 ms (bloco + rampa de 1 ms)");
}

/* ---------------------------------------------------------------- motor, Stop, jog, prioridade */
const run = (tt, secs) => { const one = new Float32Array(1); for (let s = 0; s < secs * SR; s++) tt.process(one, 1); };
const fresh = f => { const tt = new Turntable(SR); tt.load(SOUND); if (f) f(tt); return tt; };

console.log("\nmotor");
{
  const one = new Float32Array(1);
  let tt = fresh(t => { t.setRun(true); t.setTorque(0.7); }), t95 = null;
  for (let s = 0; s < 3 * SR; s++) { tt.process(one, 1); if (t95 === null && tt.v >= 0.95) t95 = s / SR; }
  ok(Math.abs(t95 - 0.7) < 0.05, "Torque 0,7 s: parado a 33 1/3 em " + t95.toFixed(2) + " s");
  tt = fresh(t => { t.setRun(true); t.setTorque(0.1); }); let t1 = null;
  for (let s = 0; s < SR; s++) { tt.process(one, 1); if (t1 === null && tt.v >= 0.95) { t1 = s / SR; break; } }
  ok(t1 > 0.08 && t1 < 0.12, "Torque 0,1 s: partida seca (" + t1.toFixed(2) + " s)");
  tt = fresh(t => { t.setRun(false); t.v = 1; });
  const p0 = tt.total; run(tt, 4);
  const deg = (tt.total - p0) / SPD;
  ok(tt.v === 0 && deg >= 120 && deg <= 270, "Stop a 33 1/3 para em " + deg.toFixed(0) + "° (SL-1200MK2: 120° a 270°)");
  tt = fresh(t => { t.setRpm(45); t.setRun(true); }); run(tt, 3);
  ok(Math.abs(tt.v - 1.35) < 0.01, "45 RPM = 1,35x (" + tt.v.toFixed(3) + ")");
}
console.log("\npitch wheel e encoder");
{
  let tt = fresh(t => { t.setRun(true); t.v = 1; });
  tt.wheel(pw(30), 0);
  ok(tt.handOn, "wheel fora do centro = mão no disco");
  run(tt, 0.1); tt.wheel(8192, 100); run(tt, 0.08);
  ok(!tt.handOn, "wheel parado no centro solta o disco");
  tt = fresh(t => { t.setRun(true); t.v = 1; });
  tt.wheel(pw(20), 0); run(tt, 0.02); tt.wheel(pw(-20), 20); run(tt, 0.02); tt.wheel(pw(20), 40); run(tt, 0.01);
  ok(tt.handOn, "passar pelo centro no meio do scratch não solta o disco");
  tt = fresh(t => { t.setRun(true); t.v = 1; t.setMode("speed"); });
  tt.wheel(0, 0); run(tt, 0.1);
  ok(tt.v < -1.5, "modo Speed: wheel no fundo gira para trás, v = " + tt.v.toFixed(2));
  tt.wheel(8192, 100); run(tt, 2);
  ok(Math.abs(tt.v - 1) < 0.05, "modo Speed: soltar volta à velocidade do motor");
  tt = fresh(); const p0 = tt.total;
  for (let k = 0; k < 10; k++) { tt.jog(1, 1000 + k * 50); run(tt, 0.05); }
  const jd = (tt.total - p0) / SPD;
  ok(jd > 10 && jd < 60 && tt.v === 0, "jog devagar: 10 passos andam " + jd.toFixed(0) + "° e param");
  tt = fresh(t => { t.setRun(true); t.v = 1; });
  for (let k = 0; k < 12; k++) tt.jog(-2, 1000 + k * 6);
  ok(tt.v < -0.5, "encoder rápido para trás vira backspin, v = " + tt.v.toFixed(2));
  run(tt, 3);
  ok(Math.abs(tt.v - 1) < 0.05, "o motor devolve à velocidade normal no tempo do Torque");
  tt = fresh(); tt.wheel(pw(30), 0); const v0 = tt.v; tt.jog(2, 10);
  ok(tt.jogT === 0 && tt.v === v0, "wheel fora do centro ignora o encoder");
}
console.log("\nfader: curvas e Hamster");
{
  const tt = fresh();
  const gain = (c, x, h) => { tt.setCurve(c); tt.setHamster(!!h); tt.setFader(x); return tt.gT; };
  ok(gain("sharp", 0.03) === 0 && gain("sharp", 0.05) === 1, "Sharp: corte por limiar (cruzou = abriu)");
  ok(gain("medium", 0.04) === 0 && gain("medium", 0.5) === 1 && gain("medium", 0.15) > 0 && gain("medium", 0.15) < 1, "Medium: sobe em 25% do curso");
  ok(Math.abs(gain("smooth", 0.5) - 0.5) < 1e-9, "Smooth: linear");
  ok(gain("sharp", 1, true) === 0 && gain("sharp", 0, true) === 1, "Hamster inverte o lado");
}

console.log("\n" + (fails ? fails + " falha(s)" : "tudo certo"));
process.exit(fails ? 1 : 0);
