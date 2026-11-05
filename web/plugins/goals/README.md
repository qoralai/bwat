# The goals plugin, web side (`goals`)

Its board script only (`board/board.js`), a feature plugin (`../README.md`, What a plugin may
add to the board). The backend side and its routes: `backend/src/plugins/goals/README.md`.
On while the backend runs the `goals` plugin.

| Hook | What it shows |
|---|---|
| `tags` | the goal the card serves (`G2 Board is easy to scan`), on its tile |
| `readerRow` | Goal in an opened card: None or one of this period's goals |
| `narrow` | `?source=open&narrow=goals:<id>`: the goal's open cards from every meeting, under "Goal: G2 … ×" |
| `page` | Goals: this period's and the next one's goals, named by the list's rhythm (This week, This month, …); add a draft with a title and a description (a short SMART tip under the form), edit (✎) them, and "Cards →". An owner or admin also promotes or dismisses a draft and sets a goal's outcome |
