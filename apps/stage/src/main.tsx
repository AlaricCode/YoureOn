import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { StageErrorBoundary } from './boundary';
import './stage.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <StageErrorBoundary>
      <App />
    </StageErrorBoundary>
  </StrictMode>,
);
