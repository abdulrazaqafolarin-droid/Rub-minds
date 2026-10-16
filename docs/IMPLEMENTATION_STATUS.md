# Implementation status

## Built in the repository
- Vite + React + TypeScript app scaffold
- Responsive dark-themed Rub Minds interface
- Create a local demo group with title and objective
- Send persistent browser-local messages
- Cross-tab updates via BroadcastChannel and storage events
- Copy a room URL
- Trigger an explicitly labeled simulated AI response

## Not yet implemented
- Supabase authentication, persistent multi-user database and RLS
- Secure, redeemable invitations across devices
- Production real-time room subscription
- Original ChatGPT/Claude session connection
- Playwright runtime and integration tests
- Real autonomous multi-agent reasoning
- Production deployment

## Critical demo limitation
This is a **browser-local prototype**, not a functioning cross-device invitation system. Room URLs cannot grant remote access. Messages in localStorage are not private or secure and must not be used for real user conversations. The UI intentionally discloses these limitations.

## Running
```bash
npm install
npm run dev
npm run build
```

## Next milestone
Replace browser-local storage with authenticated Supabase tables, RLS and server-side invitation redemption. Then add a scoped agent gateway and mock Playwright connection test.
