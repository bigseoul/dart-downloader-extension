// html_converter.js - HTML을 structured text로 변환
// Python rag/utils/html_converter.py의 현재 동작을 포팅한다.

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
const NOTE_ROW_SUFFIXES = [
  "에 대한 기술",
  "에 대한 설명",
  "에 관한 설명",
  "에 대한 내역",
  "에 관한 내역",
];
const PAYLOAD_LINE_PREFIXES = [
  "HEADER:",
  "ROW:",
  "HEADER_RAW:",
  "ROW_RAW:",
  "NOTE_ROW:",
  "NOTE_ROW_RAW:",
];

function buildStructuredText(htmlText, sourceName) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(htmlText || "", "text/html");

  _stripComments(doc);
  _removeNoiseTags(doc);

  const outputLines = [`DOCUMENT: ${sourceName}`];
  const seenTables = new Set();
  const elements = [];
  let currentHeading = "";

  const body = doc.body || doc.documentElement;
  const walker = doc.createTreeWalker(body, NodeFilter.SHOW_ELEMENT);

  let node;
  while ((node = walker.nextNode())) {
    if (node.tagName === "TABLE") {
      if (seenTables.has(node)) {
        continue;
      }
      seenTables.add(node);

      const tableBlock = _classifyTableBlock(
        _structuredLinesFromTable(node, currentHeading)
      );
      if (tableBlock.kind === "empty") {
        continue;
      }
      elements.push(tableBlock);
      continue;
    }

    if (node.closest("table")) {
      continue;
    }

    if (_isSectionHeadingTag(node)) {
      const text = _normalizedText(node);
      if (text) {
        currentHeading = text;
        elements.push(`SECTION: ${text}`);
      }
      continue;
    }

    if (node.tagName === "P" || node.tagName === "LI") {
      const logicalLines = _logicalLinesFromNode(node, {
        stripDescendantBlocks: true,
      });
      for (const text of logicalLines) {
        if (_shouldPromoteProseLineToSection(text)) {
          elements.push(`SECTION: ${text}`);
          continue;
        }
        const prefix = node.tagName === "LI" ? "- " : "";
        elements.push(`${prefix}${text}`);
      }
    }
  }

  for (const element of _mergeAdjacentTableBlocks(elements)) {
    if (typeof element === "string") {
      outputLines.push(element);
      continue;
    }
    outputLines.push(...element.lines);
    outputLines.push("");
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
  for (const comment of comments) {
    comment.parentNode?.removeChild(comment);
  }
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

function _tableCaption(table, currentHeading = "") {
  const caption = _normalizedText(table.querySelector("caption"));
  if (caption) {
    return caption;
  }
  if (currentHeading) {
    return currentHeading;
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

function _isNoteRow(accountLabel) {
  const normalized = accountLabel.replace(/\s+/g, " ").trim();
  return NOTE_ROW_SUFFIXES.some(
    (suffix) => normalized.endsWith(suffix) || normalized.includes(`${suffix},`)
  );
}

function _rowLinePrefix(accountLabel, { raw }) {
  if (_isNoteRow(accountLabel)) {
    return raw ? "NOTE_ROW_RAW:" : "NOTE_ROW:";
  }
  return raw ? "ROW_RAW:" : "ROW:";
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

function _headerParts(header) {
  return header
    .split(/\s+\/\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function _leafHeaderLabels(headers) {
  const leafHeaders = headers.map((header) => {
    const parts = _headerParts(header);

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

function _groupedLeafHeaderLabels(headers, groupName) {
  if (!groupName) {
    return _leafHeaderLabels(headers);
  }

  const leafHeaders = headers.map((header, index) => {
    if (index === 0) {
      return header;
    }
    const parts = _headerParts(header);
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
    return [row.map((_, index) => `col${index + 1}`), row];
  }

  const effectiveHeaders = [...headers];
  while (effectiveHeaders.length < row.length) {
    effectiveHeaders.push(`col${effectiveHeaders.length + 1}`);
  }

  const collapsedHeaders = [];
  const collapsedRow = [];
  let index = 0;

  while (index < effectiveHeaders.length) {
    const label = effectiveHeaders[index];
    let nextIndex = index + 1;
    while (nextIndex < effectiveHeaders.length && effectiveHeaders[nextIndex] === label) {
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
    "^(?:\\d+\\.\\d+\\s*\\S|[가-힣]\\.\\s+)"
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

function _commonPrefixDepth(partsList) {
  if (!partsList.length) {
    return 0;
  }

  const minLength = Math.min(...partsList.map((parts) => parts.length));
  let depth = 0;
  while (depth < minLength) {
    const candidate = partsList[0][depth];
    if (partsList.slice(1).some((parts) => parts[depth] !== candidate)) {
      break;
    }
    depth += 1;
  }
  return depth;
}

function _topLevelGroup(header, commonPrefixDepth) {
  const parts = _headerParts(header);
  if (!parts.length) {
    return header;
  }
  if (commonPrefixDepth < parts.length) {
    return parts[commonPrefixDepth];
  }
  return parts[parts.length - 1];
}

function _rawHeaderGroups(headers) {
  if (headers.length <= 1) {
    return [];
  }

  const headerPartsList = headers.slice(1).map((header) => _headerParts(header));
  const commonPrefixDepth = _commonPrefixDepth(headerPartsList.filter(Boolean));
  const groups = [];
  const groupIndexes = new Map();

  headers.slice(1).forEach((header, offset) => {
    const index = offset + 1;
    const groupName = _topLevelGroup(header, commonPrefixDepth);
    if (!groupIndexes.has(groupName)) {
      groupIndexes.set(groupName, groups.length);
      groups.push([groupName, [0, index]]);
      return;
    }
    groups[groupIndexes.get(groupName)][1].push(index);
  });

  if (groups.length <= 1 || groups.every(([, indexes]) => indexes.length === 2)) {
    return [["", Array.from({ length: headers.length }, (_, index) => index)]];
  }

  return groups;
}

function _selectColumns(values, indexes) {
  const selected = [];
  for (const index of indexes) {
    if (index < values.length) {
      selected.push(values[index]);
    }
  }
  return selected;
}

function _createStructuredTableBlock(kind, caption, lines) {
  return {
    kind,
    caption,
    lines,
    get hasPayload() {
      return this.lines.some((line) =>
        PAYLOAD_LINE_PREFIXES.some((prefix) => line.startsWith(prefix))
      );
    },
  };
}

function _extractTableCaption(lines) {
  if (!lines.length || !lines[0].startsWith("TABLE: ")) {
    return "";
  }
  return lines[0].slice("TABLE: ".length).trim();
}

function _classifyTableBlock(lines) {
  const caption = _extractTableCaption(lines);
  if (!lines.length) {
    return _createStructuredTableBlock("empty", caption, []);
  }

  const bodyLines = lines.slice(1);
  const hasMeta = bodyLines.some((line) => line.startsWith("META:"));
  const hasPayload = bodyLines.some((line) =>
    PAYLOAD_LINE_PREFIXES.some((prefix) => line.startsWith(prefix))
  );
  const hasNonPrefixLines = lines.some(
    (line) => !line.startsWith("TABLE:") && !line.startsWith("META:")
  );

  if (lines.length === 1 && lines[0] === "TABLE: 표") {
    return _createStructuredTableBlock("empty", caption, []);
  }
  if (!hasMeta && !hasPayload && !hasNonPrefixLines) {
    return _createStructuredTableBlock("empty", caption, []);
  }
  if (hasMeta && !hasPayload && !hasNonPrefixLines) {
    return _createStructuredTableBlock("meta", caption, lines);
  }
  return _createStructuredTableBlock("data", caption, lines);
}

function _captionsCompatible(metaCaption, dataCaption) {
  if (metaCaption === dataCaption) {
    return true;
  }
  return ["", "표"].includes(metaCaption) || ["", "표"].includes(dataCaption);
}

function _mergeAdjacentTableBlocks(elements) {
  const merged = [];
  let index = 0;

  while (index < elements.length) {
    const current = elements[index];
    const next = elements[index + 1];
    if (
      current &&
      typeof current !== "string" &&
      current.kind === "meta" &&
      next &&
      typeof next !== "string" &&
      next.kind === "data" &&
      next.hasPayload &&
      _captionsCompatible(current.caption, next.caption)
    ) {
      let caption = next.caption || current.caption || "표";
      if (["", "표"].includes(caption) && !["", "표"].includes(current.caption)) {
        caption = current.caption;
      }
      merged.push(
        _createStructuredTableBlock("data", caption, [
          `TABLE: ${caption}`,
          ...current.lines.slice(1),
          ...next.lines.slice(1),
        ])
      );
      index += 2;
      continue;
    }

    merged.push(current);
    index += 1;
  }

  return merged;
}

function _structuredLinesFromTable(node, currentHeading = "") {
  const caption = _tableCaption(node, currentHeading);
  const gridRows = _buildTableGrid(node);
  if (!gridRows.length) {
    return [];
  }

  const outputLines = [`TABLE: ${caption}`];
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
      return outputLines;
    }
  }

  if (!dataRows.length) {
    outputLines.push(..._metaLinesFromHeaders(collapsedHeaders));
    return outputLines;
  }

  if (_isMetadataTable(collapsedHeaders, dataRows)) {
    for (const row of dataRows) {
      const [, collapsedRow] = _collapseAdjacentHeaderGroups(headers, row);
      const values = _dedupeAdjacentValues(collapsedRow);
      if (values.length) {
        outputLines.push(`META: ${values.join(" | ")}`);
      }
    }
    return outputLines;
  }

  if (_shouldUseRawTableFallback(collapsedHeaders)) {
    let groups = _rawHeaderGroups(collapsedHeaders);
    if (!groups.length) {
      groups = [["", Array.from({ length: collapsedHeaders.length }, (_, index) => index)]];
    }
    const collapsedRows = dataRows.map((row) =>
      _normalizeSummaryRow(_collapseAdjacentHeaderGroups(headers, row)[1])
    );

    for (const [groupName, indexes] of groups) {
      const selectedHeaders = _selectColumns(collapsedHeaders, indexes);
      const rawHeaders = _groupedLeafHeaderLabels(selectedHeaders, groupName);
      if (groupName) {
        outputLines.push(`GROUP: ${groupName}`);
      }
      outputLines.push(`HEADER_RAW: ${rawHeaders.join(" | ")}`);

      for (const collapsedRow of collapsedRows) {
        const selectedRow = _selectColumns(collapsedRow, indexes);
        const rawPairs = _rowPairs(rawHeaders, selectedRow);
        if (!rawPairs.length) {
          continue;
        }
        const prefix = _rowLinePrefix(selectedRow[0] || "", { raw: true });
        outputLines.push(`${prefix} ${rawPairs.join(" | ")}`);
      }
    }
    return outputLines;
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
      const prefix = _rowLinePrefix(effectiveRow[0] || "", { raw: false });
      outputLines.push(`${prefix} ${pairs.join(" | ")}`);
    }
  }

  return outputLines;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    buildStructuredText,
  };
}
