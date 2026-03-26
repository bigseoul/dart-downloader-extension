// content.js - DART 페이지에서 jstree 노드 데이터를 추출하는 content script

(function () {
  let pendingTreeResolve = null;
  let pendingTreeStartedAt = 0;
  const FETCH_TIMEOUT_MS = 15000;
  const SINGLE_PAGE_FETCH_TIMEOUT_MS = 30000;
  const ERROR_CODES = {
    HOST_INVALID: "HOST_INVALID",
    DOCUMENT_ERROR_STATE: "DOCUMENT_ERROR_STATE",
    TREE_DATA_UNAVAILABLE: "TREE_DATA_UNAVAILABLE",
    FETCH_FAILURE: "FETCH_FAILURE",
    FETCH_TIMEOUT: "FETCH_TIMEOUT",
  };
  const ERROR_MESSAGES = {
    HOST_INVALID: "호스트 비정상: 허용된 DART 호스트가 아닙니다.",
    DOCUMENT_ERROR_STATE: "페이지 로드 실패 상태: 문서가 비정상입니다.",
    TREE_DATA_UNAVAILABLE: "트리 데이터를 가져올 수 없습니다.",
    FETCH_FAILURE: "후속 문서 fetch 실패: 문서를 가져오지 못했습니다.",
    FETCH_TIMEOUT: "문서 요청 시간이 초과되었습니다.",
  };
  const ALLOWED_HOSTS = ["dart.fss.or.kr", "dart1.fss.or.kr", "dart2.fss.or.kr"];
  const CHARSET_ALIASES = {
    "euc-kr": "euc-kr",
    euckr: "euc-kr",
    "ks_c_5601-1987": "euc-kr",
    "ksc5601": "euc-kr",
    "cp949": "euc-kr",
    "windows-949": "euc-kr",
    "x-windows-949": "euc-kr",
    utf8: "utf-8",
    "utf-8": "utf-8",
  };

  function logContentTiming(step, detail) {
    console.info("[DART AI][content]", step, detail || "");
  }

  function buildViewerUrl(params = {}) {
    const query = new URLSearchParams({
      rcpNo: params.rcpNo || "",
      dcmNo: params.dcmNo || "",
      eleId: params.eleId || "0",
      offset: params.offset || "0",
      length: params.length || "0",
      dtd: params.dtd || "HTML",
    });
    return `${window.location.origin}/report/viewer.do?${query.toString()}`;
  }

  function isAllowedHost() {
    return ALLOWED_HOSTS.includes(window.location.hostname);
  }

  function normalizeCharset(charset) {
    const normalized = (charset || "")
      .trim()
      .replace(/^["']|["']$/g, "")
      .toLowerCase();
    return CHARSET_ALIASES[normalized] || normalized || "utf-8";
  }

  function extractCharsetFromContentType(contentType) {
    const match = (contentType || "").match(/charset\s*=\s*([^;]+)/i);
    return match ? normalizeCharset(match[1]) : "";
  }

  function sniffCharsetFromHtmlBytes(bytes) {
    const headText = new TextDecoder("latin1").decode(bytes.slice(0, 4096));

    const charsetMetaMatch = headText.match(
      /<meta[^>]+charset\s*=\s*["']?\s*([a-z0-9._-]+)/i
    );
    if (charsetMetaMatch) {
      return normalizeCharset(charsetMetaMatch[1]);
    }

    const contentTypeMetaMatch = headText.match(
      /<meta[^>]+content\s*=\s*["'][^"']*charset\s*=\s*([a-z0-9._-]+)/i
    );
    if (contentTypeMetaMatch) {
      return normalizeCharset(contentTypeMetaMatch[1]);
    }

    return "";
  }

  function decodeHtmlBytes(bytes, charset) {
    try {
      return new TextDecoder(charset).decode(bytes);
    } catch (_) {
      return new TextDecoder("utf-8").decode(bytes);
    }
  }

  function serializeDocument(doc) {
    return `<!DOCTYPE html>\n${doc.documentElement.outerHTML}`;
  }

  function getSinglePageSourceDocument() {
    const frame = document.getElementById("ifrm");
    if (frame) {
      try {
        const frameDoc = frame.contentDocument;
        if (
          frameDoc &&
          frameDoc.documentElement &&
          normalizeTextContent(frameDoc.body?.textContent).length > 20
        ) {
          return frameDoc;
        }
      } catch (_) {}
    }

    return document;
  }

  function normalizeTextContent(text) {
    return (text || "").replace(/\s+/g, " ").trim();
  }

  function extractPeriodFromText(text) {
    const match = (text || "").match(/제\s*(\d+)\s*기/);
    return match ? `${match[1]}기` : "";
  }

  function extractPeriodFromHtml(html) {
    const text = normalizeTextContent((html || "").replace(/<[^>]*>/g, " "));
    return extractPeriodFromText(text);
  }

  function isDocumentInErrorState() {
    const bodyText = normalizeTextContent(document.body?.textContent);
    if (bodyText.length < 20 && !document.getElementById("ifrm")) {
      return true;
    }
    return false;
  }

  function makeErrorResponse(errorCode) {
    return {
      success: false,
      errorCode,
      error: ERROR_MESSAGES[errorCode] || errorCode,
    };
  }

  function serializeCurrentDocument() {
    return serializeDocument(getSinglePageSourceDocument());
  }

  async function fetchTextWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
    const controller = new AbortController();
    const timerId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
      });

      if (!response.ok) {
        const err = new Error(`문서를 가져오지 못했습니다. (${response.status})`);
        err.errorCode = ERROR_CODES.FETCH_FAILURE;
        throw err;
      }

      const bytes = new Uint8Array(await response.arrayBuffer());
      const charset =
        extractCharsetFromContentType(response.headers.get("content-type")) ||
        sniffCharsetFromHtmlBytes(bytes) ||
        "utf-8";

      return decodeHtmlBytes(bytes, charset);
    } catch (error) {
      if (error.name === "AbortError") {
        const timeoutError = new Error(ERROR_MESSAGES.FETCH_TIMEOUT);
        timeoutError.errorCode = ERROR_CODES.FETCH_TIMEOUT;
        throw timeoutError;
      }
      if (!error.errorCode) {
        error.errorCode = ERROR_CODES.FETCH_FAILURE;
      }
      throw error;
    } finally {
      clearTimeout(timerId);
    }
  }

  // 페이지 컨텍스트에서 전달된 메시지 수신
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;

    if (event.data?.type === "DART_TREE_DATA") {
      logContentTiming("inject.result", {
        elapsedMs: pendingTreeStartedAt
          ? Math.round(performance.now() - pendingTreeStartedAt)
          : null,
        success: Boolean(event.data.success),
        singlePage: Boolean(event.data.singlePage),
      });
      if (pendingTreeResolve) {
        pendingTreeResolve(event.data);
        pendingTreeResolve = null;
        pendingTreeStartedAt = 0;
      }
    }
  });

  // 메시지 리스너: popup.js에서 요청이 오면 트리 데이터 반환
  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    if (!isAllowedHost()) {
      sendResponse(makeErrorResponse(ERROR_CODES.HOST_INVALID));
      return true;
    }

    if (request.action !== "getTreeData" && isDocumentInErrorState()) {
      sendResponse(makeErrorResponse(ERROR_CODES.DOCUMENT_ERROR_STATE));
      return true;
    }

    if (request.action === "getTreeData") {
      const startedAt = performance.now();
      extractTreeDataViaInjection()
        .then((result) => {
          logContentTiming("getTreeData.done", {
            elapsedMs: Math.round(performance.now() - startedAt),
            success: Boolean(result?.success),
            singlePage: Boolean(result?.singlePage),
          });
          if (!result.success && !result.errorCode) {
            result.errorCode = ERROR_CODES.TREE_DATA_UNAVAILABLE;
          }
          sendResponse(result);
        })
        .catch((e) =>
          sendResponse({
            success: false,
            errorCode: ERROR_CODES.TREE_DATA_UNAVAILABLE,
            error: e.message,
          })
        );
      return true;
    }

    if (request.action === "getDocMeta") {
      (async () => {
        try {
          // 페이지 타이틀에서 회사명 추출 (형식: "삼성전자/사업보고서/2026.03.10")
          const titleParts = document.title.split("/");
          const companyName = titleParts[0] || "";

          // 현재 URL의 dcmNo로 활성 문서 판별
          const urlParams = new URLSearchParams(location.search);
          const currentDcmNo = urlParams.get("dcmNo") || "";

          // 모든 select에서 현재 dcmNo와 일치하는 문서유형 추출
          let docType = "";
          const selects = document.querySelectorAll("select");
          for (const sel of selects) {
            for (const opt of sel.options) {
              // 콤보박스 value에 dcmNo가 포함되어 있거나, 선택된 항목 매칭
              if (currentDcmNo && opt.value.includes(currentDcmNo)) {
                const text = opt.text.trim();
                const m = text.match(/\d{4}\.\d{2}\.\d{2}\s+(.+)/);
                docType = m ? m[1] : text;
                break;
              }
            }
            if (docType) break;
          }
          // dcmNo 매칭 실패 시: 선택된 항목에서 추출
          if (!docType) {
            for (const sel of selects) {
              const selected = sel.options[sel.selectedIndex];
              if (!selected || !selected.value) continue;
              const text = selected.text.trim();
              if (text.includes("선택")) continue;
              const m = text.match(/\d{4}\.\d{2}\.\d{2}\s+(.+)/);
              if (m) { docType = m[1]; break; }
            }
          }
          // 최종 fallback: 페이지 타이틀
          if (!docType) {
            docType = titleParts[1] || "";
          }

          // 기수 추출: 현재 표시 문서 → 실제 보고서 노드 우선 후보 → 기존 fallback
          let period = "";

          try {
            const currentDoc = getSinglePageSourceDocument();
            period = extractPeriodFromText(currentDoc.body?.textContent);
          } catch (_) {}

          if (!period && Array.isArray(request.reportCandidateNodes)) {
            for (const params of request.reportCandidateNodes) {
              try {
                const html = await fetchTextWithTimeout(buildViewerUrl(params));
                period = extractPeriodFromHtml(html);
                if (period) break;
              } catch (_) {}
            }
          }

          if (!period) {
            const sourceParams = request.firstNode || request.docParams || null;
            if (sourceParams) {
              try {
                const url = buildViewerUrl(sourceParams);
                const html = await fetchTextWithTimeout(url);
                period = extractPeriodFromHtml(html);
              } catch (_) {}
            }
          }

          sendResponse({ success: true, companyName, period, docType });
        } catch (e) {
          sendResponse({
            success: false,
            errorCode: e.errorCode || ERROR_CODES.FETCH_FAILURE,
            error: e.message,
          });
        }
      })();
      return true;
    }

    if (request.action === "fetchNodeHTML") {
      const url = buildViewerUrl(request.nodeData);

      fetchTextWithTimeout(url)
        .then((html) => sendResponse({ success: true, html }))
        .catch((e) =>
          sendResponse({
            success: false,
            errorCode: e.errorCode || ERROR_CODES.FETCH_FAILURE,
            error: e.message,
          })
        );

      return true;
    }

    if (request.action === "fetchSinglePageHTML") {
      const startedAt = performance.now();
      Promise.resolve()
        .then(() => {
          const html = serializeCurrentDocument();
          logContentTiming("fetchSinglePageHTML.done", {
            elapsedMs: Math.round(performance.now() - startedAt),
            htmlLength: html.length,
          });
          sendResponse({ success: true, html });
        })
        .catch((e) =>
          sendResponse({
            success: false,
            errorCode: ERROR_CODES.DOCUMENT_ERROR_STATE,
            error: e.message,
          })
        );

      return true;
    }
  });

  function extractTreeDataViaInjection() {
    return new Promise((resolve, reject) => {
      pendingTreeResolve = resolve;
      pendingTreeStartedAt = performance.now();
      logContentTiming("inject.start", {});

      // 외부 스크립트 파일을 페이지 컨텍스트에 주입
      const script = document.createElement("script");
      script.src = chrome.runtime.getURL("inject.js");
      script.onload = () => script.remove();
      document.documentElement.appendChild(script);

      // 타임아웃 (5초)
      setTimeout(() => {
        if (pendingTreeResolve === resolve) {
          pendingTreeResolve = null;
          reject(new Error("트리 데이터 추출 시간 초과"));
        }
      }, 5000);
    });
  }
})();
