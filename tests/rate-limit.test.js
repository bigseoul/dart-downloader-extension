// tests/rate-limit.test.js - DART 요청 간격과 차단 징후 시 즉시 중단을 확인한다.
// 라이브 DART 호출은 하지 않는다. fetch 와 chrome API 는 모두 스텁이다.
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadPopup, loadContent } = require("./helpers");

const HTML = "<html><body><p>정상 본문</p></body></html>";
const ok = () => new Response(HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
const nodeRequest = (eleId) => ({ action: "fetchNodeHTML", nodeData: { rcpNo: "1", dcmNo: "1", eleId } });

function networkError() {
  // 크롬 fetch 는 연결이 끊기면 TypeError("Failed to fetch") 를 던진다.
  throw new TypeError("Failed to fetch");
}

test("동시에 요청해도 viewer 요청 시작 간격은 0.5초 이상이다", async () => {
  const { send, requests } = loadContent({ fetchResponse: ok });

  const responses = await Promise.all([send(nodeRequest("1")), send(nodeRequest("2")), send(nodeRequest("3"))]);

  assert.ok(responses.every((response) => response.success));
  assert.equal(requests.length, 3);
  for (let index = 1; index < requests.length; index += 1) {
    const gap = requests[index].at - requests[index - 1].at;
    assert.ok(gap >= 490, `요청 ${index} 와 ${index + 1} 사이 간격이 ${gap}ms 입니다`);
  }
});

test("연결이 끊기는 네트워크 오류는 RATE_LIMITED 로 돌려준다", async () => {
  const { send } = loadContent({ fetchResponse: networkError });

  const response = await send(nodeRequest("1"));

  assert.equal(response.success, false);
  assert.equal(response.errorCode, "RATE_LIMITED");
});

for (const status of [429, 503]) {
  test(`HTTP ${status} 은 RATE_LIMITED 로 돌려준다`, async () => {
    const { send } = loadContent({ fetchResponse: () => new Response("", { status }) });

    const response = await send(nodeRequest("1"));

    assert.equal(response.errorCode, "RATE_LIMITED");
  });
}

test("다른 HTTP 오류는 기존대로 FETCH_FAILURE 다", async () => {
  const { send } = loadContent({ fetchResponse: () => new Response("", { status: 500 }) });

  const response = await send(nodeRequest("1"));

  assert.equal(response.errorCode, "FETCH_FAILURE");
});

test("기수 추출 중 차단 징후가 보이면 남은 후보는 요청하지 않는다", async () => {
  const { send, requests } = loadContent({ fetchResponse: networkError });
  const params = { rcpNo: "1", dcmNo: "1", eleId: "1" };

  const response = await send({
    action: "getDocMeta",
    reportCandidateNodes: [params, { ...params, eleId: "2" }, { ...params, eleId: "3" }],
    firstNode: { ...params, eleId: "4" },
  });

  assert.equal(response.success, true, "메타 실패는 다운로드를 막지 않는다");
  assert.equal(requests.length, 1);
});

function makeNodes(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `n${index + 1}`,
    text: `n${index + 1}`,
    children: [],
    rcpNo: "1",
    dcmNo: "1",
    eleId: `n${index + 1}`,
  }));
}

async function startPopup(fetchHtml, count) {
  const popup = await loadPopup({ fetchHtml });
  popup.run(`treeData = ${JSON.stringify(makeNodes(count))};`);
  popup.run("selectedNodes.clear(); treeData.forEach((n) => selectedNodes.set(n.id, n));");
  popup.window.document.querySelector('input[name="outputMode"][value="ai-merged"]').checked = true;
  return popup;
}

const rateLimitedFrom = (eleId) => (message) =>
  message.nodeData.eleId === eleId
    ? { success: false, errorCode: "RATE_LIMITED", error: "DART 가 요청을 제한했습니다." }
    : { success: true, html: HTML };

test("차단되면 남은 섹션은 요청하지 않고, 받은 것만 저장할지 묻는다", async () => {
  const popup = await startPopup(rateLimitedFrom("n2"), 5);

  await popup.run("downloadSelected()");

  assert.equal(popup.messages.length, 2, "n3~n5 는 요청하지 않아야 한다");
  const confirmDialog = popup.dialogs.find((dialog) => dialog.type === "confirm");
  assert.match(confirmDialog.message, /DART가 요청을 제한했습니다/);
  assert.match(confirmDialog.message, /받지 못한 섹션: 4개/);
  assert.match(confirmDialog.message, /이미 받은 1개만 저장할까요/);
  assert.equal(popup.downloads.length, 1);
});

test("첫 요청부터 차단되면 저장하지 않고 알린다", async () => {
  const popup = await startPopup(rateLimitedFrom("n1"), 3);

  await popup.run("downloadSelected()");

  assert.equal(popup.messages.length, 1);
  assert.equal(popup.downloads.length, 0);
  const alertDialog = popup.dialogs.find((dialog) => dialog.type === "alert");
  assert.match(alertDialog.message, /1시간쯤 뒤에 다시 시도해주세요/);
  assert.match(alertDialog.message, /받지 못한 섹션: 3개/);
});

test("진행 표시에 남은 시간이 나오고, 끝나면 사라진다", async () => {
  const popup = await startPopup(() => ({ success: true, html: HTML }), 4);

  await popup.run("downloadSelected()");

  assert.equal(popup.messages[0].progressText, "0 / 4");
  assert.match(popup.messages[2].progressText, /^2 \/ 4 · 약 \d+초 남음$/);
  assert.equal(popup.window.document.getElementById("progressText").textContent, "4 / 4");
});

test("남은 시간은 지금까지의 평균 속도로 계산한다", async () => {
  const { run } = await loadPopup({ fetchHtml: () => ({ success: true, html: HTML }) });

  assert.equal(run("formatProgressText(10, 65, 10500)"), "10 / 65 · 약 58초 남음");
  assert.equal(run("formatProgressText(0, 65, 0)"), "0 / 65");
  assert.equal(run("formatProgressText(65, 65, 70000)"), "65 / 65");
});
