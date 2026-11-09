/* RJ-45 - som de demonstração do disco
 *
 * Um "ahh" de vogal em quatro sílabas, uma por 0,45 s (o loop inteiro é um giro a 33 1/3),
 * feito na hora: serra com banda limitada passada por dois formantes, mais um sopro
 * curto no começo de cada sílaba. Serve para ter o que arranhar sem trazer arquivo.
 * Os sons de scratch próprios da DCX vêm depois (ver docs/manual.md, "O que falta").
 */
(function (g) {
  "use strict";
  function demoSound(sr) {
    const secs = 1.8, N = Math.round(sr * secs), out = new Float32Array(N);
    // formantes: filtro passa-faixa de 2ª ordem (RBJ), um por vogal
    const bp = (f, q) => {
      const w = 2 * Math.PI * f / sr, al = Math.sin(w) / (2 * q), b0 = al, a0 = 1 + al, a1 = -2 * Math.cos(w), a2 = 1 - al;
      let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
      return x => { const y = (b0 * x - b0 * x2 - a1 * y1 - a2 * y2) / a0; x2 = x1; x1 = x; y2 = y1; y1 = y; return y; };
    };
    const vowels = [[700, 1100], [500, 1700], [650, 1000], [350, 2100]];
    let seed = 12345; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
    const syl = Math.round(sr * 0.45);
    for (let s = 0; s < 4; s++) {
      const f1 = bp(vowels[s][0], 6), f2 = bp(vowels[s][1], 8), f0 = 110 + s * 12;
      const nh = Math.min(40, Math.floor(sr / 2 / f0) - 1);
      let ph = 0;
      for (let i = 0; i < syl; i++) {
        const t = i / syl, env = Math.min(1, i / (sr * 0.006)) * Math.pow(1 - t, 0.7);
        ph += (f0 * (1 + 0.04 * Math.sin(2 * Math.PI * 5 * i / sr))) / sr;
        let x = 0; for (let h = 1; h <= nh; h++) x += Math.sin(2 * Math.PI * ph * h) / h;
        x = x * 0.6 + (i < sr * 0.02 ? rnd() * 0.8 * (1 - i / (sr * 0.02)) : 0);
        out[s * syl + i] = (f1(x) + 0.7 * f2(x)) * env;
      }
    }
    let pk = 0; for (let i = 0; i < N; i++) pk = Math.max(pk, Math.abs(out[i]));
    const k = pk ? 0.8 / pk : 1; for (let i = 0; i < N; i++) out[i] *= k;
    return out;
  }
  const ns = typeof module === "object" && module.exports ? module.exports : (g.RJ45 = g.RJ45 || {});
  ns.demoSound = demoSound;
})(typeof globalThis !== "undefined" ? globalThis : this);
