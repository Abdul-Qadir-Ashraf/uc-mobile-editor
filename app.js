const { BlobReader, BlobWriter, ZipReader, ZipWriter, configure } = globalThis.zip;

configure({ useWebWorkers: false });

const ZIP_PASSWORD = "123";
const INPUT_ZIP_PASSWORDS = ["123", "1234"];
const MAX_FILE_SIZE = 20 * 1024 * 1024;
const state = {
  files: new Map(),
  reports: [],
  outputs: null,
  objectUrls: [],
};

const $ = (selector) => document.querySelector(selector);
const elements = {
  fileInput: $("#file-input"),
  dropZone: $("#drop-zone"),
  fileSummary: $("#file-summary"),
  reportCount: $("#report-count"),
  eligibleCount: $("#eligible-count"),
  reportList: $("#report-list"),
  orphanWarning: $("#orphan-warning"),
  clearFiles: $("#clear-files"),
  totalRange: $("#total-range"),
  totalNumber: $("#total-number"),
  totalOutput: $("#total-output"),
  newRange: $("#new-range"),
  newNumber: $("#new-number"),
  newOutput: $("#new-output"),
  estimateTotal: $("#estimate-total"),
  estimateNew: $("#estimate-new"),
  estimateMandatory: $("#estimate-mandatory"),
  processButton: $("#process-button"),
  processLabel: $("#process-label"),
  progressCard: $("#progress-card"),
  progressTitle: $("#progress-title"),
  progressDetail: $("#progress-detail"),
  resultCard: $("#result-card"),
  resultCaption: $("#result-caption"),
  resultNew: $("#result-new"),
  resultMandatory: $("#result-mandatory"),
  resultSaved: $("#result-saved"),
  downloadAll: $("#download-all"),
  individualDownloads: $("#individual-downloads"),
  errorCard: $("#error-card"),
  errorMessage: $("#error-message"),
};

function baseName(filename) {
  const leaf = leafName(filename);
  const index = leaf.lastIndexOf(".");
  return index > 0 ? leaf.slice(0, index) : leaf;
}

function extension(filename) {
  const index = filename.lastIndexOf(".");
  return index >= 0 ? filename.slice(index).toLowerCase() : "";
}

function leafName(filename) {
  return filename.split(/[\\/]/).filter(Boolean).at(-1) || filename;
}

function safeFilename(filename) {
  return filename.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim() || "report";
}

function reportMimeType(filename) {
  const ext = extension(filename);
  if (ext === ".html") return "text/html";
  if (ext === ".csv") return "text/csv";
  return "application/octet-stream";
}

function formatRupees(value) {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(value);
}

function parseCsv(text) {
  const source = text.replace(/^\uFEFF/, "");
  const table = [];
  let row = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === '"') {
      if (quoted && source[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === "," && !quoted) {
      row.push(field);
      field = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && source[index + 1] === "\n") index += 1;
      row.push(field);
      table.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }

  if (field.length || row.length) {
    row.push(field);
    table.push(row);
  }
  while (table.length && table.at(-1).every((value) => value === "")) table.pop();
  if (!table.length) throw new Error("The CSV file is empty.");

  const headers = table[0].map((header) => header.trim());
  const rows = table.slice(1).map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])));
  return { headers, rows };
}

