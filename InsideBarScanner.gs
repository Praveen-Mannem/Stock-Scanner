/**
 * MOTHER & BABY / INSIDE BAR BREAKOUT SCANNER (GOOGLE APPS SCRIPT v2.1)
 * ------------------------------------------------------------------
 * Spreadsheet: https://docs.google.com/spreadsheets/d/1d3wJfxxkWYrHa23qeIbQCoTYpEpI6mSNefjzFfLGACA/edit#gid=1661228420
 * Tab GID: 1661228420
 * 
 * Technical Enhancements Added to Eliminate False Breakouts:
 * 1. Trend Filter: EMA 21 > EMA 50 for BUY, EMA 21 < EMA 50 for SELL.
 * 2. Wick Rejection Filter: Breakout candle must close in top 40% of its range (strength >= 0.60).
 * 3. Doji Filter: Ignores weak Mother bars with candle body < 15% of range.
 * 4. High Confidence Tag: Marks opposite color setups (Red Mother + Green Baby / Green Mother + Red Baby).
 * 5. Volume Expansion Filter: Highlights volume expansion > 1.2x of 20-SMA volume.
 */

const SPREADSHEET_ID = "1d3wJfxxkWYrHa23qeIbQCoTYpEpI6mSNefjzFfLGACA";
const SHEET_GID = "1661228420";

const NIFTY_50 = [
  "ADANIENT.NS", "ADANIPORTS.NS", "APOLLOHOSP.NS", "ASIANPAINT.NS", "AXISBANK.NS",
  "BAJAJ-AUTO.NS", "BAJFINANCE.NS", "BAJAJFINSV.NS", "BEL.NS", "BHARTIARTL.NS",
  "BPCL.NS", "CIPLA.NS", "COALINDIA.NS", "DIVISLAB.NS", "DRREDDY.NS",
  "EICHERMOT.NS", "GRASIM.NS", "HCLTECH.NS", "HDFCBANK.NS", "HDFCLIFE.NS",
  "HEROMOTOCO.NS", "HINDALCO.NS", "HINDUNILVR.NS", "ICICIBANK.NS", "INDUSINDBK.NS",
  "INFY.NS", "ITC.NS", "JSWSTEEL.NS", "KOTAKBANK.NS", "LT.NS",
  "M&M.NS", "MARUTI.NS", "NESTLEIND.NS", "NTPC.NS", "ONGC.NS",
  "POWERGRID.NS", "RELIANCE.NS", "SBILIFE.NS", "SBIN.NS", "SHRIRAMFIN.NS",
  "SUNPHARMA.NS", "TATACONSUM.NS", "TATAMOTORS.NS", "TATASTEEL.NS", "TCS.NS",
  "TECHM.NS", "TITAN.NS", "TRENT.NS", "ULTRACEMCO.NS", "WIPRO.NS"
];

// Add custom UI menu when Google Sheet opens
function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu("🚀 Stock Scanner")
    .addItem("▶️ Run Daily Scan Now (1D)", "runDailyScan")
    .addItem("▶️ Run Hourly Scan Now (1H)", "runHourlyScan")
    .addSeparator()
    .addItem("🧹 Clear Results Sheet", "clearResultsSheet")
    .addSeparator()
    .addItem("⏰ Enable Auto-Run (Daily 4PM)", "setupDailyTrigger")
    .addItem("⏰ Enable Auto-Run (Hourly Market Hours)", "setupHourlyTrigger")
    .addItem("❌ Disable All Auto-Run Triggers", "removeTriggers")
    .addToUi();
}

function runDailyScan() {
  scanMarket("1d", "6mo", "DAILY CANDLES");
}

function runHourlyScan() {
  scanMarket("60m", "1mo", "HOURLY CANDLES");
}

function clearResultsSheet() {
  const sheet = getTargetSheet();
  sheet.clear();
  sheet.appendRow(["Updated At", "Interval", "Ticker", "Bar Time", "Signal", "Close", "Volume OK", "Entry", "Stop Loss", "Target"]);
  sheet.getRange(1, 1, 1, 10).setFontWeight("bold").setBackground("#1155cc").setFontColor("#ffffff");
  SpreadsheetApp.getUi().alert("🧹 Results sheet has been cleared and reset!");
}

/**
 * Main scanner execution function
 */
function scanMarket(interval, range, label) {
  const sheet = getTargetSheet();
  const requests = NIFTY_50.map(ticker => ({
    url: buildYahooChartUrl(ticker, interval, range),
    headers: { "User-Agent": "Mozilla/5.0" },
    muteHttpExceptions: true
  }));

  let responses;
  try {
    responses = UrlFetchApp.fetchAll(requests);
  } catch (e) {
    console.warn(`Batch fetch failed; retrying sequentially: ${e && e.message ? e.message : e}`);
    responses = requests.map(request => UrlFetchApp.fetch(request.url, request));
  }

  const results = [];

  for (let i = 0; i < responses.length; i++) {
    const sig = evaluateTickerResponse(NIFTY_50[i], responses[i]);
    if (sig) {
      results.push(sig);
    }
  }

  writeResultsToSheet(sheet, label, results);
}

