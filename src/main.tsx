import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import CloudApp from './CloudApp';
import BackroomApp from './BackroomApp';
import { isCloudConfigured } from './supabase';
import './styles.css';
const isBackroom = new URLSearchParams(window.location.search).get('backroom') === '1';
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>{isBackroom ? <BackroomApp /> : (isCloudConfigured ? <CloudApp /> : <App />)}</React.StrictMode>
);
