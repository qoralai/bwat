"""The bot's presence image: a 16:9 picture becomes the one I420 frame its video shows."""
import pytest
from PIL import Image

from bwat_bot import presence
from bwat_bot.__main__ import main
from bwat_bot.presence import HEIGHT, WIDTH, i420_frame, write_frame

BACKGROUND = (35, 31, 32)  # dark
LOGO = (241, 90, 54)  # orange
# The same colours in full-range BT.601 (JPEG) YCbCr, which FrameDataFormat_I420_FULL is.
BACKGROUND_YUV = (32, 128, 130)
LOGO_YUV = (131, 85, 206)


def picture(tmp_path, size=(1920, 1080), name="presence.png"):
    """A background with the logo colour as a block in the middle third."""
    width, height = size
    image = Image.new("RGB", size, BACKGROUND)
    image.paste(LOGO, (width // 3, height // 3, 2 * width // 3, 2 * height // 3))
    path = tmp_path / name
    image.save(path)
    return path


def planes(frame: bytes):
    y_size, c_size = WIDTH * HEIGHT, (WIDTH // 2) * (HEIGHT // 2)
    return frame[:y_size], frame[y_size:y_size + c_size], frame[y_size + c_size:]


def sample(frame: bytes, x: int, y: int) -> tuple[int, int, int]:
    """Y, U and V at a pixel of the 1280x720 frame."""
    luma, u, v = planes(frame)
    c = (y // 2) * (WIDTH // 2) + x // 2
    return luma[y * WIDTH + x], u[c], v[c]


def close(actual, expected, tolerance=2) -> bool:
    return all(abs(a - e) <= tolerance for a, e in zip(actual, expected, strict=True))


def test_a_16_9_picture_becomes_one_720p_i420_frame(tmp_path):
    frame = i420_frame(picture(tmp_path))
    assert (WIDTH, HEIGHT) == (1280, 720)
    assert len(frame) == WIDTH * HEIGHT * 3 // 2


def test_the_logo_and_the_background_keep_their_colours(tmp_path):
    frame = i420_frame(picture(tmp_path))
    assert close(sample(frame, WIDTH // 2, HEIGHT // 2), LOGO_YUV)
    for corner in ((0, 0), (WIDTH - 1, 0), (0, HEIGHT - 1), (WIDTH - 1, HEIGHT - 1)):
        assert close(sample(frame, *corner), BACKGROUND_YUV)


def test_a_picture_already_720p_is_used_as_it_is(tmp_path):
    frame = i420_frame(picture(tmp_path, (WIDTH, HEIGHT)))
    assert close(sample(frame, WIDTH // 2, HEIGHT // 2), LOGO_YUV)


@pytest.mark.parametrize("size", [(1000, 1000), (1280, 1024), (720, 1280)])
def test_a_picture_that_is_not_16_9_is_refused(tmp_path, size):
    with pytest.raises(ValueError, match="16:9"):
        i420_frame(picture(tmp_path, size))


def test_the_frame_is_written_where_the_sdk_app_reads_it(tmp_path):
    out = tmp_path / "presence.i420"
    write_frame(picture(tmp_path), out)
    assert out.read_bytes() == i420_frame(picture(tmp_path))


@pytest.fixture
def start_env(monkeypatch, tmp_path):
    """A bot start with no bridge chosen: main() renders the frame, then stops at the bridge."""
    monkeypatch.setenv("BWAT_BACKEND_URL", "https://backend.test")
    monkeypatch.setenv("BWAT_FLEET_CREDENTIAL", "bwf_" + "a" * 43)
    monkeypatch.delenv("BWAT_BRIDGE", raising=False)
    monkeypatch.setattr(presence, "FRAME_PATH", str(tmp_path / "presence.i420"))
    return monkeypatch


def test_the_frame_is_rendered_once_at_start(start_env, tmp_path, capsys):
    start_env.setenv("BWAT_BOT_PRESENCE_IMAGE", str(picture(tmp_path)))
    assert main() == 2  # no bridge here
    assert (tmp_path / "presence.i420").read_bytes() == i420_frame(picture(tmp_path))
    assert "bot.presence_image_invalid" not in capsys.readouterr().out


def test_a_presence_image_that_cannot_be_used_is_logged_and_the_bot_goes_on_without_it(start_env, tmp_path, capsys):
    # The picture is cosmetic: a bad one never keeps the bot out of the meeting.
    start_env.setenv("BWAT_BOT_PRESENCE_IMAGE", str(picture(tmp_path, (1000, 1000))))
    assert main() == 2  # no bridge here
    out = capsys.readouterr().out
    assert "bot.presence_image_invalid" in out and "1000x1000" in out
    assert "bot.no_bridge" in out  # it went on to choose a bridge
    assert not (tmp_path / "presence.i420").exists()


def test_a_picture_a_pixel_off_16_9_is_used(tmp_path):
    assert len(i420_frame(picture(tmp_path, (1280, 721)))) == WIDTH * HEIGHT * 3 // 2


def test_an_image_too_large_to_open_is_refused_as_a_bad_picture(tmp_path, monkeypatch):
    from PIL import Image
    monkeypatch.setattr(Image, "MAX_IMAGE_PIXELS", 1000)
    with pytest.raises(ValueError):
        i420_frame(picture(tmp_path, (1280, 720)))
