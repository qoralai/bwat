"""Explicit transcript corrections, based on the prototype's exact-match behavior.

Patterns are escaped words, never user-supplied regexes. Match once against the original
speech (longest alias first), so replacements cannot trigger another correction. No
phonetic guesses, device-name inference, or changes to typed chat.
"""
import re
from dataclasses import dataclass, replace

from bwat_bot.audio import Segment


@dataclass(frozen=True)
class Dictionary:
    version: str | None = None
    body: tuple = ()
    speakers: tuple = ()

    @classmethod
    def compile(cls, payload: dict | None) -> "Dictionary":
        if payload is None:
            return cls()
        targets, people = payload['targets'], payload.get('people', [])
        rows = targets + people
        by_id = {r['id']: r for r in rows}
        if len(by_id) != len(rows):
            raise ValueError('duplicate dictionary ids')
        canonical = {r['canonical'].lower(): r['id'] for r in rows}
        if any(not r['canonical'].strip() for r in rows):
            raise ValueError('empty spelling')
        body, speakers, seen = [], [], set()
        person_ids = {p['id'] for p in people}
        for alias in payload['aliases']:
            find, target = alias['alias'].strip(), alias['target_id']
            key = find.lower()
            if not find or key in seen or target not in by_id:
                raise ValueError('invalid correction')
            if key in canonical and canonical[key] != target:
                raise ValueError('ambiguous correction')
            seen.add(key)
            scopes = alias.get('scopes', ['body'])
            if not isinstance(scopes, list) or not scopes or set(scopes) - {'body', 'speaker'}:
                raise ValueError('invalid correction scope')
            if 'speaker' in scopes and target not in person_ids:
                raise ValueError('speaker correction must name a person')
            if alias.get('hardness', 'hard') != 'hard':
                continue
            entry = (find, by_id[target]['canonical'], bool(alias.get('require_capitalised')))
            if 'body' in scopes:
                body.append(entry)
            if 'speaker' in scopes:
                speakers.append(entry)
        version = payload.get('version')
        if version is not None and not isinstance(version, str):
            raise ValueError('invalid dictionary version')
        return cls(version, cls._patterns(body), cls._patterns(speakers, whole=True))

    @staticmethod
    def _patterns(entries, whole=False):
        return tuple((re.compile((r'\A' if whole else r'(?<!\w)') + re.escape(find)
                                 + (r'\Z' if whole else r'(?!\w)'), re.IGNORECASE), replacement, capital)
                     for find, replacement, capital in sorted(entries, key=lambda row: -len(row[0])))

    @staticmethod
    def _apply(text, patterns):
        # Gather non-overlapping matches before applying any replacement.
        accepted = []
        for pattern, replacement, capital in patterns:
            for match in pattern.finditer(text):
                if capital and not match.group()[0].isupper():
                    continue
                start, end = match.span()
                if any(start < b and end > a for a, b, _ in accepted):
                    continue
                accepted.append((start, end, replacement))
        for start, end, replacement in sorted(accepted, reverse=True):
            text = text[:start] + replacement + text[end:]
        return text

    def correct(self, segment: Segment) -> Segment:
        if segment.source != 'asr':
            return segment
        text = self._apply(segment.text, self.body)
        speaker = self._apply(segment.speaker_label, self.speakers)
        if text == segment.text and speaker == segment.speaker_label:
            return segment
        return replace(segment, text=text, speaker_label=speaker,
                       original_text=segment.text, original_speaker_label=segment.speaker_label,
                       dictionary_version=self.version)
