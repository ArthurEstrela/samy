# KYC (Verificação da Modelo) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Construir o lado de escrita do KYC da modelo — iniciar uma verificação via provedor externo (captura no provedor, nada de biometria no backend), receber o resultado por webhook assinado, e ao aprovar liberar a modelo (`kyc_status.approved=true` + usuário `PENDING_VERIFICATION → ACTIVE`).

**Architecture:** NestJS + Prisma sobre o projeto existente. Provedor de KYC entra por uma porta `KycVerificationProvider` (adaptador real stub + fake, mesmo padrão de PSP/Identity). O webhook é autenticado por HMAC (molde do `PspSignatureValidator`). O início de sessão **reusa** uma sessão PENDING ainda válida para não gerar sessões pagas duplicadas. A aplicação do resultado é atômica (verificação + `kyc_status` + status do usuário numa transação). Reusa os guards `JwtAuthGuard`/`RolesGuard` da Identidade e a flag `kyc_status` que o cash-out do ledger já lê.

**Tech Stack:** NestJS, Prisma v5.22.0, PostgreSQL, Jest (integração contra Postgres real, `npm run test:int`), `crypto` nativo (HMAC), supertest (e2e).

## Global Constraints

- **Nenhum dado biométrico/documento é recebido ou armazenado.** Só `providerRef`, `clientToken` (token de sessão curto — não é biometria) e o resultado.
- **Reuso de sessão:** antes de criar nova sessão no `/kyc/start`, reusar a `KycVerification` PENDING mais recente da conta com `sessionExpiresAt > agora` (devolve o `clientToken` existente, SEM chamar o provedor).
- **Webhook autenticado por HMAC-SHA256** do corpo cru, header `x-kyc-signature`, comparação tempo-constante. Inválida/ausente → 401.
- **Idempotência:** aplicar um resultado de webhook em verificação já resolvida (APPROVED/REJECTED) é no-op.
- **Segredo por env, fail-fast no boot:** `KYC_WEBHOOK_SECRET`.
- **Aprovação não sobrepõe SUSPENDED:** ao aprovar, promove o usuário só se `PENDING_VERIFICATION`; `SUSPENDED` permanece. `kyc_status.approved` é marcado de qualquer forma.
- **Aplicação do resultado é atômica:** verificação + `kyc_status` + status do usuário numa única `$transaction`.
- **Conta da modelo:** `model:<userId>` via `UsersService.accountOf`.
- **Status `EXPIRED`** existe no modelo mas NUNCA é setado por este subsistema (reservado para um reaper futuro).
- **`npx tsc --noEmit` deve passar:** `import type` para interfaces em posição injetada (TS1272).
- **Migração não-interativa:** `prisma migrate diff` + `prisma migrate deploy`; migration SQL em UTF-8 sem BOM (PowerShell `>` gera UTF-16 → P3018); banco de teste recebe schema via `db:test:push` que o `test:int` já roda.
- **Não alterar as tabelas do ledger nem do identidade** além de escrever `kyc_status` e o `users.status`.

---

### Task 1: Schema KycVerification + segredo de webhook

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260620030000_kyc_verification/migration.sql`
- Modify: `.env`, `.env.test`
- Test: `test/kyc-verification-schema.spec.ts`

**Interfaces:**
- Consumes: `PrismaClient`.
- Produces: tabela `kyc_verifications` (unique `providerRef`, index `account`); tipo Prisma `KycVerification`.

- [ ] **Step 1: Escrever o teste que falha**

Create `test/kyc-verification-schema.spec.ts`:
```typescript
import { PrismaClient } from '@prisma/client';

describe('kyc_verifications schema', () => {
  const prisma = new PrismaClient();
  beforeEach(async () => { await prisma.kycVerification.deleteMany(); });
  afterAll(async () => { await prisma.$disconnect(); });

  it('rejeita providerRef duplicado', async () => {
    const base = {
      account: 'model:1',
      userId: 'u1',
      status: 'PENDING',
      providerRef: 'ref-1',
      clientToken: 'tok-1',
      sessionExpiresAt: new Date(Date.now() + 60000),
    };
    await prisma.kycVerification.create({ data: base });
    await expect(prisma.kycVerification.create({ data: { ...base, clientToken: 'tok-2' } }))
      .rejects.toMatchObject({ code: 'P2002' });
  });

  it('reason e resolvedAt nascem nulos', async () => {
    const v = await prisma.kycVerification.create({
      data: { account: 'model:2', userId: 'u2', status: 'PENDING', providerRef: 'ref-2', clientToken: 'tok', sessionExpiresAt: new Date(Date.now() + 60000) },
    });
    expect(v.reason).toBeNull();
    expect(v.resolvedAt).toBeNull();
  });
});
```

- [ ] **Step 2: Rodar para ver falhar**

Run: `npm run test:int -- test/kyc-verification-schema.spec.ts`
Expected: FAIL — `prisma.kycVerification` não existe.

- [ ] **Step 3: Adicionar o modelo ao schema**

Add to `prisma/schema.prisma` (após os modelos existentes):
```prisma
model KycVerification {
  id               String    @id @default(uuid())
  account          String
  userId           String
  status           String
  providerRef      String    @unique
  clientToken      String
  sessionExpiresAt DateTime
  reason           String?
  createdAt        DateTime  @default(now())
  resolvedAt       DateTime?

  @@index([account])
  @@map("kyc_verifications")
}
```

- [ ] **Step 4: Gerar migration não-interativa e aplicar no dev**

Use a mesma forma comprovada no projeto (`migrate diff` do banco de dev atual para o
schema, depois `deploy`). Rode no Bash/Git Bash para o redirect sair em UTF-8 (PowerShell
`>` gera UTF-16+BOM → Prisma P3018):
```bash
mkdir -p prisma/migrations/20260620030000_kyc_verification
npx prisma migrate diff \
  --from-schema-datasource prisma/schema.prisma \
  --to-schema-datamodel prisma/schema.prisma \
  --script > prisma/migrations/20260620030000_kyc_verification/migration.sql
