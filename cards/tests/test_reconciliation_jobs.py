import httpx
import pytest

from capture.buffer import Buffer
from tests.test_smart_merge import pair
from writer.loop import WriterLoop, settings_of


def test_finished_job_survives_restart_and_runs_only_once(db, meeting, monkeypatch):
    pair(db, meeting)
    with db.connect('cards') as conn:
        conn.execute('UPDATE cards.reconciliation_jobs SET completed_at = now()')
    buffer = Buffer()
    buffer.finished.add(str(meeting['id']))
    calls = []
    monkeypatch.setattr('writer.reconcile.reconcile', lambda *args: calls.append(args[1]) or 0)
    backend = httpx.Client(base_url='http://backend.test', transport=httpx.MockTransport(
        lambda r: httpx.Response(200, json={'base_url': 'http://model.test', 'model': 'fake', 'settings': {'cards_granularity': 'balanced'}})))
    loop = WriterLoop(db.url('cards'), buffer, backend)
    loop._unread()  # persists the work before the process disappears
    restarted = WriterLoop(db.url('cards'), Buffer(), backend)
    restarted._reconcile_jobs()
    restarted._reconcile_jobs()
    assert calls == [str(meeting['id'])]


def test_model_failure_keeps_job_pending_with_backoff(db, meeting, monkeypatch):
    pair(db, meeting)
    with db.connect('cards') as conn:
        conn.execute('UPDATE cards.reconciliation_jobs SET completed_at = now()')
    loop = WriterLoop(db.url('cards'), Buffer(), None)
    loop._forget(str(meeting['id']), 0)
    loop._read_settings = lambda: settings_of({'base_url': 'http://model.test', 'model': 'fake', 'settings': {'cards_granularity': 'balanced'}})
    def fail(*args):
        raise ValueError('bad model output')
    monkeypatch.setattr('writer.reconcile.reconcile', fail)
    loop._reconcile_jobs()
    with db.connect('cards') as conn:
        assert conn.execute('SELECT completed_at, attempts, retry_at > now() FROM cards.reconciliation_jobs '
                            'WHERE meeting_id = %s', [meeting['id']]).fetchone() == (None, 1, True)


def test_failed_reconciliation_stops_after_five_attempts_and_new_position_resets(db, meeting, monkeypatch, caplog):
    pair(db, meeting)
    with db.connect('cards') as conn:
        conn.execute('UPDATE cards.reconciliation_jobs SET completed_at = now()')
    loop = WriterLoop(db.url('cards'), Buffer(), None)
    loop._forget(str(meeting['id']), 0)
    loop._read_settings = lambda: settings_of({'base_url': 'http://model.test', 'model': 'fake', 'settings': {'cards_granularity': 'balanced'}})
    calls = []
    def fail(*args):
        calls.append(args[1])
        raise ValueError('bad model output')
    monkeypatch.setattr('writer.reconcile.reconcile', fail)
    for _ in range(7):
        with db.connect('cards') as conn:
            conn.execute('UPDATE cards.reconciliation_jobs SET retry_at = now() WHERE meeting_id = %s', [meeting['id']])
        loop._reconcile_jobs()
    assert len(calls) == 5
    assert sum('exhausted' in r.message for r in caplog.records) == 1
    with db.connect('cards') as conn:
        assert conn.execute('SELECT completed_at, attempts FROM cards.reconciliation_jobs WHERE meeting_id = %s',
                            [meeting['id']]).fetchone() == (None, 5)
        conn.execute('UPDATE cards.capture_positions SET last_seq = last_seq + 1 WHERE meeting_id = %s', [meeting['id']])
    loop._forget(str(meeting['id']), 0)
    with db.connect('cards') as conn:
        assert conn.execute('SELECT completed_at, attempts FROM cards.reconciliation_jobs WHERE meeting_id = %s',
                            [meeting['id']]).fetchone() == (None, 0)
    loop._reconcile_jobs()
    assert len(calls) == 6


