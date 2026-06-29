import { render, screen } from '@testing-library/react';
import App from './App';

it('renderiza o nome do produto', () => {
  render(<App />);
  expect(screen.getByText('Samy')).toBeInTheDocument();
});
