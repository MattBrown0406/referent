import { CASH_PAY } from './insurance';
import { MatchCriteria, MatchResult, Referent } from './types';

// Weights: clinical fit is primary, then payment, then geography.
// Reciprocity (who sends us business) is a deliberate tiebreaker on top.
const W_CLINICAL = 40;
const W_PAYMENT = 30;
const W_GEO = 20;
const W_RECIPROCITY = 10;

/** Approximate monthly cost for budget comparison. */
function monthlyCost(referent: Referent): number | null {
  if (referent.cashPrice == null) return null;
  switch (referent.priceUnit) {
    case '/day':
      return referent.cashPrice * 30;
    case '/session':
      return referent.cashPrice * 8; // ~2 sessions/week
    default:
      return referent.cashPrice; // /month, /episode, /case treated as-is
  }
}

export function scoreReferents(
  referents: Referent[],
  criteria: MatchCriteria,
  statsFor: (id: string) => { inbound: number; outbound: number; net: number }
): MatchResult[] {
  const pool = criteria.type ? referents.filter((r) => r.type === criteria.type) : referents;

  const results = pool.map((referent) => {
    // Clinical fit
    let clinical = W_CLINICAL;
    let matchedSpecialties: string[] = [];
    if (criteria.specialties.length > 0) {
      matchedSpecialties = criteria.specialties.filter((s) => referent.specialties.includes(s));
      clinical = Math.round((matchedSpecialties.length / criteria.specialties.length) * W_CLINICAL);
    }

    // Payment fit
    let payment = W_PAYMENT;
    let paymentNote = '';
    const priceLabel =
      referent.cashPrice != null
        ? `$${referent.cashPrice.toLocaleString()}${referent.priceUnit ?? ''}`
        : null;

    if (criteria.payment === CASH_PAY) {
      const budget = parseFloat(criteria.cashBudget.replace(/[^0-9.]/g, ''));
      const monthly = monthlyCost(referent);
      if (!isFinite(budget) || budget <= 0) {
        paymentNote = priceLabel ? `${priceLabel} cash — enter a budget to score fit` : 'Cash price unknown';
      } else if (monthly == null) {
        payment = Math.round(W_PAYMENT * 0.3);
        paymentNote = 'Cash price unknown — verify with program';
      } else if (monthly <= budget) {
        payment = W_PAYMENT;
        paymentNote = `${priceLabel} (~$${monthly.toLocaleString()}/mo) — within budget`;
      } else if (monthly <= budget * 1.2) {
        payment = Math.round(W_PAYMENT * 0.5);
        paymentNote = `${priceLabel} (~$${monthly.toLocaleString()}/mo) — slightly over budget`;
      } else {
        payment = 0;
        paymentNote = `${priceLabel} (~$${monthly.toLocaleString()}/mo) — over budget`;
      }
    } else {
      // Insurance provider selected
      if (referent.insurance.includes(criteria.payment)) {
        payment = W_PAYMENT;
        paymentNote = `In-network with ${criteria.payment}`;
      } else if (referent.insurance.includes('Out-of-Network')) {
        payment = Math.round(W_PAYMENT * 0.4);
        paymentNote = 'Out-of-network benefits may apply';
      } else if (referent.insurance.length === 0) {
        payment = Math.round(W_PAYMENT * 0.2);
        paymentNote = priceLabel ? `Cash-pay only (${priceLabel})` : 'Cash-pay only';
      } else {
        payment = 0;
        paymentNote = `Does not take ${criteria.payment}`;
      }
    }

    // Geography
    let geography = W_GEO;
    if (criteria.state) {
      geography = referent.state === criteria.state ? W_GEO : 0;
    }

    // Reciprocity — rewards partners who send us business
    const stats = statsFor(referent.id);
    const reciprocity = Math.min(W_RECIPROCITY, Math.max(0, stats.net) * 3 + Math.min(stats.inbound, 2));

    return {
      referent,
      clinical,
      payment,
      geography,
      reciprocity,
      total: clinical + payment + geography + reciprocity,
      netInbound: stats.net,
      matchedSpecialties,
      paymentNote,
    };
  });

  return results.sort((a, b) => b.total - a.total || b.reciprocity - a.reciprocity);
}