npx prisma generate
npx prisma migrate deploy
```
Confirme que `migration.sql` contém `CREATE TABLE "kyc_verifications"` com `CREATE UNIQUE INDEX` em `providerRef` e `CREATE INDEX` em `account`, e que NÃO dropa/altera outras tabelas. Se sair vazio/errado, PARE e reporte. (Se por acaso o arquivo sair com BOM e o `deploy` der P3018, reescreva-o em UTF-8 sem BOM, ex.: `[System.IO.File]::WriteAllText`.)

- [ ] **Step 5: Adicionar o segredo de env**

Append to `.env`:
```
KYC_WEBHOOK_SECRET="dev-kyc-webhook-secret"
```
Append to `.env.test`:
```
KYC_WEBHOOK_SECRET="test-kyc-webhook-secret"
```

- [ ] **Step 6: Rodar o teste**

Run: `npm run test:int -- test/kyc-verification-schema.spec.ts`
Expected: PASS — 2 testes.

- [ ] **Step 7: Commit**

```bash
git add prisma test/kyc-verification-schema.spec.ts
git commit -m "feat(kyc): KycVerification schema + KYC_WEBHOOK_SECRET env"
```

---

### Task 2: KycVerificationProvider (porta + fake + adaptador real stub)

**Files:**
- Create: `src/kyc-verification/kyc-verification.port.ts`
- Create: `src/kyc-verification/fake-kyc-verification.adapter.ts`
- Create: `src/kyc-verification/real-kyc-verification.adapter.ts`
- Test: `test/kyc-verification.fake.spec.ts`

**Interfaces:**
- Consumes: nada do projeto.
- Produces:
  - `KYC_VERIFICATION_PROVIDER` (token string) + interface `KycVerificationProvider` com
    `createSession(account: string): Promise<KycSession>` onde
    `KycSession = { providerRef: string; clientToken: string; expiresAt: Date }`.
  - `FakeKycVerificationProvider` — `calls: string[]` (contas) e `reset()`; cada `createSession`
    incrementa um contador e devolve refs/tokens únicos com `expiresAt` 30min no futuro.
  - `RealKycVerificationProvider` — stub: `createSession` lança `Error('real KYC provider not configured')`. Construtor não exige env (a app precisa bootar sem credenciais reais).

- [ ] **Step 1: Escrever o teste do fake**

Create `test/kyc-verification.fake.spec.ts`:
```typescript
import { FakeKycVerificationProvider } from '../src/kyc-verification/fake-kyc-verification.adapter';

