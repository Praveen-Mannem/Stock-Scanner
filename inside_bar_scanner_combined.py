"""
Inside Bar Breakout Scanner — TWO SCANNERS IN ONE SCRIPT
------------------------------------------------------------------------------
  SCANNER 1: NIFTY 50 constituents (hourly candles)
  SCANNER 2: ALL NSE-listed stocks priced <= Rs 500 (hourly candles)

Data source: Yahoo Finance via `yfinance` (free, no signup, no API key).

IMPORTANT — read before running Scanner 2:
  NSE has 2000+ listed equities. Scanning all of them on hourly candles via
  a free data source means:
    - It WILL take a long time to run (think 20-60+ minutes depending on
      your internet connection and Yahoo's rate limiting that day).
    - Yahoo may start returning errors/blocks if hit too fast — this script
      batches requests and pauses briefly between batches to reduce that risk,
      but you may still see some "[skip]" lines for symbols that time out.
    - This is normal. Let it finish, or lower ALL_NSE_TEST_LIMIT below to
      test on a smaller slice first (recommended before your first full run).

Install dependencies (Mac terminal):
    pip3 install yfinance requests --break-system-packages

Run:
    python3 inside_bar_scanner_combined.py
"""

import os
import sys
import time
from dataclasses import dataclass
from datetime import datetime

try:
    import yfinance as yf
    import requests
except ImportError:
    print("Missing dependency. Install it with:\n    pip3 install yfinance requests --break-system-packages")
    sys.exit(1)


# --------------------------------------------------------------------------
# CONFIG
# --------------------------------------------------------------------------

RUN_NIFTY50_SCANNER = True
RUN_ALL_NSE_UNDER_500_SCANNER = True

INTERVAL = "60m"
LOOKBACK_PERIOD = "1mo"
VOLUME_CONFIRM = True
VOLUME_LOOKBACK = 20
MAX_PRICE = 500.0          # price ceiling for Scanner 2
BATCH_SIZE = 15            # tickers fetched per yfinance batch call (lower = more reliable, slower)
BATCH_PAUSE_SECONDS = 2.5  # pause between batches to ease rate limiting / DNS load

# Set this to a small number (e.g. 100) to test Scanner 2 quickly before
# committing to a full multi-thousand-ticker run. Set to None for full run.
ALL_NSE_TEST_LIMIT = 100

NSE_EQUITY_LIST_URL = "https://nsearchives.nseindia.com/content/equities/EQUITY_L.csv"
LOCAL_CACHE_FILE = "nse_equity_list_cache.csv"

# --------------------------------------------------------------------------
# GOOGLE SHEETS CONFIG
# Target Sheet: https://docs.google.com/spreadsheets/d/1d3wJfxxkWYrHa23qeIbQCoTYpEpI6mSNefjzFfLGACA/edit?gid=1661228420#gid=1661228420
# --------------------------------------------------------------------------
SPREADSHEET_ID = "1d3wJfxxkWYrHa23qeIbQCoTYpEpI6mSNefjzFfLGACA"
SHEET_GID = "1661228420"
EXPORT_TO_GOOGLE_SHEET = True

# Option 1: Google Apps Script Web App URL (Recommended)
GOOGLE_SHEET_WEBHOOK_URL = "https://script.google.com/macros/s/AKfycbwhStvUOaJTEdIzxOwJZc3DK7aOhsD5tR-AZrhY_BhPWY7mwN5BU_JuNSilFfDC1P6S/exec"

# Option 2: Service Account Credentials File
SERVICE_ACCOUNT_FILE = "service_account.json"


NIFTY_50 = [
    "ADANIENT.NS", "ADANIPORTS.NS", "APOLLOHOSP.NS", "ASIANPAINT.NS", "AXISBANK.NS",
    "BAJAJ-AUTO.NS", "BAJFINANCE.NS", "BAJAJFINSV.NS", "BEL.NS", "BHARTIARTL.NS",
    "CIPLA.NS", "COALINDIA.NS", "DRREDDY.NS", "EICHERMOT.NS", "ETERNAL.NS",
    "GRASIM.NS", "HCLTECH.NS", "HDFCBANK.NS", "HDFCLIFE.NS", "HINDALCO.NS",
    "HINDUNILVR.NS", "ICICIBANK.NS", "INDIGO.NS", "INFY.NS", "ITC.NS",
    "JIOFIN.NS", "JSWSTEEL.NS", "KOTAKBANK.NS", "LT.NS", "M&M.NS",
    "MARUTI.NS", "MAXHEALTH.NS", "NESTLEIND.NS", "NTPC.NS", "ONGC.NS",
    "POWERGRID.NS", "RELIANCE.NS", "SBILIFE.NS", "SHRIRAMFIN.NS", "SBIN.NS",
    "SUNPHARMA.NS", "TCS.NS", "TATACONSUM.NS", "TMPV.NS", "TATASTEEL.NS",
    "TECHM.NS", "TITAN.NS", "TRENT.NS", "ULTRACEMCO.NS", "WIPRO.NS",
]


