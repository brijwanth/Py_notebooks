"""OneView: a Kanban board, table and calendar over a CSV file, kept in sync both ways.

Usage:
    python oneview.py                     # start at http://localhost:8000 and open the browser
    python oneview.py --port 8050         # use another port
    python oneview.py --no-browser        # don't open the browser
    python oneview.py --csv other.csv     # use another CSV than the one in config.json
    python oneview.py --export            # write a read-only snapshot to oneview.html instead

While it runs:
  * edits to the CSV (in Excel, a text editor, a script ...) show up in the page
    within a couple of seconds, including added, removed or renamed columns;
  * edits in the page (card values, dragging cards between Kanban columns or
    calendar days, new/deleted cards, new/renamed/deleted columns) are written
    straight back to the CSV. The previous version is kept as <csv>.bak.

Columns come from the CSV header. Their types (date, select, number ...) are
detected from the values; anything set in config.json, or in the page's
"Columns" panel, overrides the detection.

Only the Python standard library is used.
"""

import argparse
import codecs
import csv
import datetime as dt
import hashlib
import io
import json
import os
import re
import secrets
import shutil
import sys
import threading
import traceback
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

HERE = os.path.dirname(os.path.abspath(__file__))
TEMPLATE = os.path.join(HERE, 'template.html')

TYPES = ['title', 'text', 'select', 'status', 'multi_select', 'date', 'created_time',
         'last_edited_time', 'number', 'checkbox', 'url']
DATE_TYPES = {'date', 'created_time', 'last_edited_time'}
STAMP_TYPES = {'created_time', 'last_edited_time'}     # filled in by the program, not edited by hand
SELECT_TYPES = {'select', 'status'}
COLOURS = ['gray', 'brown', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'red']
DEFAULT_STAMP_FORMAT = '%d-%m-%Y %H:%M'
TRUE_WORDS = {'yes', 'y', 'true', '1', 'x', 'checked', '__yes__'}
BOOL_WORDS = {'yes', 'no', 'y', 'n', 'true', 'false', 'checked', 'unchecked', '__yes__', '__no__'}

DEFAULTS = {
    'title': 'OneView',
    'csv': 'oneview.csv',
    'output': 'oneview.html',
    'title_property': None,
    'date_formats': ['%d-%m-%Y', '%d/%m/%Y', '%Y-%m-%d', '%d-%b-%Y', '%d-%b-%y', '%B %d, %Y',
                     '%d-%m-%Y %H:%M', '%d/%m/%Y %H:%M', '%Y-%m-%d %H:%M', '%B %d, %Y %I:%M %p'],
    'display_date_format': '%d-%b-%Y',
    'multi_select_separator': ',',
    'autofill_created_time': True,
    'board': {},
    'calendar': {},
    'properties': {},
}


class OneViewError(Exception):
    status = 400


class Conflict(OneViewError):
    status = 409


class Locked(OneViewError):
    status = 423


# ---------------------------------------------------------------- config

def load_config(path):
    cfg = json.loads(json.dumps(DEFAULTS))
    if os.path.exists(path):
        with open(path, encoding='utf-8') as f:
            cfg.update(json.load(f))
    props = cfg.get('properties') or {}
    if isinstance(props, list):                      # older list format
        props = {p['name']: {k: v for k, v in p.items() if k != 'name'} for p in props}
    cfg['properties'] = props
    for name, p in props.items():
        if p.get('type') and p['type'] not in TYPES:
            raise SystemExit('config.json: property "%s" has unknown type "%s". Use one of: %s'
                             % (name, p['type'], ', '.join(TYPES)))
    return cfg


def save_config(path, cfg):
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(cfg, f, indent=2, ensure_ascii=False)
        f.write('\n')
    os.replace(tmp, path)


def resolve(base_dir, path):
    return path if os.path.isabs(path) else os.path.join(base_dir, path)


# ---------------------------------------------------------------- csv file

