# 단일 페이지 DART 문서 지원

## Context

일부 DART 공시 문서는 사이드바(jstree) 없이 단일 페이지로 전체 내용이 표시됨.
예: `rcpNo=20260316801476&dcmNo=11126925`

현재 동작: jstree에 노드가 0개일 때 DART 페이지는 `hideTocArea()`를 호출하여 사이드바를 숨기고, `cnt == 0` 조건에서 collapse 버튼도 비활성화함. inject.js는 트리 데이터가 없으므로 에러를 반환하고, 팝업에 에러 메시지가 표시됨.

## 변경 파일

| 파일 | 변경 | 설명 |
|------|------|------|
| `inject.js` | 수정 | 빈 트리 감지 시 `singlePage` 플래그 + `docParams` 반환 |
| `content.js` | 수정 | `fetchSinglePageHTML` 핸들러 추가 |
| `section-splitter.js` | 신규 | HTML → 섹션 분할 알고리즘 |
| `popup.html` | 수정 | `section-splitter.js` 스크립트 태그 추가 |
| `popup.js` | 수정 | 단일 페이지 모드 UI/다운로드 처리 |

## 1. inject.js — 단일 페이지 감지

트리가 비어있을 때(rootNode.children.length === 0, maxRetries 소진), 에러 대신 DART 페이지의 전역변수 `currentDocValues` 존재 여부를 확인:

```js
// 기존: postTreeResult({ success: false, error: "..." })
// 변경: currentDocValues가 있으면 singlePage 응답
if (typeof currentDocValues !== "undefined" && currentDocValues.rcpNo) {
  postTreeResult({
    type: "DART_TREE_DATA",
    success: true,
    singlePage: true,
    data: [],
    docParams: {
      rcpNo: currentDocValues.rcpNo,
      dcmNo: currentDocValues.dcmNo,
      eleId: currentDocValues.eleId || "0",
      offset: currentDocValues.offset || "0",
      length: currentDocValues.length || "0",
      dtd: currentDocValues.dtd || "HTML"
    }
  });
} else {
  postTreeResult({ success: false, error: "..." }); // 기존 에러
}
```

두 곳 수정 필요: jstree 미발견 시(line 20-27)와 children 비어있을 때(line 37-44).

## 2. content.js — 단일 페이지 콘텐츠 가져오기

기존 `fetchTextWithTimeout()` 재사용. 새 액션 핸들러 추가:

```js
if (request.action === "fetchSinglePageHTML") {
  const { rcpNo, dcmNo, eleId, offset, length, dtd } = request.docParams;
  const url = `/report/viewer.do?rcpNo=${rcpNo}&dcmNo=${dcmNo}&eleId=${eleId}&offset=${offset}&length=${length}&dtd=${dtd}`;
  fetchTextWithTimeout(url)
    .then((html) => sendResponse({ success: true, html }))
    .catch((e) => sendResponse({ success: false, error: e.message }));
  return true;
}
```

단일 페이지 문서는 크기가 클 수 있으므로 이 요청에 대해 타임아웃을 30초로 증가 고려.

## 3. section-splitter.js — 섹션 분할 알고리즘

### 분할 기준 (우선순위 순)

1. **`P.SECTION-1`** — DART 단일 페이지 문서의 주요 섹션 구분자 (대문자 클래스명, 18pt, 파란색, 볼드). 예: "재무상태표", "포괄손익계산서", "주석"
2. **`p.section-2`, `p.table-group-xbrl`** — 기존 html_converter.js의 `DART_HEADING_CLASSES`와 동일
3. **`<a name="toc...">`** 앵커를 포함하는 부모 요소
4. **`h1`-`h6`** 태그
5. 위 마커가 모두 없으면 → 전체 문서를 하나의 섹션으로 반환

### 알고리즘

```
function splitDartSections(htmlString):
  doc = DOMParser로 파싱
  body의 직계 자식(child)들을 순회

  섹션 구분자를 만나면 새 섹션 시작:
    - 구분자 노드의 textContent → 섹션 이름
    - 이후 다음 구분자까지의 모든 노드 → 해당 섹션의 HTML

  첫 구분자 이전의 콘텐츠 → "표지" 섹션으로 분리 (실질적 텍스트가 있을 경우)

  반환: [{ id, text, html }, ...]
```

DOM 순회 방식(body의 자식 노드를 순서대로 탐색)을 사용하여 문자열 indexOf의 취약성 회피.

각 섹션 HTML은 `<html><head><meta charset="utf-8"></head><body>...</body></html>`로 래핑하여 `buildStructuredText()`와 호환.

## 4. popup.js — UI 변경

### 단일 페이지 분할 후 팝업 UI 예시

DART 단일 페이지 문서(예: 감사보고서)가 `SECTION-1` 클래스 기준으로 자동 분할된 후,
팝업에 다음과 같이 플랫한 트리 목록으로 표시됨:

```
┌─────────────────────────────────────┐
│ 📄 (주)OO기업/감사보고서/2026.03.16 │  ← docTitle
├─────────────────────────────────────┤
│ [전체선택] [전체해제] [펼치기] [접기]│
│ ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄ │
│ ☑ 표지                              │  ← 첫 SECTION-1 이전 콘텐츠
│ ☑ 재무상태표                         │  ← SECTION-1 마커 텍스트
│ ☑ 포괄손익계산서                     │
│ ☑ 자본변동표                         │
│ ☑ 현금흐름표                         │
│ ☑ 주석                              │
├─────────────────────────────────────┤
│ ☐ HTML로 다운로드                    │
│ [📥 다운로드 (6개 선택)]             │
└─────────────────────────────────────┘
```

- 모든 노드는 children 없이 플랫 — 토글(▶) 버튼 불필요
- 기존 체크박스 선택/해제, 전체 선택 등 동작 그대로 작동
- 분할 마커가 없는 문서는 "전체 문서" 1개 노드만 표시

### loadTreeData() 수정

`response.singlePage === true`일 때:

1. `singlePageParams = response.docParams` 저장
2. `fetchSinglePageHTML` 메시지로 전체 HTML 가져오기
3. `splitDartSections(html)` 호출하여 섹션 배열 생성
4. 섹션을 트리 노드 형태로 변환:
   ```js
   sections.map(s => ({
     id: s.id, text: s.text,
     rcpNo: "", dcmNo: "", eleId: "", offset: "", length: "", dtd: "",
     children: [],
     _singlePageHtml: s.html  // 사전 fetch된 HTML
   }))
   ```
5. `renderTree()` 호출 — 기존 UI 그대로 재사용

### downloadSelected() 수정

다운로드 루프에서 `node._singlePageHtml` 존재 여부 확인:
- 있으면: 직접 사용 (추가 fetch 불필요)
- 없으면: 기존 `fetchNodeHTML` 경로 사용

### getDocMeta 수정

단일 페이지 모드에서는 `firstNode`에 rcpNo/dcmNo가 없으므로, `singlePageParams`를 전달하여 기수 추출.

## 5. 검증 방법

1. 다중 페이지 문서 (기존 동작 유지 확인): `rcpNo=20250312000622` 등
2. 단일 페이지 문서: `rcpNo=20260316801476&dcmNo=11126925`
   - 팝업에 자동 분할된 섹션 목록이 트리로 표시되는지
   - 개별 섹션 선택/해제 가능한지
   - HTML/구조화 텍스트 양쪽 다운로드 모두 정상 동작하는지
   - 전체 선택 후 ZIP 파일명이 올바른지
3. 사이드바 없는 다른 문서 유형으로도 테스트