function buildYahooChartUrl(ticker, interval, range) {
  return `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=${encodeURIComponent(interval)}&range=${encodeURIComponent(range)}`;
}

/**
 * Technical Indicator Helper: Exponential Moving Average (EMA)
 */
function calculateEMA(closes, period) {
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = (closes[i] * k) + (ema * (1 - k));
  }
  return ema;
}

/**
 * Evaluates Inside Bar + Technical Filters for a ticker
 */
function evaluateTicker(ticker, interval, range) {
  const response = UrlFetchApp.fetch(buildYahooChartUrl(ticker, interval, range), {
    headers: { "User-Agent": "Mozilla/5.0" },
    muteHttpExceptions: true
  });
  return evaluateTickerResponse(ticker, response);
}

function evaluateTickerResponse(ticker, response) {
  try {
    if (response.getResponseCode() !== 200) return null;

    const json = JSON.parse(response.getContentText());
    const result = json.chart && json.chart.result && json.chart.result[0];
    if (!result || !result.timestamp || !result.indicators || !result.indicators.quote || !result.indicators.quote[0]) return null;

    const quote = result.indicators.quote[0];
    const timestamps = result.timestamp;
    const opens = quote.open;
    const highs = quote.high;
    const lows = quote.low;
    const closes = quote.close;
    const volumes = quote.volume;

    // Filter valid bars
    const bars = [];
    for (let i = 0; i < timestamps.length; i++) {
      if (opens[i] != null && highs[i] != null && lows[i] != null && closes[i] != null) {
        bars.push({
          time: new Date(timestamps[i] * 1000),
          open: opens[i],
          high: highs[i],
          low: lows[i],
          close: closes[i],
          volume: volumes[i] || 0
        });
      }
    }

    if (bars.length < 52) return null; // Need enough history for EMA 50

    const closeList = bars.map(b => b.close);
    const ema21 = calculateEMA(closeList, 21);
    const ema50 = calculateEMA(closeList, 50);

    const last = bars[bars.length - 1];
    const prev = bars[bars.length - 2];
    const prev2 = bars[bars.length - 3];

    // 1. Calculate 20-period Average Volume
    let volSum = 0;
    for (let j = bars.length - 21; j < bars.length - 1; j++) {
      volSum += bars[j].volume;
    }
    const avgVol = volSum / 20;
    const isVolConfirmed = last.volume > avgVol * 1.2;
    const volOk = isVolConfirmed ? "YES 🔥" : "NO (low volume)";

    // 2. Mother Bar Doji Filter (Mother body >= 15% of range)
    const mRange = prev2.high - prev2.low;
    const mBody = Math.abs(prev2.close - prev2.open);
    const isMotherValid = mRange > 0 && (mBody / mRange >= 0.15);

    // 3. High Confidence Setup (Opposite Color Pattern)
    const isMotherRed = prev2.close < prev2.open;
    const isMotherGreen = prev2.close > prev2.open;
    const isBabyRed = prev.close < prev.open;
    const isBabyGreen = prev.close > prev.open;
    const isOppositeColor = (isMotherRed && isBabyGreen) || (isMotherGreen && isBabyRed);
    const confTag = isOppositeColor ? " 🔥 [HIGH CONFIDENCE]" : "";

    // 4. Breakout Candle Close Strength (Filter long rejection wicks)
    const boRange = last.high - last.low;
    const buyStrength = boRange > 0 ? (last.close - last.low) / boRange : 0;
    const sellStrength = boRange > 0 ? (last.high - last.close) / boRange : 0;

    // 5. Trend Direction Filter (EMA Alignment)
    const isUptrend = ema21 && ema50 ? (last.close > ema21 && ema21 > ema50) : true;
    const isDowntrend = ema21 && ema50 ? (last.close < ema21 && ema21 < ema50) : true;

    // A. Check Breakout of Previous Inside Bar (prev2 = Mother, prev = Baby, last = Breakout)
    const isInsidePrev = (prev.high <= prev2.high) && (prev.low >= prev2.low);
    
    if (isInsidePrev && isMotherValid) {
      // BUY BREAKOUT: Close > Mother High AND Green Candle AND Close Strength >= 60% AND Uptrend
      if (last.close > prev2.high && last.close > last.open && buyStrength >= 0.60 && isUptrend) {
        const slDist = Math.max(last.close - prev2.low, last.close * 0.005);
        return {
          ticker: ticker,
          timeStr: formatDate(last.time),
          signal: "🟢 BULLISH BREAKOUT" + confTag,
          close: last.close.toFixed(2),
          volumeOk: volOk,
          entry: last.close.toFixed(2),
          stopLoss: (last.close - slDist).toFixed(2),
          target: (last.close + 1.5 * slDist).toFixed(2)
        };
      }
      // SELL BREAKDOWN: Close < Mother Low AND Red Candle AND Close Strength >= 60% AND Downtrend
      if (last.close < prev2.low && last.close < last.open && sellStrength >= 0.60 && isDowntrend) {
        const slDist = Math.max(prev2.high - last.close, last.close * 0.005);
        return {
          ticker: ticker,
          timeStr: formatDate(last.time),
          signal: "🔴 BEARISH BREAKDOWN" + confTag,
          close: last.close.toFixed(2),
          volumeOk: volOk,
          entry: last.close.toFixed(2),
          stopLoss: (last.close + slDist).toFixed(2),
          target: (last.close - 1.5 * slDist).toFixed(2)
        };
      }
    }

    // B. Check Active Inside Bar Formed (prev = Mother, last = Baby)
    const isInsideNow = (last.high <= prev.high) && (last.low >= prev.low);
    if (isInsideNow) {
      return {
        ticker: ticker,
        timeStr: formatDate(last.time),
        signal: "🟡 INSIDE BAR FORMED (watch)" + confTag,
        close: last.close.toFixed(2),
        volumeOk: "n/a",
        entry: `Buy > ${prev.high.toFixed(2)} / Sell < ${prev.low.toFixed(2)}`,
        stopLoss: `SL ${prev.low.toFixed(2)} / SL ${prev.high.toFixed(2)}`,
        target: `T ${(prev.high + 1.5 * (prev.high - prev.low)).toFixed(2)} / T ${(prev.low - 1.5 * (prev.high - prev.low)).toFixed(2)}`
      };
    }

    return null;
  } catch (e) {
    console.warn(`Skipping ${ticker}: ${e && e.message ? e.message : e}`);
    return null;
  }
}

