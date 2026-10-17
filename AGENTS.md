# Peekalo project instructions

Peekalo is a camera-first photo/video sharing app for iOS and Android, with anonymous single-use web links. The repository has a pnpm mobile/web foundation, shared contracts, local photo/video capture/review and a fixture-based local reveal demo. Separate backend/sharing code is under integration; the local demo does not verify live authorization, uploads, server viewing allowances or real sharing. Read the build board for actual verification status.

## Start each task

- Read `docs/BUILD_BOARD.md` for current work and `docs/DECISIONS.md` for accepted requirements and provisional defaults.
- Consult `docs/PEEKALO_PLAN.md` for architecture/privacy reasoning and `docs/MVP_BACKLOG.md` for detailed acceptance criteria. Human instructions in the current conversation take precedence.
- Work on one bounded deliverable at a time. Use specialist agents for independent implementation/review tasks with clear file ownership; integrate and verify their results.
- Preserve unrelated changes. When implementation starts, use a `codex/` feature branch and the existing suitable checkout; create worktrees only when isolation is useful.

## Product rules

- Name: Peekalo. Default native flow: Camera -> capture -> review/retake -> send to chosen accounts or create a link.
- Bottom navigation: Inbox left, a prominent Camera button in the center, Profile right. Tapping Camera opens the in-app camera.
- Shared photos/videos must originate from in-app camera capture. No gallery, photo-library or file imports; backend uploads of those captures to private storage are still required.
- Tap the shutter for a photo; hold to record video, release to stop, maximum ten seconds. Preview/review and photos use a consistent portrait 9:16 frame. Photos and videos up to ten seconds. The three-active-media-items limit is provisional until clarified; do not silently treat it as lifetime uploads or three attachments per message.
- Received media is hidden by default. Hold reveals; release/cancel/interruption hides. Allow up to ten seconds total per identity/post across holds, not per hold.
- Native direct sharing requires an owner-created recipient grant and accepted request state. Only owners grant/revoke access to their media.
- External links are anonymous and globally single-use. The first deliberate reveal atomically binds the link to one identity; previews/unfurl GETs never consume it. Cookie resets cannot reopen a claimed link.
- Native comments/chat are in scope later. Public web stays profiles and shared viewing, plus necessary operational pages.

## Privacy and backend rules

- Public previews must be separate processed blurred assets or opaque placeholders. Never protect an already downloaded original with a removable visual blur.
- Clear viewer media stays private and passes through authorized delivery. Server transactions govern link claims, cumulative budgets, concurrency and upload limits.
- Do not claim that timers, no-store headers, link revocation or native capture mitigations can erase delivered bytes or guarantee capture prevention.
- No secrets, privileged database keys, real user/private media, raw share tokens or message bodies in client bundles, logs or committed files. Clearly identified non-sensitive demo/test fixtures may be committed for reproducible development; they do not establish privacy protection. No session replay on protected screens.
- Local mocks must be labeled as prototypes; they do not verify server authorization, single-use links, cross-device quotas or native capture protection.
- Real-device evidence is required for camera/capture/privacy claims. Report simulator-only verification accurately.

## Implementation and verification

- Planned stack: TypeScript, Expo/React Native, Next.js, Supabase and a trusted media worker. Pin compatible supported versions when scaffolding; prefer pnpm since it is installed. Do not add an AI backend or custom skill without a real product/workflow need.
- Introduce the proposed code directories when scaffolding useful code; do not add empty placeholders for every future service.
- Commands: `pnpm dev:web`, `pnpm dev:mobile`, `pnpm ios` (Debug simulator), `pnpm android`, and `pnpm check` (lint, typecheck, mobile lifecycle tests, shared reveal tests, web build, mobile JS exports). See README for native prerequisites and limits. Run checks relevant to each change.
- Write meaningful tests for budgets, atomic claims, grants, limits and lifecycle behavior. Avoid tests that merely mirror markup or implementation details.
- Keep `docs/BUILD_BOARD.md` current: planned, implemented and verified are distinct. Record actual validation or explicit pending evidence; never mark device testing complete based on source inspection.
- Update `docs/DECISIONS.md` when requirements change and adjust the plan/backlog where affected. Do not duplicate long specifications in new documents.
