# 단일 페이지형 DART 문서 지원 병합 계획

## Summary

사이드바 `jstree`가 없는 `dsaf001/main.do` 문서도 지원한다. 구현은 `Claude`안의 감지/전체 HTML 확보 방식을 채택하고, 사용자 경험과 분할 기준은 `Codex`안을 채택한다.

핵심 방향은 다음과 같다.

- `inject.js`에서 `currentDocValues`를 이용해 단일 페이지 문서를 감지한다.
- `content.js`에서 `fetchTextWithTimeout()`로 전체 HTML을 가져온다.
- 새 `section-splitter.js` 모듈에서 전체 HTML을 파싱해 섹션 트리를 합성한다.
- 팝업은 기존 트리 UI를 재사용하되, 항상 최상단에 `전체 문서` 노드를 제공한다.
- 분할 단위는 `중간 단위`를 기본으로 하며, `2.1` 수준까지 나누고 `(1)`, `가.` 수준은 제외한다.

## Target Files

- `inject.js`
- `content.js`
- `popup.js`
- `popup.html`
- `section-splitter.js` 신규 추가

현재 코드베이스 기준으로 단일 페이지형 지원은 위 5개 파일만 수정하거나 추가하면 된다. 기존 `html_converter.js`는 다운로드 포맷 변환 로직으로 재사용하고, 이번 작업에서 변경하지 않는다.

## Key Decisions

### 트리 구조

- 플랫 리스트가 아니라 계층 트리를 사용한다.
- 최상단에 `전체 문서` 가상 노드를 항상 추가한다.
- 재무제표 본문은 독립 섹션으로 분리한다.
  - 예: `재무상태표`, `손익계산서`, `포괄손익계산서`, `자본변동표`, `현금흐름표`
- 주석 구간은 하위 트리로 구성한다.
  - 예: `5. 재무제표 주석 > 1. 일반적 사항 > 2.1 재무제표 작성기준`

### 아키텍처

- `inject.js`
  - `jstree`가 없거나 비어 있을 때 `singlePage: true` 와 `docParams`를 반환한다.
  - `currentDocValues`가 있으면 이를 단일 페이지 문서의 원본 파라미터로 사용한다.

- `content.js`
  - `fetchSinglePageHTML` 액션을 추가한다.
  - 기존 `fetchTextWithTimeout()`를 재사용해 전체 HTML을 가져온다.
  - 단일 페이지 전체 HTML 요청은 일반 섹션 요청보다 큰 문서를 다루므로 타임아웃 상향 가능성을 열어둔다.
  - 기존 `getDocMeta` 핸들러는 `request.firstNode` 외에 `request.docParams`도 받을 수 있도록 확장한다.

- `section-splitter.js`
  - 전체 HTML을 `DOMParser`로 파싱한다.
  - 섹션 분할과 트리 합성은 별도 모듈에서 처리한다.
  - `popup.js`에 로직을 과도하게 넣지 않는다.

- `popup.js`
  - 기존 체크박스 트리 UI와 다운로드 흐름을 재사용한다.
  - 단일 페이지형에서는 `fetchSinglePageHTML` 결과를 `section-splitter.js`로 넘겨 트리 노드로 변환한다.

- `popup.html`
  - `section-splitter.js` 스크립트 태그를 추가한다.

## Public Contracts

### 1. `inject.js` → `content.js` 트리 추출 응답

기존 `DART_TREE_DATA` 메시지 형식은 유지하되, 단일 페이지형일 때만 `singlePage`와 `docParams`를 추가한다.

```js
{
  type: "DART_TREE_DATA",
  success: true,
  singlePage: true,
  data: [],
  docParams: {
    rcpNo: string,
    dcmNo: string,
    eleId: string,
    offset: string,
    length: string,
    dtd: string
  }
}
```

### 2. `popup.js` → `content.js` 전체 HTML 요청

새 액션 `fetchSinglePageHTML`를 추가한다.

요청:

```js
{
  action: "fetchSinglePageHTML",
  docParams: { rcpNo, dcmNo, eleId, offset, length, dtd }
}
```

응답:

```js
{
  success: true,
  html: string
}
```

실패 응답은 기존 패턴을 그대로 따른다.

```js
{
  success: false,
  error: string
}
```

### 3. `section-splitter.js` 출력 노드 shape

`popup.js`의 기존 `renderTree()`, `findNodeById()`, `getEffectiveNodes()`를 그대로 쓰기 위해 단일 페이지형 노드도 기존 트리 shape를 따른다.

```js
{
  id: string,
  text: string,
  children: Array<Node>,
  mode: "singlePage",
  _singlePageHtml: string
}
```

주의:

- 일반 `viewer.do` 노드처럼 `rcpNo`, `dcmNo`, `eleId`, `offset`, `length`, `dtd`를 채워 넣지 않는다.
- `downloadSelected()`는 `mode === "singlePage"` 또는 `_singlePageHtml` 존재 여부로 분기한다.
- `전체 문서` 노드는 분할 전 원본 전체 HTML을 `_singlePageHtml`에 그대로 보관해야 한다.

## Section Splitting Rules

### 경계 후보

- `P.SECTION-1`
- `p.section-2`
- `p.table-group-xbrl`
- `h1` ~ `h6`
- 명확한 번호형 제목 `^\d+\.(?:\d+\.)?\s*\S`
- 재무제표 제목 텍스트
  - `재무상태표`
  - `손익계산서`
  - `포괄손익계산서`
  - `자본변동표`
  - `현금흐름표`

### 제외 규칙

- `(1)`, `(2)` 수준은 기본 섹션 경계로 쓰지 않는다.
- `가.`, `나.` 수준은 기본 섹션 경계로 쓰지 않는다.
- `①`, `②` 수준도 기본 섹션 경계로 쓰지 않는다.

### 범위 계산 방식

- 1차 구현은 `body` 직계 자식만 순회하는 방식과 무제한 깊이 탐색의 중간 지점을 택한다.
- 우선순위가 높은 마커(`SECTION-1`, `section-2`, `table-group-xbrl`, `h1-h6`, `a[name^=toc]`)를 먼저 수집하고, 제한된 범위에서 번호형 제목을 보조적으로 인식한다.
- 번호형 제목은 CSS 마커보다 낮은 우선순위로 사용해 표 셀 내부의 우발적 숫자 패턴 오탐을 줄인다.
- 각 섹션 범위는 “현재 경계부터 다음 경계 직전까지”를 기본으로 하되, 1차 구현에서는 구현 복잡도가 큰 전체 DOM 깊이 슬라이싱은 피한다.
- `<table><td>...</td></table>` 깊은 내부의 `2.1`, `2.2` 완전 포착은 2차 개선 항목으로 남긴다.

## Example Tree

```text
전체 문서
재무상태표
손익계산서
포괄손익계산서
자본변동표
현금흐름표
5. 재무제표 주석
├── 1. 일반적 사항
├── 2. 중요한 회계처리방침
│   ├── 2.1 재무제표 작성기준
│   ├── 2.2 회계정책과 공시의 변경
│   └── ...
├── 3. 중요한 회계추정 및 가정
└── ...
```

## Implementation Outline

### `inject.js`

- `jstree` 없음 또는 빈 트리 감지 시 에러 대신 단일 페이지 응답 반환
- 반환 예:

```js
{
  type: "DART_TREE_DATA",
  success: true,
  singlePage: true,
  data: [],
  docParams: { rcpNo, dcmNo, eleId, offset, length, dtd }
}
```

- 수정 위치:
  - `jQuery("#listTree").jstree` 자체가 없는 분기
  - `rootNode.children.length === 0` 분기
- 감지 우선순위:
  - `currentDocValues`가 존재하면 단일 페이지 응답
  - 없으면 기존 에러 응답 유지

### `content.js`

- 새 액션:

```js
{ action: "fetchSinglePageHTML", docParams }
```

- 응답:

```js
{ success: true, html }
```

- 기존 `fetchTextWithTimeout()`를 그대로 재사용한다.
- 큰 문서 대응을 위해 `fetchSinglePageHTML` 경로에서만 타임아웃 값을 별도 상향할 수 있다.
- `getTreeData` 응답은 기존처럼 그대로 popup으로 전달한다. 단일 페이지 분할 로직은 `popup.js`와 `section-splitter.js`가 담당한다.
- 기존 `getDocMeta` 핸들러도 함께 수정한다.
- 멀티 페이지 문서에서는 기존처럼 `request.firstNode`를 사용한다.
- 단일 페이지 문서에서는 `request.docParams`를 사용해 기수 추출용 `viewer.do` HTML을 가져온다.
- 즉 `getDocMeta` 입력 계약은 아래 두 경로를 모두 허용해야 한다.

```js
{ action: "getDocMeta", firstNode }
```

또는

```js
{ action: "getDocMeta", docParams }
```

- `firstNode`가 없더라도 `docParams`가 있으면 메타 추출이 성공 경로로 동작해야 한다.

### `section-splitter.js`

- 입력: 전체 HTML 문자열
- 출력: 팝업 트리와 호환되는 노드 배열
- 노드에는 최소한 아래 성격이 필요하다.
  - `id`
  - `text`
  - `children`
  - 단일 페이지용 HTML 또는 범위 식별 정보
- `전체 문서` 노드는 분할 전 원본 전체 HTML을 그대로 보관해야 한다.

- 권장 공개 함수:

```js
function buildSinglePageTree(htmlText)
```

