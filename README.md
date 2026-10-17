# Peekalo

Peekalo is being built as a camera-first photo/video sharing app: capture a photo or video up to ten seconds, then send it to selected accounts or share an anonymous single-use link. Recipients hold to reveal hidden media, with up to ten seconds total viewing time.

- **[Start here: build board](docs/BUILD_BOARD.md)** — current task, build order, readiness and verification.
- [Decisions](docs/DECISIONS.md) — confirmed rules and provisional defaults.
- [Product and engineering plan](docs/PEEKALO_PLAN.md) — detailed architecture and privacy reasoning.
- [MVP backlog](docs/MVP_BACKLOG.md) — feature checklist and acceptance criteria.
- [Project instructions](AGENTS.md) — working rules for coding assistants.

Current stage: **Supabase development setup verified.** Capture review supports account sign-in, private photo/video upload, single-use links and recipient requests. The Peekalo Supabase project has all four migrations applied, private capture storage and email verification enabled; 64 live integration assertions pass with generated fixtures. The API gateway was tested locally on this Mac. General signup email delivery, durable public API hosting and physical native sharing remain pending. See the build board for exact evidence.

Web has a sample profile and interactive viewer; mobile has Inbox, a prominent center Camera button, Profile and the same sample interaction. Camera preview and capture review share a centered portrait 9:16 frame; taller screens have dark extra space so framing stays consistent. The logo remains fixed at the top and the center navigation button is unchanged. Android live preview uses a plain logo fallback because blend mode affected native camera composition. Simulator camera fallback is explicit.

Try PHOTO-01 at `/s/demo` on web or “Explore this sample” from the mobile Profile. Hold reveals a public still-life illustration; release, cancel, movement outside, navigation or loss of foreground hides it. Every hold shares ten seconds, with a countdown and an exhausted state. Space/Enter work on web; an accessible “Reveal for 1 second” button uses the same allowance on both platforms. Opening the viewer does not spend time. The runtime keeps the sample allowance across route changes; page reload/app restart resets it. This is a local interaction prototype, not a real single-use link or server authorization.

The fixture's clear and physically downsampled/blurred PNGs are separate. Only the hidden asset renders before a hold. Both are identified non-sensitive demo assets and are publicly bundled; their source illustration is in `packages/reveal/fixtures/morning.svg`. This exception is solely for the sample. Private user media uses the separate authorized delivery gateway. The demo does not prevent screenshots or retained bytes.

Tap the shutter for a photo; hold it for 300 ms to start video and release to stop. Video stops at ten seconds using a native duration limit plus a JavaScript fallback. The first hold requests microphone access if needed; after granting it, hold again to record. Review supports photo viewing or video play/pause, plus Retake and Discard. Captured photos are center-cropped to exact 9:16.

Photos and videos originate only from the in-app camera; there are no gallery, photo-library or file imports. Drafts stay in app cache without saving to the photo library. Retake/discard, navigation away and backgrounding clear the draft and attempt cleanup; late capture results are invalidated and cleaned up. Cleanup is best effort, not a guarantee that delivered or stored bytes are erased. Samsung framing and video are user-confirmed; ten-second duration, audio, interruption, permission-denial and front-camera checks, plus physical iOS capture, remain pending.

## Source layout

```text
apps/mobile/          iOS and Android application
apps/web/             Profiles, protected viewers, Node API and media processing
packages/contracts/   Shared media types and limits
packages/reveal/      Local sample allowance controller and deterministic tests
scripts/              Native build runner and backend verification suites
supabase/migrations/  Service-only sharing schema and atomic claim/budget functions
docs/                 Build board, decisions, plan and backlog
```

The Node API and trusted Sharp/FFmpeg processing path are in `apps/web/lib/server/`. The database migrations are under `supabase/migrations/`; the intended separate worker deployment remains future work.

## Install and run

Use **Node 24.14.1** and **pnpm 11.25.0**. Exact application dependencies are pinned in package manifests and `pnpm-lock.yaml`.

```sh
pnpm install --frozen-lockfile
pnpm dev:web
```

