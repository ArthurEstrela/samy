# Blueprint Mestre — Ecossistema Samy

**Data:** 2026-06-19
**Status:** Design aprovado (aguardando revisão final do usuário)
**Tipo:** Documento de visão e arquitetura macro (sem código)

> Este é o **blueprint mestre** — a planta do terreno. Ele define como as peças se
> encaixam e em que ordem se constroem. Cada subsistema será depois aprofundado em
> seu próprio spec → plano → implementação.

---

## 1. Conceito

A Samy é um **marketplace premium de companhia por voz**. Conecta, em tempo real,
pessoas que buscam atenção/escuta/entretenimento adulto-sensual focado em **áudio**
com profissionais ("Samys") que monetizam tempo e voz com segurança e anonimato.

**A tese central (o wedge):** áudio em vez de vídeo.
- Para a modelo: menor custo de produção (sem cenário, maquiagem, luz, exposição de
  rosto), anonimato real, trabalho de casa.
- Para o cliente: a voz cria imersão psicológica mais íntima que o visual.

**Posicionamento:** *Dark Premium* — glassmorphism, neon sobre fundo preto, itálico.
Sensação de clube VIP privado. Não pode parecer site barato de classificados.

---

## 2. Modelo de receita

Economia de **créditos pré-pagos** (pre-paid tokenomics):

1. **Cash-in:** usuário compra "Créditos Samy" via PIX. Nunca paga a modelo direto.
2. **Taxímetro (burn):** chamada cobra por minuto (ex: R$5/min).
3. **Split (take rate):** comissão da plataforma, configurável (faixa 30–50%).
   Ex: chamada de R$100 → R$40 plataforma, R$60 saldo da modelo.
4. **Cash-out:** modelo só saca acima de um mínimo (ex: R$200), garantindo float
   positivo no caixa antes de pagar a oferta.

O take rate é **configuração**, não valor fixo no código — ajustável por modelo/tier.

---

## 3. Decisões estratégicas fechadas

### 3.1 Pagamentos (PIX-first)
- **PIX exclusivo no começo, cartão de crédito nunca.** Cartão traz chargeback/fraude
  amiga; passar de 1% de chargeback aciona BRAM da Visa/Mastercard e bane do sistema
  financeiro global. PIX é irreversível por arrependimento.
- **PSPs high-risk** (mercado iGaming/infoproduto): Suitpay, Pushin Pay, ZifiPay,
  Owen Pay, Kirvano. Aceitam o modelo de negócio declarado.
- **Failover multi-PSP** (padrão Strategy): se um PSP cai/bloqueia, o sistema gera
  QR Codes por outro automaticamente.
- **Descritor de fatura discreto** (legítimo): nome neutro tipo "ST Services" na
  fatura do cliente.
- **⚠️ NÃO declarar CNAE/natureza falsa ao PSP/banco.** Isso é transaction laundering
  e dispara BRAM, multa e exposição criminal. Usar PSP high-risk que aceita adulto
  **declarado**. Ser discreto com o cliente final é ok; mentir para quem processa o
  pagamento não é.

### 3.2 Risco regulatório a monitorar (não bloqueia o MVP)
- Segurar float de terceiros e repassar pode caracterizar **arranjo de pagamento** e,
  acima de limiares do Bacen, exigir autorização como instituição de pagamento.
  Passa batido no início; revisar antes de escalar a milhões/mês.
- PSPs high-risk podem reter saldo se forem investigados (CPI das bets). O ledger +
  multi-PSP é a apólice contra exatamente isso.

### 3.3 Cold start
- **Recrutamento ativo + curadoria (convite).** Começa fechado, poucas e boas.
- **Concentração temporal > volume:** combinar para 10–15 modelos ficarem online na
  *mesma janela nobre* (ex: qui–dom, 20h–00h). Liquidez é percepção; fabrica-se com
  timing, não com massa.
- **Salário-garantido como exceção cirúrgica:** 2–3 "âncoras" pagas para garantir
  presença na janela nobre no lançamento. O resto é convite.
- Casa com o posicionamento dark premium (clube VIP não tem catraca aberta).

### 3.4 Gravação de chamadas
- **NÃO gravar.** Só metadados (quem, quando, duração, valor). Mantém a promessa de
  privacidade/anonimato e elimina o passivo LGPD de guardar áudio sensual.
- Proteção contra abuso é **estrutural e em tempo real**, não forense (ver 4.6).

### 3.5 KYC / verificação de idade
- **Cliente:** leve no cadastro (Google 1 clique), forte no PIX. O CPF do titular do
  PIX confirma +18 e vira identidade permanente. Ligar só **após** a primeira recarga.
