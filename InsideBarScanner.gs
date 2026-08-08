/**
 * MOTHER & BABY / INSIDE BAR BREAKOUT SCANNER (GOOGLE APPS SCRIPT)
 * ------------------------------------------------------------------
 * Spreadsheet: https://docs.google.com/spreadsheets/d/1d3wJfxxkWYrHa23qeIbQCoTYpEpI6mSNefjzFfLGACA/edit#gid=1661228420
 * Tab GID: 1661228420
 * 
 * Features:
 * - Scans NIFTY 50 on Daily (1d) & Hourly (60m) intervals natively in Google Sheets.
 * - Detects Inside Bars & Breakout Signals with Volume Confirmation.
 * - Automatically updates Google Sheet with colored formatting.
 * - Includes one-click Menu in Google Sheets ("🚀 Stock Scanner").
 * - Supports automatic Monday-Friday scheduled runs.
 */

const SPREADSHEET_ID = "1d3wJfxxkWYrHa23qeIbQCoTYpEpI6mSNefjzFfLGACA";
const SHEET_GID = "1661228420";

const NIFTY_50 = [
  "ADANIENT.NS", "ADANIPORTS.NS", "APOLLOHOSP.NS", "ASIANPAINT.NS", "AXISBANK.NS",
  "BAJAJ-AUTO.NS", "BAJFINANCE.NS", "BAJAJFINSV.NS", "BEL.NS", "BHARTIARTL.NS",
  "CIPLA.NS", "COALINDIA.NS", "DRREDDY.NS", "EICHERMOT.NS", "ETERNAL.NS",
  "GRASIM.NS", "HCLTECH.NS", "HDFCBANK.NS", "HDFCLIFE.NS", "HINDALCO.NS",
  "HINDUNILVR.NS", "ICICIBANK.NS", "INDIGO.NS", "INFY.NS", "ITC.NS",
  "JIOFIN.NS", "JSWSTEEL.NS", "KOTAKBANK.NS", "LT.NS", "M&M.NS",
  "MARUTI.NS", "MAXHEALTH.NS", "NESTLEIND.NS", "NTPC.NS", "ONGC.NS",
  "POWERGRID.NS", "RELIANCE.NS", "SBILIFE.NS", "SHRIRAMFIN.NS", "SBIN.NS",
  "SUNPHARMA.NS", "TCS.NS", "TATACONSUM.NS", "TMPV.NS", "TATASTEEL.NS",
  "TECHM.NS", "TITAN.NS", "TRENT.NS", "ULTRACEMCO.NS", "WIPRO.NS"
];

// Add custom UI menu when Google Sheet opens
function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu("🚀 Stock Scanner")
    .addItem("▶️ Run Daily Scan Now (1D)", "runDailyScan")
    .addItem("▶️ Run Hourly Scan Now (1H)", "runHourlyScan")
    .addSeparator()
    .addItem("⏰ Enable Auto-Run (Mon-Fri)", "setupTriggers")
    .addItem("❌ Disable Auto-Run", "removeTriggers")
    .addToUi();
}

function runDailyScan() {
  scanMarket("1d", "6mo", "DAILY CANDLES");
}

function runHourlyScan() {
  scanMarket("60m", "1mo", "HOURLY CANDLES");
}

/**
 * Main scanner function
 */
function scanMarket(interval, range, label) {
  const now = new Date();
  const day = now.getDay(); // 0=Sunday, 6=Saturday
  
  const sheet = getTargetSheet();
  const results = [];

  for (let i = 0; i < NIFTY_50.length; i++) {
    const ticker = NIFTY_50[i];
    const sig = evaluateTicker(ticker, interval, range);
    if (sig) {
      results.push(sig);
    }
    Utilities.sleep(100); // polite pause between requests
  }

  writeResultsToSheet(sheet, label, results);
}

