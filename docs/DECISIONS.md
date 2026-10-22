# Peekalo decisions

Updated 22 October 2026. Human decisions take precedence over proposed defaults. When a choice changes, update the affected plan/backlog rather than keeping contradictory rules.

## Confirmed product decisions

| ID | Decision | Reason / boundary |
| --- | --- | --- |
| D-01 | Name is **Peekalo** | Corrected by the user. |
| D-02 | Camera-first Snapchat-style sharing | Take a photo or <=10-second video, review, then select account recipients or create an external link. |
| D-03 | iOS and Android apps | Shared implementation is preferred; platform behavior still needs separate verification. |
| D-04 | Received/profile media is hidden or blurred by default | Hold to reveal; release hides. Owner review is a separate state. |
| D-05 | Up to ten seconds total across holds | Not a fresh ten seconds each hold. Accounts and guests cannot be assumed to identify one unique human. |
| D-06 | Native shares target selected accounts | The owner's recipient grant determines access. No public/follower reveal rights by default. |
| D-07 | External links need no viewer sign-in | Bind the first claim to a server-issued guest identity, or to the account if opened in-app before claim. |
| D-08 | External link is globally single-use | Only the first deliberate revealer can claim it. Preview requests do not claim it; clearing cookies cannot reopen it. |
| D-09 | Product web app is profiles/shared viewing; marketing and early-access signup are a separate website | Comments, chat, capture and uploads stay in native apps. Privacy/support/deletion pages are operational additions. D-20 sets marketing scope; D-23 separates its application. |
| D-10 | Include comments and chat in the MVP | Build after the capture/reveal/share flow works. |
| D-11 | Capture mitigations are part of native implementation | Verify real behavior; web cannot promise prevention of recipient capture or retention. |
| D-12 | Inbox left, prominent Camera button in the center, Profile right | Tapping Camera opens the in-app camera; Camera remains the default entry screen. |
| D-13 | Share only photos/videos captured through the in-app camera | No gallery, photo-library or file imports. Captures still upload to private backend storage for processing and sharing. |
| D-14 | Camera stays behind its controls and the logo stays fixed at the top | D-16 supersedes literal full-viewport fill with a shared 9:16 frame. Keep controls clear of safe-area edges. D-22 replaces the earlier blend/fallback treatment with canonical artwork on a subtle dark backing. |
| D-15 | Tap the shutter for a photo; hold to record video and release to stop | The implementation uses a 300 ms hold threshold and stops automatically at ten seconds. Request microphone access on the first hold when needed, then ask the user to hold again. |
| D-16 | Camera preview and capture review use the same portrait 9:16 framing | Fit the centered frame on screen, leaving dark extra space on taller screens; center-crop captured photos to exact 9:16. This replaces the earlier literal full-viewport framing in D-14. Keep the fixed logo and unchanged center navigation button. |

| D-17 | Capture review includes a working Share action for protected Peekalo links and chosen recipients | Confirmed instead of exporting originals through the phone share sheet. A separate Peekalo Supabase project is authorized; recipient requests must be accepted before reveal. |
| D-18 | Web hold-to-reveal opens a full-viewport media overlay; release returns to the same blurred card | Keep the page position and existing allowance. Apply to the sample and protected photo/video viewer; opening the overlay does not grant fresh viewing time. |
| D-19 | Native accounts can sign in with Google as well as email | Requested 17 October. Uses Supabase Google OAuth (PKCE) through the in-app browser sheet and the `peekalo://auth-callback` redirect. Google accounts arrive with a verified email, so they do not depend on the pending signup email provider. Invites are not decided yet. |
| D-20 | Build a prelaunch marketing landing page, initially in the existing Next.js app | Requested 20 October. D-23 moves it into a separate website without changing this scope. Explain capture/share/hold-to-reveal, show a labelled public sample, and prepare consent-based early-access collection. Retain `/u/demo` and `/s/demo`. User chose branded email after selecting a domain (20 October); domain and mailbox setup remain pending. Do not create a temporary Gmail account or publish a fabricated working address. Keep collection closed until storage and a private contact/removal route are connected. Public hosting remains pending under E-13. |
| D-21 | One shared product and design foundation for native and web | Requested 20 October after the marketing/mobile visual drift. Extend the accepted dark, mysterious homepage direction across the app and web viewer. Share semantic tokens and the display font; adapt layouts to each platform. This changes presentation, not capture/sharing rules. See the foundation below and FND-02 on the board. |
| D-22 | Use the exact same logo artwork across app and website | User corrected remaining logo differences on 20 October. Canonical paired-eye mark, outlined lowercase wordmark, spacing and lime period are defined in `packages/design/src/brand-geometry.ts` and colored from shared tokens. All branded placements use platform adapters to this artwork; do not re-type the wordmark or redraw the eyes. Camera uses the same colors on a small dark backing. Launcher/favicon assets derive from the same mark. |
| D-23 | Separate the marketing website from the product web app, retaining one foundation and backend | Requested 21 October. `apps/site` owns the marketing homepage, brand motion, privacy notice and waitlist-only proxy; `apps/web` owns product entry, profiles, shared viewers and existing APIs/media delivery. Share `@peekalo/design` and browser adapters in `@peekalo/web-ui`; keep canonical logo geometry and capture/claim/grant rules unchanged. Default local ports are 3100 for site and 3101 for product. WEB-SPLIT-01 tracks implementation/verification; paid hosting remains deferred. |