- **Modelo:** KYC forte obrigatório **no primeiro saque** — documento + selfie com
  liveness, +18, chave PIX no nome dela. Liveness é a defesa principal contra coação,
  laranja e menoridade.

---

## 4. Arquitetura — os 6 subsistemas

Seis órgãos com fronteiras claras, comunicando-se só por contratos bem definidos.
Trocar o motor de um não pode quebrar outro.

```
                    ┌─────────────────────────────┐
                    │   1. IDENTIDADE & ACESSO     │
                    │  Login Google, sessões,      │
                    │  papéis (cliente/modelo)     │
                    └──────────────┬──────────────┘
                                   │ "quem é você"
        ┌──────────────────────────┼──────────────────────────┐
        ▼                          ▼                          ▼
┌───────────────┐      ┌─────────────────────┐      ┌──────────────────┐
│ 2. CARTEIRA & │      │ 5. MARKETPLACE &    │      │ 6. TRUST &       │
│    LEDGER     │      │    DESCOBERTA       │      │    SAFETY / KYC  │
│ créditos,     │      │ perfis, preview de  │      │ verificação +18, │
│ saldo modelo, │      │ voz, presença       │      │ pânico, banimento│
│ saque, PSPs   │      │ (online/ocupada)    │      │ moderação        │
└───────┬───────┘      └──────────┬──────────┘      └──────────────────┘
        │                         │ "quem tá online"
        │ "debita/credita"        ▼
        │              ┌─────────────────────┐
        └─────────────▶│ 3. BILLING ENGINE   │
                       │    (TAXÍMETRO)      │
                       │ cobra por minuto,   │
                       │ corta no saldo zero │
                       └──────────┬──────────┘
                                  │ "pode falar / corta agora"
                                  ▼
                       ┌─────────────────────┐
                       │ 4. MOTOR DE CHAMADAS│
                       │    (WebRTC)         │
                       │ áudio em tempo real,│
                       │ sem gravação        │
                       └─────────────────────┘
```

**Fluxo do dinheiro (caminho crítico):** cliente recarrega → Carteira credita (webhook
do PSP) → cliente liga → Marketplace confirma modelo `online` → Billing abre sessão e
a cada minuto pede à Carteira para mover crédito do cliente ao saldo da modelo → saldo
zera → Billing manda o Motor de Chamadas derrubar → modelo pede saque → Carteira
enfileira cash-out.

### 4.1 Identidade & Acesso
- Login Google (1 clique) para cliente; convite/cadastro para modelo.
- Três papéis com fronteiras rígidas:
  - **Cliente:** recarrega, liga, favorita, denuncia.
  - **Modelo:** fica online, atende, saca, aciona pânico/bloqueio.
  - **Admin:** curadoria de convite, moderação, configura take rate, gerencia fila de
    saque e PSPs, vê painel financeiro.
- Uma pessoa não pode ser cliente e modelo simultaneamente (evita lavagem interna via
  laranja). CPFs distintos.

### 4.2 Carteira & Ledger
- **Livro-razão de dupla entrada, append-only.** Nunca existe um campo de saldo
  editável; o saldo é a soma das transações imutáveis.
- Toda transação **fecha em zero**. Um minuto de R$5 gera 3 lançamentos:
  `cliente −5,00`, `modelo +3,00`, `plataforma +2,00`. Se a soma global não der zero,
  há bug — é a rede de segurança contábil.
- **Idempotência:** cada lançamento tem uma `ref_idempotencia` única. Webhook de PIX
  repetido (vai acontecer) é rejeitado — cobra-se uma vez só.
- `saldo = SUM(valor) WHERE conta = X`. Cacheado no Redis por performance; a verdade
  mora no PostgreSQL.

Exemplo do ledger:
```
TABELA: ledger_entries  (append-only, nunca UPDATE/DELETE)
id │ conta        │ tipo        │ valor   │ ref_idempotencia
───┼──────────────┼─────────────┼─────────┼──────────────────
 1 │ cliente:123  │ RECARGA     │ +100,00 │ pix_abc (webhook)
 2 │ cliente:123  │ CONSUMO_MIN │  -5,00  │ call_77_min_1
 3 │ modelo:45    │ GANHO_MIN   │  +3,00  │ call_77_min_1
 4 │ plataforma   │ COMISSAO    │  +2,00  │ call_77_min_1
```

**Cash-in:** usuário gera PIX → PSP confirma via webhook → sistema valida assinatura
do webhook → grava lançamento RECARGA (idempotente) → atualiza cache Redis.

