import { describe, expect, it } from 'vitest';
import { claimKey, differingScopeKeys, mergeScope, scopeKey } from '../src/domain';

const ALL_WILDCARD = 'country=*;region=*;jointCommittee=*;employeeCategory=*;product=*;customerId=*';

describe('scopeKey', () => {
  it('is order-independent', () => {
    const a = scopeKey({ country: 'BE', jointCommittee: 'PC 200', employeeCategory: 'bediende' });
    const b = scopeKey({ employeeCategory: 'bediende', country: 'BE', jointCommittee: 'PC 200' });
    expect(a).toBe(b);
  });

  it('is null-safe: null, undefined, {} and null fields are all wildcards', () => {
    expect(scopeKey(null)).toBe(ALL_WILDCARD);
    expect(scopeKey(undefined)).toBe(ALL_WILDCARD);
    expect(scopeKey({})).toBe(ALL_WILDCARD);
    expect(scopeKey({ country: null, region: undefined, product: '' as never })).toBe(ALL_WILDCARD);
  });

  it('normalizes case, spaces, punctuation and diacritics', () => {
    expect(scopeKey({ jointCommittee: 'PC 200' })).toBe(scopeKey({ jointCommittee: 'pc200' }));
    expect(scopeKey({ jointCommittee: 'PC-200' })).toBe(scopeKey({ jointCommittee: 'pc 200' }));
    expect(scopeKey({ customerId: 'Nordwind  Retail' })).toBe(scopeKey({ customerId: 'nordwindretail' }));
    expect(scopeKey({ region: 'Liège' })).toBe(scopeKey({ region: 'liege' }));
  });

  it('distinguishes different values and dimensions', () => {
    expect(scopeKey({ country: 'BE' })).not.toBe(scopeKey({ country: 'NL' }));
    expect(scopeKey({ country: 'BE' })).not.toBe(scopeKey({ region: 'BE' }));
    expect(scopeKey({ jointCommittee: 'PC 200' })).not.toBe(scopeKey({ jointCommittee: 'PC 311' }));
  });

  it('ignores language (same rule in NL and FR must align)', () => {
    expect(scopeKey({ country: 'BE', language: 'nl' } as never)).toBe(scopeKey({ country: 'BE', language: 'fr' } as never));
  });
});

describe('mergeScope', () => {
  it('qualifiers win over the declared scope, which fills the blanks', () => {
    expect(mergeScope({ country: 'BE', jointCommittee: 'PC 200' }, { country: 'NL' })).toEqual({ country: 'NL', jointCommittee: 'PC 200' });
  });
  it('is null-safe', () => {
    expect(mergeScope(null, undefined)).toEqual({});
    expect(mergeScope({ country: null }, {})).toEqual({ country: null });
    expect(mergeScope({ country: null }, { country: 'BE' })).toEqual({ country: 'BE' });
  });
});

describe('differingScopeKeys', () => {
  it('lists the dimensions that differ', () => {
    expect(differingScopeKeys({ country: 'BE', jointCommittee: 'PC 200' }, { country: 'NL', jointCommittee: 'PC 200' })).toEqual(['country']);
    expect(differingScopeKeys(null, {})).toEqual([]);
    expect(differingScopeKeys({ country: 'BE' }, null)).toEqual(['country']);
  });
});

describe('claimKey', () => {
  const base = { subject: 'leave.small_leave.own_marriage', attribute: 'duration', qualifiers: { country: 'BE', jointCommittee: 'PC 200' } };

  it('is a stable sha1 hex', () => {
    expect(claimKey(base)).toMatch(/^[a-f0-9]{40}$/);
    expect(claimKey(base)).toBe(claimKey({ ...base }));
  });

  it('is order-independent over qualifier keys', () => {
    const a = claimKey({ ...base, qualifiers: { country: 'BE', jointCommittee: 'PC 200' } });
    const b = claimKey({ ...base, qualifiers: { jointCommittee: 'PC 200', country: 'BE' } });
    expect(a).toBe(b);
  });

  it('uses declaredScope when the claim has no qualifier, and the qualifier wins when both exist', () => {
    const fromDoc = claimKey({ ...base, qualifiers: {}, declaredScope: { country: 'BE', jointCommittee: 'PC 200' } });
    expect(fromDoc).toBe(claimKey(base));
    const qualifierWins = claimKey({ ...base, qualifiers: { country: 'BE', jointCommittee: 'PC 200' }, declaredScope: { country: 'NL' } });
    expect(qualifierWins).toBe(claimKey(base));
    expect(claimKey({ ...base, qualifiers: {}, declaredScope: { country: 'NL' } })).not.toBe(claimKey(base));
  });

  it('is null-safe', () => {
    const k = claimKey({ subject: 's', attribute: 'a' });
    expect(k).toMatch(/^[a-f0-9]{40}$/);
    expect(claimKey({ subject: 's', attribute: 'a', qualifiers: null, declaredScope: null })).toBe(k);
    expect(claimKey({ subject: 's', attribute: 'a', qualifiers: { country: null } })).toBe(k);
  });

  it('ignores conditions and surrounding whitespace/case in subject and attribute', () => {
    const withConditions = { ...base, qualifiers: { ...base.qualifiers, conditions: ['if married'] } };
    expect(claimKey(withConditions)).toBe(claimKey(base));
    expect(claimKey({ ...base, subject: '  Leave.Small_Leave.Own_Marriage ', attribute: 'DURATION' })).toBe(claimKey(base));
  });

  it('differs on subject, attribute and scope', () => {
    const k = claimKey(base);
    expect(claimKey({ ...base, attribute: 'eligibility' })).not.toBe(k);
    expect(claimKey({ ...base, subject: 'leave.small_leave.birth' })).not.toBe(k);
    expect(claimKey({ ...base, qualifiers: { country: 'NL', jointCommittee: 'PC 200' } })).not.toBe(k);
  });
});
