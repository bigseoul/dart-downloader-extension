# 정정 보고서 기수 추출 정확화 계획

## 1. Context

현재 `getDocMeta`는 기수를 `firstNode` HTML 1건에서만 `/제\s*(\d+)\s*기/` 패턴으로 찾는다.  
정정 보고서에서는 기본 선택 문서가 `정 정 신 고 (보고)`일 수 있고, 이 문서 상단에는 기수가 없어서 파일명 접두사의 기수가 빠진다.

실제 DART 페이지(`rcpNo=20180326000377`)를 Playwright로 확인한 결과:

- 기본 선택 노드: `정 정 신 고 (보고)`
- 이 상태의 iframe 상단: `제63기` 없음
- 문서목차에서 `사 업 보 고 서` 선택 시 iframe 상단: `(제 63 기)` 명시

즉, 문제의 핵심은 "기수가 없는 정정 안내 문서가 첫 노드로 잡히는 것"이지, "문서 전체에 기수가 없는 것"이 아니다.

---

## 2. 접근 방식 상세 설명

### 2.1. 새 추출 전략

기수 추출 우선순위를 아래처럼 바꾼다.

1. **현재 표시 문서 DOM**
   - 현재 iframe 또는 현재 문서의 `body.textContent`에서 먼저 추출
   - 사용자가 이미 `사 업 보 고 서` 본문을 보고 있다면 추가 fetch 없이 여기서 끝난다

2. **실제 보고서 노드 우선 후보**
   - 정정 안내 노드는 건너뛰고, 최상위 트리 노드 중 실제 보고서 본문에 해당하는 노드를 우선 후보로 사용
   - 우선 후보 텍스트:
     - `사업보고서`
     - `반기보고서`
     - `분기보고서`
   - 제외 후보 텍스트:
     - `정정신고`
     - `정 정 신 고`

3. **기존 fallback**
   - `firstNode`
   - `docParams`
   - 위 우선 소스에서 못 찾은 경우에만 사용

### 2.2. 왜 이렇게 바꾸는가

- 정정 보고서에서 `firstNode`는 대표 문서가 아니라 정정 안내일 수 있다
- 드롭다운 옵션 텍스트에는 문서명은 보여도 기수는 안 보일 수 있다
- 반면 실제 보고서 본문 상단에는 `(제 63 기)`처럼 기수가 직접 표기되는 경우가 있다
- 따라서 "첫 노드 한 건 fetch"보다 "실제 보고서 노드 우선 선택"이 훨씬 결정적이다

### 2.3. 후보 선택 규칙

`popup.js`는 이미 `treeData`를 가지고 있으므로, 여기서 최상위 노드 텍스트를 보고 "실제 보고서 노드" 후보를 먼저 골라서 `getDocMeta`에 넘긴다.

후보 선택 규칙:

- 대상: `treeData` 최상위 노드
- 포함: 공백 제거 후 `사업보고서|반기보고서|분기보고서`
- 제외: 공백 제거 후 `정정신고`
- 후보 수: 앞에서 최대 3개
- 전달 필드: `rcpNo`, `dcmNo`, `eleId`, `offset`, `length`, `dtd`, `text`

### 2.4. 실패 시 동작

- 현재 문서 DOM에서 못 찾으면 우선 후보 노드들을 순차 fetch
- 그래도 못 찾으면 기존처럼 `firstNode` 또는 `docParams` fallback
- 끝까지 못 찾으면 빈 문자열 유지

---

## 3. 수정 파일 경로

- [content.js](/abs/path/C:/Dev/Workspace/dart-downloader-extension-1/content.js)
- [popup.js](/abs/path/C:/Dev/Workspace/dart-downloader-extension-1/popup.js)

`inject.js`, `manifest.json`, 파일명 생성 로직은 이번 변경 범위에 포함하지 않는다.

---

## 4. 코드 스니펫

### 4.1. `content.js` — 기수 추출 헬퍼 추가

`normalizeTextContent()` 근처에 추가:

