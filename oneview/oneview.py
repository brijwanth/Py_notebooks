"""OneView: render a CSV file as a Kanban board, a table and a calendar.

Usage:
    python oneview.py                     # uses config.json next to this file
    python oneview.py --config my.json    # use another config
    python oneview.py --csv other.csv     # override the CSV named in the config
    python oneview.py --open              # open the generated page in the browser

Everything about the data (columns, their types, select colours, which
property groups the board and which date drives the calendar) lives in
config.json, so adding a property is: add a column to the CSV, then
(optionally) describe it in config.json. Columns found in the CSV but not
in the config are still shown, as plain text.

Only the Python standard library is used.
"""

import argparse
import csv
import datetime as dt
import hashlib
import json
import os
import webbrowser

HERE = os.path.dirname(os.path.abspath(__file__))
TEMPLATE = os.path.join(HERE, 'template.html')

PROPERTY_TYPES = {'title', 'text', 'select', 'status', 'multi_select', 'date',
                  'created_time', 'number', 'checkbox', 'url'}
DATE_TYPES = {'date', 'created_time'}
SELECT_TYPES = {'select', 'status'}
COLOURS = ['gray', 'brown', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'red']
CREATED_FORMAT = '%d-%m-%Y %H:%M'   # how an auto-filled "Date Created" is written back to the CSV
TRUE_WORDS = {'yes', 'y', 'true', '1', 'x', 'checked', '__yes__'}


# ---------------------------------------------------------------- config / csv

def load_config(path):
    with open(path, encoding='utf-8') as f:
        cfg = json.load(f)
    cfg.setdefault('title', 'OneView')
    cfg.setdefault('csv', 'data.csv')
    cfg.setdefault('output', 'oneview.html')
    cfg.setdefault('date_formats', ['%d-%m-%Y', '%Y-%m-%d'])
    cfg.setdefault('display_date_format', '%d-%b-%Y')
    cfg.setdefault('multi_select_separator', ',')
    cfg.setdefault('autofill_created_time', True)
    cfg.setdefault('board', {})
    cfg.setdefault('calendar', {})
    cfg.setdefault('properties', [])
    for p in cfg['properties']:
        p.setdefault('type', 'text')
        if p['type'] not in PROPERTY_TYPES:
            raise SystemExit('Property "%s" has unknown type "%s". Use one of: %s'
                             % (p['name'], p['type'], ', '.join(sorted(PROPERTY_TYPES))))
    return cfg


def resolve(base_dir, path):
    return path if os.path.isabs(path) else os.path.join(base_dir, path)


def read_csv(path):
    # utf-8-sig strips the BOM that Excel and Notion exports put at the start
    with open(path, encoding='utf-8-sig', newline='') as f:
        reader = csv.DictReader(f)
        headers = [h.strip() for h in (reader.fieldnames or [])]
        rows = [{(k or '').strip(): (v or '').strip() for k, v in r.items()} for r in reader]
    return headers, rows


def write_csv(path, headers, rows):
    with open(path, 'w', encoding='utf-8', newline='') as f:
        w = csv.DictWriter(f, fieldnames=headers, extrasaction='ignore')
        w.writeheader()
        w.writerows(rows)


def build_properties(cfg, headers):
    """Configured properties first (in config order), then any extra CSV columns as text."""
    props = []
    seen = set()
    for p in cfg['properties']:
        if p['name'] not in headers:
            print('note: property "%s" is in the config but not in the CSV - skipped' % p['name'])
            continue
        props.append(p)
        seen.add(p['name'])
    for h in headers:
        if h and h not in seen:
            props.append({'name': h, 'type': 'text'})
    if not any(p['type'] == 'title' for p in props):
        title = cfg.get('title_property') or headers[0]
        for p in props:
            if p['name'] == title:
                p['type'] = 'title'
    return props


# ---------------------------------------------------------------- value parsing

def parse_date(raw, formats):
    """Return (iso_string, has_time) or (None, False). Notion date ranges 'a → b' keep the start."""
    raw = raw.split('→')[0].strip()
    if not raw:
        return None, False
    for fmt in formats:
        try:
            d = dt.datetime.strptime(raw, fmt)
        except ValueError:
            continue
        has_time = any(c in fmt for c in ('%H', '%I', '%M'))
        return (d.strftime('%Y-%m-%dT%H:%M') if has_time else d.strftime('%Y-%m-%d')), has_time
    return None, False


def parse_number(raw):
    s = raw.replace(',', '').replace('₹', '').replace('$', '').replace('%', '').strip()
    try:
        return float(s)
    except ValueError:
        return None


