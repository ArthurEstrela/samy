# Identidade & Acesso Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Construir identidade, autenticação (login Google via porta) e autorização (JWT + guards por papel) da Samy, com auto-cadastro + KYC (sem convite), rotação de refresh com detecção de roubo, e status sempre fresco do banco nos guards.

**Architecture:** NestJS + Prisma sobre o projeto existente. Login Google entra por uma **porta `IdentityProvider`** (adaptador real + fake, mesmo padrão de PSP/KYC do ledger). Sessão por **JWT** (access curto stateless + refresh persistido por hash, rotacionado). Guards (`JwtAuthGuard`, `RolesGuard`) resolvem o usuário do banco a cada request para refletir `status` corrente. Usuário liga-se às contas string do ledger via `client:<id>`/`model:<id>`.

**Tech Stack:** NestJS, Prisma v5.22.0, PostgreSQL, Jest (integração contra Postgres real, `npm run test:int`), `jsonwebtoken` (assinatura JWT), `crypto` nativo (hash SHA-256 de refresh), `google-auth-library` (adaptador real do Google, não exercitado nos testes).

## Global Constraints

- **Refresh token nunca em claro:** persistir só o hash SHA-256; o token cru só na resposta HTTP.
- **Rotação:** todo refresh revoga o token usado (`revokedReason=ROTATED`) e emite um novo par.
- **Detecção de roubo:** reapresentar refresh já revogado → revoga TODOS os refresh ativos do `userId` (`SECURITY_RESET`) + log severidade alta + 401.
- **Status nunca confiado do JWT:** access token carrega só `id`+`role`; `JwtAuthGuard` resolve o usuário do banco em toda request; `SUSPENDED` → 403; inexistente → 401.
- **Segredos por env, boot falha se faltarem:** `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `GOOGLE_CLIENT_ID` (mesmo padrão do `PSP_WEBHOOK_SECRET`).
- **TTLs por env com default:** `ACCESS_TTL` (default `15m`), `REFRESH_TTL` (default `30d`).
- **Um papel por identidade:** uma identidade Google = um usuário = um papel; `role:'ADMIN'` via cadastro é proibido (400); admin só por seed.
- **Conta derivada:** `CLIENT` id `U` → `client:U`; `MODEL` id `M` → `model:M`.
- **`npx tsc --noEmit` deve passar:** ts-jest não pega TS1272 — usar `import type` para interfaces em posição injetada/decorada (token de DI por `string` const + `import type` da interface).
- **Migração não-interativa:** `prisma migrate dev` trava no runtime; usar `prisma migrate diff` (gerar SQL na pasta da migration) + `prisma migrate deploy`. O banco de teste recebe o schema via `db:test:push` que o `test:int` já roda.
- **Não alterar as tabelas do ledger.**

---

### Task 1: Schema de usuários (User, RefreshToken) + segredos de env

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260620020000_identity/migration.sql`
- Modify: `.env`, `.env.test`
- Test: `test/identity-schema.spec.ts`

**Interfaces:**
- Consumes: `PrismaClient` (existente).
- Produces: tabelas `users` (unique `(provider, providerSubject)`) e `refresh_tokens` (unique `tokenHash`, coluna `revokedReason`); tipos Prisma `User`, `RefreshToken`.

- [ ] **Step 1: Escrever o teste que falha (constraints)**

Create `test/identity-schema.spec.ts`:
```typescript
import { PrismaClient } from '@prisma/client';

describe('identity schema', () => {
  const prisma = new PrismaClient();
  beforeEach(async () => {
    await prisma.refreshToken.deleteMany();
    await prisma.user.deleteMany();
  });
  afterAll(async () => { await prisma.$disconnect(); });

  it('rejeita (provider, providerSubject) duplicado', async () => {
    const base = {
      role: 'CLIENT',
      provider: 'google',
      providerSubject: 'sub-1',
      email: 'a@b.com',
      displayName: 'A',
      status: 'ACTIVE',
    };
    await prisma.user.create({ data: base });
    await expect(prisma.user.create({ data: { ...base, email: 'c@d.com' } }))
      .rejects.toMatchObject({ code: 'P2002' });
  });

  it('persiste refresh token com revokedReason nulo por padrão', async () => {
    const user = await prisma.user.create({
      data: { role: 'CLIENT', provider: 'google', providerSubject: 's2', email: 'e@f.com', displayName: 'E', status: 'ACTIVE' },
    });
    const rt = await prisma.refreshToken.create({
      data: { userId: user.id, tokenHash: 'hash1', expiresAt: new Date(Date.now() + 1000) },
    });
    expect(rt.revokedReason).toBeNull();
    expect(rt.revokedAt).toBeNull();
  });
});
```

- [ ] **Step 2: Rodar para ver falhar**

Run: `npm run test:int -- test/identity-schema.spec.ts`
Expected: FAIL — `prisma.user` / `prisma.refreshToken` não existem.

- [ ] **Step 3: Adicionar os modelos ao schema**

Add to `prisma/schema.prisma` (após os modelos existentes):
```prisma
model User {
  id              String   @id @default(uuid())
  role            String
  provider        String
  providerSubject String
  email           String
  displayName     String
  status          String
  createdAt       DateTime @default(now())

  @@unique([provider, providerSubject])
  @@index([role, status])
  @@map("users")
}

model RefreshToken {
  id            String    @id @default(uuid())
  userId        String
  tokenHash     String    @unique
  expiresAt     DateTime
  revokedAt     DateTime?
  revokedReason String?
  createdAt     DateTime  @default(now())

  @@index([userId])
  @@map("refresh_tokens")
}
```

- [ ] **Step 4: Gerar a migration não-interativa e aplicar no dev**

Run:
```bash
mkdir -p prisma/migrations/20260620020000_identity
npx prisma migrate diff --from-migrations ./prisma/migrations --to-schema-datamodel ./prisma/schema.prisma --script > prisma/migrations/20260620020000_identity/migration.sql
npx prisma generate
npx prisma migrate deploy
```
Confirme que `migration.sql` contém `CREATE TABLE "users"` e `CREATE TABLE "refresh_tokens"` com `CREATE UNIQUE INDEX` em `(provider, providerSubject)` e `tokenHash`. Se o diff sair vazio/errado, PARE e reporte.

- [ ] **Step 5: Adicionar segredos de env**

Append to `.env`:
```
JWT_ACCESS_SECRET="dev-access-secret"
JWT_REFRESH_SECRET="dev-refresh-secret"
GOOGLE_CLIENT_ID="dev-google-client-id"
ACCESS_TTL="15m"
REFRESH_TTL="30d"
```
Append to `.env.test`:
```
JWT_ACCESS_SECRET="test-access-secret"
JWT_REFRESH_SECRET="test-refresh-secret"
GOOGLE_CLIENT_ID="test-google-client-id"
ACCESS_TTL="15m"
REFRESH_TTL="30d"
```