function encodeCsvValue(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function toCsv(headers, rows) {
  return [headers, ...rows.map((row) => headers.map((header) => row[header] ?? ""))]
    .map((row) => row.map(encodeCsvValue).join(","))
    .join("\r\n") + "\r\n";
}

function parseHtml(text) {
  const documentObject = new DOMParser().parseFromString(text, "text/html");
  const rows = [...documentObject.querySelectorAll(".details_view table tbody tr")]
    .map((row) => [...row.querySelectorAll("td")].map((cell) => cell.textContent.trim()))
    .filter((cells) => cells.length >= 19);
  if (!rows.length) throw new Error("No UC transaction table was found in this HTML file.");
  return { documentObject, rows };
}

function stationIdFromDocument(documentObject) {
  const label = [...documentObject.querySelectorAll("td, th")]
    .find((cell) => cell.textContent.toLowerCase().includes("station id"));
  return label?.nextElementSibling?.textContent.trim() || "UNKNOWN";
}

function eligibleSerialsFromHtml(text) {
  const { rows } = parseHtml(text);
  return rows.filter((cells) => cells[3] === "U" && Number(cells[18] || 0) === 125).map((cells) => cells[0]);
}

function eligibleSerialsFromCsv(text) {
  const { headers, rows } = parseCsv(text);
  for (const required of ["SLNO", "TYPE", "TOTAL_AMOUNT_CHARGED"]) {
    if (!headers.includes(required)) throw new Error(`CSV column ${required} is missing.`);
  }
  return rows.filter((row) => row.TYPE === "U" && Number(row.TOTAL_AMOUNT_CHARGED || 0) === 125).map((row) => row.SLNO);
}

function eodStats(htmlText) {
  const { rows } = parseHtml(htmlText);
  const stats = { NEW: 0, BIO: 0, DEMO: 0, MAND: 0 };
  for (const cells of rows) {
    const type = cells[3];
    const amount = Number(cells[18] || 0);
    if (type === "E" || type === "N") stats.NEW += 1;
    else if (type === "U" && amount === 125) stats.BIO += 1;
    else if (type === "U" && amount === 75) stats.DEMO += 1;
    else if (type === "U" && amount === 0) stats.MAND += 1;
  }
  return stats;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

function cellValues(rowHtml) {
  const wrapper = document.createElement("table");
  wrapper.innerHTML = `<tbody>${rowHtml}</tbody>`;
  return [...wrapper.querySelectorAll("td")].map((cell) => cell.textContent.trim());
}

function replaceRowCells(rowHtml, replacements) {
  let cellIndex = -1;
  return rowHtml.replace(/<td\b[^>]*>[\s\S]*?<\/td>/gi, (cellHtml) => {
    cellIndex += 1;
    if (!Object.hasOwn(replacements, cellIndex)) return cellHtml;
    const opening = cellHtml.match(/^<td\b[^>]*>/i)?.[0] || "<td>";
    return `${opening} ${escapeHtml(replacements[cellIndex])} </td>`;
  });
}

function replaceClassDiv(html, className, transform) {
  const escaped = className.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`<div\\b(?=[^>]*\\bclass\\s*=\\s*["'][^"']*\\b${escaped}\\b[^"']*["'])[^>]*>[\\s\\S]*?<\\/div>`, "i");
  return html.replace(pattern, transform);
}

function updateExistingSummary(html, newCount, updateCount) {
  return replaceClassDiv(html, "pick_date", (section) => section.replace(
    /(<tbody\b[^>]*>)([\s\S]*?)(<\/tbody>)/i,
    (whole, open, body, close) => {
      if (!/<tr\b/i.test(body)) return whole;
      const updated = body.replace(/<tr\b[^>]*>[\s\S]*?<\/tr>/i, (row) => replaceRowCells(row, {
        1: String(newCount),
        2: String(updateCount),
        3: String(newCount + updateCount),
      }));
      return `${open}${updated}${close}`;
    },
  ));
}

function modifyHtml(text, newSerials, mandatorySerials) {
  let finalNewCount = 0;
  let finalUpdateCount = 0;
  let changedNew = 0;
  let changedMandatory = 0;

  const modified = replaceClassDiv(text, "details_view", (section) => section.replace(
    /(<tbody\b[^>]*>)([\s\S]*?)(<\/tbody>)/i,
    (whole, open, body, close) => {
      const updatedBody = body.replace(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi, (rowHtml) => {
        const values = cellValues(rowHtml);
        if (values.length < 19) return rowHtml;
        const serial = values[0];
        let updated = rowHtml;
        if (newSerials.has(serial)) {
          updated = replaceRowCells(rowHtml, { 3: "E", 10: "HF", 15: "0.0", 16: "0.0", 17: "0.0", 18: "0.0" });
          values[3] = "E";
          changedNew += 1;
        } else if (mandatorySerials.has(serial)) {
          updated = replaceRowCells(rowHtml, { 4: "Yes", 15: "0.0", 16: "0.0", 17: "0.0", 18: "0.0" });
          changedMandatory += 1;
        }
        if (values[3] === "E") finalNewCount += 1;
        else if (values[3] === "U") finalUpdateCount += 1;
        return updated;
      });
      return `${open}${updatedBody}${close}`;
    },
  ));

  return {
    text: updateExistingSummary(modified, finalNewCount, finalUpdateCount),
    newCount: changedNew,
    mandatoryCount: changedMandatory,
  };
}

function modifyCsv(text, newSerials, mandatorySerials) {
  const { headers, rows } = parseCsv(text);
  for (const required of ["SLNO", "TYPE", "MANDATORY_BIO_METRIC_UPDATE_ONLY", "TOTAL_AMOUNT_CHARGED"]) {
    if (!headers.includes(required)) throw new Error(`CSV column ${required} is missing.`);
  }
  let newCount = 0;
  let mandatoryCount = 0;
  const zeroColumns = ["GST_APPLIED", "GST_AMOUNT", "AMOUNT_CHARGED_FOR_NEW_ENROLMENT", "AMOUNT_CHARGED_FOR_UPDATE_ENROLMENT"];

  for (const row of rows) {
    if (newSerials.has(row.SLNO)) {
      row.TYPE = "E";
      row.MANDATORY_BIO_METRIC_UPDATE_ONLY = "No";
      if (headers.includes("PROOF")) row.PROOF = "HF";
      row.TOTAL_AMOUNT_CHARGED = "0.0";
      for (const column of zeroColumns) if (headers.includes(column)) row[column] = "0.0";
      newCount += 1;
    } else if (mandatorySerials.has(row.SLNO)) {
      row.MANDATORY_BIO_METRIC_UPDATE_ONLY = "Yes";
      row.TOTAL_AMOUNT_CHARGED = "0.0";
      for (const column of zeroColumns) if (headers.includes(column)) row[column] = "0.0";
      mandatoryCount += 1;
    }
  }
  return { text: toCsv(headers, rows), newCount, mandatoryCount };
}

function shuffle(values) {
  const copy = [...values];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const randomValues = new Uint32Array(1);
    crypto.getRandomValues(randomValues);
    const selected = randomValues[0] % (index + 1);
    [copy[index], copy[selected]] = [copy[selected], copy[index]];
  }
  return copy;
}

