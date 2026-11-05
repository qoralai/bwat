"""What Jev is asked before the writer reads a window (QOR-4769).

Jev scores one statement against the meeting's new lines, the lines just before them and
the board, and the writer reads the window when the score reaches the threshold. The board
goes in with its cards' content, newest first, inside one cap: past it a card is only its
title line, and past that it is left out. The lines are inside the same cap.
"""

import json

from writer.reconcile import bounded
from writer.window import BUCKETS, transcript_lines

STATEMENT = ("A new commitment, decision, question or risk was raised, or new information about an "
             "existing card was given, in the NEW lines.")
# typesafe/jev-1.13 takes at most 32,000 prompt tokens.
STATE_CAP = 96_000


def title_line(card):
    return f"{card['id']} [{card['kind']}] {card['title']}"


def board_cards(board):
    """board_digest's cards as Jev reads them, newest first."""
    return [{"id": c["display_id"], "kind": BUCKETS[c["kind"]], "title": c["title"],
             "retired": c["retired"], "content": c.get("detail", "")}
            for c in reversed(list(board.values()))]


def transcript(window, context):
    return {"new_lines": transcript_lines(window), "earlier_lines": transcript_lines(context)}


def state(window, context, cards):
    """Jev's state inside STATE_CAP (QOR-4769): the earlier lines lose their oldest first,
    then the new lines theirs (the writer still reads all of them), then the board is cut."""
    size = lambda new, earlier: len(json.dumps({**transcript(new, earlier), "board": []}))
    while context and size(window, context) > STATE_CAP:
        context = context[1:]
    while window and size(window, context) > STATE_CAP:
        window = window[1:]
    # bounded() counts each card's own JSON; the ", " between two cards is counted here.
    room = max(0, STATE_CAP - size(window, context) - 2 * len(cards))
    return {**transcript(window, context), "board": bounded(cards, room, title_line)}
