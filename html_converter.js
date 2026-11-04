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

      const tableLines = _structuredLinesFromTable(node, currentHeading);
      const warning = _coverageWarning(node, tableLines);
      if (warning) {
        if (!tableLines.length) {
          tableLines.push(`TABLE: ${_tableCaption(node, currentHeading)}`);
        }
        tableLines.push(warning);
      }
      const tableBlock = _classifyTableBlock(tableLines);
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

// 변환 결과를 원문 표와 대조한다(중첩 표는 따로 대조). 빠진 내용이 있으면 WARN 을 남긴다.
// - 숫자: 원문에 나온 횟수만큼 출력에도 있어야 한다(같은 숫자가 두 칸에 있다가 하나만 사라진 경우도 잡는다).
// - 글자: 4자 이상인 셀은 앞뒤 일부가 출력에 있어야 한다(숫자 없는 문장이 사라진 경우를 잡는다).
const NUMERIC_TOKEN_PATTERN = /\d[\d,]*(?:\.\d+)?/g;
const MAX_WARN_SAMPLES = 5;
const MIN_TEXT_PROBE_LENGTH = 4;
const TEXT_PROBE_LENGTH = 12;
const TEXT_SAMPLE_LENGTH = 30;

function _numericTokens(text) {
  return text.match(NUMERIC_TOKEN_PATTERN) || [];
}

function _countTokens(tokens) {
  const counts = new Map();
  for (const token of tokens) {
    counts.set(token, (counts.get(token) || 0) + 1);
  }
  return counts;
}

function _compact(text) {
  return text.replace(/\s+/g, "");
}

function _isTextCoveredBy(compactOutput, compactCell) {
  if (compactCell.length < MIN_TEXT_PROBE_LENGTH || !/[^\d,.\-()%]/.test(compactCell)) {
    return true;
  }
  // "구분(*)" 같은 일반 열 이름은 "계정과목(*)" 으로 바뀌어 나간다(각주 표시는 유지).
  const footnoteMarker = (compactCell.match(FOOTNOTE_MARKER_PATTERN) || [""])[0];
  const coreLabel = compactCell.slice(0, compactCell.length - footnoteMarker.length);
  if (GENERIC_ACCOUNT_LABELS.includes(coreLabel) && compactOutput.includes(`계정과목${footnoteMarker}`)) {
    return true;
  }
  return (
    compactOutput.includes(compactCell.slice(0, TEXT_PROBE_LENGTH)) &&
    compactOutput.includes(compactCell.slice(-TEXT_PROBE_LENGTH))
  );
}

function _formatWarnSamples(items) {
  const samples = items.slice(0, MAX_WARN_SAMPLES).join(", ");
  const overflow = items.length > MAX_WARN_SAMPLES ? ` 외 ${items.length - MAX_WARN_SAMPLES}개` : "";
  return `${samples}${overflow}`;
}