function makeEodReport(records, includeSavings = false, oldTotals = null) {
  const headers = ["STATION ID", "NEW", "BIO", "DEMO", "MAND", "GST", "WEEKLY"];
  let totalGst = 0;
  let totalWeekly = 0;
  const rows = records.map(({ stationId, stats }) => {
    const gst = stats.BIO * 125 + stats.DEMO * 75;
    const weekly = stats.NEW * 25 + stats.MAND * 20;
    totalGst += gst;
    totalWeekly += weekly;
    return { "STATION ID": stationId, ...stats, GST: gst, WEEKLY: weekly };
  });
  rows.push({ "STATION ID": "GRAND TOTAL", GST: totalGst, WEEKLY: totalWeekly });
  if (includeSavings && oldTotals) {
    rows.push({});
    rows.push({ "STATION ID": "TOTAL SAVED AMOUNT", GST: oldTotals.gst - totalGst + oldTotals.weekly - totalWeekly });
  }
  return { text: toCsv(headers, rows), totals: { gst: totalGst, weekly: totalWeekly } };
}

async function createZip(entries, options = {}) {
  const blobWriter = new BlobWriter("application/zip");
  const writerOptions = options.password ? { password: options.password, zipCrypto: true } : {};
  const zipWriter = new ZipWriter(blobWriter, writerOptions);
  for (const entry of entries) {
    await zipWriter.add(entry.name, new BlobReader(entry.blob), { ...writerOptions, level: 6 });
  }
  return zipWriter.close();
}

