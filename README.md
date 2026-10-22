# Peekalo

Peekalo is being built as a camera-first photo/video sharing app: capture a photo or video up to ten seconds, then send it to selected accounts or share an anonymous single-use link. Recipients hold to reveal hidden media, with up to ten seconds total viewing time.

- **[Start here: build board](docs/BUILD_BOARD.md)** — current task, build order, readiness and verification.
- [Decisions](docs/DECISIONS.md) — confirmed rules and provisional defaults.
- [Product and engineering plan](docs/PEEKALO_PLAN.md) — detailed architecture and privacy reasoning.
- [MVP backlog](docs/MVP_BACKLOG.md) — feature checklist and acceptance criteria.
- [Project instructions](AGENTS.md) — working rules for coding assistants.

Current stage: **Free backend and local account testing are prepared.** All six Supabase migrations are deployed; 71 hosted sharing assertions pass with generated photo/video fixtures. Local signup, captured confirmation email, verified login, username and sign-out pass, as does the local sharing suite. Google is configured in hosted testing mode. The latest Android APK builds and installs on the authorized Samsung phone; Metro bundling and native activity startup pass. Native local email registration, confirmation, login and username selection now pass with user confirmation and matching backend records; camera-to-share tests are in progress. General public signup email still needs a domain/provider. See the build board for exact evidence.

Peekalo has separate web applications: `apps/site` is the prelaunch marketing website; `apps/web` is the product web app with shared-link viewing, sample profile and local viewer demo. They share branding and browser UI through workspace packages and use the same backend. Mobile has Inbox, a prominent center Camera button, Profile and the same sample interaction. Camera preview and capture review share a centered portrait 9:16 frame; taller screens have dark extra space so framing stays consistent. The canonical logo remains fixed at the top on a subtle dark backing, and the center navigation button is unchanged. Simulator camera fallback is explicit.

Try PHOTO-01 at `/s/demo` on web or “Explore this sample” from the mobile Profile. Hold reveals a public still-life illustration; release, cancel, movement outside, navigation or loss of foreground hides it. Every hold shares ten seconds, with a countdown and an exhausted state. Space/Enter work on web; an accessible “Reveal for 1 second” button uses the same allowance on both platforms. Opening the viewer does not spend time. The runtime keeps the sample allowance across route changes; page reload/app restart resets it. This is a local interaction prototype, not a real single-use link or server authorization.

The fixture's clear and physically downsampled/blurred PNGs are separate. Only the hidden asset renders before a hold. Both are identified non-sensitive demo assets and are publicly bundled; their source illustration is in `packages/reveal/fixtures/morning.svg`. This exception is solely for the sample. Private user media uses the separate authorized delivery gateway. The demo does not prevent screenshots or retained bytes.

Tap the shutter for a photo; hold it for 300 ms to start video and release to stop. Video stops at ten seconds using a native duration limit plus a JavaScript fallback. The first hold requests microphone access if needed; after granting it, hold again to record. Review supports photo viewing or video play/pause, plus Retake and Discard. Captured photos are center-cropped to exact 9:16.

Photos and videos originate only from the in-app camera; there are no gallery, photo-library or file imports. Drafts stay in app cache without saving to the photo library. Retake/discard, navigation away and backgrounding clear the draft and attempt cleanup; late capture results are invalidated and cleaned up. Cleanup is best effort, not a guarantee that delivered or stored bytes are erased. Samsung framing and video are user-confirmed; ten-second duration, audio, interruption, permission-denial and front-camera checks, plus physical iOS capture, remain pending.

## Prelaunch marketing site (MKT-01 / WEB-SPLIT-01)

The `apps/site` homepage is Peekalo’s dark, responsive prelaunch landing page, separate from the product web app in `apps/web`. It uses an original ten-second Higgsfield/Wan 2.6 hero loop, with muted inline playback, pause/play control, poster fallback and reduced-motion/data-saver handling. Background video pauses off-screen or while the page is hidden. `/u/demo` and `/s/demo` belong to the product web app; the marketing site redirects those legacy paths to its configured product origin. The separate generated photo is identified as a local demo; its ten-second allowance persists across holds within that runtime and resets on reload. These marketing assets do not verify protected delivery or native privacy. Asset provenance, processing and exact generation prompts are in `apps/site/public/marketing/ASSETS.md`; bundled Bricolage Grotesque includes its SIL Open Font License.

