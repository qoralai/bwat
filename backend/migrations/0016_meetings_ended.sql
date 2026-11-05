
UPDATE bwat.meetings m
   SET ended_at = greatest(m.started_at, e.ended_at)
  FROM (SELECT mm.id, least(
          (SELECT min(z.ended_at) FROM bwat.zoom_ended_occurrences z WHERE z.occurrence_uuid = mm.occurrence_uuid),
          (SELECT min(c.meeting_ended_at) FROM bwat.claims c WHERE c.occurrence_uuid = mm.occurrence_uuid)) AS ended_at
          FROM bwat.meetings mm WHERE mm.ended_at IS NULL) e
 WHERE m.id = e.id AND e.ended_at IS NOT NULL;
