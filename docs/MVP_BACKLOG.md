# Peekalo MVP implementation backlog

Prepared 15 October 2026. Feature checklist; unchecked items remain unfinished even when part of a shell exists. Product rules and sources live in [the plan](PEEKALO_PLAN.md); execution order and actual verification live in [the build board](BUILD_BOARD.md). The mobile/web foundation is complete with iOS simulator and physical Android startup verified. Local photo/video shutter, review, Retake and Discard are implemented. The user confirms matching preview/photo framing and hold/release video recording with playback on Samsung; earlier photo capture and Retake are also confirmed. Duration, audio, lifecycle/permission, front-camera and physical iOS evidence remain pending. A local prototype does not complete the server/security/device checks below.

## Milestone 1: prove the central behavior

- [x] WEB-SPLIT-01: D-23 separate marketing website (`apps/site`, port 3100) and product web app/API (`apps/web`, port 3101), shared `@peekalo/design`/`@peekalo/web-ui`, configured cross-app links and compatible redirects. Locked install, workspace checks, both production builds/native JS exports, origin/proxy regression and production browser/HTTP checks pass. Both Linux ARM64 standalone container build/smoke checks pass; hosted CI/AMD64 and Free public-preview evidence are now recorded under HOST-01 on the build board. Keep origins configured on both servers, waitlist closed and paid hosting deferred.
- [x] BRAND-01: D-22 canonical logo artwork across native/web, including full wordmark, camera/account/footer/reveal, and common launcher/favicon mark. Generated-asset checks, lint/types, exports/build, production browser and running iOS simulator checks pass. Native launcher binary rollout and physical-device/live-camera contrast remain pending separately.
- [x] FND-02: apply the D-21 shared dark/lime design foundation through `@peekalo/design` to native Inbox/Profile/account/sample surfaces and the web homepage/profile/viewer. Workspace checks, native exports, web builds, production browser layouts and rebuilt iOS simulator screens pass. Modal safe-area correction also passes mobile lint/types and visual checking. Physical-device appearance and live native account/sharing checks remain pending separately on the board.
- [ ] HOST-01: Free Singapore product/API and marketing services are live; full GitHub checks and both AMD64 container builds/Free smoke profiles pass on `354ef22`. Native ignored origin now targets the hosted API. Physical native connectivity/sharing and actual Render HTTP health-check/shutdown settings remain pending; paid hosting stays deferred.
- [x] HOST-02: 71 hosted sharing assertions pass, including generated photo/video delivery and strict revocation during a valid grant. Sanitized latency is recorded on the build board; authorization, two-second slices and ten-second totals are unchanged. Client-visible viewing time and realistic maximum/concurrent-video capacity remain separate evidence.
- [x] Bound upload admission before body buffering, cap/read deadline and upstream timeout, recover expired uploading reservations with attempt-fenced transitions/Storage paths. New migration is deployed; upload/SQL/HTTP regressions and hosted fixtures pass. Distributed abuse controls and orphan maintenance remain future work.
- [ ] APP-TEST-01: isolated local email signup/confirmation/login/username/sign-out (ten assertions) and local sharing (71 assertions) pass. Hosted Google testing is configured and routes to the expected client/callback. Android APK build/install, USB reverse connections and native startup pass on Samsung; native local signup/confirmation/login/username now pass with user and backend evidence. Native photo capture/upload/link creation pass with user and private-storage evidence; Android Chrome photo reveal and local direct-photo recipient delivery/acceptance/reveal/hide/exhaustion also pass on the physical Samsung (two isolated app accounts, one device). Direct native video upload/recipient acceptance, playback with sound, release/hide/resume and 10,000 ms exhaustion also pass on the same Samsung. The automatic recording stop around ten seconds is user-confirmed. Native password recovery also passes on the Samsung: request, captured email/callback, user password update, old-password denial, new-password login and replay rejection without replacing the normal login. Hosted Google browser sign-in, native callback and signed-in profile loading now pass on Samsung. Google cancellation left the app signed out, and a subsequent retry succeeded on the same device. Release cold-link, exact duration, interruption and physical iOS tests remain pending. Public signup SMTP/domain remains pending.
- [x] Implement PHOTO-01 local fixture reveal on mobile/web: hold/release/cancel, cumulative ten-second allowance, countdown/exhaustion, keyboard and one-second accessible alternative. Runtime-only demo; server/device criteria below remain separate.