Open [the sample profile](http://localhost:3000) or [the viewer demo](http://localhost:3000/s/demo). `/u/demo` also shows the profile. These samples need no environment variables or API keys. Configured protected links use `/s/view#…` and the separate backend described below; unknown viewer paths show an unavailable state.

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

- Mobile is pinned to **Expo 55.0.31 / React Native 0.83.10** for the installed Xcode 26.2. Web is **Next.js 16.4.1**; both apps use **React 19.2.0** for compatible, consistent peer resolution.
- A source-build setting in `app.json` avoids React Native's prebuilt-artifact file-URI failure when the checkout path contains spaces. This makes the first native build slower. [Expo build-properties documentation](https://docs.expo.dev/versions/v55.0.0/sdk/build-properties/)
- CocoaPods can be installed normally with `brew install cocoapods`. On this Mac, the stalled Homebrew Ruby download was replaced with CocoaPods 1.17.0 in ignored `.cache/cocoapods`, using the existing Homebrew portable Ruby. The runner recognizes that optional local install; it is not an application dependency and is not committed.
- Keep several GB free on the internal drive for Apple tooling, even with external build caches. The successful simulator build had over 5 GiB free. A local Expo config plugin fixes generated shell-script quoting for checkout paths containing spaces. See the build board for actual native evidence.
- The pinned `expo-camera@55.0.23` package has a pnpm-managed patch in `patches/` that selects Android CameraX `PreviewView.ImplementationMode.COMPATIBLE` (TextureView) to compose the full-screen preview with React Native overlays. `apps/mobile/package.json` also sets Android autolinking `buildFromSource: ["expo-camera"]`; otherwise Expo's precompiled library skips the patch. The patched native build and installation pass, and the phone has reached captured-photo review; the user confirms full-screen live preview, capture and Retake work on the Samsung. Run `pnpm install --frozen-lockfile`, then `pnpm android --device` to rebuild and reinstall after native patch changes. Metro refresh alone cannot apply a native patch. The manifest, patch and lockfile preserve the change.
- Native bundle identifiers `com.peekalo.preview` are development placeholders, not reserved store identities.

## Verification commands

```sh
pnpm lint           # Workspace code and native runner
pnpm typecheck      # Shared contracts, mobile and web
pnpm test:mobile    # 31 photo/video lifecycle and framing tests
pnpm test:reveal    # 12 local allowance, cancellation and timer tests
pnpm test:backend   # Disposable PostgreSQL 15: real migration/claim/grant/budget tests
pnpm build          # Web production build
pnpm export:mobile  # iOS and Android production JS bundles
pnpm check          # Lint, types, mobile/reveal/backend tests, web build and mobile exports
pnpm peers check
pnpm --filter @peekalo/mobile exec expo install --check
```

The GitHub workflow runs locked installation and `pnpm check` on pushes/PRs. The existing 43 local tests cover capture lifecycle, crop geometry and fixture reveal accounting/cancellation. The backend suite applies every migration to a fresh loopback-only PostgreSQL 15 cluster, including a populated migration/backfill fixture, then checks claims, grants, budgets, quotas, retry keys and row-lock contention over independent connections. It needs no Docker, Supabase credentials or existing server and removes its database afterward. Run as an ordinary user; PostgreSQL refuses to initialize as root. The pinned `embedded-postgres` development dependency supplies binaries; its platform postinstall scripts restore required symlinks through the workspace build allowlist. CI does not perform native builds or prove camera/capture behavior. Build results and remaining device checks are tracked in the build board.

Next: durable API hosting, general signup email delivery and physical native Share/reveal checks. Supabase is verified through the local Node gateway; the earlier temporary tunnel is not durable hosting. Remaining evidence is on the build board.


## Protected sharing development

After capture, tap **Share moment**, sign in/create an account and choose a username. Create & share link opens the phone chooser with a single-use protected URL; Send to recipient creates a request in that account’s Inbox. The recipient must accept before holding to reveal. The current capture’s share panel also supports revoking its link or recipient access.

Copy `apps/web/.env.example` and `apps/mobile/.env.example` to ignored `.env.local` files. Only the web server receives `SUPABASE_SERVICE_ROLE_KEY` and `SHARE_TOKEN_SECRET`; never put them in Expo public variables. Mobile needs only `EXPO_PUBLIC_API_URL` and obtains the non-privileged auth configuration from the server. Apply migrations under `supabase/migrations/` to a dedicated development project. The worker needs Sharp plus `ffmpeg`/`ffprobe`; this Node processing path is not a drop-in serverless deployment.

Run `pnpm --filter @peekalo/web build`, then `pnpm --filter @peekalo/web start --port 4000`. Earlier public tests used an ephemeral tunnel to this Mac; restarting it changes the URL and breaks links to its old host. Keep server `PUBLIC_APP_URL` and mobile `EXPO_PUBLIC_API_URL` on the same HTTPS origin for phone/public tests. Durable hosting/domain setup remains pending.

For disposable development projects only, set `PEEKALO_TEST_BASE_URL` and run `pnpm test:sharing`. This uses generated fixtures and temporary test accounts and cleans them up; never point it at production. It verifies real transactions, authorization and storage delivery rather than mocks. Existing capture/reveal unit tests remain in `pnpm check`.

To repeat the verified localhost integration without changing the ignored app URL files, start the production gateway in one terminal, then run the suite in another:

```sh
PUBLIC_APP_URL=http://127.0.0.1:4000 pnpm --filter @peekalo/web start --hostname 127.0.0.1 --port 4000
```

```sh
PUBLIC_APP_URL=http://127.0.0.1:4000 PEEKALO_TEST_BASE_URL=http://127.0.0.1:4000 pnpm test:sharing
```

For backend development without remote writes, use `pnpm test:backend`. Its minimal `auth` and `storage` schemas support testing the real PostgreSQL migrations; they do not exercise Supabase authentication, Storage or the HTTP gateway. The API contract and expected error states are recorded under LINK-01 in [the plan](docs/PEEKALO_PLAN.md#implemented-development-protocol--link-01). Migration `202610160004_claim_lease_safety.sql` adds claim/lease race fixes and persistent link-request mappings; all four migrations are deployed to the dedicated development project as of 17 October 2026. Historical alias request keys were never stored and cannot be backfilled. The live suite passes 64 assertions; cleanup was independently confirmed.

Supabase’s default email service sends confirmations only to project-team addresses. A custom SMTP provider is needed for general signup; do not disable confirmation to work around this. The user has no email provider yet. Anonymous web link viewers do not need signup. Native Share/auth/upload/reveal and capture protection still need physical-device checks; the user deferred the next phone test.

The server prepays two-second viewing slices, allows renewal near expiry and caps cumulative grants at ten seconds per identity/post. Interrupted prepaid time is charged. Opaque previews never download originals; authorized media passes through a private no-store gateway. These controls cannot erase delivered bytes or guarantee capture prevention. The three-active-post proposal is not enforced until its meaning is confirmed; `PEEKALO_ACTIVE_POST_LIMIT` is an explicit optional server setting.

### Google sign-in

The account panel offers **Continue with Google** (Supabase OAuth with PKCE in the in-app browser sheet). It stays disabled with a clear message until the provider is configured:

1. In Google Cloud Console → APIs & Services → Credentials, create an **OAuth client ID** of type **Web application**. Add the authorized redirect URI `https://<project-ref>.supabase.co/auth/v1/callback`. Configure the OAuth consent screen (app name, support email, scopes `email`, `profile`, `openid`).
2. In Supabase → Authentication → Sign In / Providers → **Google**, enable it and paste that client ID and secret. Keep the secret out of the repository.
3. In Supabase → Authentication → URL Configuration → **Redirect URLs**, add `peekalo://auth-callback`.

Adding `expo-web-browser` requires a native rebuild (`pnpm android --device` / `pnpm ios`); Metro refresh alone is not enough. `supabase/config.toml` mirrors these settings for a local Supabase stack using `SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID` and `SUPABASE_AUTH_EXTERNAL_GOOGLE_SECRET`.

## Container hosting — HOST-01

The root `Dockerfile` packages the web/API into one Node 24.14.1 container with Sharp, FFmpeg/FFprobe, H.264/AAC encoders and an unprivileged server process. Next.js standalone output includes the workspace dependencies, static chunks and public demo fixtures. Build from the repository root; `.dockerignore` excludes environment files, native projects, caches and unrelated workspace inputs. Supply backend credentials only at runtime. No persistent capture disk is required; media remains in private Supabase Storage.

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

Render is the selected hosting provider for the combined web/API/media runtime, retaining the existing Supabase project. `render.yaml` describes the development deployment; its presence does not mean a service is live. It proposes Singapore, one `1c-2g` instance (1 CPU / 2 GB), manual deploys, `/api/health` and a 120-second shutdown allowance. Review the current [compute plan](https://render.com/docs/compute-plans) and [pricing](https://render.com/pricing) before creating billable resources. Render provides a stable HTTPS `onrender.com` origin; a custom domain is optional for this development step. See the [Blueprint reference](https://render.com/docs/blueprint-spec) and [Docker hosting documentation](https://render.com/docs/docker).

Deployment sequence: publish the reviewed repository branch to GitHub, connect the repository in Render, and review the proposed service/plan. Set the five `sync: false` values in the hosting secret settings from the ignored server configuration. Preserve the existing `SHARE_TOKEN_SECRET` so existing tokens/cookies keep their signatures. Set `PUBLIC_APP_URL` to the exact assigned HTTPS origin; do not include a path. After health passes, run the generated-fixture suite through that origin, then update mobile's ignored `EXPO_PUBLIC_API_URL` and restart Metro. Keep the prior gateway available until the new origin is verified; changing the host does not migrate URLs already sent. Roll back by deploying the previous image/commit with the same runtime secrets; deployment does not apply migrations automatically.

Keep one Node process initially, allow multipart bodies of at least 30 MiB plus 64 KiB overhead, allow upload/processing requests beyond the 75-second probe/transcode window, preserve authorization/cookies/Range headers and disable proxy/CDN caching for `/api/**`. Restrict operational logs to sanitized metadata, without credentials, raw link tokens or request bodies. Avoid persistent scratch volumes; the local command bounds ephemeral scratch to 256 MiB, while the Render template relies on the container's ephemeral filesystem. Measure real memory and latency before changing instance size.

Before inviting users, finish upload admission/timeouts before body buffering and stale-upload recovery after crashes; the current processing concurrency guard begins after multipart buffering and an interrupted reservation can remain `uploading`. Rate limits, signup SMTP, physical native sharing/privacy, and a separate durable worker/job queue remain tracked work. Hosting preparation does not close them.
