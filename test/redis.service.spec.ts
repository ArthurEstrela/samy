import Redis from 'ioredis';
import { RedisService } from '../src/redis/redis.service';

describe('RedisService', () => {
  let service: RedisService;
  let raw: Redis;

  beforeAll(async () => {
    service = new RedisService();
    await service.onModuleInit();
    raw = new Redis(process.env.REDIS_URL as string);
  });
  beforeEach(async () => { await raw.flushdb(); });
  afterAll(async () => {
    await service.onModuleDestroy();
    await raw.quit();
  });

  it('setOnline marca presença com TTL positivo', async () => {
    await service.setOnline('m1');
    expect(await service.getStatus('m1')).toBe('ONLINE');
    expect(await service.ttlOf('m1')).toBeGreaterThan(0);
  });

  it('getStatus é OFFLINE quando não há chave', async () => {
    expect(await service.getStatus('ghost')).toBe('OFFLINE');
  });

  it('getStatuses reflete um lote (MGET)', async () => {
    await service.setOnline('a');
    await service.setOnline('b');
    const s = await service.getStatuses(['a', 'b', 'c']);
    expect(s).toEqual({ a: 'ONLINE', b: 'ONLINE', c: 'OFFLINE' });
  });

  it('getStatuses([]) devolve objeto vazio sem chamar o Redis', async () => {
    expect(await service.getStatuses([])).toEqual({});
  });
});