Early-access collection is **closed by default**. The page shows “opens soon” and `POST /api/waitlist` returns a sanitized 503 until `WAITLIST_ENABLED=true` is explicitly configured. The waitlist migration is deployed, but do not enable collection until real Supabase POST/duplicate behavior is verified and a working private contact/removal route is included in `/privacy`. Branded email is selected after domain choice; no domain or contact mailbox has been provisioned yet. Opening collection does not send emails or provide unsubscribe delivery; connect that flow before sending updates.

When enabled, the browser posts `{email, consent:true, website:""}` to the marketing site’s same-origin `/api/waitlist`. Its bounded server proxy forwards only this waitlist request to the configured product backend. The backend validates the exact `PUBLIC_SITE_URL` origin and saves to Supabase using its server-only service credential. `PUBLIC_APP_URL` remains a legacy origin fallback when `PUBLIC_SITE_URL` is absent. Both servers must explicitly enable `WAITLIST_ENABLED=true`; the marketing app receives no database credentials or private viewer/auth proxy routes. `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` stay in ignored server configuration. Duplicate requests return the same success and preserve the original consent record. No email, IP, request body or provider error is logged. RLS denies anonymous/authenticated database access. The body is capped at 2048 bytes and five seconds; storage requests have a five-second deadline. Identifier-free admission allows up to four in-flight requests and 30 requests per rolling minute per process. Limits reset on restart and do not coordinate across instances; use trusted edge limits before scaling. The flag is read at request time by the marketing page/proxy and backend endpoint. Keep protected/demo routes noindexed; search indexing for a public launch is a separate hosting change.

Run `pnpm test:waitlist` for the backend handler and disposable PostgreSQL permissions/consent checks, and `pnpm test:web-split` for origin/proxy boundary checks, plus the workspace lint/typecheck and both web builds. The Free marketing preview is live with collection closed; this does not create a mailbox or establish waitlist readiness.

## Source layout

```text
apps/mobile/          iOS and Android application
apps/site/            Marketing website, privacy notice and waitlist-only proxy
apps/web/             Product web app, profiles, protected viewers, Node API/media processing
packages/contracts/   Shared media types and limits
packages/reveal/      Local sample allowance controller and deterministic tests
packages/design/      Shared native/web tokens, canonical logo artwork and display font
packages/web-ui/      Shared browser brand/icons, reveal overlay, base CSS and origin validation
scripts/              Native build runner and backend verification suites
supabase/migrations/  Service-only sharing schema and atomic claim/budget functions
docs/                 Build board, decisions, plan and backlog
```

The Node API and trusted Sharp/FFmpeg processing path are in `apps/web/lib/server/`. The database migrations are under `supabase/migrations/`; the intended separate worker deployment remains future work.

All three applications consume `@peekalo/design`; the two browser apps reuse `@peekalo/web-ui`. Update `@peekalo/design` semantic values to change the common palette/scale; keep native components and web CSS as platform adapters. Brand, component and product-language rules live in D-21 of `docs/DECISIONS.md`.

D-22 uses one canonical logo geometry in `packages/design/src/brand-geometry.ts`: web renders the outlined SVG and native loads its bundled PNG densities. Headers, camera/account panels, footer, sample phone and reveal overlay use these adapters. Run `pnpm brand:generate` after editing shared logo geometry/colors and `pnpm brand:check` to verify the checked-in exports, including native launcher and web favicon. Launcher asset changes take effect in the next native build; header/logo artwork changes are bundled JavaScript/assets.

## Install and run

Use **Node 24.14.1** and **pnpm 11.25.0**. Exact application dependencies are pinned in package manifests and `pnpm-lock.yaml`.

```sh
pnpm install --frozen-lockfile
pnpm dev:site  # Marketing website, port 3100
```

