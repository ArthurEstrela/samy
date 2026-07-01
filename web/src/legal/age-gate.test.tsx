import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AgeGate } from './AgeGate';

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

describe('AgeGate', () => {
  it('bloqueia até confirmar 18+ e então revela o conteúdo', async () => {
    render(<AgeGate><div>conteudo-protegido</div></AgeGate>);
    expect(screen.getByText(/maiores de 18 anos/i)).toBeInTheDocument();
    expect(screen.queryByText('conteudo-protegido')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /18 anos ou mais/i }));
    expect(screen.getByText('conteudo-protegido')).toBeInTheDocument();
    expect(localStorage.getItem('samy.age_ok')).toBe('true');
  });

  it('pula o gate quando já confirmado antes', () => {
    localStorage.setItem('samy.age_ok', 'true');
    render(<AgeGate><div>conteudo-protegido</div></AgeGate>);
    expect(screen.getByText('conteudo-protegido')).toBeInTheDocument();
    expect(screen.queryByText(/maiores de 18 anos/i)).not.toBeInTheDocument();
  });
});
