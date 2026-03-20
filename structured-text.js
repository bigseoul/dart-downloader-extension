// structured-text.js - HTML을 structured text로 변환
// Python utils/html_converter.py의 JavaScript 포팅

const NOISE_TAGS = new Set([
  "script", "style", "meta", "link", "noscript", "iframe",
  "form", "input", "button", "nav", "header", "footer",
  "aside", "svg", "canvas",
]);

function buildStructuredText(htmlText, sourceName) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(htmlText || "", "text/html");

  _stripComments(doc);
  _removeNoiseTags(doc);

  const outputLines = [`DOCUMENT: ${sourceName}`];
  const seenTables = new Set();

  const body = doc.body || doc.documentElement;
  const walker = doc.createTreeWalker(body, NodeFilter.SHOW_ELEMENT);

  let node;
  while ((node = walker.nextNode())) {
    if (node.tagName === "TABLE") {
      if (seenTables.has(node)) continue;
      seenTables.add(node);

      const caption = _tableCaption(node);
      const rows = _tableRows(node);
      if (!rows.length) continue;

      outputLines.push(`TABLE: ${caption}`);
      const [headers, startIndex] = _headerLabels(node, rows);
      const dataRows = rows.slice(startIndex);
      const [collapsedHeaders] = _collapseAdjacentHeaderGroups(
        headers,
        new Array(headers.length).fill("")
      );

      if (!dataRows.length) {
        outputLines.push(..._metaLinesFromHeaders(collapsedHeaders));
        outputLines.push("");
        continue;
      }

      if (_isMetadataTable(collapsedHeaders, dataRows)) {
        for (const row of dataRows) {
          const [, collapsedRow] = _collapseAdjacentHeaderGroups(headers, row);
          const values = _dedupeAdjacentValues(collapsedRow);
          if (values.length) {
            outputLines.push(`META: ${values.join(" | ")}`);
          }
        }
        outputLines.push("");
        continue;
      }

      if (collapsedHeaders.length) {
        outputLines.push(`HEADER: ${collapsedHeaders.join(" | ")}`);
      }
      for (const row of dataRows) {
        const [effHeaders, effRow] = _collapseAdjacentHeaderGroups(headers, row);
        const pairs = _rowPairs(effHeaders, effRow);
        if (pairs.length) {
          outputLines.push(`ROW: ${pairs.join(" | ")}`);
        }
      }
      outputLines.push("");
      continue;
    }

    if (/^H[1-6]$/.test(node.tagName)) {
      const text = _normalizedText(node);
      if (text) outputLines.push(`SECTION: ${text}`);
      continue;
    }

    if (node.tagName === "P" || node.tagName === "LI") {
      const text = _normalizedText(node);
      if (text) {
        const prefix = node.tagName === "LI" ? "- " : "";
        outputLines.push(`${prefix}${text}`);
      }
    }
  }

  // Compact: remove consecutive blank lines
  const compactLines = [];
  let lastBlank = false;
  for (const line of outputLines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (lastBlank) continue;
      compactLines.push("");
      lastBlank = true;
      continue;
    }
    compactLines.push(trimmed);
    lastBlank = false;
  }

  return compactLines.join("\n").trim() + "\n";
}

// ─── Helper functions ───

function _stripComments(doc) {
  const walker = doc.createTreeWalker(doc, NodeFilter.SHOW_COMMENT);
  const comments = [];
  while (walker.nextNode()) comments.push(walker.currentNode);
  comments.forEach((c) => c.parentNode?.removeChild(c));
}

function _removeNoiseTags(doc) {
  for (const tag of NOISE_TAGS) {
    doc.querySelectorAll(tag).forEach((el) => el.remove());
  }
}

function _normalizedText(node) {
  if (!node) return "";
  return (node.textContent || "").replace(/\s+/g, " ").trim();
}

function _tableCaption(table) {
  const caption = table.querySelector("caption");
  const captionText = _normalizedText(caption);
  if (captionText) return captionText;

  // Look for preceding heading
  let prev = table.previousElementSibling;
  while (prev) {
    if (/^H[1-6]$/.test(prev.tagName)) {
      const text = _normalizedText(prev);
      if (text) return text;
    }
    prev = prev.previousElementSibling;
  }
  return "표";
}

function _tableRows(table) {
  const rows = [];
  for (const tr of table.querySelectorAll("tr")) {
    const [values] = _expandedRowValues(tr);
    if (values.some((v) => v)) rows.push(values);
  }
  return rows;
}

