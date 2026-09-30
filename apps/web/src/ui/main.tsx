import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';

const container = document.getElementById('root');

if (container === null) {
  throw new Error('ShipLoop owner UI could not start: index.html has no element with id "root" to mount into.');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
