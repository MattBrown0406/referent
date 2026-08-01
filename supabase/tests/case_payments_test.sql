-- Atomic/additive case-payment regression coverage.
BEGIN;
SELECT plan(28);

SELECT ok(
  NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'public.record_case_payment(uuid,uuid,integer,text)'::regprocedure),
  'record_case_payment is SECURITY INVOKER'
);

SELECT is(
  (SELECT proconfig FROM pg_proc WHERE oid = 'public.record_case_payment(uuid,uuid,integer,text)'::regprocedure),
  ARRAY['search_path=pg_catalog'],
  'record_case_payment has a fixed minimal search_path'
);

SELECT ok(
  has_function_privilege('authenticated', 'public.record_case_payment(uuid,uuid,integer,text)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.record_case_payment(uuid,uuid,integer,text)', 'EXECUTE'),
  'only authenticated clients can record case payments'
);

SELECT ok(
  NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'public.update_case_payment_with_event(uuid,uuid,jsonb)'::regprocedure),
  'payment corrections are SECURITY INVOKER'
);

SELECT ok(
  has_function_privilege('authenticated', 'public.update_case_payment_with_event(uuid,uuid,jsonb)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.update_case_payment_with_event(uuid,uuid,jsonb)', 'EXECUTE'),
  'only authenticated clients can correct payment fields'
);

SELECT ok(
  NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'public.update_case_details_with_event(uuid,uuid,jsonb,text)'::regprocedure),
  'case-detail patches are SECURITY INVOKER'
);

SELECT ok(
  has_function_privilege('authenticated', 'public.update_case_details_with_event(uuid,uuid,jsonb,text)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.update_case_details_with_event(uuid,uuid,jsonb,text)', 'EXECUTE'),
  'only authenticated clients can patch case details'
);

INSERT INTO auth.users (id, email)
VALUES
  ('81000000-0000-0000-0000-000000000001', 'payment-owner@example.test'),
  ('82000000-0000-0000-0000-000000000002', 'other-payment-owner@example.test');

INSERT INTO public.cases (id, owner_id, title, quoted_amount, paid_amount, payment_status)
VALUES
  ('83000000-0000-0000-0000-000000000003', '81000000-0000-0000-0000-000000000001', 'Coaching case', 150, 0, 'quoted'),
  ('84000000-0000-0000-0000-000000000004', '82000000-0000-0000-0000-000000000002', 'Other owner case', 100, 0, 'quoted');

SELECT set_config('request.jwt.claim.sub', '81000000-0000-0000-0000-000000000001', true);
SET LOCAL ROLE authenticated;

SELECT lives_ok(
  $$ SELECT * FROM public.record_case_payment(
    '83000000-0000-0000-0000-000000000003',
    '85000000-0000-0000-0000-000000000005',
    100,
    E'Coaching session 1\npaid by card'
  ) $$,
  'the first payment is accepted'
);

SELECT is(
  (SELECT paid_amount FROM public.cases WHERE id = '83000000-0000-0000-0000-000000000003'),
  100,
  'the first payment increments paid revenue'
);

SELECT is(
  (SELECT payment_status FROM public.cases WHERE id = '83000000-0000-0000-0000-000000000003'),
  'partial',
  'a payment below the quote leaves the case partial'
);

SELECT ok(
  (SELECT body FROM public.case_events WHERE id = '85000000-0000-0000-0000-000000000005')
    LIKE 'Payment received: $100%Coaching session 1 paid by card%Total paid: $100',
  'the payment timeline entry includes amount, sanitized note, and confirmed total'
);

SELECT lives_ok(
  $$ SELECT * FROM public.record_case_payment(
    '83000000-0000-0000-0000-000000000003',
    '85000000-0000-0000-0000-000000000005',
    100,
    'Coaching session 1 paid by card'
  ) $$,
  'retrying the same payment event is accepted idempotently'
);

SELECT is(
  (SELECT paid_amount FROM public.cases WHERE id = '83000000-0000-0000-0000-000000000003'),
  100,
  'an idempotent retry does not double-count revenue'
);

SELECT throws_ok(
  $$ SELECT * FROM public.record_case_payment(
    '83000000-0000-0000-0000-000000000003',
    '85000000-0000-0000-0000-000000000005',
    99,
    'different request reusing the same event'
  ) $$,
  '23505',
  'Payment event ID is already used by a different payment request',
  'an idempotency key cannot be reused for a different amount or note'
);

