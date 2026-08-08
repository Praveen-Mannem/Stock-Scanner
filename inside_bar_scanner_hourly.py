"""
Inside Bar Breakout Scanner — Full NIFTY 50, HOURLY candles, price <= 500
----------------------------------------------------------------------------
Scans all current NIFTY 50 constituents on 1-hour candles for inside bar
breakout setups, and only lists results for stocks currently trading at
or below Rs 500.

NOTE ON FUTURES: Yahoo Finance (yfinance) does not carry NSE stock futures
contract data (e.g. RELIANCE25AUGFUT) - only cash-market equity prices and
index futures are available through this free source. This script covers
the NIFTY 50 CASH/EQUITY list only. If you need futures scanning, that
requires the Dhan API (which has proper F&O securityIds) - let me know if
you want that version built.

NIFTY 50 list used below reflects constituents as of Dec 2025 (semi-annual
index reshuffles happen every Jan 31 / Jul 31 cutoff, so double check
against nseindia.com if this is being run months after that).

Install dependency (Mac):
    pip3 install yfinance --break-system-packages

Run:
    python3 inside_bar_scanner_nifty50.py
"""

import sys
from dataclasses import dataclass
from datetime import datetime

try:
    import yfinance as yf
except ImportError:
    print("Missing dependency. Install it with:\n    pip3 install yfinance --break-system-packages")
    sys.exit(1)


# --------------------------------------------------------------------------
# CONFIG
# --------------------------------------------------------------------------

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

INTERVAL = "60m"
LOOKBACK_PERIOD = "1mo"
VOLUME_CONFIRM = True
VOLUME_LOOKBACK = 20
MAX_PRICE = 500.0   # only list results at or below this price
MIN_MOTHER_BAR_ATR_MULT = 0.0


@dataclass
class Signal:
    ticker: str
    datetime_str: str
    direction: str
    inside_high: float
    inside_low: float
    close: float
    volume_ok: str


def compute_atr(df, period=14):
    high, low, close = df["High"], df["Low"], df["Close"]
    prev_close = close.shift(1)
    tr = (high - low).combine((high - prev_close).abs(), max).combine(
        (low - prev_close).abs(), max
    )
    return tr.rolling(period).mean()


def scan_ticker(ticker: str):
    df = yf.download(ticker, period=LOOKBACK_PERIOD, interval=INTERVAL, progress=False)
    if df is None or len(df) < 20:
        return None

    if isinstance(df.columns, __import__("pandas").MultiIndex):
        df.columns = df.columns.get_level_values(0)

    df["ATR"] = compute_atr(df)
    df["AvgVol"] = df["Volume"].rolling(VOLUME_LOOKBACK).mean()

    mother = df.iloc[-3]
    inside = df.iloc[-2]
    latest = df.iloc[-1]

    latest_close = float(latest["Close"])
    if latest_close > MAX_PRICE:
        return None  # price filter

    is_inside = (inside["High"] < mother["High"]) and (inside["Low"] > mother["Low"])
    if not is_inside:
        return None

    if MIN_MOTHER_BAR_ATR_MULT > 0:
        mother_range = mother["High"] - mother["Low"]
        atr_at_mother = df["ATR"].iloc[-3]
        if atr_at_mother and mother_range < MIN_MOTHER_BAR_ATR_MULT * atr_at_mother:
            return None

    breakout_up = latest_close > inside["High"]
    breakout_down = latest_close < inside["Low"]

    if not (breakout_up or breakout_down):
        direction = "INSIDE BAR FORMED (watch)"
    elif breakout_up:
        direction = "BULLISH BREAKOUT"
    else:
        direction = "BEARISH BREAKOUT"

    vol_ok = "n/a"
    if VOLUME_CONFIRM and (breakout_up or breakout_down):
        avg_vol = df["AvgVol"].iloc[-1]
        vol_ok = "YES" if latest["Volume"] > avg_vol else "NO (low volume)"

    return Signal(
        ticker=ticker,
        datetime_str=str(df.index[-1]),
        direction=direction,
        inside_high=round(float(inside["High"]), 2),
        inside_low=round(float(inside["Low"]), 2),
        close=round(latest_close, 2),
        volume_ok=vol_ok,
    )


def main():
    print(f"NIFTY 50 Inside Bar Scanner (Hourly, <= Rs.{MAX_PRICE:.0f}) — {datetime.now().strftime('%Y-%m-%d %H:%M')}")
    print(f"Scanning {len(NIFTY_50)} NIFTY 50 constituents...\n")

    results = []
    skipped = []
    for t in NIFTY_50:
        try:
            sig = scan_ticker(t)
            if sig:
                results.append(sig)
        except Exception as e:
            skipped.append((t, str(e)))

    if skipped:
        print(f"[Note: {len(skipped)} tickers could not be fetched — likely renamed/delisted symbols. Skipped: "
              f"{', '.join(t for t, _ in skipped)}]\n")

    if not results:
        print(f"No inside bar setups found at or below Rs.{MAX_PRICE:.0f} right now.")
        return

    print(f"{'Ticker':<14}{'Bar Time':<22}{'Signal':<28}{'Close':<10}{'Vol OK':<12}{'Inside Range'}")
    print("-" * 110)
    for s in results:
        print(
            f"{s.ticker:<14}{s.datetime_str:<22}{s.direction:<28}{s.close:<10}{s.volume_ok:<12}"
            f"{s.inside_low}-{s.inside_high}"
        )


if __name__ == "__main__":
    main()