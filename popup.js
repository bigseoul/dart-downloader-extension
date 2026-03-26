// popup.js - 팝업 UI 로직

let treeData = [];
let selectedNodes = new Map(); // id -> nodeData
let docMeta = { companyName: "", period: "", docType: "" }; // 기수_회사명_문서유형
let docMetaPromise = null;
let singlePageDocParams = null;
let singlePageUiMode = false;
let isLoadingState = false;
const OUTPUT_MODES = {
  AI_MERGED: "ai-merged",
  AI_ZIP: "ai-zip",
};
const DART_PAGE_PATTERN = /^https:\/\/dart[12]?\.fss\.or\.kr\/dsaf001\/main\.do/;
const POPUP_ERROR_MESSAGES = {
  HOST_INVALID: "호스트 비정상: 허용된 DART 호스트에서 실행해주세요.",
  DOCUMENT_ERROR_STATE: "페이지 로드 실패 상태: 문서가 정상적으로 로드되지 않았습니다.",
  TREE_DATA_UNAVAILABLE: "문서 목차를 읽지 못했습니다. 페이지를 새로고침한 뒤 다시 시도해주세요.",
  FETCH_FAILURE: "문서를 가져오지 못했습니다. 네트워크 상태를 확인해주세요.",
  FETCH_TIMEOUT: "문서 요청 시간이 초과되었습니다. 네트워크 상태를 확인해주세요.",
};

function logPopupTiming(step, detail) {
  console.info("[DART AI][popup]", step, detail || "");
}

function resolveErrorMessage(responseOrError) {
  if (responseOrError?.errorCode && POPUP_ERROR_MESSAGES[responseOrError.errorCode]) {
    return POPUP_ERROR_MESSAGES[responseOrError.errorCode];
  }
  return responseOrError?.error || responseOrError?.message || "알 수 없는 오류가 발생했습니다.";
}

function getSelectedOutputMode() {
  return (
    document.querySelector('input[name="outputMode"]:checked')?.value ||
    OUTPUT_MODES.AI_MERGED
  );
}

function sanitizeFilename(value) {
  return (value || "")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
}

function buildDownloadBaseName() {
  const prefix = [docMeta.period, docMeta.companyName, docMeta.docType]
    .filter(Boolean)
    .join("_");
  return sanitizeFilename(prefix) || "dart_documents";
}

function stripStructuredDocumentHeader(text) {
  return (text || "").replace(/^DOCUMENT:[^\n]*\n+/, "").trim();
}

function createSinglePageFullDocumentNode(html = "") {
  return {
    id: "sp-full-document",
    text: "전체 문서",
    children: [],
    mode: "singlePageFullDocument",
    _singlePageHtml: html,
  };
}

function buildMergedStructuredText(items, outputFileName) {
  const blocks = [`DOCUMENT: ${outputFileName}`, `ITEM_COUNT: ${items.length}`, ""];

  items.forEach((item, index) => {
    const structuredText = buildStructuredText(item.html, item.displayName);
    const body = stripStructuredDocumentHeader(structuredText);

    blocks.push(`===== ${item.displayName} =====`);
    if (body) {
      blocks.push(body);
    }
    if (index < items.length - 1) {
      blocks.push("", "");
    }
  });

  return `${blocks.join("\n").trim()}\n`;
}

function updateOutputModeUI() {
  const mode = singlePageUiMode ? OUTPUT_MODES.AI_MERGED : getSelectedOutputMode();
  const helper = document.getElementById("outputModeHelper");
  const label = document.getElementById("downloadLabel");

  if (helper && label) {
    if (singlePageUiMode) {
      helper.textContent = "문서 전체를 한 파일로 저장합니다.";
      label.textContent = "전체 저장";
    } else if (mode === OUTPUT_MODES.AI_MERGED) {
      helper.textContent = "선택한 내용을 텍스트 파일 하나로 저장합니다.";
      label.textContent = "합쳐 저장";
    } else {
      helper.textContent = "선택한 내용을 항목별 텍스트 파일로 나눠 ZIP에 저장합니다.";
      label.textContent = "따로 저장";
    }
  }

  updateDownloadButton();
}