class Table:
    """The CSV kept as plain lists, so a write-back changes only what was edited."""

    def __init__(self, headers, rows, encoding, bom, newline):
        self.headers = headers
        self.rows = rows
        self.encoding = encoding
        self.bom = bom
        self.newline = newline

    @property
    def names(self):
        """Header names made usable as keys: blanks get 'Column N', repeats get ' (2)'."""
        out, seen = [], set()
        for i, h in enumerate(self.headers):
            base = h.strip() or 'Column %d' % (i + 1)
            name, k = base, 2
            while name in seen:
                name, k = '%s (%d)' % (base, k), k + 1
            seen.add(name)
            out.append(name)
        return out

    def cell(self, row, idx):
        r = self.rows[row]
        return r[idx].strip() if idx < len(r) else ''

    def set_cell(self, row, idx, value):
        r = self.rows[row]
        if len(r) <= idx:
            r.extend([''] * (idx + 1 - len(r)))
        r[idx] = value

    def blank(self, row):
        return not any(c.strip() for c in self.rows[row])


def decode(raw):
    bom = raw.startswith(codecs.BOM_UTF8)
    try:
        return raw.decode('utf-8-sig'), 'utf-8', bom
    except UnicodeDecodeError:                       # Excel's plain "CSV" on Windows
        return raw.decode('cp1252', errors='replace'), 'cp1252', False


def parse_table(raw):
    text, encoding, bom = decode(raw)
    newline = '\r\n' if '\r\n' in text else '\n'
    rows = list(csv.reader(io.StringIO(text, newline='')))
    headers = rows[0] if rows else []
    return Table(headers, rows[1:], encoding, bom, newline)


def write_table(path, t):
    tmp = path + '.tmp'
    try:
        with open(tmp, 'w', encoding='utf-8-sig' if t.bom else t.encoding, newline='') as f:
            w = csv.writer(f, lineterminator=t.newline)
            w.writerow(t.headers)
            w.writerows(t.rows)
        if os.path.exists(path):
            shutil.copy2(path, path + '.bak')
            shutil.copymode(path, tmp)
        os.replace(tmp, path)
    except PermissionError:
        if os.path.exists(tmp):
            os.remove(tmp)
        raise Locked('Could not save: %s is open or locked in another program (Excel?). '
                     'Close it there and try again.' % os.path.basename(path))


# ---------------------------------------------------------------- values

def parse_date(raw, formats):
    """Return (datetime, format) or (None, None). Notion date ranges 'a → b' keep the start."""
    raw = raw.split('→')[0].strip()
    if raw:
        for fmt in formats:
            try:
                return dt.datetime.strptime(raw, fmt), fmt
            except ValueError:
                pass
    return None, None


def has_time(fmt):
    return bool(fmt) and any(c in fmt for c in ('%H', '%I', '%M'))


def parse_number(raw):
    s = raw.replace(',', '').replace('₹', '').replace('$', '').replace('%', '').strip()
    try:
        return float(s)
    except ValueError:
        return None


def split_multi(raw, sep):
    return [v.strip() for v in raw.split(sep) if v.strip()]


def detect_type(name, values, cfg):
    """Guess a column's type from its name and values."""
    vals = [v for v in values if v]
    n = name.lower()
    dates = [v for v in vals if parse_date(v, cfg['date_formats'])[0]]
    if (vals and len(dates) >= 0.8 * len(vals)) or (not vals and re.search(r'date|updated|edited|created', n)):
        if re.search(r'creat', n):
            return 'created_time'
        if re.search(r'updat|edit|modif', n):
            return 'last_edited_time'
        return 'date'
    if not vals:
        return 'select' if 'status' in n else 'text'
    if all(v.lower() in BOOL_WORDS for v in vals):
        return 'checkbox'
    if all(parse_number(v) is not None for v in vals):
        return 'number'
    if all(re.match(r'https?://', v, re.I) for v in vals):
        return 'url'
    sep = cfg['multi_select_separator']
    tokens = [x for v in vals for x in split_multi(v, sep)]
    if (any(sep in v for v in vals) and all(len(x) <= 30 for x in tokens)
            and len(set(tokens)) <= 0.7 * len(tokens)):
        return 'multi_select'
    distinct = set(vals)
    if 'status' in n or 'stage' in n or (
            len(distinct) <= 25 and max(len(v) for v in vals) <= 40
            and (len(distinct) < len(vals) or len(vals) <= 3)):
        return 'select'
    return 'text'


def column_format(values, formats, fallback):
    """The date format most of a column's values are written in, to write new ones the same way."""
    counts = {}
    for v in values:
        _, fmt = parse_date(v, formats)
        if fmt:
            counts[fmt] = counts.get(fmt, 0) + 1
    return max(counts, key=counts.get) if counts else fallback


