// section-splitter.js - 단일 페이지형 DART 문서를 트리 섹션으로 분할

(function () {
  const FINANCIAL_TITLES = [
    "재무상태표",
    "손익계산서",
    "포괄손익계산서",
    "자본변동표",
    "현금흐름표",
  ];

  function normalizeText(text) {
    return (text || "").replace(/\s+/g, " ").trim();
  }

  function normalizeHeadingText(element) {
    if (!element) {
      return "";
    }
    return normalizeText(element.textContent);
  }

  function isFinancialTitle(text) {
    return FINANCIAL_TITLES.some((title) => text.includes(title));
  }

  function getNumberDepth(text) {
    const match = normalizeText(text).match(/^(\d+)(?:[.-](\d+))?(?:\.)?\s*\S/);
    if (!match) {
      return 0;
    }
    return match[2] ? 2 : 1;
  }

  function isExcludedNumberedHeading(text) {
    const normalized = normalizeText(text);
    return /^\(\d+\)/.test(normalized) || /^[가-힣]\./.test(normalized) || /^[①-⑳]/.test(normalized);
  }

  function resolveHeadingElement(element) {
    if (!element) {
      return null;
    }

    if (
      element.tagName === "A" &&
      /^toc/i.test(element.getAttribute("name") || "") &&
      element.parentElement
    ) {
      return element.parentElement;
    }

    return element;
  }

  function classifyHeading(element) {
    const resolvedElement = resolveHeadingElement(element);
    if (!resolvedElement || !resolvedElement.isConnected) {
      return null;
    }

    const text = normalizeHeadingText(resolvedElement);
    if (!text || text.length > 120 || isExcludedNumberedHeading(text)) {
      return null;
    }

    const classList = Array.from(resolvedElement.classList || []).map((value) =>
      value.toLowerCase()
    );
    const tagName = resolvedElement.tagName || "";

    if (classList.includes("section-1") || classList.includes("section-2")) {
      return { element: resolvedElement, text, level: 1 };
    }

    if (isFinancialTitle(text)) {
      return { element: resolvedElement, text, level: 1 };
    }

    if (/^H[1-3]$/.test(tagName)) {
      return { element: resolvedElement, text, level: 1 };
    }

    if (classList.includes("table-group-xbrl")) {
      const depth = getNumberDepth(text);
      return { element: resolvedElement, text, level: depth >= 2 ? 3 : 2 };
    }

    if (/^H[4-6]$/.test(tagName)) {
      return { element: resolvedElement, text, level: 2 };
    }

    const hasTocAnchor =
      resolvedElement.querySelector?.('a[name^="toc" i]') ||
      (/^toc/i.test(resolvedElement.getAttribute?.("name") || "") ? resolvedElement : null);

    const numberDepth = getNumberDepth(text);
    if (numberDepth > 0 && (hasTocAnchor || tagName === "P")) {
      return { element: resolvedElement, text, level: numberDepth === 1 ? 2 : 3 };
    }

    if (hasTocAnchor) {
      return { element: resolvedElement, text, level: 2 };
    }

    return null;
  }

  function collectHeadings(doc) {
    const candidates = doc.body
      ? Array.from(doc.body.querySelectorAll('p, h1, h2, h3, h4, h5, h6, a[name^="toc" i]'))
      : [];

    const seen = new Set();
    const headings = [];

    for (const candidate of candidates) {
      const heading = classifyHeading(candidate);
      if (!heading || seen.has(heading.element)) {
        continue;
      }
      seen.add(heading.element);
      headings.push(heading);
    }

    return headings;
  }

  function findNextBoundaryIndex(headings, startIndex) {
    const currentLevel = headings[startIndex].level;
    for (let index = startIndex + 1; index < headings.length; index += 1) {
      if (headings[index].level <= currentLevel) {
        return index;
      }
    }
    return -1;
  }

  function serializeFragmentAsDocument(sourceDoc, fragment) {
    const outputDoc = document.implementation.createHTMLDocument(sourceDoc.title || "");

    while (outputDoc.head.firstChild) {
      outputDoc.head.removeChild(outputDoc.head.firstChild);
    }

    for (const childNode of Array.from(sourceDoc.head?.childNodes || [])) {
      outputDoc.head.appendChild(childNode.cloneNode(true));
    }

    outputDoc.body.appendChild(fragment);
    return `<!DOCTYPE html>\n${outputDoc.documentElement.outerHTML}`;
  }

  function buildSectionHtml(doc, startElement, endElement) {
    if (!doc.body || !doc.body.lastChild) {
      return `<!DOCTYPE html>\n${doc.documentElement.outerHTML}`;
    }

    const range = doc.createRange();
    range.setStartBefore(startElement);
    if (endElement) {
      range.setEndBefore(endElement);
    } else {
      range.setEndAfter(doc.body.lastChild);
    }

    return serializeFragmentAsDocument(doc, range.cloneContents());
  }

  function createNode(id, text, html, mode) {
    return {
      id,
      text,
      children: [],
      mode,
      _singlePageHtml: html,
    };
  }

  function buildSinglePageTree(htmlText) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(htmlText || "", "text/html");
    const headings = collectHeadings(doc);

    const fullDocumentNode = createNode(
      "sp-full-document",
      "전체 문서",
      htmlText || `<!DOCTYPE html>\n${doc.documentElement.outerHTML}`,
      "singlePageFullDocument"
    );

    if (!headings.length) {
      return [fullDocumentNode];
    }

    const headingNodes = headings.map((heading, index) => {
      const nextBoundaryIndex = findNextBoundaryIndex(headings, index);
      const endElement =
        nextBoundaryIndex >= 0 ? headings[nextBoundaryIndex].element : null;
      const html = buildSectionHtml(doc, heading.element, endElement);
      const node = createNode(`sp-node-${index + 1}`, heading.text, html, "singlePage");
      return {
        level: heading.level,
        node,
      };
    });

    const roots = [];
    const stack = [];

    for (const entry of headingNodes) {
      while (stack.length && stack[stack.length - 1].level >= entry.level) {
        stack.pop();
      }

      if (stack.length) {
        stack[stack.length - 1].node.children.push(entry.node);
      } else {
        roots.push(entry.node);
      }

      stack.push(entry);
    }

    return [fullDocumentNode, ...roots];
  }

  window.buildSinglePageTree = buildSinglePageTree;
})();
