/**
 * Cross-session claims. DSH starts one MCP process per conversation, so a claim
 * identifies "this conversation is working on that issue". Claims expire so a
 * crashed or abandoned conversation cannot lock an issue forever.
 */
export const CLAIM_TTL_MS = 2 * 60 * 60 * 1000;

/** ISO cutoff: claims older than this are considered abandoned. */
export function claimCutoff(ttlMs: number = CLAIM_TTL_MS): string {
  return new Date(Date.now() - ttlMs).toISOString();
}

export function isClaimFresh(claimedAt: string | null | undefined, ttlMs: number = CLAIM_TTL_MS): boolean {
  if (!claimedAt) return false;
  const at = Date.parse(claimedAt);
  if (!Number.isFinite(at)) return false;
  return at >= Date.now() - ttlMs;
}
