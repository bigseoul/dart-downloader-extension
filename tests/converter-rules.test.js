// tests/converter-rules.test.js - 열 붕괴 방지와 원문 숫자 대조 검증 규칙을 확인한다.
const test = require("node:test");
const assert = require("node:assert/strict");
const { JSDOM } = require("jsdom");
const { readRoot, runScript } = require("./helpers");

function loadConverter() {
  const dom = new JSDOM("", { runScripts: "outside-only" });
  runScript(dom, readRoot("html_converter.js"));
  return {
    convert: (tableHtml) =>
      dom.window
        .buildStructuredText(`<body><p class="section-2">표</p>${tableHtml}</body>`, "x")
        .split("\n")
        .slice(2),
    run: (source) => runScript(dom, source),
  };
}

test("TD 로 쓴 헤더 + 데이터 1행 표는 열 이름과 값이 짝지어진다", () => {
  const { convert } = loadConverter();
  const lines = convert(
    "<table><tr><td>회사명</td><td>지분율</td><td>장부금액</td></tr>" +
      "<tr><td>삼성디스플레이㈜</td><td>84.8%</td><td>18,472,623</td></tr></table>"
  );
  assert.ok(lines.includes("HEADER: 회사명 | 지분율 | 장부금액"));
  assert.ok(lines.includes("ROW: 회사명=삼성디스플레이㈜ | 지분율=84.8% | 장부금액=18,472,623"));
  assert.equal(lines.some((line) => line.startsWith("META:")), false);
});

test("헤더 없는 숫자 2행 표는 META 로 납작해지지 않고 ROW 로 남는다", () => {
  const { convert } = loadConverter();
  const lines = convert(
    "<table><tr><td>매출채권</td><td>1,234</td><td>5,678</td></tr>" +
      "<tr><td>미수금</td><td>(90)</td><td>120</td></tr></table>"
  );
  assert.equal(lines.filter((line) => line.startsWith("ROW:")).length, 2);
  assert.equal(lines.some((line) => line.startsWith("META:")), false);
});

test("단위·기준일 같은 진짜 메타 표는 그대로 META 로 남는다", () => {
  const { convert } = loadConverter();
  assert.ok(convert("<table><tr><td>(단위 : 백만원)</td><td></td></tr></table>").includes("META: (단위 : 백만원)"));
  assert.ok(
    convert(
      "<table><tr><td>(기준일 :</td><td>2025년 12월 31일</td><td>)</td><td>(단위 : 백만원, 천주, %)</td></tr></table>"
    ).includes("META: (기준일 : | 2025년 12월 31일 | ) | (단위 : 백만원, 천주, %)")
  );
});

test("변환 결과에서 원문 숫자가 빠지면 WARN 줄을 남긴다", () => {
  const { convert, run } = loadConverter();
  // 마지막 ROW 를 버리는 결함을 주입한다.
  run(`
    const __orig = _structuredLinesFromTable;
    _structuredLinesFromTable = (node, heading) => __orig(node, heading).slice(0, -1);
  `);
  const lines = convert(
    "<table><tr><th>구분</th><th>당기</th></tr><tr><td>매출채권</td><td>1,234</td></tr>" +
      "<tr><td>미수금</td><td>5,678</td></tr></table>"
  );
  const warn = lines.find((line) => line.startsWith("WARN:"));
  assert.ok(warn, "누락 경고가 있어야 한다");
  assert.match(warn, /5,678/);
  assert.doesNotMatch(warn, /1,234/);
});

test("변환이 원문 숫자를 모두 담으면 WARN 이 없다", () => {
  const { convert } = loadConverter();
  const lines = convert(
    "<table><tr><th>구분</th><th>당기</th><th>전기</th></tr>" +
      "<tr><td>매출채권</td><td>1,234</td><td>1,234</td></tr></table>"
  );
  assert.equal(lines.some((line) => line.startsWith("WARN:")), false);
});
