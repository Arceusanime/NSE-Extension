#!/usr/bin/env python3
"""
oi_fetch.py  -  Angel One SmartAPI  ->  lines for the Pine Script "OI Levels" indicator, for MANY symbols.

FAST DAILY ROUTINE (recommended):
  EVENING after 3:45 PM, or MORNING before 9:15     python oi_fetch.py quick
       Reads the CURRENT OI of every strike in batches of 50 (a few minutes for ~230 symbols),
       saves a snapshot in the oi_snapshots folder, and ranks strikes by TOTAL OI (call + put)
       at the last close. Add --change to rank by OI change against the previous snapshot.
  Then after 9:16                                    python oi_fetch.py levels

The original slow method is still available:

  1) EVENING (after the market closes)   python oi_fetch.py collect
       For every symbol in symbols.txt it reads the option OI history and saves the OI change per
       strike (last completed day minus the day before) into oi_data.json.
       This is slow (roughly 20-40 minutes for ~230 stocks). If it stops because of rate limits,
       just run the same command again - it continues where it stopped.

  2) MORNING (after ~9:16, once the opening price is known)   python oi_fetch.py levels
       Reads oi_data.json, gets today's OPEN price for each symbol, picks the top 3 strikes
       above the open and the top 3 below it, and writes the compact lines
            SYMBOL | above1,above2,above3 | below1,below2,below3
       into oi_pine_1.txt, oi_pine_2.txt, ... (each small enough for one settings box).
       Paste file 1 into "OI Data - box 1", file 2 into box 2, and so on.  Once per day.

Setup (once):
    pip install smartapi-python pyotp requests logzero websocket-client pycryptodome
    Put your Angel One details in angel_login.txt (same folder as this file), one per line:
        API_KEY=...   CLIENT_ID=...   PIN=...   TOTP_SECRET=...
    (Environment variables ANGEL_API_KEY, ANGEL_CLIENT_ID, ANGEL_PIN, ANGEL_TOTP_SECRET also work.)
    Keep the file private - never send it to anyone.
    Create symbols.txt next to this file, one symbol per line, e.g.
        LICHSGFIN
        SYNGENE
        NIFTY
        BAJAJ-AUTO=BAJAJ_AUTO      # ANGEL_NAME=TRADINGVIEW_TICKER when the two names differ
    Lines starting with # are ignored.

NOTE: written from the SmartAPI SDK docs; it has NOT been run against a live account.
      Use --debug to print raw API responses if something looks wrong.
"""

import argparse
import json
import os
import sys
import time
from datetime import date, datetime, timedelta

import requests

# ─────────────────────────── CONFIG ────────────────────────────
SYMBOLS_FILE = "symbols.txt"
DATA_FILE = "oi_data.json"
STRIKES_EACH_SIDE = 5            # strikes above and below the current price to read
TOP_N = 3                        # levels above / below the open
INTERVAL = "FIFTEEN_MINUTE"      # candle size used to read OI history
LOOKBACK_DAYS = 8                # calendar days of OI history to request
SLEEP_BETWEEN_CALLS = 1.2        # seconds; keeps requests inside SmartAPI rate limits (raised from 0.4 - Angel's OI history endpoint rejects requests with AB1012 if hit too fast over a long batch run)
CHUNK_CHARS = 3500               # max characters per output file (one settings box each)
UNIT = 100000.0                  # OI change shown in lakhs

MASTER_URL = "https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json"

INDEX_INFO = {                   # index spot tokens on NSE; stocks are looked up as <SYMBOL>-EQ
    "NIFTY": ("Nifty 50", "99926000"),
    "BANKNIFTY": ("Nifty Bank", "99926009"),
    "FINNIFTY": ("Nifty Fin Service", "99926037"),
    "MIDCPNIFTY": ("NIFTY MID SELECT", "99926074"),
}
# ────────────────────────────────────────────────────────────────


_LOGIN_FILE = None
_FILE_KEYS = {"ANGEL_API_KEY": "API_KEY", "ANGEL_CLIENT_ID": "CLIENT_ID",
              "ANGEL_PIN": "PIN", "ANGEL_TOTP_SECRET": "TOTP_SECRET"}


