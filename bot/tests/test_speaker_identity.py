import asyncio
import json
from dataclasses import asdict, replace

import httpx
import numpy as np

from bwat_bot.audio import Segment, transcribe_audio
from bwat_bot.backend import BackendClient
from bwat_bot.feed import transcript_frame
from bwat_bot.push import Pusher


async def test_audio_keeps_participant_id_through_flush_and_normal_cuts():
    async def audio():
        yield {'sample_rate': 16000}
        yield (16778240, 'Same name', np.full(16000, 1000, dtype=np.int16).tobytes())
        yield (16778240, 'Same name', bytes(32000))
        yield (16779264, 'Same name', np.full(16000, 1000, dtype=np.int16).tobytes())

    async def asr(pcm):
        return "I'll take that."

    out = asyncio.Queue()
    await transcribe_audio(audio(), asr, out)
    assert [out.get_nowait().speaker_zoom_id for _ in range(out.qsize())] == ['16778240', '16779264']


def test_feed_carries_verified_identity():
    segment = Segment(0, 'Zoom name', "I'll take that", 0, 1000,
                      speaker_zoom_id='16778240', speaker_member_id='00000000-0000-4000-8000-000000000001')
    frame = transcript_frame('occurrence', 1, segment)
    assert frame['speaker_zoom_id'] == '16778240'
    assert frame['speaker_member_id'] == segment.speaker_member_id


async def test_push_publishes_backend_identity_and_original_stored_text(config):
    sent = Segment(0, 'Zoom name', 'retry text', 0, 1000, speaker_zoom_id='42')
    stored = replace(sent, text="I'll take that", speaker_member_id='00000000-0000-4000-8000-000000000001')

    def respond(request):
        body = json.loads(request.content)
        assert body['return_segments'] is True
        assert body['segments'][0]['speaker_zoom_id'] == '42'
        # The backend's segment view carries columns the bot does not keep.
        return httpx.Response(200, json={'segments': [
            {'epoch': 1, **asdict(stored), 'created_at': '2026-10-12T15:00:00.000Z'}]})

    client = BackendClient(config, httpx.MockTransport(respond))
    client._token = 'test-token'
    out = asyncio.Queue()
    published = []

    async def publish(epoch, segments):
        published.extend(segments)

    push = Pusher(client, out, on_stored=publish)
    push.start('occurrence', 1)
    out.put_nowait(sent)
    try:
        await push.finish()
        assert published == [stored]
    finally:
        push.cancel()
        await client.aclose()