describe('FakeKycVerificationProvider', () => {
  it('cria sessão com providerRef, clientToken e expiresAt futuro; registra a chamada', async () => {
    const fake = new FakeKycVerificationProvider();
    const s = await fake.createSession('model:1');
    expect(s.providerRef).toBeTruthy();
    expect(s.clientToken).toBeTruthy();
    expect(s.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(fake.calls).toEqual(['model:1']);
  });

  it('reset zera o histórico de chamadas', async () => {
    const fake = new FakeKycVerificationProvider();
    await fake.createSession('model:1');
    fake.reset();
    expect(fake.calls).toEqual([]);
  });
});
```

- [ ] **Step 2: Rodar para ver falhar**

Run: `npm run test:int -- test/kyc-verification.fake.spec.ts`
Expected: FAIL — módulo inexistente.

- [ ] **Step 3: Criar a porta**

Create `src/kyc-verification/kyc-verification.port.ts`:
```typescript
export const KYC_VERIFICATION_PROVIDER = 'KYC_VERIFICATION_PROVIDER';

export interface KycSession {
  providerRef: string;
  clientToken: string;
  expiresAt: Date;
}

export interface KycVerificationProvider {
  createSession(account: string): Promise<KycSession>;
}
```

- [ ] **Step 4: Criar o adaptador fake**

Create `src/kyc-verification/fake-kyc-verification.adapter.ts`:
```typescript
import { Injectable } from '@nestjs/common';
import type { KycSession, KycVerificationProvider } from './kyc-verification.port';

@Injectable()
export class FakeKycVerificationProvider implements KycVerificationProvider {
  public calls: string[] = [];
  private seq = 0;

  reset(): void {
    this.calls = [];
    this.seq = 0;
  }

  async createSession(account: string): Promise<KycSession> {
    this.seq += 1;
    this.calls.push(account);
    return {
      providerRef: `ref-${account}-${this.seq}`,
      clientToken: `tok-${account}-${this.seq}`,
      expiresAt: new Date(Date.now() + 30 * 60 * 1000),
    };
  }
}
```

- [ ] **Step 5: Criar o adaptador real (stub)**

Create `src/kyc-verification/real-kyc-verification.adapter.ts`:
```typescript
import { Injectable } from '@nestjs/common';
import type { KycSession, KycVerificationProvider } from './kyc-verification.port';

@Injectable()
export class RealKycVerificationProvider implements KycVerificationProvider {
  async createSession(_account: string): Promise<KycSession> {
    throw new Error('real KYC provider not configured');
  }
}
```

- [ ] **Step 6: Rodar o teste e o tsc**

Run:
```bash
npm run test:int -- test/kyc-verification.fake.spec.ts
npx tsc --noEmit
```
Expected: PASS (2 testes) e tsc exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/kyc-verification test/kyc-verification.fake.spec.ts
git commit -m "feat(kyc): KycVerificationProvider port with fake and real-stub adapters"
```

---

### Task 3: KycVerificationService (start com reuso + applyResult atômico)

**Files:**
- Create: `src/kyc-verification/kyc-verification.service.ts`
- Test: `test/kyc-verification.service.spec.ts`

**Interfaces:**
- Consumes: `PrismaService`; `KYC_VERIFICATION_PROVIDER` (Task 2).
- Produces `KycVerificationService`:
  - `start(account: string, userId: string): Promise<{ verificationId: string; clientToken: string; status: 'PENDING' }>` — 409 (`ConflictException`) se `kyc_status.approved`; reusa PENDING válida; senão cria sessão.
  - `applyResult(providerRef: string, outcome: 'APPROVED' | 'REJECTED', reason?: string): Promise<void>` — idempotente; APPROVED aplica em transação (verificação + `kyc_status` + user, respeitando SUSPENDED); REJECTED grava reason.
  - `getLatest(account: string): Promise<{ status: string; reason?: string; createdAt?: Date; resolvedAt?: Date }>` — `{ status: 'NONE' }` se nunca iniciou.

- [ ] **Step 1: Escrever os testes**

Create `test/kyc-verification.service.spec.ts`:
```typescript
import { Test } from '@nestjs/testing';
import { ConflictException } from '@nestjs/common';
import { PrismaModule } from '../src/prisma/prisma.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { KycVerificationService } from '../src/kyc-verification/kyc-verification.service';
import { KYC_VERIFICATION_PROVIDER } from '../src/kyc-verification/kyc-verification.port';
import { FakeKycVerificationProvider } from '../src/kyc-verification/fake-kyc-verification.adapter';

describe('KycVerificationService', () => {
  let service: KycVerificationService;
  let prisma: PrismaService;
  let fake: FakeKycVerificationProvider;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      imports: [PrismaModule],
      providers: [
        KycVerificationService,
        { provide: KYC_VERIFICATION_PROVIDER, useClass: FakeKycVerificationProvider },
      ],
    }).compile();
    service = mod.get(KycVerificationService);
    prisma = mod.get(PrismaService);
    fake = mod.get(KYC_VERIFICATION_PROVIDER);
  });
  beforeEach(async () => {
    fake.reset();
    await prisma.kycVerification.deleteMany();
    await prisma.kycStatus.deleteMany();
    await prisma.refreshToken.deleteMany();
    await prisma.user.deleteMany();
  });
  afterAll(async () => { await prisma.$disconnect(); });

  async function makeModel(id: string, status = 'PENDING_VERIFICATION'): Promise<void> {
    await prisma.user.create({
      data: { id, role: 'MODEL', provider: 'google', providerSubject: id, email: `${id}@x.com`, displayName: id, status },
    });
  }

  it('start cria PENDING e retorna clientToken', async () => {
    await makeModel('m1');
    const r = await service.start('model:m1', 'm1');
    expect(r.status).toBe('PENDING');
    expect(r.clientToken).toBeTruthy();
    expect(fake.calls).toHaveLength(1);
  });

  it('start reusa a sessão PENDING válida (não chama o provedor de novo)', async () => {
    await makeModel('m2');
    const a = await service.start('model:m2', 'm2');
    const b = await service.start('model:m2', 'm2');
    expect(b.clientToken).toBe(a.clientToken);
    expect(fake.calls).toHaveLength(1);
    expect(await prisma.kycVerification.count({ where: { account: 'model:m2' } })).toBe(1);
  });

  it('start cria nova sessão quando a anterior expirou', async () => {
    await makeModel('m3');
    await service.start('model:m3', 'm3');
    await prisma.kycVerification.updateMany({ where: { account: 'model:m3' }, data: { sessionExpiresAt: new Date(Date.now() - 1000) } });
    await service.start('model:m3', 'm3');
    expect(fake.calls).toHaveLength(2);
  });

  it('start lança 409 se já aprovada', async () => {
    await makeModel('m4');
    await prisma.kycStatus.create({ data: { account: 'model:m4', approved: true } });
    await expect(service.start('model:m4', 'm4')).rejects.toBeInstanceOf(ConflictException);
  });

  it('applyResult APPROVED libera: kyc_status true + user ACTIVE', async () => {
    await makeModel('m5');
    const r = await service.start('model:m5', 'm5');
    const v = await prisma.kycVerification.findUnique({ where: { id: r.verificationId } });
    await service.applyResult(v!.providerRef, 'APPROVED');
    expect((await prisma.kycStatus.findUnique({ where: { account: 'model:m5' } }))?.approved).toBe(true);
    expect((await prisma.user.findUnique({ where: { id: 'm5' } }))?.status).toBe('ACTIVE');
  });

  it('applyResult APPROVED não tira o SUSPENDED do usuário (mas marca kyc_status)', async () => {
    await makeModel('m6', 'SUSPENDED');
    const r = await service.start('model:m6', 'm6');
    const v = await prisma.kycVerification.findUnique({ where: { id: r.verificationId } });
    await service.applyResult(v!.providerRef, 'APPROVED');
    expect((await prisma.kycStatus.findUnique({ where: { account: 'model:m6' } }))?.approved).toBe(true);
    expect((await prisma.user.findUnique({ where: { id: 'm6' } }))?.status).toBe('SUSPENDED');
  });

  it('applyResult REJECTED grava reason; permite nova verificação', async () => {
    await makeModel('m7');
    const r = await service.start('model:m7', 'm7');
    const v = await prisma.kycVerification.findUnique({ where: { id: r.verificationId } });
    await service.applyResult(v!.providerRef, 'REJECTED', 'documento ilegível');
    const rejected = await prisma.kycVerification.findUnique({ where: { id: r.verificationId } });
    expect(rejected?.status).toBe('REJECTED');
    expect(rejected?.reason).toBe('documento ilegível');
    // sessão anterior continua "válida" no tempo, mas está REJECTED -> não é reusada; cria nova
    const r2 = await service.start('model:m7', 'm7');
    expect(r2.verificationId).not.toBe(r.verificationId);
    expect(fake.calls).toHaveLength(2);
  });

  it('applyResult é idempotente em verificação já resolvida', async () => {
    await makeModel('m8');
    const r = await service.start('model:m8', 'm8');
    const v = await prisma.kycVerification.findUnique({ where: { id: r.verificationId } });
    await service.applyResult(v!.providerRef, 'APPROVED');
    await prisma.user.update({ where: { id: 'm8' }, data: { status: 'SUSPENDED' } });
    await service.applyResult(v!.providerRef, 'APPROVED'); // redelivery
    expect((await prisma.user.findUnique({ where: { id: 'm8' } }))?.status).toBe('SUSPENDED');
  });

  it('applyResult ignora providerRef desconhecido', async () => {
    await expect(service.applyResult('nope', 'APPROVED')).resolves.toBeUndefined();
  });

  it('getLatest devolve NONE quando nunca iniciou', async () => {
    expect((await service.getLatest('model:zzz')).status).toBe('NONE');
  });
});
```

- [ ] **Step 2: Rodar para ver falhar**

Run: `npm run test:int -- test/kyc-verification.service.spec.ts`
Expected: FAIL — `KycVerificationService` inexistente.

- [ ] **Step 3: Implementar o service**

Create `src/kyc-verification/kyc-verification.service.ts`:
```typescript
import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { KYC_VERIFICATION_PROVIDER } from './kyc-verification.port';
import type { KycVerificationProvider } from './kyc-verification.port';

interface StartResult {
  verificationId: string;
  clientToken: string;
  status: 'PENDING';
}

interface LatestResult {
  status: string;
  reason?: string;
  createdAt?: Date;
  resolvedAt?: Date;
}

@Injectable()
export class KycVerificationService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(KYC_VERIFICATION_PROVIDER) private readonly provider: KycVerificationProvider,
  ) {}

  async start(account: string, userId: string): Promise<StartResult> {
    const kyc = await this.prisma.kycStatus.findUnique({ where: { account } });
    if (kyc?.approved) {
      throw new ConflictException('KYC already approved');
    }
    const existing = await this.prisma.kycVerification.findFirst({
      where: { account, status: 'PENDING', sessionExpiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
    if (existing) {
      return { verificationId: existing.id, clientToken: existing.clientToken, status: 'PENDING' };
    }
    const session = await this.provider.createSession(account);
    const created = await this.prisma.kycVerification.create({
      data: {
        account,
        userId,
        status: 'PENDING',
        providerRef: session.providerRef,
        clientToken: session.clientToken,
        sessionExpiresAt: session.expiresAt,
      },
    });
    return { verificationId: created.id, clientToken: created.clientToken, status: 'PENDING' };
  }

  async applyResult(
    providerRef: string,
    outcome: 'APPROVED' | 'REJECTED',
    reason?: string,
  ): Promise<void> {
    const v = await this.prisma.kycVerification.findUnique({ where: { providerRef } });
    if (!v || v.status !== 'PENDING') {
      return; // desconhecido ou já resolvido -> no-op idempotente
    }
    if (outcome === 'REJECTED') {
      await this.prisma.kycVerification.update({
        where: { providerRef },
        data: { status: 'REJECTED', resolvedAt: new Date(), reason: reason ?? null },
      });
      return;
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.kycVerification.update({
        where: { providerRef },
        data: { status: 'APPROVED', resolvedAt: new Date() },
      });
      await tx.kycStatus.upsert({
        where: { account: v.account },
        update: { approved: true },
        create: { account: v.account, approved: true },
      });
      const user = await tx.user.findUnique({ where: { id: v.userId } });
      if (user && user.status === 'PENDING_VERIFICATION') {
        await tx.user.update({ where: { id: v.userId }, data: { status: 'ACTIVE' } });
      }
    });
  }

  async getLatest(account: string): Promise<LatestResult> {
    const v = await this.prisma.kycVerification.findFirst({
      where: { account },
      orderBy: { createdAt: 'desc' },
    });
    if (!v) {
      return { status: 'NONE' };
    }
    return {
      status: v.status,
      reason: v.reason ?? undefined,
      createdAt: v.createdAt,
      resolvedAt: v.resolvedAt ?? undefined,
    };
  }
}
```

- [ ] **Step 4: Rodar os testes e o tsc**

Run:
```bash
npm run test:int -- test/kyc-verification.service.spec.ts
npx tsc --noEmit
```
Expected: PASS (10 testes) e tsc exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/kyc-verification/kyc-verification.service.ts test/kyc-verification.service.spec.ts
git commit -m "feat(kyc): KycVerificationService — start with session reuse, atomic applyResult"
```

---

### Task 4: Controller da modelo (/kyc/start, /kyc/me) + módulo

**Files:**
- Create: `src/kyc-verification/kyc-verification.controller.ts`
- Create: `src/kyc-verification/kyc-verification.module.ts`
- Modify: `src/app.module.ts`
- Test: `test/kyc.start.e2e-spec.ts`

**Interfaces:**
- Consumes: `KycVerificationService` (Task 3); `JwtAuthGuard`, `RolesGuard`, `@Roles` (Identidade, exportados por `AuthModule`); `UsersService.accountOf` (Identidade).
- Produces:
  - `POST /kyc/start` e `GET /kyc/me`, ambos `@UseGuards(JwtAuthGuard, RolesGuard)` + `@Roles('MODEL')`.
  - `KycVerificationModule` (imports PrismaModule, AuthModule, UsersModule; provê o provider real como default + service; declara o controller). Registrado em `AppModule`.

- [ ] **Step 1: Escrever o teste e2e**

Create `test/kyc.start.e2e-spec.ts`:
```typescript
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { IDENTITY_PROVIDER } from '../src/identity/identity.port';
import { FakeIdentityProvider } from '../src/identity/fake-identity.adapter';
import { KYC_VERIFICATION_PROVIDER } from '../src/kyc-verification/kyc-verification.port';
import { FakeKycVerificationProvider } from '../src/kyc-verification/fake-kyc-verification.adapter';

describe('KYC start/me', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let fakeId: FakeIdentityProvider;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(IDENTITY_PROVIDER).useClass(FakeIdentityProvider)
      .overrideProvider(KYC_VERIFICATION_PROVIDER).useClass(FakeKycVerificationProvider)
      .compile();
    app = mod.createNestApplication({ rawBody: true });
    await app.init();
    prisma = mod.get(PrismaService);
    fakeId = mod.get(IDENTITY_PROVIDER);
  });
  beforeEach(async () => {
    fakeId.reset();
    await prisma.kycVerification.deleteMany();
    await prisma.kycStatus.deleteMany();
    await prisma.refreshToken.deleteMany();
    await prisma.user.deleteMany();
  });
  afterAll(async () => { await app.close(); });

  function http() { return request(app.getHttpServer()); }
  async function login(sub: string, role: string): Promise<string> {
    fakeId.register(`tok-${sub}`, { provider: 'google', subject: sub, email: `${sub}@x.com`, name: sub });
    const res = await http().post('/auth/google').send({ idToken: `tok-${sub}`, role });
    return res.body.accessToken;
  }

  it('MODEL inicia KYC → PENDING + clientToken', async () => {
    const token = await login('mod1', 'MODEL');
    const res = await http().post('/kyc/start').set('Authorization', `Bearer ${token}`).expect(201);
    expect(res.body.status).toBe('PENDING');
    expect(res.body.clientToken).toBeTruthy();
  });

  it('CLIENT no /kyc/start → 403', async () => {
    const token = await login('cli1', 'CLIENT');
    await http().post('/kyc/start').set('Authorization', `Bearer ${token}`).expect(403);
  });

  it('sem token → 401', async () => {
    await http().post('/kyc/start').expect(401);
  });

  it('GET /kyc/me reflete a verificação atual; NONE quando nunca iniciou', async () => {
    const token = await login('mod2', 'MODEL');
    const none = await http().get('/kyc/me').set('Authorization', `Bearer ${token}`).expect(200);
    expect(none.body.status).toBe('NONE');
    await http().post('/kyc/start').set('Authorization', `Bearer ${token}`).expect(201);
    const pending = await http().get('/kyc/me').set('Authorization', `Bearer ${token}`).expect(200);
    expect(pending.body.status).toBe('PENDING');
  });
});
```

- [ ] **Step 2: Rodar para ver falhar**

Run: `npm run test:int -- test/kyc.start.e2e-spec.ts`
Expected: FAIL — rota `/kyc/start` inexistente.

- [ ] **Step 3: Implementar o controller**

Create `src/kyc-verification/kyc-verification.controller.ts`:
```typescript
import { Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthUser } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { UsersService } from '../users/users.service';
import { KycVerificationService } from './kyc-verification.service';