- [ ] Interpret the three-upload limit. Anonymous globally single-use links and chosen-account native sharing are confirmed.
- [ ] Set up Expo development builds and the restricted web viewer using sample media.
- [ ] Complete physical verification of default Camera, tap-to-photo and hold/release video with automatic stop at ten seconds. Samsung photo framing and video recording/playback are user-confirmed; exact duration, audio and physical iOS checks remain pending.
- [x] Implement local photo/video capture, review, Retake/Discard and app-cache drafts. Tap takes a photo; a 300 ms hold starts video, release stops it, and native `maxDuration` plus a JavaScript fallback stop at ten seconds. Video review has play/pause.
- [x] Implement first-use microphone permission on hold, followed by a new hold to record after permission is granted. Denial/recovery still needs physical verification.
- [x] Implement consistent centered portrait 9:16 preview/review framing and photo cropping, with dark extra space on taller screens. Fixed top logo and center navigation button remain.
- [x] Pass 31 local tests: ten photo-session, fourteen video-session and seven framing tests; mobile lint and TypeScript pass. This is local implementation evidence.
- [ ] Complete photo/video Retake/Discard, front-camera and lifecycle verification on physical Android and iOS, including leaving the screen or backgrounding during preparation, capture, recording and review; stale results must not reopen review. Confirm best-effort cache cleanup and document failures without claiming byte erasure.
- [ ] Complete consistent 9:16 framing and fixed-logo verification on physical devices (Samsung preview/photo framing confirmed); use difference blend only where reliable, with a readable fallback. Physical iOS evidence remains pending.
- [ ] Bottom navigation: Inbox left, prominent Camera button in the center, Profile right; tapping Camera opens the in-app camera.
- [ ] Allow sharing only from in-app captures; no gallery, photo-library or file import actions or permissions.
- [ ] Review/retake/discard capture, then select recipient accounts or create a single-use link. Photo/video review actions are implemented locally; real recipient/link actions remain planned.
- [ ] Handle camera/microphone denial and recording interruptions; do not send partial captures or auto-save to the photo library.
- [x] Implement a server ledger per account-or-guest identity/post with a 10,000 ms maximum allowance. All four migrations are deployed to the dedicated development project; the disposable PostgreSQL suite and 64 live HTTP/Auth/Storage assertions pass under SUPABASE-01.
- [x] Prototype atomic, idempotent leases and conservative accounting across holds/devices. PostgreSQL tests cover single-winner claims, access-path retry scope, competing sessions, exhaustion and revoke/expiry lock races; physical-device behavior remains separate.
- [ ] Test press, hold, release, cancellation, expiry, keyboard/screen-reader interaction and visible countdown.
- [ ] Test a photo and a <=10-second video; stop both video and audio when hidden.
- [ ] Verify clear media never appears before protection and authorization are ready.
- [ ] Measure first-load overhead and latency; choose lease granularity and wording.
- [ ] Verify Android OS screenshot/recording behavior on a physical device. On Samsung / Android 17, the received-moment window has FLAG_SECURE and the user confirmed the hardware screenshot shortcut was blocked while hidden. The user also confirmed black/blocked Samsung screen recording of the same hidden screen. Revealed-state, Recent apps and interruption checks remain pending.
- [ ] Verify the selected Expo/iOS package on a physical iPhone in a release build.
- [ ] Record limitations and product wording; web is capturable after reveal.