function evaluateTicker(ticker, interval, range) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=${interval}&range=${range}`;
    const options = {
      headers: { "User-Agent": "Mozilla/5.0" },
      muteHttpExceptions: true
    };
    const response = UrlFetchApp.fetch(url, options);
    if (response.getResponseCode() !== 200) return null;

    const json = JSON.parse(response.getContentText());
    const result = json.chart.result[0];
    if (!result || !result.timestamp) return null;

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

    if (bars.length < 22) return null;

    const last = bars[bars.length - 1];
    const prev = bars[bars.length - 2];
    const prev2 = bars[bars.length - 3];

    // Calculate 20-period avg volume
    let volSum = 0;
    for (let j = bars.length - 21; j < bars.length - 1; j++) {
      volSum += bars[j].volume;
    }
    const avgVol = volSum / 20;
    const volOk = last.volume > avgVol * 1.2 ? "YES 🔥" : "NO (low volume)";

    // 1. Check Breakout of Previous Inside Bar (prev2 = Mother, prev = Baby, last = Breakout)
    const isInsidePrev = (prev.high <= prev2.high) && (prev.low >= prev2.low);
    
    if (isInsidePrev) {
      if (last.close > prev2.high && last.close > last.open) {
        const slDist = Math.max(last.close - prev2.low, last.close * 0.005);
        return {
          ticker: ticker,
          timeStr: formatDate(last.time),
          signal: "🟢 BULLISH BREAKOUT",
          close: last.close.toFixed(2),
          volumeOk: volOk,
          entry: last.close.toFixed(2),
          stopLoss: (last.close - slDist).toFixed(2),
          target: (last.close + 1.5 * slDist).toFixed(2)
        };
      }
      if (last.close < prev2.low && last.close < last.open) {
        const slDist = Math.max(prev2.high - last.close, last.close * 0.005);
        return {
          ticker: ticker,
          timeStr: formatDate(last.time),
          signal: "🔴 BEARISH BREAKDOWN",
          close: last.close.toFixed(2),
          volumeOk: volOk,
          entry: last.close.toFixed(2),
          stopLoss: (last.close + slDist).toFixed(2),
          target: (last.close - 1.5 * slDist).toFixed(2)
        };
      }
    }

    // 2. Check Active Inside Bar Formed (prev = Mother, last = Baby)
    const isInsideNow = (last.high <= prev.high) && (last.low >= prev.low);
    if (isInsideNow) {
      return {
        ticker: ticker,
        timeStr: formatDate(last.time),
        signal: "🟡 INSIDE BAR FORMED (watch)",
        close: last.close.toFixed(2),
        volumeOk: "n/a",
        entry: `Buy > ${prev.high.toFixed(2)} / Sell < ${prev.low.toFixed(2)}`,
        stopLoss: `SL ${prev.low.toFixed(2)} / SL ${prev.high.toFixed(2)}`,
        target: `T ${(prev.high + 1.5 * (prev.high - prev.low)).toFixed(2)} / T ${(prev.low - 1.5 * (prev.high - prev.low)).toFixed(2)}`
      };
    }

    return null;
  } catch (e) {
    return null;
  }
}

function writeResultsToSheet(sheet, label, results) {
  const timestamp = Utilities.formatDate(new Date(), "Asia/Kolkata", "yyyy-MM-dd HH:mm:ss");

  // Format headers if sheet empty
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

    // Color styling based on signal type
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

// --------------------------------------------------------------------------
// AUTOMATED TRIGGERS (Monday to Friday Schedule)
// --------------------------------------------------------------------------
function setupTriggers() {
  removeTriggers();
  // Runs daily at 4:00 PM IST (after market close)
  ScriptApp.newTrigger("runDailyScan")
    .timeBased()
    .everyDays(1)
    .atHour(16)
    .create();
    
  SpreadsheetApp.getUi().alert("✅ Auto-run trigger created! The scanner will run automatically every day at 4:00 PM IST.");
}

function removeTriggers() {
  const triggers = ScriptApp.getProjectTriggers();
  for (let i = 0; i < triggers.length; i++) {
    ScriptApp.deleteTrigger(triggers[i]);
  }
}