@Controller('kyc')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('MODEL')
export class KycVerificationController {
  constructor(
    private readonly kyc: KycVerificationService,
    private readonly users: UsersService,
  ) {}

  @Post('start')
  async start(@Req() req: Request & { user: AuthUser }): Promise<unknown> {
    const account = this.users.accountOf({ id: req.user.id, role: req.user.role });
    return this.kyc.start(account, req.user.id);
  }

  @Get('me')
  async me(@Req() req: Request & { user: AuthUser }): Promise<unknown> {
    const account = this.users.accountOf({ id: req.user.id, role: req.user.role });
    return this.kyc.getLatest(account);
  }
}
```

- [ ] **Step 4: Criar o módulo e registrar**

Create `src/kyc-verification/kyc-verification.module.ts`:
```typescript
import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';
import { KYC_VERIFICATION_PROVIDER } from './kyc-verification.port';
import { RealKycVerificationProvider } from './real-kyc-verification.adapter';
import { KycVerificationService } from './kyc-verification.service';
import { KycVerificationController } from './kyc-verification.controller';

@Module({
  imports: [PrismaModule, AuthModule, UsersModule],
  controllers: [KycVerificationController],
  providers: [
    KycVerificationService,
    { provide: KYC_VERIFICATION_PROVIDER, useClass: RealKycVerificationProvider },
  ],
  exports: [KycVerificationService],
})
export class KycVerificationModule {}
```

Modify `src/app.module.ts` — adicionar `KycVerificationModule` aos imports (mantendo todos os existentes: PrismaModule, LedgerModule, WalletModule, KycModule, PayoutModule, IdentityModule, UsersModule, AuthModule, AdminModule).

- [ ] **Step 5: Rodar o teste e o tsc**

Run:
```bash
npm run test:int -- test/kyc.start.e2e-spec.ts
npx tsc --noEmit
```
Expected: PASS (4 testes) e tsc exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/kyc-verification/kyc-verification.controller.ts src/kyc-verification/kyc-verification.module.ts src/app.module.ts test/kyc.start.e2e-spec.ts
git commit -m "feat(kyc): /kyc/start and /kyc/me (MODEL-only) + module wiring"
```

