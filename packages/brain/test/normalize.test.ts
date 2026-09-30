import { describe, expect, it } from 'vitest';
import { normalizeValue, type NormalizeHint } from '../src/domain';

type Row = [input: string, expected: { type: string; normalized: unknown; unit?: string }, hint?: NormalizeHint];

const run = (rows: Row[]) =>
  it.each(rows)('%s', (input, expected, hint) => {
    const v = normalizeValue(input, hint);
    expect(v.raw).toBe(input.trim());
    expect({ type: v.type, normalized: v.normalized, unit: v.unit }).toEqual({ unit: undefined, ...expected });
  });

describe('numbers with units (days)', () => {
  run([
    ['2', { type: 'number', normalized: 2 }],
    ['2 d', { type: 'number', normalized: 2, unit: 'days' }],
    ['2d', { type: 'number', normalized: 2, unit: 'days' }],
    ['2 dagen', { type: 'number', normalized: 2, unit: 'days' }],
    ['2 werkdagen', { type: 'number', normalized: 2, unit: 'days' }],
    ['2 kalenderdagen', { type: 'number', normalized: 2, unit: 'days' }],
    ['2 jours ouvrables', { type: 'number', normalized: 2, unit: 'days' }],
    ['2 jours', { type: 'number', normalized: 2, unit: 'days' }],
    ['2 days', { type: 'number', normalized: 2, unit: 'days' }],
    ['2 working days', { type: 'number', normalized: 2, unit: 'days' }],
    ['2 business days.', { type: 'number', normalized: 2, unit: 'days' }],
    ['1,5 dagen', { type: 'number', normalized: 1.5, unit: 'days' }],
    ['0.5 day', { type: 'number', normalized: 0.5, unit: 'days' }],
    ['  3 Dagen  ', { type: 'number', normalized: 3, unit: 'days' }],
    ['2', { type: 'number', normalized: 2, unit: 'days' }, { unit: 'days' }],
  ]);
});

describe('number words (NL / FR / EN)', () => {
  run([
    ['twee dagen', { type: 'number', normalized: 2, unit: 'days' }],
    ['drie werkdagen', { type: 'number', normalized: 3, unit: 'days' }],
    ['een dag', { type: 'number', normalized: 1, unit: 'days' }],
    ['tien dagen', { type: 'number', normalized: 10, unit: 'days' }],
    ['eenentwintig dagen', { type: 'number', normalized: 21, unit: 'days' }],
    ['tweeëntwintig dagen', { type: 'number', normalized: 22, unit: 'days' }],
    ['achtenveertig uur', { type: 'number', normalized: 48, unit: 'hours' }],
    ['honderd twintig', { type: 'number', normalized: 120 }],
    ['deux jours', { type: 'number', normalized: 2, unit: 'days' }],
    ['trois jours ouvrables', { type: 'number', normalized: 3, unit: 'days' }],
    ['vingt et un jours', { type: 'number', normalized: 21, unit: 'days' }],
    ['trente-deux heures', { type: 'number', normalized: 32, unit: 'hours' }],
    ['soixante-dix-sept', { type: 'number', normalized: 77 }],
    ['quatre-vingt-dix-sept', { type: 'number', normalized: 97 }],
    ['quatre-vingts', { type: 'number', normalized: 80 }],
    ['two days', { type: 'number', normalized: 2, unit: 'days' }],
    ['two working days', { type: 'number', normalized: 2, unit: 'days' }],
    ['twenty-one days', { type: 'number', normalized: 21, unit: 'days' }],
    ['twenty one hours', { type: 'number', normalized: 21, unit: 'hours' }],
    ['one hundred and twenty', { type: 'number', normalized: 120 }],
    ['two hundred', { type: 'number', normalized: 200 }],
  ]);
});