function renderLayout() {
  const toolbar = document.getElementById("toolbar");
  const loading = document.getElementById("loading");
  const notice = document.getElementById("singlePageNotice");
  const treeContainer = document.getElementById("treeContainer");
  const modePanel = document.getElementById("modePanel");
  const bottomBar = document.getElementById("bottomBar");
  const errorDiv = document.getElementById("error");

  if (loading) {
    loading.style.display = isLoadingState ? "flex" : "none";
  }
  if (toolbar) {
    toolbar.style.display = !isLoadingState && !singlePageUiMode ? "flex" : "none";
  }
  if (treeContainer) {
    treeContainer.style.display = !isLoadingState && !singlePageUiMode ? "block" : "none";
  }
  if (modePanel) {
    modePanel.style.display = singlePageUiMode ? "none" : "flex";
  }
  if (notice) {
    notice.style.display = !isLoadingState && singlePageUiMode ? "flex" : "none";
  }
  if (bottomBar) {
    bottomBar.style.display = !isLoadingState || singlePageUiMode ? "flex" : "none";
  }
  if (errorDiv && isLoadingState) {
    errorDiv.style.display = "none";
  }
}

function setSinglePageUiMode(enabled) {
  singlePageUiMode = enabled;
  renderLayout();
}

function setLoadingUi(isLoading) {
  isLoadingState = isLoading;
  renderLayout();
  updateDownloadButton();
}

function normalizeNodeLabel(text) {
  return (text || "").replace(/\s+/g, "");
}

function isReportCandidateNode(node) {
  const label = normalizeNodeLabel(node?.text);
  if (!label) return false;
  if (label.includes("정정신고")) return false;
  return (
    label.includes("사업보고서") ||
    label.includes("반기보고서") ||
    label.includes("분기보고서")
  );
}

function buildFailureSummary(failedItems) {
  const freq = new Map();
  for (const item of failedItems) {
    freq.set(item.message, (freq.get(item.message) || 0) + 1);
  }
  let primaryMessage = failedItems[0]?.message || "";
  let maxCount = 0;
  for (const [msg, count] of freq) {
    if (count > maxCount) {
      maxCount = count;
      primaryMessage = msg;
    }
  }

  const names = failedItems.slice(0, 3).map((item) => item.name);
  const overflow = failedItems.length > 3 ? ` 외 ${failedItems.length - 3}개` : "";
  const detailsText = names.join(", ") + overflow;

  return { primaryMessage, detailsText };
}

document.addEventListener("DOMContentLoaded", async () => {
  const btnSelectAll = document.getElementById("btnSelectAll");
  const btnDeselectAll = document.getElementById("btnDeselectAll");
  const btnDownload = document.getElementById("btnDownload");
  const outputModeInputs = document.querySelectorAll('input[name="outputMode"]');

  btnSelectAll.addEventListener("click", () => toggleAll(true));
  btnDeselectAll.addEventListener("click", () => toggleAll(false));
  btnDownload.addEventListener("click", downloadSelected);
  outputModeInputs.forEach((input) => {
    input.addEventListener("change", updateOutputModeUI);
  });

  document.getElementById("btnExpandAll").addEventListener("click", () => {
    document.querySelectorAll(".tree-children").forEach((el) => el.classList.remove("collapsed"));
    document.querySelectorAll(".tree-toggle:not(.no-children)").forEach((el) => el.classList.add("expanded"));
  });
  document.getElementById("btnCollapseAll").addEventListener("click", () => {
    document.querySelectorAll(".tree-children").forEach((el) => el.classList.add("collapsed"));
    document.querySelectorAll(".tree-toggle:not(.no-children)").forEach((el) => el.classList.remove("expanded"));
  });

  updateOutputModeUI();
  await loadTreeData();
});