def _load_login_file():
    """Reads angel_login.txt (next to this script): lines like  API_KEY=abcd1234"""
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "angel_login.txt")
    out = {}
    if os.path.exists(path):
        with open(path, encoding="utf-8-sig") as f:
            for line in f:
                line = line.split("#")[0].strip()
                if "=" in line:
                    k, v = line.split("=", 1)
                    out[k.strip().upper()] = v.strip().strip('"').strip("'").strip()
    return out


def need_env(name):
    """Login details come from angel_login.txt first, then from environment variables."""
    global _LOGIN_FILE
    if _LOGIN_FILE is None:
        _LOGIN_FILE = _load_login_file()
    key = _FILE_KEYS.get(name, "")
    v = (_LOGIN_FILE.get(key, "") or os.environ.get(name, "")).strip().strip('"').strip("'").strip()
    if not v:
        sys.exit(f"Missing {key or name}. Open angel_login.txt (in the same folder as oi_fetch.py) "
                 f"and type your real value after {key}=")
    if "YOUR" in v.upper():
        sys.exit(f"{key or name} still contains placeholder text ('YOUR...'). Type only the real value.")
    return v


def login():
    import pyotp
    from SmartApi import SmartConnect
    api = SmartConnect(api_key=need_env("ANGEL_API_KEY"))
    secret = need_env("ANGEL_TOTP_SECRET")
    secret = "".join(ch for ch in secret.upper() if ch.isalnum())     # drop spaces, quotes, dashes
    try:
        totp = pyotp.TOTP(secret).now()
    except Exception:
        sys.exit("ANGEL_TOTP_SECRET is not a valid TOTP key. It must be the long key (letters A-Z and "
                 "digits 2-7 only) from the Enable TOTP page, not the 6-digit code. Save it again with setx.")
    res = api.generateSession(need_env("ANGEL_CLIENT_ID"), need_env("ANGEL_PIN"), totp)
    if not res or not res.get("status"):
        sys.exit(f"Login failed: {res}")
    print("Login OK.")
    return api


MASTER_CACHE = "instrument_master.json"


def load_master():
    """Downloads Angel One's instrument list (a big file). Saved for the day, so it downloads only once."""
    if os.path.exists(MASTER_CACHE):
        age_hours = (time.time() - os.path.getmtime(MASTER_CACHE)) / 3600
        if age_hours < 20:
            try:
                with open(MASTER_CACHE, encoding="utf-8") as f:
                    data = json.load(f)
                print(f"Using the instrument list saved earlier today ({len(data)} entries).")
                return data
            except (ValueError, OSError):
                pass
    print("Downloading Angel One's instrument list. It is a big file, so this can take 2-5 minutes.")
    print("Please wait - do NOT press Ctrl+C. Nothing is wrong if it looks stuck.")
    chunks, got, last_print = [], 0, time.time()
    with requests.get(MASTER_URL, stream=True, timeout=(20, 120)) as r:
        r.raise_for_status()
        for chunk in r.iter_content(chunk_size=1 << 20):
            chunks.append(chunk)
            got += len(chunk)
            if time.time() - last_print > 5:
                print(f"  ...downloaded {got / 1e6:.0f} MB")
                last_print = time.time()
    raw = b"".join(chunks)
    data = json.loads(raw.decode("utf-8"))
    with open(MASTER_CACHE, "wb") as f:
        f.write(raw)
    print(f"Instrument list downloaded ({got / 1e6:.0f} MB, {len(data)} entries).")
    return data


def read_symbols(args):
    """Returns a list of (angel_name, tradingview_ticker)."""
    raw = []
    if args.symbols:
        raw = args.symbols
    elif os.path.exists(SYMBOLS_FILE):
        with open(SYMBOLS_FILE, encoding="utf-8") as f:
            raw = [ln.split("#")[0].strip() for ln in f]
    else:
        sys.exit(f"Create {SYMBOLS_FILE} (one symbol per line) or use --symbols")
    out = []
    for item in raw:
        if not item:
            continue
        if "=" in item:
            a, t = [x.strip().upper() for x in item.split("=", 1)]
        else:
            a = t = item.strip().upper()
        out.append((a, t))
    return out


def load_json(path):
    if os.path.exists(path):
        try:
            with open(path, encoding="utf-8") as f:
                return json.load(f)
        except (ValueError, OSError):
            return {}
    return {}