**Cash-out:** modelo pede saque acima do mínimo → entra em "fila de pagamento" →
sistema usa API de PIX cash-out do PSP para a chave verificada dela → gera comprovante.
Saque só com KYC aprovado (ver 4.6).

### 4.3 Billing Engine (taxímetro)
- Processo que dá um "tique" por unidade pequena (ex: a cada minuto), **nunca só no
  fim** — se a conexão cair, o pior caso é perder uma fatia, não a chamada toda.
- Ciclo de cada tique:
  ```
  A cada minuto da chamada ativa:
    1. Lê saldo do cliente no Redis
    2. Saldo >= preço do minuto?
         SIM → grava os 3 lançamentos no ledger (fecha em zero) + atualiza Redis
         NÃO → manda o Motor de Chamadas DERRUBAR + avisa os dois
    3. Avisa o cliente quando o saldo está baixo ("resta 1 min")
  ```
- **Aviso de saldo baixo = conversão:** gatilho para recarga no meio da chamada.
- **Corte gracioso:** ao zerar, aviso de 10–15s antes de derrubar (experiência premium
  + última chance de recarga), não mute no susto.
- O take rate vive aqui como configuração; o split dos 3 lançamentos lê essa config.

### 4.4 Motor de Chamadas (WebRTC)
- Áudio em tempo real via WebRTC, passando por **servidor de mídia próprio (SFU)** —
  nunca P2P direto.
- Por que SFU: P2P vazaria o IP da modelo (risco de stalker). Pelo servidor, nenhuma
  parte vê o IP da outra — o anonimato vendido é garantido tecnicamente.
- O SFU é o **ponto de corte instantâneo**: quando o taxímetro diz "derruba", o fluxo
  morre na origem em ms. Impossível "continuar de graça".
- Infra recomendada: **LiveKit auto-hospedado** (soberania, casa com o posicionamento);
  alternativa gerenciada Twilio/Daily. Decisão de fase de implementação.
- **Não grava em disco.** Áudio passa e se perde. Só metadados sobrevivem.

### 4.5 Marketplace & Descoberta
- **Presença em tempo real** (Redis + heartbeat). Estados calculados pelo sistema, não
  setados na mão:
  - `ONLINE` (verde) — app aberto e disponível.
  - `OCUPADA` (vermelho) — em chamada, automático.
  - `OFFLINE` (cinza) — app fechado / conexão caiu, automático em segundos.
- Presença tem que ser verdade — ligar para "online" que não atende destrói confiança.
- Transição `OCUPADA → ONLINE` dispara **notificação à fila** ("Ela ficou disponível")
  — escassez/urgência automatizada.
- **Preview de voz:** áudio curto (10–15s) gravado pela modelo, público e consentido —
  o único áudio que existe além da chamada. Servido por CDN. Toca fácil/rápido na
  navegação (micro-comprometimento → impulso).
- **Descoberta/ordenação como alavanca de negócio:** online primeiro sempre; depois mix
  de favoritas + novas (dar palco) + performance. Filtros por tipo de voz/estilo (tags).
  Algoritmo é seu — soberania de quem aparece.

Gatilhos psicológicos mapeados na arquitetura:

| Gatilho | Onde vive tecnicamente |
|---|---|
| Bolinha verde "Online" | Presença Redis + heartbeat |
| Vermelho "Ocupada" + fila | Estado automático + notificação na volta |
| Preview de voz grátis | Áudio CDN no perfil |
| Fricção zero (Google + PIX) | Identidade (1 clique) + Carteira (PIX) |
| Escassez/urgência | Ordenação "online first" + alerta de disponibilidade |

### 4.6 Trust & Safety / KYC
**KYC do cliente:** leve no cadastro, forte no PIX (CPF do titular = +18 + identidade
permanente). Ligar só após a primeira recarga.

**KYC da modelo:** escalonado para reduzir fricção de recrutamento.
```
1. Convite/cadastro → cria perfil, grava preview, define preço/min
   PODE: ficar online, atender, acumular saldo
2. Primeiro SAQUE → trava KYC forte obrigatório:
   - documento com foto + selfie (liveness)
   - confirma +18 e identidade real
   - chave PIX no nome dela
3. KYC aprovado → cash-out liberado
```
Travar no saque inverte o incentivo a favor: ela *quer* completar para liberar o
dinheiro. PSP sério exige esse KYC de qualquer forma — resolve pagamento e legalidade
juntos. Liveness é inegociável.

**Proteção da modelo sem gravação** (4 camadas, estrutural e em tempo real):
1. **Botão de pânico:** derruba a chamada na hora e bloqueia o cliente, sem explicação.
2. **Bloqueio amarrado ao CPF/KYC** (não ao login Google) — ele não cria conta nova e
   volta. O dinheiro o identifica permanentemente.
