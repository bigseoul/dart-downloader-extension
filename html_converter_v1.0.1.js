// html_converter.js - HTML을 structured text로 변환
// Python util/html_converter.py를 기준으로 유지한다.

const NOISE_TAGS = new Set([
  "script",
  "style",
  "meta",
  "link",
  "noscript",
  "iframe",
  "form",
  "input",
  "button",
  "nav",
  "header",
  "footer",
  "aside",
  "svg",
  "canvas",
]);

const TABLE_SECTION_TAGS = new Set(["THEAD", "TBODY", "TFOOT"]);
const DART_HEADING_CLASSES = new Set(["section-2", "table-group-xbrl"]);

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
      if (seenTables.has(node)) {
        continue;
      }
      seenTables.add(node);

      const caption = _tableCaption(node);
      const gridRows = _buildTableGrid(node);
      if (!gridRows.length) {
        continue;
      }

      outputLines.push(`TABLE: ${caption}`);
      let [headers, startIndex] = _headerLabels(node, gridRows);
      const dataRows = gridRows.slice(startIndex).map(({ row }) => row);

      if (_shouldMergeStubColumns(headers, dataRows)) {
        headers = _mergeStubHeaders(headers);
      }

      let [collapsedHeaders] = _collapseAdjacentHeaderGroups(
        headers,
        new Array(headers.length).fill("")
      );
      collapsedHeaders = _normalizeFirstHeaderLabel(collapsedHeaders);

      if (collapsedHeaders.length === 1) {
        const [singleColumnKind, proseLines] = _classifySingleColumnTable(
          node,
          collapsedHeaders,
          dataRows.length ? dataRows : gridRows.map(({ row }) => row),
          startIndex
        );
        if (singleColumnKind === "prose") {
          outputLines.push(..._formatProseLines(proseLines));
          outputLines.push("");
          continue;
        }
      }

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

      if (_shouldUseRawTableFallback(collapsedHeaders)) {
        const rawHeaders = _leafHeaderLabels(collapsedHeaders);
        outputLines.push(`HEADER_RAW: ${rawHeaders.join(" | ")}`);
        for (const row of dataRows) {
          const [effectiveHeaders, effectiveRowBeforeNormalize] =
            _collapseAdjacentHeaderGroups(headers, row);
          const effectiveRow = _normalizeSummaryRow(effectiveRowBeforeNormalize);
          const rawPairs = _rowPairs(
            _leafHeaderLabels(effectiveHeaders),
            effectiveRow
          );
          if (rawPairs.length) {
            outputLines.push(`ROW_RAW: ${rawPairs.join(" | ")}`);
          }
        }
        outputLines.push("");
        continue;
      }

      if (collapsedHeaders.length) {
        outputLines.push(`HEADER: ${collapsedHeaders.join(" | ")}`);
      }
      for (const row of dataRows) {
        const [effectiveHeaders, effectiveRowBeforeNormalize] =
          _collapseAdjacentHeaderGroups(headers, row);
        const effectiveRow = _normalizeSummaryRow(effectiveRowBeforeNormalize);
        const pairs = _rowPairs(effectiveHeaders, effectiveRow);
        if (pairs.length) {
          outputLines.push(`ROW: ${pairs.join(" | ")}`);
        }
      }
      outputLines.push("");
      continue;
    }

    if (node.closest("table")) {
      continue;
    }

    if (_isSectionHeadingTag(node)) {
      const text = _normalizedText(node);
      if (text) {
        outputLines.push(`SECTION: ${text}`);
      }
      continue;
    }

    if (node.tagName === "P" || node.tagName === "LI") {
      const logicalLines = _logicalLinesFromNode(node, {
        stripDescendantBlocks: true,
      });
      for (const text of logicalLines) {
        if (_shouldPromoteProseLineToSection(text)) {
          outputLines.push(`SECTION: ${text}`);
          continue;
        }
        const prefix = node.tagName === "LI" ? "- " : "";
        outputLines.push(`${prefix}${text}`);
      }
    }
  }

  const compactLines = [];
  let lastBlank = false;
  for (const line of outputLines) {
    const normalized = line.trim();
    if (!normalized) {
      if (lastBlank) {
        continue;
      }
      compactLines.push("");
      lastBlank = true;
      continue;
    }
    compactLines.push(normalized);
    lastBlank = false;
  }

  return `${compactLines.join("\n").trim()}\n`;
}

