import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useProfile } from './useProfile';
import { useUpsertProfile } from './useUpsertProfile';

export function ProfileForm(): JSX.Element {
  const { data, isLoading } = useProfile();
  const upsert = useUpsertProfile();
  const [stageName, setStageName] = useState('');
  const [bio, setBio] = useState('');
  const [price, setPrice] = useState('5.00');
  const [tags, setTags] = useState('');
  const [voice, setVoice] = useState('');

  useEffect(() => {
    if (data) {
      setStageName(data.stageName);
      setBio(data.bio ?? '');
      setPrice(data.pricePerMinute);
      setTags(data.tags.join(', '));
      setVoice(data.voicePreviewUrl ?? '');
    }
  }, [data]);

  const submit = (e: FormEvent): void => {
    e.preventDefault();
    upsert.mutate({
      stageName,
      bio: bio || undefined,
      pricePerMinute: price,
      tags: tags.split(',').map((t) => t.trim()).filter(Boolean),
      voicePreviewUrl: voice || undefined,
    });
  };

  if (isLoading) return <div className="mt-6 h-64 rounded-2xl bg-velvet animate-pulse" />;

  return (
    <form onSubmit={submit} className="mt-6 rounded-2xl bg-velvet p-6 flex flex-col gap-4">
      <div>
        <label htmlFor="stageName" className="block text-mist text-sm">Nome artístico</label>
        <input id="stageName" value={stageName} onChange={(e) => setStageName(e.target.value)} required className="mt-1 w-full rounded-lg bg-void px-4 py-3 text-cream outline-none focus-visible:ring-2 focus-visible:ring-ember" />
      </div>
      <div>
        <label htmlFor="bio" className="block text-mist text-sm">Bio</label>
        <textarea id="bio" value={bio} onChange={(e) => setBio(e.target.value)} rows={3} className="mt-1 w-full rounded-lg bg-void px-4 py-3 text-cream outline-none focus-visible:ring-2 focus-visible:ring-ember" />
      </div>
      <div>
        <label htmlFor="price" className="block text-mist text-sm">Preço por minuto (créditos)</label>
        <input id="price" type="number" min="1" step="0.01" value={price} onChange={(e) => setPrice(e.target.value)} required className="mt-1 w-full rounded-lg bg-void px-4 py-3 font-mono text-cream outline-none focus-visible:ring-2 focus-visible:ring-ember" />
      </div>
      <div>
        <label htmlFor="tags" className="block text-mist text-sm">Tags (separadas por vírgula)</label>
        <input id="tags" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="suave, grave, carinhosa" className="mt-1 w-full rounded-lg bg-void px-4 py-3 text-cream outline-none focus-visible:ring-2 focus-visible:ring-ember" />
      </div>
      <div>
        <label htmlFor="voice" className="block text-mist text-sm">URL do preview de voz (opcional)</label>
        <input id="voice" value={voice} onChange={(e) => setVoice(e.target.value)} className="mt-1 w-full rounded-lg bg-void px-4 py-3 text-cream outline-none focus-visible:ring-2 focus-visible:ring-ember" />
      </div>
      <button type="submit" disabled={upsert.isPending} className="rounded-full bg-ember px-6 py-3 text-void disabled:opacity-50">
        {upsert.isPending ? 'Salvando…' : 'Salvar perfil'}
      </button>
      {upsert.isSuccess && <p className="text-gold text-sm">Perfil salvo ✓</p>}
      {upsert.isError && <p className="text-ember text-sm">Não foi possível salvar. Tente de novo.</p>}
    </form>
  );
}
