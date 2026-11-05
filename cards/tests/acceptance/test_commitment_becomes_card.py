"""A spoken commitment becomes a cited card (MVP T013, QOR-4634).

Outside-in: a window of transcript lines goes in, the model's reply comes back over the
OpenAI-compatible API (recorded, no network), and the card, its checked quote and the
writer's position land together in the cards schema as the card service's own login.
"""

import json

import httpx

from writer.model import ModelClient
from writer.window import read_window


def line(seq, speaker, text, member_id=None, epoch=0, source="asr"):
    return {
        "epoch": epoch,
        "seq": seq,
        "speaker": {"label": speaker, "member_id": member_id},
        "text": text,
        "start_ms": seq * 1000,
        "end_ms": seq * 1000 + 900,
        "source": source,
    }


def model_replying(cards, finish="stop"):
    """A model behind the OpenAI-compatible API that replies with `cards` as JSON."""

    def handle(request):
        return httpx.Response(
            200,
            json={
                "choices": [
                    {
                        "index": 0,
                        # Models wrap the array in prose and a code fence, and may cite a line first.
                        "message": {
                            "role": "assistant",
                            "content": f"Reading [Marco @e0 seq 8] first:\n```json\n{json.dumps(cards)}\n```",
                        },
                        "finish_reason": finish,
                    }
                ],
                "usage": {"prompt_tokens": 1200, "completion_tokens": 80},
            },
        )

    http = httpx.Client(transport=httpx.MockTransport(handle), base_url="https://models.example.com/v1")
    return ModelClient(http=http, model="test-model", api_key="k-test")


def window(meeting):
    return [
        line(7, meeting["ada_name"], "Who can take the license draft?", meeting["ada"]),
        line(8, meeting["marco_name"], "I'll send the license draft to legal by Friday.", meeting["marco"]),
        line(9, meeting["ada_name"], "Great, thanks.", meeting["ada"]),
    ]


def commitment(meeting, owner=None, quote="I'll send the license draft to legal by Friday", seq=8):
    return {
        "bucket": "do",
        "title": "Send the license draft to legal by Friday",
        "owner": owner or meeting["marco_name"],
        "detail": "<p>Marco takes the license draft to legal.</p>",
        # Two quotes from one line: a card keeps one quote per line.
        "evidence": [
            {"epoch": 0, "seq": seq, "speaker": meeting["marco_name"], "quote": quote},
            {"epoch": 0, "seq": seq, "speaker": meeting["marco_name"], "quote": "by Friday"},
        ],
    }


def cards_in(db, meeting_id):
    with db.connect("cards") as conn:
        return conn.execute(
            """SELECT c.id, c.kind, c.title, c.owner_member_id, e.epoch, e.seq, e.speaker_label, e.text
                 FROM cards.cards c LEFT JOIN cards.evidence e ON e.card_id = c.id
                WHERE c.meeting_id = %s ORDER BY c.created_at""",
            [meeting_id],
        ).fetchall()


def position(db, meeting_id):
    with db.connect("cards") as conn:
        row = conn.execute(
            "SELECT last_seq FROM cards.capture_positions WHERE meeting_id = %s AND epoch = 0", [meeting_id]
        ).fetchone()
    return row[0] if row else None


def test_a_commitment_becomes_a_card_quoting_its_words_and_owned_by_who_said_it(db, meeting):
    result = read_window(db.url("cards"), meeting["id"], window(meeting), model_replying([commitment(meeting)]))

    rows = cards_in(db, meeting["id"])
    assert len(rows) == 1
    _, kind, title, owner, epoch, seq, speaker, text = rows[0]
    assert (kind, title, owner) == ("todo", "Send the license draft to legal by Friday", meeting["marco"])
    assert (epoch, seq, speaker) == (0, 8, meeting["marco_name"])
    assert text == "I'll send the license draft to legal by Friday"
    assert position(db, meeting["id"]) == 9
    assert result["usage"]["in"] == 1200


def test_an_owner_who_is_not_a_member_is_unknown_and_the_spoken_name_is_kept(db, meeting):
    read_window(db.url("cards"), meeting["id"], window(meeting), model_replying([commitment(meeting, owner="Legal team")]))

    (card_id, _, _, owner, *_), = cards_in(db, meeting["id"])
    assert owner is None
    with db.connect("cards") as conn:
        after = conn.execute(
            "SELECT after FROM cards.card_events WHERE card_id = %s AND action = 'card.create'", [card_id]
        ).fetchone()[0]
    assert after["owner_name"] == "Legal team"


def test_a_cut_off_reply_writes_nothing_and_holds_the_position(db, meeting):
    result = read_window(
        db.url("cards"), meeting["id"], window(meeting), model_replying([commitment(meeting)], finish="length")
    )

    assert cards_in(db, meeting["id"]) == []
    assert position(db, meeting["id"]) is None
    assert "error" in result and result["usage"]["in"] == 1200


def test_a_card_whose_quote_is_not_in_the_window_is_refused_and_the_rest_lands(db, meeting):
    invented = commitment(meeting, quote="I will also redo the website", seq=8)
    invented["title"] = "Redo the website"
    untitled = commitment(meeting) | {"title": ""}
    result = read_window(
        db.url("cards"), meeting["id"], window(meeting), model_replying([invented, untitled, commitment(meeting)])
    )

    titles = [row[2] for row in cards_in(db, meeting["id"])]
    assert titles == ["Send the license draft to legal by Friday"]
    assert len(result["refused"]) == 2
    assert position(db, meeting["id"]) == 9
