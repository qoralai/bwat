CREATE OR REPLACE VIEW bwat.v_cards_occurrences AS
  SELECT m.id AS meeting_id, m.occurrence_uuid, m.meeting_number, m.started_at, m.ended_at,
         CASE WHEN m.finalization = 'transcript_complete' THEN 'ended'
              WHEN (EXISTS (SELECT 1 FROM bwat.claims c WHERE c.occurrence_uuid = m.occurrence_uuid
                                                         AND c.state IN ('pending', 'claimed', 'attending'))
                    OR (NOT (EXISTS (SELECT 1 FROM bwat.claims WHERE occurrence_uuid = m.occurrence_uuid AND meeting_ended_at IS NOT NULL)
                             OR EXISTS (SELECT 1 FROM bwat.zoom_ended_occurrences WHERE occurrence_uuid = m.occurrence_uuid)
                             OR EXISTS (SELECT 1 FROM bwat.deleted_occurrences WHERE occurrence_uuid = m.occurrence_uuid)
                             OR EXISTS (SELECT 1 FROM bwat.meetings WHERE occurrence_uuid = m.occurrence_uuid AND transcript_expired_at IS NOT NULL))
                        AND EXISTS (SELECT 1 FROM bwat.claims c WHERE c.occurrence_uuid IS NULL AND c.meeting_number = m.meeting_number
                                                                 AND c.state IN ('pending', 'claimed', 'attending'))))
                THEN 'live'
              WHEN (EXISTS (SELECT 1 FROM bwat.claims WHERE occurrence_uuid = m.occurrence_uuid AND meeting_ended_at IS NOT NULL)
                    OR EXISTS (SELECT 1 FROM bwat.zoom_ended_occurrences WHERE occurrence_uuid = m.occurrence_uuid)
                    OR EXISTS (SELECT 1 FROM bwat.deleted_occurrences WHERE occurrence_uuid = m.occurrence_uuid)
                    OR EXISTS (SELECT 1 FROM bwat.meetings WHERE occurrence_uuid = m.occurrence_uuid AND transcript_expired_at IS NOT NULL))
                THEN 'ended'
              ELSE 'abandoned' END AS occurrence_state,
         m.title
    FROM bwat.meetings m;
