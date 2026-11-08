/* RJ-45 - página solo
 *
 * Monta um host só com o RJ-45 (RJ.Host.solo): targets() devolve só "file" e o
 * armazenamento usa o prefixo "rj45/". O encaixe no Studio fica para depois da v0.1.
 */
(function () {
  "use strict";
  const RJ = window.RJ;

  window.addEventListener("DOMContentLoaded", () => {
    const host = RJ.Host.solo("rj45");
    const dev = new RJ.RJ45(host.view("rj45"));
    host.add("rj45", dev, { label: "RJ-45" });
    const root = document.getElementById("r45");
    dev.build(root);
    new RJ.LearnBar(host, { root, bar: document.getElementById("learnbar") });

    // tela de ligar: o navegador só libera o som depois de um toque
    const power = document.getElementById("power");
    const on = () => { host.power(); power.classList.add("off"); };
    document.getElementById("power-btn").addEventListener("click", on);

    // teclado: Espaço liga e desliga o motor, C volta ao começo
    window.addEventListener("keydown", e => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (!host.on) { if (e.code === "Space" || e.code === "Enter") { e.preventDefault(); on(); } return; }
      if (e.target && /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(e.target.tagName)) return;
      if (e.code === "Space") { e.preventDefault(); if (!e.repeat) dev.setRun(!dev.st.run); }
      else if (e.code === "KeyC" && !e.repeat) { dev.post({ k: "cue" }); dev.setLcd(null, "0:00.0"); }
    });

    // no console: RJ.solo (o host) e RJ.rj45
    RJ.solo = host; RJ.rj45 = dev;
  });
})();
