import { FakeMediaServer } from '../src/calls/fake-media-server.adapter';

describe('FakeMediaServer', () => {
  it('emite token e url determinísticos para a identidade', async () => {
    const fake = new FakeMediaServer();
    const a = await fake.issueToken('call:1', 'model:9');
    expect(a.token).toContain('call:1');
    expect(a.token).toContain('model:9');
    expect(a.url).toMatch(/^wss:\/\//);
  });
});
