import { boundText } from '../security/input';
import { LIMITS } from '../security/limits';
import type { ClaimValue } from './claim';
import type { Unit, ValueType } from './enums';

// SPEC §3: deterministic value normalization. Plain code, no LLM: the extractor supplies `raw`, this produces `normalized`.
//   numbers  "twee dagen" | "2 d" | "2 werkdagen" | "deux jours" | "two working days"  → {number 2, unit days}
//   dates    "1 januari 2027" | "01/01/2027" | "January 1, 2027" | "2027-01-01"         → ISO "2027-01-01"  (numeric dates are day-first)
//   money    "€ 1.234,56" | "EUR 1,234.56" | "8 euro"                                   → cents (unit eur)
//   pct      "120%" | "vijftig procent"                                                 → number, unit pct
//   range    "2-3 dagen" | "tussen 2 en 3 dagen" | "de 2 à 3 jours"                     → {min, max}
//   bool     yes/no, ja/nee, oui/non
// Anything it cannot read cleanly becomes {type:'text'}: better an honest text value than a wrong number.

export interface NormalizeHint {
  type?: ValueType; // 'enum' and 'text' are honoured; the others are detected
  unit?: Unit; // applied to a bare number ("2" for a duration slot → days)
}

const fold = (s: string) => s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();

// ---------- number words (NL / FR / EN, 0..999)
const WORDS: Record<string, number> = Object.create(null);
const add = (n: number, ...ws: string[]) => ws.forEach((w) => (WORDS[w] = n));
[
  [0, 'zero', 'nul'],
  [1, 'one', 'een', 'un', 'une'],
  [2, 'two', 'twee', 'deux'],
  [3, 'three', 'drie', 'trois'],
  [4, 'four', 'vier', 'quatre'],
  [5, 'five', 'vijf', 'cinq'],
  [6, 'six', 'zes'],
  [7, 'seven', 'zeven', 'sept'],
  [8, 'eight', 'acht', 'huit'],
  [9, 'nine', 'negen', 'neuf'],
  [10, 'ten', 'tien', 'dix'],
  [11, 'eleven', 'elf', 'onze'],
  [12, 'twelve', 'twaalf', 'douze'],
  [13, 'thirteen', 'dertien', 'treize'],
  [14, 'fourteen', 'veertien', 'quatorze'],
  [15, 'fifteen', 'vijftien', 'quinze'],
  [16, 'sixteen', 'zestien', 'seize'],
  [17, 'seventeen', 'zeventien'],
  [18, 'eighteen', 'achttien'],
  [19, 'nineteen', 'negentien'],
  [20, 'twenty', 'twintig', 'vingt', 'vingts'],
  [30, 'thirty', 'dertig', 'trente'],
  [40, 'forty', 'veertig', 'quarante'],
  [50, 'fifty', 'vijftig', 'cinquante'],
  [60, 'sixty', 'zestig', 'soixante'],
  [70, 'seventy', 'zeventig', 'septante'],
  [80, 'eighty', 'tachtig', 'huitante', 'octante'],
  [90, 'ninety', 'negentig', 'nonante'],
  [100, 'hundred', 'honderd', 'cent', 'cents'],
].forEach(([n, ...ws]) => add(n as number, ...(ws as string[])));
// NL compounds: eenentwintig, tweeëntwintig (folded: tweeentwintig), drieëndertig …
const NL_UNITS: [string, number][] = [['een', 1], ['twee', 2], ['drie', 3], ['vier', 4], ['vijf', 5], ['zes', 6], ['zeven', 7], ['acht', 8], ['negen', 9]];
const NL_TENS: [string, number][] = [['twintig', 20], ['dertig', 30], ['veertig', 40], ['vijftig', 50], ['zestig', 60], ['zeventig', 70], ['tachtig', 80], ['negentig', 90]];
for (const [u, uv] of NL_UNITS) for (const [t, tv] of NL_TENS) WORDS[`${u}en${t}`] = uv + tv;
const HUNDREDS = new Set(['hundred', 'honderd', 'cent', 'cents']);
const CONJ = new Set(['and', 'et', 'en']); // "one hundred AND twenty", "vingt ET un"; not "twee EN drie" (that is a range)

