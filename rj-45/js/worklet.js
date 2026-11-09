/* RJ-45 - AudioWorkletProcessor
 *
 * Carregar depois de js/turntable.js (os dois no mesmo escopo do worklet).
 * Recebe o MIDI e os gestos por MessagePort e aplica direto no Turntable, sem
 * passar pela interface. Manda o estado de volta ~48 vezes por segundo.
 *   { k: "load", data: Float32Array }
 *   { k: "wheel", v: 0..16383, t: ms }     pitch wheel de 14 bits
 *   { k: "hand", on, a: graus, t: ms }     mouse ou toque
 *   { k: "jog", s: passo, t: ms }          encoder relativo
 *   { k: "xf", x: 0..1 }  { k: "curve", c } { k: "hamster", on }
 *   { k: "sample", data: Float32Array } { k: "src", s: "music"|"sample" }   disco do scratch
 *   { k: "mix", m: "mix"|"cut" } { k: "slip", on }
 *   { k: "range", deg }                  curso do pitch wheel em graus (±)
 *   { k: "run", on } { k: "rpm", v } { k: "torque", s } { k: "mode", m } { k: "cue" }
 */
class RJ45Processor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.tt = new RJ45.Turntable(sampleRate);
    this.blocks = 0;
    this.port.onmessage = e => {
      const m = e.data, tt = this.tt;
      switch (m.k) {
        case "load": tt.load(m.data); break;
        case "wheel": tt.wheel(m.v, m.t); break;
        case "hand": tt.hand(m.on, m.a, m.t); break;
        case "jog": tt.jog(m.s, m.t); break;
        case "xf": tt.setFader(m.x); break;
        case "curve": tt.setCurve(m.c); break;
        case "hamster": tt.setHamster(m.on); break;
        case "run": tt.setRun(m.on); break;
        case "rpm": tt.setRpm(m.v); break;
        case "torque": tt.setTorque(m.s); break;
        case "sample": tt.loadSample(m.data); break;
        case "src": tt.setSource(m.s); break;
        case "mix": tt.setMix(m.m); break;
        case "slip": tt.setSlip(m.on); break;
        case "range": tt.setWheelRange(m.deg); break;
        case "mode": tt.setMode(m.m); break;
        case "cue": tt.cue(); break;
      }
    };
  }
  process(inputs, outputs) {
    const out = outputs[0];
    if (!out || !out[0]) return true;
    this.tt.process(out[0], out[0].length);
    for (let c = 1; c < out.length; c++) out[c].set(out[0]);
    if (++this.blocks % 8 === 0) this.port.postMessage(this.tt.snapshot());
    return true;
  }
}
registerProcessor("rj45-turntable", RJ45Processor);