def save_json(path, obj):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f)


# ───────────────────────── option contracts ─────────────────────────
def option_contracts(master, name):
    today = date.today()
    out = []
    for it in master:
        if it.get("exch_seg") != "NFO" or it.get("name") != name:
            continue
        if it.get("instrumenttype") not in ("OPTSTK", "OPTIDX"):
            continue
        try:
            exp = datetime.strptime(it["expiry"], "%d%b%Y").date()
        except (KeyError, ValueError):
            continue
        if exp < today:
            continue
        sym = it.get("symbol", "")
        otype = "CE" if sym.endswith("CE") else ("PE" if sym.endswith("PE") else None)
        if not otype:
            continue
        try:
            strike = float(it["strike"]) / 100.0      # the master file stores strike x 100
        except (KeyError, ValueError):
            continue
        out.append({"token": it["token"], "symbol": sym, "expiry": exp, "strike": strike, "type": otype})
    return out


def spot_token(master, name):
    if name in INDEX_INFO:
        return INDEX_INFO[name]
    ts = f"{name}-EQ"
    tok = next((i["token"] for i in master if i.get("exch_seg") == "NSE" and i.get("symbol") == ts), None)
    return ts, tok


def spot_ltp(api, master, name):
    ts, tok = spot_token(master, name)
    if not tok:
        return None
    try:
        r = api.ltpData("NSE", ts, tok)
        return float(r["data"]["ltp"])
    except Exception:
        return None


# ───────────────────────── OI history ─────────────────────────
def parse_time(v):
    if isinstance(v, (int, float)):
        return datetime.fromtimestamp(v / 1000 if v > 1e11 else v)
    s = str(v).strip()
    try:
        return datetime.fromisoformat(s)
    except ValueError:
        pass
    for fmt_ in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%d-%m-%Y %H:%M"):
        try:
            return datetime.strptime(s, fmt_)
        except ValueError:
            continue
    return None


def parse_rows(data):
    """getOIData response -> sorted list of (datetime, oi)."""
    rows = []
    for r in data or []:
        if isinstance(r, dict):
            t = r.get("time") or r.get("timestamp") or r.get("datetime")
            oi = r.get("oi") if r.get("oi") is not None else r.get("openinterest")
        elif isinstance(r, (list, tuple)) and len(r) >= 2:
            t, oi = r[0], r[1]
        else:
            continue
        dt = parse_time(t)
        try:
            oi = float(oi)
        except (TypeError, ValueError):
            continue
        if dt:
            rows.append((dt, oi))
    rows.sort(key=lambda x: x[0])
    return rows


def fetch_oi_rows(api, token, debug=False):
    now = datetime.now()
    frm = (now - timedelta(days=LOOKBACK_DAYS)).replace(hour=9, minute=15, second=0, microsecond=0)
    to = now.replace(hour=15, minute=30, second=0, microsecond=0)
    params = {
        "exchange": "NFO",
        "symboltoken": str(token),
        "interval": INTERVAL,
        "fromdate": frm.strftime("%Y-%m-%d %H:%M"),
        "todate": to.strftime("%Y-%m-%d %H:%M"),
    }
    for attempt in range(3):
        try:
            res = api.getOIData(params)
        except Exception as e:
            res = {"status": False, "message": str(e)}
        if debug:
            print("DEBUG getOIData", params, "->", json.dumps(res)[:1000])
        if res and res.get("status"):
            return parse_rows(res.get("data"))
        # AB1012 usually means we're going too fast for this endpoint - wait longer, not just a short blip
        wait = 6.0 if (res and res.get("errorcode") == "AB1012") else 1.5 * (attempt + 1)
        time.sleep(wait)
    return []


def oi_change(rows, include_today=False):
    """OI at the close of the last trading day minus OI at the close of the previous trading day."""
    by_day = {}
    for dt, oi in rows:
        d = dt.date()
        if d == date.today() and not include_today:
            continue
        by_day[d] = oi
    days = sorted(by_day)
    if len(days) >= 2:
        return by_day[days[-1]] - by_day[days[-2]], days[-1]
    return None, (days[-1] if days else None)


def fmt(x):
    return f"{x:g}"