In another terminal, run `pnpm dev:web` for the product web app on port 3101. Open [the website](http://127.0.0.1:3100), [the web app](http://127.0.0.1:3101), [the sample profile](http://127.0.0.1:3101/u/demo) or [the viewer demo](http://127.0.0.1:3101/s/demo). These public samples need no API keys; early-access collection stays closed by default. Configured protected links use the product origin’s `/s/view#…`; unknown viewer paths show an unavailable state.

For cross-app links, configure `PUBLIC_SITE_URL` as the marketing origin and `PUBLIC_APP_URL` as the product origin on both servers. Use distinct actual HTTPS origins without paths or credentials in production. Only development supplies loopback defaults (`http://127.0.0.1:3100` / `http://127.0.0.1:3101`); use those same origins in the browser when testing origin checks. Missing or invalid production configuration omits cross-app links or shows an unavailable state rather than inventing a domain. The product `/privacy` redirects to the configured website’s notice; equal origins are rejected to prevent a self-redirect. No ignored environment files were changed as part of this split; ensure an older local `PUBLIC_APP_URL` still points to the product server before generating links.

For the native app, install Xcode 26.2+ with an iOS simulator runtime and CocoaPods, then run:

```sh
pnpm ios
```

Select an iPhone simulator when prompted, or pass its name/UDID with `pnpm ios --device <simulator>`. This runner builds Debug **simulator** binaries. It generates ignored iOS files, installs Pods, places Xcode build output and temporary downloads under ignored `.cache/`, then uses Expo to install the binary and start Metro. Physical-device/release builds are a later verification task using the Expo CLI and signing configuration.

After installing the development build, JavaScript-only changes need:

```sh
pnpm dev:mobile
```

`pnpm android --device` uses Expo's local Android build and lets you select a connected phone. On this Mac, the command-line Android SDK and Temurin JDK 17 are installed; the full Android Studio IDE and emulator are not required for USB phone testing. SDK 36, build-tools 36.0.0, NDK 27.1.12297006 and CMake 3.22.1 are installed. SDK/Java/Gradle files live on **Mac External**, which must remain connected.

New zsh Terminal sessions load the tools automatically. In an already-open terminal, run:

```sh
source "$HOME/.config/peekalo-android/env.zsh"
adb devices
pnpm android --device
```

Connect the phone with a USB data cable, enable Developer options / USB debugging, and accept the debugging authorization on the phone. `adb devices` must list an authorized device before installation. Native Debug build, installation and Camera screen startup pass on Samsung SM-S931B / Android 17. The native camera patch below resolves the reported blank preview on this phone. The latest build includes `expo-video@55.0.21` and `expo-image-manipulator@55.0.21`; the user confirms matching photo framing and video recording/playback. Ten-second duration, audio, lifecycle/permission and front-camera checks, physical iOS capture and privacy checks remain pending. Exporting an Android JavaScript bundle does not verify a native Android build.

After installation, leave Metro running (`pnpm dev:mobile`). For a USB connection, run `adb reverse tcp:8081 tcp:8081` after reconnecting, then open Peekalo. The development server can be reached at `http://127.0.0.1:8081` from the phone through that USB reverse connection. JavaScript changes can refresh without rebuilding the native app.

## Native tooling notes

- Mobile is pinned to **Expo 55.0.31 / React Native 0.83.10** for the installed Xcode 26.2. Both browser apps use **Next.js 16.4.1**; all apps use **React 19.2.0** for compatible, consistent peer resolution.
- A source-build setting in `app.json` avoids React Native's prebuilt-artifact file-URI failure when the checkout path contains spaces. This makes the first native build slower. [Expo build-properties documentation](https://docs.expo.dev/versions/v55.0.0/sdk/build-properties/)
- CocoaPods can be installed normally with `brew install cocoapods`. On this Mac, the stalled Homebrew Ruby download was replaced with CocoaPods 1.17.0 in ignored `.cache/cocoapods`, using the existing Homebrew portable Ruby. The runner recognizes that optional local install; it is not an application dependency and is not committed.
- Keep several GB free on the internal drive for Apple tooling, even with external build caches. The successful simulator build had over 5 GiB free. A local Expo config plugin fixes generated shell-script quoting for checkout paths containing spaces. See the build board for actual native evidence.
- The pinned `expo-camera@55.0.23` package has a pnpm-managed patch in `patches/` that selects Android CameraX `PreviewView.ImplementationMode.COMPATIBLE` (TextureView) to compose the full-screen preview with React Native overlays. `apps/mobile/package.json` also sets Android autolinking `buildFromSource: ["expo-camera"]`; otherwise Expo's precompiled library skips the patch. The patched native build and installation pass, and the phone has reached captured-photo review; the user confirms full-screen live preview, capture and Retake work on the Samsung. Run `pnpm install --frozen-lockfile`, then `pnpm android --device` to rebuild and reinstall after native patch changes. Metro refresh alone cannot apply a native patch. The manifest, patch and lockfile preserve the change.
- Native bundle identifiers `com.peekalo.preview` are development placeholders, not reserved store identities.

## Verification commands

```sh
pnpm lint           # Workspace code and native runner
pnpm typecheck      # Shared packages, mobile, website and web app
pnpm test:mobile    # 31 photo/video lifecycle and framing tests
pnpm test:reveal    # 12 local allowance, cancellation and timer tests
pnpm test:backend   # Disposable PostgreSQL 15: real migration/claim/grant/budget tests
pnpm test:web-split # Public origins and marketing proxy boundary regression
pnpm test:waitlist  # Signup handler, admission and PostgreSQL permissions/consent
pnpm brand:check    # Both favicons and native assets match canonical artwork
pnpm build          # Marketing website and product web app production builds
pnpm export:mobile  # iOS and Android production JS bundles
pnpm check          # Lint, types, mobile/reveal/backend tests, both web builds and mobile exports
pnpm peers check
pnpm --filter @peekalo/mobile exec expo install --check
```

The GitHub workflow runs locked installation and `pnpm check` on pushes/PRs. The existing 43 local tests cover capture lifecycle, crop geometry and fixture reveal accounting/cancellation. The backend suite applies every migration to a fresh loopback-only PostgreSQL 15 cluster, including a populated migration/backfill fixture, then checks claims, grants, budgets, quotas, retry keys and row-lock contention over independent connections. It needs no Docker, Supabase credentials or existing server and removes its database afterward. Run as an ordinary user; PostgreSQL refuses to initialize as root. The pinned `embedded-postgres` development dependency supplies binaries; its platform postinstall scripts restore required symlinks through the workspace build allowlist. CI does not perform native builds or prove camera/capture behavior. Build results and remaining device checks are tracked in the build board.

Next: hosted delivery timing (HOST-02), sign-in provider/email setup and physical native Share/reveal checks. Free Render hosting is live with limited media evidence; the earlier temporary tunnel is superseded for hosting, but native configuration is unchanged. Remaining evidence is on the build board.


## Protected sharing development

After capture, tap **Share moment**, sign in/create an account and choose a username. Create & share link opens the phone chooser with a single-use protected URL; Send to recipient creates a request in that account’s Inbox. The recipient must accept before holding to reveal. The current capture’s share panel also supports revoking its link or recipient access.

Copy `apps/web/.env.example` and `apps/mobile/.env.example` to ignored `.env.local` files. Only the web server receives `SUPABASE_SERVICE_ROLE_KEY` and `SHARE_TOKEN_SECRET`; never put them in Expo public variables. Mobile needs only `EXPO_PUBLIC_API_URL` and obtains the non-privileged auth configuration from the server. Apply migrations under `supabase/migrations/` to a dedicated development project. The worker needs Sharp plus `ffmpeg`/`ffprobe`; this Node processing path is not a drop-in serverless deployment.

Run `pnpm --filter @peekalo/web build`, then `pnpm --filter @peekalo/web exec next start --port 4000`. The package’s plain `start` command defaults to 3101. Earlier public tests used an ephemeral tunnel to this Mac; restarting it changes the URL and breaks links to its old host. Keep server `PUBLIC_APP_URL` and mobile `EXPO_PUBLIC_API_URL` on the same HTTPS origin for phone/public tests. Durable hosting/domain setup remains pending.

For disposable development projects only, set `PEEKALO_TEST_BASE_URL` and run `pnpm test:sharing`. This uses generated fixtures and temporary test accounts and cleans them up; never point it at production. It verifies real transactions, authorization and storage delivery rather than mocks. Existing capture/reveal unit tests remain in `pnpm check`.

To repeat the verified localhost integration without changing the ignored app URL files, start the production gateway in one terminal, then run the suite in another:

```sh
PUBLIC_APP_URL=http://127.0.0.1:4000 pnpm --filter @peekalo/web exec next start --hostname 127.0.0.1 --port 4000
```

```sh
PUBLIC_APP_URL=http://127.0.0.1:4000 PEEKALO_TEST_BASE_URL=http://127.0.0.1:4000 pnpm test:sharing
```

For backend development without remote writes, use `pnpm test:backend`. Its minimal `auth` and `storage` schemas support testing the real PostgreSQL migrations; they do not exercise Supabase authentication, Storage or the HTTP gateway. The API contract and expected error states are recorded under LINK-01 in [the plan](docs/PEEKALO_PLAN.md#implemented-development-protocol--link-01). Migration `202610160004_claim_lease_safety.sql` adds claim/lease race fixes and persistent link-request mappings; all four migrations are deployed to the dedicated development project as of 17 October 2026. Historical alias request keys were never stored and cannot be backfilled. The live suite passes 64 assertions; cleanup was independently confirmed.

Supabase’s default email service sends confirmations only to project-team addresses. A custom SMTP provider is needed for general signup; do not disable confirmation to work around this. The user has no email provider yet. Anonymous web link viewers do not need signup. Native Share/auth/upload/reveal and capture protection still need physical-device checks; the user deferred the next phone test.

The server prepays two-second viewing slices, allows renewal near expiry and caps cumulative grants at ten seconds per identity/post. Interrupted prepaid time is charged. Opaque previews never download originals; authorized media passes through a private no-store gateway. These controls cannot erase delivered bytes or guarantee capture prevention. The three-active-post proposal is not enforced until its meaning is confirmed; `PEEKALO_ACTIVE_POST_LIMIT` is an explicit optional server setting.

### Isolated local registration testing

`pnpm local:setup` prepares a separate Docker Supabase project with private storage and email confirmation enabled. Confirmation emails are captured on this Mac at `http://127.0.0.1:55324`, rather than sent externally. Google is disabled there until real OAuth credentials are supplied. These accounts are separate from hosted Supabase accounts. Clean stop/start, loopback port inspection, ten actual account assertions and the 71-assertion local sharing suite pass under APP-TEST-01.

The helper uses the project-local CLI in `.cache/supabase-cli/supabase` when available, otherwise the installed CLI. On this Mac the cached official CLI is 2.121.0; the global CLI is unchanged. A private Docker socket proxy makes this stack's published ports explicitly loopback-only at creation, then actual bindings are verified. Diagnostic/credential files stay private and active app environment files are preserved. `pnpm local:stop` stops only this test stack and preserves its volumes.

After setup and `pnpm build:web`, run `pnpm dev:web:local` and `pnpm dev:mobile:local --localhost` in separate terminals. Metro uses port 8083 because unrelated applications own 8081 and 8082. For Android USB testing, reverse ports 3101 (product), 55321 (local Auth/Storage) and 8083 (Metro) with adb; the local inbox stays on the Mac. The mobile launcher receives only a public API origin and a development-only local-testing flag, never server keys. The flag avoids Expo 55's development `.env.local` precedence overriding the shell API setting; release builds ignore it. Fully restart the app/Metro when switching account environments. Open the Mac inbox to confirm a new test account, then return to the app and sign in. `pnpm test:auth:local` repeats the generated-account integration checks. Local sharing links work only on this Mac or through configured USB reverses; they are not public links. Physical tests remain pending.

For hosted Google or public sharing tests, stop local Metro and run `pnpm dev:mobile --port 8083 --localhost`; the ignored default mobile API origin points to `https://peekalo-dev.onrender.com`. Reverse only 8083 for Metro. Hosted accounts differ from local email-test accounts. Google testing currently allows only the owner's Google account; public email signup still needs SMTP. Native sign-in/capture-to-share on this new build is not yet verified.

### Google sign-in

The account panel offers **Continue with Google** (Supabase OAuth with PKCE in the in-app browser sheet). Hosted Google is configured as of 22 October: External/Testing consent, owner account allowlisted, web client callback on the existing Supabase project, exact native redirect and hosted site URL saved. Provider status and initiation routing pass; actual native Google sign-in remains pending. Credentials stay in Supabase/private ignored storage. For another environment:

1. In Google Cloud Console → APIs & Services → Credentials, create an **OAuth client ID** of type **Web application**. Add the authorized redirect URI `https://<project-ref>.supabase.co/auth/v1/callback`. Configure the OAuth consent screen (app name, support email, scopes `email`, `profile`, `openid`).
2. In Supabase → Authentication → Sign In / Providers → **Google**, enable it and paste that client ID and secret. Keep the secret out of the repository.
3. In Supabase → Authentication → URL Configuration → **Redirect URLs**, add `peekalo://auth-callback`.

Adding `expo-web-browser` requires a native rebuild (`pnpm android --device` / `pnpm ios`); Metro refresh alone is not enough. `supabase/config.toml` mirrors these settings for a local Supabase stack using `SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID` and `SUPABASE_AUTH_EXTERNAL_GOOGLE_SECRET`.

## Container hosting — HOST-01

The root `Dockerfile` packages the product web/API into one Node 24.14.1 container with Sharp, FFmpeg/FFprobe, H.264/AAC encoders and an unprivileged server process. Next.js standalone output includes the workspace dependencies, static chunks and public demo fixtures. Build from the repository root; `.dockerignore` excludes environment files, native projects, caches and unrelated workspace inputs. Supply backend credentials only at runtime. No persistent capture disk is required; media remains in private Supabase Storage.

```sh
docker build --tag peekalo-hosting:local .
pnpm test:hosting
node scripts/test-hosting-container.mjs
```

The five configuration tests need no Docker or credentials and run in `pnpm check`. The separate container smoke test uses synthetic credentials, checks startup refusal without configuration, backend readiness failure, pages/chunks/fixtures, the non-root user and absence of environment files. GitHub Actions has a separate container build/smoke job; a local run does not establish hosted CI evidence.

To test the container against the disposable development project with existing ignored configuration:

```sh
docker run --rm --name peekalo-dev --memory=2g --cpus=1 \
  --tmpfs /tmp:rw,noexec,nosuid,size=256m,mode=1777 \
  --env-file apps/web/.env.local \
  -e FFMPEG_PATH=/usr/bin/ffmpeg -e FFPROBE_PATH=/usr/bin/ffprobe \
  -e PUBLIC_APP_URL=http://127.0.0.1:4001 \
  -p 127.0.0.1:4001:3000 peekalo-hosting:local
```

Then use `PUBLIC_APP_URL=http://127.0.0.1:4001 PEEKALO_TEST_BASE_URL=http://127.0.0.1:4001 pnpm test:sharing`. This creates and removes generated fixtures/test accounts in the development project. Keep it away from production.

Before listening, the container validates required settings, HTTPS origins (HTTP is allowed only for explicit loopback development), optional quota syntax, actual Sharp JPEG encoding, FFmpeg/FFprobe, required encoders and private writable temporary storage. Startup errors are generic. `GET /api/health` returns only `{ready}` with HTTP 200/503 and no-store headers; it checks that the service credential can read migration 004's request-mapping table and that `peekalo-captures` is private with the expected 30 MiB limit, under a four-second deadline. This is readiness for those dependencies, not a full authorization regression or email/device test. `/api/shares/config` remains the native client's public bootstrap endpoint and is not the hosting health check.

Render is the selected hosting provider for the combined web/API/media runtime, retaining the existing Supabase project. `render.yaml` describes the development deployment; its presence does not mean a service is live. It now proposes two Singapore **Free** web services: `peekalo-dev` for product/API/media and `peekalo-site-dev` for marketing, one instance each, manual deploys and `/api/health`. Product retains a 120-second shutdown allowance. The prior paid proposal remains deferred. Review the current [compute plan](https://render.com/docs/compute-plans) and [pricing](https://render.com/pricing) before creating billable resources. Render provides a stable HTTPS `onrender.com` origin; a custom domain is optional for this development step. See the [Blueprint reference](https://render.com/docs/blueprint-spec) and [Docker hosting documentation](https://render.com/docs/docker).

The marketing website has its own standalone image without database credentials or a media runtime. Build it separately from the same repository root:

```sh
docker build -f apps/site/Dockerfile --tag peekalo-site:local .
node scripts/test-site-container.mjs
```

The site smoke checks standalone pages/chunks/assets, absent private routes, closed collection, compatibility redirects, non-root execution and no environment files. CI has separate product and site container jobs. Configure only public origins and the closed waitlist gate on the site; backend secrets stay on the product service. On 22 October the user selected Free testing. Both [marketing](https://peekalo-site-dev.onrender.com) and [product/API](https://peekalo-dev.onrender.com) are live; paid provisioning remains deferred. The Blueprint creates no Render database, disk or worker.

Actual preview services were created through MCP from commit `fe2f1fb`, with manual deploys and the existing signing secret. They are not Blueprint-managed: do not apply `render.yaml` again without reviewing resource adoption/duplication. MCP does not expose HTTP health-check-path/shutdown-delay settings, so the live services currently retain TCP checks/platform shutdown defaults; the manifest records `/api/health` and the product 120-second target for subsequent configuration. Both health endpoints were verified directly. Dashboard access is needed to finish those settings.

[CI run 39703523711](https://github.com/pascalpong/peekalo/actions/runs/39703523711) passes the workspace and both Linux AMD64 container jobs, including both resource profiles. Public pages, boundaries and health checks pass. Generated photo and one-second video delivery succeeded in a warm diagnostic, but the full hosted sharing suite fails when its multi-request sequences exceed the two-second lease. Expired media remains denied. Native/server ignored origins have not been changed; hosted timing verification is HOST-02 before phone integration. Do not lengthen or remove authorization checks to make these tests pass.

Deployment sequence: publish the reviewed repository branch to GitHub, connect the repository in Render, and review the proposed service/plan. Supply the four existing Supabase/signing settings only on the product service from ignored server configuration; supply both assigned public origins on each service. Preserve the existing `SHARE_TOKEN_SECRET` so existing tokens/cookies keep their signatures. Set `PUBLIC_APP_URL` to the exact assigned product HTTPS origin and `PUBLIC_SITE_URL` to the actual marketing origin on both servers; do not include paths. Keep the waitlist closed until the existing collection requirements are met. After health passes, run the generated-fixture suite through that origin, then update mobile's ignored `EXPO_PUBLIC_API_URL` and restart Metro. Keep the prior gateway available until the new origin is verified; changing the host does not migrate URLs already sent. Roll back by deploying the previous image/commit with the same runtime secrets; deployment does not apply migrations automatically.

Keep one Node process initially, allow multipart bodies of at least 30 MiB plus 64 KiB overhead, allow upload/processing requests beyond the 75-second probe/transcode window, preserve authorization/cookies/Range headers and disable proxy/CDN caching for `/api/**`. Restrict operational logs to sanitized metadata, without credentials, raw link tokens or request bodies. Avoid persistent scratch volumes; the local command bounds ephemeral scratch to 256 MiB, while the Render template relies on the container's ephemeral filesystem. Measure real memory and latency before changing instance size.

Free preview limits: each service receives 0.1 CPU / 512 MB, sleeps after 15 idle minutes and can take about a minute to wake. All Free web services share 750 instance-hours per workspace each month, including unrelated services already in this workspace. Bandwidth/build limits and external Supabase traffic also apply; without a payment method, exhaustion can suspend services; with a payment method, supplementary bandwidth/build usage can be billed. See [Render Free limits](https://render.com/docs/free) and [current compute plans](https://render.com/docs/compute-plans). A successful page/container smoke does not establish photo/video processing capacity or production readiness. Do not use keep-alive traffic to bypass idle suspension.

Reproduce the free-resource page/bootstrap smoke checks with the locally built images:

```sh
PEEKALO_TEST_PROFILE=free node scripts/test-hosting-container.mjs
PEEKALO_TEST_PROFILE=free node scripts/test-site-container.mjs
```

These use synthetic credentials with 512 MiB / 0.1 CPU and do not create Supabase accounts or media. Realistic upload/transcoding capacity needs separate verification; the hosted Linux AMD64 split now passes CI as recorded below. Keep both `WAITLIST_ENABLED` values false; the website needs no Supabase secrets. No domain purchase or SMTP provider is needed for this closed preview.

Upload admission/body deadlines and fenced stale-upload recovery are now implemented under APP-TEST-01; deploy the matching gateway and migration together before relying on them. Failed attempt objects may remain private when publication state is uncertain; durable orphan cleanup remains future work. Rate limits, signup SMTP, physical native sharing/privacy, and a separate durable worker/job queue remain tracked work. Hosting preparation does not close them.