describe('other units', () => {
  run([
    ['38 uur', { type: 'number', normalized: 38, unit: 'hours' }],
    ['38h', { type: 'number', normalized: 38, unit: 'hours' }],
    ['8 heures', { type: 'number', normalized: 8, unit: 'hours' }],
    ['4 weken', { type: 'number', normalized: 4, unit: 'weeks' }],
    ['vier weken', { type: 'number', normalized: 4, unit: 'weeks' }],
    ['deux semaines', { type: 'number', normalized: 2, unit: 'weeks' }],
    ['3 months', { type: 'number', normalized: 3, unit: 'months' }],
    ['6 maanden', { type: 'number', normalized: 6, unit: 'months' }],
    ['2 mois', { type: 'number', normalized: 2, unit: 'months' }],
  ]);
});

describe('percentages', () => {
  run([
    ['120%', { type: 'number', normalized: 120, unit: 'pct' }],
    ['120 %', { type: 'number', normalized: 120, unit: 'pct' }],
    ['50,5%', { type: 'number', normalized: 50.5, unit: 'pct' }],
    ['50 procent', { type: 'number', normalized: 50, unit: 'pct' }],
    ['vijftig procent', { type: 'number', normalized: 50, unit: 'pct' }],
    ['50 percent', { type: 'number', normalized: 50, unit: 'pct' }],
    ['50 pour cent', { type: 'number', normalized: 50, unit: 'pct' }],
  ]);
});

describe('money → EUR cents', () => {
  run([
    ['€8', { type: 'number', normalized: 800, unit: 'eur' }],
    ['€ 8,50', { type: 'number', normalized: 850, unit: 'eur' }],
    ['8,50 €', { type: 'number', normalized: 850, unit: 'eur' }],
    ['€8.00', { type: 'number', normalized: 800, unit: 'eur' }],
    ['EUR 1.234,56', { type: 'number', normalized: 123456, unit: 'eur' }],
    ['EUR 1,234.56', { type: 'number', normalized: 123456, unit: 'eur' }],
    ['€ 1.000', { type: 'number', normalized: 100000, unit: 'eur' }],
    ['1234,5 euro', { type: 'number', normalized: 123450, unit: 'eur' }],
    ['8 euro', { type: 'number', normalized: 800, unit: 'eur' }],
    ['acht euro', { type: 'number', normalized: 800, unit: 'eur' }],
    ['0,75 EUR', { type: 'number', normalized: 75, unit: 'eur' }],
    ['0,750 EUR', { type: 'number', normalized: 75, unit: 'eur' }],
  ]);
});

describe('dates → ISO', () => {
  run([
    ['2027-01-01', { type: 'date', normalized: '2027-01-01' }],
    ['2026-09-25T10:42:00Z', { type: 'date', normalized: '2026-09-25' }],
    ['01/01/2027', { type: 'date', normalized: '2027-01-01' }],
    ['25-09-2026', { type: 'date', normalized: '2026-09-25' }],
    ['25.09.2026', { type: 'date', normalized: '2026-09-25' }],
    ['1 januari 2027', { type: 'date', normalized: '2027-01-01' }],
    ['1 janvier 2027', { type: 'date', normalized: '2027-01-01' }],
    ['1er janvier 2027', { type: 'date', normalized: '2027-01-01' }],
    ['1 January 2027', { type: 'date', normalized: '2027-01-01' }],
    ['January 1, 2027', { type: 'date', normalized: '2027-01-01' }],
    ['3rd March 2026', { type: 'date', normalized: '2026-03-03' }],
    ['15 maart 2026', { type: 'date', normalized: '2026-03-15' }],
    ['12 août 2025', { type: 'date', normalized: '2025-08-12' }],
    ['31 dec 2026', { type: 'date', normalized: '2026-12-31' }],
    ['1 sept. 2026', { type: 'date', normalized: '2026-09-01' }],
    ['1 mei 2026', { type: 'date', normalized: '2026-05-01' }],
  ]);
  it('rejects impossible dates (falls back to text)', () => {
    expect(normalizeValue('31/02/2026').type).toBe('text');
    expect(normalizeValue('2026-13-01').type).not.toBe('date');
    expect(normalizeValue('32 januari 2026').type).toBe('text');
  });
});

