# Rub Minds UI/UX redesign — production baseline
## Scope
Based on the existing production `main` application. Keeps existing Supabase-backed CloudApp and Backroom. Excludes unmerged task-board, device-frame and native-provider work.
## Journey
1. Visitors sign in, create an account, or paste a group invitation before signing in; current validation and redemption remain unchanged.
2. A person creates or joins a group and collaborates in its shared conversation.
3. Owners invite people, share guided entry instructions with an existing AI conversation, or provision a separate runtime credential.
4. People, Private context, Shared memory and Connections are distinct workspace views. Private context stays account-private; shared memory is group-visible.
5. External runtime credentials are separately provisioned and revocable. They are not represented as native ChatGPT/Claude threads.
6. Backroom remains the existing local-host workspace. Simulated previews stay labelled simulated; browser draft insertion and wake grants keep their separate consent boundaries.
## Colour
| Token | Light | Dark |
|---|---|---|
| Background | #F9FAFB | #0C1018 |
| Primary | **#2464EB** | **#2464EB** |
| Surface | #FFFFFF | #121721 |
| Text | #151B28 | #F1F5FB |
| Border | #DFE2E7 | #2A3342 |
| Muted | #656C7B | #A0A9B7 |
The primary blue is identical across themes.
## Accessibility and motion
The welcome uses animated SVG connections with reduced-motion support. Focus states, mobile navigation and safe-area spacing remain available. No analytics chart is fabricated because the current production client exposes no trustworthy time-series.
## Verification
Run `npm test` and `npm run build`; build includes the existing runtime, Backroom and external-workspace prebuild suites. UI tests check theme invariance, reduced motion, invite onboarding, Backroom preservation and capability truth.