## Shared design foundation — D-21

- **Personality:** intimate, curious and calm. Charcoal surfaces, warm off-white text and restrained lime actions; media is the focus. The homepage can use cinematic composition while native screens prioritize quick capture and legible controls.
- **Source of truth:** `packages/design/src/index.ts` owns semantic colors, spacing, corner radii and the base type scale. `packages/design/assets/display.ttf` is the licensed Bricolage Grotesque bold display face for headings, with native/system sans-serif for body text. The logo uses D-22's outlined artwork rather than platform-rendered text. Numeric type tokens are a base scale; marketing headings can scale responsively and native text must remain scalable.
- **Canonical branding:** `@peekalo/design/brand` exposes fixed-proportion vector artwork; web's `BrandLogo` renders it directly and native's `BrandLogo` renders its bundled 1×/2×/3× PNG exports. The complete lockup is 184:40 and the mark is 32:28. Scale uniformly; retain the same eyes, wordmark and lime period in headers, camera, account panels, footer, illustrative phone and reveal overlay. `pnpm brand:generate` exports assets and `pnpm brand:check` detects drift. The glyph paths originate from the bundled licensed display face; the logo does not depend on a font loading successfully.
- **Color roles:** `background` is the page/screen, `surface` groups content, `elevated` holds inputs/secondary controls, `text` and `muted` are readable copy, `border` separates surfaces, and `accent` highlights the primary action. Lime controls always use `onAccent` text/icons. Error feedback uses `danger`/`dangerSurface`. Art, camera overlays and processed media previews can have their own colors.
- **Component rules:** one prominent primary action per section; secondary actions have a surface or outline. Use pill actions, softly rounded media/cards, consistent eyes/wordmark and outline icons. Keep visible keyboard focus on web and adequate native touch areas. Loading, empty, unavailable, pending, exhausted and revoked states must remain distinguishable without relying on color alone.
- **Product language:** a **moment** is one captured photo or video. Use **Hold to reveal**, **Hidden by default**, and **Up to 10 seconds total**; show the actual remaining allowance when known. Use **Create a single-use link** and **Send on Peekalo** for the two sharing paths. Demo/prototype labels and capture/privacy limits stay explicit. A visual style never establishes authorization or capture protection.
- **Implementation boundary:** share values/assets and product semantics, while React Native components stay platform-specific and browser apps share their brand/icons, reveal overlay and base CSS through `@peekalo/web-ui`. New interface work must consume the shared roles instead of inventing another palette. The fixed 9:16 frame, gesture handling, server ledger, claim/grant rules and closed waitlist remain governed by their existing decisions.

D-23 origin boundary: configure distinct `PUBLIC_SITE_URL` (marketing) and `PUBLIC_APP_URL` (product) origins on both servers. Cross-app links resolve from server configuration, never request Host headers; only development falls back to `http://127.0.0.1:3100` / `http://127.0.0.1:3101`. Missing/invalid production destinations omit links or show unavailable states. Marketing’s old `/s` and `/u` paths redirect to the product origin; product `/privacy` redirects to the website notice. Only the bounded waitlist proxy forwards marketing requests to the backend; no private viewer/auth proxy or database credentials are added to marketing. Both waitlist gates remain closed by default. Existing ignored environment files and deferred paid provisioning are unchanged.

## Adopted engineering direction

