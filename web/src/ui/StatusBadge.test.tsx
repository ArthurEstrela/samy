import { render, screen } from '@testing-library/react';
import { StatusBadge } from './StatusBadge';

it('mapeia cada status pro rótulo certo', () => {
  const { rerender } = render(<StatusBadge status="ONLINE" />);
  expect(screen.getByText('online')).toBeInTheDocument();
  rerender(<StatusBadge status="OCUPADA" />);
  expect(screen.getByText('ocupada')).toBeInTheDocument();
  rerender(<StatusBadge status="OFFLINE" />);
  expect(screen.getByText('offline')).toBeInTheDocument();
});