---

### Task 5: Webhook do provedor (assinatura HMAC + /webhooks/kyc) + suíte completa

**Files:**
- Create: `src/kyc-verification/kyc-signature.validator.ts`
- Create: `src/kyc-verification/kyc-webhook.controller.ts`
- Modify: `src/kyc-verification/kyc-verification.module.ts`
- Test: `test/kyc-signature.validator.spec.ts`
- Test: `test/kyc.webhook.e2e-spec.ts`

**Interfaces:**
- Consumes: `KycVerificationService.applyResult` (Task 3).
- Produces:
  - `KycSignatureValidator.isValid(rawBody: Buffer, signature: string): boolean` — HMAC-SHA256 com `KYC_WEBHOOK_SECRET`, comparação tempo-constante.
  - `POST /webhooks/kyc` — valida assinatura (header `x-kyc-signature`), chama `applyResult`, retorna 200 `{ received: true }`; 401 em assinatura inválida.

> Nota: `KycSignatureValidator` espelha deliberadamente o `PspSignatureValidator` (mesmo molde HMAC). Extrair um util compartilhado é um refactor possível, mas fora de escopo aqui — não tocar no código do wallet.

- [ ] **Step 1: Escrever o teste do validador (unitário)**

Create `test/kyc-signature.validator.spec.ts`:
```typescript
import { createHmac } from 'crypto';
import { KycSignatureValidator } from '../src/kyc-verification/kyc-signature.validator';

describe('KycSignatureValidator', () => {
  const secret = 'test-kyc-webhook-secret';
  const validator = new KycSignatureValidator(secret);

  it('aceita assinatura HMAC válida', () => {
    const body = Buffer.from(JSON.stringify({ outcome: 'APPROVED' }));
    const sig = createHmac('sha256', secret).update(body).digest('hex');
    expect(validator.isValid(body, sig)).toBe(true);
  });

  it('rejeita assinatura inválida', () => {
    expect(validator.isValid(Buffer.from('{}'), 'deadbeef')).toBe(false);
  });
});
```

