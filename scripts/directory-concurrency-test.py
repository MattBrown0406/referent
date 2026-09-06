"""Run against disposable local Supabase only: python3 scripts/directory-concurrency-test.py."""
import concurrent.futures
import subprocess
import uuid

def sql(query):
    result = subprocess.run(['docker', 'exec', '-i', 'supabase_db_referent', 'psql', '-U', 'postgres', '-Atq', '-v', 'ON_ERROR_STOP=1'], input=query, text=True, capture_output=True)
    if result.returncode:
        raise RuntimeError(result.stderr)
    return result.stdout.strip()

users = [str(uuid.uuid4()) for _ in range(2)]
partners = [str(uuid.uuid4()) for _ in range(2)]
name = 'Concurrency fixture ' + str(uuid.uuid4())
try:
    for user, partner in zip(users, partners):
        sql(f"INSERT INTO auth.users(id,email) VALUES('{user}','{user}@example.test'); INSERT INTO public.partners(id,owner_id,name,organization,city,state) VALUES('{partner}','{user}','Private','{name}','Bend','OR');")
    orgs = [sql(f"SELECT org_id FROM public.org_members WHERE user_id='{u}'") for u in users]
    def publish(i):
        return sql(f"BEGIN; SELECT set_config('request.jwt.claim.sub','{users[i]}',true); SET LOCAL ROLE authenticated; SELECT public.publish_partner_program('{partners[i]}','{{\"organization\":\"{name}\",\"city\":\"Bend\",\"state\":\"OR\",\"types\":[\"Inpatient\"]}}','{orgs[i]}'); SELECT pg_sleep(0.3); COMMIT;")
    with concurrent.futures.ThreadPoolExecutor(2) as pool:
        list(pool.map(publish, range(2)))
    assert sql(f"SELECT count(*) FROM public.global_partners WHERE organization='{name}'") == '1'
    global_id = sql(f"SELECT id FROM public.global_partners WHERE organization='{name}'")
    assert sql(f"SELECT count(*) FROM public.partners WHERE global_partner_id='{global_id}'") == '2'
    # Remove B's local fixture, then race four first imports into that practice.
    sql(f"DELETE FROM public.partners WHERE id='{partners[1]}'")
    def import_program(_):
        return sql(f"BEGIN; SELECT set_config('request.jwt.claim.sub','{users[1]}',true); SET LOCAL ROLE authenticated; SELECT public.import_global_partner('{global_id}','{uuid.uuid4()}','{orgs[1]}'); SELECT pg_sleep(0.2); COMMIT;")
    with concurrent.futures.ThreadPoolExecutor(4) as pool:
        list(pool.map(import_program, range(4)))
    assert sql(f"SELECT count(*) FROM public.partners WHERE org_id='{orgs[1]}' AND global_partner_id='{global_id}'") == '1'
    print('PASS concurrent contributions create one global record; four concurrent imports create one local record')
finally:
    for user in users:
        sql(f"DELETE FROM public.partners WHERE owner_id='{user}'; DELETE FROM auth.users WHERE id='{user}';")
    sql(f"DELETE FROM public.global_partners WHERE organization='{name}'")
