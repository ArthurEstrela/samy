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