- [ ] **Step 2: Rodar para ver falhar**

Run: `npm run test:int -- test/kyc-signature.validator.spec.ts`
Expected: FAIL — classe inexistente.

- [ ] **Step 3: Implementar o validador**

Create `src/kyc-verification/kyc-signature.validator.ts`:
```typescript
import { Injectable } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';

@Injectable()
export class KycSignatureValidator {
  constructor(private readonly secret: string) {}

  isValid(rawBody: Buffer, signature: string): boolean {
    const expected = createHmac('sha256', this.secret).update(rawBody).digest('hex');
    const a = Buffer.from(expected);
    const b = Buffer.from(signature);
    if (a.length !== b.length) {
      return false;
    }
    return timingSafeEqual(a, b);
  }
}
```

- [ ] **Step 4: Rodar o teste do validador**

Run: `npm run test:int -- test/kyc-signature.validator.spec.ts`
Expected: PASS (2 testes).

- [ ] **Step 5: Escrever o teste e2e do webhook**

Create `test/kyc.webhook.e2e-spec.ts`:
```typescript
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { createHmac } from 'crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { IDENTITY_PROVIDER } from '../src/identity/identity.port';
import { FakeIdentityProvider } from '../src/identity/fake-identity.adapter';
import { KYC_VERIFICATION_PROVIDER } from '../src/kyc-verification/kyc-verification.port';
import { FakeKycVerificationProvider } from '../src/kyc-verification/fake-kyc-verification.adapter';

describe('POST /webhooks/kyc', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let fakeId: FakeIdentityProvider;
  const secret = 'test-kyc-webhook-secret';

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(IDENTITY_PROVIDER).useClass(FakeIdentityProvider)
      .overrideProvider(KYC_VERIFICATION_PROVIDER).useClass(FakeKycVerificationProvider)
      .compile();
    app = mod.createNestApplication({ rawBody: true });
    await app.init();
    prisma = mod.get(PrismaService);
    fakeId = mod.get(IDENTITY_PROVIDER);
  });
  beforeEach(async () => {
    fakeId.reset();
    await prisma.kycVerification.deleteMany();
    await prisma.kycStatus.deleteMany();
    await prisma.refreshToken.deleteMany();
    await prisma.user.deleteMany();
  });
  afterAll(async () => { await app.close(); });

  function http() { return request(app.getHttpServer()); }
  function sign(payload: object): { body: string; sig: string } {
    const body = JSON.stringify(payload);
    const sig = createHmac('sha256', secret).update(Buffer.from(body)).digest('hex');
    return { body, sig };
  }
  async function startKyc(sub: string): Promise<string> {
    fakeId.register(`tok-${sub}`, { provider: 'google', subject: sub, email: `${sub}@x.com`, name: sub });
    const reg = await http().post('/auth/google').send({ idToken: `tok-${sub}`, role: 'MODEL' });
    const start = await http().post('/kyc/start').set('Authorization', `Bearer ${reg.body.accessToken}`);
    const v = await prisma.kycVerification.findFirst({ where: { userId: reg.body.user.id } });
    return v!.providerRef;
  }

  it('APPROVED assinado libera a modelo (kyc_status true + ACTIVE)', async () => {
    const ref = await startKyc('mod1');
    const { body, sig } = sign({ providerRef: ref, outcome: 'APPROVED' });
    await http().post('/webhooks/kyc').set('x-kyc-signature', sig).set('content-type', 'application/json').send(body).expect(200);
    const u = await prisma.user.findFirst({ where: { providerSubject: 'mod1' } });
    expect(u?.status).toBe('ACTIVE');
    expect((await prisma.kycStatus.findUnique({ where: { account: `model:${u!.id}` } }))?.approved).toBe(true);
  });

  it('REJECTED grava reason; modelo não fica ACTIVE', async () => {
    const ref = await startKyc('mod2');
    const { body, sig } = sign({ providerRef: ref, outcome: 'REJECTED', reason: 'blur' });
    await http().post('/webhooks/kyc').set('x-kyc-signature', sig).set('content-type', 'application/json').send(body).expect(200);
    const u = await prisma.user.findFirst({ where: { providerSubject: 'mod2' } });
    expect(u?.status).toBe('PENDING_VERIFICATION');
    const v = await prisma.kycVerification.findUnique({ where: { providerRef: ref } });
    expect(v?.status).toBe('REJECTED');
    expect(v?.reason).toBe('blur');
  });

  it('assinatura inválida → 401, nada muda', async () => {
    const ref = await startKyc('mod3');
    const { body } = sign({ providerRef: ref, outcome: 'APPROVED' });
    await http().post('/webhooks/kyc').set('x-kyc-signature', 'wrong').set('content-type', 'application/json').send(body).expect(401);
    const u = await prisma.user.findFirst({ where: { providerSubject: 'mod3' } });
    expect(u?.status).toBe('PENDING_VERIFICATION');
  });

  it('providerRef desconhecido → 200 e nada muda', async () => {
    const { body, sig } = sign({ providerRef: 'nope', outcome: 'APPROVED' });
    await http().post('/webhooks/kyc').set('x-kyc-signature', sig).set('content-type', 'application/json').send(body).expect(200);
  });
});
```