Acceptance examples:

| Scenario | Required result |
| --- | --- |
| Tap the shutter | Capture a photo and review the same centered 9:16 composition shown in preview. |
| Hold the shutter for 300 ms, then release | Record video while held, stop on release and open local video review with play/pause. |
| First video hold needs microphone permission | Request access, then require a new hold to record; never begin recording after the original gesture ends. |
| Hold the shutter beyond ten seconds | Native duration cap and JavaScript fallback stop recording; verify actual file duration on device. |
| Navigate away or background during photo capture or video preparation/recording | Stop/cancel recording, do not reopen review with a late result and attempt temporary-file cleanup. |
| Retake/discard a local photo or video | Clear the draft and attempt app-cache file deletion; do not save to the photo library. |
| Hold for about 2 seconds, release, hold again | Continue from the authoritative remaining allowance; no new 10-second grant. |
| Hold a web card, then release | Show media in a full-viewport overlay while revealed; return to the same blurred card and scroll position on release, retaining the remaining allowance. |
| Reload/reinstall/open another device in the app | Same account/post balance. |
| Reload guest web viewer | Same guest/post balance while the cookie persists. |
| Clear cookies / use another browser | Cannot reclaim the used link; original guest loses resumption if its cookie is lost. |
| Two visitors hold an unclaimed link simultaneously | One atomic claim succeeds; the other visitor is denied. |
| Open in app after guest web claim | Cannot reclaim/transfer that link in v1; separately granted native access remains separate. |
| Two devices reveal simultaneously | One active session; total granted time cannot exceed 10,000 ms. |
| Retry the same lease request | Same result; no duplicate charge or grant. |
| Lose network, kill app, or miss release | Cover at lease expiry; no automatic refund that mints extra time. |
| Clock changes | Local wall-clock changes do not extend the reveal. |
| GET link / social unfurl | Safe preview only; no budget consumed. |
| Exhausted budget through a second share link | Still exhausted for that account/post. |
| Malicious viewer saves already received bytes | Documented platform limitation; never presented as prevented by the timer. |

## Milestone 2: private upload and sharing

Development implementation includes authenticated private upload/normalization, protected links, accepted recipient grants, a transactional cumulative ledger and owner revocation. SUPABASE-01 applies all four migrations and passes 64 live backend assertions with generated fixtures through the local production gateway. Unchecked end-to-end/beta criteria below still require their full acceptance evidence; general signup email and physical native sharing remain pending; HOST-02 now passes 71 hosted assertions.

- [ ] Native email verification, recovery and username/profile; server-issued anonymous web cookie, no guest login requirement.
- [ ] Reserve upload slots atomically; enforce the selected three-item policy.
- [ ] Native camera capture only, private staging upload of those captures and safe progress/retry states; no gallery, photo-library or file imports.
- [ ] Trusted type/size/dimensions/duration checks and resource-limited processing.
- [ ] Normalized media, metadata removal, separate heavily blurred preview/poster.
- [ ] Failed-job cleanup, retry idempotency, moderation-before-publish state.
- [ ] Capture-to-share progress: recipient delivery or usable link only after processing/moderation succeeds.
- [ ] Private clear-media delivery; no unrestricted recipient/guest read policy on storage.
- [ ] Explicit owner-created post-recipient grants; no native forwarding of reveal rights.
- [ ] Expiring/revocable hashed share tokens, atomic single-viewer claims and explicit web-sharing disclosure.
- [ ] Claimed/exhausted/expired/revoked state handling; retries cannot reopen a consumed link.
- [ ] Universal Links / App Links on an actual domain with release association files.
- [ ] No clear media in public HTML, social cards, thumbnails, logs or notifications.

Meaningful backend/security checks:

- [x] Run actual migrations and populated request-key backfill in disposable local PostgreSQL without remote credentials; include claims, grants, budgets, configured quota, permissions and deterministic lock-contention regressions in `pnpm check`.
- [x] Verify canonical and alias link-creation request keys keep their original revoked result after replacement; a retry cannot mint a fresh claim. Historical alias keys preceding migration 004 were never stored.
- [ ] Two simultaneous uploads cannot create a fourth reserved/published post.
- [ ] A forged MIME type or over-ten-second video is rejected server-side.
- [ ] Guessing post IDs or storage paths cannot reveal media.
- [ ] User A cannot read User B's private settings, budgets or messages.
- [ ] New media/range requests fail after lease expiry, link revocation or takedown.
- [ ] Revocation does not claim to erase bytes already delivered.
- [ ] Owner previews are scoped to the owner; client-supplied IDs cannot grant exemption.
- [ ] Pending or declined direct-share requests cannot reveal via API, even when a recipient grant row already exists.
- [ ] Replacing clear media cannot silently reuse the old post's identity/ledger.

## Milestone 3: minimal social features

- [ ] Username lookup, chosen-recipient sharing and chronological “Shared with you” list in Inbox.
- [ ] Profile with maximum three active blurred media cards.
- [ ] Flat comments; author deletion, post-owner removal, reports and rate limits.
- [ ] 1:1 conversations with first-sender accept/decline, text messages and owner-sent existing-post references.
- [ ] Durable storage, private realtime update signals and authorized data fetches.
- [ ] No chat attachment path that bypasses the media/post policy.
- [ ] Block enforcement for identified accounts across feed, direct reveals, comments, chat and existing realtime sessions; state anonymous-link limitation.
- [ ] Generic push notifications only after core chat works.
- [ ] Empty, loading, processing, failed, expired, revoked and exhausted states.

## Milestone 4: beta and release

- [ ] MKT-01: publish the prelaunch marketing site after review. Dark landing page, original ten-second cinematic hero, labelled local reveal demo, privacy notice and consent-based waitlist integration are implemented locally in the separate `apps/site` website (D-23); profiles/private viewing remain in `apps/web`. The original marketing work was implemented on 20 October; MKT-02 records that motion evidence. Apply the new waitlist migration, verify a real Supabase HTTP insert/duplicate, connect a working private contact/removal route using branded email after domain choice, update the notice and enable collection only after those checks. Free public hosting is live under HOST-01 with collection closed; remaining signup/contact/storage work still blocks waitlist launch.

- [ ] Filtering/moderation queue, restricted operator access and published contact.
- [ ] Report post/comment/message/user; responses and takedowns actually work.
- [ ] Terms acceptance, privacy/terms/support pages, age and country decisions.
- [ ] In-app deletion and external deletion request route; cleanup and retention policy.
- [ ] App Privacy/Data safety disclosures match the app and installed SDKs.
- [ ] Check current social-app child-safety and store requirements for the selected audience.
- [ ] Physical-device tests: recording started before reveal and during it, mirroring/sharing, screenshot shortcuts, interruptions, Control Center, app switcher, orientation, navigation and repeated mounts.
- [ ] Camera/microphone permission-denied tests; no photo-library access requested for the capture-only sharing flow.
- [ ] Clear-media cache/storage checks, telemetry redaction, no protected-screen session replay.
- [ ] Separate staging/production, migration rollback, backup/restore and failed-worker recovery.
- [ ] Alerts for crashes, worker failures, abnormal link traffic and spending.
- [ ] Signed release builds and reviewer/test accounts with non-sensitive sample media.
- [ ] TestFlight / Play test tracks; recruit Play closed testers if applicable.
- [ ] Recheck privacy mitigations after native SDK updates and before each release.

## Deferred work

Followers, group chat, calls, chat media attachments, Stories/Reels, algorithmic discovery, likes/bookmarks, editing/filter tools, video trimming editor, payments, DRM, E2EE, recipient-restricted external links, post-claim browser/app handoff, watermarking, human identity verification, full web social features, and custom development skills.
