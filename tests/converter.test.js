// tests/converter.test.js - html_converter.js 출력이 고정 정답과 같은지 확인한다.
// 의도적으로 출력을 바꿨다면 `UPDATE_GOLDEN=1 npm test` 로 정답을 다시 만든다.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const { readRoot } = require("./helpers");

const FIXTURE_DIR = path.join(__dirname, "fixtures");
const UPDATE = process.env.UPDATE_GOLDEN === "1";

const { window } = new JSDOM("", { runScripts: "outside-only" });
window.eval(readRoot("html_converter.js"));

const fixtures = fs.readdirSync(FIXTURE_DIR).filter((name) => name.endsWith(".html"));

test("fixture 가 하나 이상 있다", () => {
  assert.ok(fixtures.length > 0);
});

for (const name of fixtures) {
  test(`structured text 정답 일치: ${name}`, () => {
    const html = fs.readFileSync(path.join(FIXTURE_DIR, name), "utf8");
    const actual = window.buildStructuredText(html, name);
    const goldenPath = path.join(FIXTURE_DIR, name.replace(/\.html$/, ".expected.txt"));

    if (UPDATE || !fs.existsSync(goldenPath)) {
      fs.writeFileSync(goldenPath, actual);
      if (!UPDATE) {
        assert.fail(`정답 파일이 없어 새로 만들었습니다. 내용을 검토하세요: ${goldenPath}`);
      }
      return;
    }

    assert.equal(actual, fs.readFileSync(goldenPath, "utf8"));
  });
}
