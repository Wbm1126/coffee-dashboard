import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import '../styles/tokens.css';
import '../styles/app.css';
import '../styles/gallery.css';
import '../styles/recommendations.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
