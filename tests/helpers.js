// tests/helpers.js - 확장 스크립트를 jsdom 안에서 실제 브라우저처럼 로드한다.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { JSDOM } = require("jsdom");

const ROOT = path.resolve(__dirname, "..");

// window.eval 은 top-level let/const 를 eval 범위에 가두므로 classic script 처럼 실행한다.
function runScript(dom, source) {
  return vm.runInContext(source, dom.getInternalVMContext());
}

function readRoot(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

// popup.html 마크업 + html_converter.js + popup.js 를 한 window 에 로드한다.
// chrome API 는 호출 기록과 응답을 제어할 수 있는 스텁으로 대체한다.
// DOMContentLoaded 이후에 스크립트를 실행해 popup.js 의 자동 loadTreeData 가 돌지 않게 한다.
async function loadPopup({ popupSource = readRoot("popup.js"), fetchHtml }) {
  const markup = readRoot("popup.html").replace(/<script[\s\S]*?<\/script>/g, "");
  const dom = new JSDOM(markup, { runScripts: "outside-only" });
  const { window } = dom;
  if (window.document.readyState === "loading") {
    await new Promise((resolve) => window.addEventListener("DOMContentLoaded", resolve));
  }
  const downloads = [];
  const dialogs = [];

  window.chrome = {
    tabs: {
      query: async () => [{ id: 1, url: "https://dart.fss.or.kr/dsaf001/main.do" }],
      sendMessage: async (_tabId, message) => fetchHtml(message),
    },
    downloads: {
      download: async (options) => {
        downloads.push({ ...options, blob: blobsByUrl.get(options.url) });
      },
    },
  };
  const blobsByUrl = new Map();
  let blobCounter = 0;
  window.URL.createObjectURL = (blob) => {
    const url = `blob:test/${++blobCounter}`;
    blobsByUrl.set(url, blob);
    return url;
  };
  window.URL.revokeObjectURL = () => {};
  window.alert = (message) => dialogs.push({ type: "alert", message });
  window.confirm = (message) => {
    dialogs.push({ type: "confirm", message });
    return true;
  };

  runScript(dom, readRoot("html_converter.js"));
  runScript(dom, popupSource);
  return { window, run: (source) => runScript(dom, source), downloads, dialogs };
}

// content.js 를 DART 페이지 window 에 로드하고 onMessage 리스너를 돌려준다.
function loadContent({ contentSource = readRoot("content.js"), fetchResponse }) {
  // content.js 는 본문이 거의 없고 #ifrm 도 없으면 오류 페이지로 판단하므로 iframe 을 둔다.
  const dom = new JSDOM('<!DOCTYPE html><body><iframe id="ifrm"></iframe></body>', {
    url: "https://dart.fss.or.kr/dsaf001/main.do?rcpNo=1",
    runScripts: "outside-only",
  });
  const { window } = dom;
  let listener = null;
  window.chrome = {
    runtime: {
      getURL: (name) => name,
      onMessage: { addListener: (fn) => (listener = fn) },
    },
  };
  window.TextDecoder = TextDecoder;
  window.fetch = async () => fetchResponse();
  runScript(dom, contentSource);

  const send = (request) =>
    new Promise((resolve) => {
      listener(request, {}, resolve);
    });
  return { window, send };
}

module.exports = { ROOT, readRoot, runScript, loadPopup, loadContent };