- [ ] **Step 6: Rodar o teste (aplica schema no banco de teste e valida)**

Run: `npm run test:int -- test/identity-schema.spec.ts`
Expected: PASS — 2 testes.

- [ ] **Step 7: Commit**

```bash
git add prisma .env.example 2>/dev/null; git add prisma test/identity-schema.spec.ts
git commit -m "feat(identity): User and RefreshToken schema + auth env secrets"
```

---

### Task 2: IdentityProvider (porta + adaptador fake + adaptador Google)

**Files:**
- Create: `src/identity/identity.port.ts`
- Create: `src/identity/fake-identity.adapter.ts`
- Create: `src/identity/google-identity.adapter.ts`
- Create: `src/identity/identity.module.ts`
- Test: `test/identity.fake.spec.ts`

**Interfaces:**
- Consumes: nada do projeto.
- Produces:
  - `IDENTITY_PROVIDER` (token string) + interface `IdentityProvider` com
    `verify(idToken: string): Promise<IdentityClaims>` onde
    `IdentityClaims = { provider: string; subject: string; email: string; name: string }`.
  - `FakeIdentityProvider` com `register(idToken: string, claims: IdentityClaims): void` para testes; `verify` lança `UnauthorizedException` se o token não foi registrado.
  - `IdentityModule` provê `{ provide: IDENTITY_PROVIDER, useClass: GoogleIdentityProvider }` e exporta `IDENTITY_PROVIDER`.

- [ ] **Step 1: Escrever o teste do fake**

Create `test/identity.fake.spec.ts`:
```typescript
import { UnauthorizedException } from '@nestjs/common';
import { FakeIdentityProvider } from '../src/identity/fake-identity.adapter';

describe('FakeIdentityProvider', () => {
  it('verifica um token registrado e devolve as claims', async () => {
    const fake = new FakeIdentityProvider();
    fake.register('tok-1', { provider: 'google', subject: 'sub-1', email: 'a@b.com', name: 'A' });
    await expect(fake.verify('tok-1')).resolves.toEqual({
      provider: 'google', subject: 'sub-1', email: 'a@b.com', name: 'A',
    });
  });

  it('rejeita token não registrado', async () => {
    const fake = new FakeIdentityProvider();
    await expect(fake.verify('nope')).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
```

- [ ] **Step 2: Rodar para ver falhar**

Run: `npm run test:int -- test/identity.fake.spec.ts`
Expected: FAIL — módulo inexistente.

- [ ] **Step 3: Criar a porta**

Create `src/identity/identity.port.ts`:
```typescript
export const IDENTITY_PROVIDER = 'IDENTITY_PROVIDER';

export interface IdentityClaims {
  provider: string;
  subject: string;
  email: string;
  name: string;
}

export interface IdentityProvider {
  verify(idToken: string): Promise<IdentityClaims>;
}
```

- [ ] **Step 4: Criar o adaptador fake**

Create `src/identity/fake-identity.adapter.ts`:
```typescript
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { IdentityClaims, IdentityProvider } from './identity.port';

@Injectable()
export class FakeIdentityProvider implements IdentityProvider {
  private readonly tokens = new Map<string, IdentityClaims>();

  register(idToken: string, claims: IdentityClaims): void {
    this.tokens.set(idToken, claims);
  }

  reset(): void {
    this.tokens.clear();
  }

  async verify(idToken: string): Promise<IdentityClaims> {
    const claims = this.tokens.get(idToken);
    if (!claims) {
      throw new UnauthorizedException('Invalid identity token');
    }
    return claims;
  }
}
```

- [ ] **Step 5: Criar o adaptador Google e o módulo**

Run: `npm install google-auth-library`

Create `src/identity/google-identity.adapter.ts`:
```typescript
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { OAuth2Client } from 'google-auth-library';
import { IdentityClaims, IdentityProvider } from './identity.port';

@Injectable()
export class GoogleIdentityProvider implements IdentityProvider {
  private readonly client: OAuth2Client;
  private readonly clientId: string;

  constructor() {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    if (!clientId) {
      throw new Error('GOOGLE_CLIENT_ID env var is required');
    }
    this.clientId = clientId;
    this.client = new OAuth2Client(clientId);
  }

  async verify(idToken: string): Promise<IdentityClaims> {
    try {
      const ticket = await this.client.verifyIdToken({ idToken, audience: this.clientId });
      const payload = ticket.getPayload();
      if (!payload?.sub || !payload.email) {
        throw new UnauthorizedException('Invalid Google token payload');
      }
      return {
        provider: 'google',
        subject: payload.sub,
        email: payload.email,
        name: payload.name ?? payload.email,
      };
    } catch {
      throw new UnauthorizedException('Invalid Google token');
    }
  }
}
```

Create `src/identity/identity.module.ts`:
```typescript
import { Module } from '@nestjs/common';
import { IDENTITY_PROVIDER } from './identity.port';
import { GoogleIdentityProvider } from './google-identity.adapter';

@Module({
  providers: [{ provide: IDENTITY_PROVIDER, useClass: GoogleIdentityProvider }],
  exports: [IDENTITY_PROVIDER],
})
export class IdentityModule {}
```

- [ ] **Step 6: Rodar o teste e o tsc**

Run:
```bash
npm run test:int -- test/identity.fake.spec.ts
npx tsc --noEmit
```
Expected: PASS (2 testes) e tsc exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/identity test/identity.fake.spec.ts package.json package-lock.json
git commit -m "feat(identity): IdentityProvider port with Google and fake adapters"
```

---

### Task 3: UsersService (find/create/status + conta derivada)

**Files:**
- Create: `src/users/users.service.ts`
- Create: `src/users/users.module.ts`
- Modify: `src/app.module.ts`
- Test: `test/users.service.spec.ts`

**Interfaces:**
- Consumes: `PrismaService`.
- Produces `UsersService`:
  - `findByProvider(provider: string, subject: string): Promise<User | null>`
  - `findById(id: string): Promise<User | null>`
  - `createUser(input: { role: 'CLIENT' | 'MODEL'; provider: string; subject: string; email: string; name: string }): Promise<User>` — CLIENT→`ACTIVE`, MODEL→`PENDING_VERIFICATION`.
  - `setStatus(id: string, status: 'ACTIVE' | 'SUSPENDED'): Promise<User>` — lança `NotFoundException` se não existir.
  - `accountOf(user: { id: string; role: string }): string` — `client:<id>` / `model:<id>` / `admin:<id>` (role minúsculo + id).
- `UsersModule` importa `PrismaModule`, provê+exporta `UsersService`.

- [ ] **Step 1: Escrever os testes**

Create `test/users.service.spec.ts`:
```typescript
import { Test } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { PrismaModule } from '../src/prisma/prisma.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { UsersModule } from '../src/users/users.module';
import { UsersService } from '../src/users/users.service';

