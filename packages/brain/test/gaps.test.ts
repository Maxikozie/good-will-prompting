import { describe, expect, it } from 'vitest';
import type { Scope, SlotTemplate } from '../src/domain';
import { detectGaps, loadSlotTemplates, type GapClaim, type GapFact } from '../src/rules';

const template: SlotTemplate = loadSlotTemplates().find((t) => t.subject === 'leave.small_leave.own_marriage')!;
const query: Scope = { country: 'BE', jointCommittee: 'PC 200', employeeCategory: 'bediende' };
const TH = { scoreBelow: 60, lowAuthorityBelow: 0.5 };

const claim = (id: string, over: Partial<GapClaim> = {}): GapClaim => ({ id, modality: 'rule', scope: { country: 'BE', jointCommittee: 'PC 200' }, score: 80, authority: 0.85, group: 'g1', effectiveFrom: '2024-01-01', ...over });
const fact = (attribute: string, over: Partial<GapFact> = {}): GapFact => {
  const slot = template.slots.find((s) => s.attribute === attribute);
  return { factId: `f-${attribute}`, attribute, ...(slot ? { slotId: slot.id } : {}), inScope: true, claims: [claim(`c-${attribute}`)], hasContradiction: false, ...over };
};
const full = () => template.slots.map((s) => fact(s.attribute));
const types = (g: ReturnType<typeof detectGaps>) => g.map((x) => `${x.type}:${x.slotId ?? ''}`);

describe('detectGaps', () => {
  it('no gaps when every slot is covered, well supported, scoped and dated', () => {
    expect(detectGaps(template, query, full(), TH)).toEqual([]);
  });

  it('MISSING_SLOT for each required AND optional slot without a live fact', () => {
    const facts = full().filter((f) => f.attribute !== 'legal_basis' && f.attribute !== 'effective_from' && f.attribute !== 'timing_window');
    const g = detectGaps(template, query, facts, TH);
    expect(types(g)).toEqual(['MISSING_SLOT:timing_window', 'MISSING_SLOT:legal_basis', 'MISSING_SLOT:effective_from']);
    expect(g[0]!.description).toMatch(/required/);
    expect(g[1]!.description).toMatch(/optional/);
    expect(g.every((x) => !x.factId)).toBe(true);
  });

  it('a fact outside the query scope, or with only non-rule claims, does not fill a slot', () => {
    const facts = full().map((f) => (f.attribute === 'duration' ? { ...f, inScope: false } : f.attribute === 'eligibility' ? { ...f, claims: [claim('x', { modality: 'unknown' })] } : f));
    expect(types(detectGaps(template, query, facts, TH))).toEqual(['MISSING_SLOT:duration', 'MISSING_SLOT:eligibility']);
  });

  it('UNRESOLVED_CONFLICT links to the fact and its slot', () => {
    const facts = full().map((f) => (f.attribute === 'duration' ? { ...f, hasContradiction: true } : f));
    const g = detectGaps(template, query, facts, TH);
    expect(g).toEqual([expect.objectContaining({ type: 'UNRESOLVED_CONFLICT', slotId: 'duration', factId: 'f-duration' })]);
  });

  it('WEAK_SUPPORT: best score below the threshold, or a single low-authority source', () => {
    const weakScore = full().map((f) => (f.attribute === 'proof_required' ? { ...f, claims: [claim('w', { score: 59.9 })] } : f));
    expect(types(detectGaps(template, query, weakScore, TH))).toEqual(['WEAK_SUPPORT:proof_required']);

    const lowAuthority = full().map((f) => (f.attribute === 'proof_required' ? { ...f, claims: [claim('t', { authority: 0.4, score: 70 })] } : f));
    expect(types(detectGaps(template, query, lowAuthority, TH))).toEqual(['WEAK_SUPPORT:proof_required']);

    // two independent low-authority sources are not "single"; one strong claim in the group is enough
    const twoSources = full().map((f) => (f.attribute === 'proof_required' ? { ...f, claims: [claim('t1', { authority: 0.4, group: 'g1' }), claim('t2', { authority: 0.4, group: 'g2' })] } : f));
    expect(detectGaps(template, query, twoSources, TH)).toEqual([]);
    const strongInGroup = full().map((f) => (f.attribute === 'proof_required' ? { ...f, claims: [claim('t1', { authority: 0.4 }), claim('t2', { authority: 0.85 })] } : f));
    expect(detectGaps(template, query, strongInGroup, TH)).toEqual([]);
  });

  it('MISSING_SCOPE when the best claim does not state the country / joint committee the question is about', () => {
    const noPc = full().map((f) => (f.attribute === 'pay_continuation' ? { ...f, claims: [claim('n', { scope: { country: 'BE' } })] } : f));
    const g = detectGaps(template, query, noPc, TH);
    expect(g).toEqual([expect.objectContaining({ type: 'MISSING_SCOPE', slotId: 'pay_continuation' })]);
    expect(g[0]!.description).toContain('jointCommittee');

    const undeclaredCountry = full().map((f) => (f.attribute === 'pay_continuation' ? { ...f, claims: [claim('n', { scope: { country: null, jointCommittee: 'PC 200' } })] } : f));
    expect(detectGaps(template, query, undeclaredCountry, TH)[0]!.description).toContain('country');

    // a query that does not state a joint committee needs none
    expect(detectGaps(template, { country: 'BE' }, noPc, TH)).toEqual([]);
  });

  it('MISSING_TEMPORAL only for the numeric slot of a high-impact template', () => {
    const undated = full().map((f) => ({ ...f, claims: f.claims.map((c) => ({ ...c, effectiveFrom: undefined })) }));
    const g = detectGaps(template, query, undated, TH);
    expect(types(g)).toEqual(['MISSING_TEMPORAL:duration']); // eligibility & co. stay gap-free
    expect(detectGaps({ ...template, impact: 'medium' }, query, undated, TH)).toEqual([]);
  });

  it('the best claim decides: a strong claim rescues a fact whose other claim is weak', () => {
    const facts = full().map((f) => (f.attribute === 'duration' ? { ...f, claims: [claim('weak', { score: 30, scope: { country: 'BE' } }), claim('strong')] } : f));
    expect(detectGaps(template, query, facts, TH)).toEqual([]);
  });

  it('is deterministic and ordered by gap type', () => {
    const facts = full().filter((f) => f.attribute !== 'legal_basis').map((f) => (f.attribute === 'duration' ? { ...f, hasContradiction: true } : f));
    const a = detectGaps(template, query, facts, TH);
    const b = detectGaps(template, query, [...facts].reverse(), TH);
    expect(a).toEqual(b);
    expect(types(a)).toEqual(['MISSING_SLOT:legal_basis', 'UNRESOLVED_CONFLICT:duration']);
  });
});
