# Peekalo build board

Updated 17 October 2026. This is the main entry point for development status.

**Current stage:** The Peekalo Supabase development project is configured and verified. All four migrations, including claim/lease hardening, are deployed. **64 live HTTP/Auth/Storage assertions pass** with generated photo/video fixtures, alongside 22 local PostgreSQL regression cases. Email verification is enabled and capture storage is private. The verified API gateway ran locally on this Mac; public hosting, general signup email delivery and remaining native capture/privacy evidence are pending.

**Next task — HOST-01 deployment (deferred by user):** Render is selected for the combined web/API/media container, retaining Supabase. Reviewed application source is published on `codex/hosting-runtime`; GitHub's workspace and native Linux AMD64 container jobs both pass. The user approved the proposed single Singapore service and then requested leaving provisioning pending. No Peekalo Render service exists, and the mobile API URL is unchanged. Resume paid provisioning only when the user asks to continue; then verify the assigned stable HTTPS origin before changing native configuration. General signup SMTP and remaining PHOTO-01/PHOTO-02/native sharing/privacy checks stay pending. LINK-01's implemented API/error contract is recorded in the plan.

**NAV-01 implemented and simulator-verified:** Inbox / Camera / Profile, with a prominent lime center Camera button. Pressing it opens a dedicated camera screen; physical devices use the existing permission-gated preview, and the simulator shows an explicit camera-unavailable state. Camera preview and review now share a fixed 9:16 portrait frame behind controls, with the logo fixed at the screen top (D-14/D-16). Taller screens use dark space outside the frame. Capture-only sharing is confirmed in D-13; no gallery/library/file importer is present. Local photo/video shutter/review and development backend sharing are implemented; SHARE-01 below records backend evidence and remaining device checks.

Navigation refinement: lowered the bar's visible top edge and side tabs so the unchanged 62-point Camera button overlaps the bar. Visually checked in the running iOS simulator; mobile lint/TypeScript pass.

## How we work in this chat

- Keep this chat as the place for product decisions, progress and integration. Repository files retain the plan across chats and sessions.
- Complete one small, testable deliverable at a time. Parallel agents can handle independent code or reviews; their output is checked before integration.
- Give each task a stable ID. Report what changed, what was verified, what remains uncertain, and the next task.
- Keep the full feature inventory in [MVP_BACKLOG.md](MVP_BACKLOG.md), durable decisions in [DECISIONS.md](DECISIONS.md), and detailed reasoning in [PEEKALO_PLAN.md](PEEKALO_PLAN.md).
- A runnable local demo is useful evidence about interaction. Real authorization and device privacy require their own checks.

## Build order

| Stage | Deliverable | Status | Completion evidence |
| --- | --- | --- | --- |
| 0. Organize | Plan, board, decisions and project instructions | Complete | Files exist and guide the implementation. |
| 1A. Foundation | Expo mobile shell, Next.js web shell, shared TypeScript contracts | Complete — FND-01 | Locked install, lint, TypeScript, web build, mobile JS exports and browser preview pass. Debug native binary built and Camera screen loaded on iPhone 17 Pro / iOS 26.2 simulator. |
| 1B. One photo | Capture/review/retake and local blurred recipient-view interaction | Local capture/reveal implemented — PHOTO-01/02 | Android user confirms capture/Retake; browser and iOS simulator local reveal/countdown/exhaustion verified. Physical lifecycle/iOS capture evidence remains pending. |
| 1C. Real sharing | Private photo delivery, account recipients, global single-use link and server allowance | Supabase development integration verified — SUPABASE-01 | Four migrations deployed; 64 real HTTP/Auth/Storage assertions and 22 PostgreSQL regression cases pass. Durable API hosting, signup SMTP and physical native integration remain pending. |
| 1D. Short video/privacy | <=10-second capture, video/audio reveal and native protection | Local recording implemented — VIDEO-CAPTURE-01 | Samsung hold/release recording and playback user-confirmed. Physical duration/audio/lifecycle checks, recipient reveal and native protection remain pending. |
| 2. Media/accounts | Complete sign-in, three-item quota, processing, profiles and link management | Planned | Full upload/permission/quota tests and failure recovery. |
| 3. Social | Text chat, comments, Inbox and reporting/blocking | Planned | Two-account flows, request acceptance, authorization and realtime/block checks. |
| 4. Beta | Moderation, deletion, release builds and store/device testing | Planned | Release checklist and beta evidence. |