function _coverageWarning(table, lines) {
  const cellTexts = Array.from(table.querySelectorAll("th, td"))
    .filter((cell) => cell.closest("table") === table)
    .map((cell) => _cellText(cell))
    .filter(Boolean);
  if (!cellTexts.length) {
    return "";
  }

  const output = lines.join("\n");
  const outputCounts = _countTokens(_numericTokens(output));
  const missingNumbers = [];
  for (const [token, count] of _countTokens(cellTexts.flatMap(_numericTokens))) {
    const shortfall = count - (outputCounts.get(token) || 0);
    if (shortfall > 0) {
      missingNumbers.push(shortfall > 1 ? `${token}(${shortfall}회)` : token);
    }
  }

  const compactOutput = _compact(output);
  const missingTexts = cellTexts
    .filter((text) => !_isTextCoveredBy(compactOutput, _compact(text)))
    .map((text) => `"${text.length > TEXT_SAMPLE_LENGTH ? `${text.slice(0, TEXT_SAMPLE_LENGTH)}…` : text}"`);

  const problems = [];
  if (missingNumbers.length) {
    problems.push(`숫자 ${missingNumbers.length}종 누락: ${_formatWarnSamples(missingNumbers)}`);
  }
  if (missingTexts.length) {
    problems.push(`셀 ${missingTexts.length}개 누락: ${_formatWarnSamples(missingTexts)}`);
  }
  return problems.length ? `WARN: 원문 표 내용이 변환 결과에 빠졌습니다. ${problems.join(" / ")}` : "";
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
    // 칸마다 원문 셀의 첫 칸인지 기록한다. colspan 으로 복제된 칸과 같은 값의 별도 셀을 구분하는 데 쓴다.
    const spanStarts = [];
    let colIndex = 0;

    const flushCarriedCells = () => {
      while (carry.has(colIndex)) {
        const carried = carry.get(colIndex);
        row.push(carried.value);
        spanStarts.push(carried.isSpanStart);
        if (carried.remaining <= 1) {
          carry.delete(colIndex);
        } else {
          carry.set(colIndex, {
            ...carried,
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
        spanStarts.push(offset === 0);
        if (rowspan > 1) {
          carry.set(colIndex + offset, {
            value: text,
            isSpanStart: offset === 0,
            remaining: rowspan - 1,
          });
        }
      }
      colIndex += colspan;
    }

    flushCarriedCells();

    if (row.some((value) => value.trim())) {
      row.spanStarts = spanStarts;
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

  // TD 로 작성된 헤더: 첫 행에는 숫자가 없고 다음 행부터 숫자 값이 나오면 첫 행을 헤더로 쓴다.
  const [firstRow, ...restRows] = gridRows.map(({ row }) => row);
  const firstRowCells = firstRow.filter((cell) => cell.trim());
  if (
    firstRow.length > 1 &&
    firstRowCells.length === firstRow.length &&
    new Set(firstRowCells).size === firstRowCells.length &&
    !_hasNumericValueCell(firstRow) &&
    restRows.some(_hasNumericValueCell)
  ) {
    return [_mergeHeaderRows([firstRow]), 1];
  }

  return [gridRows[0].row.map((_, index) => `col${index + 1}`), 0];
}

const NUMERIC_VALUE_PATTERN = /^[(\-−△]?\s*[\d,]+(?:\.\d+)?\s*\)?\s*%?$/;

function _hasNumericValueCell(row) {
  return row.slice(1).some((cell) => NUMERIC_VALUE_PATTERN.test(cell.trim()));
}

const MAX_ACCOUNT_LABEL_LENGTH = 20;
const GENERIC_ACCOUNT_LABELS = ["구분", "과목", "계정과목"];
const FOOTNOTE_MARKER_PATTERN = /\s*(?:\(\*\d*\)|\(주\d*\)|\*\d*)$/;

function _normalizeFirstHeaderLabel(headers) {
  if (!headers.length) {
    return headers;
  }

  const normalizedHeaders = [...headers];
  const firstHeader = normalizedHeaders[0].trim() || "계정과목";
  // "구 분"·"과목" 같은 짧은 열 이름만 바꾼다. 문장 속 단어(예: "…구분이 없어졌습니다")는 바꾸지 않는다.
  if (firstHeader.replace(/\s+/g, "").length > MAX_ACCOUNT_LABEL_LENGTH) {
    return normalizedHeaders;
  }
  const hasDescriptiveFollowingHeader = normalizedHeaders
    .slice(1)
    .some((header) => header.trim() && !header.startsWith("col"));

  // "(단위 : 백만원) / 구분(*1)" 처럼 마지막 칸이 일반 명칭일 때만 바꾸고, 각주 표시는 남긴다.
  // "특수관계 구분" 같은 고유 명칭은 그대로 둔다.
  const lastPart = _headerParts(firstHeader).at(-1) || firstHeader;
  const footnoteMarker = (lastPart.match(FOOTNOTE_MARKER_PATTERN) || [""])[0];
  const coreLabel = lastPart.slice(0, lastPart.length - footnoteMarker.length).trim();
  if (GENERIC_ACCOUNT_LABELS.includes(coreLabel)) {
    normalizedHeaders[0] = `계정과목${footnoteMarker}`;
  } else if (normalizedHeaders[0].startsWith("col") && hasDescriptiveFollowingHeader) {
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

// GROUP/HEADER_RAW 로 나누면 모든 열에 공통인 윗단 헤더(예: "공정가치로 측정하는 금융자산 / 상장주식")와
// 그룹과 마지막 칸 사이의 중간 헤더가 출력에서 빠진다. 빠진 헤더를 처음 나온 순서대로 돌려준다.
function _droppedHeaderParts(headers, groupedHeaders) {
  const shown = new Set();
  for (const [groupName, , rawHeaders] of groupedHeaders) {
    if (groupName) {
      shown.add(groupName);
    }
    for (const label of rawHeaders) {
      _headerParts(label).forEach((part) => shown.add(part));
    }
  }

  const dropped = [];
  for (const header of headers.slice(1)) {
    for (const part of _headerParts(header)) {
      if (!shown.has(part) && !dropped.includes(part) && !/^col\d+$/.test(part)) {
        dropped.push(part);
      }
    }
  }
  return dropped;
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

    // 같은 열 이름이 이어지면 값을 합친다. colspan 으로 복제된 칸만 버리고, 별도 셀은 값이 같아도 모두 남긴다
    // (예: 은행차입금 두 건의 이자율이 둘 다 0.026 인 경우).
    const values = [];
    for (let column = index; column < nextIndex; column += 1) {
      const normalized = (row[column] || "").trim();
      if (!normalized) {
        continue;
      }
      const isSeparateCell = row.spanStarts
        ? column === index || row.spanStarts[column]
        : !values.includes(normalized);
      if (isSeparateCell) {
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

  // 금액·비율 같은 숫자 값이 있는 다열 표는 메타가 아니라 데이터다.
  if (headers.length > 1 && rows.some(_hasNumericValueCell)) {
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

  const [rawCollapsedHeaders] = _collapseAdjacentHeaderGroups(
    headers,
    new Array(headers.length).fill("")
  );
  const collapsedHeaders = _normalizeFirstHeaderLabel(rawCollapsedHeaders);

  if (collapsedHeaders.length === 1) {
    const [singleColumnKind, proseLines] = _classifySingleColumnTable(
      node,
      collapsedHeaders,
      dataRows.length ? dataRows : gridRows.map(({ row }) => row),
      startIndex
    );
    if (singleColumnKind === "prose") {
      // 헤더 칸(예: "목 적 사 업")은 본문 셀에 포함되지 않으므로 제목으로 남긴다.
      const proseTitle = (rawCollapsedHeaders[0] || "").trim();
      if (
        startIndex > 0 &&
        proseTitle &&
        !/^col\d+$/.test(proseTitle) &&
        !proseLines.join(" ").includes(proseTitle)
      ) {
        outputLines.push(`META: ${proseTitle}`);
      }
      outputLines.push(..._formatProseLines(proseLines));
      return outputLines;
    }
  }

  // 데이터 행이 없으면 헤더 칸이 곧 내용이다. 열 이름 정규화를 거치지 않은 원문을 그대로 남긴다.
  if (!dataRows.length) {
    outputLines.push(..._metaLinesFromHeaders(rawCollapsedHeaders));
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
    const groupedHeaders = groups.map(([groupName, indexes]) => [
      groupName,
      indexes,
      _groupedLeafHeaderLabels(_selectColumns(collapsedHeaders, indexes), groupName),
    ]);
    const droppedHeaderParts = _droppedHeaderParts(collapsedHeaders, groupedHeaders);
    if (droppedHeaderParts.length) {
      outputLines.push(`META: ${droppedHeaderParts.join(" / ")}`);
    }

    for (const [groupName, indexes, rawHeaders] of groupedHeaders) {
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
