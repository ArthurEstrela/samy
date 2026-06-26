# Deploy — Samy backend

Backend NestJS empacotado em Docker. Roda em qualquer host com Docker + Compose.

## Pré-requisitos
- Docker + Docker Compose v2
- Um arquivo `.env` na raiz (copie de `.env.example` e preencha)

## Subir
```bash
cp .env.example .env   # edite os CHANGE_ME
docker compose -f docker-compose.prod.yml up -d --build
```
O entrypoint roda `prisma migrate deploy` automaticamente antes de subir a app.

## Verificar
```bash
curl http://localhost:3000/health
# -> {"status":"ok","postgres":"up","redis":"up"}
```

## Variáveis de ambiente
Veja `.env.example`. Obrigatórias no boot: `DATABASE_URL`, `REDIS_URL`,
`JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `GOOGLE_CLIENT_ID`, `PSP_WEBHOOK_SECRET`,
`KYC_WEBHOOK_SECRET`, `GLOBAL_TAKE_RATE`. As demais têm default ou são pontos-de-plugar.

## Adaptadores externos (plugar depois)
- **LiveKit** (mídia): preencha `LIVEKIT_API_KEY/SECRET/URL`. Sem isso, iniciar
  chamada falha com `LiveKit not configured` — o resto do app funciona.
- **PSP cash-out** (saque PIX): `RealPspPayoutPort` lança `PSP payout not configured`
  até plugar um provedor. Saques ficam PENDING e falham ao processar.
- **KYC**: `RealKycVerificationProvider` lança erro até plugar um provedor.

## Migrações
Geradas no repo em `prisma/migrations`. O container aplica com `migrate deploy`.
Nunca rode `db push`/`migrate dev` em produção.