function parseWords(tokens: string[]): number | null {
  let cur = 0;
  let seen = false;
  let prev = '';
  for (const t of tokens) {
    if (CONJ.has(t) && seen && (WORDS[prev] ?? 0) >= 20) continue;
    const v = WORDS[t];
    if (v === undefined) return null;
    if ((t === 'vingt' || t === 'vingts') && prev === 'quatre') cur = cur - 4 + 80; // quatre-vingt(s) = 80
    else if (HUNDREDS.has(t)) cur = cur === 0 ? 100 : cur * 100;
    else cur += v;
    seen = true;
    prev = t;
  }
  return seen ? cur : null;
}

// ---------- decimals ("1,5" "1.5" "1.234,56" "1,234.56" "1.000")
function parseDecimal(s: string): number | null {
  if (!/^\d+(?:[.,]\d+)*$/.test(s)) return null;
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  let dec: '.' | ',' | null = null;
  if (lastDot >= 0 && lastComma >= 0) dec = lastDot > lastComma ? '.' : ',';
  else {
    const sep = lastDot >= 0 ? '.' : lastComma >= 0 ? ',' : null;
    if (sep) {
      const count = s.split(sep).length - 1;
      const trailing = s.length - s.lastIndexOf(sep) - 1;
      const intPart = s.slice(0, s.indexOf(sep));
      // single separator: decimal unless exactly 3 trailing digits (then thousands), except "0,750"
      if (count === 1 && (trailing !== 3 || intPart === '0')) dec = sep;
    }
  }
  let intDigits = s;
  let frac = '';
  if (dec) {
    const i = s.lastIndexOf(dec);
    intDigits = s.slice(0, i);
    frac = s.slice(i + 1);
  }
  intDigits = intDigits.replace(/[.,]/g, '');
  const n = Number(frac ? `${intDigits}.${frac}` : intDigits);
  return Number.isFinite(n) ? n : null;
}

// ---------- units
const UNITS: Record<string, Unit> = Object.create(null);
const unitsOf = (u: Unit, ...ws: string[]) => ws.forEach((w) => (UNITS[w] = u));
unitsOf('days', 'd', 'dag', 'dagen', 'werkdag', 'werkdagen', 'kalenderdag', 'kalenderdagen', 'jour', 'jours', 'jour ouvrable', 'jours ouvrables', 'jour ouvre', 'jours ouvres', 'jour calendrier', 'jours calendrier', 'day', 'days', 'working day', 'working days', 'business day', 'business days', 'workday', 'workdays', 'calendar day', 'calendar days');
unitsOf('hours', 'h', 'hr', 'hrs', 'u', 'uur', 'uren', 'hour', 'hours', 'heure', 'heures');
unitsOf('weeks', 'w', 'wk', 'week', 'weken', 'weeks', 'semaine', 'semaines');
unitsOf('months', 'maand', 'maanden', 'mnd', 'mois', 'month', 'months');
unitsOf('pct', '%', 'pct', 'procent', 'percent', 'pour cent', 'pourcent', 'percentage');
unitsOf('eur', 'eur', 'euro', 'euros', '€');

interface Quantity {
  n: number;
  unit?: Unit;
}

/** "2", "2 d", "twee dagen", "€ 8,50", "120 %" → number + optional unit. Null if anything is left unrecognised. */
function parseQuantity(input: string): Quantity | null {
  let f = fold(input);
  if (!f) return null;
  const prefixed = f.match(/^(?:€|eur|euros?)\s*(\d.*)$/); // "€ 8,50" → "8,50 eur"
  if (prefixed) f = `${prefixed[1]} eur`;
  f = f.replace(/[.;,]+$/, '');

  const m = f.match(/^(\d+(?:[.,]\d+)*)\s*(.*)$/);
  let n: number | null = null;
  let rest = '';
  if (m) {
    n = parseDecimal(m[1]!);
    rest = m[2]!;
  } else {
    const tokens = f.split(/[\s-]+/).filter(Boolean);
    for (let i = tokens.length; i >= 1 && n === null; i--) {
      const v = parseWords(tokens.slice(0, i));
      if (v !== null) {
        n = v;
        rest = tokens.slice(i).join(' ');
      }
    }
  }
  if (n === null) return null;
  rest = rest.replace(/^\((.*)\)$/, '$1').trim();
  if (rest === '') return { n };
  const unit = UNITS[rest];
  return unit ? { n, unit } : null;
}