describe('ranges', () => {
  run([
    ['2-3 dagen', { type: 'range', normalized: { min: 2, max: 3 }, unit: 'days' }],
    ['2 - 3 dagen', { type: 'range', normalized: { min: 2, max: 3 }, unit: 'days' }],
    ['2–3 days', { type: 'range', normalized: { min: 2, max: 3 }, unit: 'days' }],
    ['2 tot 3 dagen', { type: 'range', normalized: { min: 2, max: 3 }, unit: 'days' }],
    ['2 to 3 days', { type: 'range', normalized: { min: 2, max: 3 }, unit: 'days' }],
    ['de 2 à 3 jours', { type: 'range', normalized: { min: 2, max: 3 }, unit: 'days' }],
    ['tussen 2 en 3 dagen', { type: 'range', normalized: { min: 2, max: 3 }, unit: 'days' }],
    ['between two and three days', { type: 'range', normalized: { min: 2, max: 3 }, unit: 'days' }],
    ['twee en drie dagen', { type: 'range', normalized: { min: 2, max: 3 }, unit: 'days' }],
    ['2 dagen tot 3 dagen', { type: 'range', normalized: { min: 2, max: 3 }, unit: 'days' }],
    ['50-60%', { type: 'range', normalized: { min: 50, max: 60 }, unit: 'pct' }],
    ['€5 tot €10', { type: 'range', normalized: { min: 500, max: 1000 }, unit: 'eur' }],
  ]);
  it('does not treat a descending or mixed-unit pair as a range', () => {
    expect(normalizeValue('3-2 dagen').type).not.toBe('range');
    expect(normalizeValue('2 dagen tot 3 uur').type).not.toBe('range');
  });
});

describe('booleans', () => {
  run([
    ['ja', { type: 'bool', normalized: true }],
    ['Nee', { type: 'bool', normalized: false }],
    ['oui', { type: 'bool', normalized: true }],
    ['non', { type: 'bool', normalized: false }],
    ['Yes', { type: 'bool', normalized: true }],
    ['false', { type: 'bool', normalized: false }],
  ]);
});

describe('enum and text fallbacks', () => {
  run([
    ['Bediende', { type: 'enum', normalized: 'bediende' }, { type: 'enum' }],
    ['Volledig loon', { type: 'enum', normalized: 'volledig_loon' }, { type: 'enum' }],
    ['Op de dag van het huwelijk of binnen 4 maanden', { type: 'text', normalized: 'op de dag van het huwelijk of binnen 4 maanden' }],
    ['2 dagen per jaar', { type: 'text', normalized: '2 dagen per jaar' }],
    ['3 jaar', { type: 'text', normalized: '3 jaar' }],
    ['huwelijksakte', { type: 'text', normalized: 'huwelijksakte' }],
    ['', { type: 'text', normalized: '' }],
    ['12', { type: 'text', normalized: '12' }, { type: 'text' }],
  ]);
});

it('is deterministic on bounded odd input', () => {
  for (const s of ['€', '%', '-', ' - ', '2-', '-2', '1,2,3,4', '1..2', '\u0000', 'NaN', 'Infinity']) {
    const a = normalizeValue(s);
    expect(normalizeValue(s)).toEqual(a);
    expect(a.raw.length).toBeLessThanOrEqual(500);
  }
});


it('rejects oversized values before normalization and treats prototype names as text', () => {
  expect(() => normalizeValue('a'.repeat(2000))).toThrow('Input too large');
  for (const raw of ['constructor', 'toString', '__proto__', '1 constructor']) expect(normalizeValue(raw).type).toBe('text');
});