function _stripComments(doc) {
  const walker = doc.createTreeWalker(doc, NodeFilter.SHOW_COMMENT);
  const comments = [];
  while (walker.nextNode()) {
    comments.push(walker.currentNode);
  }
  comments.forEach((comment) => comment.parentNode?.removeChild(comment));
}

function _removeNoiseTags(doc) {
  for (const tag of NOISE_TAGS) {
    doc.querySelectorAll(tag).forEach((element) => element.remove());
  }
}

function _normalizedText(node) {
  if (!node) {
    return "";
  }

  if (node.nodeType === Node.TEXT_NODE) {
    return (node.textContent || "").replace(/\s+/g, " ").trim();
  }

  const walker = (node.ownerDocument || document).createTreeWalker(
    node,
    NodeFilter.SHOW_TEXT
  );
  const parts = [];
  while (walker.nextNode()) {
    const text = (walker.currentNode.textContent || "").trim();
    if (text) {
      parts.push(text);
    }
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

function _normalizedLines(text) {
  return text
    .split(/\r?\n/)
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function _cloneElement(node) {
  return node ? node.cloneNode(true) : null;
}

function _logicalLinesFromNode(node, options = {}) {
  const { stripDescendantBlocks = false } = options;
  const clonedNode = _cloneElement(node);
  if (!clonedNode) {
    const text = _normalizedText(node);
    return text ? [text] : [];
  }

  if (stripDescendantBlocks) {
    clonedNode.querySelectorAll("p, li").forEach((descendant) => descendant.remove());
  }

  clonedNode.querySelectorAll("br").forEach((br) => {
    br.replaceWith(clonedNode.ownerDocument.createTextNode("\n"));
  });

  return _normalizedLines(_joinedTextNodes(clonedNode, "\n"));
}

function _joinedTextNodes(node, separator) {
  const walker = (node.ownerDocument || document).createTreeWalker(
    node,
    NodeFilter.SHOW_TEXT
  );
  const parts = [];

  while (walker.nextNode()) {
    parts.push(walker.currentNode.textContent || "");
  }

  return parts.join(separator);
}

function _isDartHeadingTag(node) {
  if (node.tagName !== "P") {
    return false;
  }
  return Array.from(node.classList || []).some((className) =>
    DART_HEADING_CLASSES.has(className)
  );
}

function _isSectionHeadingTag(node) {
  return /^H[1-6]$/.test(node.tagName) || _isDartHeadingTag(node);
}

function _previousElement(node) {
  if (!node) {
    return null;
  }

  if (node.previousElementSibling) {
    let current = node.previousElementSibling;
    while (current.lastElementChild) {
      current = current.lastElementChild;
    }
    return current;
  }

  return node.parentElement;
}

function _previousTableHeading(table) {
  let previous = _previousElement(table);
  while (previous) {
    if (
      previous !== table &&
      previous.tagName !== "TABLE" &&
      previous.closest("table")
    ) {
      previous = _previousElement(previous);
      continue;
    }

    if (previous.tagName === "TABLE") {
      if (_buildTableGrid(previous).length) {
        break;
      }
      previous = _previousElement(previous);
      continue;
    }

    if (_isDartHeadingTag(previous) || /^H[1-6]$/.test(previous.tagName)) {
      const text = _normalizedText(previous);
      if (text) {
        return text;
      }
    }

    previous = _previousElement(previous);
  }

  return "";
}

function _tableCaption(table) {
  const caption = _normalizedText(table.querySelector("caption"));
  if (caption) {
    return caption;
  }

  const previousHeading = _previousTableHeading(table);
  if (previousHeading) {
    return previousHeading;
  }

  return "표";
}

function _directTRs(container) {
  const rows = [];
  for (const child of Array.from(container.children)) {
    if (child.tagName === "TR") {
      rows.push(child);
      continue;
    }
    if (TABLE_SECTION_TAGS.has(child.tagName)) {
      rows.push(..._directTRs(child));
    }
  }
  return rows;
}

function _cloneCellWithoutNestedTables(cell) {
  const clonedCell = _cloneElement(cell);
  if (!clonedCell) {
    return null;
  }
  clonedCell.querySelectorAll("table").forEach((nestedTable) => nestedTable.remove());
  return clonedCell;
}

function _cellText(cell) {
  const clonedCell = _cloneCellWithoutNestedTables(cell);
  if (!clonedCell) {
    return _normalizedText(cell);
  }
  return _normalizedText(clonedCell);
}

function _spanSize(cell, attrName) {
  const rawValue = cell.getAttribute(attrName) || "1";
  const parsed = parseInt(rawValue, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return 1;
  }
  return parsed;
}

function _buildTableGrid(table) {
  const carry = new Map();
  const gridRows = [];

  for (const tr of _directTRs(table)) {
    let cells = Array.from(tr.children).filter(
      (child) => child.tagName === "TH" || child.tagName === "TD"
    );
    if (!cells.length) {
      cells = Array.from(tr.querySelectorAll("th, td"));
    }

    const row = [];
    let colIndex = 0;

    const flushCarriedCells = () => {
      while (carry.has(colIndex)) {
        const carried = carry.get(colIndex);
        row.push(carried.value);
        if (carried.remaining <= 1) {
          carry.delete(colIndex);
        } else {
          carry.set(colIndex, {
            value: carried.value,
            remaining: carried.remaining - 1,
          });
        }
        colIndex += 1;
      }
    };

    for (const cell of cells) {
      flushCarriedCells();

      const text = _cellText(cell);
      const colspan = _spanSize(cell, "colspan");
      const rowspan = _spanSize(cell, "rowspan");

      for (let offset = 0; offset < colspan; offset += 1) {
        row.push(text);
        if (rowspan > 1) {
          carry.set(colIndex + offset, {
            value: text,
            remaining: rowspan - 1,
          });
        }
      }
      colIndex += colspan;
    }

    flushCarriedCells();

    if (row.some((value) => value.trim())) {
      const isHeader = cells.length > 0 && cells.every((cell) => cell.tagName === "TH");
      gridRows.push({ row, isHeader });
    }
  }

  return gridRows;
}

function _mergeHeaderRows(headerRows) {
  if (!headerRows.length) {
    return [];
  }

  const maxColumns = Math.max(...headerRows.map((row) => row.length));
  const merged = [];
  for (let columnIndex = 0; columnIndex < maxColumns; columnIndex += 1) {
    const parts = [];
    for (const row of headerRows) {
      if (columnIndex >= row.length) {
        continue;
      }
      const value = row[columnIndex].trim();
      if (!value) {
        continue;
      }
      if (!parts.includes(value)) {
        parts.push(value);
      }
    }
    merged.push(parts.length ? parts.join(" / ") : `col${columnIndex + 1}`);
  }
  return merged;
}

function _looksLikeHeaderLabel(value) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return false;
  }

  if (
    /\d{4}/.test(normalized) &&
    !normalized.includes("과목") &&
    !normalized.includes("구분") &&
    !normalized.includes("주석")
  ) {
    return false;
  }

  const keywords = [
    "과 목",
    "과목",
    "구분",
    "주석",
    "당기",
    "전기",
    "기말",
    "기초",
    "증가",
    "감소",
  ];
  return keywords.some((keyword) => normalized.includes(keyword));
}

function _headerLabels(table, gridRows) {
  if (!gridRows.length) {
    return [[], 0];
  }

  const thead = Array.from(table.children).find((child) => child.tagName === "THEAD");
  if (thead) {
    const theadGrid = _buildTableGrid(thead);
    if (theadGrid.length) {
      return [_mergeHeaderRows(theadGrid.map(({ row }) => row)), theadGrid.length];
    }
  }

  const headerRows = [];
  let headerRowCount = 0;
  for (const { row, isHeader } of gridRows) {
    const normalizedCells = row.filter((cell) => cell.trim());
    if (isHeader && normalizedCells.length) {
      headerRows.push(row);
      headerRowCount += 1;
      continue;
    }
    if (headerRows.length) {
      break;
    }
    if (
      normalizedCells.length &&
      normalizedCells.every((cell) => _looksLikeHeaderLabel(cell))
    ) {
      headerRows.push(row);
      headerRowCount += 1;
      continue;
    }
    break;
  }

  if (headerRows.length) {
    return [_mergeHeaderRows(headerRows), headerRowCount];
  }

  return [gridRows[0].row.map((_, index) => `col${index + 1}`), 0];
}

function _normalizeFirstHeaderLabel(headers) {
  if (!headers.length) {
    return headers;
  }

  const normalizedHeaders = [...headers];
  const firstHeader = normalizedHeaders[0].trim() || "계정과목";
  const hasDescriptiveFollowingHeader = normalizedHeaders
    .slice(1)
    .some((header) => header.trim() && !header.startsWith("col"));

  if (
    firstHeader.includes("과목") ||
    firstHeader.includes("구분") ||
    (normalizedHeaders[0].startsWith("col") && hasDescriptiveFollowingHeader)
  ) {
    normalizedHeaders[0] = "계정과목";
  }

  return normalizedHeaders;
}

function _rowPairs(headers, row) {
  const effectiveHeaders = headers.length
    ? [...headers]
    : row.map((_, index) => `col${index + 1}`);

  while (effectiveHeaders.length < row.length) {
    effectiveHeaders.push(`col${effectiveHeaders.length + 1}`);
  }

  const normalizedHeaders = _normalizeFirstHeaderLabel(effectiveHeaders);
  return row
    .map((value, index) => (value ? `${normalizedHeaders[index]}=${value}` : null))
    .filter(Boolean);
}

function _isSummaryLabel(value) {
  const normalized = value.replace(/\s+/g, "");
  return ["합계", "소계", "총계", "계"].includes(normalized);
}

function _normalizeSummaryRow(row) {
  if (row.length < 2) {
    return row;
  }

  const firstValue = row[0].trim();
  if (!firstValue || !_isSummaryLabel(firstValue)) {
    return row;
  }

  let repeatedCount = 1;
  for (const value of row.slice(1)) {
    if (value.trim() !== firstValue) {
      break;
    }
    repeatedCount += 1;
  }

  if (repeatedCount < 2) {
    return row;
  }

  const normalizedRow = [...row];
  for (let index = 1; index < repeatedCount; index += 1) {
    normalizedRow[index] = "";
  }
  return normalizedRow;
}

function _leafHeaderLabels(headers) {
  const leafHeaders = headers.map((header) => {
    const parts = header
      .split(/\s+\/\s+/)
      .map((part) => part.trim())
      .filter(Boolean);

    if (parts.length >= 3) {
      return parts.slice(-2).join(" / ");
    }
    if (parts.length) {
      return parts[parts.length - 1];
    }
    return header;
  });

  return _normalizeFirstHeaderLabel(leafHeaders);
}

function _shouldUseRawTableFallback(headers) {
  return headers.length > 18;
}

function _shouldMergeStubColumns(headers, rows) {
  if (headers.length < 3) {
    return false;
  }
  if (!headers[1].startsWith("col")) {
    return false;
  }
  if (!headers.slice(2).some((header) => header.trim() && !header.startsWith("col"))) {
    return false;
  }

  const pairRows = rows
    .filter((row) => row.length >= 2 && (row[0].trim() || row[1].trim()))
    .map((row) => [row[0].trim(), row[1].trim()]);

  if (!pairRows.length) {
    return false;
  }

  return pairRows.some(([first, second]) => first && second && first !== second);
}

function _mergeStubHeaders(headers) {
  if (headers.length < 2) {
    return headers;
  }

  const normalizedHeaders = [...headers];
  normalizedHeaders[0] = "계정과목";
  normalizedHeaders[1] = "계정과목";
  return normalizedHeaders;
}

function _collapseAdjacentHeaderGroups(headers, row) {
  if (!headers.length) {
    return [headers, row];
  }

  const collapsedHeaders = [];
  const collapsedRow = [];
  let index = 0;

  while (index < headers.length) {
    const label = headers[index];
    let nextIndex = index + 1;
    while (nextIndex < headers.length && headers[nextIndex] === label) {
      nextIndex += 1;
    }

    const values = [];
    for (const value of row.slice(index, nextIndex)) {
      const normalized = value.trim();
      if (normalized && !values.includes(normalized)) {
        values.push(normalized);
      }
    }

    collapsedHeaders.push(label);
    collapsedRow.push(values.join(" / "));
    index = nextIndex;
  }

  return [collapsedHeaders, collapsedRow];
}

function _isMetadataTable(headers, rows) {
  if (!rows.length) {
    return false;
  }

  if (!headers.every((header) => header.startsWith("col"))) {
    return false;
  }

  const blob = rows.map((row) => row.join(" ")).join(" ");
  const metaKeywords = [
    "단위",
    "현재",
    "부터",
    "까지",
    "주식회사",
    "대표이사",
    "본점 소재지",
    "첨부된 재무제표",
  ];

  if (headers.length === 1 && metaKeywords.some((keyword) => blob.includes(keyword))) {
    return true;
  }

  if (rows.length <= 2) {
    return true;
  }

  if (rows.length > 4) {
    return false;
  }

  return metaKeywords.some((keyword) => blob.includes(keyword));
}

function _singleColumnCells(table, startIndex) {
  let rows = _directTRs(table).slice(startIndex);
  if (!rows.length) {
    rows = _directTRs(table);
  }

  return rows
    .map((tr) => {
      const directCell = Array.from(tr.children).find(
        (child) => child.tagName === "TH" || child.tagName === "TD"
      );
      if (directCell) {
        return directCell;
      }
      return tr.querySelector("th, td");
    })
    .filter(Boolean);
}

function _analyzeSingleColumnCell(cell) {
  const clonedCell = _cloneCellWithoutNestedTables(cell);
  if (!clonedCell) {
    const lines = _logicalLinesFromNode(cell);
    return [lines, 0, 0];
  }

  const brCount = clonedCell.querySelectorAll("br").length;
  const paragraphs = Array.from(clonedCell.querySelectorAll("p")).filter(
    (paragraph) => _logicalLinesFromNode(paragraph).length
  );

  if (paragraphs.length) {
    const lines = [];
    for (const paragraph of paragraphs) {
      lines.push(..._logicalLinesFromNode(paragraph));
    }
    return [lines, paragraphs.length, brCount];
  }

  return [_logicalLinesFromNode(clonedCell), 0, brCount];
}

function _countPatternMatches(lines, pattern) {
  const compiled = new RegExp(pattern);
  return lines.filter((line) => compiled.test(line)).length;
}

function _classifySingleColumnTable(table, headers, rows, startIndex) {
  if (!rows.length || headers.length !== 1) {
    return ["meta", []];
  }

  const cells = _singleColumnCells(table, startIndex);
  const lines = [];
  let paragraphCount = 0;
  let brCount = 0;

  for (const cell of cells) {
    const [cellLines, cellParagraphCount, cellBrCount] =
      _analyzeSingleColumnCell(cell);
    lines.push(...cellLines);
    paragraphCount += cellParagraphCount;
    brCount += cellBrCount;
  }

  const textLength = lines.reduce((sum, line) => sum + line.length, 0);
  const sectionLikeCount = _countPatternMatches(
    lines,
    "^(?:\\\\d+\\\\.\\\\d+\\\\s*\\\\S|[가-힣]\\\\.\\\\s+)"
  );

  if (textLength > 500) {
    return ["prose", lines];
  }
  if (paragraphCount >= 3 && textLength > 200) {
    return ["prose", lines];
  }
  if (sectionLikeCount >= 2 && textLength > 120) {
    return ["prose", lines];
  }
  if (brCount >= 3 && textLength > 200) {
    return ["prose", lines];
  }
  return ["meta", lines];
}

function _shouldPromoteProseLineToSection(text) {
  return /^\d+\.\d+\s*\S/.test(text) || /^[가-힣]\.\s+/.test(text);
}

function _formatProseLines(lines) {
  const formattedLines = [];
  for (const text of lines) {
    if (_shouldPromoteProseLineToSection(text)) {
      formattedLines.push(`SECTION: ${text}`);
    } else {
      formattedLines.push(text);
    }
  }
  return formattedLines;
}

function _dedupeAdjacentValues(values) {
  const deduped = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized) {
      continue;
    }
    if (deduped.length && deduped[deduped.length - 1] === normalized) {
      continue;
    }
    deduped.push(normalized);
  }
  return deduped;
}

function _metaLinesFromHeaders(headers) {
  const values = _dedupeAdjacentValues(headers);
  if (!values.length) {
    return [];
  }
  return [`META: ${values.join(" | ")}`];
}