def colour_for(value):
    h = int(hashlib.md5(value.encode('utf-8')).hexdigest(), 16)
    return COLOURS[h % len(COLOURS)]


class Prop:
    def __init__(self, **kw):
        self.__dict__.update(kw)


def resolve_properties(cfg, t):
    names = t.names
    title = cfg.get('title_property') if cfg.get('title_property') in names else (names[0] if names else None)
    props = []
    for idx, name in enumerate(names):
        conf = cfg['properties'].get(name, {})
        values = [t.cell(r, idx) for r in range(len(t.rows)) if not t.blank(r)]
        if name == title:
            ptype, auto = 'title', False
        elif conf.get('type') and conf['type'] != 'title':
            ptype, auto = conf['type'], False
        else:
            ptype, auto = detect_type(name, values, cfg), True
        p = Prop(name=name, idx=idx, type=ptype, auto=auto, values=values,
                 on_card=conf.get('on_card', ptype not in ('text', 'url')),
                 in_table=conf.get('in_table', True), options={}, fmt=None)
        if ptype in DATE_TYPES:
            fallback = DEFAULT_STAMP_FORMAT if ptype in STAMP_TYPES else cfg['date_formats'][0]
            p.fmt = column_format(values, cfg['date_formats'], fallback)
        if ptype in SELECT_TYPES or ptype == 'multi_select':
            opts = {k: v for k, v in (conf.get('options') or {}).items() if v in COLOURS}
            for v in values:
                for x in (split_multi(v, cfg['multi_select_separator']) if ptype == 'multi_select' else [v]):
                    if x and x not in opts:
                        opts[x] = colour_for(x)
            p.options = opts
        props.append(p)
    return props


def to_json_value(p, raw, cfg, warnings, label):
    if p.type in SELECT_TYPES:
        return raw
    if p.type == 'multi_select':
        return split_multi(raw, cfg['multi_select_separator'])
    if p.type in DATE_TYPES:
        d, fmt = parse_date(raw, cfg['date_formats'])
        if d is None:
            if raw:
                warnings.append('%s: could not read %s "%s" - add its format to date_formats in config.json'
                                % (label, p.name, raw))
            return None
        return d.strftime('%Y-%m-%dT%H:%M' if has_time(fmt) else '%Y-%m-%d')
    if p.type == 'number':
        n = parse_number(raw)
        if raw and n is None:
            warnings.append('%s: %s "%s" is not a number' % (label, p.name, raw))
        return n
    if p.type == 'checkbox':
        return raw.lower() in TRUE_WORDS
    return raw


def to_csv_value(p, value, cfg):
    """A value sent by the page -> the text written into the CSV cell."""
    if value is None:
        return ''
    if p.type == 'multi_select':
        sep = cfg['multi_select_separator']
        items = value if isinstance(value, list) else split_multi(str(value), sep)
        items = [str(x).replace(sep, ' ').strip() for x in items if str(x).strip()]
        return (sep.strip() + ' ' if sep.strip() else sep).join(dict.fromkeys(items))
    if p.type == 'checkbox':
        on = value if isinstance(value, bool) else str(value).lower() in TRUE_WORDS
        if any(v.lower() in ('true', 'false') for v in p.values):
            return 'TRUE' if on else 'FALSE'
        return 'Yes' if on else 'No'
    value = str(value).strip()
    if p.type == 'date':
        if not value:
            return ''
        try:
            d = dt.datetime.strptime(value[:10], '%Y-%m-%d')
        except ValueError:
            raise OneViewError('"%s" is not a date' % value)
        return d.strftime(p.fmt)
    if p.type == 'number' and value and parse_number(value) is None:
        raise OneViewError('%s must be a number' % p.name)
    return value


def stamp(p, now):
    return now.strftime(p.fmt or DEFAULT_STAMP_FORMAT)


def fill_created(cfg, t, props, now):
    """Give rows with a blank created-time cell the current time. Returns how many were filled."""
    if not cfg['autofill_created_time']:
        return 0
    n = 0
    for p in props:
        if p.type == 'created_time':
            for r in range(len(t.rows)):
                if not t.blank(r) and not t.cell(r, p.idx):
                    t.set_cell(r, p.idx, stamp(p, now))
                    n += 1
    return n


