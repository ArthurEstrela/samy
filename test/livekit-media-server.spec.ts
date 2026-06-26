import { LivekitMediaServer } from '../src/calls/livekit-media-server.adapter';

describe('LivekitMediaServer', () => {
  const adapter = new LivekitMediaServer();
  const orig = { ...process.env };
  afterEach(() => { process.env = { ...orig }; });

  it('emite um JWT com a sala e a identidade quando configurado', async () => {
    process.env.LIVEKIT_API_KEY = 'devkey';
    process.env.LIVEKIT_API_SECRET = 'secretsecretsecretsecretsecret123';
    process.env.LIVEKIT_URL = 'wss://example.livekit.cloud';
    const { token, url } = await adapter.issueToken('call:abc', 'user:1');
    expect(url).toBe('wss://example.livekit.cloud');
    const parts = token.split('.');
    expect(parts).toHaveLength(3);
    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
    expect(payload.video.room).toBe('call:abc');
    expect(payload.sub).toBe('user:1');
  });

  it('lança erro claro quando não configurado', async () => {
    delete process.env.LIVEKIT_API_KEY;
    delete process.env.LIVEKIT_API_SECRET;
    delete process.env.LIVEKIT_URL;
    await expect(adapter.issueToken('r', 'i')).rejects.toThrow(/not configured/i);
  });
});
