// tests/converter-rules.test.js - 열 붕괴 방지와 원문 대조 검증 규칙을 확인한다.
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

test("'구분' 이 들어 있는 주석 한 칸 표는 본문이 '계정과목' 으로 바뀌지 않는다", () => {
  // 삼성전자 2025 사업보고서 VI. 주식사무 아래 주석 표에서 실제로 생긴 문제
  const { convert } = loadConverter();
  const lines = convert(
    '<table class="nb"><tr><td>※ 2019년 9월 16일 전자증권법 시행으로<br>\'주권의 종류\' 구분이 없어졌습니다.<br>※ 당사는 중앙일보에 공고합니다.</td></tr></table>'
  );
  const meta = lines.find((line) => line.startsWith("META:"));
  assert.match(meta, /2019년 9월 16일/);
  assert.match(meta, /구분이 없어졌습니다/);
  assert.equal(lines.some((line) => line.startsWith("WARN:")), false);
});

test("짧은 '구분' 열 이름은 기존대로 '계정과목' 으로 맞춘다", () => {
  const { convert } = loadConverter();
  const lines = convert(
    "<table><tr><th>구분</th><th>당기</th></tr><tr><td>매출채권</td><td>1,234</td></tr></table>"
  );
  assert.ok(lines.includes("ROW: 계정과목=매출채권 | 당기=1,234"));
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

test("숫자 없는 셀 문장이 빠져도 WARN 이 남는다", () => {
  const { convert, run } = loadConverter();
  run(`
    const __origText = _structuredLinesFromTable;
    _structuredLinesFromTable = (node, heading) =>
      __origText(node, heading).map((line) => line.replace("구분이 없어졌습니다", ""));
  `);
  const lines = convert(
    "<table><tr><th>구분</th><th>내용</th></tr><tr><td>주권</td><td>주권의 종류 구분이 없어졌습니다</td></tr></table>"
  );
  assert.match(lines.find((line) => line.startsWith("WARN:")), /셀 1개 누락: "주권의 종류 구분이 없어졌습니다"/);
});

test("같은 숫자가 두 칸에 있다가 하나만 빠져도 WARN 이 남는다", () => {
  const { convert, run } = loadConverter();
  run(`
    const __origDup = _structuredLinesFromTable;
    _structuredLinesFromTable = (node, heading) =>
      __origDup(node, heading).map((line) => line.replace(" | 전기=1,234", ""));
  `);
  const lines = convert(
    "<table><tr><th>구분</th><th>당기</th><th>전기</th></tr><tr><td>매출채권</td><td>1,234</td><td>1,234</td></tr></table>"
  );
  assert.match(lines.find((line) => line.startsWith("WARN:")), /숫자 1종 누락: 1,234/);
});

test("열 이름이 같은 별도 칸은 값이 같아도 모두 남는다", () => {
  // 삼성전자 별도 주석 차입금 표: 한국산업은행 차입금 두 건의 이자율이 모두 0.026
  const { convert } = loadConverter();
  const lines = convert(
    "<table><tr><th>구분</th><th>은행차입금</th><th>은행차입금</th></tr>" +
      "<tr><td>연이자율</td><td>0.026</td><td>0.026</td></tr>" +
      "<tr><td>장기차입금</td><td>2,000,000</td><td>800,000</td></tr></table>"
  );
  assert.ok(lines.includes("ROW: 계정과목=연이자율 | 은행차입금=0.026 / 0.026"));
  assert.ok(lines.includes("ROW: 계정과목=장기차입금 | 은행차입금=2,000,000 / 800,000"));
  assert.equal(lines.some((line) => line.startsWith("WARN:")), false);
});

test("colspan 으로 여러 칸을 덮은 값은 기존대로 한 번만 쓰고, 다른 열에는 그대로 남는다", () => {
  const { convert } = loadConverter();
  const merged = convert(
    '<table><tr><th>구분</th><th>은행차입금</th><th>은행차입금</th></tr><tr><td>만기일</td><td colspan="2">2030.12.10</td></tr></table>'
  );
  assert.ok(merged.includes("ROW: 계정과목=만기일 | 은행차입금=2030.12.10"));
  const spread = convert(
    '<table><tr><th>구분</th><th>당기</th><th>전기</th></tr><tr><td>차입금</td><td colspan="2">해당사항 없음</td></tr></table>'
  );
  assert.ok(spread.includes("ROW: 계정과목=차입금 | 당기=해당사항 없음 | 전기=해당사항 없음"));
});

test("열이 많아 GROUP 으로 나눌 때 공통 윗단 헤더를 META 로 남긴다", () => {
  const { convert } = loadConverter();
  const companies = Array.from({ length: 10 }, (_, index) => `회사${index + 1}`);
  const header = (group) => companies.map((name) => `<th>${name}</th>`).join("");
  const values = Array.from({ length: 20 }, (_, index) => `<td>${(index + 1) * 1000}</td>`).join("");
  const lines = convert(
    "<table>" +
      '<tr><th rowspan="4">구분</th><th colspan="20">공정가치로 측정하는 금융자산</th></tr>' +
      '<tr><th colspan="20">상장주식</th></tr>' +
      '<tr><th colspan="10">취득원가</th><th colspan="10">공정가치</th></tr>' +
      `<tr>${header("취득원가")}${header("공정가치")}</tr>` +
      `<tr><td>금융자산</td>${values}</tr></table>`
  );
  assert.ok(lines.includes("META: 공정가치로 측정하는 금융자산 / 상장주식"), lines.join("\n"));
  assert.ok(lines.includes("GROUP: 취득원가"));
  assert.equal(lines.some((line) => line.startsWith("WARN:")), false);
});

test("'구분(*1)' 처럼 각주가 붙은 열 이름은 각주를 남긴 채 '계정과목' 으로 맞춘다", () => {
  // 한국스탠다드차타드은행 2025 사업보고서 III. 재무에 관한 사항에서 실제로 나온 형태
  const { convert } = loadConverter();
  const lines = convert(
    "<table><tr><th>구분(*1)</th><th>당기말</th></tr><tr><td>원화예치금</td><td>1,000</td></tr></table>"
  );
  assert.ok(lines.includes("ROW: 계정과목(*1)=원화예치금 | 당기말=1,000"));
  assert.equal(lines.some((line) => line.startsWith("WARN:")), false);
});

test("'특수관계 구분' 같은 고유 열 이름은 그대로 둔다", () => {
  const { convert } = loadConverter();
  const lines = convert(
    "<table><tr><th>특수관계 구분</th><th>당기</th></tr><tr><td>지배기업</td><td>1,000</td></tr></table>"
  );
  assert.ok(lines.includes("ROW: 특수관계 구분=지배기업 | 당기=1,000"));
});

test("한 열짜리 긴 목록 표는 헤더 칸을 제목으로 남긴다", () => {
  // 한국스탠다드차타드은행 I. 회사의 개요 '목 적 사 업' 표
  const { convert } = loadConverter();
  const items = Array.from({ length: 25 }, (_, index) => `${index + 1}. 업무 항목 설명 ${index + 1}`).join("<br>");
  const lines = convert(`<table><tr><th>목 적 사 업</th></tr><tr><td>${items}</td></tr></table>`);
  assert.ok(lines.includes("META: 목 적 사 업"), lines.join("\n"));
  assert.equal(lines.some((line) => line.startsWith("WARN:")), false);
});
