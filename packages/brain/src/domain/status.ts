import type { FactStatus } from './enums';

/** Highest status a fact that rests only on reference facts may have. */
export const REFERENCE_ONLY_CEILING: FactStatus = 'PROVISIONAL';

/** Apply the reference-only ceiling: VERIFIED / LIKELY become PROVISIONAL; every other status is unchanged. */
export function capStatus(status: FactStatus, referenceOnly: boolean): FactStatus {
  return referenceOnly && (status === 'VERIFIED' || status === 'LIKELY') ? REFERENCE_ONLY_CEILING : status;
}