def build_payload(cfg, t, csv_path, version, live):
    props = resolve_properties(cfg, t)
    title = next((p.name for p in props if p.type == 'title'), None)
    warnings, rows = [], []
    for r in range(len(t.rows)):
        if t.blank(r):
            continue
        label = (t.cell(r, props[0].idx) if props else '') or 'row %d' % (r + 2)
        rows.append({'id': r, 'v': {p.name: to_json_value(p, t.cell(r, p.idx), cfg, warnings, label)
                                    for p in props}})
    groupable = [p.name for p in props if p.type in SELECT_TYPES]
    dated = [p.name for p in props if p.type in DATE_TYPES]
    board = dict(cfg['board'])
    if board.get('group_by') not in groupable:
        board['group_by'] = groupable[0] if groupable else None
    calendar = dict(cfg['calendar'])
    if calendar.get('date_property') not in dated:
        plain = [p.name for p in props if p.type == 'date']
        calendar['date_property'] = (plain or dated or [None])[0]
    return {
        'title': cfg['title'],
        'source': os.path.basename(csv_path),
        'generated': dt.datetime.now().strftime('%d-%b-%Y %H:%M'),
        'live': live,
        'version': version,
        'titleProperty': title,
        'displayDateFormat': cfg['display_date_format'],
        'types': [x for x in TYPES if x not in ('title', 'status')],
        'properties': [{'name': p.name, 'type': p.type, 'auto': p.auto, 'options': p.options,
                        'onCard': p.on_card, 'inTable': p.in_table} for p in props],
        'rows': rows,
        'board': board,
        'calendar': calendar,
        'warnings': warnings[:20],
    }


# ---------------------------------------------------------------- store (all reads and writes)

class Store:
    def __init__(self, cfg_path, csv_override=None):
        self.cfg_path = os.path.abspath(cfg_path)
        self.csv_override = csv_override
        self.lock = threading.Lock()

    def _load(self):
        cfg_bytes = b''
        if os.path.exists(self.cfg_path):
            with open(self.cfg_path, 'rb') as f:
                cfg_bytes = f.read()
        cfg = load_config(self.cfg_path)
        csv_path = resolve(os.path.dirname(self.cfg_path), self.csv_override or cfg['csv'])
        if not os.path.exists(csv_path):
            raise OneViewError('CSV file not found: %s' % csv_path)
        with open(csv_path, 'rb') as f:
            csv_bytes = f.read()
        version = hashlib.sha1(csv_bytes + b'\0' + cfg_bytes).hexdigest()[:16]
        return cfg, csv_path, parse_table(csv_bytes), version

    def version(self):
        with self.lock:
            return self._load()[3]

    def snapshot(self, live=True):
        with self.lock:
            cfg, csv_path, t, version = self._load()
            return build_payload(cfg, t, csv_path, version, live)

    def stamp_created_on_start(self):
        with self.lock:
            cfg, csv_path, t, _ = self._load()
            n = fill_created(cfg, t, resolve_properties(cfg, t), dt.datetime.now())
            if n:
                try:
                    write_table(csv_path, t)
                    print('stamped %d blank created date(s) in %s' % (n, os.path.basename(csv_path)))
                except Locked as e:
                    print('note:', e)

    def apply(self, req):
        with self.lock:
            cfg, csv_path, t, version = self._load()
            if req.get('version') != version:
                raise Conflict('The CSV changed outside the page. The latest version has been loaded - '
                               'please redo your last change.')
            props = resolve_properties(cfg, t)
            op = req.get('op')
            handler = OPS.get(op)
            if not handler:
                raise OneViewError('unknown operation %r' % op)
            now = dt.datetime.now()
            csv_changed, cfg_changed, new_id = handler(cfg, t, props, req, now)
            if csv_changed:
                fill_created(cfg, t, resolve_properties(cfg, t), now)
                write_table(csv_path, t)
            if cfg_changed:
                save_config(self.cfg_path, cfg)
            cfg, csv_path, t, version = self._load()
            payload = build_payload(cfg, t, csv_path, version, True)
            payload['newId'] = new_id
            return payload


def _prop(props, name):
    for p in props:
        if p.name == name:
            return p
    raise OneViewError('There is no column "%s" any more.' % name)


def _row(t, rid):
    if not isinstance(rid, int) or not 0 <= rid < len(t.rows):
        raise OneViewError('That card no longer exists.')
    return rid


def _touch(t, props, row, now):
    for p in props:
        if p.type == 'last_edited_time':
            t.set_cell(row, p.idx, stamp(p, now))


