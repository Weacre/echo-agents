# UI refresh

Implemented on `feature/ui-refresh`, based on the existing application at `107c642`.

## Design references

- [Home, 74:37](https://www.figma.com/design/kS71785BD8Bj6wnh4tI0A7/?node-id=74-37)
- [Initial conversation, 74:55](https://www.figma.com/design/kS71785BD8Bj6wnh4tI0A7/?node-id=74-55)
- [Active conversation, 74:84](https://www.figma.com/design/kS71785BD8Bj6wnh4tI0A7/?node-id=74-84)
- [Guest stories, 206:4](https://www.figma.com/design/kS71785BD8Bj6wnh4tI0A7/?node-id=206-4)

The publicly viewable canvases were reviewed visually. Exact layer measurements and original image exports were unavailable, so this is an implementation of the design direction, not a pixel-exact export.

## Pages and behavior

- `/`: purple photographic hero, companion invitation, educational sections and three existing anonymous cases. Existing support contacts, privacy dialog, sign-in, learning and guest links remain available. Case links now land on the corresponding `/stories` item.
- `/support`: a centered initial state, three suggested questions with access to all eight, persistent composer, pale purple user bubbles and outlined assistant bubbles. The four initial self-help resources remain available before sending; conversation recommendations are merged ahead of these defaults. Resources preserve their actual Markdown/HTML format and support reading or downloading.
- `/guests`: pale purple introduction, two-column cards, real topic filtering and all nine original guest identities. The sensitive-content dialog still allows cancellation before entering the selected guest's route.
- Small screens use stacked cards and a self-help drawer. Conversation controls, privacy information and the composer remain reachable at 320px.

The existing SSE, stop-generation, history restore, encryption/sync controls, authentication, guest IDs, and voluntary story contribution flow were retained. Chinese IME composition no longer sends a message when Enter confirms a candidate. Restored conversations also restore relevant self-help suggestions. No authentication, storage, or backend API policy was changed.

## Assets

- `public/logo.PNG` and the nine guest avatars reuse existing assets.
- `public/design/hero-portrait.webp` is a generated substitute, not the original Figma photograph or a real guest. The original PNG and the complete built-in imagegen prompt are retained alongside it in `hero-portrait.prompt.md`.
- `public/design/rose.svg` is a local vector interpretation of the floral background. The educational illustrations use the existing Lucide icon system.

To use exact design artwork later, replace these local assets and the three circular illustration contents without changing application logic.

## Validation

- TypeScript passed (`tsc --noEmit --incremental false`).
- Production build passed with `next build --webpack` (all 18 static pages generated).
- 48 safety tests, 6 Claude diagnostics tests and 16 mocked Claude route/SDK tests passed.
- ESLint passed for the changed components. Repository lint excluding the already-ignored `.local` scratch directory reports only the existing unused `children` warning in `components/ui/combobox.tsx`. Unfiltered lint also reports a pre-existing CommonJS import in `.local/claude-http-smoke.cjs`.
- Browser checks: desktop home/guest/conversation, 390px home/guest/conversation, 320px conversation, no horizontal overflow, all eight quick replies reachable, Shift+Enter, default resource drawer, guest filtering, cancellation and correct guest navigation, and visible chat failure/recovery state.

Local browser testing used `next dev --webpack --hostname localhost --port 3100`; the default Turbopack preview stalled in this environment. Real assistant replies could not be verified because the local service reports a missing `ANTHROPIC_API_KEY`. Signed-in cloud history was not exercised in this UI pass; its existing implementation and mocked backend tests are retained.