describe('UsersService', () => {
  let users: UsersService;
  let prisma: PrismaService;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [PrismaModule, UsersModule] }).compile();
    users = mod.get(UsersService);
    prisma = mod.get(PrismaService);
  });
  beforeEach(async () => {
    await prisma.refreshToken.deleteMany();
    await prisma.user.deleteMany();
  });
  afterAll(async () => { await prisma.$disconnect(); });

  it('cria CLIENT como ACTIVE e MODEL como PENDING_VERIFICATION', async () => {
    const c = await users.createUser({ role: 'CLIENT', provider: 'google', subject: 's1', email: 'c@x.com', name: 'C' });
    const m = await users.createUser({ role: 'MODEL', provider: 'google', subject: 's2', email: 'm@x.com', name: 'M' });
    expect(c.status).toBe('ACTIVE');
    expect(m.status).toBe('PENDING_VERIFICATION');
  });

  it('findByProvider acha o usuário criado e devolve null quando não existe', async () => {
    await users.createUser({ role: 'CLIENT', provider: 'google', subject: 's3', email: 'a@x.com', name: 'A' });
    expect(await users.findByProvider('google', 's3')).not.toBeNull();
    expect(await users.findByProvider('google', 'nope')).toBeNull();
  });

  it('setStatus muda o status e lança NotFound em id inexistente', async () => {
    const u = await users.createUser({ role: 'MODEL', provider: 'google', subject: 's4', email: 'b@x.com', name: 'B' });
    const updated = await users.setStatus(u.id, 'ACTIVE');
    expect(updated.status).toBe('ACTIVE');
    await expect(users.setStatus('00000000-0000-0000-0000-000000000000', 'SUSPENDED'))
      .rejects.toBeInstanceOf(NotFoundException);
  });

  it('accountOf deriva client:/model: a partir do papel e id', () => {
    expect(users.accountOf({ id: 'abc', role: 'CLIENT' })).toBe('client:abc');
    expect(users.accountOf({ id: 'xyz', role: 'MODEL' })).toBe('model:xyz');
  });
});
```

- [ ] **Step 2: Rodar para ver falhar**

Run: `npm run test:int -- test/users.service.spec.ts`
Expected: FAIL — `UsersModule` inexistente.

- [ ] **Step 3: Implementar o UsersService**

Create `src/users/users.service.ts`:
```typescript
import { Injectable, NotFoundException } from '@nestjs/common';
import { User } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

interface CreateUserInput {
  role: 'CLIENT' | 'MODEL';
  provider: string;
  subject: string;
  email: string;
  name: string;
}

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  findByProvider(provider: string, subject: string): Promise<User | null> {
    return this.prisma.user.findUnique({
      where: { provider_providerSubject: { provider, providerSubject: subject } },
    });
  }

  findById(id: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { id } });
  }

  createUser(input: CreateUserInput): Promise<User> {
    const status = input.role === 'MODEL' ? 'PENDING_VERIFICATION' : 'ACTIVE';
    return this.prisma.user.create({
      data: {
        role: input.role,
        provider: input.provider,
        providerSubject: input.subject,
        email: input.email,
        displayName: input.name,
        status,
      },
    });
  }

  async setStatus(id: string, status: 'ACTIVE' | 'SUSPENDED'): Promise<User> {
    try {
      return await this.prisma.user.update({ where: { id }, data: { status } });
    } catch {
      throw new NotFoundException('User not found');
    }
  }

  accountOf(user: { id: string; role: string }): string {
    return `${user.role.toLowerCase()}:${user.id}`;
  }
}
```

> Nota: o nome do índice composto no Prisma é `provider_providerSubject` (ordem dos campos do `@@unique`).

Create `src/users/users.module.ts`:
```typescript
import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { UsersService } from './users.service';