# ───────────────────────── step 1: collect ─────────────────────────
def collect_symbol(api, master, name, args):
    contracts = option_contracts(master, name)
    if not contracts:
        print(f"  {name}: no option contracts in the instrument master (check the name)")
        return None
    expiry = datetime.strptime(args.expiry.upper(), "%d%b%Y").date() if args.expiry else min(c["expiry"] for c in contracts)
    chain = [c for c in contracts if c["expiry"] == expiry]
    strikes = sorted({c["strike"] for c in chain})
    if not strikes:
        return None
    spot = spot_ltp(api, master, name)
    if spot is None:
        spot = strikes[len(strikes) // 2]
        print(f"  {name}: no spot price, using the middle strike {fmt(spot)}")
    atm = min(range(len(strikes)), key=lambda i: abs(strikes[i] - spot))
    chosen = strikes[max(0, atm - STRIKES_EACH_SIDE): atm + STRIKES_EACH_SIDE + 1]

    # After the market has closed (3:45 PM or later) today's OI is complete, so include today.
    now_ = datetime.now()
    use_today = args.include_today or (now_.hour * 60 + now_.minute >= 15 * 60 + 45)
    by_key = {(c["strike"], c["type"]): c for c in chain}
    calls, puts, data_day, empty = [], [], None, 0
    for k in chosen:
        vals = {}
        for typ in ("CE", "PE"):
            c = by_key.get((k, typ))
            chg = 0.0
            if c:
                rows = fetch_oi_rows(api, c["token"], debug=args.debug and not calls and typ == "CE")
                d_chg, day = oi_change(rows, use_today)
                if d_chg is None:
                    empty += 1
                else:
                    chg = d_chg
                if day:
                    data_day = day
                time.sleep(SLEEP_BETWEEN_CALLS)
            vals[typ] = round(chg / UNIT, 3)
        calls.append(vals["CE"])
        puts.append(vals["PE"])
        print(f"    strike {fmt(k)}: call {vals['CE']}  put {vals['PE']}", flush=True)
    if empty >= len(chosen):
        print(f"  {name}: no OI data came back (rate limit or empty response) - will retry on the next run")
        return None
    return {
        "collected_on": date.today().isoformat(),
        "expiry": expiry.isoformat(),
        "spot": spot,
        "data_day": str(data_day),
        "strikes": chosen,
        "call": calls,
        "put": puts,
    }


def cmd_collect(args):
    symbols = read_symbols(args)
    data = load_json(DATA_FILE)
    today = date.today().isoformat()
    api = login()
    master = load_master()
    done = 0
    for n, (name, tv) in enumerate(symbols, 1):
        rec = data.get(tv)
        if rec and rec.get("collected_on") == today and not args.force:
            done += 1
            continue
        print(f"[{n}/{len(symbols)}] {name} ... (about 20-40 seconds per symbol - please wait)", flush=True)
        try:
            rec = collect_symbol(api, master, name, args)
        except Exception as e:                      # one bad symbol must not stop the whole run
            print(f"  {name}: error {e}")
            rec = None
        if rec:
            data[tv] = rec
            save_json(DATA_FILE, data)
            done += 1
    print(f"\nCollected {done} of {len(symbols)} symbols into {DATA_FILE}.")
    if done < len(symbols):
        print("Some symbols are missing - run the same command again to fill them in.")


# ───────────────────────── step 2: levels ─────────────────────────
def score_of(c, p, mode):
    if mode == "max":
        return max(c, p)
    if mode == "call":
        return c
    if mode == "put":
        return p
    return c + p                                       # total


def pick_levels(strikes, calls, puts, open_price, top_n, mode):
    """Top N strikes at/above the open and top N below it, ranked by score (highest first)."""
    scored = [(s, score_of(c, p, mode)) for s, c, p in zip(strikes, calls, puts)]
    above = sorted([x for x in scored if x[0] >= open_price], key=lambda x: -x[1])[:top_n]
    below = sorted([x for x in scored if x[0] < open_price], key=lambda x: -x[1])[:top_n]
    return [s for s, _ in above], [s for s, _ in below]


def get_opens(api, master, names, debug=False):
    """{tradingview_ticker: (open, used_close_instead)} using the SmartAPI market-data (OHLC) call."""
    tok_to_name, tokens = {}, []
    for tv, angel in names.items():
        _, tok = spot_token(master, angel)
        if tok:
            tok_to_name[str(tok)] = tv
            tokens.append(str(tok))
    out = {}
    for i in range(0, len(tokens), 50):
        batch = tokens[i:i + 50]
        try:
            res = api.getMarketData("OHLC", {"NSE": batch})
        except Exception as e:
            print("market data error:", e)
            continue
        if debug:
            print("DEBUG getMarketData ->", json.dumps(res)[:1000])
        fetched = ((res or {}).get("data") or {}).get("fetched") or []
        for item in fetched:
            tv = tok_to_name.get(str(item.get("symbolToken")))
            if not tv:
                continue
            o = float(item.get("open") or 0)
            if o > 0:
                out[tv] = (o, False)
            else:
                c = float(item.get("close") or 0)     # market not open yet: use previous close
                if c > 0:
                    out[tv] = (c, True)
        time.sleep(1.0)
    return out


def chunk_lines(lines, limit):
    chunks, cur, size = [], [], 0
    for ln in lines:
        add = len(ln) + 1
        if cur and size + add > limit:
            chunks.append(cur)
            cur, size = [], 0
        cur.append(ln)
        size += add
    if cur:
        chunks.append(cur)
    return chunks


def cmd_levels(args):
    data = load_json(DATA_FILE)
    if not data:
        sys.exit(f"{DATA_FILE} is empty - run 'python oi_fetch.py collect' first")
    api = login()
    master = load_master()
    sym_map = {tv: angel for angel, tv in read_symbols(args)} if (args.symbols or os.path.exists(SYMBOLS_FILE)) else {}
    names = {tv: sym_map.get(tv, tv) for tv in data}
    opens = get_opens(api, master, names, debug=args.debug)

    lines, used_close, missing = [], 0, []
    for tv, rec in data.items():
        if tv not in opens:
            missing.append(tv)
            continue
        o, was_close = opens[tv]
        used_close += was_close
        above, below = pick_levels(rec["strikes"], rec["call"], rec["put"], o, TOP_N, args.rank)
        lines.append(f"{tv} | {','.join(fmt(x) for x in above)} | {','.join(fmt(x) for x in below)}")

    chunks = chunk_lines(lines, CHUNK_CHARS)
    for old in os.listdir("."):
        if old.startswith("oi_pine_") and old.endswith(".txt"):
            os.remove(old)
    for i, ch in enumerate(chunks, 1):
        with open(f"oi_pine_{i}.txt", "w", encoding="utf-8") as f:
            f.write("\n".join(ch) + "\n")

    print(f"{len(lines)} symbols written to {len(chunks)} file(s): " + ", ".join(f"oi_pine_{i}.txt" for i in range(1, len(chunks) + 1)))
    print("Paste file 1 into 'OI Data - box 1', file 2 into 'box 2', and so on (the indicator has 4 boxes).")
    if len(chunks) > 4:
        print("WARNING: more than 4 files - the indicator only has 4 boxes. Reduce the symbols or raise CHUNK_CHARS.")
    if used_close:
        print(f"NOTE: {used_close} symbol(s) had no open price yet, so the previous close was used. Run again after 9:16 for exact opens.")
    if missing:
        print("No price found for: " + ", ".join(missing))


# ───────────────────────── fast collect: quick ─────────────────────────
SNAP_DIR = "oi_snapshots"
QUICK_BATCH = 50                 # getMarketData accepts up to 50 tokens per request
QUICK_SLEEP = 1.0                # seconds between batches
KEEP_SNAPSHOTS = 10              # older snapshot files are deleted
# 'quick' ranks strikes by TOTAL OI (the biggest open positions at the last close).
# Use  python oi_fetch.py quick --change  to rank by OI change against the previous snapshot instead.


def index_master(master):
    """Build lookups once instead of scanning the whole instrument list for every symbol."""
    opts, eq = {}, {}
    for it in master:
        seg = it.get("exch_seg")
        if seg == "NFO" and it.get("instrumenttype") in ("OPTSTK", "OPTIDX"):
            opts.setdefault(it.get("name"), []).append(it)
        elif seg == "NSE":
            s = it.get("symbol", "")
            if s.endswith("-EQ"):
                eq[s] = it.get("token")
    return opts, eq


def market_data(api, mode, exchange, tokens, debug=False):
    """Batched getMarketData -> {token: item}. Retries each batch up to 3 times."""
    out = {}
    tokens = list(dict.fromkeys(str(t) for t in tokens if t))
    total = (len(tokens) + QUICK_BATCH - 1) // QUICK_BATCH
    for bi, i in enumerate(range(0, len(tokens), QUICK_BATCH), 1):
        batch = tokens[i:i + QUICK_BATCH]
        for attempt in range(3):
            try:
                res = api.getMarketData(mode, {exchange: batch})
            except Exception as e:
                res = {"status": False, "message": str(e)}
            if debug and bi == 1 and attempt == 0:
                print(f"DEBUG getMarketData {mode} {exchange} ->", json.dumps(res)[:1000])
            if res and res.get("status"):
                for item in ((res.get("data") or {}).get("fetched") or []):
                    out[str(item.get("symbolToken"))] = item
                break
            time.sleep(2.0 * (attempt + 1))
        if exchange == "NFO":
            print(f"  OI batch {bi}/{total} done", flush=True)
        time.sleep(QUICK_SLEEP)
    return out


def get_oi(item):
    for f in ("opnInterest", "openInterest", "oi"):
        v = item.get(f)
        if v is not None:
            try:
                return float(v)
            except (TypeError, ValueError):
                pass
    return None


def trading_day_label():
    """The trading day the OI belongs to: before 9:15 it is the previous weekday's closing OI."""
    now = datetime.now()
    d = now.date()
    if now.hour * 60 + now.minute < 9 * 60 + 15:
        d -= timedelta(days=1)
    while d.weekday() >= 5:
        d -= timedelta(days=1)
    return d


def previous_snapshot(label):
    if not os.path.isdir(SNAP_DIR):
        return {}, None
    names = sorted(f[:-5] for f in os.listdir(SNAP_DIR) if f.endswith(".json") and f[:-5] < label.isoformat())
    if not names:
        return {}, None
    return load_json(os.path.join(SNAP_DIR, names[-1] + ".json")), names[-1]


def cmd_quick(args):
    symbols = read_symbols(args)
    label = trading_day_label()
    now = datetime.now()
    if now.weekday() < 5 and 9 * 60 + 15 <= now.hour * 60 + now.minute < 15 * 60 + 30:
        print("NOTE: the market is open, so this reads LIVE (incomplete) OI. For proper levels run it "
              "after 3:45 PM or before 9:15 AM.")
    api = login()
    master = load_master()
    opts, eq = index_master(master)
    del master

    # 1) spot prices for all symbols in a few batched calls
    spot_tok = {}
    for name, tv in symbols:
        if name in INDEX_INFO:
            spot_tok[tv] = str(INDEX_INFO[name][1])
        else:
            tok = eq.get(f"{name}-EQ")
            if tok:
                spot_tok[tv] = str(tok)
    print(f"Reading spot prices for {len(spot_tok)} symbols...")
    spots = market_data(api, "LTP", "NSE", spot_tok.values(), debug=args.debug)

    # 2) choose strikes per symbol (same rule as 'collect': nearest expiry, ATM +/- STRIKES_EACH_SIDE)
    plan, all_tokens = {}, []
    for name, tv in symbols:
        contracts = option_contracts(opts.get(name, []), name)
        if not contracts:
            print(f"  {name}: no option contracts in the instrument master (check the name)")
            continue
        expiry = (datetime.strptime(args.expiry.upper(), "%d%b%Y").date() if args.expiry
                  else min(c["expiry"] for c in contracts))
        chain = [c for c in contracts if c["expiry"] == expiry]
        strikes = sorted({c["strike"] for c in chain})
        if not strikes:
            continue
        item = spots.get(spot_tok.get(tv, ""))
        spot = float(item["ltp"]) if item and item.get("ltp") else strikes[len(strikes) // 2]
        atm = min(range(len(strikes)), key=lambda i: abs(strikes[i] - spot))
        chosen = strikes[max(0, atm - STRIKES_EACH_SIDE): atm + STRIKES_EACH_SIDE + 1]
        by_key = {(c["strike"], c["type"]): str(c["token"]) for c in chain}
        keys = {(k, t): by_key[(k, t)] for k in chosen for t in ("CE", "PE") if (k, t) in by_key}
        all_tokens.extend(keys.values())
        plan[tv] = {"name": name, "expiry": expiry, "spot": spot, "strikes": chosen, "keys": keys}

    # 3) current OI of every chosen contract, 50 per request
    print(f"Reading OI for {len(all_tokens)} option contracts...")
    quotes = market_data(api, "FULL", "NFO", all_tokens, debug=args.debug)

    # 4) snapshot + change against the previous snapshot
    prev, prev_day = previous_snapshot(label)
    snap_path = os.path.join(SNAP_DIR, label.isoformat() + ".json")
    snap = load_json(snap_path)
    data = load_json(DATA_FILE)
    n_change, n_total, failed = 0, 0, []
    for tv, p in plan.items():
        oi_map = {}
        for (k, t), tok in p["keys"].items():
            q = quotes.get(tok)
            oi = get_oi(q) if q else None
            if oi is not None:
                skey = f"{p['name']}|{p['expiry'].isoformat()}|{fmt(k)}|{t}"
                oi_map[(k, t)] = (skey, oi)
                snap[skey] = oi
        if not oi_map:
            failed.append(tv)
            continue
        use_change = args.change and bool(prev) and all(skey in prev for skey, _ in oi_map.values())
        calls, puts = [], []
        for k in p["strikes"]:
            vals = {}
            for t in ("CE", "PE"):
                if (k, t) in oi_map:
                    skey, oi = oi_map[(k, t)]
                    v = oi - prev[skey] if use_change else oi
                else:
                    v = 0.0
                vals[t] = round(v / UNIT, 3)
            calls.append(vals["CE"])
            puts.append(vals["PE"])
        n_change += use_change
        n_total += not use_change
        data[tv] = {
            "collected_on": date.today().isoformat(),
            "expiry": p["expiry"].isoformat(),
            "spot": p["spot"],
            "data_day": label.isoformat(),
            "strikes": p["strikes"],
            "call": calls,
            "put": puts,
            "basis": "change" if use_change else "total",
        }

    os.makedirs(SNAP_DIR, exist_ok=True)
    save_json(snap_path, snap)
    save_json(DATA_FILE, data)
    for old in sorted(f for f in os.listdir(SNAP_DIR) if f.endswith(".json"))[:-KEEP_SNAPSHOTS]:
        os.remove(os.path.join(SNAP_DIR, old))

    print(f"\nSaved {n_change + n_total} of {len(symbols)} symbols into {DATA_FILE} (OI of {label.isoformat()}).")
    if n_change:
        print(f"  {n_change} ranked by OI CHANGE vs the snapshot of {prev_day}.")
    if n_total:
        if args.change:
            print(f"  {n_total} ranked by TOTAL OI (no earlier snapshot for them yet - normal on the first run "
                  f"or right after an expiry). From the next day they switch to OI change.")
        else:
            print(f"  {n_total} ranked by TOTAL OI (highest open positions at the last close).")
    if failed:
        print("No OI came back for: " + ", ".join(failed) + "  -  run 'quick' again to retry.")
    print("Next: python oi_fetch.py levels")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("command", choices=["quick", "collect", "levels"])
    ap.add_argument("--symbols", nargs="*", help="override symbols.txt")
    ap.add_argument("--expiry", help="e.g. 29SEP2026 (default: nearest expiry)")
    ap.add_argument("--include-today", action="store_true", help="also use today's OI (default: last completed day)")
    ap.add_argument("--force", action="store_true", help="re-collect symbols already collected today")
    ap.add_argument("--rank", choices=["total", "max", "call", "put"], default="total", help="how strikes are ranked (default: call+put total)")
    ap.add_argument("--change", action="store_true", help="quick: rank by OI change vs the previous snapshot (default: total OI)")
    ap.add_argument("--debug", action="store_true", help="print raw API responses")
    args = ap.parse_args()
    if args.command == "quick":
        cmd_quick(args)
    elif args.command == "collect":
        cmd_collect(args)
    else:
        cmd_levels(args)


if __name__ == "__main__":
    main()
