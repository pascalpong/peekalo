/** Product limits; authorization and quota reservations are enforced server-side. */
export const REVEAL_BUDGET_MS = 10_000;
export const MAX_VIDEO_DURATION_MS = 10_000;

/** Three active moments per account; deletion frees a slot (D-25). */
export const ACTIVE_MEDIA_LIMIT = 3;

export type MediaKind = 'photo' | 'video';