Stages 1C and 1D use the minimum account/media backend needed to prove the core flow. Stage 2 completes and hardens those paths; it does not postpone authentication or private delivery until after public sharing.

## First development task: FND-01

**Outcome:** Peekalo launches on the iOS simulator and its web viewer shell opens in a browser from this repository.

Implementation sequence:

1. Select and pin compatible supported Node/Expo/Next.js/package versions; record the chosen package manager and lockfile.
2. Create a small pnpm workspace with `apps/mobile`, `apps/web` and only the shared contracts needed now in `packages/contracts`.
3. Mobile: Camera / Inbox / Profile navigation and clear empty/loading/permission states. Scaffold camera access for the next photo task; no pretend recipient delivery.
4. Web: minimal profile and shared-viewer shells using non-sensitive fixtures. Label fixture viewing as a demo; do not issue fake usable share links.
5. Add reproducible startup, lint, typecheck and applicable build/check commands to the README.
6. Run those checks, launch the iOS simulator and web page, and record the result here. Note any startup, simulator or SDK problem instead of assuming tool installation proves success.

Acceptance criteria:

- [x] Fresh dependency install is reproducible from the lockfile.
- [x] Available lint/typecheck/build checks pass for the new foundation.
- [x] Native app starts in an iOS simulator; web shell loads in a browser.
- [x] Fixture assets are non-sensitive opaque illustrations; no clear originals sit beneath blur effects.
- [x] No public media storage, working share claims, real send behavior or capture guarantees are implied by shell screens.
- [x] README commands and this board reflect the actual implementation and validation.

Both startup checks pass. Simulator evidence does not verify physical camera or capture/privacy behavior.

## Immediately after foundation

| ID | Task | Depends on |
| --- | --- | --- |
| PHOTO-01 | Fixture image, separate blurred card, hold/release/cancel and cumulative local allowance; explicitly local demo | Implemented; browser and iOS simulator verified, physical checks below |
| PHOTO-02 | Native photo capture, review/retake/discard, interruption and permission handling | FND-01; physical device for capture evidence |
| LINK-01 | Define minimal recipient/claim/reveal contract and error states | PHOTO-01 |
| LINK-02 | Server identity, private photo storage/delivery, atomic single-viewer claim and cumulative ledger | LINK-01; configured development backend |
| LINK-03 | Integrate anonymous browser claim and native selected-recipient access | LINK-02, PHOTO-02 |
| VIDEO-CAPTURE-01 | Hold-to-record local video, release/ten-second stop, review/retake and matching 9:16 photo framing | Implemented; Samsung recording/playback/framing user-confirmed |
| VIDEO-01 | Processing and video/audio reveal under the same allowance | Verified photo sharing; VIDEO-CAPTURE-01 |
| PRIVACY-01 | Native protection and lifecycle checks using the chosen release packages | Native viewer; physical iPhone and Android device |

PHOTO-01 does not close LINK or PRIVACY tasks. Sample media lets interaction work continue while device access is arranged. Add video before declaring the overall reveal/privacy prototype complete.

## Verified environment and upcoming dependencies

Environment and implementation on 15 October 2026:

- Node 24.14.1 and pnpm 11.25.0 are pinned. Expo 55.0.31 / React Native 0.83.10 and Next.js 16.4.1 use React 19.2.0 with clean peer resolution.
- Xcode 26.2 and iOS 18.3.1/26.2 simulator runtimes/devices are available. CocoaPods 1.17.0 installed locally in ignored cache; Pods install succeeds. Peekalo's Camera screen loads on the iPhone 17 Pro / iOS 26.2 simulator.
- Android SDK command-line tools 22.0, platform-tools 37.0.1 (`adb` 1.0.41), SDK platform 36, build-tools 36.0.0, NDK 27.1.12297006 and CMake 3.22.1 are installed. Temurin Java 17.0.20.1 runs the generated Gradle 9.0.0 wrapper. Full Android Studio/emulator are not installed; physical USB testing uses the command-line tools.
- Backend work uses `codex/backend-ledger` in the existing checkout, branched from `codex/capture-share`. Earlier local reveal/capture/sharing changes are preserved; changes remain local and uncommitted.

