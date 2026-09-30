import type { IssueType, Person, Task, Verdict } from '../../src/core/types';

// MOCK mail: "asking a colleague" is shown as an email. Nothing is actually sent. The email is a TrustLayer
// fix task (POST /api/tasks), and the owner's reply resolves it (POST /api/tasks/:id/resolve).

const SUBJECT: Record<IssueType, string> = {
  conflict: 'Conflicting info',
  capture: 'Please confirm',
  unverified: 'Please verify',
  stale: 'Please re-check',
  orphan: 'Needs an owner',
  gap: 'Question nobody could answer',
};

export function subjectFor(t: Pick<Task, 'issue' | 'topic_label'>): string {
  return `${SUBJECT[t.issue]}: ${t.topic_label}`;
}

const first = (name: string) => name.split(' ')[0];

/** The email a colleague sends from the Ask screen, built from the verdict. Max 1000 chars (API limit). */
export function emailFromVerdict(v: Verdict, owner: Person, sender: Person | null): string {
  const lines = [`Hi ${first(owner.name)},`, '', `A customer is on the line asking: "${v.question}"`, ''];
  const c = v.conflicts[0];
  if (c) {
    lines.push(`TrustLayer found ${c.sides.length} sources that disagree:`);
    for (const s of c.sides) lines.push(`- ${s.value}: ${s.title}${s.owner_name ? ` (${s.owner_name})` : ' (no owner)'}`);
  } else if (v.recommended) {
    lines.push(`The best source I have is not verified yet: ${v.recommended.title}.`);
  } else {
    lines.push('I could not find a trustworthy source for this.');
  }
  lines.push('', 'Could you reply with the correct answer? Your reply becomes the verified answer for everyone.', '', 'Thanks,');
  if (sender) lines.push(sender.name, sender.team);
  return lines.join('\n').slice(0, 1000);
}

/** The email the radar sends when someone clicks "Email owner". */
export function emailFromRadar(detail: string, sender: Person | null): string {
  return [
    'Hi,',
    '',
    `TrustLayer's knowledge radar flagged this: ${detail}.`,
    '',
    'Could you check it and reply with the correct information?',
    '',
    'Thanks,',
    sender?.name ?? 'TrustLayer',
  ]
    .join('\n')
    .slice(0, 1000);
}

export function initials(name: string): string {
  return name
    .split(' ')
    .map((p) => p[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
}
