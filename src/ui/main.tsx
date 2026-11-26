import React from 'react';
import { createRoot } from 'react-dom/client';
import { AppView } from './App';
import './styles.css';

const rootEl = document.getElementById('root');
if (rootEl) {
  createRoot(rootEl).render(
    <React.StrictMode>
      <AppView />
    </React.StrictMode>,
  );
}
