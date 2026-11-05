"""A card's title is a short headline that fits a narrow board in a line or two; the rest
of what was said goes in the card's detail. The writer asks the model for that.
"""

from writer.window import build_parts

STABLE, _ = build_parts([], {})


def test_the_writer_asks_for_a_short_headline_title_with_the_rest_in_detail():
    assert '"title":    a short headline, at most 60 characters (about 8-10 words)' in STABLE
    assert "the rest of what was said goes in detail" in STABLE


def test_a_revised_title_is_the_same_short_headline():
    assert '"title":"optional improved title, a short headline as above"' in STABLE


def test_the_rules_give_titles_the_same_60_character_budget():
    assert "| title | <= 60 chars |" in STABLE and "<= 80 chars" not in STABLE
    assert "If the title will not fit, keep the\nheadline and put the rest in detail." in STABLE