// ─── 트리 데이터 로드 ───
async function loadTreeData() {
  const errorDiv = document.getElementById("error");
  const treeContainer = document.getElementById("treeContainer");
  const startedAt = performance.now();

  try {
    selectedNodes.clear();
    treeData = [];
    singlePageDocParams = null;
    docMeta = { companyName: "", period: "", docType: "" };
    docMetaPromise = null;
    setSinglePageUiMode(false);
    setLoadingUi(true);
    treeContainer.innerHTML = "";

    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    logPopupTiming("tabs.query.done", {
      elapsedMs: Math.round(performance.now() - startedAt),
      url: tab?.url || "",
    });

    if (!tab || !DART_PAGE_PATTERN.test(tab.url || "")) {
      throw new Error("DART 문서 페이지가 아닙니다.");
    }

    // 페이지 타이틀 표시
    document.getElementById("docTitle").textContent = tab.title || "";

    // content script에 메시지 전송
    const response = await chrome.tabs.sendMessage(tab.id, {
      action: "getTreeData",
    });
    logPopupTiming("getTreeData.done", {
      elapsedMs: Math.round(performance.now() - startedAt),
      singlePage: Boolean(response?.singlePage),
    });

    if (!response || !response.success) {
      throw new Error(resolveErrorMessage(response));
    }

    const fetchDocMeta = async (firstNode, reportCandidateNodes = []) => {
      try {
        const metaResponse = await chrome.tabs.sendMessage(tab.id, {
          action: "getDocMeta",
          firstNode: firstNode
            ? {
              rcpNo: firstNode.rcpNo,
              dcmNo: firstNode.dcmNo,
              eleId: firstNode.eleId,
              offset: firstNode.offset,
              length: firstNode.length,
              dtd: firstNode.dtd,
            }
            : null,
          docParams: singlePageDocParams,
          reportCandidateNodes,
        });
        if (metaResponse?.success) {
          docMeta.companyName = metaResponse.companyName;
          docMeta.period = metaResponse.period;
          docMeta.docType = metaResponse.docType;
        }
      } catch (_) { }
    };

    let firstNode = response.data[0] || null;
    if (response.singlePage) {
      singlePageDocParams = response.docParams || null;
      setSinglePageUiMode(true);
      updateOutputModeUI();
      docMetaPromise = fetchDocMeta(null, []);
      const fullDocumentNode = createSinglePageFullDocumentNode();
      treeData = [fullDocumentNode];
      selectedNodes.set(fullDocumentNode.id, fullDocumentNode);
      firstNode = null;
      logPopupTiming("singlePage.ui.ready", {
        elapsedMs: Math.round(performance.now() - startedAt),
      });
    } else {
      treeData = response.data;
      const reportCandidateNodes = Array.isArray(treeData)
        ? treeData
          .filter((node) => node?.rcpNo && node?.dcmNo)
          .filter((node) => isReportCandidateNode(node))
          .slice(0, 3)
          .map((node) => ({
            rcpNo: node.rcpNo,
            dcmNo: node.dcmNo,
            eleId: node.eleId,
            offset: node.offset,
            length: node.length,
            dtd: node.dtd,
            text: node.text,
          }))
        : [];
      docMetaPromise = fetchDocMeta(firstNode, reportCandidateNodes);
      await docMetaPromise;
      logPopupTiming("tree.meta.ready", {
        elapsedMs: Math.round(performance.now() - startedAt),
        nodeCount: Array.isArray(treeData) ? treeData.length : 0,
      });
    }

    setLoadingUi(false);
    if (!singlePageUiMode) {
      renderTree(treeData, treeContainer, 0);
    }
    updateOutputModeUI();
    logPopupTiming("loadTreeData.done", {
      elapsedMs: Math.round(performance.now() - startedAt),
      singlePage: singlePageUiMode,
    });
  } catch (e) {
    setLoadingUi(false);
    document.getElementById("bottomBar").style.display = "none";
    errorDiv.style.display = "block";
    errorDiv.textContent = e.message;
    logPopupTiming("loadTreeData.error", {
      elapsedMs: Math.round(performance.now() - startedAt),
      message: e.message,
    });
  }
}

