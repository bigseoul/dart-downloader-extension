# 방어 코딩 개선: 호스트 가드, 에러 상태 조기 중단, 에러 메시지 세분화

## Context

이전 분석에서 이 확장이 "Unsafe attempt to load URL ... from frame with URL chrome-error://chromewebdata/" 에러의 직접 원인이 아님을 확인함. 그러나 페이지가 비정상 상태에 빠진 후 후행 실패 경로를 방지하고, 에러 원인 추적을 용이하게 하기 위한 방어 코딩 개선을 수행.

## 수정 파일

- `content.js` — 호스트 가드, 에러 상태 감지, URL 명확화, 에러 코드 분류
- `popup.js` — 에러 메시지 세분화, dart1/dart2 URL 패턴 지원
- `manifest.json` — dart1/dart2 매치 패턴 추가

---

## Step 1: content.js — 상수 및 유틸리티 추가 (line 5-6 뒤)

### 1a. 에러 코드 상수

```js
const ERROR_CODES = {
  HOST_INVALID: "HOST_INVALID",
  DOCUMENT_ERROR_STATE: "DOCUMENT_ERROR_STATE",
  IFRAME_ACCESS_FAILURE: "IFRAME_ACCESS_FAILURE",
  FETCH_FAILURE: "FETCH_FAILURE",
  FETCH_TIMEOUT: "FETCH_TIMEOUT",
};

const ERROR_MESSAGES = {
  HOST_INVALID: "호스트 비정상: 허용된 DART 호스트가 아닙니다.",
  DOCUMENT_ERROR_STATE: "페이지 로드 실패 상태: 문서가 비정상입니다.",
  IFRAME_ACCESS_FAILURE: "iframe 접근 실패: 문서 콘텐츠를 읽을 수 없습니다.",
  FETCH_FAILURE: "후속 문서 fetch 실패: 문서를 가져오지 못했습니다.",
  FETCH_TIMEOUT: "문서 요청 시간이 초과되었습니다.",
};
```

### 1b. 허용 호스트 목록 및 검증 함수

```js
const ALLOWED_HOSTS = ["dart.fss.or.kr", "dart1.fss.or.kr", "dart2.fss.or.kr"];

function isAllowedHost() {
  return ALLOWED_HOSTS.includes(window.location.hostname);
}
```

### 1c. 문서 에러 상태 감지 함수

`normalizeTextContent()` (line 95) 뒤에 배치:

```js
function isDocumentInErrorState() {
  const bodyText = normalizeTextContent(document.body?.textContent);
  if (bodyText.length < 20 && !document.getElementById("ifrm")) {
    return true;
  }
  return false;
}
```

**설계 근거**: body 텍스트가 20자 미만이고 iframe도 없으면 정상 DART 페이지가 아님. 20자 기준은 `getSinglePageSourceDocument()` (line 85)의 기존 기준과 동일. 특정 에러 문구 매칭은 오탐(false positive) 위험이 있으므로 사용하지 않음.

### 1d. 에러 응답 헬퍼

```js
function makeErrorResponse(errorCode) {
  return { success: false, errorCode, error: ERROR_MESSAGES[errorCode] || errorCode };
}
```

---

## Step 2: content.js — `buildViewerUrl()` origin 명확화 (line 19-29)

**현재**: `return \`/report/viewer.do?${query}\``
**변경**: `return \`${window.location.origin}/report/viewer.do?${query}\``

호스트를 하드코딩하지 않음. 현재 페이지의 실제 origin을 사용하므로 dart/dart1/dart2 모두 올바르게 동작. 상대 경로의 해석 의도를 명시적으로 표현.

호출처(line 202, 218)는 이미 반환값을 그대로 fetch에 전달하므로 변경 불필요.

---

## Step 3: content.js — 메시지 핸들러 가드 (line 147)

### 3a. 리스너 최상단에 호스트 가드 삽입

```js
chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  // 호스트 정상성 가드 — 모든 액션에 적용
  if (!isAllowedHost()) {
    sendResponse(makeErrorResponse(ERROR_CODES.HOST_INVALID));
    return true;
  }

  // 에러 상태 문서 가드 — getTreeData 제외 (자체 에러 처리 있음)
  if (request.action !== "getTreeData" && isDocumentInErrorState()) {
    sendResponse(makeErrorResponse(ERROR_CODES.DOCUMENT_ERROR_STATE));
    return true;
  }

  // ... 기존 핸들러들
```

**getTreeData 제외 이유**: `extractTreeDataViaInjection()`은 inject.js를 통해 jstree 존재 여부를 자체 확인하고, 없으면 singlePage 모드로 전환. 에러 상태 가드가 여기서 먼저 차단하면 singlePage fallback 경로가 막힘.

### 3b. fetchNodeHTML 에러 응답에 errorCode 추가 (line 222)

```js
.catch((e) => sendResponse({
  success: false,
  errorCode: ERROR_CODES.FETCH_FAILURE,
  error: e.message,
}));
```

### 3c. fetchSinglePageHTML에서 iframe 에러 전파 (line 227-233)

`getSinglePageSourceDocument()`의 기존 인터페이스(Document 반환)는 유지. 대신 에러 상태 가드가 이 핸들러 진입 전에 차단하므로, `getSinglePageSourceDocument()`의 try/catch fallback은 그대로 유지.

### 3d. getDocMeta의 fetch 실패에 에러 코드 추가 (line 210-211)

```js
sendResponse({ success: false, errorCode: ERROR_CODES.FETCH_FAILURE, error: e.message });
```

