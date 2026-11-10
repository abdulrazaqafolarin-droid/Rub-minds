# Rub Minds UI/UX redesign

## Product architecture
Rub Minds is one shared group collaboration system. Humans and existing AI sessions are participants in the same group. Phone, desktop, terminal and browser frames are execution surfaces associated with those participants; they must not be shown as duplicate group members.

## Main user journey
1. **Create a group:** a signed-in person creates a group and defines its objective.
2. **Join a group:** a new or returning person accepts a share link, or pastes an invitation link into the workspace Join with invitation flow. The invite token remains in the URL through the existing authentication flow.
3. **Bring more minds:** the owner creates a room-scoped invitation. A person follows the human sign-in route. An existing AI conversation receives guided instructions and can use only capabilities supported by its host. A separate credential is available for an independently configured AI runtime; it is not presented as a native ChatGPT or Claude thread.
4. **Collaborate:** the Conversation tab is the one place for shared messages and the message composer.
5. **Coordinate work:** Tasks has its own section. People shows the actual group participants and their participant kinds/statuses.
6. **Manage context:** Private context is account-private. Shared memory is visible to the group. The two are deliberately separate.
7. **Manage access:** Connections holds human invitations, existing AI guidance and external runtime credential management.
8. **Use execution surfaces:** Backroom is a separate but visually integrated workspace for paired devices and live runtimes. Frame association, native app control and autonomous Send are distinct permissions.

## Colour tokens
| Token | Light mode | Dark mode |
| --- | --- | --- |
| Background | #F9FAFB | #0C1018 |
| Primary blue | **#2464EB** | **#2464EB** |
| Cards / surfaces | #FFFFFF | #121721 |
| Text | #151B28 | #F1F5FB |
| Borders | #DFE2E7 | #2A3342 |
| Muted text | #656C7B | #A0A9B7 |

The primary blue must not shift between modes. It remains #2464EB everywhere; only surrounding surface and text contrast adapt.

## Interaction and motion
The landing workspace includes a custom SVG constellation of participants and execution surfaces, animated path dashes, restrained node pulses, floating surface tokens and sequenced entrance transitions. Anime.js timelines and staggered animation examples informed the sequencing; Motion for React's transition, presence and reduced-motion guidance informed the interaction and accessibility decisions. The implementation uses small CSS/browser-native effects rather than adding another animation runtime to the app bundle. The UI honors prefers-reduced-motion.

References: [Anime.js timelines](https://animejs.com/documentation/timeline), [Anime.js stagger](https://animejs.com/documentation/utilities/stagger/), [Motion for React](https://motion.dev/docs/react), [Motion reduced-motion guidance](https://motion.dev/docs/react-use-reduced-motion).

## Chart policy
There is no trustworthy activity time-series dataset in the current client data model. The redesign does not create a fake chart. Home cards show actual group titles/objectives loaded from Supabase; the room header shows actual participant and message counts. The referenced [shadcn/ui chart](https://ui.shadcn.com/docs/components/base/chart) uses Recharts v3 and requires a sized responsive container. We do not add that dependency or render a chart until a real metric and meaningful time range exist.

## Accessibility and responsive behavior
- All interactive controls have visible keyboard focus.
- Exactly one secondary room view is active at a time.
- The message composer is only rendered in Conversation.
- Room sections scroll horizontally on smaller viewports instead of disappearing.
- Group switching, join invitation and Backroom navigation remain available on narrow screens.
- The workspace rail adapts into a compact sticky mobile header.
- Safe-area bottom padding is applied to the mobile composer.
- Theme preference follows the operating system initially and remembers an explicit choice.

## Tests and local verification
The UI tests exercise theme preference, exact same-blue token, reduced-motion support, mutual exclusion of panels, composer visibility and participant-kind labelling. Run npm test. npm run build also runs the comprehensive prebuild Node suites for runtime, MCP, Backroom, external workspaces and native companion contracts.