@Module({
  imports: [PrismaModule],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
```

Modify `src/app.module.ts` — adicionar `UsersModule` e `IdentityModule` aos imports:
```typescript
import { Module } from '@nestjs/common';
import { PrismaModule } from './prisma/prisma.module';
import { LedgerModule } from './ledger/ledger.module';
import { WalletModule } from './wallet/wallet.module';
import { KycModule } from './kyc/kyc.module';
import { PayoutModule } from './payout/payout.module';
import { IdentityModule } from './identity/identity.module';
import { UsersModule } from './users/users.module';

@Module({
  imports: [
    PrismaModule,
    LedgerModule,
    WalletModule,
    KycModule,
    PayoutModule,
    IdentityModule,
    UsersModule,
  ],
})
export class AppModule {}
```

- [ ] **Step 4: Rodar os testes e o tsc**

Run:
```bash
npm run test:int -- test/users.service.spec.ts
npx tsc --noEmit
```
Expected: PASS (4 testes) e tsc exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/users src/app.module.ts test/users.service.spec.ts
git commit -m "feat(users): UsersService find/create/setStatus + ledger account derivation"
```

---

### Task 4: TokenService (access JWT + refresh com hash, rotação, detecção de roubo)

**Files:**
- Create: `src/auth/token.service.ts`
- Create: `src/auth/auth.module.ts`
- Test: `test/token.service.spec.ts`

**Interfaces:**
- Consumes: `PrismaService`.
- Produces `TokenService`:
  - `signAccess(user: { id: string; role: string }): string` — JWT com `{ sub: id, role }`, expira em `ACCESS_TTL`, assinado com `JWT_ACCESS_SECRET`.
  - `verifyAccess(token: string): { sub: string; role: string }` — lança `UnauthorizedException` se inválido/expirado.
  - `issueRefresh(userId: string): Promise<string>` — gera token aleatório, persiste só o hash, expira em `REFRESH_TTL`, retorna o token cru.
  - `rotateRefresh(rawToken: string): Promise<{ userId: string; refreshToken: string }>` — valida; se já revogado → detecção de roubo (revoga todos do userId com `SECURITY_RESET`, loga, lança `UnauthorizedException`); se válido → marca `ROTATED` e emite novo refresh.
  - `revoke(rawToken: string, reason: string): Promise<void>` — marca `revokedAt`/`revokedReason` se existir (no-op se não existir).
- `AuthModule` importa `PrismaModule` e `UsersModule`, provê `TokenService` (mais o resto nas tasks seguintes).

- [ ] **Step 1: Escrever os testes**

Create `test/token.service.spec.ts`:
```typescript
import { Test } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';
import { createHash } from 'crypto';
import { PrismaModule } from '../src/prisma/prisma.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { TokenService } from '../src/auth/token.service';

describe('TokenService', () => {
  let tokens: TokenService;
  let prisma: PrismaService;
  let userId: string;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      imports: [PrismaModule],
      providers: [TokenService],
    }).compile();
    tokens = mod.get(TokenService);
    prisma = mod.get(PrismaService);
  });
  beforeEach(async () => {
    await prisma.refreshToken.deleteMany();
    await prisma.user.deleteMany();
    const u = await prisma.user.create({
      data: { role: 'CLIENT', provider: 'google', providerSubject: 's', email: 'e@x.com', displayName: 'E', status: 'ACTIVE' },
    });
    userId = u.id;
  });
  afterAll(async () => { await prisma.$disconnect(); });

  it('assina e verifica access token; rejeita lixo', () => {
    const t = tokens.signAccess({ id: userId, role: 'CLIENT' });
    expect(tokens.verifyAccess(t)).toMatchObject({ sub: userId, role: 'CLIENT' });
    expect(() => tokens.verifyAccess('garbage')).toThrow(UnauthorizedException);
  });

  it('refresh é persistido apenas como hash, nunca em claro', async () => {
    const raw = await tokens.issueRefresh(userId);
    const inDb = await prisma.refreshToken.findFirst({ where: { userId } });
    expect(inDb?.tokenHash).toBe(createHash('sha256').update(raw).digest('hex'));
    expect(inDb?.tokenHash).not.toBe(raw);
  });

  it('rotaciona: emite novo refresh e revoga o antigo como ROTATED', async () => {
    const raw = await tokens.issueRefresh(userId);
    const { refreshToken: novo } = await tokens.rotateRefresh(raw);
    const oldHash = createHash('sha256').update(raw).digest('hex');
    const oldRow = await prisma.refreshToken.findUnique({ where: { tokenHash: oldHash } });
    expect(oldRow?.revokedReason).toBe('ROTATED');
    expect(novo).not.toBe(raw);
  });

  it('detecção de roubo: reusar refresh revogado revoga TODOS do usuário e lança 401', async () => {
    const raw = await tokens.issueRefresh(userId);
    const outroRaw = await tokens.issueRefresh(userId); // segunda sessão válida
    await tokens.rotateRefresh(raw); // raw vira ROTATED
    await expect(tokens.rotateRefresh(raw)).rejects.toBeInstanceOf(UnauthorizedException);
    // o outro refresh, antes válido, agora também está revogado (SECURITY_RESET)
    const outroHash = createHash('sha256').update(outroRaw).digest('hex');
    const outroRow = await prisma.refreshToken.findUnique({ where: { tokenHash: outroHash } });
    expect(outroRow?.revokedAt).not.toBeNull();
    expect(outroRow?.revokedReason).toBe('SECURITY_RESET');
  });
});
```

- [ ] **Step 2: Rodar para ver falhar**

Run: `npm run test:int -- test/token.service.spec.ts`
Expected: FAIL — `TokenService` inexistente.

- [ ] **Step 3: Instalar jsonwebtoken**

Run: `npm install jsonwebtoken && npm install -D @types/jsonwebtoken`

- [ ] **Step 4: Implementar o TokenService**

Create `src/auth/token.service.ts`:
```typescript
import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import * as jwt from 'jsonwebtoken';
import { PrismaService } from '../prisma/prisma.service';

interface AccessPayload {
  sub: string;
  role: string;
}

@Injectable()
export class TokenService {
  private readonly logger = new Logger(TokenService.name);
  private readonly accessSecret: string;
  private readonly refreshTtlMs: number;
  private readonly accessTtl: string;

  constructor(private readonly prisma: PrismaService) {
    const accessSecret = process.env.JWT_ACCESS_SECRET;
    if (!accessSecret) {
      throw new Error('JWT_ACCESS_SECRET env var is required');
    }
    if (!process.env.JWT_REFRESH_SECRET) {
      throw new Error('JWT_REFRESH_SECRET env var is required');
    }
    this.accessSecret = accessSecret;
    this.accessTtl = process.env.ACCESS_TTL ?? '15m';
    this.refreshTtlMs = this.parseDurationMs(process.env.REFRESH_TTL ?? '30d');
  }

  signAccess(user: { id: string; role: string }): string {
    return jwt.sign({ sub: user.id, role: user.role }, this.accessSecret, {
      expiresIn: this.accessTtl,
    } as jwt.SignOptions);
  }

  verifyAccess(token: string): AccessPayload {
    try {
      const decoded = jwt.verify(token, this.accessSecret) as AccessPayload;
      return { sub: decoded.sub, role: decoded.role };
    } catch {
      throw new UnauthorizedException('Invalid access token');
    }
  }

  async issueRefresh(userId: string): Promise<string> {
    const raw = randomBytes(48).toString('hex');
    await this.prisma.refreshToken.create({
      data: {
        userId,
        tokenHash: this.hash(raw),
        expiresAt: new Date(Date.now() + this.refreshTtlMs),
      },
    });
    return raw;
  }

  async rotateRefresh(rawToken: string): Promise<{ userId: string; refreshToken: string }> {
    const row = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: this.hash(rawToken) },
    });
    if (!row || row.expiresAt.getTime() < Date.now()) {
      throw new UnauthorizedException('Invalid refresh token');
    }
    if (row.revokedAt) {
      // reuso de token revogado = sinal de roubo
      this.logger.error(`Refresh token reuse detected for user ${row.userId}; revoking all sessions`);
      await this.prisma.refreshToken.updateMany({
        where: { userId: row.userId, revokedAt: null },
        data: { revokedAt: new Date(), revokedReason: 'SECURITY_RESET' },
      });
      throw new UnauthorizedException('Refresh token reuse detected');
    }
    await this.prisma.refreshToken.update({
      where: { tokenHash: row.tokenHash },
      data: { revokedAt: new Date(), revokedReason: 'ROTATED' },
    });
    const refreshToken = await this.issueRefresh(row.userId);
    return { userId: row.userId, refreshToken };
  }

  async revoke(rawToken: string, reason: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash: this.hash(rawToken), revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
  }

  private hash(raw: string): string {
    return createHash('sha256').update(raw).digest('hex');
  }

  private parseDurationMs(value: string): number {
    const match = /^(\d+)([smhd])$/.exec(value);
    if (!match) {
      throw new Error(`Invalid duration: ${value}`);
    }
    const n = Number(match[1]);
    const unit = match[2];
    const factor = unit === 's' ? 1000 : unit === 'm' ? 60000 : unit === 'h' ? 3600000 : 86400000;
    return n * factor;
  }
}
```

Create `src/auth/auth.module.ts`:
```typescript
import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { UsersModule } from '../users/users.module';
import { TokenService } from './token.service';

@Module({
  imports: [PrismaModule, UsersModule],
  providers: [TokenService],
  exports: [TokenService],
})
export class AuthModule {}
```

- [ ] **Step 5: Rodar os testes e o tsc**

Run:
```bash
npm run test:int -- test/token.service.spec.ts
npx tsc --noEmit
```
Expected: PASS (4 testes) e tsc exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/auth test/token.service.spec.ts package.json package-lock.json
git commit -m "feat(auth): TokenService — JWT access + hashed refresh with rotation and reuse detection"
```

---

### Task 5: AuthService + AuthController (login/cadastro, refresh, logout)

**Files:**
- Create: `src/auth/auth.service.ts`
- Create: `src/auth/auth.controller.ts`
- Create: `src/auth/dto.ts`
- Modify: `src/auth/auth.module.ts`
- Test: `test/auth.flow.e2e-spec.ts`

**Interfaces:**
- Consumes: `TokenService` (Task 4), `UsersService` (Task 3), `IDENTITY_PROVIDER` (Task 2).
- Produces:
  - `AuthService.loginOrRegister(idToken: string, role?: 'CLIENT' | 'MODEL'): Promise<AuthResult>` onde
    `AuthResult = { accessToken: string; refreshToken: string; user: { id, role, status, email, displayName } }`.
  - `AuthService.refresh(rawToken: string): Promise<{ accessToken; refreshToken }>`.
  - `AuthService.logout(rawToken: string): Promise<void>`.
  - Endpoints `POST /auth/google`, `POST /auth/refresh`, `POST /auth/logout`.
- `AuthModule` registra `IdentityModule` no imports, e `AuthService`+`AuthController`.

- [ ] **Step 1: Escrever o teste e2e**

Create `test/auth.flow.e2e-spec.ts`:
```typescript
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { IDENTITY_PROVIDER } from '../src/identity/identity.port';
import { FakeIdentityProvider } from '../src/identity/fake-identity.adapter';

describe('Auth flow', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let fake: FakeIdentityProvider;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(IDENTITY_PROVIDER).useClass(FakeIdentityProvider)
      .compile();
    app = mod.createNestApplication();
    await app.init();
    prisma = mod.get(PrismaService);
    fake = mod.get(IDENTITY_PROVIDER);
  });
  beforeEach(async () => {
    fake.reset();
    await prisma.refreshToken.deleteMany();
    await prisma.user.deleteMany();
  });
  afterAll(async () => { await app.close(); });

  function http() { return request(app.getHttpServer()); }

  it('cadastra CLIENT (ACTIVE) e devolve tokens', async () => {
    fake.register('tok-c', { provider: 'google', subject: 'c1', email: 'c@x.com', name: 'C' });
    const res = await http().post('/auth/google').send({ idToken: 'tok-c', role: 'CLIENT' }).expect(201);
    expect(res.body.user).toMatchObject({ role: 'CLIENT', status: 'ACTIVE', email: 'c@x.com' });
    expect(typeof res.body.accessToken).toBe('string');
    expect(typeof res.body.refreshToken).toBe('string');
  });

  it('cadastra MODEL como PENDING_VERIFICATION', async () => {
    fake.register('tok-m', { provider: 'google', subject: 'm1', email: 'm@x.com', name: 'M' });
    const res = await http().post('/auth/google').send({ idToken: 'tok-m', role: 'MODEL' }).expect(201);
    expect(res.body.user.status).toBe('PENDING_VERIFICATION');
  });

  it('login de identidade existente ignora role do body (CLIENT continua CLIENT)', async () => {
    fake.register('tok-x', { provider: 'google', subject: 'x1', email: 'x@x.com', name: 'X' });
    await http().post('/auth/google').send({ idToken: 'tok-x', role: 'CLIENT' }).expect(201);
    const res = await http().post('/auth/google').send({ idToken: 'tok-x', role: 'MODEL' }).expect(201);
    expect(res.body.user.role).toBe('CLIENT');
  });

  it('rejeita cadastro com role ADMIN (400)', async () => {
    fake.register('tok-a', { provider: 'google', subject: 'a1', email: 'a@x.com', name: 'A' });
    await http().post('/auth/google').send({ idToken: 'tok-a', role: 'ADMIN' }).expect(400);
  });

  it('idToken inválido → 401', async () => {
    await http().post('/auth/google').send({ idToken: 'nope', role: 'CLIENT' }).expect(401);
  });

  it('refresh rotaciona e o token antigo para de funcionar (401)', async () => {
    fake.register('tok-r', { provider: 'google', subject: 'r1', email: 'r@x.com', name: 'R' });
    const reg = await http().post('/auth/google').send({ idToken: 'tok-r', role: 'CLIENT' }).expect(201);
    const old = reg.body.refreshToken;
    const ref = await http().post('/auth/refresh').send({ refreshToken: old }).expect(201);
    expect(ref.body.refreshToken).not.toBe(old);
    await http().post('/auth/refresh').send({ refreshToken: old }).expect(401);
  });

  it('logout revoga o refresh; uso posterior → 401; logout repetido → 200/201', async () => {
    fake.register('tok-l', { provider: 'google', subject: 'l1', email: 'l@x.com', name: 'L' });
    const reg = await http().post('/auth/google').send({ idToken: 'tok-l', role: 'CLIENT' }).expect(201);
    const rt = reg.body.refreshToken;
    await http().post('/auth/logout').send({ refreshToken: rt }).expect(201);
    await http().post('/auth/refresh').send({ refreshToken: rt }).expect(401);
    await http().post('/auth/logout').send({ refreshToken: rt }).expect(201);
  });
});
```

- [ ] **Step 2: Rodar para ver falhar**

Run: `npm run test:int -- test/auth.flow.e2e-spec.ts`
Expected: FAIL — rota `/auth/google` inexistente.

- [ ] **Step 3: Criar os DTOs**

Create `src/auth/dto.ts`:
```typescript
export interface GoogleLoginDto {
  idToken: string;
  role?: string;
}

