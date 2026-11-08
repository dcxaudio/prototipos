/* RJ-45 - o aparelho (interface e ligação com o áudio)
 *
 * O som mesmo é do Turntable (js/turntable.js), que roda no AudioWorklet
 * (js/worklet.js). Aqui ficam o painel do mockup aprovado, o MIDI e o host.
 *
 * Fluidez: o MIDI do Arturia vai da entrada MIDI do navegador direto para o
 * worklet por MessagePort (pitch wheel, fader e encoder), antes de qualquer
 * desenho. A tela só lê o estado que o worklet devolve (~48 vezes por segundo).
 *
 * MIDI padrão (depois do MIDI Learn, que tem prioridade):
 *   pitch bend     pitch wheel de 14 bits: mão no disco (Hand, curso ±30° por padrão,
 *                  regulável pelo controle "Wheel" do alto da página) ou velocidade (Speed)
 *   CC 14          fader (x = 0 lado da música, x = 1 lado do scratch no modo Mix) (fader 1 do Minilab3; CC 15, 30 e 31 ficam livres)
 *   CC 28 e 29     encoder relativo: jog; rápido vira empurrão ou backspin
 * O host escuta só a porta "Minilab3 MIDI" (ignora MCU/HUI e ALV, que repetem os
 * faders como pitch bend falso).
 */