async function readZipEntryBlob(entry) {
  const needsPassword = Boolean(entry.encrypted);
  const passwordOptions = needsPassword ? INPUT_ZIP_PASSWORDS : [undefined, ...INPUT_ZIP_PASSWORDS];
  let lastError = null;
  for (const password of passwordOptions) {
    try {
      const options = password ? { password } : {};
      return await entry.getData(new BlobWriter(reportMimeType(entry.filename)), options);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("Could not read ZIP entry.");
}

async function extractReportFilesFromZip(file) {
  const zipReader = new ZipReader(new BlobReader(file));
  const extracted = [];
  try {
    const entries = await zipReader.getEntries();
    for (const entry of entries) {
      if (entry.directory) continue;
      const name = leafName(entry.filename);
      const ext = extension(name);
      if (![".html", ".csv"].includes(ext)) continue;
      if (entry.uncompressedSize > MAX_FILE_SIZE) throw new Error(`${name} inside ${file.name} is larger than 20 MB.`);
      const blob = await readZipEntryBlob(entry);
      extracted.push(new File([blob], name, { type: reportMimeType(name), lastModified: file.lastModified }));
    }
  } finally {
    await zipReader.close();
  }
  if (!extracted.length) throw new Error(`${file.name} does not contain any HTML or CSV report files.`);
  return extracted;
}

function textBlob(text, type) {
  return new Blob([text], { type: `${type};charset=utf-8` });
}

async function analyzeFiles() {
  const pairs = new Map();
  const orphanCsvs = [];
  for (const file of state.files.values()) {
    const key = baseName(file.name).toLocaleLowerCase();
    const pair = pairs.get(key) || {};
    if (extension(file.name) === ".html") pair.html = file;
    if (extension(file.name) === ".csv") pair.csv = file;
    pairs.set(key, pair);
  }

  state.reports = [];
  for (const pair of pairs.values()) {
    if (!pair.html) {
      if (pair.csv) orphanCsvs.push(pair.csv.name);
      continue;
    }
    try {
      const htmlText = await pair.html.text();
      const { documentObject } = parseHtml(htmlText);
      const csvText = pair.csv ? await pair.csv.text() : null;
      const serials = csvText ? eligibleSerialsFromCsv(csvText) : eligibleSerialsFromHtml(htmlText);
      state.reports.push({
        htmlFile: pair.html,
        csvFile: pair.csv || null,
        htmlText,
        csvText,
        stationId: stationIdFromDocument(documentObject),
        eligibleSerials: serials,
        error: null,
      });
    } catch (error) {
      state.reports.push({ htmlFile: pair.html, csvFile: pair.csv || null, eligibleSerials: [], error: error.message });
    }
  }
  renderReports(orphanCsvs);
}

function renderReports(orphanCsvs = []) {
  const totalEligible = state.reports.reduce((sum, report) => sum + report.eligibleSerials.length, 0);
  elements.fileSummary.classList.toggle("hidden", !state.reports.length && !orphanCsvs.length);
  elements.reportCount.textContent = `${state.reports.length} report${state.reports.length === 1 ? "" : "s"}`;
  elements.eligibleCount.textContent = `${totalEligible} eligible ₹125 entr${totalEligible === 1 ? "y" : "ies"}`;
  elements.reportList.replaceChildren();

  for (const report of state.reports) {
    const item = document.createElement("div");
    item.className = "report-item";
    const icon = document.createElement("div");
    icon.className = "file-icon";
    icon.textContent = "HTML";
    const copy = document.createElement("div");
    copy.className = "report-copy";
    const name = document.createElement("span");
    name.className = "report-name";
    name.textContent = report.htmlFile.name;
    const meta = document.createElement("span");
    meta.className = "report-meta";
    meta.textContent = report.error ? report.error : `Station ${report.stationId} · ${report.csvFile ? "HTML + CSV" : "HTML only"}`;
    copy.append(name, meta);
    const badge = document.createElement("span");
    badge.className = `eligible-badge${report.error ? " error" : ""}`;
    badge.textContent = report.error ? "Error" : `${report.eligibleSerials.length} eligible`;
    item.append(icon, copy, badge);
    elements.reportList.append(item);
  }

  elements.orphanWarning.classList.toggle("hidden", !orphanCsvs.length);
  elements.orphanWarning.textContent = orphanCsvs.length ? `Ignored CSV without matching HTML: ${orphanCsvs.join(", ")}` : "";
  elements.processButton.disabled = !state.reports.some((report) => !report.error && report.eligibleSerials.length > 0);
  updateEstimate();
}

function inputValue(kind) {
  const field = kind === "total" ? elements.totalNumber : elements.newNumber;
  return Number(field.value);
}

function setInputValue(kind, rawValue) {
  const minimum = kind === "total" ? 1 : 0;
  const value = Math.min(100, Math.max(minimum, Math.round(Number(rawValue) || minimum)));
  const range = kind === "total" ? elements.totalRange : elements.newRange;
  const number = kind === "total" ? elements.totalNumber : elements.newNumber;
  const output = kind === "total" ? elements.totalOutput : elements.newOutput;
  range.value = String(value);
  number.value = String(value);
  output.textContent = `${value}%`;
  updateEstimate();
}

function updateEstimate() {
  const totalPercentage = inputValue("total");
  const newPercentage = inputValue("new");
  let total = 0;
  let newCount = 0;
  for (const report of state.reports) {
    const reportTotal = Math.floor(report.eligibleSerials.length * totalPercentage / 100);
    total += reportTotal;
    newCount += Math.floor(reportTotal * newPercentage / 100);
  }
  elements.estimateTotal.textContent = String(total);
  elements.estimateNew.textContent = String(newCount);
  elements.estimateMandatory.textContent = String(total - newCount);
}

function revokeObjectUrls() {
  for (const url of state.objectUrls) URL.revokeObjectURL(url);
  state.objectUrls = [];
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  state.objectUrls.push(url);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = safeFilename(filename);
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}

function showError(error) {
  elements.errorMessage.textContent = error instanceof Error ? error.message : String(error);
  elements.errorCard.classList.remove("hidden");
  elements.progressCard.classList.add("hidden");
  elements.processButton.disabled = false;
  elements.processLabel.textContent = "Generate modified files";
  elements.errorCard.scrollIntoView({ behavior: "smooth", block: "center" });
}

async function processReports() {
  const validReports = state.reports.filter((report) => !report.error && report.eligibleSerials.length > 0);
  if (!validReports.length) return;
  revokeObjectUrls();
  state.outputs = null;
  elements.errorCard.classList.add("hidden");
  elements.resultCard.classList.add("hidden");
  elements.progressCard.classList.remove("hidden");
  elements.processButton.disabled = true;
  elements.processLabel.textContent = "Processing…";

  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

  try {
    const totalPercentage = inputValue("total");
    const newPercentage = inputValue("new");
    const processed = [];
    let totalNew = 0;
    let totalMandatory = 0;

    for (let reportIndex = 0; reportIndex < validReports.length; reportIndex += 1) {
      const report = validReports[reportIndex];
      elements.progressTitle.textContent = `Processing ${reportIndex + 1} of ${validReports.length}`;
      elements.progressDetail.textContent = report.htmlFile.name;
      await new Promise((resolve) => setTimeout(resolve, 0));

      const conversionCount = Math.floor(report.eligibleSerials.length * totalPercentage / 100);
      if (!conversionCount) continue;
      const selected = shuffle(report.eligibleSerials).slice(0, conversionCount);
      const newCount = Math.floor(selected.length * newPercentage / 100);
      const newSerials = new Set(selected.slice(0, newCount));
      const mandatorySerials = new Set(selected.slice(newCount));
      const modifiedHtml = modifyHtml(report.htmlText, newSerials, mandatorySerials);
      if (modifiedHtml.newCount !== newSerials.size || modifiedHtml.mandatoryCount !== mandatorySerials.size) {
        throw new Error(`${report.htmlFile.name}: selected entries could not be matched in the HTML.`);
      }

      let modifiedCsv = null;
      if (report.csvText) {
        modifiedCsv = modifyCsv(report.csvText, newSerials, mandatorySerials);
        if (modifiedCsv.newCount !== modifiedHtml.newCount || modifiedCsv.mandatoryCount !== modifiedHtml.mandatoryCount) {
          throw new Error(`${report.htmlFile.name}: HTML and CSV conversion counts do not match.`);
        }
      }

      processed.push({ report, modifiedHtml: modifiedHtml.text, modifiedCsv: modifiedCsv?.text || null });
      totalNew += modifiedHtml.newCount;
      totalMandatory += modifiedHtml.mandatoryCount;
    }

    if (!processed.length) throw new Error("The selected percentage produces zero conversions.");

    elements.progressTitle.textContent = "Creating EOD reports and ZIP files";
    elements.progressDetail.textContent = "This may take a moment on older phones.";
    await new Promise((resolve) => setTimeout(resolve, 0));

    const oldRecords = processed.map(({ report }) => ({ stationId: report.stationId, stats: eodStats(report.htmlText) }));
    const newRecords = processed.map(({ report, modifiedHtml }) => ({ stationId: report.stationId, stats: eodStats(modifiedHtml) }));
    const oldEod = makeEodReport(oldRecords);
    const newEod = makeEodReport(newRecords, true, oldEod.totals);
    const savedAmount = oldEod.totals.gst - newEod.totals.gst + oldEod.totals.weekly - newEod.totals.weekly;

    const rawEntries = [];
    const protectedEntries = [];
    for (const item of processed) {
      const pairEntries = [{ name: item.report.htmlFile.name, blob: textBlob(item.modifiedHtml, "text/html") }];
      rawEntries.push({ name: `modified-files/${item.report.htmlFile.name}`, blob: pairEntries[0].blob });
      if (item.modifiedCsv && item.report.csvFile) {
        const csvEntry = { name: item.report.csvFile.name, blob: textBlob(item.modifiedCsv, "text/csv") };
        pairEntries.push(csvEntry);
        rawEntries.push({ name: `modified-files/${csvEntry.name}`, blob: csvEntry.blob });
      }
      const stationZip = await createZip(pairEntries, { password: ZIP_PASSWORD });
      protectedEntries.push({ name: `${baseName(item.report.htmlFile.name)}.zip`, blob: stationZip });
    }

    const oldEodEntry = { name: "OLD EOD.csv", blob: textBlob(oldEod.text, "text/csv") };
    const newEodEntry = { name: "NEW EOD.csv", blob: textBlob(newEod.text, "text/csv") };
    rawEntries.push({ name: `reports/${oldEodEntry.name}`, blob: oldEodEntry.blob });
    rawEntries.push({ name: `reports/${newEodEntry.name}`, blob: newEodEntry.blob });
    protectedEntries.push({ name: "OLD EOD.zip", blob: await createZip([oldEodEntry], { password: ZIP_PASSWORD }) });
    protectedEntries.push({ name: "NEW EOD.zip", blob: await createZip([newEodEntry], { password: ZIP_PASSWORD }) });

    const masterEntries = [
      ...rawEntries,
      ...protectedEntries.map((entry) => ({ name: `password-protected-zips/${entry.name}`, blob: entry.blob })),
    ];
    const masterZip = await createZip(masterEntries);
    const date = new Date();
    const stamp = [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("");
    state.outputs = {
      master: { name: `UC_Mobile_Output_${stamp}.zip`, blob: masterZip },
      individual: [...protectedEntries, oldEodEntry, newEodEntry],
      summary: { processed: processed.length, totalNew, totalMandatory, savedAmount },
    };
    renderResults();
  } catch (error) {
    showError(error);
  }
}

function renderResults() {
  const { summary, individual } = state.outputs;
  elements.progressCard.classList.add("hidden");
  elements.errorCard.classList.add("hidden");
  elements.resultCard.classList.remove("hidden");
  elements.resultCaption.textContent = `${summary.processed} station report${summary.processed === 1 ? "" : "s"} processed on this device.`;
  elements.resultNew.textContent = String(summary.totalNew);
  elements.resultMandatory.textContent = String(summary.totalMandatory);
  elements.resultSaved.textContent = formatRupees(summary.savedAmount);
  elements.individualDownloads.replaceChildren();
  for (const entry of individual) {
    const button = document.createElement("button");
    button.type = "button";
    const name = document.createElement("span");
    name.textContent = entry.name;
    const action = document.createElement("span");
    action.textContent = "Save";
    button.append(name, action);
    button.addEventListener("click", () => downloadBlob(entry.blob, entry.name));
    elements.individualDownloads.append(button);
  }
  elements.processButton.disabled = false;
  elements.processLabel.textContent = "Generate again";
  elements.resultCard.scrollIntoView({ behavior: "smooth", block: "start" });
}

async function addFiles(files) {
  elements.errorCard.classList.add("hidden");
  for (const file of files) {
    const ext = extension(file.name);
    if (![".html", ".csv", ".zip"].includes(ext)) continue;
    if (file.size > MAX_FILE_SIZE) {
      showError(`${file.name} is larger than 20 MB.`);
      continue;
    }
    if (ext === ".zip") {
      try {
        const reportFiles = await extractReportFilesFromZip(file);
        for (const reportFile of reportFiles) state.files.set(reportFile.name.toLocaleLowerCase(), reportFile);
      } catch (error) {
        showError(`${file.name}: ${error.message}`);
      }
      continue;
    }
    state.files.set(leafName(file.name).toLocaleLowerCase(), file);
  }
  await analyzeFiles();
}

elements.fileInput.addEventListener("change", async (event) => {
  await addFiles([...event.target.files]);
  elements.fileInput.value = "";
});
elements.dropZone.addEventListener("dragover", (event) => { event.preventDefault(); elements.dropZone.classList.add("dragging"); });
elements.dropZone.addEventListener("dragleave", () => elements.dropZone.classList.remove("dragging"));
elements.dropZone.addEventListener("drop", async (event) => {
  event.preventDefault();
  elements.dropZone.classList.remove("dragging");
  await addFiles([...event.dataTransfer.files]);
});
elements.clearFiles.addEventListener("click", () => {
  state.files.clear();
  state.reports = [];
  state.outputs = null;
  revokeObjectUrls();
  elements.fileSummary.classList.add("hidden");
  elements.resultCard.classList.add("hidden");
  elements.errorCard.classList.add("hidden");
  elements.processButton.disabled = true;
  updateEstimate();
});

for (const kind of ["total", "new"]) {
  const range = kind === "total" ? elements.totalRange : elements.newRange;
  const number = kind === "total" ? elements.totalNumber : elements.newNumber;
  range.addEventListener("input", () => setInputValue(kind, range.value));
  number.addEventListener("change", () => setInputValue(kind, number.value));
}
for (const button of document.querySelectorAll(".nudge")) {
  button.addEventListener("click", () => setInputValue(button.dataset.target, inputValue(button.dataset.target) + Number(button.dataset.delta)));
}
elements.processButton.addEventListener("click", processReports);
elements.downloadAll.addEventListener("click", () => {
  if (state.outputs) downloadBlob(state.outputs.master.blob, state.outputs.master.name);
});

function registerWebMcp() {
  const context = document.modelContext;
  if (!context?.registerTool) return;
  const lifecycle = new AbortController();
  try {
    void Promise.resolve(context.registerTool({
      name: "configure_uc_conversion",
      title: "Configure UC conversion",
      description: "Set the total conversion percentage and New Enrolment share shown in UC Mobile Editor.",
      inputSchema: {
        type: "object",
        properties: {
          totalPercentage: { type: "integer", minimum: 1, maximum: 100 },
          newEnrolmentPercentage: { type: "integer", minimum: 0, maximum: 100 },
        },
        required: ["totalPercentage", "newEnrolmentPercentage"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute(input) {
        if (!Number.isInteger(input?.totalPercentage) || input.totalPercentage < 1 || input.totalPercentage > 100) throw new Error("totalPercentage must be an integer from 1 to 100.");
        if (!Number.isInteger(input?.newEnrolmentPercentage) || input.newEnrolmentPercentage < 0 || input.newEnrolmentPercentage > 100) throw new Error("newEnrolmentPercentage must be an integer from 0 to 100.");
        setInputValue("total", input.totalPercentage);
        setInputValue("new", input.newEnrolmentPercentage);
        return { totalPercentage: input.totalPercentage, newEnrolmentPercentage: input.newEnrolmentPercentage };
      },
    }, { signal: lifecycle.signal })).catch(() => {});
  } catch {}
}

registerWebMcp();
updateEstimate();