function writeResultsToSheet(sheet, label, results) {
  const timestamp = Utilities.formatDate(new Date(), "Asia/Kolkata", "yyyy-MM-dd HH:mm:ss");

  if (sheet.getLastRow() === 0) {
    sheet.appendRow(["Updated At", "Interval", "Ticker", "Bar Time", "Signal", "Close", "Volume OK", "Entry", "Stop Loss", "Target"]);
    sheet.getRange(1, 1, 1, 10).setFontWeight("bold").setBackground("#1155cc").setFontColor("#ffffff");
  }

  if (results.length === 0) {
    sheet.appendRow([timestamp, label, "No setups found", "-", "-", "-", "-", "-", "-", "-"]);
    return;
  }

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const rowNum = sheet.getLastRow() + 1;
    sheet.appendRow([
      timestamp,
      label,
      r.ticker,
      r.timeStr,
      r.signal,
      r.close,
      r.volumeOk,
      r.entry,
      r.stopLoss,
      r.target
    ]);

    const range = sheet.getRange(rowNum, 1, 1, 10);
    if (r.signal.includes("BULLISH")) {
      range.setBackground("#e6f4ea").setFontColor("#137333");
    } else if (r.signal.includes("BEARISH")) {
      range.setBackground("#fce8e6").setFontColor("#c5221f");
    } else if (r.signal.includes("INSIDE BAR")) {
      range.setBackground("#fef7e0").setFontColor("#b06000");
    }
  }
}

function getTargetSheet() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheets = ss.getSheets();
  for (let i = 0; i < sheets.length; i++) {
    if (sheets[i].getSheetId().toString() === SHEET_GID) {
      return sheets[i];
    }
  }
  return ss.getActiveSheet();
}

function formatDate(date) {
  return Utilities.formatDate(date, "Asia/Kolkata", "yyyy-MM-dd HH:mm");
}

function setupDailyTrigger() {
  removeTriggers();
  ScriptApp.newTrigger("runDailyScan")
    .timeBased()
    .everyDays(1)
    .atHour(16)
    .create();
    
  SpreadsheetApp.getUi().alert("✅ Daily auto-run trigger created! The scanner will run automatically every day at 4:00 PM IST.");
}

function setupHourlyTrigger() {
  removeTriggers();
  ScriptApp.newTrigger("runHourlyScan")
    .timeBased()
    .everyHours(1)
    .create();
    
  SpreadsheetApp.getUi().alert("✅ Hourly auto-run trigger created! The scanner will run automatically every hour.");
}

function removeTriggers() {
  const triggers = ScriptApp.getProjectTriggers();
  for (let i = 0; i < triggers.length; i++) {
    ScriptApp.deleteTrigger(triggers[i]);
  }
  SpreadsheetApp.getUi().alert("❌ All auto-run triggers disabled.");
}