def _check_new_name(t, name):
    name = (name or '').strip()
    if not name:
        raise OneViewError('A column needs a name.')
    if name in t.names:
        raise OneViewError('There is already a column called "%s".' % name)
    return name


def op_update_cell(cfg, t, props, req, now):
    row = _row(t, req.get('row'))
    p = _prop(props, req.get('column'))
    if p.type in STAMP_TYPES:
        raise OneViewError('%s is filled in automatically.' % p.name)
    t.set_cell(row, p.idx, to_csv_value(p, req.get('value'), cfg))
    _touch(t, props, row, now)
    return True, False, row


def op_add_row(cfg, t, props, req, now):
    t.rows.append([''] * len(t.headers))
    row = len(t.rows) - 1
    for name, value in (req.get('values') or {}).items():
        p = _prop(props, name)
        if p.type not in STAMP_TYPES:
            t.set_cell(row, p.idx, to_csv_value(p, value, cfg))
    for p in props:
        if p.type in STAMP_TYPES:
            t.set_cell(row, p.idx, stamp(p, now))
    if t.blank(row):                                # keep the row even with no stamp columns
        title = next((p for p in props if p.type == 'title'), None)
        if title:
            t.set_cell(row, title.idx, 'Untitled')
    return True, False, row


def op_delete_row(cfg, t, props, req, now):
    del t.rows[_row(t, req.get('row'))]
    return True, False, None


def op_add_column(cfg, t, props, req, now):
    name = _check_new_name(t, req.get('name'))
    idx = len(t.headers)
    t.headers.append(name)
    for r in t.rows:
        if len(r) < idx:
            r.extend([''] * (idx - len(r)))
        r.insert(idx, '')
    ptype = req.get('type')
    if ptype and ptype != 'auto':
        if ptype not in TYPES or ptype == 'title':
            raise OneViewError('unknown type %r' % ptype)
        cfg['properties'].setdefault(name, {})['type'] = ptype
        return True, True, None
    return True, False, None


def op_delete_column(cfg, t, props, req, now):
    p = _prop(props, req.get('name'))
    if p.type == 'title':
        raise OneViewError('Pick another title column before deleting this one.')
    del t.headers[p.idx]
    for r in t.rows:
        if len(r) > p.idx:
            del r[p.idx]
    cfg_changed = cfg['properties'].pop(p.name, None) is not None
    return True, cfg_changed, None


def op_rename_column(cfg, t, props, req, now):
    p = _prop(props, req.get('old'))
    new = (req.get('new') or '').strip()
    if new == p.name:
        return False, False, None
    new = _check_new_name(t, new)
    t.headers[p.idx] = new
    if p.name in cfg['properties']:
        cfg['properties'][new] = cfg['properties'].pop(p.name)
    if cfg.get('title_property') == p.name:
        cfg['title_property'] = new
    for section, key in (('board', 'group_by'), ('calendar', 'date_property')):
        if cfg[section].get(key) == p.name:
            cfg[section][key] = new
    return True, True, None


def op_set_property(cfg, t, props, req, now):
    p = _prop(props, req.get('name'))
    conf = cfg['properties'].setdefault(p.name, {})
    patch = req.get('patch') or {}
    if 'type' in patch:
        if patch['type'] == 'auto':
            conf.pop('type', None)
        elif patch['type'] in TYPES and patch['type'] != 'title':
            conf['type'] = patch['type']
        else:
            raise OneViewError('unknown type %r' % patch['type'])
    for key in ('on_card', 'in_table'):
        if key in patch:
            conf[key] = bool(patch[key])
    if 'options' in patch:
        conf['options'] = {str(k): v for k, v in patch['options'].items() if v in COLOURS}
    if not conf:
        cfg['properties'].pop(p.name)
    return False, True, None


def op_set_title(cfg, t, props, req, now):
    cfg['title_property'] = _prop(props, req.get('name')).name
    return False, True, None


def op_set_defaults(cfg, t, props, req, now):
    if req.get('group_by'):
        cfg['board']['group_by'] = _prop(props, req['group_by']).name
    if req.get('date_property'):
        cfg['calendar']['date_property'] = _prop(props, req['date_property']).name
    return False, True, None


OPS = {
    'update_cell': op_update_cell, 'add_row': op_add_row, 'delete_row': op_delete_row,
    'add_column': op_add_column, 'delete_column': op_delete_column, 'rename_column': op_rename_column,
    'set_property': op_set_property, 'set_title': op_set_title, 'set_defaults': op_set_defaults,
}


