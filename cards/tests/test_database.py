"""The test database is the real schema, and the card service meets it as bwat_cards."""


def test_the_card_login_reads_the_card_tables_and_the_two_views(db):
    with db.connect("cards") as conn:
        conn.execute("SELECT count(*) FROM cards.cards")
        conn.execute("SELECT member_id, display_name FROM bwat.v_cards_members LIMIT 1")
        conn.execute("SELECT meeting_id, occurrence_state FROM bwat.v_cards_occurrences LIMIT 1")
        user = conn.execute("SELECT current_user").fetchone()[0]
    assert user == "bwat_cards"
