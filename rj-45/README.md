# RJ-45

Toca-discos de scratch que roda no navegador: um disco de 7" que para quando você toca e segue a mão (como a roda do TP-7), mais um fader de scratch como o crossfader de um mixer. É um projeto open source da [DCX Audio](https://github.com/dcxaudio), irmão do RJ-2000, do RJ-950, do RJ-42 e do DCX 404.

- Arraste o disco com o mouse ou o dedo; o fader corta o som.
- Arturia Minilab3: **pitch wheel** (14 bits) = mão no disco (Hand) ou velocidade (Speed); **fader 1** (CC 14) = fader de scratch; **encoder** (CC 28/29) = jog e, rápido, empurrão ou backspin.
- Solte um arquivo de áudio no disco (ou **Load**) para trocar o som. O padrão é um "ahh" de demonstração de 1,8 s.
- O manual está em [docs/manual.md](docs/manual.md).

## Rodar no seu computador

```bash
cd rj-45 && python3 -m http.server 8000
```

Depois abra `http://localhost:8000`. Não tem build nem dependências. O AudioWorklet precisa de `http://` (não abre por `file://`) e o MIDI, de Chrome, Edge ou Opera.

## Teste sem som

```bash
node tests/sim.js
```

Renderiza o disco e o fader fora do navegador (nada toca) com baby scratch, chirp, transformer e flare de 2 cliques, no ritmo de mensagens do Minilab3, e mede degraus, latência, Torque, Stop, jog e as curvas do fader. Detalhes em [docs/manual.md](docs/manual.md#teste).

## Estrutura

```
index.html            página solo (host do dcx-core com só o RJ-45)
js/turntable.js       o toca-discos: DSP puro, roda no worklet e no Node
js/worklet.js         AudioWorkletProcessor (recebe o MIDI por MessagePort)
js/rj45.js            o aparelho: painel, MIDI, arquivo, display e armazenamento
js/solo.js            monta a página: host, teclado, tela de ligar
js/demo-sound.js      som de demonstração, gerado na hora
css/rj45.css          o painel (mockup aprovado)
tests/sim.js          teste sem som
docs/manual.md        manual curto
vendor/dcx-core/      submódulo do dcx-core v1.1.0
```

## Licença

GPL-3.0 ([LICENSE](LICENSE)).
