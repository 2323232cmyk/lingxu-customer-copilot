import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import './index.css';
import './app/workspace-theme.css';
import './app/crm-refresh.css';
import './app/conversation-refresh.css';
import './app/panel-sizing.css';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('应用根节点不存在');
}

createRoot(rootElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
