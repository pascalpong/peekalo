/** These limits are descriptive until server authorization is implemented. */
export const REVEAL_BUDGET_MS = 10_000;
export const MAX_VIDEO_DURATION_MS = 10_000;

/** Proposed default, not a confirmed lifetime-upload or attachment limit. */
export const PROVISIONAL_ACTIVE_MEDIA_LIMIT = 3;

export type MediaKind = 'photo' | 'video';
