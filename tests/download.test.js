// tests/download.test.js - 다운로드 흐름의 실패 격리와 원문 계약 검사를 확인한다.
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadPopup, loadContent } = require("./helpers");

const GOOD_HTML = "<html><body><p class='section-2'>1. 개요</p><p>정상 본문</p></body></html>";
const BROKEN_HTML = "<html><body><p>변환 실패를 일으키는 본문</p></body></html>";

// jsdom Blob 에는 text() 가 없어서 FileReader 로 읽는다.
function readBlobText(window, blob) {
  return new Promise((resolve, reject) => {
    const reader = new window.FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

function selectNodes({ window, run }, nodes) {
  run(`treeData = ${JSON.stringify(nodes)};`);
  run("selectedNodes.clear(); treeData.forEach((n) => selectedNodes.set(n.id, n));");
  window.document.querySelector('input[name="outputMode"][value="ai-merged"]').checked = true;
}

function makeNodes() {
  return ["good-a", "broken", "good-b"].map((id) => ({
    id,
    text: id,
    children: [],
    rcpNo: "1",
    dcmNo: "1",
    eleId: id,
  }));
}

function fetchByEleId(message) {
  const html = message.nodeData.eleId === "broken" ? BROKEN_HTML : GOOD_HTML;
  return { success: true, html };
}

function breakConverterFor({ run }, marker) {
  run(`
    const originalBuildStructuredText = buildStructuredText;
    buildStructuredText = (html, name) => {
      if (html.includes(${JSON.stringify(marker)})) throw new Error("converter exploded");
      return originalBuildStructuredText(html, name);
    };
  `);
}

test("한 항목 변환이 실패해도 나머지는 합쳐 저장된다", async () => {
  const popup = await loadPopup({ fetchHtml: fetchByEleId });
  const { downloads, dialogs } = popup;
  breakConverterFor(popup, "변환 실패를 일으키는");
  selectNodes(popup, makeNodes());

  await popup.run("downloadSelected()");

  assert.equal(downloads.length, 1, "부분 성공 결과가 저장되어야 한다");
  const text = await readBlobText(popup.window, downloads[0].blob);
  assert.match(text, /ITEM_COUNT: 2/);
  assert.match(text, /===== good-a =====/);
  assert.match(text, /===== good-b =====/);
  assert.doesNotMatch(text, /===== broken =====/);

  const confirmDialog = dialogs.find((d) => d.type === "confirm");
  assert.ok(confirmDialog, "실패 항목을 사용자에게 알려야 한다");
  assert.match(confirmDialog.message, /1개 섹션을 가져오지 못했습니다/);
  assert.match(confirmDialog.message, /텍스트로 변환하지 못했습니다/);
  assert.equal(dialogs.some((d) => d.type === "alert"), false);
});

test("저장 파일의 각 섹션에 DART 원문 SOURCE 주소가 붙는다", async () => {
  const popup = await loadPopup({ fetchHtml: fetchByEleId });
  selectNodes(popup, makeNodes().filter((node) => node.id !== "broken"));

  await popup.run("downloadSelected()");

  const text = await readBlobText(popup.window, popup.downloads[0].blob);
  assert.match(
    text,
    /===== good-a =====\nSOURCE: https:\/\/dart1\.fss\.or\.kr\/report\/viewer\.do\?rcpNo=1&dcmNo=1&eleId=good-a&offset=0&length=0&dtd=HTML\n/
  );
  assert.match(text, /===== good-b =====\nSOURCE: .*eleId=good-b/);
});

test("원문 내용 누락 경고가 있으면 저장 후 사용자에게 알린다", async () => {
  const popup = await loadPopup({ fetchHtml: fetchByEleId });
  popup.run(`
    const __origConvert = buildStructuredText;
    buildStructuredText = (html, name) => __origConvert(html, name) + "WARN: 테스트 경고\\n";
  `);
  selectNodes(popup, makeNodes().filter((node) => node.id !== "broken"));

  await popup.run("downloadSelected()");

  assert.equal(popup.downloads.length, 1);
  const alertDialog = popup.dialogs.find((d) => d.type === "alert");
  assert.ok(alertDialog);
  assert.match(alertDialog.message, /표 2개에서 원문 내용이/);
});

test("빈 본문 응답은 DOCUMENT_EMPTY 실패로 돌려준다", async () => {
  const { send } = loadContent({
    fetchResponse: () =>
      new Response("<html><head><script>var x=1;</script></head><body>  </body></html>", {
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
  });

  const response = await send({ action: "fetchNodeHTML", nodeData: { rcpNo: "1", dcmNo: "1" } });

  assert.equal(response.success, false);
  assert.equal(response.errorCode, "DOCUMENT_EMPTY");
});

test("본문이 있는 응답은 그대로 성공으로 돌려준다", async () => {
  const { send } = loadContent({
    fetchResponse: () =>
      new Response(GOOD_HTML, { headers: { "content-type": "text/html; charset=utf-8" } }),
  });

  const response = await send({ action: "fetchNodeHTML", nodeData: { rcpNo: "1", dcmNo: "1" } });

  assert.equal(response.success, true);
  assert.equal(response.html, GOOD_HTML);
});

test("텍스트 없이 표만 있는 응답도 성공으로 본다", async () => {
  const html = "<html><body><table><tr><td></td></tr></table></body></html>";
  const { send } = loadContent({
    fetchResponse: () => new Response(html, { headers: { "content-type": "text/html" } }),
  });

  const response = await send({ action: "fetchNodeHTML", nodeData: { rcpNo: "1", dcmNo: "1" } });

  assert.equal(response.success, true);
});