SELECT lives_ok(
  $$ SELECT * FROM public.record_case_payment(
    '83000000-0000-0000-0000-000000000003',
    '86000000-0000-0000-0000-000000000006',
    50,
    'Coaching session 2'
  ) $$,
  'a second distinct payment is accepted'
);

SELECT is(
  (SELECT paid_amount::text || ':' || payment_status FROM public.cases WHERE id = '83000000-0000-0000-0000-000000000003'),
  '150:paid',
  'additional payments accumulate and mark a fully paid quote as paid'
);

SELECT is(
  (SELECT count(*)::integer FROM public.case_events WHERE case_id = '83000000-0000-0000-0000-000000000003' AND kind = 'payment'),
  2,
  'each distinct payment has exactly one timeline event'
);

SELECT lives_ok(
  $$ SELECT * FROM public.update_case_details_with_event(
    '83000000-0000-0000-0000-000000000003',
    '89000000-0000-0000-0000-000000000009',
    '{"title":"Renamed coaching case"}'::jsonb,
    'Case name updated'
  ) $$,
  'a case-name edit succeeds without sending a stale payment snapshot'
);

SELECT is(
  (SELECT title || ':' || paid_amount::text || ':' || payment_status FROM public.cases WHERE id = '83000000-0000-0000-0000-000000000003'),
  'Renamed coaching case:150:paid',
  'a stale case-name edit cannot erase newer paid revenue'
);

SELECT lives_ok(
  $$ SELECT * FROM public.update_case_payment_with_event(
    '83000000-0000-0000-0000-000000000003',
    '8a000000-0000-0000-0000-00000000000a',
    '{"quoted_amount":200}'::jsonb
  ) $$,
  'a quote correction uses the locked patch RPC'
);

SELECT is(
  (SELECT quoted_amount::text || ':' || paid_amount::text || ':' || payment_status FROM public.cases WHERE id = '83000000-0000-0000-0000-000000000003'),
  '200:150:partial',
  'changing the quote preserves paid revenue and derives a consistent status'
);

SELECT throws_ok(
  $$ SELECT * FROM public.update_case_payment_with_event(
    '83000000-0000-0000-0000-000000000003',
    '8a000000-0000-0000-0000-00000000000a',
    '{"quoted_amount":225}'::jsonb
  ) $$,
  '23505',
  'Payment event ID is already used by a different correction request',
  'a correction idempotency key cannot be reused with a changed payload'
);

SELECT throws_ok(
  $$ SELECT * FROM public.update_case_payment_with_event(
    '83000000-0000-0000-0000-000000000003',
    '8b000000-0000-0000-0000-00000000000b',
    '{"payment_status":"none"}'::jsonb
  ) $$,
  '22023',
  'No-payment status requires zero paid and no quote',
  'manual status edits cannot contradict payment totals'
);

SELECT lives_ok(
  $$ SELECT * FROM public.update_case_payment_with_event(
    '83000000-0000-0000-0000-000000000003',
    '8d000000-0000-0000-0000-00000000000d',
    '{"payment_status":"refunded"}'::jsonb
  ) $$,
  'refunding a case atomically clears its revenue and open quote'
);

SELECT is(
  (SELECT paid_amount::text || ':' || coalesce(quoted_amount::text, 'null') || ':' || payment_status FROM public.cases WHERE id = '83000000-0000-0000-0000-000000000003'),
  '0:null:refunded',
  'refunded revenue is excluded from paid totals and open balances'
);

SELECT lives_ok(
  $$ SELECT * FROM public.update_case_payment_with_event(
    '83000000-0000-0000-0000-000000000003',
    '8d000000-0000-0000-0000-00000000000d',
    '{"payment_status":"refunded"}'::jsonb
  ) $$,
  'retrying the same refund correction remains idempotent'
);

SELECT throws_ok(
  $$ SELECT * FROM public.record_case_payment(
    '84000000-0000-0000-0000-000000000004',
    '87000000-0000-0000-0000-000000000007',
    25,
    'not mine'
  ) $$,
  'P0002',
  'Case not found for the authenticated owner',
  'an authenticated owner cannot add revenue to another owner''s case'
);

SELECT throws_ok(
  $$ SELECT * FROM public.record_case_payment(
    '83000000-0000-0000-0000-000000000003',
    '88000000-0000-0000-0000-000000000008',
    0,
    ''
  ) $$,
  '22023',
  'Payment amount must be between 1 and 10000000 whole dollars',
  'zero-value payments are rejected'
);

RESET ROLE;
SELECT * FROM finish();
ROLLBACK;
