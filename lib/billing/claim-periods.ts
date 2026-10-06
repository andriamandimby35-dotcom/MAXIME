// Périodes de facturation : une facture couvre une période (début → fin).
// Quand on demande une facture « entre deux dates », l'application cherche les
// jours de cette période qui ne sont PAS déjà couverts par une facture
// existante, et propose une facture par « trou » (ex : du 1er au 19 juin et
// du 2 au 20 août si une facture couvre déjà du 20 juin au 1er août).

export type ClaimPeriodRow = { id?: string; period_start?: string | null; period_end?: string | null; issue_date: string; created_at?: string | null; claim_number?: string | null };
export type Gap = { start: string; end: string };

const DAY_MS = 86_400_000;
const toTime = (value: string) => Date.UTC(Number(value.slice(0, 4)), Number(value.slice(5, 7)) - 1, Number(value.slice(8, 10)));
const toDate = (time: number) => new Date(time).toISOString().slice(0, 10);

export const todayKey = () => new Date().toISOString().slice(0, 10);
export const dayBefore = (value: string) => toDate(toTime(value) - DAY_MS);
export const dayAfter = (value: string) => toDate(toTime(value) + DAY_MS);
export const isDateKey = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value);

/** Fin réelle d'une facture : sa fin de période, sinon sa date d'émission (anciennes factures). */
export const claimEnd = (claim: ClaimPeriodRow) => String(claim.period_end || claim.issue_date).slice(0, 10);
/** Début réel : sa début de période ; une ancienne facture sans période couvre « depuis toujours ». */
export const claimStart = (claim: ClaimPeriodRow) => (claim.period_start ? String(claim.period_start).slice(0, 10) : "0001-01-01");

/** Les trous (jours non facturés) à l'intérieur de [rangeStart, rangeEnd]. */
export function computeGaps(claims: ClaimPeriodRow[], rangeStart: string, rangeEnd: string): Gap[] {
  if (rangeStart > rangeEnd) return [];
  const covered = claims
    .map((claim) => ({ start: claimStart(claim), end: claimEnd(claim) }))
    .filter((interval) => interval.end >= interval.start)
    .sort((a, b) => a.start.localeCompare(b.start));
  const gaps: Gap[] = [];
  let cursor = rangeStart;
  for (const interval of covered) {
    if (interval.end < cursor) continue;
    if (interval.start > rangeEnd) break;
    if (interval.start > cursor) gaps.push({ start: cursor, end: dayBefore(interval.start) > rangeEnd ? rangeEnd : dayBefore(interval.start) });
    cursor = dayAfter(interval.end);
    if (cursor > rangeEnd) break;
  }
  if (cursor <= rangeEnd) gaps.push({ start: cursor, end: rangeEnd });
  return gaps.filter((gap) => gap.start <= gap.end);
}

/** La facture qui précède une période : celle dont la fin est la plus récente avant son début. */
export function baseClaimBefore<T extends ClaimPeriodRow>(claims: T[], periodStart: string): T | null {
  let best: T | null = null;
  for (const claim of claims) {
    const end = claimEnd(claim);
    if (end >= periodStart) continue;
    if (!best || end > claimEnd(best) || (end === claimEnd(best) && String(claim.created_at ?? "") > String(best.created_at ?? ""))) best = claim;
  }
  return best;
}
