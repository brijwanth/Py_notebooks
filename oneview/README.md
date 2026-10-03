# OneView – Board, Table and Calendar from a CSV

`oneview.py` reads `oneview.csv` and writes `oneview.html`, a single page with three views
of the same data (like a Notion database):

- **Board**: Kanban columns grouped by any select property (Status by default)
- **Table**: every property, sortable by clicking a column header
- **Calendar**: a month grid placed by any date property (Next Review, Date Created …)

Clicking a card, row or calendar entry opens a side panel with all its properties.
A search box filters all three views. Only the Python standard library is used.

```
python oneview.py            # writes oneview.html
python oneview.py --open     # ...and opens it in your browser
python oneview.py --csv export.csv
```

Re-run the command after editing the CSV.

## Adding or changing properties

1. Add a column to the CSV.
2. Describe it in `config.json` under `properties` (optional: a column not in the config
   still shows up, as plain text).

```json
{ "name": "Target Price", "type": "number", "on_card": true }
```

| type           | CSV value                                  | notes |
|----------------|--------------------------------------------|-------|
| `title`        | text                                       | the card name (one per file) |
| `text`         | text                                       | |
| `select`       | one value                                  | can be used to group the board; colours via `options` |
| `multi_select` | values separated by `multi_select_separator` (`,`) | shown as tags |
| `date`         | a date in any of `date_formats`            | can drive the calendar |
| `created_time` | a date, or blank                           | blank cells are stamped with the current date/time and saved back to the CSV (turn off with `"autofill_created_time": false`) |
| `number`       | `1,234.5`, `₹500`, `12%`                   | right-aligned, sorts numerically |
| `checkbox`     | `Yes` / `No` / `TRUE` / `1` / `x`          | |
| `url`          | `https://…`                                | |

Per-property switches: `"on_card": false` hides it on board cards, `"in_table": false`
hides it in the table. It always appears in the side panel.

Select colours: `gray, brown, orange, yellow, green, blue, purple, pink, red`. The order of
`options` is also the order of the board columns. Values without a colour get one
automatically.

Other settings: `board.group_by`, `board.hide_empty_columns`, `calendar.date_property`,
`calendar.week_starts_monday`, `display_date_format` (strftime, default `%d-%b-%Y`).

## Using a Notion export

Notion → database `…` → *Export* → *Markdown & CSV* gives a CSV that works directly:
the default `date_formats` already include Notion's `July 14, 2026` and
`July 14, 2026 7:22 AM`, and multi-selects use `,`. Rename the columns in `config.json`
to match your database's property names.