def test_failure_does_not_charge_a_replaced_position(db, meeting, monkeypatch):
    pair(db, meeting)
    with db.connect('cards') as conn:
        conn.execute('UPDATE cards.reconciliation_jobs SET completed_at = now()')
    loop = WriterLoop(db.url('cards'), Buffer(), None)
    loop._forget(str(meeting['id']), 0)
    loop._read_settings = lambda: settings_of({'base_url': 'http://model.test', 'model': 'fake', 'settings': {'cards_granularity': 'balanced'}})
    def replace_then_fail(*args):
        with db.connect('cards') as conn:
            conn.execute('UPDATE cards.capture_positions SET last_seq = last_seq + 1 WHERE meeting_id = %s', [meeting['id']])
        loop._forget(str(meeting['id']), 0)
        raise ValueError('old request failed')
    monkeypatch.setattr('writer.reconcile.reconcile', replace_then_fail)
    loop._reconcile_jobs()
    with db.connect('cards') as conn:
        assert conn.execute('SELECT completed_at, attempts FROM cards.reconciliation_jobs WHERE meeting_id = %s',
                            [meeting['id']]).fetchone() == (None, 0)


@pytest.mark.parametrize(('failure', 'initial_attempts'),
                         [('settings', 0), ('transport', 0), ('credit', 0), ('provider', 0), ('key', 0), ('credit', 4)])
def test_transient_failure_recovers_without_consuming_attempts(db, meeting, monkeypatch, failure, initial_attempts):
    pair(db, meeting)
    with db.connect('cards') as conn:
        conn.execute('UPDATE cards.reconciliation_jobs SET completed_at = now()')
    broken = True
    def settings(request):
        return httpx.Response(503 if broken and failure == 'settings' else 200,
                              json={'base_url': 'http://model.test/', 'model': 'fake', 'settings': {'cards_granularity': 'balanced'}})
    def model(request):
        if broken:
            if failure == 'transport':
                raise httpx.ConnectError('unavailable', request=request)
            if failure in ('credit', 'provider', 'key'):
                return httpx.Response({'credit': 402, 'provider': 503, 'key': 401}[failure])
        return httpx.Response(200, json={'choices': [{'finish_reason': 'stop', 'message': {'content': '[]'}}]})
    backend = httpx.Client(base_url='http://backend.test', transport=httpx.MockTransport(settings))
    loop = WriterLoop(db.url('cards'), Buffer(), backend, model_transport=httpx.MockTransport(model))
    loop._forget(str(meeting['id']), 0)
    with db.connect('cards') as conn:
        conn.execute('UPDATE cards.reconciliation_jobs SET attempts = %s WHERE meeting_id = %s',
                     [initial_attempts, meeting['id']])
    for i in range(7):
        with db.connect('cards') as conn:
            conn.execute('UPDATE cards.reconciliation_jobs SET retry_at = now() WHERE meeting_id = %s', [meeting['id']])
        loop._reconcile_jobs()
        with db.connect('cards') as conn:
            completed, attempts, delay = conn.execute('SELECT completed_at, attempts, extract(epoch FROM retry_at-now()) '
                    'FROM cards.reconciliation_jobs WHERE meeting_id = %s', [meeting['id']]).fetchone()
        assert completed is None and attempts == initial_attempts
        assert min(3600, 60 * 2 ** i) - 3 < delay <= min(3600, 60 * 2 ** i)
    broken = False
    with db.connect('cards') as conn:
        conn.execute('UPDATE cards.reconciliation_jobs SET retry_at = now() WHERE meeting_id = %s', [meeting['id']])
    loop._reconcile_jobs()
    with db.connect('cards') as conn:
        completed, attempts = conn.execute('SELECT completed_at, attempts FROM cards.reconciliation_jobs WHERE meeting_id = %s',
                                           [meeting['id']]).fetchone()
    assert completed is not None and attempts == initial_attempts + 1