**Native build history:** the original attempt failed with roughly 100 MiB free on the internal volume. The successful retry had over 5 GiB free. Build caches remain on the external drive; Apple tooling still needs internal space. Expo's generated bundle and Constants scripts also required path-quoting fixes for “Mac External”; a local config plugin preserves those fixes across prebuild/Pods installation. The source-build setting avoids React Native's prebuilt file-URI bug for the same spaced checkout path. The first source build is slow; completed objects are cached.

Future dependencies do not block foundation work:

- Remaining Android capture lifecycle/permission checks and native privacy testing on the connected phone.
- Borrowed iPhone or tester for physical iOS camera and capture-protection evidence.
- Development Supabase project and ignored server/mobile environment configuration are present and verified under SUPABASE-01. Never paste secrets into chat or source files.
- A domain and signing associations before testing real Universal/App Links; store memberships are needed later for distribution.

## Open product decisions

See [DECISIONS.md](DECISIONS.md). Use the explicitly provisional three-active-items default for early UI; settle its meaning before enforcing upload quotas. Launch countries/age policy can be resolved before beta. Neither requires blocking local shell development.

## Latest verification

### AUTH-01: Google sign-in — 17 October (implemented; provider setup pending)

- The share/account panel has **Continue with Google** above the email form. It uses Supabase OAuth with PKCE through `expo-web-browser@55.0.20`, redirecting to `peekalo://auth-callback`; `src/app/+native-intent.tsx` stops Expo Router from opening that redirect as a screen, so the capture being shared is kept. New Google accounts continue to the existing username step.
- Before opening Google, the app reads the project's public auth settings and shows “Google sign-in is not set up yet” when the provider is off. As of this entry the hosted project reports `google: false`; a Google Cloud OAuth client and the Supabase provider/redirect settings in the README are still required. Mobile lint and TypeScript pass. The Android debug app was rebuilt for the new native module; actual Google sign-in on the phone is unverified until the provider is configured.

- Profile is now account-aware instead of a fixed demo identity: it shows the signed-in `@username` and email, a sign-in/create-account entry (with Google), a choose-username prompt and a retry state, and opens the same account panel for sign-out. The fixture is kept under a labelled “Try a sample” section. The Samsung UI hierarchy showed the real signed-in username and email after a Metro refresh. Listing a person's own shared moments needs a new owner endpoint and is not built.

### Android local test startup — 17 October

- The connected Samsung initially ran a stale development binary that failed with `Cannot find native module 'ExpoCrypto'`. Rebuilt and reinstalled Android Debug successfully; mobile lint and TypeScript pass. Relaunched through the `exp+peekalo` development-client scheme with Metro on USB-forwarded port 8081. The device UI hierarchy now contains Camera, Inbox and Profile, with no missing-module error in the fresh Metro session. No camera frames or private captures were saved.
- Web/API and Metro are running for this local test with process-only loopback URL overrides and USB forwarding for ports 3000/8081; ignored URL files remain unchanged. `/api/health` returns `{ready:true}` and `/s/demo` returns HTTP 200. Physical capture, account sign-in/upload and actual shared-link reveal in this session still require user testing; no public hosting was provisioned.
- Later the same day, Share moment showed “Cannot reach Peekalo” after a Mac restart: the API server, Metro and the earlier quick tunnel had stopped. A dev-only log showed the bundle still called the dead tunnel host because Expo loads `apps/mobile/.env.local` over a process `EXPO_PUBLIC_API_URL` override. Started a new Cloudflare quick tunnel and the production web/API server on `127.0.0.1:3000`, pointed both ignored `.env.local` URL files at that tunnel, and restarted Metro with a cleared cache. The share panel on the Samsung now passes the connection step and shows account sign-in. The live sharing suite passed all 64 assertions through the new tunnel. Quick-tunnel URLs change on every restart, so links created now break when it stops, and both env files must be updated again. The user then confirmed on the Samsung that sign-in and Create & share link work. Recipient send, the link's reveal on another device and video sharing were not separately reported.

### HOST-01: Render deployment preparation — 17 October