(function () {
  "use strict";
  const RJ = window.RJ;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const $ = (s, r = document) => r.querySelector(s);
  const STATE_KEY = "state";
  const CC_FADER = 14, CC_JOG = [28, 29];
  const TORQUE_MIN = 0.1, TORQUE_MAX = 0.7;        // s; o padrão é 0,7 (SL-1200MK2)
  const CURVES = ["sharp", "medium", "smooth"];
  const SILENT = /[?&]silent\b/.test(location.search);   // gancho de teste: nada sai pelo alto-falante

  RJ.RJ45 = class {
    constructor(host) {
      this.host = host;
      this.id = host.id;
      this.on = false;
      this.st = { vol: 0.8, torque: 1, rpm: 33, run: false, mode: "hand", range: 30, mix: "mix", slip: true, src: "music", kit: "scratch-01", slot: 0, curve: "sharp", hamster: false, fader: 0.5 };
      this.tele = { pos: 0, total: 0, v: 0, g: 1, hand: false, seconds: 0, len: 0, at: performance.now(), sr: 48000 };
      this.name = "DEMO"; this.musicName = "DEMO";
      this.kits = {};                 // kit -> array de { slot, name, wav } (um por vez no global DCX.SCRATCH_KIT)
      this.gestCache = {};            // "kit/slot" -> Float32Array já decodificado
      this.held = false;              // a mão do mouse/toque está no disco
      this.knobs = {};
      this.msgs = 0;                  // mensagens de MIDI entregues ao worklet (para o teste)
      this.dirtyT = null;
    }

    /* =========================================================== montagem */

    build(root) {
      this.root = root;
      const q = s => $(s, root);
      this.el = {
        platter: q(".platter"), rot: q(".platter-rot"), xf: q(".xf"),
        lcdName: q("#lcd-name"), lcdTime: q("#lcd-time"),
        file: $("#r45-file"), lat: $("#lat"),
      };
      this.shown = { name: null, time: null, turn: null };

      // botões (clique na tela ou MIDI Learn)
      this.btn("start", "RJ-45 Start", () => this.setRun(!this.st.run));
      this.btn("cue", "RJ-45 Cue", () => { this.post({ k: "cue" }); this.setLcd(null, "0:00.0"); });
      this.btn("load", "RJ-45 Load", () => { this.el.file.value = ""; this.el.file.click(); });
      this.btn("grab", "RJ-45 Grab", () => this.flash("GRAB: STUDIO"));
      this.btn("speed", "RJ-45 33/45", () => this.setRpm(this.st.rpm === 33 ? 45 : 33));
      this.btn("wheel-mode", "RJ-45 Wheel Mode", () => this.setMode(this.st.mode === "hand" ? "speed" : "hand"));
      // chaves deslizantes
      this.sw = {};
      root.querySelectorAll(".sw").forEach(sw => {
        const id = sw.dataset.ctrl, cycle = () => {
          const o = sw.dataset.opts.split(",");
          const next = o[(o.indexOf(sw.dataset.pos) + 1) % o.length];
          if (id === "xf-curve") this.setCurve(next); else this.setHamster(next === "on");
        };
        this.sw[id] = sw;
        sw.addEventListener("click", cycle);
        this.host.learn.add(id, sw, id === "xf-curve" ? "RJ-45 Curve" : "RJ-45 Hamster", "button", { down: cycle });
      });
      // knobs
      this.bindKnob("torque", "RJ-45 Torque", () => this.st.torque, v => { this.st.torque = v; this.post({ k: "torque", s: this.torqueSec() }); this.flash("TQ " + this.torqueSec().toFixed(2) + "s"); });
      this.bindKnob("volume", "RJ-45 Volume", () => this.st.vol, v => { this.st.vol = v; this.applyVol(); this.flash("VOL " + Math.round(v * 127)); });
      // fader de scratch
      this.bindFader();
      // disco
      this.bindPlatter();
      // arquivo
      this.el.file.addEventListener("change", e => {
        const f = (e.target.files || [])[0];
        if (f) this.loadFile(f);
      });
      // curso do pitch wheel: controle da página (fora do painel aprovado), em tempo real
      this.rangeEl = $("#r45-range"); this.rangeOut = $("#r45-range-v");
      if (this.rangeEl) this.rangeEl.addEventListener("input", () => this.setRange(+this.rangeEl.value));
      // disco do scratch (botões do painel): fonte, kit, gesto, modo do fader e Slip
      this.btn("src", "RJ-45 Scratch Source", () => this.setSource(this.st.src === "music" ? "sample" : "music"));
      this.btn("kit", "RJ-45 Kit", () => this.setKit(this.st.kit === "scratch-01" ? "scratch-02" : "scratch-01"));
      this.btn("gest-prev", "RJ-45 Gesture -", () => this.stepGesture(-1));
      this.btn("gest-next", "RJ-45 Gesture +", () => this.stepGesture(1));
      this.btn("fader-mode", "RJ-45 Fader Mix/Cut", () => this.setMix(this.st.mix === "mix" ? "cut" : "mix"));
      this.btn("slip", "RJ-45 Slip", () => this.setSlip(!this.st.slip));
      // MIDI padrão do aparelho
      this.host.midi.addDefaults(d => this.midi(d));

      this.paintAll();
      requestAnimationFrame(t => this.frame(t));
    }

    /** Botão de tecla: clique na tela e alvo do MIDI Learn. */
    btn(id, name, fn) {
      const el = $(`[data-ctrl="${id}"]`, this.root);
      if (!el) return;
      el.addEventListener("click", () => { if (this.host.on) fn(); });
      this.host.learn.add(id, el, name, "button", { down: () => { if (this.host.on) fn(); } });
    }

    bindKnob(id, name, get, set) {
      const el = $(`[data-ctrl="${id}"]`, this.root);
      const draw = () => el.style.setProperty("--a", (-135 + get() * 270) + "deg");
      const put = v => { if (!this.host.on) return; set(clamp(v, 0, 1)); draw(); this.dirty(); };
      this.knobs[id] = { el, draw };
      this.host.learn.add(id, el, name, "value", { get, set: put });
      let y0 = 0, v0 = 0;
      el.addEventListener("pointerdown", e => { e.preventDefault(); el.setPointerCapture(e.pointerId); y0 = e.clientY; v0 = get(); el.dataset.drag = "1"; });
      el.addEventListener("pointermove", e => { if (el.dataset.drag) put(v0 + (y0 - e.clientY) / 170); });
      ["pointerup", "pointercancel"].forEach(ev => el.addEventListener(ev, () => { delete el.dataset.drag; }));
      el.addEventListener("wheel", e => { e.preventDefault(); put(get() - Math.sign(e.deltaY) * 0.02); }, { passive: false });
      el.addEventListener("keydown", e => {
        const d = { ArrowUp: 0.02, ArrowRight: 0.02, ArrowDown: -0.02, ArrowLeft: -0.02 }[e.key];
        if (d == null) return;
        e.preventDefault(); e.stopPropagation(); put(get() + d);
      });
      draw();
    }

    bindFader() {
      const xf = this.el.xf;
      const at = e => { const r = xf.getBoundingClientRect(); return clamp((e.clientX - r.left - 13) / (r.width - 26), 0, 1); };
      xf.addEventListener("pointerdown", e => { e.preventDefault(); xf.setPointerCapture(e.pointerId); xf.dataset.drag = "1"; this.setFader(at(e)); });
      xf.addEventListener("pointermove", e => {
        if (!xf.dataset.drag) return;
        for (const c of (e.getCoalescedEvents ? e.getCoalescedEvents() : null) || [e]) this.setFader(at(c));   // cada ponto do movimento, sem perder o corte rápido
      });
      ["pointerup", "pointercancel"].forEach(ev => xf.addEventListener(ev, () => { delete xf.dataset.drag; }));
      xf.addEventListener("keydown", e => {
        const d = { ArrowRight: 0.05, ArrowUp: 0.05, ArrowLeft: -0.05, ArrowDown: -0.05, Home: -1, End: 1 }[e.key];
        if (d == null) return;
        e.preventDefault(); e.stopPropagation(); this.setFader(Math.abs(d) === 1 ? (d > 0 ? 1 : 0) : this.st.fader + d);
      });
      this.host.learn.add("xfader", xf, "RJ-45 Fader", "value", { get: () => this.st.fader, set: v => this.host.on && this.setFader(v) });
    }

    bindPlatter() {
      const p = this.el.platter;
      let acc = 0, lastA = 0;
      const angleOf = e => { const r = p.getBoundingClientRect(); return Math.atan2(e.clientY - (r.top + r.height / 2), e.clientX - (r.left + r.width / 2)) * 180 / Math.PI; };
      p.addEventListener("pointerdown", e => {
        if (!this.host.on || this.host.learn.learning) return;
        e.preventDefault();
        p.setPointerCapture(e.pointerId);
        this.held = true; acc = 0; lastA = angleOf(e);
        p.classList.add("grab");
        this.post({ k: "hand", on: true, a: 0, t: e.timeStamp });
      });
      p.addEventListener("pointermove", e => {
        if (!this.held) return;
        for (const c of (e.getCoalescedEvents ? e.getCoalescedEvents() : null) || [e]) {
          const a = angleOf(c); let d = a - lastA;
          if (d > 180) d -= 360; if (d < -180) d += 360;
          lastA = a; acc += d;
          this.post({ k: "hand", on: true, a: acc, t: c.timeStamp });
        }
      });
      const release = () => { if (!this.held) return; this.held = false; p.classList.remove("grab"); this.post({ k: "hand", on: false, a: 0, t: performance.now() }); };
      p.addEventListener("pointerup", release); p.addEventListener("pointercancel", release);
      // soltar um arquivo no disco
      p.addEventListener("dragover", e => { e.preventDefault(); p.classList.add("drop"); });
      p.addEventListener("dragleave", () => p.classList.remove("drop"));
      p.addEventListener("drop", e => {
        e.preventDefault(); p.classList.remove("drop");
        const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (f && this.host.on) this.loadFile(f);
      });
    }

    /* =========================================================== liga */

    async boot() {
      if (this.on || !this.host.on) return;
      this.on = true;
      this.root.classList.add("on");
      const ctx = this.host.engine.ensure();
      const url = f => new URL(f, document.baseURI).href;
      await ctx.audioWorklet.addModule(url("js/turntable.js"));
      await ctx.audioWorklet.addModule(url("js/worklet.js"));
      this.node = new AudioWorkletNode(ctx, "rj45-turntable", { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
      this.node.port.onmessage = e => { Object.assign(this.tele, e.data, { at: performance.now() }); };
      this.vol = ctx.createGain();
      this.node.connect(this.vol);
      this.vol.connect(this.host.output());
      this.tele.sr = ctx.sampleRate;
      this.post({ k: "load", data: RJ45.demoSound(ctx.sampleRate) });
      try {
        const saved = await this.host.store.get(STATE_KEY);
        if (saved) Object.assign(this.st, JSON.parse(saved), { run: false });
      } catch (e) { console.warn("Estado do RJ-45 ilegível, usando o padrão", e); }
      this.applyAll();
      this.paintAll();
      this.setLcd("DEMO", "0:00.0");
      this.showLatency(ctx);
      this.post({ k: "src", s: "music" });
      if (this.st.src === "sample") this.setSource("sample"); else this.setKit(this.st.kit, true);
    }

    showLatency(ctx) {
      const b = (ctx.baseLatency || 0) * 1000, o = (ctx.outputLatency || 0) * 1000, blk = 128 / ctx.sampleRate * 1000;
      this.latency = { base: b, output: o, block: blk };
      this.el.lat.textContent = `latência: bloco ${blk.toFixed(1)} ms · navegador ${b.toFixed(1)} ms · saída ${o.toFixed(1)} ms`;
    }

    post(m, transfer) { if (this.node) this.node.port.postMessage(m, transfer || []); }

    applyAll() {
      const s = this.st;
      this.applyVol();
      this.post({ k: "torque", s: this.torqueSec() });
      this.post({ k: "rpm", v: s.rpm });
      this.post({ k: "mode", m: s.mode });
      this.post({ k: "range", deg: s.range });
      this.post({ k: "mix", m: s.mix });
      this.post({ k: "slip", on: s.slip });
      this.post({ k: "curve", c: s.curve });
      this.post({ k: "hamster", on: s.hamster });
      this.post({ k: "xf", x: s.fader });
      this.post({ k: "run", on: s.run });
    }
    applyVol() { if (this.vol) this.vol.gain.value = SILENT ? 0 : this.st.vol * this.st.vol; }   // curva quadrática: o meio do knob não é "metade do ruído"
    torqueSec() { return TORQUE_MIN + this.st.torque * (TORQUE_MAX - TORQUE_MIN); }

    /* =========================================================== ações */

    setRun(r) { this.st.run = r; this.post({ k: "run", on: r }); this.paintRun(); this.flash(r ? "START" : "STOP"); }
    setRpm(v) { this.st.rpm = v; this.post({ k: "rpm", v }); this.paintRpm(); this.dirty(); this.flash(v + " RPM"); }
    setMode(m) { this.st.mode = m; this.post({ k: "mode", m }); this.paintMode(); this.dirty(); this.flash(m === "hand" ? "WHEEL HAND" : "WHEEL SPEED"); }
    setRange(deg) {
      deg = clamp(Math.round(deg), 5, 360);
      this.st.range = deg; this.post({ k: "range", deg }); this.paintRange(); this.dirty(); this.flash("WHEEL ±" + deg);
    }
    setMix(m) { this.st.mix = m === "cut" ? "cut" : "mix"; this.post({ k: "mix", m: this.st.mix }); this.paintDisc(); this.dirty(); this.flash(this.st.mix === "mix" ? "FADER MIX" : "FADER CUT"); }
    setSlip(on) { this.st.slip = !!on; this.post({ k: "slip", on: this.st.slip }); this.paintDisc(); this.dirty(); this.flash(on ? "SLIP ON" : "SLIP OFF"); }
    /* ---- fonte do scratch e kits ---- */

    /** Injeta o kit.js do kit pedido (os dois definem DCX.SCRATCH_KIT, então um de cada vez) e guarda o array. */
    loadKit(kit) {
      if (this.kits[kit]) return Promise.resolve(this.kits[kit]);
      return new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = new URL(`kits/${kit}/kit.js`, document.baseURI).href;
        s.onload = () => {
          const arr = (window.DCX && window.DCX.SCRATCH_KIT) || null;
          if (window.DCX) delete window.DCX.SCRATCH_KIT;     // o próximo kit começa limpo
          s.remove();
          if (!arr || !arr.length) return reject(new Error("kit vazio"));
          this.kits[kit] = arr; resolve(arr);
        };
        s.onerror = () => { s.remove(); reject(new Error("kit não encontrado")); };
        document.head.appendChild(s);
      });
    }
    async decodeGesture(kit, i) {
      const key = kit + "/" + i;
      if (this.gestCache[key]) return this.gestCache[key];
      const g = this.kits[kit][i], ctx = this.host.engine.ensure();
      const dec = await RJ.decodeAudio(ctx, RJ.dsp.base64ToArrayBuffer(g.wav));
      return (this.gestCache[key] = dec.raw);
    }
    async setKit(kit, quiet) {
      try {
        await this.loadKit(kit);
        this.st.kit = kit; this.st.slot = clamp(this.st.slot, 0, this.kits[kit].length - 1);
        this.paintDisc();
        if (this.st.src === "sample") await this.applyGesture();
        this.dirty();
      } catch (e) { console.warn("Kit não abriu", e); if (!quiet) this.flash("KIT ERRO"); }
    }
    async setGesture(i) {
      const arr = this.kits[this.st.kit]; if (!arr) return;
      this.st.slot = ((i % arr.length) + arr.length) % arr.length;
      this.dirty();
      if (this.st.src !== "sample") { this.st.src = "sample"; this.post({ k: "src", s: "sample" }); this.paintDisc(); }
      await this.applyGesture();
    }
    stepGesture(d) { return this.setGesture(this.st.slot + d); }
    async applyGesture() {
      const arr = this.kits[this.st.kit]; if (!arr) return;
      const g = arr[this.st.slot], seq = (this.gseq = (this.gseq || 0) + 1);
      try {
        const raw = await this.decodeGesture(this.st.kit, this.st.slot);
        if (seq !== this.gseq) return;                    // chegou outro pedido: vale o último
        const data = raw.slice();
        this.post({ k: "sample", data }, [data.buffer]);
        this.setLcd(g.slot + " " + g.name.toUpperCase().replace(/[^A-Z0-9 ]/g, "").slice(0, 7), "0:00.0");
      } catch (e) { console.warn("Gesto não abriu", e); this.flash("GESTO ERRO"); }
    }
    async setSource(s) {
      s = s === "sample" ? "sample" : "music";
      this.st.src = s; this.paintDisc(); this.dirty();
      if (s === "sample") {
        this.flash("SCRATCH SAMPLE");
        if (!this.kits[this.st.kit]) await this.setKit(this.st.kit);
        await this.applyGesture();
        this.post({ k: "src", s });
      } else {
        this.post({ k: "src", s }); this.setLcd(this.musicName, null); this.flash("SCRATCH MUSIC");
      }
    }
    paintDisc() {
      this.led("src-mus", this.st.src === "music"); this.led("src-smp", this.st.src === "sample");
      this.led("kit-1", this.st.kit === "scratch-01"); this.led("kit-2", this.st.kit === "scratch-02");
      this.led("mix", this.st.mix === "mix"); this.led("cut", this.st.mix === "cut");
      this.led("slip", this.st.slip && this.st.mix === "mix");
    }
    paintRange() {
      this.paintDisc();
      if (this.rangeEl) this.rangeEl.value = this.st.range;
      if (this.rangeOut) this.rangeOut.textContent = "±" + this.st.range + "°";
    }
    setCurve(c) { this.st.curve = c; this.post({ k: "curve", c }); this.paintSwitches(); this.dirty(); this.flash("CURVE " + c.toUpperCase()); }
    setHamster(on) { this.st.hamster = on; this.post({ k: "hamster", on }); this.paintSwitches(); this.dirty(); this.flash(on ? "HAMSTER ON" : "HAMSTER OFF"); }
    setFader(x) {
      x = clamp(x, 0, 1);
      this.st.fader = x;
      this.post({ k: "xf", x });               // primeiro o som; o desenho vem no quadro seguinte
      this.faderDirty = true;
    }

    async loadFile(f) {
      try {
        this.setLcd("LOADING", null);
        const ctx = this.host.engine.ensure();
        const dec = await RJ.decodeAudio(ctx, await f.arrayBuffer());
        const raw = dec.raw;
        if (!raw.length) throw new Error("arquivo vazio");
        const data = raw.slice();
        this.post({ k: "load", data }, [data.buffer]);
        this.musicName = (f.name.replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9 ]/g, "").toUpperCase() || "SOM").slice(0, 10);
        this.setLcd(this.musicName, "0:00.0");
      } catch (e) {
        console.warn("Não deu para abrir o arquivo", e);
        this.setLcd("ERRO", null);
      }
    }

    /* =========================================================== MIDI (direto para o worklet) */

    midi(d) {
      if (!this.host.on) return "Off";
      if (!this.node) return null;
      const st = d[0] & 0xf0, t = performance.now();
      if (st === 0xe0) {
        this.post({ k: "wheel", v: d[1] | (d[2] << 7), t }); this.msgs++;
        return "RJ-45 Wheel";
      }
      if (st === 0xb0) {
        if (d[1] === CC_FADER) { this.setFader(d[2] / 127); this.msgs++; return "RJ-45 Fader"; }
        if (CC_JOG.includes(d[1])) {
          const s = d[2] - 64;                          // relativo: 64 ± n
          if (s) { this.post({ k: "jog", s, t }); this.msgs++; }
          return "RJ-45 Jog";
        }
      }
      return null;
    }

    /* =========================================================== tela */

    dirty() {
      clearTimeout(this.dirtyT);
      this.dirtyT = setTimeout(() => this.saveNow(), 500);
    }
    saveNow() {
      if (!this.on) return;
      const { vol, torque, rpm, mode, range, mix, slip, src, kit, slot, curve, hamster, fader } = this.st;
      try { this.host.store.put(STATE_KEY, JSON.stringify({ vol, torque, rpm, mode, range, mix, slip, src, kit, slot, curve, hamster, fader })); } catch (e) { console.warn(e); }
    }

    setLcd(name, time) {
      if (name != null) this.name = name;
      if (name != null && this.el.lcdName.textContent !== name) this.el.lcdName.textContent = name;
      if (time != null && this.el.lcdTime.textContent !== time) this.el.lcdTime.textContent = time;
      this.lcdAt = performance.now();
    }
    /** Um aviso curto no lugar do nome; o nome do som volta em 1,2 s. */
    flash(text) {
      this.el.lcdName.textContent = text;
      clearTimeout(this.flashT);
      this.flashT = setTimeout(() => { this.el.lcdName.textContent = this.name; }, 1200);
    }

    led(n, on) { const l = $(`[data-led="${n}"]`, this.root); if (l) l.classList.toggle("on", !!on); }
    paintRun() { $('[data-ctrl="start"]', this.root).classList.toggle("down", this.st.run); }
    paintRpm() { this.led("33", this.st.rpm === 33); this.led("45", this.st.rpm === 45); }
    paintMode() { this.led("hand", this.st.mode === "hand"); this.led("speed", this.st.mode === "speed"); $('[data-ctrl="wheel-mode"]', this.root).dataset.pos = this.st.mode; }
    paintSwitches() {
      const set = (id, pos) => { const sw = this.sw[id]; sw.dataset.pos = pos; this.paintSwitch(sw); };
      set("xf-curve", this.st.curve); set("hamster", this.st.hamster ? "on" : "off");
    }
    paintSwitch(sw) {
      const opts = sw.dataset.opts.split(","), i = opts.indexOf(sw.dataset.pos), slot = sw.querySelector(".slot"), th = sw.querySelector(".thumb");
      const w = slot.clientWidth - 8 - th.offsetWidth;
      th.style.left = 4 + (opts.length > 1 ? w * i / (opts.length - 1) : 0) + "px";
      sw.querySelectorAll(".pos span").forEach((s, j) => s.classList.toggle("sel", j === i));
    }
    paintAll() {
      this.led("power", this.on);
      this.paintRange(); this.paintRun(); this.paintRpm(); this.paintMode(); this.paintSwitches();
      Object.values(this.knobs).forEach(k => k.draw());
      this.el.xf.style.setProperty("--pos", this.st.fader.toFixed(3));
    }

    /** Um quadro de tela: o giro do disco, o tempo, o LED Touch e o fader. */
    frame(now) {
      requestAnimationFrame(t => this.frame(t));
      const T = this.tele;
      if (this.faderDirty) { this.faderDirty = false; this.el.xf.style.setProperty("--pos", this.st.fader.toFixed(3)); }
      if (!this.on) return;
      // giro: o último estado do worklet mais o que andou desde então, na velocidade dele
      const ahead = clamp((now - T.at) / 1000, 0, 0.1) * T.sr * T.v;
      const turn = 20 + (T.total + ahead) / (T.sr / 200);
      const q = Math.round(turn * 10) / 10;
      if (q !== this.shown.turn) { this.shown.turn = q; this.el.rot.style.setProperty("--turn", q + "deg"); }
      this.led("touch", this.held || T.hand);
      const s = Math.max(0, T.seconds), time = `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;
      if (time !== this.shown.time) { this.shown.time = time; this.el.lcdTime.textContent = time; }
    }
  };
})();