- 반환 형식:
  - 최상단 배열
  - 첫 번째 원소는 항상 `전체 문서`
  - 이후 재무제표 섹션
  - 이후 주석 계층 섹션

- 구현 단계:
  1. HTML을 `DOMParser`로 파싱
  2. 신뢰도 높은 마커 후보를 수집
  3. 제목 텍스트와 DOM 순서로 경계 목록 정리
  4. 경계 간 범위를 HTML fragment로 직렬화
  5. 재무제표 상위 섹션과 주석 하위 섹션을 트리로 합성

- 1차 구현 제한:
  - 깊은 테이블 내부의 `2.1`, `2.2`는 완전 포착을 보장하지 않는다.
  - CSS 마커가 없는 순수 텍스트 번호형 제목은 오탐 방지를 위해 보수적으로만 사용한다.

### `popup.js`

- `singlePage === true`이면:
  - 전체 HTML fetch
  - `section-splitter.js`로 분할
  - 결과를 기존 `renderTree()`로 렌더링
- 다운로드 시:
  - 단일 페이지 노드는 분할 결과 HTML 사용
  - 일반 노드는 기존 `viewer.do` fetch 경로 사용

- 실제 수정 함수:
  - `loadTreeData()`
  - `downloadSelected()`

- `loadTreeData()` 변경 내용:
  - `getTreeData` 응답에 `singlePage`가 있으면 `fetchSinglePageHTML` 호출
  - 반환된 HTML을 `buildSinglePageTree(html)`에 전달
  - 결과 노드를 `treeData`에 넣고 기존 `renderTree()` 호출
  - 단일 페이지 모드에서도 `docTitle` 표시와 에러 처리 흐름은 유지

- `downloadSelected()` 변경 내용:
  - 각 노드에서 `_singlePageHtml`이 있으면 추가 fetch 없이 바로 저장
  - `_singlePageHtml`이 없으면 기존 `fetchNodeHTML` 경로 사용
  - 기존 파일명 중복 제거, ZIP 생성, HTML/TXT 분기 로직은 그대로 유지

- 메타 정보 처리:
  - 기존 `getDocMeta`는 첫 노드의 `viewer.do` 파라미터에 의존한다.
  - 단일 페이지 모드에서는 첫 노드 대신 `docParams`를 전달해 기수 추출이 가능하도록 확장해야 한다.

### `popup.html`

- 현재 스크립트 순서:

```html
<script src="lib/jszip.min.js"></script>
<script src="html_converter.js"></script>
<script src="popup.js"></script>
```

- 변경 후 순서:

```html
<script src="lib/jszip.min.js"></script>
<script src="html_converter.js"></script>
<script src="section-splitter.js"></script>
<script src="popup.js"></script>
```

`section-splitter.js`는 `popup.js`보다 먼저 로드되어야 한다.

## Tradeoffs

- `inject.js`에서 단일 페이지를 감지하고 `popup.js`에서 전체 HTML을 fetch하는 구조는 구현이 단순하다.
- `content.js`에서 바로 분할까지 끝내는 구조보다 popup 수정이 조금 늘지만, 분할 로직을 UI 근처 모듈로 분리해 테스트하기 쉽다.
- `section-splitter.js`를 별도 파일로 두면 가독성과 유지보수성이 좋아지지만, 스크립트 로드 순서를 추가로 관리해야 한다.
- 1차 구현은 완전한 DOM 깊이 기반 분할보다 보수적이다. 대신 오탐을 줄이고 빠르게 안정화할 수 있다.
- `전체 문서` fallback을 항상 제공하므로, 자동 분할이 불완전해도 사용성은 유지된다.

## Test Plan

- 기존 `jstree` 문서에서 기존 동작이 유지되는지 확인
- 단일 페이지 문서에서 에러 대신 자동 분할 트리가 표시되는지 확인
- 재무제표 본문이 독립 섹션으로 분리되는지 확인
- `재무제표 주석` 아래에 `1.`, `2.`, `2.1` 수준이 보이는지 확인
- `(1)`, `가.` 수준이 과도하게 노출되지 않는지 확인
- `전체 문서` 다운로드가 분할 전 원본 전체 HTML을 반환하는지 확인
- `전체 문서`만 다운로드, 개별 섹션만 다운로드, 부모/자식 동시 선택 시 중복 제거를 확인
- HTML 다운로드와 structured text 다운로드가 모두 정상 동작하는지 확인

## Assumptions

- `currentDocValues`는 단일 페이지 문서에서 계속 사용 가능하다고 가정한다.
- `viewer.do` 전체 HTML은 same-origin fetch로 안정적으로 가져올 수 있다고 가정한다.
- 자동 분리는 완벽하지 않을 수 있으므로 `전체 문서` fallback을 항상 제공한다.
- 사용자 가치가 가장 큰 단위는 재무제표 개별 표와 주석의 `2.1` 수준까지라고 본다.
