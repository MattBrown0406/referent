import React from 'react';
import { createRoot } from 'react-dom/client';

import AnswerLink from './AnswerLink';
import App from './App';
import BedCheckIn from './BedCheckIn';
import EmailPreferences from './EmailPreferences';
import FamilyAssessment from './FamilyAssessment';
import Handoff from './Handoff';
import './styles.css';

// Signed-out pages, each reached by a private link: /h a referral handoff
// (src/Handoff.tsx), /a a placement request opened from a practice's answer
// link (src/AnswerLink.tsx), /b the weekly bed check-in email's page
// (src/BedCheckIn.tsx), /u email settings and unsubscribe
// (src/EmailPreferences.tsx), /f a family assessment a practice sent
// (src/FamilyAssessment.tsx). Everything else is the center portal.
const isHandoff = /^\/h\/?$/.test(window.location.pathname);
const isAnswerLink = /^\/a\/?$/.test(window.location.pathname);
const isBedCheckIn = /^\/b\/?$/.test(window.location.pathname);
const isEmailPreferences = /^\/u\/?$/.test(window.location.pathname);
const isFamilyAssessment = /^\/f\/?$/.test(window.location.pathname);

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {isHandoff ? <Handoff />
      : isAnswerLink ? <AnswerLink />
        : isBedCheckIn ? <BedCheckIn />
          : isEmailPreferences ? <EmailPreferences />
            : isFamilyAssessment ? <FamilyAssessment />
              : <App />}
  </React.StrictMode>,
);
