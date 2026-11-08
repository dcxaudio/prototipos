/* RJ-45 - o toca-discos (DSP)
 *
 * Um disco de 7" que lê um sample em loop. Roda no AudioWorklet (js/worklet.js)
 * e, igual, no Node (tests/sim.js), para o teste não precisar de som.
 *
 * Unidades: a posição (pos) é em amostras; a velocidade (v) é "taxa de leitura",
 * 1 = 33 1/3 RPM, 1,35 = 45 RPM, negativa = para trás. Um giro do disco a 33 1/3
 * dura 1,8 s, então 1 taxa = 200 graus por segundo.
 *
 * Fluidez (requisitos do card):
 *  - a mão no disco (pitch wheel de 14 bits ou mouse/toque) não entra como degrau:
 *    cada mensagem move o alvo de uma mola criticamente amortecida, com
 *    extrapolação pela velocidade medida (lead), então o disco anda liso entre
 *    as mensagens de 100 Hz do Arturia e o atraso fica abaixo de 10 ms;
 *  - o fader mexe no ganho com rampa de 1 ms (sem clique e sem atraso); o corte é
 *    por limiar (cruzou = abriu), não pela curva de volume;
 *  - a leitura usa interpolação cúbica (Catmull-Rom / Hermite de 4 pontos);
 *  - o MIDI chega ao worklet por MessagePort, sem passar pela interface.
 */
