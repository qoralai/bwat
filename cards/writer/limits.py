"""Shared bounds for transcript recovery and post-meeting reconciliation."""

RECONCILIATION_ATTEMPTS = 5
RECENT_HOURS = 120

# The clean-up's advisory lock, per meeting ('reconcile:' + its id): the writer's clean-up,
# Jev's Merge now and a draft going live take it, so no two change one meeting's cards at once.
RECONCILE_LOCK = "reconcile:"
TRY_LOCK = "SELECT pg_try_advisory_lock(hashtextextended(%s, 0))"
UNLOCK = "SELECT pg_advisory_unlock(hashtextextended(%s, 0))"
# A claimed job's lease, and a failed one's backoff: 1 minute doubling to an hour (SQL, on attempts).
LEASE = "interval '10 minutes'"
BACKOFF = "least(3600, 60 * power(2, least(attempts - 1, 6))) * interval '1 second'"