export interface RefreshDto {
  refreshToken: string;
}
```

- [ ] **Step 4: Implementar o AuthService**

Create `src/auth/auth.service.ts`:
```typescript
import { BadRequestException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { TokenService } from './token.service';
import { UsersService } from '../users/users.service';
import { IDENTITY_PROVIDER } from '../identity/identity.port';
import type { IdentityProvider } from '../identity/identity.port';

interface AuthResult {
  accessToken: string;
  refreshToken: string;
  user: { id: string; role: string; status: string; email: string; displayName: string };
}

@Injectable()
export class AuthService {
  constructor(
    private readonly tokens: TokenService,
    private readonly users: UsersService,
    @Inject(IDENTITY_PROVIDER) private readonly identity: IdentityProvider,
  ) {}

  async loginOrRegister(idToken: string, role?: string): Promise<AuthResult> {
    const claims = await this.identity.verify(idToken);
    let user = await this.users.findByProvider(claims.provider, claims.subject);
    if (!user) {
      if (role === 'ADMIN') {
        throw new BadRequestException('Cannot self-register as ADMIN');
      }
      const newRole = role === 'MODEL' ? 'MODEL' : 'CLIENT';
      user = await this.users.createUser({
        role: newRole,
        provider: claims.provider,
        subject: claims.subject,
        email: claims.email,
        name: claims.name,
      });
    }
    const refreshToken = await this.tokens.issueRefresh(user.id);
    return {
      accessToken: this.tokens.signAccess({ id: user.id, role: user.role }),
      refreshToken,
      user: {
        id: user.id,
        role: user.role,
        status: user.status,
        email: user.email,
        displayName: user.displayName,
      },
    };
  }

  async refresh(rawToken: string): Promise<{ accessToken: string; refreshToken: string }> {
    const { userId, refreshToken } = await this.tokens.rotateRefresh(rawToken);
    const user = await this.users.findById(userId);
    if (!user || user.status === 'SUSPENDED') {
      await this.tokens.revoke(refreshToken, 'SECURITY_RESET');
      throw new UnauthorizedException('User not allowed');
    }
    return { accessToken: this.tokens.signAccess({ id: user.id, role: user.role }), refreshToken };
  }

  async logout(rawToken: string): Promise<void> {
    await this.tokens.revoke(rawToken, 'LOGOUT');
  }
}
```

- [ ] **Step 5: Implementar o AuthController e registrar no módulo**

Create `src/auth/auth.controller.ts`:
```typescript
import { BadRequestException, Body, Controller, Post } from '@nestjs/common';
import { AuthService } from './auth.service';
import { GoogleLoginDto, RefreshDto } from './dto';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('google')
  async google(@Body() body: GoogleLoginDto): Promise<unknown> {
    if (!body?.idToken || typeof body.idToken !== 'string') {
      throw new BadRequestException('idToken is required');
    }
    return this.auth.loginOrRegister(body.idToken, body.role);
  }

  @Post('refresh')
  async refresh(@Body() body: RefreshDto): Promise<unknown> {
    if (!body?.refreshToken || typeof body.refreshToken !== 'string') {
      throw new BadRequestException('refreshToken is required');
    }
    return this.auth.refresh(body.refreshToken);
  }

  @Post('logout')
  async logout(@Body() body: RefreshDto): Promise<{ ok: true }> {
    if (body?.refreshToken && typeof body.refreshToken === 'string') {
      await this.auth.logout(body.refreshToken);
    }
    return { ok: true };
  }
}
```

Modify `src/auth/auth.module.ts`:
```typescript
import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { UsersModule } from '../users/users.module';
import { IdentityModule } from '../identity/identity.module';
import { TokenService } from './token.service';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';

