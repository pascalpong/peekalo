# Peekalo decisions

Updated 17 October 2026. Human decisions take precedence over proposed defaults. When a choice changes, update the affected plan/backlog rather than keeping contradictory rules.

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
| D-09 | Web is profile/shared viewing only | Comments, chat, capture and uploads stay in apps. Necessary privacy/support/deletion pages are operational additions. |
| D-10 | Include comments and chat in the MVP | Build after the capture/reveal/share flow works. |
| D-11 | Capture mitigations are part of native implementation | Verify real behavior; web cannot promise prevention of recipient capture or retention. |
| D-12 | Inbox left, prominent Camera button in the center, Profile right | Tapping Camera opens the in-app camera; Camera remains the default entry screen. |
| D-13 | Share only photos/videos captured through the in-app camera | No gallery, photo-library or file imports. Captures still upload to private backend storage for processing and sharing. |
| D-14 | Camera stays behind its controls and the logo stays fixed at the top | D-16 supersedes literal full-viewport fill with a shared 9:16 frame. Keep controls clear of safe-area edges. Use difference blend where reliable; Android live preview uses a plain logo fallback. |
| D-15 | Tap the shutter for a photo; hold to record video and release to stop | The implementation uses a 300 ms hold threshold and stops automatically at ten seconds. Request microphone access on the first hold when needed, then ask the user to hold again. |
| D-16 | Camera preview and capture review use the same portrait 9:16 framing | Fit the centered frame on screen, leaving dark extra space on taller screens; center-crop captured photos to exact 9:16. This replaces the earlier literal full-viewport framing in D-14. Keep the fixed logo and unchanged center navigation button. |

| D-17 | Capture review includes a working Share action for protected Peekalo links and chosen recipients | Confirmed instead of exporting originals through the phone share sheet. A separate Peekalo Supabase project is authorized; recipient requests must be accepted before reveal. |
| D-18 | Web hold-to-reveal opens a full-viewport media overlay; release returns to the same blurred card | Keep the page position and existing allowance. Apply to the sample and protected photo/video viewer; opening the overlay does not grant fresh viewing time. |

## Adopted engineering direction

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
| E-13 | Development sharing runs on a Node server with a trusted Sharp/FFmpeg processing path and private Supabase storage | The user selected Render for the combined web/API/media container on 17 October and approved one Singapore 1 CPU / 2 GB service at US$25/month plus tax/usage, then requested leaving deployment pending. Retain the existing Supabase project and resume provisioning only on the user's request. Stable HTTPS verification, general signup email and physical-device evidence remain pending. |

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
