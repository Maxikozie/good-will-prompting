import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { splitSections } from '../src/reference';
import { DEMO_DIR } from '../src/store/seed';

const ROOT = path.resolve(path.dirname(DEMO_DIR), '..', '..');

describe('slot template', () => {
  it('matches SPEC §4 exactly', () => {
    const y = parse(fs.readFileSync(path.join(ROOT, 'slots', 'leave.small_leave.own_marriage.yaml'), 'utf8'));
    expect(y).toEqual({
      subject: 'leave.small_leave.own_marriage',
      label: 'Klein verlet — eigen huwelijk',
      impact: 'high',
      slots: [
        { id: 'duration', attribute: 'duration', required: true, weight: 1.0, valueType: 'number', unit: 'days' },
        { id: 'eligibility', attribute: 'eligibility', required: true, weight: 1.0 },
        { id: 'timing_window', attribute: 'timing_window', required: true, weight: 0.8 },
        { id: 'pay_continuation', attribute: 'pay_continuation', required: true, weight: 0.8 },
        { id: 'proof_required', attribute: 'proof_required', required: false, weight: 0.5 },
        { id: 'legal_basis', attribute: 'legal_basis', required: false, weight: 0.5 },
        { id: 'effective_from', attribute: 'effective_from', required: false, weight: 0.25 },
      ],
      halfLifeDays: 365,
    });
  });
});

describe('demo fixtures', () => {
  it('are labelled as fictional demo data', () => {
    const readme = fs.readFileSync(path.join(DEMO_DIR, 'README.md'), 'utf8');
    expect(readme).toMatch(/FICTIEVE DEMODATA/);
    expect(readme).toMatch(/Fictional demo data/);
  });

  it('are Dutch HR text (spot check)', () => {
    for (const f of ['evidence/A.md', 'evidence/B.md', 'evidence/C.md', 'evidence/D.md', 'reference/W1.md', 'reference/W3.md']) {
      expect(fs.readFileSync(path.join(DEMO_DIR, f), 'utf8')).toMatch(/\b(de|het|een|voor|werknemer)\b/);
    }
  });
});

describe('splitSections', () => {
  it('splits heading-aware with correct offsets, keeping the intro', () => {
    const t = '# Titel\n\nIntro.\n\n## Een\n\nTekst een.\n\n## Twee\n\nTekst twee.\n';
    const s = splitSections(t);
    expect(s.map((x) => x.headingPath)).toEqual([['Titel'], ['Titel', 'Een'], ['Titel', 'Twee']]);
    for (const x of s) expect(t.slice(x.start, x.end)).toBe(x.text);
    expect(s[1]!.text).toBe('## Een\n\nTekst een.');
  });
  it('handles text without headings and empty input', () => {
    expect(splitSections('Alleen tekst.')).toHaveLength(1);
    expect(splitSections('')).toEqual([]);
  });
});