@Module({
  imports: [PrismaModule, UsersModule, IdentityModule],
  controllers: [AuthController],
  providers: [TokenService, AuthService],
  exports: [TokenService],
})
export class AuthModule {}
```

Modify `src/app.module.ts` — adicionar `AuthModule` aos imports (junto dos demais).

- [ ] **Step 6: Rodar o teste e o tsc**

Run:
```bash
npm run test:int -- test/auth.flow.e2e-spec.ts
npx tsc --noEmit
```
Expected: PASS (7 testes) e tsc exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/auth src/app.module.ts test/auth.flow.e2e-spec.ts
git commit -m "feat(auth): /auth/google login-register, /auth/refresh rotation, /auth/logout"
```

---

### Task 6: JwtAuthGuard + RolesGuard + /auth/me (status fresco do banco)

**Files:**
- Create: `src/auth/jwt-auth.guard.ts`
- Create: `src/auth/roles.decorator.ts`
- Create: `src/auth/roles.guard.ts`
- Modify: `src/auth/auth.controller.ts` (adiciona `GET /auth/me`)
- Modify: `src/auth/auth.module.ts` (provê os guards)
- Test: `test/auth.guards.e2e-spec.ts`

**Interfaces:**
- Consumes: `TokenService.verifyAccess` (Task 4), `UsersService.findById` (Task 3).
- Produces:
  - `JwtAuthGuard` — lê `Authorization: Bearer <access>`, valida, busca o usuário por id, injeta `req.user = { id, role, status }`; sem/!inválido → 401; `SUSPENDED` → 403; inexistente → 401.
  - `@Roles(...roles: string[])` + `RolesGuard` — 403 se `req.user.role` não estiver na lista.
  - `GET /auth/me` (protegido por `JwtAuthGuard`) retorna `req.user`.

- [ ] **Step 1: Escrever o teste e2e dos guards**

Create `test/auth.guards.e2e-spec.ts`:
```typescript
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { IDENTITY_PROVIDER } from '../src/identity/identity.port';
import { FakeIdentityProvider } from '../src/identity/fake-identity.adapter';

describe('Auth guards', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let fake: FakeIdentityProvider;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(IDENTITY_PROVIDER).useClass(FakeIdentityProvider)
      .compile();
    app = mod.createNestApplication();
    await app.init();
    prisma = mod.get(PrismaService);
    fake = mod.get(IDENTITY_PROVIDER);
  });
  beforeEach(async () => {
    fake.reset();
    await prisma.refreshToken.deleteMany();
    await prisma.user.deleteMany();
  });
  afterAll(async () => { await app.close(); });

  function http() { return request(app.getHttpServer()); }
  async function loginClient(sub: string): Promise<string> {
    fake.register(`tok-${sub}`, { provider: 'google', subject: sub, email: `${sub}@x.com`, name: sub });
    const res = await http().post('/auth/google').send({ idToken: `tok-${sub}`, role: 'CLIENT' });
    return res.body.accessToken;
  }

  it('/auth/me sem token → 401; com token → usuário', async () => {
    await http().get('/auth/me').expect(401);
    const access = await loginClient('me1');
    const res = await http().get('/auth/me').set('Authorization', `Bearer ${access}`).expect(200);
    expect(res.body).toMatchObject({ role: 'CLIENT', status: 'ACTIVE' });
  });

  it('status fresco: suspender invalida o MESMO access token (403)', async () => {
    const access = await loginClient('me2');
    const user = await prisma.user.findFirst({ where: { providerSubject: 'me2' } });
    await prisma.user.update({ where: { id: user!.id }, data: { status: 'SUSPENDED' } });
    await http().get('/auth/me').set('Authorization', `Bearer ${access}`).expect(403);
  });

  it('RolesGuard: CLIENT no endpoint admin → 403', async () => {
    const access = await loginClient('me3');
    const user = await prisma.user.findFirst({ where: { providerSubject: 'me3' } });
    await http().post(`/admin/users/${user!.id}/suspend`).set('Authorization', `Bearer ${access}`).expect(403);
  });
});
```