- [ ] **Step 6: Implementar o webhook controller e registrar o validador**

Create `src/kyc-verification/kyc-webhook.controller.ts`:
```typescript
import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Post,
  RawBodyRequest,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { KycVerificationService } from './kyc-verification.service';
import { KycSignatureValidator } from './kyc-signature.validator';

interface KycWebhookEvent {
  providerRef: string;
  outcome: 'APPROVED' | 'REJECTED';
  reason?: string;
}

@Controller('webhooks')
export class KycWebhookController {
  constructor(
    private readonly kyc: KycVerificationService,
    private readonly validator: KycSignatureValidator,
  ) {}

  @Post('kyc')
  @HttpCode(200)
  async handle(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-kyc-signature') signature: string,
    @Body() event: KycWebhookEvent,
  ): Promise<{ received: boolean }> {
    const raw = req.rawBody;
    if (!raw || !signature || !this.validator.isValid(raw, signature)) {
      throw new UnauthorizedException('Invalid signature');
    }
    if (event.outcome === 'APPROVED' || event.outcome === 'REJECTED') {
      await this.kyc.applyResult(event.providerRef, event.outcome, event.reason);
    }
    return { received: true };
  }
}
```

Modify `src/kyc-verification/kyc-verification.module.ts` — adicionar o webhook controller e o validador:
```typescript
import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';
import { KYC_VERIFICATION_PROVIDER } from './kyc-verification.port';
import { RealKycVerificationProvider } from './real-kyc-verification.adapter';
import { KycVerificationService } from './kyc-verification.service';
import { KycVerificationController } from './kyc-verification.controller';
import { KycWebhookController } from './kyc-webhook.controller';
import { KycSignatureValidator } from './kyc-signature.validator';

@Module({
  imports: [PrismaModule, AuthModule, UsersModule],
  controllers: [KycVerificationController, KycWebhookController],
  providers: [
    KycVerificationService,
    { provide: KYC_VERIFICATION_PROVIDER, useClass: RealKycVerificationProvider },
    {
      provide: KycSignatureValidator,
      useFactory: (): KycSignatureValidator => {
        const secret = process.env.KYC_WEBHOOK_SECRET;
        if (!secret) {
          throw new Error('KYC_WEBHOOK_SECRET env var is required');
        }
        return new KycSignatureValidator(secret);
      },
    },
  ],
  exports: [KycVerificationService],
})
export class KycVerificationModule {}
```

