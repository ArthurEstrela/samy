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
