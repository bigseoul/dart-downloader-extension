// popup.js - 팝업 UI 로직

let treeData = [];
let selectedNodes = new Map(); // id -> nodeData
let docMeta = { companyName: "", period: "", docType: "" }; // 기수_회사명_문서유형
let singlePageDocParams = null;

document.addEventListener("DOMContentLoaded", async () => {
  const btnSelectAll = document.getElementById("btnSelectAll");
  const btnDeselectAll = document.getElementById("btnDeselectAll");
  const btnDownload = document.getElementById("btnDownload");

  btnSelectAll.addEventListener("click", () => toggleAll(true));
  btnDeselectAll.addEventListener("click", () => toggleAll(false));
  btnDownload.addEventListener("click", downloadSelected);

  document.getElementById("btnExpandAll").addEventListener("click", () => {
    document.querySelectorAll(".tree-children").forEach((el) => el.classList.remove("collapsed"));
    document.querySelectorAll(".tree-toggle:not(.no-children)").forEach((el) => el.classList.add("expanded"));
  });
  document.getElementById("btnCollapseAll").addEventListener("click", () => {
    document.querySelectorAll(".tree-children").forEach((el) => el.classList.add("collapsed"));
    document.querySelectorAll(".tree-toggle:not(.no-children)").forEach((el) => el.classList.remove("expanded"));
  });

  await loadTreeData();
});

// ─── 트리 데이터 로드 ───
async function loadTreeData() {
  const loading = document.getElementById("loading");
  const errorDiv = document.getElementById("error");
  const treeContainer = document.getElementById("treeContainer");

  try {
    selectedNodes.clear();
    treeData = [];
    singlePageDocParams = null;

    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });

    if (!tab || !tab.url.includes("dart.fss.or.kr/dsaf001/main.do")) {
      throw new Error("DART 공시 문서 페이지에서 실행해주세요.");
    }

    // 페이지 타이틀 표시
    document.getElementById("docTitle").textContent = tab.title || "";

    // content script에 메시지 전송
    const response = await chrome.tabs.sendMessage(tab.id, {
      action: "getTreeData",
    });

    if (!response || !response.success) {
      throw new Error(response?.error || "트리 데이터를 가져올 수 없습니다.");
    }

    let firstNode = response.data[0] || null;
    if (response.singlePage) {
      singlePageDocParams = response.docParams || null;
      const singlePageResponse = await chrome.tabs.sendMessage(tab.id, {
        action: "fetchSinglePageHTML",
        docParams: singlePageDocParams,
      });

      if (!singlePageResponse || !singlePageResponse.success) {
        throw new Error(singlePageResponse?.error || "단일 페이지 HTML을 가져올 수 없습니다.");
      }

      treeData = buildSinglePageTree(singlePageResponse.html);
      firstNode = null;
    } else {
      treeData = response.data;
    }

    // 기수, 회사명 메타 정보 가져오기 (첫 번째 노드의 HTML에서 기수 추출)
    try {
      const metaResponse = await chrome.tabs.sendMessage(tab.id, {
        action: "getDocMeta",
        firstNode: firstNode ? {
          rcpNo: firstNode.rcpNo,
          dcmNo: firstNode.dcmNo,
          eleId: firstNode.eleId,
          offset: firstNode.offset,
          length: firstNode.length,
          dtd: firstNode.dtd,
        } : null,
        docParams: singlePageDocParams,
      });
      if (metaResponse?.success) {
        docMeta.companyName = metaResponse.companyName;
        docMeta.period = metaResponse.period;
        docMeta.docType = metaResponse.docType;
      }
    } catch (_) {}

    loading.style.display = "none";
    treeContainer.style.display = "block";
    renderTree(treeData, treeContainer, 0);
  } catch (e) {
    loading.style.display = "none";
    errorDiv.style.display = "block";
    errorDiv.textContent = e.message;
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
  const count = document.getElementById("selectedCount");

  // 실제 다운로드 파일 수 (부모 선택 시 자식 제외한 중복 제거 수)
  const effectiveCount = getEffectiveNodes().length;
  count.textContent = effectiveCount;
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
  const effectiveNodes = getEffectiveNodes();
  if (effectiveNodes.length === 0) return;

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

  const zip = new JSZip();
  let completed = 0;
  let failed = 0;
  const usedNames = new Map(); // 파일명 중복 방지

  for (const node of effectiveNodes) {
    try {
      let html = node._singlePageHtml || "";
      let response = null;

      if (!html) {
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
        html = response?.html || "";
      }

      if (html && (!response || response.success)) {
        // 파일명에서 특수문자 제거
        let safeName = node.text
          .replace(/[\\/:*?"<>|]/g, "_")
          .replace(/\s+/g, " ")
          .trim();
        // 동일 파일명 충돌 시 인덱스 추가
        const count = usedNames.get(safeName) || 0;
        usedNames.set(safeName, count + 1);
        if (count > 0) {
          safeName = `${safeName} (${count + 1})`;
        }
        const filePrefix = [docMeta.period, docMeta.companyName, docMeta.docType]
          .filter(Boolean)
          .join("_");
        const fullName = filePrefix ? `${filePrefix}_${safeName}` : safeName;

        const downloadAsHtml = document.getElementById("chkDownloadHtml").checked;
        if (downloadAsHtml) {
          zip.file(`${fullName}.html`, html);
        } else {
          const txt = buildStructuredText(html, safeName);
          zip.file(`${fullName}.txt`, txt);
        }
      } else {
        // content script returned { success: false } — treat as failure
        console.warn(`Failed response for: ${node.text}`, response?.error);
        failed++;
      }
    } catch (e) {
      console.error(`Failed to fetch: ${node.text}`, e);
      failed++;
    }

    completed++;
    const pct = Math.round((completed / effectiveNodes.length) * 100);
    progressBar.style.width = `${pct}%`;
    progressText.textContent = `${completed} / ${effectiveNodes.length}`;
  }

  // ZIP 생성 및 다운로드
  if (failed === effectiveNodes.length) {
    alert("모든 섹션의 다운로드에 실패했습니다.");
    overlay.style.display = "none";
    return;
  }

  if (failed > 0) {
    const proceed = confirm(
      `${failed}개 섹션을 가져오지 못했습니다. 나머지 ${effectiveNodes.length - failed}개만 다운로드할까요?`
    );
    if (!proceed) {
      overlay.style.display = "none";
      return;
    }
  }

  let blobUrl = null;
  try {
    const blob = await zip.generateAsync({ type: "blob" });
    blobUrl = URL.createObjectURL(blob);

    // 기수_회사명_문서유형 접두사 생성
    const prefix = [docMeta.period, docMeta.companyName, docMeta.docType]
      .filter(Boolean)
      .join("_");
    const safePrefix = prefix.replace(/[\\/:*?"<>|]/g, "_").trim();
    const zipName = safePrefix || "dart_documents";

    await chrome.downloads.download({
      url: blobUrl,
      filename: `${zipName}.zip`,
      saveAs: true,
    });
  } catch (e) {
    console.error("ZIP 생성 실패:", e);
    alert("다운로드에 실패했습니다: " + e.message);
  } finally {
    if (blobUrl) URL.revokeObjectURL(blobUrl);
    overlay.style.display = "none";
  }
}