- [ ] **Step 7: Rodar a suíte completa e o tsc**

Run:
```bash
npm run test:int
npx tsc --noEmit
```
Expected: PASS — todas as suítes (ledger + identidade + kyc): schema, fake, service, start/me e2e, signature, webhook e2e, mais as anteriores. tsc exit 0.

- [ ] **Step 8: Commit**

```bash
git add src/kyc-verification/kyc-signature.validator.ts src/kyc-verification/kyc-webhook.controller.ts src/kyc-verification/kyc-verification.module.ts test/kyc-signature.validator.spec.ts test/kyc.webhook.e2e-spec.ts
git commit -m "feat(kyc): signed /webhooks/kyc applying provider outcome (approve releases model)"
```

---

## Cobertura do spec (self-review)

| Requisito do spec (seção) | Onde é atendido |
|---|---|
| Tabela `kyc_verifications` + status PENDING/APPROVED/REJECTED/EXPIRED (§4) | Task 1 |
| Provedor por porta + fake + real stub (§2, §5) | Task 2 |
| Início de sessão com reuso de PENDING válida (§3, §6.1) | Task 3 (`start`) + teste de reuso |
| 409 se já aprovada (§6.1, §7) | Task 3 + teste |
| Aplicação atômica + SUSPENDED não sobreposto (§3, §6.2) | Task 3 (`applyResult`) + testes |
| Idempotência do webhook (§3, §6.2) | Task 3 (`applyResult` no-op) + teste |
| `/kyc/start`, `/kyc/me` MODEL-only (§6.1, §6.3) | Task 4 + e2e (403/401/NONE) |
| Webhook assinado HMAC + 401 (§3, §6.2, §7) | Task 5 (`KycSignatureValidator` + controller) |
| providerRef desconhecido → 200 ignora (§6.2, §7) | Task 3 + Task 5 e2e |
| `KYC_WEBHOOK_SECRET` fail-fast (§3) | Task 5 (factory lança) |
| Nada de biometria armazenada; só providerRef/clientToken/resultado (§3) | Todo o desenho (provider-hosted) |
| `EXPIRED` reservado p/ reaper, nunca setado aqui (§4, §1) | Task 1 (status livre) — nenhuma task seta EXPIRED |
| Conta `model:<id>` via accountOf (§3) | Task 4 (controller) |
| Migração não-interativa, UTF-8 sem BOM (§3) | Task 1 |
| `tsc --noEmit` limpo / `import type` (§3) | Tasks 2,3,4,5 usam `import type` em interfaces injetadas |

Sem placeholders de implementação (todo passo tem código). Tipos consistentes entre tasks: `KycSession`, `KYC_VERIFICATION_PROVIDER`, `KycVerificationProvider`, `start`/`applyResult`/`getLatest`, `AuthUser`/`accountOf` usados igual onde produzidos e consumidos.