// ─── 트리 렌더링 ───
function renderTree(nodes, container, level) {
  nodes.forEach((node) => {
    const nodeEl = document.createElement("div");
    nodeEl.className = "tree-node";
    nodeEl.dataset.nodeId = node.id;

    const row = document.createElement("div");
    row.className = "tree-node-row";
    row.style.paddingLeft = `${8 + level * 20}px`;

    // 토글 버튼
    const toggle = document.createElement("span");
    toggle.className = `tree-toggle ${node.children.length > 0 ? "expanded" : "no-children"}`;
    toggle.textContent = "▶";
    toggle.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleExpand(nodeEl, toggle);
    });

    // 체크박스
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "tree-checkbox";
    checkbox.dataset.nodeId = node.id;
    checkbox.addEventListener("change", (e) => {
      e.stopPropagation();
      onCheckboxChange(node, checkbox.checked);
      // 하위 노드도 같이 체크/해제
      const childCheckboxes = nodeEl.querySelectorAll(
        ".tree-children .tree-checkbox"
      );
      childCheckboxes.forEach((cb) => {
        cb.checked = checkbox.checked;
        const childNode = findNodeById(treeData, cb.dataset.nodeId);
        if (childNode) onCheckboxChange(childNode, checkbox.checked);
      });
      updateParentCheckbox(nodeEl);
    });

    // 라벨
    const label = document.createElement("span");
    label.className = `tree-label level-${Math.min(level, 2)}`;
    label.textContent = node.text;
    label.addEventListener("click", () => {
      checkbox.checked = !checkbox.checked;
      checkbox.dispatchEvent(new Event("change"));
    });

    row.appendChild(toggle);
    row.appendChild(checkbox);
    row.appendChild(label);
    nodeEl.appendChild(row);

    // 자식 노드
    if (node.children.length > 0) {
      const childContainer = document.createElement("div");
      childContainer.className = "tree-children";
      renderTree(node.children, childContainer, level + 1);
      nodeEl.appendChild(childContainer);
    }

    container.appendChild(nodeEl);
  });
}

// ─── 토글 확장/축소 ───
function toggleExpand(nodeEl, toggleBtn) {
  const childContainer = nodeEl.querySelector(":scope > .tree-children");
  if (!childContainer) return;

  const isCollapsed = childContainer.classList.toggle("collapsed");
  toggleBtn.classList.toggle("expanded", !isCollapsed);
}

// ─── 체크박스 변경 ───
function onCheckboxChange(node, checked) {
  if (checked) {
    selectedNodes.set(node.id, node);
  } else {
    selectedNodes.delete(node.id);
  }
  updateDownloadButton();
}

// ─── 부모 체크박스 상태 업데이트 ───
function updateParentCheckbox(nodeEl) {
  const parent = nodeEl.parentElement?.closest?.(".tree-node");
  if (!parent) return;

  const parentCheckbox = parent.querySelector(
    ":scope > .tree-node-row > .tree-checkbox"
  );
  const childCheckboxes = parent.querySelectorAll(
    ":scope > .tree-children .tree-checkbox"
  );

  if (!parentCheckbox || childCheckboxes.length === 0) return;

  const allChecked = Array.from(childCheckboxes).every((cb) => cb.checked);
  const someChecked = Array.from(childCheckboxes).some((cb) => cb.checked);

  parentCheckbox.checked = allChecked;
  parentCheckbox.indeterminate = someChecked && !allChecked;

  // selectedNodes Map도 동기화
  const parentNode = findNodeById(treeData, parentCheckbox.dataset.nodeId);
  if (parentNode) {
    if (allChecked) {
      selectedNodes.set(parentNode.id, parentNode);
    } else {
      selectedNodes.delete(parentNode.id);
    }
  }
  updateDownloadButton();

  // 재귀적으로 상위도 업데이트
  updateParentCheckbox(parent);
}

// ─── 전체 선택/해제 ───
function toggleAll(checked) {
  const checkboxes = document.querySelectorAll(".tree-checkbox");
  checkboxes.forEach((cb) => {
    cb.checked = checked;
    cb.indeterminate = false;
    const node = findNodeById(treeData, cb.dataset.nodeId);
    if (node) onCheckboxChange(node, checked);
  });
}