function _expandedRowValues(tr) {
  let cells = Array.from(tr.querySelectorAll(":scope > th, :scope > td"));
  if (!cells.length) cells = Array.from(tr.querySelectorAll("th, td"));

  const values = [];
  const isHeader = cells.length > 0 && cells.every((c) => c.tagName === "TH");

  for (const cell of cells) {
    const text = _normalizedText(cell);
    const colspan = Math.max(1, parseInt(cell.getAttribute("colspan") || "1", 10) || 1);
    for (let i = 0; i < colspan; i++) values.push(text);
  }
  return [values, isHeader];
}

function _mergeHeaderRows(headerRows) {
  if (!headerRows.length) return [];

  const maxCols = Math.max(...headerRows.map((r) => r.length));
  const merged = [];
  for (let col = 0; col < maxCols; col++) {
    const parts = [];
    for (const row of headerRows) {
      if (col >= row.length) continue;
      const val = row[col].trim();
      if (val && !parts.includes(val)) parts.push(val);
    }
    merged.push(parts.length ? parts.join(" / ") : `col${col + 1}`);
  }
  return merged;
}

function _looksLikeHeaderLabel(value) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return false;

  if (
    /\d{4}/.test(normalized) &&
    !normalized.includes("과목") &&
    !normalized.includes("구분") &&
    !normalized.includes("주석")
  ) {
    return false;
  }

  const keywords = ["과 목", "과목", "구분", "주석", "당기", "전기", "기말", "기초", "증가", "감소"];
  return keywords.some((kw) => normalized.includes(kw));
}

function _headerLabels(table, rows) {
  if (!rows.length) return [[], 0];

  const thead = table.querySelector("thead");
  if (thead) {
    const headerRows = _tableRows(thead);
    if (headerRows.length) {
      return [_mergeHeaderRows(headerRows), headerRows.length];
    }
  }

  const headerRows = [];
  let headerRowCount = 0;
  for (const tr of table.querySelectorAll("tr")) {
    const [row, isHeader] = _expandedRowValues(tr);
    const normalizedCells = row.filter((c) => c.trim());
    if (isHeader && normalizedCells.length) {
      headerRows.push(row);
      headerRowCount++;
      continue;
    }
    if (headerRows.length) break;
    if (normalizedCells.length && normalizedCells.every(_looksLikeHeaderLabel)) {
      headerRows.push(row);
      headerRowCount++;
      continue;
    }
    break;
  }

  if (headerRows.length) {
    return [_mergeHeaderRows(headerRows), headerRowCount];
  }

  return [rows[0].map((_, i) => `col${i + 1}`), 0];
}

function _rowPairs(headers, row) {
  const effHeaders = headers.length
    ? [...headers]
    : row.map((_, i) => `col${i + 1}`);
  while (effHeaders.length < row.length) {
    effHeaders.push(`col${effHeaders.length + 1}`);
  }

  const first = (effHeaders[0] || "").trim() || "계정과목";
  if (first.includes("과목") || first.includes("구분")) {
    effHeaders[0] = "계정과목";
  }

  return row
    .map((value, i) => (value ? `${effHeaders[i]}=${value}` : null))
    .filter(Boolean);
}

function _collapseAdjacentHeaderGroups(headers, row) {
  if (!headers.length) return [headers, row];

  const collapsedHeaders = [];
  const collapsedRow = [];
  let i = 0;
  while (i < headers.length) {
    const label = headers[i];
    let next = i + 1;
    while (next < headers.length && headers[next] === label) next++;

    const values = [];
    for (const val of row.slice(i, next)) {
      const normalized = val.trim();
      if (normalized && !values.includes(normalized)) values.push(normalized);
    }

    collapsedHeaders.push(label);
    collapsedRow.push(values.join(" / "));
    i = next;
  }

  return [collapsedHeaders, collapsedRow];
}

function _isMetadataTable(headers, rows) {
  if (!rows.length) return false;
  if (!headers.every((h) => h.startsWith("col"))) return false;
  if (rows.length <= 2) return true;
  if (rows.length > 4) return false;

  const blob = rows.map((r) => r.join(" ")).join(" ");
  const keywords = ["단위", "현재", "부터", "까지", "주식회사", "대표이사", "본점 소재지", "첨부된 재무제표"];
  return keywords.some((kw) => blob.includes(kw));
}

function _dedupeAdjacentValues(values) {
  const deduped = [];
  for (const val of values) {
    const normalized = val.trim();
    if (!normalized) continue;
    if (deduped.length && deduped[deduped.length - 1] === normalized) continue;
    deduped.push(normalized);
  }
  return deduped;
}

function _metaLinesFromHeaders(headers) {
  const values = _dedupeAdjacentValues(headers);
  if (!values.length) return [];
  return [`META: ${values.join(" | ")}`];
}
