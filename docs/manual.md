# RJ-45 · manual curto

## O painel

| Controle | O que faz |
|---|---|
| **Disco** (platter) | Arraste em cima: mão no disco. O disco para de seguir o motor e segue a mão; o LED **Touch** acende. Solte e ele volta à velocidade do motor no tempo do Torque. Solte um arquivo de áudio em cima para trocar o som. |
| **Start / Stop** | Liga e desliga o motor. Ao parar, o freio leva ~190° até o disco parar (como o SL-1200MK2, 120° a 270°). Atalho: `Espaço`. |
| **Speed** | 33 1/3 ou 45 RPM (45 toca 1,35x mais rápido). |
| **Torque** | Tempo da partida, de parado até a velocidade: 0,1 s (seco) a 0,7 s ("arrasta"). Padrão 0,7 s. Vale também para o disco voltar ao motor depois da mão. |
| **Fader de scratch** | Modo **Mix** (padrão, botão Mode do grupo Scratch Disc): esquerda = a música como ia estar tocando, direita = o que você faz no disco, no meio os dois; Hamster inverte os lados. Modo **Cut**: o fader clássico, só o scratch, esquerda corta. Curso curto, rampa de 1 ms. **Slip** (botão Slip, padrão ligado): ao largar o disco, o scratch volta para onde a música está. |
| **Curve** | Sharp: cada lado entra por limiar (cruzou os 4% do curso, abriu); Medium: potência constante (no Cut, sobe nos 25% seguintes); Smooth: linear. |
| **Hamster** | Inverte o lado do fader. |
| **Wheel** | Hand: o pitch wheel é a mão no disco (padrão). Speed: o pitch wheel manda na velocidade, para backspin (para baixo = para trás). |
| **Scratch Disc: Source / Kit / Gest − + / Mode / Slip** (painel, grupo "Scratch Disc") | Mode troca o fader entre Mix e Cut, Slip liga o retorno à música. O disco da música é sempre a música carregada. **Scratch: Música** faz o disco que você mexe tocar a mesma música; **Sample** faz tocar um gesto dos kits CC0 (kit 01: tons, stabs e vozes; kit 02: gestos de scratch), em loop. Kit troca o kit e Gest − / + trocam o gesto (o LCD mostra o slot); tudo aprende pelo MIDI Learn. |
| **Cue** | Volta o som ao começo. Atalho: `C`. |
| **Load** | Abre um arquivo de áudio (WAV, MP3, AIFF, OGG...) e põe no disco. O som toca em loop; um giro a 33 1/3 dura 1,8 s. |
| **Grab** | No Studio, grava os últimos segundos do RJ-2000/404 como o som do disco. Na página solo só avisa (ainda não feito). |
| **Volume** | Volume de saída (curva quadrática). |
| **Visor** | Nome do som e tempo da posição no sample. Mostra o último ajuste por 1,2 s. |

## Arturia Minilab3

O host só escuta a porta **"Minilab3 MIDI"** (ignora MCU/HUI e ALV, que repetem os faders como pitch bend falso).

| Controle | Mensagem | O que faz |
|---|---|---|
| Pitch wheel | pitch bend, 14 bits, ~100 mensagens/s | Hand: a mão no disco, curso inteiro = ±30° por padrão (micro riscos); regule no controle "Wheel Hand" do alto da página (5° a 360°). Speed: velocidade. O disco só "solta a mão" quando o wheel fica parado no centro por 40 ms (passar pelo centro no meio do scratch não solta). |
| Fader 1 | CC 14 | Fader de scratch. |
| Encoder | CC 28 e 29 (relativo, 64 ± n) | Devagar (< 60 passos/s): jog, ~1,5° por passo (mais, quanto mais rápido). Rápido: empurra o disco; para trás é backspin. O motor devolve à velocidade normal no tempo do Torque. Com o wheel fora do centro, o encoder é ignorado. |

Qualquer outro controle (CC 15/30/31, mod wheel CC 1, knobs, pads, teclas) aprende pelo **MIDI Learn**: aperte o botão no alto da página, toque num controle do painel, mexa no controlador e aperte Enter. O Learn tem prioridade sobre o mapa padrão.

## Como fica fluido

- Disco e fader rodam no AudioWorklet. O MIDI vai do navegador direto ao worklet por MessagePort; a tela só desenha o estado que o worklet devolve.
- Cada mensagem do wheel move um alvo **contínuo** (nunca pula) que se adianta à mão pela velocidade medida; uma mola criticamente amortecida (350 rad/s) segue o alvo. Entre as mensagens de 100 Hz o disco anda liso, sem o degrau a 100 Hz.
- O fader leva o ganho ao alvo numa rampa linear de 1 ms. Sharp corta por limiar, não pela curva de volume.
- Leitura por interpolação cúbica de 4 pontos, para a frente e para trás.

## Teste

`node tests/sim.js` (nenhum som sai). Os gestos são gerados como o Minilab3 manda: wheel de 14 bits a ~100 mensagens/s com jitter e intervalos de 20 ms, fader de 7 bits com saltos. As mensagens chegam no começo do bloco de 128 amostras seguinte, como no MessagePort. O que se mede:

- **Degrau**: maior salto de velocidade do disco entre amostras vizinhas (limite 0,02 taxa/amostra, ~20x o pico de um baby scratch real) e maior salto de ganho do fader (limite = a rampa de 1 ms). Cada teste roda também o jeito errado (sem mola, sem rampa), que tem de passar do limite: assim se sabe que o teste enxerga o degrau.
- **Latência do software**: degrau de 20° no wheel chega a 50% em 7,9 ms em média e 9,1 ms no pior caso (inclui o bloco de 2,7 ms); o fader fecha a 50% em até 3,1 ms; em movimento contínuo o disco fica ~3,5 ms atrás da mão.
- **Motor**: Torque, Stop, 45 RPM, modos do wheel, jog, impulso, prioridade da mão e curvas do fader.

Limite do que o teste prova: ele mede o worklet, não o ouvido. A latência de ponta a ponta soma a do Minilab3/USB e a de saída do navegador e da placa, que aparece no rodapé da página (no navegador do app deu cerca de 40 ms só de saída). Confirmar no ouvido, com o Arturia, continua sendo o aceite final.

## O que falta (v0.1)

- Ouvir os quatro golpes no Arturia (aceite de Igor) e ajustar no ouvido: curso do wheel (±30° agora), força do jog/impulso, janela de Sharp (4%), Medium.
- Grab e o encaixe no Studio (`host.route`/`host.input`); os sons de scratch próprios da DCX; salvar o sample carregado.
- Anti-aliasing em velocidades altas (acima de ~3x o som tem alias; só interpolação cúbica).