- [ ] **Step 2: Rodar para ver falhar**

Run: `npm run test:int -- test/auth.guards.e2e-spec.ts`
Expected: FAIL — `/auth/me` (e `/admin/...`, Task 7) inexistentes.

- [ ] **Step 3: Implementar o JwtAuthGuard**

Create `src/auth/jwt-auth.guard.ts`:
```typescript
import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Request } from 'express';
import { TokenService } from './token.service';
import { UsersService } from '../users/users.service';

export interface AuthUser {
  id: string;
  role: string;
  status: string;
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly tokens: TokenService,
    private readonly users: UsersService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request & { user?: AuthUser }>();
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing bearer token');
    }
    const payload = this.tokens.verifyAccess(header.slice('Bearer '.length));
    const user = await this.users.findById(payload.sub);
    if (!user) {
      throw new UnauthorizedException('User not found');
    }
    if (user.status === 'SUSPENDED') {
      throw new ForbiddenException('User suspended');
    }
    req.user = { id: user.id, role: user.role, status: user.status };
    return true;
  }
}
```

> Nota TS1272: `Request` do express usado em tipo é seguro aqui (não é parâmetro decorado). Se o tsc reclamar, troque por `import type { Request } from 'express';`.

- [ ] **Step 4: Implementar Roles decorator + RolesGuard**

Create `src/auth/roles.decorator.ts`:
```typescript
import { SetMetadata } from '@nestjs/common';

export const ROLES_KEY = 'roles';
export const Roles = (...roles: string[]): MethodDecorator & ClassDecorator =>
  SetMetadata(ROLES_KEY, roles);
```

Create `src/auth/roles.guard.ts`:
```typescript
import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { ROLES_KEY } from './roles.decorator';
import { AuthUser } from './jwt-auth.guard';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) {
      return true;
    }
    const req = context.switchToHttp().getRequest<Request & { user?: AuthUser }>();
    if (!req.user || !required.includes(req.user.role)) {
      throw new ForbiddenException('Insufficient role');
    }
    return true;
  }
}
```

- [ ] **Step 5: Adicionar GET /auth/me e registrar guards no módulo**

Modify `src/auth/auth.controller.ts` — adicionar:
```typescript
import { Get, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { JwtAuthGuard, AuthUser } from './jwt-auth.guard';
```
e o método:
```typescript
  @Get('me')
  @UseGuards(JwtAuthGuard)
  me(@Req() req: Request & { user: AuthUser }): AuthUser {
    return req.user;
  }
```

Modify `src/auth/auth.module.ts` — adicionar aos `providers`: `JwtAuthGuard`, `RolesGuard`; e aos `exports`: `JwtAuthGuard`, `RolesGuard` (outros subsistemas vão usar). Garanta `imports` já tem `PrismaModule`, `UsersModule`, `IdentityModule`. O `Reflector` é provido pelo Nest automaticamente.

- [ ] **Step 6: Rodar o teste e o tsc**

Run:
```bash
npm run test:int -- test/auth.guards.e2e-spec.ts
npx tsc --noEmit
```
Expected: o teste do `/admin/...` (3º) só passa após a Task 7. Os dois primeiros (`/auth/me` e status fresco) devem PASSAR; o 3º falha por rota inexistente. Confirme os 2 verdes e siga; ele fica verde na Task 7. (Se preferir, comente o 3º teste e descomente na Task 7.) tsc exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/auth test/auth.guards.e2e-spec.ts
git commit -m "feat(auth): JwtAuthGuard (fresh status), RolesGuard, GET /auth/me"
```

---

### Task 7: Endpoints de admin (activate/suspend) + seed de admin

**Files:**
- Create: `src/admin/admin.controller.ts`
- Create: `src/admin/admin.module.ts`
- Create: `prisma/seed-admin.ts`
- Modify: `src/app.module.ts`
- Modify: `package.json` (script `seed:admin`)
- Test: completar `test/auth.guards.e2e-spec.ts` + `test/admin.e2e-spec.ts`

**Interfaces:**
- Consumes: `JwtAuthGuard`, `RolesGuard`, `@Roles` (Task 6), `UsersService.setStatus` (Task 3).
- Produces: `POST /admin/users/:id/activate` e `POST /admin/users/:id/suspend` (protegidos por `JwtAuthGuard`+`RolesGuard`, `@Roles('ADMIN')`); script `npm run seed:admin -- <provider> <subject> <email> <name>` que cria/garante um usuário ADMIN ACTIVE.

- [ ] **Step 1: Escrever o teste e2e de admin**

Create `test/admin.e2e-spec.ts`:
```typescript
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { IDENTITY_PROVIDER } from '../src/identity/identity.port';
import { FakeIdentityProvider } from '../src/identity/fake-identity.adapter';