def parse_value(prop, raw, cfg, warnings, row_label):
    t = prop['type']
    if t in SELECT_TYPES:
        return raw
    if t == 'multi_select':
        sep = cfg['multi_select_separator']
        return [v.strip() for v in raw.split(sep) if v.strip()]
    if t in DATE_TYPES:
        iso, _ = parse_date(raw, cfg['date_formats'])
        if raw and iso is None:
            warnings.append('%s: could not read %s "%s" - add its format to date_formats'
                            % (row_label, prop['name'], raw))
        return iso
    if t == 'number':
        n = parse_number(raw)
        if raw and n is None:
            warnings.append('%s: %s "%s" is not a number' % (row_label, prop['name'], raw))
        return n
    if t == 'checkbox':
        return raw.lower() in TRUE_WORDS
    return raw


def colour_for(value):
    """Stable colour for a select value that has none configured."""
    h = int(hashlib.md5(value.encode('utf-8')).hexdigest(), 16)
    return COLOURS[h % len(COLOURS)]


# ---------------------------------------------------------------- main

def build(cfg, cfg_dir, csv_override=None):
    csv_path = resolve(cfg_dir, csv_override or cfg['csv'])
    headers, raw_rows = read_csv(csv_path)
    if not headers:
        raise SystemExit('%s has no header row' % csv_path)
    props = build_properties(cfg, headers)
    title_prop = next(p['name'] for p in props if p['type'] == 'title')

    # Auto-stamp "created_time" properties that are blank, like Notion does,
    # and save them back so the date stays fixed on later runs.
    if cfg['autofill_created_time']:
        now = dt.datetime.now().strftime(CREATED_FORMAT)
        created = [p['name'] for p in props if p['type'] == 'created_time']
        stamped = 0
        for r in raw_rows:
            for name in created:
                if not r.get(name):
                    r[name] = now
                    stamped += 1
        if stamped:
            if CREATED_FORMAT not in cfg['date_formats']:
                cfg['date_formats'].append(CREATED_FORMAT)
            write_csv(csv_path, headers, raw_rows)
            print('stamped %d blank created date(s) in %s' % (stamped, os.path.basename(csv_path)))

    warnings = []
    rows = []
    for i, r in enumerate(raw_rows):
        label = r.get(title_prop) or 'row %d' % (i + 2)
        rows.append({p['name']: parse_value(p, r.get(p['name'], ''), cfg, warnings, label)
                     for p in props})

    # Fill in colours for every select value seen in the data.
    for p in props:
        if p['type'] in SELECT_TYPES or p['type'] == 'multi_select':
            opts = dict(p.get('options') or {})
            for row in rows:
                vals = row[p['name']] if p['type'] == 'multi_select' else [row[p['name']]]
                for v in vals:
                    if v and v not in opts:
                        opts[v] = colour_for(v)
            p['options'] = opts

    groupable = [p['name'] for p in props if p['type'] in SELECT_TYPES]
    dated = [p['name'] for p in props if p['type'] in DATE_TYPES]
    board = dict(cfg['board'])
    if board.get('group_by') not in groupable:
        board['group_by'] = groupable[0] if groupable else None
    calendar = dict(cfg['calendar'])
    if calendar.get('date_property') not in dated:
        calendar['date_property'] = dated[0] if dated else None

    data = {
        'title': cfg['title'],
        'generated': dt.datetime.now().strftime('%d-%b-%Y %H:%M'),
        'source': os.path.basename(csv_path),
        'titleProperty': title_prop,
        'displayDateFormat': cfg['display_date_format'],
        'properties': [{'name': p['name'], 'type': p['type'],
                        'options': p.get('options', {}),
                        'onCard': p.get('on_card', p['type'] != 'text'),
                        'inTable': p.get('in_table', True)} for p in props],
        'rows': rows,
        'board': board,
        'calendar': calendar,
    }
    return data, warnings


def render(data, out_path):
    with open(TEMPLATE, encoding='utf-8') as f:
        html = f.read()
    # "</" is escaped so text in the CSV can never close the <script> tag early
    payload = json.dumps(data, ensure_ascii=False).replace('</', '<\\/')
    html = html.replace('__TITLE__', escape_html(data['title']))
    html = html.replace('__DATA__', payload)
    with open(out_path, 'w', encoding='utf-8') as f:
        f.write(html)


def escape_html(s):
    return (s.replace('&', '&amp;').replace('<', '&lt;')
             .replace('>', '&gt;').replace('"', '&quot;'))


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--config', default=os.path.join(HERE, 'config.json'))
    ap.add_argument('--csv', help='CSV file to read instead of the one in the config')
    ap.add_argument('--out', help='HTML file to write instead of the one in the config')
    ap.add_argument('--open', action='store_true', help='open the result in a browser')
    args = ap.parse_args()

    cfg_dir = os.path.dirname(os.path.abspath(args.config))
    cfg = load_config(args.config)
    data, warnings = build(cfg, cfg_dir, args.csv)
    out_path = resolve(cfg_dir, args.out or cfg['output'])
    render(data, out_path)

    for w in warnings:
        print('warning:', w)
    print('wrote %s (%d cards, %d properties)' % (out_path, len(data['rows']), len(data['properties'])))
    if args.open:
        webbrowser.open('file://' + os.path.abspath(out_path))


if __name__ == '__main__':
    main()
