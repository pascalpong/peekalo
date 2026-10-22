# Peekalo: first-version product and engineering plan

Prepared 15 October 2026. Status: FND-01 mobile/web foundation, local photo/video capture/review and PHOTO-01 local fixture reveal implemented, verification tracked in [BUILD_BOARD.md](BUILD_BOARD.md). The user confirms matching preview/photo framing and hold-to-record video with playback on Samsung SM-S931B / Android 17; earlier photo capture and Retake are also confirmed. Duration, audio, lifecycle/permission, front-camera and physical iOS checks remain pending. The fixture allowance is runtime-only; private backend sharing and recipient viewers are implemented in development; physical native sharing, general signup email and durable hosting remain pending. Accepted/default rules are recorded in [DECISIONS.md](DECISIONS.md).

## 1. Recommendation

Build Peekalo as a camera-first sharing app with Snapchat as the main product reference: take a photo or record a video up to ten seconds, review it, then send to chosen accounts or create a single-use external link. Use one React Native + Expo application for iOS and Android, a Next.js product web app, a separate Next.js marketing website, and one shared Supabase backend. Start with capture and reveal/privacy, then add comments and chat. Profiles and blurred media lists support sharing rather than leading the experience.

Core flow: **Camera -> photo or <=10-second video -> review/retake -> send to accounts or create link -> recipient sees blurred media -> hold to reveal.**

The native app, marketing homepage, public profile and shared viewer use the D-21 shared design foundation in [DECISIONS.md](DECISIONS.md). `@peekalo/design` provides semantic values, canonical logo artwork and the licensed display font to all three applications. D-23 separates `apps/site` (marketing) and `apps/web` (product/API); `@peekalo/web-ui` shares browser brand/icons, reveal overlay and base CSS. WEB-SPLIT-01 records the split; verification is tracked on the build board. Layouts remain platform-specific; the same product language and visual identity carry through capture, sharing and viewing. FND-02 tracks implementation and visual evidence.

The product promise should be: **posts stay hidden until an authorized viewer reveals them; selected app recipients get up to ten seconds total per post; an anonymous external link can be claimed by only one viewer for up to ten seconds; native apps add capture protection where available.** Do not promise that revealed content cannot be saved, or that a ten-second allowance destroys a recipient's copy.

## 2. Confirmed requirements and planning assumptions

Confirmed by the user:

- Product name: Peekalo.
- Native iOS and Android applications.
- Snapchat-style photo/video capture and recipient sharing, extended with external links; received/profile media stays hidden or blurred by default.
- Shared photos/videos originate only from the in-app camera; no gallery, photo-library or file imports. Captures still upload to private backend storage for processing and sharing.
- Bottom navigation is Inbox on the left, a prominent Camera button in the center, and Profile on the right. Tapping Camera opens the in-app camera.
- Camera preview and capture review share a centered portrait 9:16 frame fitted to the screen; taller screens retain dark extra space instead of changing the visible crop. Center-crop captured photos to exact 9:16. Keep D-22's canonical logo fixed at the top on a subtle dark backing for consistent colors/contrast. The center navigation button stays unchanged.
- Tap the shutter for a photo; hold for 300 ms to start video, then release to stop. Record at most ten seconds. The first hold requests microphone access when needed; hold again after granting it.
- Photos and short videos, with a maximum video duration of ten seconds.
- An initial upload limit of three; the exact meaning is still a planning assumption below.
- Press and hold to reveal. **Each person gets ten seconds total per post across all holds**, rather than a fresh ten seconds on every hold.
- Share a post by link; open it in the app when possible or in a web viewer.
- Comments and chat belong in the mobile apps.
- Product web app is limited to profiles and shared-media viewing. The separate website carries the prelaunch marketing homepage and consent-based early-access list (D-20/D-23).
- Capture and recording protection must be investigated and implemented to the extent the platforms support it.
- Web links allow anonymous visitors, without sign-in.
- In-app sharing targets selected recipient accounts, like Snapchat; a follower relationship alone must not grant reveal access.
- **External links are globally single-use:** only the first viewer to deliberately reveal can claim a link. That viewer can use up to ten seconds across holds; other viewers are denied.

Resolved design choices and proposed defaults for review; the rows above distinguish the user's confirmed requirements:

| Decision | Proposed first-version behavior |
| --- | --- |
| Three uploads | Three active media posts per account, including processing reservations; delete one to free a slot. One photo or video per post. |
| App identity | Verified account; explicit post-recipient grant. |
| Web identity | Anonymous random browser identifier in a secure cookie, bound to an atomic server-side link claim. Clearing the cookie loses resumption rights; it does not reopen the link. |
| Meaning of person | Account in the app; browser identity on anonymous web. Neither proves a unique human. |
| In-app audience | Only selected recipient accounts can reveal a direct share; owner retains access. An external-link capability is a separate access path. |
| Public profiles | Username, display name, optional bio, initials avatar, and blurred post grid. No public follower lists or clear post media. |
| Sharing | Off until the owner creates a link. One active link per post, expiring after 24 hours by default. It can be revoked for future requests or forwarded before someone claims it. |
| Budget scope | One ten-second allowance per account/post for native recipients. Each external link has one claimant and at most ten seconds; an identity's existing post balance is not reset by opening another link. |
| Video behavior | Starts at the beginning on the first hold, pauses/hides on release, resumes on the next hold; no seeking or looping in this version. |
| Owner access | Owner preview is exempt from the viewer allowance. Replacing media requires a new post; caption edits do not reset allowances. |
| Chat | Text and owner-sent references to existing Peekalo media, with a simple accept/decline request for new senders. New captures use the same three-item media pipeline; no separate attachment bypass, calls, or group chats. |
| Initial beta | Small invited adult test group; choose public launch countries and age policy before store submission. |

The server can enforce one claimant per link without knowing that person's real identity. Clearing cookies cannot reset a claimed link because its claim lives on the server. However, cookies, IP addresses, and device fingerprints cannot identify a unique human. Anonymous browser and signed-in app identities cannot automatically be merged: a separately granted native recipient might also claim an external link as a guest. Do not claim a per-human limit across those identities or add invasive fingerprinting.

## 3. Privacy: what can actually be protected

