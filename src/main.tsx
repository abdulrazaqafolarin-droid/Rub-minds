import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import CloudApp from './CloudApp';
import BackroomApp from './BackroomApp';
import { isCloudConfigured } from './supabase';
import { UiPreferencesProvider } from './UiPreferences';
import './styles.css';
import './rub-minds-redesign.css';
const isBackroom = new URLSearchParams(window.location.search).get('backroom') === '1';
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><UiPreferencesProvider>{isCloudConfigured ? (isBackroom ? <BackroomApp /> : <CloudApp />) : <App />}</UiPreferencesProvider></React.StrictMode>
);
