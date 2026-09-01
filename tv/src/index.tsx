import React from 'react';
// React 17's render API (not react-dom/client's createRoot, which is
// React 18-only) — see package.json for why this app pins React 17.
import ReactDOM from 'react-dom';
import App from './App';
import './styles.css';

const container = document.getElementById('root');
if (container) {
  ReactDOM.render(<App />, container);
}