// ─── 다운로드 버튼 상태 업데이트 ───
function updateDownloadButton() {
  const btn = document.getElementById("btnDownload");
  if (isLoadingState) {
    btn.disabled = true;
    return;
  }
  const effectiveCount = singlePageUiMode ? 1 : getEffectiveNodes().length;
  btn.disabled = effectiveCount === 0;
}

// ─── 실제 다운로드할 노드 목록 (중복 제거) ───
function getEffectiveNodes() {
  const selected = Array.from(selectedNodes.values());
  const fullDocumentNode = selected.find(
    (node) => node.mode === "singlePageFullDocument"
  );

  if (fullDocumentNode) {
    return [fullDocumentNode];
  }

  // 부모 노드가 선택되어 있으면, 그 하위 자식 노드는 제외
  return selected.filter((node) => {
    // 이 노드의 부모가 selectedNodes에 있는지 확인
    return !hasSelectedAncestor(node.id);
  });
}

function collectLeafNodes(node, leaves = []) {
  if (!node || !Array.isArray(node.children) || node.children.length === 0) {
    if (node) {
      leaves.push(node);
    }
    return leaves;
  }

  node.children.forEach((child) => collectLeafNodes(child, leaves));
  return leaves;
}

function getDownloadNodesForMode(mode) {
  const effectiveNodes = getEffectiveNodes();

  if (mode === OUTPUT_MODES.AI_MERGED) {
    return effectiveNodes;
  }

  const expandedNodes = [];
  const seenIds = new Set();

  effectiveNodes.forEach((node) => {
    if (node.mode === "singlePageFullDocument") {
      if (!seenIds.has(node.id)) {
        seenIds.add(node.id);
        expandedNodes.push(node);
      }
      return;
    }

    const leaves = collectLeafNodes(node);
    leaves.forEach((leafNode) => {
      if (seenIds.has(leafNode.id)) {
        return;
      }
      seenIds.add(leafNode.id);
      expandedNodes.push(leafNode);
    });
  });

  return expandedNodes;
}

function hasSelectedAncestor(nodeId) {
  // 트리에서 이 노드의 부모를 찾아 올라가기
  const parent = findParentNode(treeData, nodeId, null);
  if (!parent) return false;
  if (selectedNodes.has(parent.id)) return true;
  return hasSelectedAncestor(parent.id);
}

