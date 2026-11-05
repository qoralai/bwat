"""The bot's presence image: a 16:9 picture, such as a logo on a brand background, rendered
into the single I420 frame the SDK app sends as the bot's video. Before each join it is the
picture an admin uploaded in the settings (GET /bot/presence-image), or with none the logo
bwat ships with (DEFAULT_IMAGE, D196). BWAT_BOT_PRESENCE_IMAGE, rendered once at start,
wins over both.

The frame is full-range YCbCr (JPEG's BT.601), which is FrameDataFormat_I420_FULL in the
SDK: the Y plane, then U and V at half width and half height.
"""
from pathlib import Path
from typing import BinaryIO

from PIL import Image

WIDTH, HEIGHT = 1280, 720  # a Zoom tile is 16:9; 720p stays sharp at full screen
FRAME_PATH = "/tmp/bwat-presence.i420"  # where the SDK app reads it (presence-frame=)
# The logo bwat ships with: bot/presence/default.png, /app/presence/default.png in the image.
DEFAULT_IMAGE = Path(__file__).resolve().parent.parent / "presence" / "default.png"


def i420_frame(image_path: str | Path | BinaryIO) -> bytes:
    """The picture (a path, or the bytes as a file) scaled to 1280x720 as one I420 frame;
    ValueError if it is not 16:9 or too large to open, OSError if it is not a picture."""
    try:
        image = Image.open(image_path)
    except Image.DecompressionBombError as exc:
        raise ValueError(f"the presence image is too large: {exc}") from exc
    with image:
        width, height = image.size
        # 16:9 give or take a height error of 1% of the width, so a picture a pixel or two off is still used.
        if abs(width * 9 - height * 16) > width * 16 // 100:
            raise ValueError(f"the presence image must be 16:9, not {width}x{height}")
        ycbcr = image.convert("RGB").resize((WIDTH, HEIGHT), Image.LANCZOS).convert("YCbCr")
    y, u, v = ycbcr.split()
    half = (WIDTH // 2, HEIGHT // 2)
    return y.tobytes() + u.resize(half, Image.BOX).tobytes() + v.resize(half, Image.BOX).tobytes()


def write_frame(image_path: str | Path | BinaryIO, out: str | Path = FRAME_PATH) -> None:
    Path(out).write_bytes(i420_frame(image_path))