| Surface | Planned protection | Honest limit |
| --- | --- | --- |
| Android app | Enable `FLAG_SECURE` before displaying any clear media; protect app-switcher surfaces and cover on interruption. | Strong protection against normal OS screenshots and capture paths; device/OS differences and compromised devices prevent a universal guarantee. [Android guidance](https://developer.android.com/security/fraud-prevention/activities) |
| iOS app | Evaluate Expo's screenshot/recording prevention, mask during detected capture, and protect inactive/app-switcher snapshots. | Expo documents iOS prevention, but its secure-text rendering technique is not an Apple general screenshot-blocking guarantee. Apple screenshot notifications arrive after capture. Test the selected package on physical devices. [Expo API](https://docs.expo.dev/versions/latest/sdk/screen-capture/), [implementation](https://raw.githubusercontent.com/expo/expo/main/packages/expo-screen-capture/ios/SecureWindowCanvas.swift), [Apple notification](https://developer.apple.com/documentation/uikit/uiapplication/userdidtakescreenshotnotification) |
| Web, including Chrome | Authorization, genuine blurred preview assets, limited reveal access, no-store responses, link expiration/revocation. | No reliable general cross-browser prevention or detection of OS screenshots/recording. Clear media delivered to a browser can be retained. `display-capture` policy does not prevent another tool from capturing the page. [W3C specification](https://www.w3.org/TR/screen-capture/#permissions-policy-integration) |
| Every platform | Clear communication and optional later watermarking. | Another camera can photograph the screen. Delivered bytes cannot be recalled. |

Apple capture-state APIs can support covering content during recording, sharing, or remote control. They are distinct from stopping an ordinary screenshot. [Apple capture-state guidance](https://developer.apple.com/documentation/swiftui/protecting-sensitive-content-when-screen-sharing)

Use wording such as: “Hold to reveal. You have up to 10 seconds total for this post.” Before a guest claims a link: “Only the first viewer can use this link. Start viewing in this browser, or open it in the app first.” On web, show: “Browser viewers may save or capture revealed content.” Before the uploader enables web sharing, show that limitation and explain single use.

The ten-second rule controls server authorization and normal client behavior. It cannot guarantee ten seconds of actual observation by a malicious recipient who saves the image, freezes a client, or modifies the app. Account identity and link claims provide quota/access consistency, not capture resistance.

Blur is not encryption: even a processed blurred preview may reveal colors, silhouettes, or composition. Use heavy downsampling and blur; use an opaque placeholder if absolutely no visual information should be exposed. The original must never sit underneath a removable CSS blur in a public feed.

This design uses provider-managed storage and server processing, not end-to-end encryption. Authorized operators can access media for processing/moderation; administrative access must be restricted and audited. Ordinary MP4 files do not acquire DRM from a timer. Defer FairPlay/Widevine and any E2EE promise.

## 4. Mobile and web scope

| Feature | iOS / Android | Public-facing web |
| --- | --- | --- |
| Profile and blurred grid | Yes | Yes |
| Shared post viewer and countdown | Yes | Yes, anonymous and one claimant per link |
| Sign-in | Full account access | Not required for guest viewing |
| Take photo / record <=10-second video | Primary flow | No |
| Privately upload in-app captures / manage posts | Yes; three-active-post policy remains provisional | No |
| Feed | Chronological “Shared with you” and own posts | No |
| Comments | Flat text comments; author can delete own, post owner can remove | No |
| Chat | Text and existing-post cards | No |
| Report/block | Posts, comments, messages, users | Minimal report/support link on shared viewer |
| Settings and account deletion | Yes | Deletion request resource only |

Open the signed-in app on Camera. Bottom navigation places Inbox on the left, a prominent Camera button in the center, and Profile on the right. Tapping Camera opens the in-app camera. Inbox contains conversations and a chronological blurred “Shared with you” list. Profile contains the owner's active media and Settings. Use username lookup to select recipients and inspect blurred profiles. Omit followers, algorithmic discovery, Stories, Reels, likes, bookmarks, filters, monetization, and contact importing initially.

Comments are available to the owner and selected app recipients. Anonymous link visitors cannot read or write comments. Text/captions can themselves describe media; do not treat them as hidden by the image timer. The app can keep the discussion accessible after a recipient's media allowance is exhausted.

The separate marketing website in `apps/site` contains the D-20 landing page, privacy notice and early-access list. The product app in `apps/web` retains profiles, shared viewing and the backend; its entry links to explicitly labelled demos. Collection stays closed until storage and a private contact/removal route are connected. Web needs small privacy, terms, support, deletion, and domain-association endpoints. These support distribution and account control rather than adding a full web social app. Google requires a usable external deletion resource even when the app has in-app deletion. [Google deletion policy](https://support.google.com/googleplay/android-developer/answer/13327111?hl=en)

## 5. Core flows

### Capture, review and share

1. Sign in with email verification; select a username and accept terms.
2. Open Camera. Request camera permission when used. Tap the shutter for a photo; hold for 300 ms to start video and release to stop. The first hold requests microphone permission for video audio if needed; after granting it, hold again to record. Provide front/back camera switching, a visible recording timer and automatic stop at ten seconds using both native `maxDuration` and a JavaScript fallback. Use the same fitted portrait 9:16 preview/review frame and center-crop photos to that ratio. Do not add lenses, filters or editing tools yet.
3. Review the capture, retake/discard if needed, then choose recipient accounts or “Create link.” The draft is local until upload; do not automatically save it to the system photo library. Do not provide gallery, photo-library or file imports; every shared photo/video must originate from in-app camera capture.
4. Reserve one of the three slots on the server before upload. Reservations expire; retries use an idempotency key. A discarded local draft does not consume a published slot. Explain how to free a slot if the account already has three active items.
5. Upload into private staging storage through a narrowly scoped upload grant. Show a preparing state; no usable share link or recipient reveal is issued before the asset is ready.
6. A trusted worker checks the actual file format, size, dimensions, codec and duration. Normalize orientation, strip metadata/GPS, resize, normalize video to a broadly compatible format, and create a separate heavily blurred poster.
7. Run the chosen content-filtering step before publication. For the closed beta, a small manual approval queue is acceptable; public launch requires a practical filtering and response process.
8. Publish only when processing and moderation succeed, then complete the selected recipient share or generate the link. Failed/rejected uploads free the slot and clean up temporary files. Delete the raw upload after successful normalization unless a defined retention need exists.

Handle denied camera/microphone permission, capture interruption and cancellation without uploading or sending a partial recording. Recording duration and the recipient's cumulative viewing allowance are separate ten-second limits.

The current local implementation supports tap-to-photo, hold/release video recording, photo review, video play/pause, Retake and Discard. Camera preview and photo/video review use the same centered 9:16 frame; captured photos are cropped to that exact ratio. Drafts stay in app cache without saving to the photo library. Retake/discard, navigation away and backgrounding clear drafts and attempt file deletion; capture results arriving after interruption are invalidated and cleaned up rather than reopening review. Cleanup is best effort and cannot guarantee erasure of bytes. All 31 local tests pass: ten photo-session tests, fourteen video-session tests and seven framing tests. Mobile lint and TypeScript pass; these checks do not establish native camera behavior. The new native build with `expo-video@55.0.21` and `expo-image-manipulator@55.0.21` installs successfully on Samsung SM-S931B / Android 17. The user confirms matching preview/photo framing and hold/release video recording with playback. Ten-second duration, audio, interruption, permission-denial and front-camera checks, plus physical iOS framing/capture, still require evidence. SHARE-01 now implements private development upload, protected links and accepted recipient grants with server viewing leases and owner revocation. All four development migrations are deployed and 64 live backend assertions pass through the local production gateway; physical native sharing, general signup email delivery and durable public API hosting remain pending. See the build board for detailed evidence.

Proposed tunable intake limits: 15 MB/photo, 30 MB/video, 20 megapixels/photo; normalized images up to 1600 pixels on the long edge, videos up to 720p. These are engineering starting points to validate against real quality, encoding and cost tests. The ten-second video limit and three-post cap are enforced on the server, including simultaneous requests.

### Reveal a post

1. Show only the safe preview and remaining allowance. For example, after a two-second hold: “8 seconds left.”
2. Viewer presses the media's designated reveal area. Page scrolling, unrelated buttons, and link previews do not count as holds.
3. For a direct share, require both an active owner-created recipient grant and an accepted sender/conversation request in backend authorization. Pending or declined requests cannot reveal through the API. For an external link, check its separate capability and claimant identity instead. Also check applicable block status, moderation status, expiry and remaining allowance. The server creates a guest identity cookie when needed; the client does not choose its own existing viewer ID. Atomically claim an unclaimed external link on deliberate reveal, never on preview.
4. Establish native capture protection before any clear frame. If the configured protection cannot initialize, keep the native viewer covered and show an actionable state.
5. Fetch/decode under an opaque cover, then reveal only within a valid server lease. On web, show revealed media in a full-viewport overlay with a countdown; keep the blurred card and page position underneath so release returns to the same place (D-18). Stop on release, pointer cancellation, gesture moving outside the target, navigation, loss of focus, interruption, capture response, or timeout. Pause video and audio together.
6. On exhaustion, show “Your viewing time is used up” and never issue fresh entitlement for that identity/post. Native account balance survives reinstall/device changes. The external link stays claimed after exhaustion. Other browsers and cookie resets cannot reclaim it; losing the claiming cookie loses access to the remaining time.

Support pointer hold on desktop web and an accessible keyboard press/release interaction. Choose a screen-reader-accessible timed reveal interaction with the same budget during the prototype. Show a visible countdown without relying on color alone.

### Cumulative allowance protocol

Use server-authoritative time and an atomic ledger keyed by `(viewer_identity_type, viewer_identity_id, post_id)`. Identity type is account or guest. Native direct shares use accounts; anonymous web uses a high-entropy random server-issued cookie (`Secure`, `HttpOnly`, appropriate `SameSite`). A separate atomic link claim binds a token to exactly one identity, with no more than ten seconds allocated through that link. For an account that has already spent time through a direct share, claiming a link does not renew its post balance. Do not trust a client to report “I only looked for two seconds.”

- Use short, idempotent reveal leases with a single active session per identity/post across devices. Link claim and first allocation must be one atomic operation; simultaneous visitors cannot both win. Every lease reserves/debits time atomically before granting access; duplicate requests cannot mint extra time. Browser mutation routes check origin/CSRF protections so another site cannot casually consume a link.
- Prototype roughly one-second lease slices. Prefer conservative charging over allowing the balance to increase after a crash, a lost release event, or a fabricated refund. UI copy says “up to ten seconds”; interrupted slices may be charged.
- Opening the preview is non-consuming. On deliberate hold, reserve/debit the first short slice before permitting clear-media preparation under an opaque cover. A short, expiring preparation state can load/decode without spending the whole remaining allowance; an idempotent activation starts that first slice's fixed deadline. Failed preparation costs at most the first reserved slice. Never send clear media without an allocation. A modified client can still retain prepared bytes; exact visible milliseconds cannot be proven by the server.
- Return the granted duration and deadline; clients use a monotonic local timer for display. Early renewal may reserve the next slice; never continue displaying beyond granted time. Stop if renewal fails. Do not support offline reveal.
- Stop new clear-media delivery when a lease ends; check authorization again on new/range requests. An issued response or buffered media cannot be taken back. Clear visible surfaces, revoke object URLs, stop players, cancel requests, and release temporary buffers as far as the platform permits.
- Keep native budgets while the post and account exist, under the retention policy. Keep guest budgets and claimed-link tombstones through their usable lifetime; cleanup never makes an old claimed token usable again. Re-uploading a deleted photo creates a new post and a new allowance; content deduplication is deferred.

Lease granularity, latency behavior and conservative time charging are acceptance criteria for the first prototype, not assumed solved. If those semantics are confusing or too slow, revisit the user interaction before adding feed/chat.

### Share a post

In-app: after capture/review, the owner selects one or more usernames, creating explicit per-recipient grants and a chat card referencing the original media. Recipients see it blurred in the conversation and Inbox's “Shared with you” list. A first sender appears as an accept/decline request; reveal follows acceptance. Grants belong to the owner/post/recipient and can be revoked for future access. A recipient cannot forward native reveal rights to another account in this version. Sending the same post again does not reset its account allowance.

External link:

1. Owner explicitly enables web sharing and sees the capture limitation.
2. Server creates a cryptographically random capability token, stores its hash, and sets expiry/revocation state.
3. Share an HTTPS URL such as `https://<chosen-domain>/s/<token>`; this is an example route, not a registered domain.
4. Before claim, a recognized installed app can open the native viewer and claim the link as the signed-in account. A chosen account's direct grant is not required for this separate link-based path. Otherwise the browser shows the creator, safe preview, time explanation and “Open in app,” with no sign-in requirement.
5. Link unfurlers, crawlers and GET requests never reveal clear media or consume time. Use a generic social card or blurred thumbnail, `noindex`, and `Referrer-Policy: no-referrer`. These reduce accidental exposure, not malicious access.
6. Link revoke, post delete, moderation takedown, or block prevents subsequent authorizations. State explicitly that already delivered content cannot be recalled.

Forwarding an unclaimed link forwards its capability; an unintended person may claim it first. Recipient-specific access is provided by native direct shares. Block checks take precedence for identified accounts, but cannot reliably stop an anonymous visitor who has a web link.

Single-use state machine: `unclaimed -> claimed -> exhausted`, with expiry/revocation able to end access from either earlier state. The first deliberate hold claims the link and reserves the first slice; claim retries are idempotent. After a failed load, the same claimant may retry remaining time until expiry. Do not automatically release the claim to a different visitor: that would violate the selected one-viewer rule. The owner can explicitly revoke and create a replacement link.

Validate entitlement and post availability before claiming. An exhausted account or the owner's unrestricted preview must not consume an unclaimed link accidentally. Once claimed, the URL token alone is insufficient to resume: require the bound account or guest session. A screenshot or copied token must not impersonate the original claimant.

In this version, a link claimed in a browser continues in that browser. Opening it in the app afterward does not create a second claim or transfer the cookie. Offer “Open in app” before claim; cross-surface transfer after claim can be designed later with an explicit single-use handoff. If the app account separately has a native recipient grant, that is an independent access path, not a second use of the link.

Use iOS Universal Links and Android App Links, including domain association files and release signing configuration. Do not assume every browser automatically opens the app or that installing it preserves a pending link. [iOS links](https://docs.expo.dev/linking/ios-universal-links/), [Android links](https://docs.expo.dev/linking/android-app-links/)

## 6. Architecture and repository layout

| Part | Choice and reason |
| --- | --- |
| Mobile | React Native, Expo, TypeScript and Expo Router; one app codebase with platform-specific capture/lifecycle behavior. |
| Product web app | `apps/web`: Next.js/React product entry, profile/viewer UI and existing server routes for reveal, links and media delivery; local port 3101. |
| Marketing website | `apps/site`: separate Next.js build with landing page, brand motion, privacy notice and bounded waitlist-only proxy; local port 3100. |
| Shared foundation | `@peekalo/design` owns tokens, font and canonical artwork; `@peekalo/web-ui` owns common browser brand/icons, reveal overlay, base CSS and origin validation. |
| Identity/database | Supabase Auth and Postgres; verified native accounts, random guest browser identities, transactional quotas and row-level security. |
| Storage | Private staging and normalized-media buckets; separately generated safe previews with explicit audience rules. |
| Processing | One trusted container worker using image processing and FFmpeg; a Postgres job table initially, with retries and resource/time limits. |
| Realtime | Supabase private channels for notifications of durable chat/comment changes. |
| Hosting | The user selected Render for the combined web/API/Sharp/FFmpeg development container, retaining Supabase. HOST-01 now prepares separate Free Singapore product/API/media and marketing services for testing (22 October); the earlier paid proposal remains deferred. Stable HTTPS deployment and hosted runtime/range-streaming evidence remain pending; a separate durable worker stays future work. |
| Notifications | Generic push notifications after the core chat works; no clear media, sensitive comment text, or message bodies in lock-screen notifications by default. |

Expo development builds allow native libraries/configuration and are the recommended release-development path; use them for privacy verification rather than treating Expo Go as proof of production behavior. [Expo development builds](https://docs.expo.dev/develop/development-builds/introduction/)

Supabase private storage supports authorization and limited-time access, but broad direct read policies would bypass Peekalo's viewing ledger. Clear viewer media should be served through the controlled reveal endpoint; do not grant recipients or guests unrestricted direct storage reads. Standard signed URLs are bearer URLs valid until expiry, not a ten-second deletion mechanism. [Private buckets](https://supabase.com/docs/guides/storage/buckets/fundamentals), [signed URL behavior](https://supabase.com/docs/guides/storage/serving/downloads)

Persist chat messages in Postgres and authorize both reads and writes by membership and block state. Use realtime to signal clients to fetch authorized data, rather than broadcasting complete private message bodies to channels that may remain subscribed after a block. Realtime connection policy changes need explicit handling; channel names alone are not access control. [Realtime authorization](https://supabase.com/docs/guides/realtime/authorization)

Proposed structure after planning is accepted:

```text
apps/mobile/          Expo iOS/Android application
apps/site/            Marketing, privacy notice, waitlist-only proxy
apps/web/             Product entry, profiles, viewer, API/media routes
packages/design/      Shared tokens, font and canonical brand artwork
packages/web-ui/      Common browser UI adapters and origin validation
packages/reveal/      Local reveal allowance controller
packages/contracts/   Shared validation, API types, limits
supabase/migrations/  Schema, RLS, quota/reveal transactions
services/media/       Trusted processing worker
docs/                 Product, privacy, decisions, release evidence
AGENTS.md             Concise project instructions for coding assistants
```

Run `pnpm dev:site` for marketing and `pnpm dev:web` for product; `pnpm build` builds both browser apps. Configure `PUBLIC_SITE_URL` and `PUBLIC_APP_URL` on both servers as distinct public origins; server-rendered cross-app links use those values. Development alone defaults to `http://127.0.0.1:3100` / `http://127.0.0.1:3101`. Missing/invalid production origins never invent a destination. Marketing’s legacy `/s` and `/u` paths redirect to product; product `/privacy` redirects to the site’s notice, with equal-origin configuration rejected to avoid loops. The marketing `/api/waitlist` proxy is its only backend bridge and forwards no private auth/viewer requests or cookies. The product waitlist handler validates the website origin, with its earlier product-origin fallback retained for compatibility. Backend secrets stay on product. The split does not modify ignored environment files, provision hosting or reopen the closed waitlist; HOST-01’s paid provisioning remains deferred.

Share types and business rules, rather than forcing all native and browser UI into identical components. Keep the media gateway close to storage; do not buffer entire videos in serverless memory. The short-video prototype must verify authenticated range requests and deployment limits.

## 7. Data and authorization plan

| Record | Purpose / key invariant |
| --- | --- |
| profiles | Public allowlisted fields; email and private settings stay separate. |
| post_recipients | Owner-created grants and revocation state; native reveal also requires accepted request/conversation state. No implicit follower access. |
| posts | Owner, normalized asset reference, preview reference, status, caption; one asset per post. |
| upload_reservations / media_jobs | Race-safe three-slot cap, processing state, idempotency, cleanup. |
| share_links / link_claims | Post, token hash, expiry/revocation, single claimant identity and remaining link allowance; atomic claim, no reopening after cleanup, no raw tokens in logs. |
| guest_viewers / viewer_budgets / reveal_leases | Account or server-issued guest identity; unique identity/post ledger, at most 10,000 ms entitlement, atomic lease accounting. |
| comments | Post, author, text; audience rules apply even when called outside the app. |
| conversations / members / messages | Sender request/recipient acceptance; membership and block checks for every operation. |
| blocks | Deny rules take precedence over direct shares and messaging for identified accounts; anonymous link holders cannot reliably be recognized. |
| reports / moderation_actions | Restricted reports, queue, decisions, operator audit trail. |
| device_tokens | Owner-scoped push tokens, removed on logout/deletion. |

All exposed tables need explicit row-level security. Server routes using privileged credentials must recheck the same policy; service credentials never ship in mobile/web bundles. Enforce audience/limits in the backend even for features with no web UI. A browser or custom API client must not bypass a rule just because a button is absent.

Media/link endpoints need rate limits, narrow grants, request idempotency and safe error responses. Use TLS, restricted administrative roles, short-lived auth sessions with refresh handling, and native secure credential storage. Keep originals, clear media URLs, tokens, emails and message bodies out of telemetry; disable session replay on protected screens. Avoid storing clear assets in ordinary image/video disk caches; set private/no-store responses and exclude them from service workers.

### Implemented development protocol — LINK-01

The current Node API uses these contracts. This records the implemented development slice; moderation/blocking, rate limits, preparation/activation, durable hosting and remaining device evidence above are still pending.

| Endpoint | Identity and input | Result / rule |
| --- | --- | --- |
| `POST /api/posts` | Verified account bearer; UUID `Idempotency-Key`; multipart captured `file` and `kind` | Private trusted normalization; stable `postId` on retry. Concurrent processing returns `upload_in_progress`. Optional server quota remains explicitly configured until P-01 is resolved. |
| `POST /api/posts/:id/link` | Owner bearer and UUID `Idempotency-Key` | `{url, expiresAt}`; one current link per post. Every request key maps to its original link, including requests that reused an active link. A retry after revocation/expiry returns the old result; a new key is required to create a replacement. Migration 004 backfills stored canonical keys; earlier alias keys were not recorded and cannot be reconstructed. |
| `DELETE /api/posts/:id/link` | Owner bearer | Revokes all links for that post; future authorizations fail. |
| `POST /api/posts/:id/recipients` | Owner bearer; `{username}` | Creates or restores an explicit account grant, returning `{requestState}`. Sending again preserves acceptance and spent time. |
| `DELETE /api/posts/:id/recipients` | Owner bearer; `{username}` | Revokes that recipient's grant. |
| `GET /api/inbox`, `POST /api/inbox/:id/accept` | Recipient bearer | Pending/accepted Inbox entries; only the recipient accepts their own grant. Pending requests cannot reveal. |
| `POST /api/view/preview` | `{token}` | Opaque preview metadata `{kind, available}`; no claim, budget debit, or clear storage path. Page GETs/unfurls do not reveal. |
| `POST /api/view/lease` | `{token, sessionId, requestId}`; account bearer or same-origin signed guest cookie | Atomically claims and prepays a two-second slice, returning `{leaseId, grantedMs, remainingMs, expiresAt, mediaUrl}`. First guest success sets a signed HttpOnly cookie. Owner accounts cannot claim their own links. |
| `POST /api/view/direct` | Accepted recipient bearer; `{postId, sessionId, requestId}` | Same lease response and identity/post budget as account link viewing; no external-link claim. |
| `GET /api/view/media/:leaseId` | Same account or signed guest identity as the lease | Checks active session, post and current grant/link before and after storage I/O. Private/no-store JPEG or bounded MP4 range; no direct storage URL. |

Lease session/request IDs are UUIDs. Repeating a request within the same session and access path returns its original allocation without a second debit; reusing it for a different session, direct grant or link conflicts. All sessions and access paths for an identity/post share 10,000 ms. A session may renew within 750 ms of its deadline; unused prepaid time is charged. Media URLs from earlier slices remain usable only while that same session has an authorized active budget; renewal does not require restarting the video URL. A replay never extends its original response deadline.

Transactions lock the post before its link/grant and budget, matching owner revocation order. They refresh server time after blocking locks and reject links that expired while waiting. Claiming an unavailable post or using an exhausted identity leaves an unclaimed link unchanged. Stored request mappings, claims and budgets are service-only with row-level security; clients cannot call the privileged functions directly.

| API error | Meaning / client action |
| --- | --- |
| `401 sign_in_required` | Refresh/sign in for account access; cookie delivery without a valid guest identity is unavailable. |
| `403 origin_not_allowed` | Browser guest mutation failed same-origin checks. |
| `404 unavailable` | Missing, expired or revoked access, pending grant, wrong owner or mismatched media identity; keep covered. |
| `410 already_claimed` / `410 exhausted` | Another identity owns the link / this identity has spent its allowance; no fresh claim or budget. |
| `409 viewer_busy` / `409 renew_later` | Another session is active / renewal is too early; keep media covered outside the existing deadline. |
| `409 conflict` | The request key was reused with an incompatible operation; do not silently retry as a new allocation. |
| `409 active_limit` / `409 upload_in_progress` | Configured upload slots are occupied / the original upload is still running. |
| `503 sharing_unavailable` | Temporary backend/configuration failure; retain the operation's key for a safe retry. |

`pnpm test:backend` applies the actual migrations to an isolated local PostgreSQL 15 cluster and tests database invariants and lock contention. It needs no Supabase credentials and runs in `pnpm check`/CI. Minimal local `auth`/`storage` schema fixtures are not Supabase Auth, Storage delivery or HTTP verification; the separate `pnpm test:sharing` suite covers the configured development integration.

## 8. Minimum trust and store-release work

Include report post/comment/message/user, block user, content filtering, a small access-controlled moderation screen, published support contact, terms acceptance, and an operator response process. Blur does not exempt uploads or chat from moderation. Apple and Google both impose UGC requirements. [Apple UGC rules](https://developer.apple.com/app-store/review/guidelines/#user-generated-content), [Google UGC rules](https://support.google.com/googleplay/android-developer/answer/9876937?hl=en)

Provide in-app account deletion and the external deletion resource. On deletion/takedown, disable new access promptly and queue storage cleanup. Before launch, document actual removal times, backup retention, reports retained for legitimate reasons, and treatment of messages already delivered to others. Verify the provider's storage/backup behavior; do not promise immediate erasure from all backups. [Apple account deletion](https://developer.apple.com/app-store/review/guidelines/#data-collection-and-storage), [Google deletion](https://support.google.com/googleplay/android-developer/answer/13327111?hl=en)

Choose target countries and age eligibility, finish accurate App Privacy/Data safety disclosures, and check then-current social-app child-safety requirements before public release. Invite-only beta is a way to keep moderation manageable, not a waiver of release obligations. No advertising SDK or invasive analytics is needed initially.

## 9. Development with the available Mac

Read-only checks on 15 October 2026 found Apple silicon (`arm64`), macOS 26.2, and Xcode 26.2 selected. This establishes a useful starting environment, not a successful application build; simulators, Android tooling, signing, disk space and chosen SDK compatibility still need verification.

Start with local iOS Simulator and Android emulator builds. You do not need to own an iPhone to begin. Borrow a device or use a trusted tester for signed physical-device builds; require real iPhone and Android capture/lifecycle testing before release. A simulator cannot establish the privacy claim. Expo documents local simulator/device builds and signing options. [Build documentation](https://docs.expo.dev/develop/development-builds/introduction/)

Pin a compatible stable Expo SDK/native package set when implementation begins. Check that privacy fixes in upstream source actually exist in the installed release. Native layer behavior, repeated protection calls and window changes are specifically worth regression testing. Upstream main is not proof about a released binary. [Expo protection implementation](https://raw.githubusercontent.com/expo/expo/main/packages/expo-screen-capture/ios/SecureWindowCanvas.swift)

## 10. Implementation sequence and estimates

These are rough engineering estimates for one experienced developer working steadily; design iteration, hardware/tester access and store review can change them. Re-estimate after the privacy prototype.

| Phase | Deliverable | Estimated effort | Exit condition |
| --- | --- | --- | --- |
| 0. Resolve rules | Confirm upload/interaction defaults, privacy wording, initial wireframes | 1–2 days | Small written specification is consistent. |
| 1. Prove capture and reveal | Take a photo, record <=10-second video, review/retake, cumulative ledger, web/native viewers, capture/lifecycle tests | 4–6 days | Real-device capture and privacy evidence; acceptable latency/time charging and clear product wording. |
| 2. Accounts and media | Auth, three slots, trusted processing, moderation gate, profiles, revocable links | 1–2 weeks | No clear media accessible outside authorized reveal; race tests pass. |
| 3. Social MVP | Recipient grants, chronological received-post feed, comments, 1:1 text chat/requests, blocking/reporting | 1–2 weeks | Two-account end-to-end flows and permission tests pass. |
| 4. Beta and release | Deletion, operational pages, moderation workflow, release builds, device QA, store submissions | 1–2 weeks plus external waits | Release checklist and distribution requirements satisfied. |

Budget approximately 5–8 development weeks for a credible small beta; this is not a fixed quote or a promised public launch date. Android and iOS can share most feature development while retaining separate device verification.

New Google Play personal developer accounts subject to the current rule need at least 12 opted-in closed testers for 14 continuous days before applying for production access; passing that test does not automatically grant approval. Plan recruitment early. [Play testing requirements](https://support.google.com/googleplay/android-developer/answer/14151465?hl=en)

## 11. Cost plan

Verified reference prices as of 15 October 2026: Apple Developer Program US$99/year, subject to regional pricing; Google Play registration US$25 once; Supabase Pro starts at US$25/month with usage/compute considerations. These are separate from hosting, encoding, email, build services, taxes and development work. [Apple enrollment](https://developer.apple.com/programs/enroll/), [Play registration](https://support.google.com/googleplay/android-developer/answer/6112435?hl=en), [Supabase pricing](https://supabase.com/pricing)

For a small low-traffic beta, provisionally allow US$50–150/month for backend, worker, web hosting, email and monitoring, plus a domain and store memberships. This is our planning allowance, not a vendor quote or spending cap. Free tiers may cover the earliest prototype. Do not buy services until their role and limits are clear.

Track processed storage, video transcoding, media egress, email verification volume, and reveal lease requests. A three-post cap bounds posts per account, not total users or repeated bandwidth. Proxying clear media can add hosting bandwidth costs, so test it before choosing plans. Alerts should precede material spending growth.

## 12. Agents and skills

Peekalo does not require an AI agent or AI API for its core features. Normal application code, transactions, deterministic access checks and a background media worker are sufficient. Moderation can use an independently chosen filtering service later without making the app an agent system.

For development, use the repository's `AGENTS.md`, build board, decision log, this product plan, the backlog, and focused tests. `AGENTS.md` supplies durable project guidance; skills package reusable workflows. [OpenAI project instructions](https://learn.chatgpt.com/docs/agent-configuration/agents-md), [OpenAI skills documentation](https://learn.chatgpt.com/docs/build-skills)

Suggested project rules when implementation starts: no clear media in feeds/previews; every reveal goes through the ledger; server-side upload/duration caps; no privileged client credentials; changes to privacy behavior require relevant device and authorization checks.

Use temporary specialist coding/review agents for mobile capture, backend permissions, and web accessibility when tasks can run independently. A human-readable API contract and shared acceptance criteria are more useful than building a permanent agent platform.

Do not create custom skills yet. Once the workflows are proven and repeated, candidates are a Peekalo privacy regression workflow and a store-release workflow. Keep changing product requirements in product docs rather than hiding them in a skill. No new skills, accounts, subscriptions, or integrations were created during this planning work.

## 13. Decisions still needing a product answer

1. Does “maximum three” mean three active posts per user as proposed, three lifetime uploads, or three files in one post?
2. Confirm the proposed first-sender request flow. Navigation is confirmed: Inbox left, prominent Camera center opening the in-app camera, Profile right. Capture-only sharing, chosen-account native recipients and anonymous globally single-use links are confirmed.
3. Accept conservative charging of short interrupted reveal slices? Prototype should make the effect understandable before finalizing it.
4. What launch countries and age group are intended? The proposed adult invited beta is only a planning default.

The first implementation milestone should capture one photo and one short video inside the app, then share them to an account or through a single-use link and verify cumulative reveal behavior on Android, iOS and web. Complete that evidence before investing in media-list polish or chat.