@pytest.mark.parametrize('result', ['success', 'invalid', 'database_outage'])
def test_lock_connection_loss_uses_fresh_bookkeeping_and_prepaid_lease(db, meeting, monkeypatch, result):
    import psycopg
    pair(db, meeting)
    with db.connect('cards') as conn:
        conn.execute('UPDATE cards.reconciliation_jobs SET completed_at = now()')
    loop = WriterLoop(db.url('cards'), Buffer(), None)
    loop._forget(str(meeting['id']), 0)
    loop._read_settings = lambda: settings_of({'base_url': 'http://model.test', 'model': 'fake', 'settings': {'cards_granularity': 'balanced'}})
    original_connect = psycopg.connect
    lock_connections = []
    outage = False
    def connect(*args, **kwargs):
        if outage:
            raise psycopg.OperationalError('database unavailable')
        conn = original_connect(*args, **kwargs)
        if kwargs.get('autocommit'):
            lock_connections.append(conn)
        return conn
    monkeypatch.setattr('writer.loop.psycopg.connect', connect)
    calls = []
    def model(*args):
        nonlocal outage
        calls.append(args[1])
        lock_connections[0].close()
        if result == 'database_outage':
            outage = True
        if result == 'invalid':
            raise ValueError('invalid paid reply')
        return 0
    monkeypatch.setattr('writer.reconcile.reconcile', model)
    loop._reconcile_jobs()
    outage = False
    loop._reconcile_jobs()
    assert len(calls) == 1
    with db.connect('cards') as conn:
        completed, attempts, delayed = conn.execute('SELECT completed_at, attempts, retry_at > now() '
                'FROM cards.reconciliation_jobs WHERE meeting_id = %s', [meeting['id']]).fetchone()
    assert (completed is not None) == (result == 'success')
    assert attempts == 1
    assert delayed
    if result == 'database_outage':
        # A crash lease is a delay, not a permanent stall after the database recovers.
        with db.connect('cards') as conn:
            conn.execute('UPDATE cards.reconciliation_jobs SET retry_at = now() WHERE meeting_id = %s', [meeting['id']])
        monkeypatch.setattr('writer.reconcile.reconcile', lambda *args: calls.append(args[1]) or 0)
        loop._reconcile_jobs()
        assert len(calls) == 2
        with db.connect('cards') as conn:
            assert conn.execute('SELECT completed_at IS NOT NULL FROM cards.reconciliation_jobs WHERE meeting_id = %s',
                                [meeting['id']]).fetchone()[0]


@pytest.mark.parametrize('lose_lease', [False, True])
def test_each_model_call_renews_lease_and_refuses_lost_ownership(db, meeting, lose_lease):
    import json
    old, new = pair(db, meeting)
    with db.connect('cards') as conn:
        conn.execute('UPDATE cards.reconciliation_jobs SET completed_at = now()')
    deadlines = []
    replacement = None
    def respond(request):
        nonlocal replacement
        with db.connect('cards') as conn:
            deadlines.append(conn.execute('SELECT retry_at FROM cards.reconciliation_jobs WHERE meeting_id = %s',
                                          [meeting['id']]).fetchone()[0])
            if lose_lease and len(deadlines) == 1:
                replacement = conn.execute("UPDATE cards.reconciliation_jobs SET retry_at = retry_at + interval '1 minute' "
                        'WHERE meeting_id = %s RETURNING retry_at', [meeting['id']]).fetchone()[0]
        content = [{'older': old, 'newer': new}] if len(deadlines) == 1 else {'context': 'Draft includes screenshots.'}
        return httpx.Response(200, json={'choices': [{'finish_reason': 'stop', 'message': {'content': json.dumps(content)}}]})
    loop = WriterLoop(db.url('cards'), Buffer(), None, model_transport=httpx.MockTransport(respond))
    loop._forget(str(meeting['id']), 0)
    loop._read_settings = lambda: settings_of({'base_url': 'http://model.test/', 'model': 'fake', 'settings': {'cards_granularity': 'balanced'}})
    loop._reconcile_jobs()
    with db.connect('cards') as conn:
        completed, deadline = conn.execute('SELECT completed_at, retry_at FROM cards.reconciliation_jobs WHERE meeting_id = %s',
                                          [meeting['id']]).fetchone()
    if lose_lease:
        assert len(deadlines) == 1
        assert completed is None and deadline == replacement
    else:
        assert len(deadlines) == 2 and deadlines[1] > deadlines[0]
        assert completed is not None and deadline == deadlines[1]


def test_process_deaths_exhaust_reserved_attempts(db, meeting, monkeypatch):
    pair(db, meeting)
    with db.connect('cards') as conn:
        conn.execute('UPDATE cards.reconciliation_jobs SET completed_at = now()')
    loop = WriterLoop(db.url('cards'), Buffer(), None)
    loop._forget(str(meeting['id']), 0)
    calls = []
    class ProcessDied(BaseException):
        pass
    def die(*args):
        calls.append(args[1])
        raise ProcessDied()
    monkeypatch.setattr('writer.reconcile.reconcile', die)
    for i in range(7):
        with db.connect('cards') as conn:
            conn.execute('UPDATE cards.reconciliation_jobs SET retry_at = now() WHERE meeting_id = %s', [meeting['id']])
        restarted = WriterLoop(db.url('cards'), Buffer(), None)
        restarted._read_settings = lambda: settings_of({'base_url': 'http://model.test/', 'model': 'fake', 'settings': {'cards_granularity': 'balanced'}})
        if i < 5:
            with pytest.raises(ProcessDied):
                restarted._reconcile_jobs()
        else:
            restarted._reconcile_jobs()
    assert len(calls) == 5
    with db.connect('cards') as conn:
        assert conn.execute('SELECT completed_at, attempts FROM cards.reconciliation_jobs WHERE meeting_id = %s',
                            [meeting['id']]).fetchone() == (None, 5)