Marketing visual refinement (20 October): the user selected a dark, mysterious direction inspired by [Nixtio](https://nixtio.com/) and [mitacore](https://mitacore.co/), with approximately ten seconds of video in the homepage hero. Use original generated brand footage, oversized typography and restrained lime accents. Decorative hero motion is separate from the hold-to-reveal product demo and must offer a pause control, static fallback and reduced-motion support. Branded email remains pending domain selection; this visual change does not authorize paid hosting or open signup collection.

| ID | Direction | When to validate |
| --- | --- | --- |
| E-01 | TypeScript; Expo/React Native mobile, Next.js web, Supabase backend | Pin compatible versions during FND-01; validate media delivery/runtime needs during the reveal prototype. |
| E-02 | Private originals and separate processed blurred previews | Required before sharing real content; visual blur over an exposed original is insufficient. |
| E-03 | Atomic server claims/budgets, controlled clear-media delivery | Required for real single-use sharing; local timers are interaction prototypes only. |
| E-04 | Photo flow first, then <=10-second video | Video/audio/buffering checks are required before completing the overall privacy prototype. |
| E-05 | One repository, one build board, current chat for coordination | Use bounded specialist agents when useful; no new user-owned chats or external project service needed now. |
| E-06 | Project instructions first; no custom agent platform or skills yet | Revisit only after a repeated workflow or real product feature warrants it. |
| E-07 | Foundation: Expo55.0.31 / RN0.83.10, Next16.4.1, React19.2.0, Node24.14.1, pnpm11.25.0 | Selected for installed Xcode26.2 and clean peer resolution. Recheck compatibility before upgrades. |
| E-08 | Generate native projects; keep native output, temporary files and Xcode derived data in ignored local caches | Source-build RN via supported Expo config to avoid the spaced-path prebuilt artifact bug. Local caches do not ship. |
| E-09 | Local photo/video drafts stay in app cache, without photo-library saves | Discard/retake, navigation and ordinary backgrounding clear drafts and attempt file cleanup. While the explicit Share flow is open, retain its draft for upload/retry and hide review pixels during interruptions; late capture results are invalidated and cleaned up. Deletion is best effort, not a byte-erasure guarantee. Physical lifecycle evidence remains required. |
| E-10 | Native video recording has a ten-second duration limit plus a JavaScript stop fallback | Release stops recording; review supports play/pause, Retake and Discard. Recording duration is separate from the recipient viewing allowance. Verify duration, audio and interruption on physical devices. |
| E-11 | PHOTO-01 uses a shared local allowance controller and a non-sensitive public fixture | Mobile/web retain the sample balance across route changes within one JS runtime. Reload/restart resets it. One-second accessible reveals debit the same allowance. This proves interaction only; real claims, identity and persistence require LINK tasks. |

| E-12 | Protected delivery uses atomic, prepaid two-second leases under the same 10,000 ms total | Renew only within 750 ms of expiry. One-second leases failed intermittently during real storage fetches. Unused prepaid time is charged; clients cover at expiry while awaiting a late renewal. No delivered-byte erasure or capture guarantee. |
| E-13 | Development sharing runs on a Node server with a trusted Sharp/FFmpeg processing path and private Supabase storage | The user selected Render for the combined web/API/media container on 17 October and approved one Singapore 1 CPU / 2 GB service at US$25/month plus tax/usage, then requested leaving deployment pending. On 22 October the user chose free testing first: prepare separate Free Singapore web services for product/API/media and marketing, retaining Supabase, with manual deployments and waitlist collection closed. The prior paid plan remains deferred; no automatic paid upgrade. Both Free services now pass HTTPS health/navigation checks; reliable hosted reveal timing, general signup email and physical-device evidence remain pending. |

## Provisional defaults — not newly confirmed user requirements

| ID | Default | Resolve by |
| --- | --- | --- |
| P-01 | Three active media items per account, one image/video per item; deletion frees a slot | Before implementing upload reservations/quota. User's original “maximum three” remains ambiguous. |
| P-02 | First-sender accept/decline requests | Validate with the first working photo flow; enforce acceptance in backend if kept. Navigation is confirmed in D-12. |
| P-03 | One active external link per item, default expiry 24 hours | Before LINK-02. Global single-use behavior itself is confirmed. |
| P-04 | Continue a claimed guest link in its original browser; “Open in app” before claim | Before LINK-03. Explicit secure handoff after claim is deferred. |
| P-05 | Short prepaid reveal slices; conservative charging on interruptions/failures | Measure latency and usability during LINK-02/03 before fixing granularity. |
| P-06 | Email verification for app accounts; text-only chat plus existing-media references | Validate account/chat implementation scope. New captures use the same media limits. |
| P-07 | Small invited adult beta | Choose launch countries, age policy and operating/moderation rules before beta. |

Current unresolved defaults do not block the local scaffold or fixture-based interaction demo.

22 October local testing: the user chose Android first, has no domain/email provider and requested help creating Google OAuth. Prepare an isolated local Supabase + captured-email inbox with confirmation enabled, separate accounts and loopback-only ports; retain the existing hosted development project. Do not buy a domain/provider or enable paid hosting as part of this setup. Google project Peekalo Development (`quick-yen-512406-g8`) is created; credential/consent setup and device sign-in remain pending.