describe('Admin endpoints', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let fake: FakeIdentityProvider;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(IDENTITY_PROVIDER).useClass(FakeIdentityProvider)
      .compile();
    app = mod.createNestApplication();
    await app.init();
    prisma = mod.get(PrismaService);
    fake = mod.get(IDENTITY_PROVIDER);
  });
  beforeEach(async () => {
    fake.reset();
    await prisma.refreshToken.deleteMany();
    await prisma.user.deleteMany();
  });
  afterAll(async () => { await app.close(); });

  function http() { return request(app.getHttpServer()); }

  async function adminToken(): Promise<string> {
    fake.register('tok-admin', { provider: 'google', subject: 'admin1', email: 'admin@x.com', name: 'Admin' });
    // cria como CLIENT pelo fluxo e promove direto no banco para ADMIN
    await http().post('/auth/google').send({ idToken: 'tok-admin', role: 'CLIENT' });
    const u = await prisma.user.findFirst({ where: { providerSubject: 'admin1' } });
    await prisma.user.update({ where: { id: u!.id }, data: { role: 'ADMIN' } });
    const res = await http().post('/auth/google').send({ idToken: 'tok-admin' });
    return res.body.accessToken;
  }

  async function makeModel(sub: string): Promise<string> {
    fake.register(`tok-${sub}`, { provider: 'google', subject: sub, email: `${sub}@x.com`, name: sub });
    await http().post('/auth/google').send({ idToken: `tok-${sub}`, role: 'MODEL' });
    const u = await prisma.user.findFirst({ where: { providerSubject: sub } });
    return u!.id;
  }

  it('admin ativa uma modelo PENDING → ACTIVE', async () => {
    const token = await adminToken();
    const modelId = await makeModel('mod1');
    await http().post(`/admin/users/${modelId}/activate`).set('Authorization', `Bearer ${token}`).expect(201);
    const u = await prisma.user.findUnique({ where: { id: modelId } });
    expect(u?.status).toBe('ACTIVE');
  });

  it('admin suspende usuário; inexistente → 404', async () => {
    const token = await adminToken();
    const modelId = await makeModel('mod2');
    await http().post(`/admin/users/${modelId}/suspend`).set('Authorization', `Bearer ${token}`).expect(201);
    expect((await prisma.user.findUnique({ where: { id: modelId } }))?.status).toBe('SUSPENDED');
    await http().post(`/admin/users/00000000-0000-0000-0000-000000000000/suspend`)
      .set('Authorization', `Bearer ${token}`).expect(404);
  });
});
```

- [ ] **Step 2: Rodar para ver falhar**

Run: `npm run test:int -- test/admin.e2e-spec.ts`
Expected: FAIL — rotas `/admin/...` inexistentes.

- [ ] **Step 3: Implementar o AdminController e o módulo**

Create `src/admin/admin.controller.ts`:
```typescript
import { Controller, Param, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { UsersService } from '../users/users.service';

@Controller('admin/users')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN')
export class AdminController {
  constructor(private readonly users: UsersService) {}

  @Post(':id/activate')
  async activate(@Param('id') id: string): Promise<{ id: string; status: string }> {
    const u = await this.users.setStatus(id, 'ACTIVE');
    return { id: u.id, status: u.status };
  }

  @Post(':id/suspend')
  async suspend(@Param('id') id: string): Promise<{ id: string; status: string }> {
    const u = await this.users.setStatus(id, 'SUSPENDED');
    return { id: u.id, status: u.status };
  }
}
```

Create `src/admin/admin.module.ts`:
```typescript
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';
import { AdminController } from './admin.controller';

@Module({
  imports: [AuthModule, UsersModule],
  controllers: [AdminController],
})
export class AdminModule {}
```

Modify `src/app.module.ts` — adicionar `AdminModule` aos imports.

- [ ] **Step 4: Criar o seed de admin**

Create `prisma/seed-admin.ts`:
```typescript
import { PrismaClient } from '@prisma/client';

async function main(): Promise<void> {
  const [provider, subject, email, name] = process.argv.slice(2);
  if (!provider || !subject || !email || !name) {
    throw new Error('usage: seed:admin -- <provider> <subject> <email> <name>');
  }
  const prisma = new PrismaClient();
  await prisma.user.upsert({
    where: { provider_providerSubject: { provider, providerSubject: subject } },
    update: { role: 'ADMIN', status: 'ACTIVE' },
    create: { role: 'ADMIN', provider, providerSubject: subject, email, displayName: name, status: 'ACTIVE' },
  });
  await prisma.$disconnect();
  // eslint-disable-next-line no-console
  console.log(`admin garantido: ${provider}:${subject}`);
}

void main();
```

Add to `package.json` scripts:
```json
"seed:admin": "ts-node prisma/seed-admin.ts"
```
Run `npm install -D ts-node` se ainda não existir.

- [ ] **Step 5: Descomentar/garantir o 3º teste da Task 6**

Confirme que `test/auth.guards.e2e-spec.ts` (teste "CLIENT no endpoint admin → 403") agora passa, pois a rota existe.

- [ ] **Step 6: Rodar a suíte completa e o tsc**

Run:
```bash
npm run test:int
npx tsc --noEmit
```
Expected: PASS — todas as suítes (ledger + identidade): schema, identity fake, users, token, auth flow, auth guards, admin, mais as suítes do ledger. tsc exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/admin prisma/seed-admin.ts src/app.module.ts package.json package-lock.json test/admin.e2e-spec.ts test/auth.guards.e2e-spec.ts
git commit -m "feat(admin): activate/suspend endpoints (ADMIN-only) + admin seed script"
```

---

## Cobertura do spec (self-review)

| Requisito do spec (seção) | Onde é atendido |
|---|---|
| JWT access + refresh, refresh por hash (§2,§3) | Task 4 (`TokenService`) |
| Rotação de refresh (§3, §6.2) | Task 4 + Task 5 (`/auth/refresh`) |
| Detecção de roubo → revoga todas as sessões + log (§3, §6.2, teste 7) | Task 4 (`rotateRefresh`) + teste |
| Status nunca do JWT; guard lê banco (§3, §6.4, §7, teste 11) | Task 6 (`JwtAuthGuard`) + teste status fresco |
| Login Google por porta + fake (§2, §5) | Task 2 (`IdentityProvider`/Google/Fake) |
| Auto-cadastro + KYC, sem convite (§2) | Task 5 (CLIENT ACTIVE / MODEL PENDING) — KYC real fora de escopo |
| Um papel por identidade; ADMIN não por cadastro (§2,§6.1) | Task 5 (`loginOrRegister`) + teste |
| Conta derivada client:/model: (§3) | Task 3 (`accountOf`) |
| Status lifecycle ACTIVE/PENDING/SUSPENDED (§3) | Task 3 (`createUser`/`setStatus`) |
| `/auth/google`, `/auth/refresh`, `/auth/logout`, `/auth/me` (§6) | Tasks 5 e 6 |
| Admin activate/suspend, admin por seed (§6.5, §2) | Task 7 |
| `RolesGuard` + `@Roles` (§7) | Task 6 |
| Segredos por env, boot falha (§3) | Tasks 2 e 4 (construtores lançam) |
| Migração não-interativa (§4) | Task 1 |
| `tsc --noEmit` limpo / `import type` (§3) | Tasks 2,4,5 usam `import type` em interfaces injetadas |
| Erros 400/401/403/404 (§8) | Tasks 5,6,7 |

Sem placeholders de implementação (todo passo tem código). Tipos consistentes entre tasks: `IdentityClaims`, `AuthUser`, `IDENTITY_PROVIDER`, `accountOf`, `signAccess`/`verifyAccess`/`issueRefresh`/`rotateRefresh`/`revoke` usados igual onde produzidos e consumidos.