---

## Step 4: content.js — fetchTextWithTimeout 에러 분류 (line 124-128)

```js
} catch (error) {
  if (error.name === "AbortError") {
    const timeoutError = new Error(ERROR_MESSAGES.FETCH_TIMEOUT);
    timeoutError.errorCode = ERROR_CODES.FETCH_TIMEOUT;
    throw timeoutError;
  }
  if (!error.errorCode) {
    error.errorCode = ERROR_CODES.FETCH_FAILURE;
  }
  throw error;
}
```

기존 `response.ok` 실패 (line 114)도 errorCode 추가:

```js
if (!response.ok) {
  const err = new Error(`문서를 가져오지 못했습니다. (${response.status})`);
  err.errorCode = ERROR_CODES.FETCH_FAILURE;
  throw err;
}
```

---

## Step 5: popup.js — 에러 메시지 세분화

### 5a. URL 패턴 업데이트 (line 45)

**현재**: `tab.url.includes("dart.fss.or.kr/dsaf001/main.do")`
**변경**:

```js
const DART_PAGE_PATTERN = /^https:\/\/dart[12]?\.fss\.or\.kr\/dsaf001\/main\.do/;
```

파일 상단(line 6 뒤)에 정의. line 45에서:

```js
if (!tab || !DART_PAGE_PATTERN.test(tab.url)) {
  throw new Error("DART 문서 페이지가 아닙니다.");
}
```

### 5b. 에러 코드 → 사용자 메시지 매핑

파일 상단에 추가:

```js
const POPUP_ERROR_MESSAGES = {
  HOST_INVALID: "호스트 비정상: 허용된 DART 호스트에서 실행해주세요.",
  DOCUMENT_ERROR_STATE: "페이지 로드 실패 상태: 문서가 정상적으로 로드되지 않았습니다.",
  IFRAME_ACCESS_FAILURE: "문서 콘텐츠를 읽을 수 없습니다. 페이지를 새로고침 해주세요.",
  FETCH_FAILURE: "문서를 가져오지 못했습니다. 네트워크 상태를 확인해주세요.",
  FETCH_TIMEOUT: "문서 요청 시간이 초과되었습니다. 네트워크 상태를 확인해주세요.",
};

function resolveErrorMessage(response) {
  if (response?.errorCode && POPUP_ERROR_MESSAGES[response.errorCode]) {
    return POPUP_ERROR_MESSAGES[response.errorCode];
  }
  return response?.error || "알 수 없는 오류가 발생했습니다.";
}
```

### 5c. 기존 에러 처리 업데이트

- line 58: `throw new Error(resolveErrorMessage(response));`
- line 70: `throw new Error(resolveErrorMessage(singlePageResponse));`
- line 369: `console.warn(\`Failed: ${node.text}\`, resolveErrorMessage(response));`

기존 fallback 문자열 (`"트리 데이터를 가져올 수 없습니다."` 등)은 `resolveErrorMessage()`의 기본값으로 대체됨.

---

## Step 6: manifest.json — dart1/dart2 지원

3곳 확장:

```json
"host_permissions": [
    "https://dart.fss.or.kr/*",
    "https://dart1.fss.or.kr/*",
    "https://dart2.fss.or.kr/*"
],
```

```json
"web_accessible_resources": [{
    "resources": ["inject.js"],
    "matches": [
        "https://dart.fss.or.kr/*",
        "https://dart1.fss.or.kr/*",
        "https://dart2.fss.or.kr/*"
    ]
}],
```

```json
"content_scripts": [{
    "matches": [
        "https://dart.fss.or.kr/dsaf001/main.do*",
        "https://dart1.fss.or.kr/dsaf001/main.do*",
        "https://dart2.fss.or.kr/dsaf001/main.do*"
    ],
    "js": ["content.js"],
    "run_at": "document_idle"
}]
```

순수 추가. 런타임 동작 변경 없이 dart1/dart2에서도 확장이 동작하게 됨.

---

## 변경하지 않는 것

- `getSinglePageSourceDocument()` 반환 타입 — Document 반환 유지. 에러 상태 가드가 핸들러 진입 전에 차단하므로 함수 자체 변경 불필요.
- `inject.js` — 이미 `window.location.origin` 사용. 변경 불필요.
- `html_converter.js`, `section-splitter.js` — 에러 경로와 무관.

## 구현 순서 (의존성 기반)

1. Step 1 + Step 2: 상수, 유틸리티, buildViewerUrl (의존성 없음)
2. Step 4: fetchTextWithTimeout 에러 분류 (Step 1 ERROR_CODES 필요)
3. Step 3: 메시지 핸들러 가드 (Step 1, 2, 4 필요)
4. Step 5: popup.js 에러 표시 (Step 3의 errorCode 응답 필요)
5. Step 6: manifest.json (독립, 아무 때나 가능)

## 검증

1. dart.fss.or.kr에서 정상 문서 열기 → 트리 로드, 다운로드 정상 동작 확인
2. 개발자 콘솔에서 `window.location.hostname`을 임의 값으로 override 불가하므로, 호스트 가드 테스트는 다른 사이트에서 확장 팝업 열어서 에러 메시지 확인
3. 네트워크 차단(DevTools Network throttling → Offline) 후 문서 fetch 시도 → 세분화된 에러 메시지 확인
4. dart1.fss.or.kr 또는 dart2.fss.or.kr 접속 → 확장 동작 확인 (manifest 변경 후)