```js
function extractPeriodFromText(text) {
  const match = (text || "").match(/제\s*(\d+)\s*기/);
  return match ? `${match[1]}기` : "";
}

function extractPeriodFromHtml(html) {
  const text = normalizeTextContent((html || "").replace(/<[^>]*>/g, " "));
  return extractPeriodFromText(text);
}
```

설명:

- DOM의 `textContent`에는 `extractPeriodFromText()` 사용
- fetch한 HTML 문자열에는 `extractPeriodFromHtml()` 사용
- 태그 사이에 `제`, 숫자, `기`가 분리되는 경우를 막기 위해 태그 제거 후 공백 정규화

### 4.2. `popup.js` — 실제 보고서 노드 후보 구성

`loadTreeData()` 안에서 `getDocMeta` 요청 직전에 추가:

```js
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
```

이후 `getDocMeta` 요청 payload 확장:

```js
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
```

### 4.3. `content.js` — `getDocMeta` 기수 추출 순서 변경

현재 "첫 노드 한 건 fetch"를 아래 순서로 교체:

```js
let period = "";

// 1순위: 현재 표시 문서 DOM
try {
  const doc = getSinglePageSourceDocument();
  period = extractPeriodFromText(doc.body?.textContent);
} catch (_) {}

// 2순위: 실제 보고서 노드 우선 후보
if (!period && Array.isArray(request.reportCandidateNodes)) {
  for (const params of request.reportCandidateNodes) {
    try {
      const html = await fetchTextWithTimeout(buildViewerUrl(params));
      period = extractPeriodFromHtml(html);
      if (period) break;
    } catch (_) {}
  }
}

// 3순위: 기존 fallback
if (!period) {
  const sourceParams = request.firstNode || request.docParams || null;
  if (sourceParams) {
    try {
      const html = await fetchTextWithTimeout(buildViewerUrl(sourceParams));
      period = extractPeriodFromHtml(html);
    } catch (_) {}
  }
}
```

### 4.4. 구현 메모

- `reportCandidateNodes`는 최상위 트리 노드만 사용한다
- `정 정 신 고 (보고)`는 후보에서 제외한다
- 현재 문서 DOM에서 이미 `제63기`가 보이면 추가 fetch 없이 종료한다
- 응답 shape는 기존 유지:

```js
sendResponse({ success: true, companyName, period, docType });
```

---

## 5. 트레이드오프

### 장점

- 정정 보고서에서 `firstNode` 오판 문제를 직접 해결한다
- 실제 보고서 본문 상단의 `(제 63 기)`를 우선 활용하므로 정확도가 올라간다
- 기존 파일명 생성 로직, 응답 shape, `docType` 로직을 안 건드려 영향 범위가 작다
- 현재 문서 DOM에서 찾으면 추가 네트워크 요청 없이 끝난다

### 단점

- 보고서 노드 판별이 `node.text` 문자열 규칙에 의존한다
- 최상위 노드 텍스트 구조가 크게 다른 특수 문서에는 추가 규칙이 필요할 수 있다
- 현재 문서 DOM이 정정 안내 문서인 경우에는 결국 후보 노드 fetch가 필요하다

### 이번 변경에서 하지 않는 것

- 모든 문서 유형에 대한 완전 일반화
- `docType` 판단 로직 재설계
- 숨은 메타데이터나 별도 API가 있는지까지 추가 탐사
- 파일명 생성 규칙 변경

---

## 6. 검증

1. `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=20180326000377`
   - 다운로드 파일명 접두사에 `63기` 포함 확인
   - 기본 선택이 `정 정 신 고 (보고)`여도 정상 추출 확인

2. 일반 사업보고서
   - 기존처럼 회귀 없이 기수 추출 확인

3. 반기/분기보고서
   - 최상위 실제 보고서 노드에서 기수 추출 확인

4. 기수 없는 문서
   - 빈 문자열 유지, 다운로드는 정상 동작 확인

---

## 7. 최종 판단

이 케이스는 일반적인 "후보를 넓게 뒤진다"보다 더 구체적으로 다룰 수 있다.  
핵심은 `정 정 신 고 (보고)`를 대표 문서로 쓰지 않고, 문서목차에서 실제 보고서 본문 노드를 우선 선택해 그 본문 상단의 기수를 읽는 것이다.
