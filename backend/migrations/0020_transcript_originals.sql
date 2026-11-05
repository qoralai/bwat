ALTER TABLE bwat.transcript_segments
  ADD COLUMN original_text text CHECK (length(original_text) <= 20000),
  ADD COLUMN original_speaker_label text CHECK (length(original_speaker_label) <= 200),
  ADD COLUMN dictionary_version text CHECK (length(dictionary_version) <= 200);