@dataclass
class Signal:
    ticker: str
    datetime_str: str
    direction: str
    inside_high: float
    inside_low: float
    close: float
    volume_ok: str
    entry: str
    stop_loss: str
    target: str


# --------------------------------------------------------------------------
# NSE full equity list fetch (for Scanner 2)
# --------------------------------------------------------------------------

def fetch_all_nse_symbols():
    """Download the full NSE equity list. Falls back to a local cache file
    if the live download fails (NSE's site sometimes blocks non-browser
    requests). If both fail, returns an empty list and tells the user how
    to fix it manually."""
    try:
        session = requests.Session()
        headers = {
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                          "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        }
        # Hit the main site first to pick up cookies NSE expects
        session.get("https://www.nseindia.com", headers=headers, timeout=10)
        resp = session.get(NSE_EQUITY_LIST_URL, headers=headers, timeout=15)
        resp.raise_for_status()

        lines = resp.text.strip().splitlines()
        header = lines[0].split(",")
        symbol_idx = header.index("SYMBOL")

        symbols = []
        for line in lines[1:]:
            parts = line.split(",")
            if len(parts) > symbol_idx:
                symbols.append(parts[symbol_idx].strip())

        if symbols:
            with open(LOCAL_CACHE_FILE, "w") as f:
                f.write("\n".join(symbols))
            print(f"Fetched {len(symbols)} NSE symbols live and cached to {LOCAL_CACHE_FILE}.\n")
            return [f"{s}.NS" for s in symbols]

    except Exception as e:
        print(f"Live NSE symbol list download failed ({e}). Trying local cache...\n")

    try:
        with open(LOCAL_CACHE_FILE) as f:
            symbols = [line.strip() for line in f if line.strip()]
        if symbols:
            print(f"Loaded {len(symbols)} NSE symbols from local cache.\n")
            return [f"{s}.NS" for s in symbols]
    except FileNotFoundError:
        pass

    print(
        "Could not get the NSE symbol list automatically.\n"
        "Manual fix: download this file yourself in a browser:\n"
        f"  {NSE_EQUITY_LIST_URL}\n"
        f"and save it in this script's folder as '{LOCAL_CACHE_FILE}' "
        "(just the SYMBOL column, one per line, no header), then re-run.\n"
    )
    return []


# --------------------------------------------------------------------------
# Scanning logic
# --------------------------------------------------------------------------

def compute_atr(df, period=14):
    high, low, close = df["High"], df["Low"], df["Close"]
    prev_close = close.shift(1)
    tr = (high - low).combine((high - prev_close).abs(), max).combine(
        (low - prev_close).abs(), max
    )
    return tr.rolling(period).mean()


def evaluate_frame(ticker, df, apply_price_filter):
    if df is None or len(df) < 20 or df["Close"].isna().all():
        return None

    df = df.dropna(subset=["High", "Low", "Close", "Volume"])
    if len(df) < 20:
        return None

    df["AvgVol"] = df["Volume"].rolling(VOLUME_LOOKBACK).mean()

    mother = df.iloc[-3]
    inside = df.iloc[-2]
    latest = df.iloc[-1]

    latest_close = float(latest["Close"])
    if apply_price_filter and latest_close > MAX_PRICE:
        return None

    inside_high = float(inside["High"])
    inside_low = float(inside["Low"])

    is_inside = (inside_high < mother["High"]) and (inside_low > mother["Low"])
    if not is_inside:
        return None

    breakout_up = latest_close > inside_high
    breakout_down = latest_close < inside_low

    # RISK_REWARD sets the target distance as a multiple of the risk
    # (distance from entry to stop-loss). 2.0 = 1:2 risk-reward.
    RISK_REWARD = 2.0

    if not (breakout_up or breakout_down):
        direction = "INSIDE BAR FORMED (watch)"
        # Not triggered yet — show both potential trigger levels.
        long_risk = inside_high - inside_low
        short_risk = inside_high - inside_low
        entry = f"Buy>{round(inside_high, 2)} / Sell<{round(inside_low, 2)}"
        stop_loss = f"SL {round(inside_low, 2)} / SL {round(inside_high, 2)}"
        target = (f"T {round(inside_high + RISK_REWARD * long_risk, 2)} / "
                  f"T {round(inside_low - RISK_REWARD * short_risk, 2)}")
    elif breakout_up:
        direction = "BULLISH BREAKOUT"
        entry_price = inside_high
        sl_price = inside_low
        risk = entry_price - sl_price
        target_price = entry_price + RISK_REWARD * risk
        entry = str(round(entry_price, 2))
        stop_loss = str(round(sl_price, 2))
        target = str(round(target_price, 2))
    else:
        direction = "BEARISH BREAKOUT"
        entry_price = inside_low
        sl_price = inside_high
        risk = sl_price - entry_price
        target_price = entry_price - RISK_REWARD * risk
        entry = str(round(entry_price, 2))
        stop_loss = str(round(sl_price, 2))
        target = str(round(target_price, 2))

    vol_ok = "n/a"
    if VOLUME_CONFIRM and (breakout_up or breakout_down):
        avg_vol = df["AvgVol"].iloc[-1]
        vol_ok = "YES" if latest["Volume"] > avg_vol else "NO (low volume)"

    return Signal(
        ticker=ticker,
        datetime_str=str(df.index[-1]),
        direction=direction,
        inside_high=round(inside_high, 2),
        inside_low=round(inside_low, 2),
        close=round(latest_close, 2),
        volume_ok=vol_ok,
        entry=entry,
        stop_loss=stop_loss,
        target=target,
    )


def scan_batch(tickers, apply_price_filter):
    """Download one batch of tickers together and evaluate each."""
    results = []
    try:
        data = yf.download(
            tickers=tickers,
            period=LOOKBACK_PERIOD,
            interval=INTERVAL,
            group_by="ticker",
            threads=False,  # avoid concurrent SQLite cache writes ("database is locked" errors)
            progress=False,
        )
    except Exception:
        return results  # whole batch failed to fetch — skip silently, batch-level

    for ticker in tickers:
        try:
            if len(tickers) == 1:
                df = data
            else:
                df = data[ticker] if ticker in data.columns.get_level_values(0) else None
            sig = evaluate_frame(ticker, df, apply_price_filter)
            if sig:
                results.append(sig)
        except Exception:
            continue  # one bad ticker shouldn't kill the batch
    return results


def print_results(title, results):
    print(f"\n=== {title} ===")
    if not results:
        print("No inside bar setups found.")
        return
    print(f"{'Ticker':<16}{'Bar Time':<22}{'Signal':<28}{'Close':<10}{'Vol OK':<18}{'Entry':<24}{'Stop-Loss':<24}{'Target'}")
    print("-" * 165)
    for s in results:
        print(
            f"{s.ticker:<16}{s.datetime_str:<22}{s.direction:<28}{s.close:<10}{s.volume_ok:<18}"
            f"{s.entry:<24}{s.stop_loss:<24}{s.target}"
        )


def export_to_google_sheet(title, results):
    if not EXPORT_TO_GOOGLE_SHEET or not results:
        return

    rows = []
    headers = ["Updated At", "Scanner", "Ticker", "Bar Time", "Signal", "Close", "Volume OK", "Entry", "Stop Loss", "Target"]
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    for s in results:
        rows.append({
            "Updated At": timestamp,
            "Scanner": title,
            "Ticker": s.ticker,
            "Bar Time": s.datetime_str,
            "Signal": s.direction,
            "Close": str(s.close),
            "Volume OK": s.volume_ok,
            "Entry": s.entry,
            "Stop Loss": s.stop_loss,
            "Target": s.target
        })

    # Method 1: Google Apps Script Web App (Webhook)
    if GOOGLE_SHEET_WEBHOOK_URL:
        try:
            print(f"\nSending {len(results)} signals to Google Sheet via Webhook...")
            payload = {
                "spreadsheet_id": SPREADSHEET_ID,
                "sheet_gid": SHEET_GID,
                "scanner_title": title,
                "updated_at": timestamp,
                "data": rows
            }
            res = requests.post(GOOGLE_SHEET_WEBHOOK_URL, json=payload, timeout=30)
            if res.status_code == 200:
                print("✓ Google Sheet updated successfully via Webhook!")
            else:
                print(f"⚠️ Google Sheet Webhook returned status code {res.status_code}: {res.text}")
        except Exception as e:
            print(f"⚠️ Failed to update Google Sheet via Webhook: {e}")

    # Method 2: gspread via Service Account
    elif os.path.exists(SERVICE_ACCOUNT_FILE):
        try:
            import gspread
            print(f"\nSending {len(results)} signals to Google Sheet via gspread...")
            gc = gspread.service_account(filename=SERVICE_ACCOUNT_FILE)
            sh = gc.open_by_key(SPREADSHEET_ID)
            
            worksheet = None
            for w in sh.worksheets():
                if str(w.id) == str(SHEET_GID):
                    worksheet = w
                    break
            if not worksheet:
                worksheet = sh.sheet1

            sheet_data = []
            existing = worksheet.get_all_values()
            if not existing:
                sheet_data.append(headers)

            for r in rows:
                sheet_data.append([r[h] for h in headers])

            worksheet.append_rows(sheet_data[1:] if existing else sheet_data)
            print(f"✓ Google Sheet updated successfully via gspread!")
        except Exception as e:
            print(f"⚠️ Failed to update Google Sheet via gspread: {e}")

    else:
        print(f"\n[Google Sheet Target]")
        print(f"Spreadsheet Link: https://docs.google.com/spreadsheets/d/{SPREADSHEET_ID}/edit#gid={SHEET_GID}")
        print("Note: To enable automatic export to your Google Sheet:")
        print(" 1. Add your Google Apps Script Web App URL to GOOGLE_SHEET_WEBHOOK_URL in this script.")
        print(" 2. OR place 'service_account.json' in this folder and install gspread (pip3 install gspread google-auth).")


def run_scanner(title, tickers, apply_price_filter):
    all_results = []
    total = len(tickers)
    for i in range(0, total, BATCH_SIZE):
        batch = tickers[i:i + BATCH_SIZE]
        print(f"  Scanning {i + 1}-{min(i + BATCH_SIZE, total)} of {total} ({title})...", end="\r")
        all_results.extend(scan_batch(batch, apply_price_filter))
        time.sleep(BATCH_PAUSE_SECONDS)
    print(" " * 80, end="\r")  # clear progress line
    print_results(title, all_results)
    export_to_google_sheet(title, all_results)


# Set FORCE_RUN = True or pass --force to run the scanner on weekends/holidays
FORCE_RUN = False


def main():
    today = datetime.now()
    is_force = "--force" in sys.argv or FORCE_RUN
    if today.weekday() >= 5 and not is_force:  # 0=Monday ... 4=Friday, 5=Saturday, 6=Sunday
        print(f"Today is {today.strftime('%A')} ({today.strftime('%Y-%m-%d')}). Scanner runs automatically Monday to Friday.")
        print("To run right now (e.g., to test weekend data or verify Google Sheet export), run with --force:")
        print("    python3 inside_bar_scanner_combined.py --force")
        sys.exit(0)

    print(f"Combined Inside Bar Scanner — {datetime.now().strftime('%Y-%m-%d %H:%M')} | Interval: {INTERVAL}")

    if RUN_NIFTY50_SCANNER:
        run_scanner("SCANNER 1: NIFTY 50", NIFTY_50, apply_price_filter=False)

    if RUN_ALL_NSE_UNDER_500_SCANNER:
        print("\nFetching full NSE equity list for Scanner 2...")
        all_nse = fetch_all_nse_symbols()
        if not all_nse:
            print("Skipping Scanner 2 — no symbol list available (see message above).")
            return

        if ALL_NSE_TEST_LIMIT:
            all_nse = all_nse[:ALL_NSE_TEST_LIMIT]
            print(f"(TEST MODE: limited to first {ALL_NSE_TEST_LIMIT} symbols. "
                  f"Set ALL_NSE_TEST_LIMIT = None in the script for a full run.)")

        print(f"This will scan {len(all_nse)} stocks — may take a while, please be patient.\n")
        run_scanner("SCANNER 2: ALL NSE STOCKS (ALL PRICES)", all_nse, apply_price_filter=False)


if __name__ == "__main__":
    main()