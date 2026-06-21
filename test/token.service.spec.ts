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
