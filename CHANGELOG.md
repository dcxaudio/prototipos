# Changelog

## v0.1 (rascunho local, ainda sem commit)

- Primeira versão do RJ-45, com o painel do mockup aprovado (`dcx-design/rj-45/mockup.html`) e o host do [dcx-core](https://github.com/dcxaudio/dcx-core) v1.1.0 (submódulo em `vendor/dcx-core`). Os dados ficam no navegador com o prefixo `rj45/`.
- Disco de 7" em AudioWorklet: leitura com interpolação cúbica (Catmull-Rom), em loop, para a frente e para trás; motor simulado (33 1/3 e 45 RPM, Torque de 0,1 a 0,7 s, padrão 0,7 s; o Stop para em 190°, dentro dos 120°–270° do SL-1200MK2).
- Mão no disco: mouse ou toque, e o pitch wheel de 14 bits (modo Hand). O alvo é contínuo e a mola criticamente amortecida tira o degrau das mensagens de 100 Hz do Minilab3; em movimento o disco fica ~3,5 ms atrás da mão. Modo Speed: o wheel manda na velocidade (backspin).
- Fader de scratch com rampa de 1 ms, corte por limiar (Sharp), curvas Sharp/Medium/Smooth e Hamster. CC 14 (fader 1 do Minilab3) liga o fader por padrão.
- Encoder relativo (CC 28 e 29): devagar é jog; rápido é empurrão ou backspin; o pitch wheel fora do centro ignora o encoder.
- MIDI direto no worklet por MessagePort; MIDI Learn do host em todos os controles. O host escuta só a porta "Minilab3 MIDI".
- `tests/sim.js`: teste sem som dos quatro golpes do aceite, da latência e do motor.
- Ainda não: Grab (Studio), encaixe no Studio, sons de scratch próprios da DCX e ajuste fino no Minilab3 (ver `docs/manual.md`).