def test_oversized_provider_payload_exhausts_attempts(db, meeting):
    pair(db, meeting)
    with db.connect('cards') as conn:
        conn.execute('UPDATE cards.reconciliation_jobs SET completed_at = now()')
    calls = []
    def respond(request):
        calls.append(request)
        return httpx.Response(413)
    loop = WriterLoop(db.url('cards'), Buffer(), None, model_transport=httpx.MockTransport(respond))
    loop._read_settings = lambda: settings_of({'base_url': 'http://model.test/', 'model': 'fake', 'settings': {'cards_granularity': 'balanced'}})
    loop._forget(str(meeting['id']), 0)
    for _ in range(7):
        with db.connect('cards') as conn:
            conn.execute('UPDATE cards.reconciliation_jobs SET retry_at = now() WHERE meeting_id = %s', [meeting['id']])
        loop._reconcile_jobs()
    assert len(calls) == 5
    with db.connect('cards') as conn:
        assert conn.execute('SELECT completed_at, attempts FROM cards.reconciliation_jobs WHERE meeting_id = %s',
                            [meeting['id']]).fetchone() == (None, 5)


def test_a_model_that_is_gone_pauses_reconciliation_too(db, meeting, monkeypatch):
    from writer.model import MODEL_UNAVAILABLE, ModelError

    pair(db, meeting)
    with db.connect('cards') as conn:
        conn.execute('UPDATE cards.reconciliation_jobs SET completed_at = now()')
    loop = WriterLoop(db.url('cards'), Buffer(), None)
    loop._forget(str(meeting['id']), 0)
    settings = settings_of({'base_url': 'http://model.test', 'model': 'fake', 'settings': {'cards_granularity': 'balanced'}})
    loop._settings = settings
    loop._read_settings = lambda: settings
    calls = []

    def gone(*args):
        calls.append(args[1])
        raise ModelError(MODEL_UNAVAILABLE)
    monkeypatch.setattr('writer.reconcile.reconcile', gone)
    loop._reconcile_jobs()
    assert loop.paused == {'model': 'fake', 'error': 'not found (404)'}

    with db.connect('cards') as conn:
        conn.execute('UPDATE cards.reconciliation_jobs SET retry_at = now() WHERE meeting_id = %s', [meeting['id']])
        attempts = conn.execute('SELECT attempts FROM cards.reconciliation_jobs WHERE meeting_id = %s', [meeting['id']]).fetchone()
    loop._reconcile_jobs()
    assert len(calls) == 1
    with db.connect('cards') as conn:
        assert conn.execute('SELECT attempts FROM cards.reconciliation_jobs WHERE meeting_id = %s', [meeting['id']]).fetchone() == attempts


def test_reconciliation_on_an_anthropic_model_sends_its_prompt_unmarked(db, meeting):
    # QOR-5079: only the card writer's rules are marked for caching.
    import json
    old, new = pair(db, meeting)
    with db.connect('cards') as conn:
        conn.execute('UPDATE cards.reconciliation_jobs SET completed_at = now()')
    systems = []
    def respond(request):
        systems.append(json.loads(request.content)['messages'][0]['content'])
        content = [{'older': old, 'newer': new}] if len(systems) == 1 else {'context': 'Draft includes screenshots.'}
        return httpx.Response(200, json={'choices': [{'finish_reason': 'stop', 'message': {'content': json.dumps(content)}}]})
    loop = WriterLoop(db.url('cards'), Buffer(), None, model_transport=httpx.MockTransport(respond))
    loop._forget(str(meeting['id']), 0)
    loop._read_settings = lambda: settings_of({'base_url': 'https://openrouter.ai/api/v1', 'model': 'anthropic/claude-opus-5.5',
                                               'api_key': 'k', 'settings': {'cards_granularity': 'balanced'}})
    loop._reconcile_jobs()
    assert len(systems) == 2 and all(isinstance(s, str) for s in systems)
