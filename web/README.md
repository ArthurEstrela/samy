# Samy — Web (porta de entrada do cliente)

SPA React/Vite que consome a API Samy. Login Google → descoberta de vozes → perfil.

## Rodar
```bash
cp .env.example .env   # preencha VITE_API_URL e VITE_GOOGLE_CLIENT_ID
npm install
npm run dev
```

## Login (ao vivo)
Precisa de um Google OAuth Client ID em `VITE_GOOGLE_CLIENT_ID` (o mesmo `GOOGLE_CLIENT_ID`
do backend). Sem ele, a tela de login mostra um aviso e o resto não autentica.

## Testes
```bash
npx vitest run     # unidade/componente (boundary de API mockado)
npx tsc --noEmit   # tipos
npm run build      # build de produção
```

## Design
"Candlelit after-midnight": tema escuro ameixa, brilho ember/gold, anonimato (sem rostos —
orb de gradiente + voiceprint que pulsa quando a voz está online). Tokens em `src/index.css`.