3. **Padrão de metadados (sem ler conteúdo):** bloqueado por N modelos na semana,
   chamadas que terminam em <30s com pânico, denúncias acumuladas → **score de risco**
   que escala: alerta → revisão manual → banimento.
4. **Denúncia pós-chamada + revisão humana:** sem áudio, vale pelo acúmulo/padrão.
   Uma denúncia é registro; várias contra o mesmo CPF é banimento.

Filosofia: **vigia-se comportamento, não conversas.**

---

## 5. Ordem de construção

Do núcleo para fora — cofre antes da loja, taxímetro por último (é o maestro):

1. **Carteira & Ledger** — coração financeiro; sem ele nada existe.
2. **Identidade & Acesso** — quem é cliente, quem é modelo.
3. **Trust & Safety / KYC** — destrava cash-out e protege legalmente.
4. **Marketplace & Descoberta** — perfis, presença, preview.
5. **Motor de Chamadas** — o áudio em si.
6. **Billing Engine** — amarra marketplace + carteira + chamada (depende de todos).

---

## 6. Stack tecnológico (referência)

- **Backend:** NestJS (Node/TypeScript).
- **Dados:** PostgreSQL (verdade do ledger) + Redis (cache de saldo, presença, heartbeat).
- **Áudio:** WebRTC via SFU (LiveKit auto-hospedado recomendado).
- **Pagamento:** PSPs high-risk com failover multi-provedor (padrão Strategy).
- **Mídia estática:** CDN para previews de voz.
- **Plataforma de acesso:** web-first (Apple/Google rejeitam apps adultos nas lojas).

---

## 7. Riscos e notas legais (registro permanente)

- **Pagamento é o assassino nº 1**, não a tecnologia. Multi-PSP + ledger são a defesa.
- **Nunca** declarar natureza/CNAE falsa ao PSP/banco (transaction laundering).
- **Float de terceiros** pode exigir autorização de instituição de pagamento ao escalar.
- **+18 e liveness** da modelo tiram do risco criminal mais grave (coação/menoridade).
- **Web-first:** lojas de app rejeitam conteúdo adulto.
- Autodeclaração "+18" é piso; o CPF do PIX é o que segura numa fiscalização.

---

## 8. Feature futura — Gamificação / Tiers de comissão

**Ideia:** ranking de modelos onde subir de nível aumenta a comissão da modelo
(reduz o take rate da plataforma). É uma **comissão em camadas (tiered take rate)**.

**Por que é boa:** resolve o problema nº 1 do negócio — reter a oferta. As melhores
modelos são as mais cobiçadas pela concorrência; dar a elas uma fatia maior é um
"desconto por volume" racional (elas geram mais receita). Status ("Samy Diamante")
vira engajamento e reforça o posicionamento de "agência de elite / clube VIP".

**A costura já existe:** o take rate é configuração por modelo (ver 4.3). Um motor de
ranking é só "um processo que atualiza periodicamente o take rate de cada modelo com
base em métricas". Nada precisa ser redesenhado.

**Decisão: adiar o motor automático. Começar com tiers manuais.**

Razões para NÃO construir o motor no início:
1. **Volume insuficiente no lançamento** — ranking entre 10–15 modelos convidadas
   (algumas âncoras pagas) não é competição, é planilha. Gamificação precisa de
   volume e disputa para significar algo.
2. **Falta de dados** — definir limiares de tier (quantos minutos = subir?) antes de
   ter dados reais é chute; refaz-se tudo quando se descobre o que correlaciona com
   receita.
3. **Incentivo a trapaça antes da defesa** — premiar volume antes do Trust & Safety
   maduro convida lavagem interna (modelo "atende" laranja para inflar números). O
   incentivo-pra-trapacear não pode vir antes da defesa-contra-trapaça (ver 4.6).

**O que entra no começo (5% do esforço, 80% do benefício):** um campo de tier no
perfil da modelo que o admin ajusta manualmente para promover uma modelo a uma
comissão melhor. Sem motor, sem métrica automática — só uma config que já existe.
Permite aprender, na prática, quais métricas valeria a pena automatizar depois.

**Pré-requisitos para automatizar o motor (revisitar quando atingidos):**
- volume de modelos e clientes que torne o ranking competitivo;
- dados suficientes para saber quais métricas correlacionam com receita;
- Trust & Safety / anti-fraude maduro o bastante para resistir a gaming de volume.

---

## 9. Próximos passos

Cada subsistema vira seu próprio ciclo spec → plano → implementação, na ordem da
seção 5. O primeiro a aprofundar é a **Carteira & Ledger**.
