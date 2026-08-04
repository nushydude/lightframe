import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { BrowserDevelopmentApp } from './components/BrowserDevelopmentApp';
import { ErrorBoundary } from './components/ErrorBoundary';
import { markPerformanceTelemetryAppStart } from './services/performanceTelemetry';
import { getRuntime, initializeRuntime } from './services/runtime/runtime';
import './index.css';

markPerformanceTelemetryAppStart();
initializeRuntime();

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      {getRuntime().kind === 'browser-development' ? <BrowserDevelopmentApp /> : <App />}
    </ErrorBoundary>
  </React.StrictMode>
);
