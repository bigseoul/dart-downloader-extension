// content.js - DART 페이지에서 jstree 노드 데이터를 추출하는 content script

(function () {
  let pendingTreeResolve = null;

  // 페이지 컨텍스트에서 전달된 메시지 수신
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;

    if (event.data?.type === "DART_TREE_DATA") {
      if (pendingTreeResolve) {
        pendingTreeResolve(event.data);
        pendingTreeResolve = null;
      }
    }
  });

  // 메시지 리스너: popup.js에서 요청이 오면 트리 데이터 반환
  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    if (request.action === "getTreeData") {
      extractTreeDataViaInjection()
        .then((result) => sendResponse(result))
        .catch((e) => sendResponse({ success: false, error: e.message }));
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

          // 첫 번째 노드의 viewer.do HTML에서 기수 추출
          let period = "";
          if (request.firstNode) {
            try {
              const { rcpNo, dcmNo, eleId, offset, length, dtd } = request.firstNode;
              const url = `/report/viewer.do?rcpNo=${rcpNo}&dcmNo=${dcmNo}&eleId=${eleId}&offset=${offset}&length=${length}&dtd=${dtd}`;
              const resp = await fetch(url);
              const html = await resp.text();
              const match = html.match(/제\s*(\d+)\s*기/);
              if (match) period = match[1] + "기";
            } catch (_) {}
          }

          sendResponse({ success: true, companyName, period, docType });
        } catch (e) {
          sendResponse({ success: false, error: e.message });
        }
      })();
      return true;
    }

    if (request.action === "fetchNodeHTML") {
      const { rcpNo, dcmNo, eleId, offset, length, dtd } = request.nodeData;
      const url = `/report/viewer.do?rcpNo=${rcpNo}&dcmNo=${dcmNo}&eleId=${eleId}&offset=${offset}&length=${length}&dtd=${dtd}`;

      fetch(url)
        .then((r) => r.text())
        .then((html) => sendResponse({ success: true, html }))
        .catch((e) => sendResponse({ success: false, error: e.message }));

      return true;
    }
  });

  function extractTreeDataViaInjection() {
    return new Promise((resolve, reject) => {
      pendingTreeResolve = resolve;

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
