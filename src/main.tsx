import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import CloudApp from './CloudApp';
import { isCloudConfigured } from './supabase';
import './styles.css';
ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode>{isCloudConfigured ? <CloudApp /> : <App />}</React.StrictMode>);
