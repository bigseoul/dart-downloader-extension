// scripts/package.js - 크롬 웹스토어/배포용 zip 을 필수 파일만으로 만든다.
// 사용: npm run package  →  dist/dart-downloader-<manifest 버전>.zip
const fs = require("node:fs");
const path = require("node:path");
const JSZip = require("../lib/jszip.min.js");

const ROOT = path.resolve(__dirname, "..");
const FILES = [
  "manifest.json",
  "popup.html",
  "popup.css",
  "popup.js",
  "content.js",
  "inject.js",
  "html_converter.js",
  "section-splitter.js",
  "lib/jszip.min.js",
  "icons/icon16.png",
  "icons/icon48.png",
  "icons/icon128.png",
];

async function main() {
  const missing = FILES.filter((file) => !fs.existsSync(path.join(ROOT, file)));
  if (missing.length) {
    throw new Error(`필수 파일이 없습니다: ${missing.join(", ")}`);
  }

  const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
  const zip = new JSZip();
  for (const file of FILES) {
    // 고정 날짜를 넣어 같은 소스면 같은 zip 이 나오게 한다.
    zip.file(file, fs.readFileSync(path.join(ROOT, file)), { date: new Date("2000-01-01T00:00:00Z"), createFolders: false });
  }

  const outDir = path.join(ROOT, "dist");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `dart-downloader-${version}.zip`);
  const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  fs.writeFileSync(outPath, buffer);
  console.log(`${path.relative(ROOT, outPath)} (${FILES.length} files, ${buffer.length} bytes)`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
