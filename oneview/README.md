# OneView – Board, Table and Calendar over a CSV, synced both ways

```
python oneview.py
```

This starts a small local server and opens `http://localhost:8000` with three views of
`oneview.csv`:

- **Board**: Kanban columns grouped by a select column (Kanban Status). Drag cards between columns.
- **Table**: every column; click a header to sort.
- **Calendar**: cards placed by a date column (Result Date). Drag them to another day; `+` on a day adds a card.

Click any card, row or calendar entry to edit it in the side panel. **+ New** adds a card.

## Adding many cards at once

**Bulk add** opens a box to paste into:

- one Symbol Name per line, **or**
- rows copied from Excel. If the first line has column names (`Symbol Name`, `Result Date`, …)
  they are used; otherwise the columns are read in the CSV's order.

Pick the Kanban Status the new cards start in. Stocks already on the board are skipped
(tick box), and the preview tells you how many will be added before you click **Add**.
Pasted dates in any known format (`15/11/2026`, `20-Nov-2026` …) are saved in the
column's own format; an unreadable date stops the add with a message.

New cards get a starting stage automatically (**Columns → Kanban Status → New cards start
as**, default *Pre-Check*). Rows you paste straight into the CSV without a Date First Created
are treated as new too: they show at Pre-Check at once, and the stage and created date are
written into the CSV the next time the page saves something.
Stop the server with Ctrl+C. Only the Python standard library is needed.

## Two-way sync

| You change…                             | What happens |
|-----------------------------------------|--------------|
| the CSV (Excel, editor, script)         | the page picks it up within ~2 seconds, new or removed columns included |
| a value / card / column in the page     | it is written to the CSV immediately; the previous file is kept as `oneview.csv.bak` |

- If the CSV changes on disk at the same moment you edit in the page, the page reloads the
  file and asks you to redo the edit instead of overwriting the other change.
- **Excel on Windows locks the file while it is open.** Edits from the page then fail with a
  message, and are not saved, until you close the file in Excel. Reading still works.
- Dates are written back in the format the column already uses (e.g. `19-10-2026`).

## Columns

Columns come from the CSV header. Add or remove a column in the CSV, or use the **Columns**
button in the page, which can also:

- rename or delete a column (this changes the CSV),
- change a column's type (stored in `config.json`),
- choose what shows on cards and in the table,
- set the colour and order of select options. The order is the order of the Kanban columns.
- choose what a select column starts as on new cards (`"default"` in `config.json`).

Types are detected from the column name and values unless you set one:

| type               | detected when                              | notes |
|--------------------|--------------------------------------------|-------|
| `title`            | `title_property` in config, else 1st column | the card name |
| `date`             | values are dates, or empty and the name has "date" | can drive the calendar |
| `created_time`     | a date column whose name has "created"     | set automatically for new cards (and blank cells) |
| `last_edited_time` | a date column whose name has "updated/edited/modified" | set automatically whenever a card is edited **in the page** |
| `select`           | few repeated values, or the name has "status"/"stage" | can group the board |
| `multi_select`     | comma-separated repeated tags              | |
| `number`, `checkbox`, `url`, `text` | by value                  | |

Your current columns are detected as: Symbol Name → title, Result Date → date,
Kanban Status → select, Last updated → last edited time, Date First Created → created time,
Strategy Used → select.

## config.json

```json
{
  "csv": "oneview.csv",
  "title_property": "Symbol Name",
  "board":    { "group_by": "Kanban Status", "hide_empty_columns": false },
  "calendar": { "date_property": "Result Date", "week_starts_monday": true },
  "properties": {
    "Kanban Status": { "type": "select", "options": { "Pre-Check": "gray", "Research": "blue" } },
    "Notes":         { "type": "text", "on_card": false }
  },
  "date_formats": ["%d-%m-%Y", "..."],
  "display_date_format": "%d-%b-%Y"
}
```

Only columns you want to override need an entry in `properties`. Colours: `gray, brown,
orange, yellow, green, blue, purple, pink, red`. The page edits this file for you when you use
the Columns panel.

## Other options

```
python oneview.py --port 8050        # another port
python oneview.py --no-browser       # don't open a browser window
python oneview.py --csv other.csv    # another CSV
python oneview.py --export           # write a read-only snapshot to oneview.html (for sharing)
```

Moving to another tool later: `oneview.csv` is a plain CSV, which Grist, NocoDB, Airtable,
Notion and Excel all import directly.

A Notion export (*Export → Markdown & CSV*) works as the CSV directly. Its date styles,
such as `July 14, 2026 7:22 AM`, are already in `date_formats`.
