// Small shared display helpers.

export function scoreText(score: number): string {
  return score >= 70 ? 'text-emerald-600' : score >= 40 ? 'text-amber-500' : 'text-red-600';
}

export function fmtDate(iso: string): string {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function ago(iso: string): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (isNaN(days)) return iso;
  if (days < 1) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  if (days < 365) return `${Math.round(days / 30)} mo ago`;
  const y = Math.max(1, Math.round(days / 365));
  return `${y} year${y > 1 ? 's' : ''} ago`;
}