# ---------------------------------------------------------------- page + server

def render_page(title, data, token):
    with open(TEMPLATE, encoding='utf-8') as f:
        html = f.read()
    # "</" is escaped so text in the CSV can never close the <script> tag early
    payload = json.dumps(data, ensure_ascii=False).replace('</', '<\\/')
    title = title.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')
    return html.replace('__TITLE__', title).replace('__TOKEN__', token).replace('__DATA__', payload)


def make_handler(store, token):
    class Handler(BaseHTTPRequestHandler):
        port = None

        def log_message(self, *args):
            pass

        def _host_ok(self):
            # Blocks other websites from reaching this server through DNS tricks.
            return self.headers.get('Host', '') in ('127.0.0.1:%d' % self.port, 'localhost:%d' % self.port)

        def _send(self, code, body, ctype='application/json; charset=utf-8'):
            data = body.encode('utf-8') if isinstance(body, str) else json.dumps(body, ensure_ascii=False).encode('utf-8')
            self.send_response(code)
            self.send_header('Content-Type', ctype)
            self.send_header('Content-Length', str(len(data)))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            if not self._host_ok():
                return self._send(403, {'error': 'forbidden'})
            path = urlparse(self.path).path
            try:
                if path == '/':
                    cfg = load_config(store.cfg_path)
                    return self._send(200, render_page(cfg['title'], None, token), 'text/html; charset=utf-8')
                if path == '/api/data':
                    return self._send(200, store.snapshot())
                if path == '/api/version':
                    return self._send(200, {'version': store.version()})
            except OneViewError as e:
                return self._send(e.status, {'error': str(e)})
            self._send(404, {'error': 'not found'})

        def do_POST(self):
            # The token header can't be sent by other websites, so only this page can write.
            if not self._host_ok() or self.headers.get('X-OneView-Token') != token:
                return self._send(403, {'error': 'forbidden'})
            if urlparse(self.path).path != '/api/op':
                return self._send(404, {'error': 'not found'})
            try:
                req = json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))) or b'{}')
                self._send(200, store.apply(req))
            except Conflict as e:
                self._send(409, {'error': str(e), 'data': store.snapshot()})
            except OneViewError as e:
                self._send(e.status, {'error': str(e)})
            except Exception as e:
                traceback.print_exc()
                self._send(500, {'error': 'Unexpected error: %s' % e})

    return Handler


def serve(store, port, open_browser):
    store.snapshot()                                # fail early if the CSV can't be read
    store.stamp_created_on_start()
    token = secrets.token_hex(16)
    handler = make_handler(store, token)
    for p in range(port, port + 20):
        try:
            server = ThreadingHTTPServer(('127.0.0.1', p), handler)
            break
        except OSError:
            continue
    else:
        raise SystemExit('No free port between %d and %d' % (port, port + 19))
    handler.port = p
    url = 'http://localhost:%d/' % p
    print('OneView is running at %s  (Ctrl+C to stop)' % url)
    for w in store.snapshot()['warnings']:
        print('warning:', w)
    if open_browser:
        threading.Timer(0.5, webbrowser.open, [url]).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\nstopped')


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--config', default=os.path.join(HERE, 'config.json'))
    ap.add_argument('--csv', help='CSV file to use instead of the one in the config')
    ap.add_argument('--port', type=int, default=8000)
    ap.add_argument('--no-browser', action='store_true', help="don't open a browser window")
    ap.add_argument('--export', action='store_true', help='write a read-only HTML snapshot and exit')
    ap.add_argument('--out', help='file for --export (default: "output" in the config)')
    args = ap.parse_args()

    store = Store(args.config, args.csv)
    try:
        if args.export:
            data = store.snapshot(live=False)
            cfg = load_config(store.cfg_path)
            out = resolve(os.path.dirname(store.cfg_path), args.out or cfg['output'])
            with open(out, 'w', encoding='utf-8') as f:
                f.write(render_page(cfg['title'], data, ''))
            for w in data['warnings']:
                print('warning:', w)
            print('wrote %s (%d cards, %d columns)' % (out, len(data['rows']), len(data['properties'])))
        else:
            serve(store, args.port, not args.no_browser)
    except OneViewError as e:
        sys.exit('error: %s' % e)


if __name__ == '__main__':
    main()