(function (g) {
  "use strict";
  const RATE_DEG = 200;            // graus por segundo a taxa 1 (33 1/3 RPM)
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

  /** Valores iniciais. Os de MIDI vêm do relatório do Minilab3 (2026-11-07); ajustar no ouvido. */
  const DEFAULTS = {
    omega: 350,            // rad/s da mola que segue o alvo (2/omega = atraso de uma rampa)
    segFrac: 0.3,          // fração do intervalo entre mensagens para o alvo alcançar a mão prevista
    vNew: 0.8,             // peso da velocidade medida na última mensagem (o resto é a anterior)
    leadMs: 3,             // extrapolação à frente da mão, em ms
    rampMs: 1,             // rampa do fader
    jogSmoothMs: 12,       // suavização do jog (encoder)
    wheelRangeDeg: 360,    // curso total do pitch wheel em graus do disco (±)
    wheelIn: 0.012,        // fração do curso para "pôr a mão" (≈ 98 de 8192)
    wheelOut: 0.006,       // fração para "tirar a mão" ...
    wheelDwellMs: 40,      // ... depois de ficar tanto tempo parado no centro (a mola chegou)
    speedGain: 3,          // modo Speed: taxa somada com o wheel no fim do curso
    torqueSec: 0.7,        // Torque padrão (SL-1200MK2: 0,7 s de parado a 33 1/3)
    brakeDeg: 190,         // o Stop do SL-1200MK2 para entre 120° e 270°
    jogDeg: 1.5,           // graus por passo do encoder, devagar
    jogFast: 60,           // passos/s a partir dos quais vira impulso
    impulse: 0.1,          // taxa somada por passo em impulso
    cutIn: 0.04,           // fração do curso em que o fader abre (Sharp e Medium)
    naive: false,          // só para o teste: sem mola e sem rampa (o jeito errado)
  };

  class Turntable {
    constructor(sr, opts) {
      this.sr = sr;
      this.o = Object.assign({}, DEFAULTS, opts || {});
      this.data = null; this.len = 0;
      this.pos = 0; this.total = 0;   // total: posição sem dar a volta no loop (para o giro)
      this.v = 0;
      this.t = 0;                     // relógio do worklet, em amostras
      this.run = false; this.rpm = 33;
      this.torque = this.o.torqueSec;
      // mão
      this.h = { on: false, x: 0, u: 0, p: 0, vEst: 0, iv: 10, ms: 0, arr: 0, first: true };
      this.wTouch = false; this.wN = 0; this.mode = "hand"; this.speedN = 0; this.speedOn = false;
      // jog
      this.jogT = 0; this.jogRate = 0; this.jogMs = -1e9;
      // fader
      this.fx = 1; this.curve = "sharp"; this.hamster = false;
      this.gT = 1; this.g = 1;
      this.updateGain();
    }

    load(data) { this.data = data; this.len = data ? data.length : 0; this.pos = 0; this.total = 0; }
    setRun(r) { this.run = !!r; }
    setRpm(r) { this.rpm = r === 45 ? 45 : 33; }
    setTorque(sec) { this.torque = clamp(sec, 0.05, 2); }
    setMode(m) { this.mode = m === "speed" ? "speed" : "hand"; this.speedOn = false; this.speedN = 0; }
    setCurve(c) { this.curve = c; this.updateGain(); }
    setHamster(b) { this.hamster = !!b; this.updateGain(); }
    cue() { this.pos = 0; this.total = 0; }
    get rate() { return this.rpm === 45 ? 45 / (100 / 3) : 1; }
    get handOn() { return this.h.on || this.wTouch; }

    /* ---------------------------------------------------------------- fader */
    setFader(x) { this.fx = clamp(x, 0, 1); this.updateGain(); }
    updateGain() {
      const x = this.hamster ? 1 - this.fx : this.fx, c = this.o.cutIn;
      let g;
      if (this.curve === "sharp") g = x >= c ? 1 : 0;                       // cruzou = abriu
      else if (this.curve === "medium") { const s = clamp((x - c) / 0.25, 0, 1); g = s * s * (3 - 2 * s); }
      else g = x;                                                           // smooth: linear no curso todo
      this.gT = g;
      if (this.o.naive) this.g = g;
    }

    /* ---------------------------------------------------------------- mão */
    handBegin(a, ms) {
      const h = this.h;
      h.on = true; h.x = a; h.tp = a; h.tv = 0; h.vs = 0; h.seg = 0; h.p = a; h.u = this.v * RATE_DEG; h.vEst = 0; h.iv = 10;
      h.ms = ms; h.arr = this.t; h.first = true; h.offs = []; h.late = 0;
      this.syncClock(ms);
    }
    /**
     * Os relógios do remetente (ms da mensagem) e do worklet diferem, e a mensagem chega no
     * começo de um bloco. A menor diferença entre os dois nas últimas 24 mensagens é "chegou sem
     * atraso"; o que passar disso é atraso de entrega (h.late), que a extrapolação cobre.
     */
    syncClock(ms) {
      const h = this.h, off = this.t / this.sr * 1000 - ms;
      h.offs.push(off); if (h.offs.length > 24) h.offs.shift();
      h.late = off - Math.min.apply(null, h.offs);
    }
    handMove(a, ms) {
      const h = this.h;
      if (!h.on) return this.handBegin(a, ms);
      const dt = ms - h.ms;
      if (dt > 0.5) {
        const inst = (a - h.p) / dt;                       // graus por ms
        h.vEst = h.first ? 0 : (1 - this.o.vNew) * h.vEst + this.o.vNew * inst;
        h.iv = 0.8 * h.iv + 0.2 * clamp(dt, 2, 40);
        h.first = false;
        h.ms = ms;
      }
      h.p = a; h.arr = this.t;
      this.syncClock(ms);
      // alvo contínuo: do ponto onde está até onde a mão vai estar em seg ms, e depois segue na
      // velocidade medida até a próxima mensagem. Não pula de posição, então o disco não ganha degrau.
      const o = this.o, segMs = clamp(o.segFrac * h.iv, 3, 15), n = Math.max(1, Math.round(segMs * 1e-3 * this.sr));
      h.vs = h.vEst * 1000 / this.sr;                       // graus por amostra
      const goal = a + h.vEst * (h.late + segMs + o.leadMs);
      h.tv = (goal - h.tp) / n; h.seg = n;
      if (o.naive) { h.tp = a; h.seg = 0; h.vs = 0; }
    }
    handEnd() {
      const h = this.h;
      if (!h.on) return;
      h.on = false;
      this.v = h.u / RATE_DEG;                             // o disco solta já na velocidade da mão
    }
    /** Mouse ou toque: ângulo acumulado em graus. */
    hand(on, a, ms) { if (on) this.handMove(a, ms); else this.handEnd(); }

    /** Pitch wheel de 14 bits (0 a 16383, centro 8192). */
    wheel(raw, ms) {
      const n = clamp((raw - 8192) / 8192, -1, 1), o = this.o;
      if (this.mode === "speed") {
        this.speedOn = Math.abs(n) > o.wheelIn;
        this.speedN = this.speedOn ? n : 0;
        return;
      }
      const a = n * o.wheelRangeDeg;
      this.wN = n;
      if (!this.wTouch) {
        if (Math.abs(n) < o.wheelIn) return;
        this.wTouch = true;
        this.handBegin(a, ms);
      } else this.handMove(a, ms);       // passar pelo centro no meio do scratch não solta o disco
    }

    /** Encoder relativo (CC 28/29): passo com sinal. Devagar é jog; rápido é impulso. */
    jog(step, ms) {
      if (!step || this.handOn) return;                    // mão no disco tem prioridade
      const o = this.o, dt = ms - this.jogMs;
      const inst = dt > 250 ? Math.abs(step) * 8 : (Math.abs(step) / Math.max(dt, 1)) * 1000;
      this.jogRate = dt > 250 ? inst : 0.6 * this.jogRate + 0.4 * inst;
      this.jogMs = ms;
      if (this.jogRate < o.jogFast) this.jogT += step * o.jogDeg * (1 + this.jogRate / 30);
      else this.v = clamp(this.v + Math.sign(step) * Math.abs(step) * o.impulse * Math.min(this.jogRate / o.jogFast, 2), -6, 6);
    }

    /* ---------------------------------------------------------------- áudio */
    process(out, n) {
      const sr = this.sr, o = this.o, dt = 1 / sr, d = this.data, L = this.len, spd = sr / RATE_DEG;
      const w = o.omega, w2 = w * w, h = this.h;
      const slew = o.naive ? 2 : 1 / (o.rampMs * 1e-3 * sr);
      const kBack = 1 - Math.exp(-dt / 0.015);
      const kT = 1 - Math.exp(-dt / (this.torque / 3));    // 95% do caminho em "torque" segundos
      const kSp = 1 - Math.exp(-dt / 0.008), kJ = 1 - Math.exp(-dt / (o.jogSmoothMs * 1e-3));
      const brake = RATE_DEG / (2 * o.brakeDeg) * dt;      // taxa por amostra (a = v0^2 / 2D)
      for (let i = 0; i < n; i++) {
        let dpos;                                          // amostras andadas neste passo
        if (this.wTouch && Math.abs(this.wN) < o.wheelOut && (this.t - h.arr) > o.wheelDwellMs * 1e-3 * sr) { this.wTouch = false; this.handEnd(); }
        if (h.on) {
          if (h.seg > 0) { h.tp += h.tv; h.seg--; }
          else if ((this.t - h.arr) / sr * 1000 < 2 * h.iv) h.tp += h.vs;          // segue na velocidade medida
          else h.tp += (h.p - h.tp) * kBack;                                        // parou o fluxo: volta ao último ponto
          if (o.naive) { dpos = (h.tp - h.x) * spd; h.x = h.tp; h.u = 0; }
          else {
            h.u += (w2 * (h.tp - h.x) - 2 * w * h.u) * dt;
            h.x += h.u * dt;
            dpos = h.u * dt * spd;
          }
        } else {
          const base = this.run ? this.rate : 0;
          if (this.speedOn) this.v += (base + this.speedN * o.speedGain - this.v) * kSp;
          else if (base === 0) {
            if (this.v > brake) this.v -= brake; else if (this.v < -brake) this.v += brake; else this.v = 0;
          } else this.v += (base - this.v) * kT;
          dpos = this.v;
        }
        if (this.jogT) { const j = this.jogT * kJ; this.jogT -= j; dpos += j * spd; if (Math.abs(this.jogT) < 1e-6) this.jogT = 0; }
        this.pos += dpos; this.total += dpos;
        if (this.pos >= L || this.pos < 0) this.pos -= L * Math.floor(this.pos / L);
        this.t++;

        // fader: rampa linear de 1 ms
        if (this.g < this.gT) { this.g += slew; if (this.g > this.gT) this.g = this.gT; }
        else if (this.g > this.gT) { this.g -= slew; if (this.g < this.gT) this.g = this.gT; }

        if (!d || !L) { out[i] = 0; continue; }
        // interpolação cúbica (Catmull-Rom) de 4 pontos
        let i1 = Math.floor(this.pos); const f = this.pos - i1;
        if (i1 >= L) i1 = 0;
        const i0 = i1 === 0 ? L - 1 : i1 - 1, i2 = i1 + 1 >= L ? i1 + 1 - L : i1 + 1, i3 = i2 + 1 >= L ? i2 + 1 - L : i2 + 1;
        const y0 = d[i0], y1 = d[i1], y2 = d[i2], y3 = d[i3];
        const c1 = 0.5 * (y2 - y0), c2 = y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3, c3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2);
        out[i] = (((c3 * f + c2) * f + c1) * f + y1) * this.g;
      }
    }

    /** Estado para a interface (e para o teste). */
    snapshot() {
      return { pos: this.pos, total: this.total, v: this.handOn ? this.h.u / RATE_DEG : this.v, g: this.g, hand: this.handOn,
        seconds: this.len ? this.pos / this.sr : 0, len: this.len };
    }
  }

  Turntable.DEFAULTS = DEFAULTS; Turntable.RATE_DEG = RATE_DEG;
  const ns = typeof module === "object" && module.exports ? module.exports : (g.RJ45 = g.RJ45 || {});
  ns.Turntable = Turntable;
})(typeof globalThis !== "undefined" ? globalThis : this);