function findParentNode(nodes, targetId, parent) {
  for (const node of nodes) {
    if (node.id === targetId) return parent;
    if (node.children.length > 0) {
      const found = findParentNode(node.children, targetId, node);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

function findNodeById(nodes, id) {
  for (const node of nodes) {
    if (node.id === id) return node;
    if (node.children.length > 0) {
      const found = findNodeById(node.children, id);
      if (found) return found;
    }
  }
  return null;
}

// ─── 다운로드 실행 ───
async function downloadSelected() {
  const outputMode = singlePageUiMode ? OUTPUT_MODES.AI_MERGED : getSelectedOutputMode();
  const effectiveNodes = getDownloadNodesForMode(outputMode);
  if (effectiveNodes.length === 0) return;
  const startedAt = performance.now();

  const overlay = document.getElementById("progressOverlay");
  const progressBar = document.getElementById("progressBar");
  const progressText = document.getElementById("progressText");

  overlay.style.display = "flex";
  progressBar.style.width = "0%";
  progressText.textContent = `0 / ${effectiveNodes.length}`;

  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });

  let completed = 0;
  const failedItems = [];
  const usedNames = new Map();
  const successfulItems = [];

  for (const node of effectiveNodes) {
    try {
      let html = node._singlePageHtml || "";
      let response = null;

      if (!html) {
        if (node.mode === "singlePageFullDocument") {
          const fetchStartedAt = performance.now();
          response = await chrome.tabs.sendMessage(tab.id, {
            action: "fetchSinglePageHTML",
            docParams: singlePageDocParams,
          });
          logPopupTiming("fetchSinglePageHTML.done", {
            elapsedMs: Math.round(performance.now() - fetchStartedAt),
          });
        } else {
          response = await chrome.tabs.sendMessage(tab.id, {
            action: "fetchNodeHTML",
            nodeData: {
              rcpNo: node.rcpNo,
              dcmNo: node.dcmNo,
              eleId: node.eleId,
              offset: node.offset,
              length: node.length,
              dtd: node.dtd,
            },
          });
        }
        html = response?.html || "";
        if (html && node.mode === "singlePageFullDocument") {
          node._singlePageHtml = html;
        }
      }

      if (html && (!response || response.success)) {
        const displayName = (node.text || "").replace(/\s+/g, " ").trim() || "untitled";
        let safeName = sanitizeFilename(displayName) || "untitled";
        const count = usedNames.get(safeName) || 0;
        usedNames.set(safeName, count + 1);
        if (count > 0) {
          safeName = `${safeName} (${count + 1})`;
        }
        successfulItems.push({ displayName, safeName, html });
      } else {
        console.warn(`Failed response for: ${node.text}`, resolveErrorMessage(response));
        failedItems.push({
          name: node.text,
          errorCode: response?.errorCode || "UNKNOWN",
          message: resolveErrorMessage(response),
        });
      }
    } catch (e) {
      console.error(`Failed to fetch: ${node.text}`, e);
      failedItems.push({
        name: node.text,
        errorCode: e.errorCode || "UNKNOWN",
        message: resolveErrorMessage(e),
      });
    }

    completed++;
    const pct = Math.round((completed / effectiveNodes.length) * 100);
    progressBar.style.width = `${pct}%`;
    progressText.textContent = `${completed} / ${effectiveNodes.length}`;
  }

  if (failedItems.length === effectiveNodes.length) {
    const { primaryMessage, detailsText } = buildFailureSummary(failedItems);
    alert(`모든 섹션의 다운로드에 실패했습니다.\n${primaryMessage}\n\n실패 항목: ${detailsText}`);
    overlay.style.display = "none";
    return;
  }

  if (failedItems.length > 0) {
    const { primaryMessage } = buildFailureSummary(failedItems);
    const proceed = confirm(
      `${failedItems.length}개 섹션을 가져오지 못했습니다.\n${primaryMessage}\n\n나머지 ${effectiveNodes.length - failedItems.length}개만 다운로드할까요?`
    );
    if (!proceed) {
      overlay.style.display = "none";
      return;
    }
  }

  let blobUrl = null;
  try {
    if (docMetaPromise) {
      await docMetaPromise;
    }
    const baseName = buildDownloadBaseName();

    if (outputMode === OUTPUT_MODES.AI_MERGED) {
      const fileName = `${baseName}.txt`;
      const mergedText = buildMergedStructuredText(successfulItems, fileName);
      const blob = new Blob([mergedText], { type: "text/plain;charset=utf-8" });
      blobUrl = URL.createObjectURL(blob);
      await chrome.downloads.download({
        url: blobUrl,
        filename: fileName,
        saveAs: true,
      });
    } else {
      const zip = new JSZip();

      successfulItems.forEach((item) => {
        const fullName = `${baseName}_${item.safeName}`;
        const txt = buildStructuredText(item.html, item.displayName);
        zip.file(`${fullName}.txt`, txt);
      });

      const blob = await zip.generateAsync({ type: "blob" });
      blobUrl = URL.createObjectURL(blob);

      await chrome.downloads.download({
        url: blobUrl,
        filename: `${baseName}.zip`,
        saveAs: true,
      });
    }
    logPopupTiming("downloadSelected.done", {
      elapsedMs: Math.round(performance.now() - startedAt),
      mode: outputMode,
      itemCount: successfulItems.length,
    });
  } catch (e) {
    console.error("다운로드 파일 생성 실패:", e);
    alert("다운로드에 실패했습니다: " + e.message);
  } finally {
    if (blobUrl) URL.revokeObjectURL(blobUrl);
    overlay.style.display = "none";
  }
}