- User confirmed Render as the provider, connected its Codex integration and explicitly approved **My Workspace** for one `peekalo-dev` Singapore service, 1 CPU / 2 GB, US$25/month plus applicable tax/usage, with automatic deployments off and the existing server credentials. Provisioning was not completed, and the user then explicitly requested leaving deployment pending. No Peekalo service, database, disk or subscription was created; existing unrelated Render services were preserved. Do not resume paid provisioning without a user request to continue.
- GitHub `pascalpong/peekalo` is public and initially contained only the README on `main`. The required application/workspace source is committed as `5d9098f` and pushed to `codex/hosting-runtime`; `main` remains unchanged. Independent review of all 110 published paths found no secret literals, private media or device identifiers; a separate scan compared publishable bytes with the actual ignored server secrets and passed. Environment files, native projects, caches and generated exports remain ignored. The only PNGs are the icon and documented non-sensitive illustration fixtures.
- Full `pnpm check` passes workspace lint/TypeScript, 31 mobile lifecycle/framing tests, 12 reveal tests, all 22 PostgreSQL regression cases (23 tests including the enclosing test), five hosting tests, Next.js production build and iOS/Android JavaScript exports. This does not replace physical-device evidence.
- Linux AMD64 build and container smoke pass under local emulation, including Sharp/FFmpeg preflight, fail-closed startup/readiness, pages/chunks/fixtures, non-root execution and absent environment files. The smoke explicitly requests the image's platform so Docker's emulation warning cannot mask the expected sanitized startup error. Targeted script lint passes after that change.
- **Hosted GitHub CI passes** for source commit `5d9098f`: both `check` (locked install and full `pnpm check`) and `container` (native Linux AMD64 Docker build/smoke) succeed in [run 39006681134](https://github.com/pascalpong/peekalo/actions/runs/39006681134). This closes native AMD64 packaging/CI evidence, not Render network performance or physical-device behavior.
- Stable Render HTTPS/health, public photo/video/lease integration, and native API cutover remain pending. Retain existing Supabase/server signing secrets when provisioning resumes. Native API configuration stays unchanged until the actual HTTPS origin passes checks. GitHub's connected integration denied draft-PR creation with HTTP 403, so the published branch has no PR; this does not prevent deploying that explicit branch later.

### HOST-01: portable hosting runtime — 17 October (local verification complete; public deployment pending)

- Work is isolated on `codex/hosting-runtime` in the existing checkout; prior local/uncommitted integration changes are preserved.
- Added a multistage, non-root Node 24.14.1 Docker runtime with Sharp, FFmpeg/FFprobe, H.264/AAC and Next.js standalone output. Explicit build-context inputs exclude environment files, native output and caches. Startup validates configuration, tools, a generated JPEG and private writable temporary storage; failures emit a fixed message without configuration values.
- Added no-store `/api/health` returning only `{ready}` and HTTP 200/503. It checks deployed request mappings and private 30 MiB capture storage using a four-second upstream deadline. This does not prove the full authorization/media path, signup delivery or devices.
- Proposed `render.yaml`: Singapore, one 1 CPU / 2 GB container, manual deploys and a 120-second shutdown allowance. No service, subscription, public deployment, domain or new secret was created. README records runtime secrets, stable-origin cutover/rollback and operational constraints.
- Five startup configuration/sanitized-failure tests, scripts ESLint and web lint/TypeScript pass. The final Linux ARM64 image builds from locked dependencies without backend secrets. The initial smoke test caught a missing standard Sharp alias in Next.js standalone output; the Dockerfile explicitly preserves the alias for preflight, and the final smoke passes.
- Standalone Node runtime on this Mac: `/api/health` returns HTTP 200 and `{ready:true}` for the configured hosted ledger/private bucket; a separate process with synthetic credentials and an unreachable backend returns HTTP 503 and only `{ready:false}`. Both are no-store; `/s/demo` returns HTTP 200. Test processes were stopped. This is macOS HTTP evidence, not the interrupted Linux container smoke.
- **Validation interruption recovered:** the rebuild filled the Mac's internal disk (117 MiB free observed) and Docker stopped with a metadata I/O error. The user approved relocating its disk to Mac External. The built-in migration stalled; an offline sparse copy verified all 228.3 GiB of logical contents byte for byte and confirmed the original stayed unchanged. Docker now runs from `/Volumes/Mac External/Developer/Docker/DockerDesktop`, with all 28 existing containers and 86 volumes present. The old internal copy was removed only after successful startup/path/resource verification; 23 GiB internal free space was then observed. Prior Docker settings are backed up beside the new data directory. The external drive must stay connected for Docker. Supabase and repository data were not altered by the disk failure or move.
- Final container smoke passes fail-closed startup without settings, real Sharp/FFmpeg/FFprobe preflight, HTTP 503/no-store readiness with unreachable backend, standalone page/JavaScript/public fixture delivery, non-root execution and absence of environment files in the image. The smoke uses synthetic credentials and a 2 GiB / 1 CPU limit with 256 MiB ephemeral scratch.
- **64 live HTTP/Auth/Storage assertions pass through the Linux container** at loopback `http://127.0.0.1:4001`, under the same resource limits, using only generated photo/video fixtures. Configured container health returns HTTP 200. Cleanup independently verifies all seven application tables empty, no Storage root entries and no temporary test accounts; the test gateway was stopped. This proves the portable runtime against hosted Supabase, not public hosting, capacity benchmarks, Linux AMD64 or native devices.
- CI adds a separate Linux container build/smoke job; no hosted run has occurred. Startup tests join `pnpm check`; no new full `pnpm check` run has completed for HOST-01.
- Runtime review also identified pre-buffer upload admission/read deadlines and stale-upload recovery after process crashes as follow-up work before inviting users. General endpoint rate limits, durable job processing, signup SMTP and all pending native evidence remain open.

### SUPABASE-01: hosted development database and live verification — 17 October

- Reused the existing, linked **Peekalo** project in Tokyo (`ap-northeast-1`), confirmed `ACTIVE_HEALTHY` and PostgreSQL **17.11**. No additional project, subscription or paid service was created. Existing ignored environment files point to this project, have mode `600`, and keep privileged credentials on the server.
- CLI dry run identified only `202610160004_claim_lease_safety.sql`; applied it successfully. `supabase migration list --linked` now matches all four local/remote migrations. The request-mapping table is available through the service-role API. Local `supabase/config.toml` now matches hosted PostgreSQL major 17 and enabled email confirmation.
- Confirmed `peekalo-captures` is private with a 30 MiB file limit. Hosted Auth has email signup and verification enabled, email autoconfirm disabled, and anonymous account signup disabled. Guest link viewing uses the application's signed guest identity instead of Supabase anonymous accounts. The user confirms no SMTP provider yet; general signup email delivery remains pending.
- Signed-in dashboard cross-check on 17 October confirms this is the same linked organization/project: all four migrations are listed, the capture bucket's Public switch is off with a 30 MB limit, Email is enabled, Confirm email is on and anonymous sign-ins are off. No duplicate project or additional access grant was needed.
- Extended `scripts/test-sharing-backend.mjs` with owner-claim denial, both direct/link retry-scope conflicts, distinct-link retry conflict, shared account budgets, canonical/alias create-key replay before/after replacement, request-mapping role denial and direct privileged-RPC denial.
- **64 live integration assertions pass** against real Supabase Auth, PostgreSQL and private Storage. The freshly built production Node gateway ran at `http://127.0.0.1:4000` with a runtime-only origin override; neither ignored app URL file was rewritten. Existing checks cover concurrent upload/link claims, non-consuming previews, CSRF, private normalized photo delivery without EXIF, cumulative exhaustion, recipient acceptance/revocation, bounded video ranges and over-ten-second rejection. Test users were admin-confirmed `.invalid` fixtures; this does not verify signup email delivery.
- Cleanup verification found zero rows in all seven application tables, zero storage root entries and zero temporary test accounts. The test gateway was stopped afterward. This run used generated non-sensitive media only and created no public share deployment.
- Validation: workspace lint, Next.js production build, all 22 local PostgreSQL regression cases and live 64-assertion suite pass. Hosted schema lint has no errors; warning-level lint reports one existing unused `link` record in `peekalo_media`, with no authorization failure found. The prior full `pnpm check` evidence remains in BACKEND-01; mobile code was unchanged in this setup task.
- **Pending:** durable Node API/media hosting and stable HTTPS app origin; signup SMTP/provider/sending domain; physical native Share/reveal and privacy verification. Supabase is configured for development; this is not a public-release readiness claim.

### BACKEND-01: claim/lease safety and repeatable database checks — 16 October

- Reviewed the existing sharing implementation and recorded its endpoint, identity, request-key, lease and error contract under LINK-01 in `PEEKALO_PLAN.md`. This documents current behavior without closing deferred moderation, rate limits, preparation/activation or device work.
- Added migration `202610160004_claim_lease_safety.sql`. Reveal transactions lock post → link/grant → budget in the same order as owner revocation, refresh server time after lock waits, and reject expiry reached while queued. Owner accounts cannot consume their own external link. Lease retries must match both session and authorization path.
- Added a service-only, RLS-enabled link-request mapping and canonical-key backfill. Canonical and alias request keys retain their original result after revocation/replacement, preventing an old create request from minting a new unclaimed link. Historical alias keys were never stored and cannot be recovered; a canonical lookup fallback covers legacy rows inserted during rollout.
- `pnpm test:backend` starts a disposable, loopback-only PostgreSQL **15.18** cluster from pinned development binaries. It applies the actual migrations, including a populated backfill fixture, without reading Supabase credentials. All **22 regression cases pass** (Node reports 23 tests including the enclosing test). Tests cover six racing guest identities, concurrent duplicate leases, shared account budgets across direct/link access, pending/revoked grants, configured quota races/retries, role denial, exhaustion/partial slices, request-key scope, link retries, owner/unavailable posts and deterministic revoke/expiry lock contention. The cluster and temporary files are removed after the run.
- Negative control excluding migration 004 failed with a nonzero exit and caught the intended ownership, retry-scope, nonce and lock/expiry failures. Independent source review found no blocking issues; its CI scheduling concern was removed by starting the expiry window after observing the blocked viewer.
- Full `pnpm check` passes workspace lint/TypeScript, 31 mobile tests, 12 local reveal tests, the PostgreSQL suite, Next.js production build and iOS/Android JavaScript exports. The backend suite is now included in the existing GitHub workflow; no hosted CI run has occurred. Frozen-lockfile installation passes with the required platform-binary postinstall allowlist.
- At completion of BACKEND-01, migration 004 deployment and renewed live HTTP/Auth/Storage evidence were pending; SUPABASE-01 above now closes those items. Minimal local `auth`/`storage` schema fixtures alone prove PostgreSQL behavior, not Supabase delivery or physical-device behavior. No remote database, auth settings, storage or public deployment was changed in BACKEND-01.

### Earlier environment and native verification

- ANDROID-SETUP: official Google command-line tools and Adoptium JDK downloads verified against published SHA-256 values. Installed SDK package listing, `adb version`, `aapt2 version`, CMake and Gradle/Java startup pass. At initial tools setup no device was connected; the later authorized phone run is recorded below. New zsh shells resolve the installed tools. Large SDK/JDK/Gradle/Android user files are on `/Volumes/Mac External/Developer/Android`, linked from the usual home directories; shell configuration is in `~/.config/peekalo-android/env.zsh`, sourced by `.zprofile` and `.zshrc`. Android prebuild succeeds.
- ANDROID-RUN: subsequent USB connection authorized on Samsung SM-S931B / Android 17 (`arm64-v8a`). Native Debug APK build passes (`:app:assembleDebug`, 13m 54s); APK installation succeeds and `com.peekalo.preview/.MainActivity` is the foreground activity. USB reverse on port 8081 connects to Metro. UI hierarchy confirms the Camera screen, tabs and permission-gated camera-preview label; live camera image quality/frames were not visually inspected. This initial run predated the photo shutter; the later PHOTO-02 evidence below supersedes its camera status. Local recording was added later in VIDEO-CAPTURE-01 below; privacy protection remains unimplemented/unverified. No phone identifiers or real camera frames were saved in project evidence. APK remains ignored under `apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk`.
- NAV-01: mobile lint and TypeScript pass; iOS/Android production JavaScript exports pass. On the running iPhone 17 Pro / iOS 26.2 simulator, the new center Camera button and Profile-to-Camera navigation were checked visually. No gallery/import controls or picker modules exist in the mobile source. Live physical camera permission/preview behavior remains unverified; no native rebuild was needed for these JavaScript changes.
- Fresh locked workspace install: passed in a separate temporary directory on the external drive.
- `pnpm check`: passed lint, TypeScript, Next.js production build and Expo iOS/Android production JavaScript exports. These exports are not native binaries.
- `pnpm peers check` and Expo dependency compatibility check: passed.
- Web production server: profile `/` and `/u/demo`, viewer `/s/demo`, unavailable link state and navigation checked in the browser. Phone 390 px and desktop 1280 px layouts have no horizontal overflow. Demo disclosure and browser-capture limitation are visible.
- Native setup: generated iOS project and installed 114 Pods successfully. Debug simulator native build, installation and Camera screen startup pass on iPhone 17 Pro / iOS 26.2. Metro's first bundle needed time to compile; localhost connection loaded successfully. Screenshot evidence is in ignored `.cache/native/peekalo-launch.png`. Android native build/installation/startup now also pass on the physical Samsung above.
- Path-quoting fix: final `xcodebuild` passes; `EXConstants.bundle/app.config` is present in the app. Both prebuild and Pods installation apply the local config plugin. Workspace lint (including the plugin) and TypeScript checks pass after the changes.
- CI workflow: added for locked installation and the same checks; no hosted GitHub run has occurred.
- At the foundation stage, backend authorization/race and physical capture-protection tests were pending. SHARE-01 below supersedes the backend status; physical iOS/native protection evidence is still pending.

- PHOTO-02: full-viewport camera, fixed top logo, photo shutter, cache-only review/Retake/Discard and front/back switching implemented. Navigation/backgrounding invalidate pending captures and clear drafts with best-effort file cleanup. No photo-library save or import path exists. Android live preview uses the plain-logo fallback; difference blend is enabled for composited review/non-Android views, with physical iOS evidence pending.
- PHOTO-02 validation: mobile lint, TypeScript and all ten local photo-session lifecycle tests pass. Frozen-lockfile installation passes. iOS/Android JavaScript exports pass. Tests cover duplicate shutter presses, late capture results, interruption, discard, native failures and cleanup races; they do not establish physical camera behavior.
- ANDROID-PREVIEW-FIX: a pinned pnpm patch selects CameraX COMPATIBLE/TextureView, and Android autolinking builds `expo-camera` from source so Expo's precompiled AAR cannot bypass the patch. Native Debug arm64 build passes (1 minute, including `:expo-camera:compileDebugKotlin`), APK installation succeeds, Metro connects over USB and Peekalo opens. The device UI reached “Your captured photo” / “REVIEW PHOTO.” The user explicitly confirms “Live camera, capture and Retake work” on Samsung SM-S931B / Android 17. No camera pixels, capture files or phone identifiers were saved as project evidence.
- VIDEO-CAPTURE-01: tap shutter for photo; hold for 300 ms to prepare/start video, release to stop, with native `maxDuration: 10` and a ten-second JS stop fallback. Visible red recording state/timer, microphone permission handling, local video playback/play/pause, Retake/Discard implemented. First microphone grant requires another hold. Navigation/backgrounding cancels recording and invalidates/cleans late results. No library import/save, upload or send added.
- FRAMING-01: preview and photo/video review use the same fitted portrait 9:16 frame. Android requests camera ratio 16:9 (portrait orientation displays 9:16); photos are processed into a centered, whole-pixel exact 9:16 JPEG. Extra screen space stays dark instead of stretching or changing the review framing. Logo remains fixed at top and center navigation button size/overlap is unchanged.
- VIDEO-CAPTURE-01 validation: mobile lint and TypeScript pass; all 31 tests pass (10 photo-session, 14 video-session and 7 framing). Tests cover early release, duplicate holds, native/JS duration completion, interruption, late file cleanup, permission refusal/failure recovery and integer cropping. Native Android Debug arm64 build passes (1 minute), including new pinned `expo-video@55.0.21` and `expo-image-manipulator@55.0.21`; APK installation and startup succeed. Own-package UI hierarchy reaches “Your captured video” and “Pause video.” User explicitly confirms “Both framing and video work” after comparing photo/preview framing and testing hold/release playback on the Samsung. This does not establish measured duration, sound, all lifecycle paths or iOS behavior.
- Still pending: physical ten-second automatic stop and audio verification; Android Discard, front/back capture, microphone/camera denial/recovery and navigation/background interruption checks; physical iOS photo/video framing, capture and logo blend; native protection checks.

### PHOTO-01: local fixture reveal

- Implemented on mobile `/sample` (Profile → “Explore this sample”) and web `/s/demo`. A shared `packages/reveal` controller accounts monotonic elapsed time across holds. Hidden/revealing/exhausted states, countdown, release/cancel/move-out handling and navigation/foreground cleanup are wired. Web supports Space/Enter/Escape; both platforms offer “Reveal for 1 second” using the same allowance.
- One original non-sensitive still-life illustration is rasterized as a clear fixture and a separate heavily downsampled/blurred preview. Clear image elements mount only during revelation. These demo assets are publicly bundled, not private posts; no user captures are used. Source: `packages/reveal/fixtures/morning.svg`.
- The sample balance survives route changes in a single JS runtime. Refresh/restart resets it, as disclosed in the UI. It has no identity, persistence, claim or cross-device enforcement and does not provide capture protection.
- Controller tests: 12 pass, covering cumulative holds, idle time, duplicate starts, exact exhaustion, disable/resume, stale callbacks, timed accessible reveal, delayed/invalid/backwards clocks, immutable snapshots, unsubscribe and synchronous subscriber cancellation/restart. Existing 31 capture/framing tests remain separate.
- Browser production preview: two-second hold leaves 8.0 seconds; another second leaves 7.0; Space held 1.5 seconds leaves 5.5. The accessible button debits another second and hides automatically. Navigation to Profile and back retains 4.5 seconds. Holding beyond the remaining allowance hides the sample at zero and disables both controls. This verifies local interaction, not server single-use behavior.
- Final checks: `pnpm check` passes workspace lint/TypeScript, all 31 capture/framing tests and 12 shared reveal tests, Next.js production build and iOS/Android JS exports. Frozen-lockfile installation passes. Browser widths 390 and 1280 have no horizontal overflow; moving a held pointer outside hides the sample, and the hidden DOM contains only the blurred image. iOS Debug native rebuild and simulator installation pass (116 Pods); screen verification follows below.
- Native source wiring reviewed. iPhone 17 Pro / iOS 26.2 simulator checks pass repeated holds/release, scrolling without time spent and the shared one-second button. Native holds wait 180 ms before revealing; movement over 10 points or a second touch cancels the intent, keeping scroll gestures from starting a reveal. Navigation/backgrounding also cancel pending intent.
- Current-checkout integration on 16 October: `pnpm check` passes after declaring Node 24 globals for the added backend test script in ESLint. This lints that script; it does not run its live backend requests. Final mobile lint, TypeScript and iOS/Android JS exports pass after the gesture refinement. Rebuilt and installed iOS Debug with all 119 Pods, resolving the stale binary's missing `ExpoCrypto` module. In the rebuilt app, a two-second press leaves 8.2 seconds after the intent threshold; closing/reopening preserves 8.2; a longer hold exhausts to 0.0 and disables both controls. Evidence: ignored `.cache/screenshots/reveal-native-exhausted.png` and `.cache/screenshots/reveal-desktop.png`.
- Physical iOS/Android reveal cancellation, notification/background timing, VoiceOver/TalkBack and native capture protection remain pending. Simulator source/runtime checks do not establish these protections.

The app has local photo/video capture/review and a local fixture reveal timer. Separate sharing/backend source has appeared in the checkout, including API routes, migrations and native client modules. PHOTO-01 does not verify that integration's live authorization, uploads, server allowances or real single-use links; its own demo remains independent. No backend resources or public deployment were created as part of PHOTO-01.

When a task is implemented, add its evidence here and move the next ready task into the current-stage summary. Keep unfinished verification visible.

### REVEAL-UI-01: full-viewport web reveal

- D-18 implemented in the local sample and protected web photo/video viewer. During an allowed reveal, one clear media element mounts in a dark full-viewport overlay with a countdown and release hint. The original blurred card stays in place and keeps gesture ownership; release returns to it without granting fresh time.
- Scroll locking compensates the existing scrollbar width and restores prior styles. Production browser checks at 390×844 and 1280×900 confirm the overlay matches the viewport and the original card bounds/scroll position remain identical before, during and after a hold. Clear sample media is removed again on release.
- Browser interaction checks pass pointer hold/release, cumulative Space holds, the one-second alternative, Escape dismissal, moving outside the original card and automatic exhaustion with both controls disabled. Removed the sample card's synthetic-click fallback so keyboard activation cannot reopen the overlay after cancellation; the dedicated timed button remains available.
- Web lint, TypeScript and production build pass; all 12 shared reveal-controller tests pass. An independent source review found no blocking issues. Evidence: ignored `.cache/screenshots/reveal-fullscreen-phone.png` and `reveal-fullscreen-desktop.png`.
- This task changes web presentation only. Protected delivery/lease logic and video cleanup are preserved and reviewed, but no new live private-photo/video sharing test was run. Responsive browser dimensions do not establish behavior on physical Safari/Chrome devices; native viewer presentation and existing device/privacy checks remain separate.
