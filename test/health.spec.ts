import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import helmet from 'helmet';
import { AppModule } from '../src/app.module';

describe('GET /health', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication({ rawBody: true });
    app.use(helmet());
    await app.init();
  });
  afterAll(async () => { await app.close(); });

  it('retorna 200 com postgres e redis up', async () => {
    const res = await request(app.getHttpServer()).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok', postgres: 'up', redis: 'up' });
  });

  it('aplica headers de segurança (helmet)', async () => {
    const res = await request(app.getHttpServer()).get('/health');
    expect(res.headers['x-frame-options']).toBeDefined();
  });
});
