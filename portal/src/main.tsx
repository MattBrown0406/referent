import React from 'react';
import { createRoot } from 'react-dom/client';

import AnswerLink from './AnswerLink';
import App from './App';
import Handoff from './Handoff';
import './styles.css';

// /h is a referral handoff's page (signed out, src/Handoff.tsx); /a is a
// placement request opened from a practice's answer link (signed out,
// src/AnswerLink.tsx); everything else is the center portal.
const isHandoff = /^\/h\/?$/.test(window.location.pathname);
const isAnswerLink = /^\/a\/?$/.test(window.location.pathname);

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {isHandoff ? <Handoff /> : isAnswerLink ? <AnswerLink /> : <App />}
  </React.StrictMode>,
);
