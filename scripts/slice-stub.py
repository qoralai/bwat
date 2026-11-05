"""Stand-ins for the end-to-end slice (scripts/smoke-slice.sh), on the compose network only.

- POST /v1/audio/transcriptions (the bot's trusted ASR host): every clip is "ship it on friday".
- POST /v1/chat/completions (the card writer's OpenAI-compatible model): the first window with
  that line gets one "do" card quoting it, owned by the dev member's display name read from
  GET /v1/me; every other window gets no cards, as a model would that sees it on the board.
"""
import json
import os
import re
import threading
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SPOKEN = "ship it on friday"
LINE = re.compile(r"^\[(?P<speaker>.+?) @e(?P<epoch>\d+) seq (?P<seq>\d+)\] (?P<text>.*)$", re.M)
answered = False
lock = threading.Lock()


def dev_member_name():
    request = urllib.request.Request(
        os.environ.get("BWAT_BACKEND_URL", "http://backend:3000") + "/v1/me",
        headers={"authorization": "Bearer " + os.environ["BWAT_DEV_PERSON_TOKEN"]},
    )
    with urllib.request.urlopen(request, timeout=5) as response:
        return json.load(response)["display_name"]


def cards_for(window):
    global answered
    line = next((m for m in LINE.finditer(window) if SPOKEN in m["text"].lower()), None)
    with lock:
        if answered or line is None:
            return []
        owner = dev_member_name()  # first, so a failed read leaves the card to the next window
        answered = True
    return [{
        "bucket": "do",
        "title": "Ship it on Friday",
        "owner": owner,
        "detail": "<p>Ship it on Friday.</p>",
        "evidence": [{"epoch": int(line["epoch"]), "seq": int(line["seq"]),
                      "speaker": line["speaker"], "quote": SPOKEN}],
    }]


class Stub(BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("content-length") or 0))
        if self.path == "/v1/audio/transcriptions":
            return self.reply({"text": SPOKEN})
        if self.path == "/v1/chat/completions":
            window = json.loads(body)["messages"][-1]["content"]
            content = "```json\n" + json.dumps(cards_for(window)) + "\n```"
            return self.reply({
                "choices": [{"index": 0, "finish_reason": "stop",
                             "message": {"role": "assistant", "content": content}}],
                "usage": {"prompt_tokens": 1, "completion_tokens": 1},
            })
        self.send_error(404)

    def reply(self, payload):
        data = json.dumps(payload).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 80), Stub).serve_forever()