const cents = (n: number) => Math.round(n * 100);
const finalizeNumber = (n: number, unit?: Unit) => (unit === 'eur' ? cents(n) : n);

// ---------- dates
const MONTHS: Record<string, number> = Object.create(null);
const month = (n: number, ...ws: string[]) => ws.forEach((w) => (MONTHS[w] = n));
month(1, 'jan', 'janv', 'january', 'januari', 'janvier');
month(2, 'feb', 'febr', 'february', 'februari', 'fevr', 'fevrier');
month(3, 'mar', 'march', 'maart', 'mrt', 'mars');
month(4, 'apr', 'april', 'avr', 'avril');
month(5, 'may', 'mei', 'mai');
month(6, 'jun', 'june', 'juni', 'juin');
month(7, 'jul', 'july', 'juli', 'juil', 'juillet');
month(8, 'aug', 'august', 'augustus', 'aout');
month(9, 'sep', 'sept', 'september', 'septembre');
month(10, 'oct', 'okt', 'october', 'oktober', 'octobre');
month(11, 'nov', 'november', 'novembre');
month(12, 'dec', 'december', 'decembre');

function isoDate(y: number, m: number, d: number): string | null {
  if (y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

function parseDate(f: string): string | null {
  let m = f.match(/^(\d{4})-(\d{2})-(\d{2})(?:[t ].*)?$/);
  if (m) return isoDate(+m[1]!, +m[2]!, +m[3]!);
  m = f.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/); // day-first (BE/NL/FR)
  if (m) return isoDate(+m[3]!, +m[2]!, +m[1]!);
  m = f.match(/^(\d{1,2})(?:st|nd|rd|th|er|ste|de|e)?\s+([a-z]+)\.?,?\s+(\d{4})$/);
  if (m && MONTHS[m[2]!]) return isoDate(+m[3]!, MONTHS[m[2]!]!, +m[1]!);
  m = f.match(/^([a-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/);
  if (m && MONTHS[m[1]!]) return isoDate(+m[3]!, MONTHS[m[1]!]!, +m[2]!);
  return null;
}

// ---------- ranges
const RANGE_PREFIX = /^(?:tussen|between|entre|de|du|van|from)\s+/;
const RANGE_SEP = /\s+(?:tot en met|tot|to|a|et|and|en)\s+|\s*[-–—]\s*/g;

function parseRange(f: string): { min: number; max: number; unit?: Unit } | null {
  const s = f.replace(RANGE_PREFIX, '');
  for (const m of s.matchAll(RANGE_SEP)) {
    const a = parseQuantity(s.slice(0, m.index));
    const b = parseQuantity(s.slice(m.index + m[0].length));
    if (!a || !b || (a.unit && b.unit && a.unit !== b.unit)) continue;
    const unit = a.unit ?? b.unit;
    const min = finalizeNumber(a.n, unit);
    const max = finalizeNumber(b.n, unit);
    if (min > max) continue;
    return { min, max, unit };
  }
  return null;
}

const BOOL: Record<string, boolean> = { yes: true, true: true, ja: true, oui: true, waar: true, vrai: true, no: false, false: false, nee: false, non: false, onwaar: false, faux: false };

/** Normalize a raw extracted value. Pure and deterministic. */
export function normalizeValue(raw: string, hint: NormalizeHint = {}): ClaimValue {
  const r = boundText(raw, LIMITS.normalizerChars).trim();
  const f = fold(r);
  const text = (): ClaimValue => ({ type: 'text', raw: r, normalized: f });

  if (hint.type === 'enum') return { type: 'enum', raw: r, normalized: f.replace(/\s+/g, '_') };
  if (hint.type === 'text' || f === '') return text();

  if (Object.hasOwn(BOOL, f)) return { type: 'bool', raw: r, normalized: BOOL[f]! };

  const date = parseDate(f);
  if (date) return { type: 'date', raw: r, normalized: date };

  // a plain quantity wins over a range, otherwise "quatre-vingt" would read as 4–20
  const q = parseQuantity(f);
  if (q) {
    const unit = q.unit ?? hint.unit;
    return { type: 'number', raw: r, normalized: finalizeNumber(q.n, unit), ...(unit ? { unit } : {}) };
  }

  const range = parseRange(f);
  if (range) return { type: 'range', raw: r, normalized: { min: range.min, max: range.max }, ...(range.unit ? { unit: range.unit } : {}) };
  return text();
}
