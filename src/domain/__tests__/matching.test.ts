/// <reference types="node" />

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isPaymentEligible,
  matchesServiceRegion,
  parseCashBudget,
  referralCountsByPartner,
} from '../matching';
import { normalizePartner, normalizeReferral, normalizeReferralMatch } from '../types';

test('cash budget has an explicit unbounded state and rejects entered invalid values', () => {
  assert.deepEqual(parseCashBudget(''), { kind: 'unbounded' });
  assert.deepEqual(parseCashBudget('   '), { kind: 'unbounded' });
  assert.deepEqual(parseCashBudget('2500'), { kind: 'limited', amount: 2500 });
  assert.deepEqual(parseCashBudget('0'), { kind: 'invalid', reason: 'Budget must be greater than zero.' });
  assert.deepEqual(parseCashBudget('-1'), { kind: 'invalid', reason: 'Budget must be greater than zero.' });
  assert.deepEqual(parseCashBudget('not money'), { kind: 'invalid', reason: 'Budget must be a number.' });
});

test('cash payment eligibility never converts invalid budgets to Infinity', () => {
  const partner = normalizePartner({ cashMin: 500 });
  assert.equal(isPaymentEligible(partner, { insurance: 'Cash pay', budget: parseCashBudget('') }), true);
  assert.equal(isPaymentEligible(partner, { insurance: 'Cash pay', budget: parseCashBudget('500') }), true);
  assert.equal(isPaymentEligible(partner, { insurance: 'Cash pay', budget: parseCashBudget('0') }), false);
  assert.equal(isPaymentEligible(partner, { insurance: 'Cash pay', budget: parseCashBudget('abc') }), false);
});

test('cash pricing preserves missing and explicit free prices without unsafe eligibility', () => {
  const budget = parseCashBudget('100');
  const missing = normalizePartner({});
  const malformed = normalizePartner({ cashMin: 'free' });
  const negative = normalizePartner({ cashMin: -1 });
  const explicitFree = normalizePartner({ cashMin: 0, cashMax: 0 });

  assert.equal(missing.cashMin, null);
  assert.equal(malformed.cashMin, null);
  assert.equal(negative.cashMin, null);
  assert.equal(explicitFree.cashMin, 0);
  assert.equal(isPaymentEligible(missing, { insurance: 'Cash pay', budget }), false);
  assert.equal(isPaymentEligible(malformed, { insurance: 'Cash pay', budget }), false);
  assert.equal(isPaymentEligible(negative, { insurance: 'Cash pay', budget }), false);
  assert.equal(isPaymentEligible(explicitFree, { insurance: 'Cash pay', budget }), true);
  assert.equal(isPaymentEligible(explicitFree, { insurance: 'Cash pay', budget: parseCashBudget('') }), true);
  assert.equal(normalizePartner({ cashMin: 1000, cashMax: 500 }).cashMax, null);
});

test('saved match budgets preserve only finite positive values', () => {
  for (const maxBudget of [0, -10, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(normalizeReferralMatch({ maxBudget }).maxBudget, undefined);
  }
  assert.equal(normalizeReferralMatch({ maxBudget: 2500 }).maxBudget, 2500);
});

test('geographic matching requires home state or an explicitly recorded service region', () => {
  const localOnly = normalizePartner({ state: 'CA' });
  const nationwide = normalizePartner({ state: 'CA', regions: ['Nationwide'] });
  const servesNewYork = normalizePartner({ state: 'CA', regions: ['NY'] });

  assert.equal(matchesServiceRegion(localOnly, 'CA'), true);
  assert.equal(matchesServiceRegion(localOnly, 'NY'), false);
  assert.equal(matchesServiceRegion(nationwide, 'NY'), true);
  assert.equal(matchesServiceRegion(servesNewYork, 'NY'), true);
  assert.equal(matchesServiceRegion(localOnly, 'ANY'), true);
});

test('out-of-network eligibility requires recorded capability for the selected insurance', () => {
  const cashOnly = normalizePartner({ insurance: [] });
  const inNetwork = normalizePartner({ insurance: ['Aetna'] });
  const outOfNetwork = normalizePartner({ outOfNetworkInsurance: ['Aetna'] });
  const broadOutOfNetwork = normalizePartner({ outOfNetworkInsurance: ['Any'] });

  assert.equal(isPaymentEligible(cashOnly, { insurance: 'Aetna', networkPreferences: ['Out-of-network'] }), false);
  assert.equal(isPaymentEligible(inNetwork, { insurance: 'Aetna', networkPreferences: ['In-network'] }), true);
  assert.equal(isPaymentEligible(inNetwork, { insurance: 'Cigna', networkPreferences: ['Out-of-network'] }), false);
  assert.equal(isPaymentEligible(outOfNetwork, { insurance: 'Aetna', networkPreferences: ['Out-of-network'] }), true);
  assert.equal(isPaymentEligible(broadOutOfNetwork, { insurance: 'Cigna', networkPreferences: ['Out-of-network'] }), true);
});

test('referral counts derive from referral rows and ignore legacy partner counters', () => {
  const partners = [
    normalizePartner({ id: 'p1', inbound: 90, outbound: 80 }),
    normalizePartner({ id: 'p2', inbound: 70, outbound: 60 }),
  ];
  const referrals = [
    normalizeReferral({ partnerId: 'p1', direction: 'Inbound' }),
    normalizeReferral({ partnerId: 'p1', direction: 'Inbound' }),
    normalizeReferral({ partnerId: 'p1', direction: 'Outbound' }),
    normalizeReferral({ partnerId: 'p2', direction: 'Outbound' }),
  ];

  assert.deepEqual(referralCountsByPartner(partners, referrals), {
    p1: { inbound: 2, outbound: 1 },
    p2: { inbound: 0, outbound: 1 },
  });
});
