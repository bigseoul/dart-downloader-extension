아래 내용을 `/Users/daegyunggang/Documents/workspace/dart-downloader-extension/PRD.md`로 저장해주세요.

---

```markdown
# DART 문서 다운로더 — Product Requirements Document (PRD)

> **Version** 1.0  
> **Last Updated** 2026-03-20  
> **Status** Draft

---

## 1. 개요 (Overview)

**DART 문서 다운로더**는 금융감독원 전자공시시스템(DART)의 공시 문서 열람 페이지에서 동작하는 Chrome 확장 프로그램이다. 사용자가 문서 목차를 트리 형태로 확인하고, 원하는 섹션을 선택하여 해당 HTML 콘텐츠를 ZIP 파일로 일괄 다운로드할 수 있도록 한다.

---

## 2. 배경 및 문제 정의 (Background & Problem)

DART 공시 문서(사업보고서, 감사보고서 등)는 웹 뷰어를 통해 섹션 단위로만 열람 가능하다. 전체 문서 다운로드는 하나의 큰 파일로만 제공되며, 특정 섹션(예: 연결재무제표, 재무제표 주석 등)만 선별적으로 다운로드하는 기능은 제공되지 않는다.

재무 분석, 리서치 등의 업무에서는 문서 전체가 아니라 필요한 섹션만 빠르게 추출해야 하는 경우가 빈번하다.

---

## 3. 목표 (Goals)

- 사용자가 DART 공시 문서의 **목차 트리를 시각적으로 탐색**할 수 있어야 한다.
- **체크박스를 통해 다중 섹션을 선택**하고, 선택한 섹션의 HTML을 **노드 단위로 개별 파일**로 묶어 **ZIP 다운로드**할 수 있어야 한다.
- 부모 노드 선택 시, 해당 노드의 **전체 HTML을 하나의 파일**로 다운로드한다 (하위 노드를 개별 분리하지 않음).
- 조작이 간단하고 직관적이어야 한다.

---

## 4. 비목표 (Non-Goals)

- DART 이외의 사이트 지원
- 다운로드된 HTML의 변환(PDF, Excel 등) 기능
- 문서 내용의 파싱, 분석, 검색 기능
- 사용자 인증/로그인 연동

---

## 5. 대상 사이트 및 기술 환경 (Target Environment)

| 항목 | 내용 |
|---|---|
| **대상 URL** | `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=...` |
| **페이지 구조** | 좌측: jstree 기반 문서 목차 트리 (`#listTree`), 우측: iframe(`#ifrm`) 콘텐츠 뷰어 |
| **트리 라이브러리** | jstree (jQuery 플러그인) |
| **콘텐츠 로드 방식** | `/report/viewer.do?rcpNo=&dcmNo=&eleId=&offset=&length=&dtd=` |
| **노드 메타데이터** | 각 jstree 노드의 `original` 속성에 `rcpNo`, `dcmNo`, `eleId`, `offset`, `length`, `dtd` 저장 |

### 5.1. 트리 구조 예시

```
사 업 보 고 서
├── 【 대표이사 등의 확인 】
├── I. 회사의 개요
│   ├── 1. 회사의 개요
│   ├── 2. 회사의 연혁
│   └── ...
├── III. 재무에 관한 사항
│   ├── 1. 요약재무정보
│   ├── 2. 연결재무제표          ← 부모 노드 (선택 시 하나의 HTML)
│   │   ├── 2-1. 연결 재무상태표   ← 자식 노드
│   │   ├── 2-2. 연결 손익계산서
│   │   └── ...
│   └── ...
└── ...
```

### 5.2. 콘텐츠 Fetch 방식

각 노드의 HTML은 `original` 메타데이터의 파라미터를 조합하여 `viewer.do` 엔드포인트에 GET 요청으로 가져온다.

```
GET https://dart.fss.or.kr/report/viewer.do
    ?rcpNo={rcpNo}
    &dcmNo={dcmNo}
    &eleId={eleId}
    &offset={offset}
    &length={length}
    &dtd={dtd}
```

응답: 완전한 HTML 문서 (DOCTYPE 포함)

---

## 6. 사용자 시나리오 (User Flow)

1. 사용자가 DART 공시 문서 열람 페이지(`dsaf001/main.do`)에 접속한다.
2. Chrome 툴바에서 **DART 문서 다운로더** 아이콘을 클릭한다.
3. **팝업 창**이 열리며, 현재 문서의 목차가 **체크박스가 포함된 트리** 형태로 표시된다.
4. 사용자가 원하는 노드의 **체크박스를 선택**한다.
   - 부모 노드 선택 시 하위 노드도 자동 선택된다.
   - 하위 노드 일부를 해제할 수도 있다.
5. **"📥 다운로드 (N개)"** 버튼을 클릭한다.
6. 선택된 각 노드의 HTML을 fetch하여 **ZIP 파일**로 묶어 다운로드한다.
   - 진행 상황이 프로그레스 바로 표시된다.
7. `{문서제목}.zip` 파일이 다운로드되고, 내부에 `{노드이름}.html` 파일들이 포함된다.

---

## 7. 기능 요구사항 (Functional Requirements)

### FR-1. 트리 목차 표시
- DART 페이지의 jstree(`#listTree`)에서 전체 노드 데이터를 추출한다.
- 팝업에서 계층 구조 그대로 트리를 렌더링한다.
- 각 노드 앞에 **체크박스**를 표시한다.
- 자식 노드가 있는 경우 **접기/펼치기** 토글을 제공한다.

### FR-2. 노드 선택
- 체크박스로 개별 노드를 선택/해제할 수 있다.
- **부모 노드 선택 시** 하위 모든 자식 노드도 자동 선택된다.
- **부모 노드 해제 시** 하위 모든 자식 노드도 자동 해제된다.
- 자식 노드 일부만 선택된 경우 부모 체크박스는 **indeterminate** 상태를 표시한다.
- **전체 선택 / 선택 해제** 버튼을 제공한다.

### FR-3. 다운로드
- 선택된 노드 중 **유효 노드**만 다운로드한다 (부모가 이미 선택된 자식은 중복 제외).
- 각 유효 노드의 `original` 메타데이터를 사용하여 `viewer.do`에서 HTML을 fetch한다.
- 가져온 HTML들을 **JSZip**으로 묶어 하나의 ZIP 파일로 생성한다.
- 파일명 규칙:
  - ZIP 파일명: `{페이지 제목}.zip`
  - 개별 HTML 파일명: `{노드 텍스트}.html`
  - 파일명에서 OS 금지 문자(`\ / : * ? " < > |`)는 `_`로 치환
- `chrome.downloads` API의 `saveAs: true` 옵션으로 저장 위치 선택 가능

### FR-4. 진행 표시
- 다운로드 진행 중 **오버레이**로 프로그레스 바를 표시한다.
- `완료 수 / 전체 수` 텍스트를 함께 표시한다.

---

## 8. 비기능 요구사항 (Non-Functional Requirements)

| 항목 | 요구사항 |
|---|---|
| **플랫폼** | Chrome 확장 프로그램 (Manifest V3) |
| **대상 브라우저** | Chrome 88+ |
| **권한** | `activeTab`, `scripting`, `downloads` |
| **호스트 권한** | `https://dart.fss.or.kr/*` |
| **팝업 크기** | 너비 420px, 최대 높이 550px |
| **성능** | 노드 134개 기준 트리 렌더링 100ms 이내 |
| **에러 처리** | DART 페이지가 아닐 경우 안내 메시지, fetch 실패 시 해당 노드 건너뛰기 |

---

## 9. 기술 아키텍처 (Technical Architecture)

```
┌─────────────────────────────────────────────────────┐
│  Chrome Extension (Manifest V3)                     │
│                                                     │
│  ┌───────────┐    chrome.tabs     ┌──────────────┐  │
│  │ popup.js  │  .sendMessage()    │ content.js   │  │
│  │           │ ◄────────────────► │              │  │
│  │ · 트리 UI  │  ① getTreeData    │ · jstree 접근  │  │
│  │ · ZIP 생성 │  ② fetchNodeHTML  │ · HTML fetch  │  │
│  │ · 다운로드  │                   │              │  │
│  └─────┬─────┘                   └──────┬───────┘  │
│        │                                │           │
│        ▼                                ▼           │
│  chrome.downloads API        DART viewer.do API     │
└─────────────────────────────────────────────────────┘
```

### 9.1. 파일 구조

```
dart-downloader-extension/
├── manifest.json          # 확장 프로그램 메타데이터
├── popup.html             # 팝업 UI
├── popup.css              # 팝업 스타일
├── popup.js               # 팝업 로직
├── content.js             # Content Script (DART 페이지 데이터 추출)
├── lib/
│   └── jszip.min.js       # JSZip 라이브러리 (v3.10.1)
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
└── PRD.md                 # 이 문서
```

### 9.2. 통신 흐름

1. **popup → content** : `{ action: "getTreeData" }`
   - content.js가 `jQuery('#listTree').jstree(true)`로 전체 노드 추출 → 트리 JSON 반환
2. **popup → content** : `{ action: "fetchNodeHTML", nodeData: { rcpNo, dcmNo, eleId, offset, length, dtd } }`
   - content.js가 동일 origin에서 `viewer.do` fetch → HTML 문자열 반환
3. **popup.js 내부** : JSZip으로 ZIP blob 생성 → `chrome.downloads.download()` 저장

---

## 10. 엣지 케이스 및 에러 처리 (Edge Cases)

| 상황 | 처리 |
|---|---|
| DART 문서 페이지가 아닌 탭에서 실행 | "DART 공시 문서 페이지에서 실행해주세요" 안내 |
| jstree가 아직 로드되지 않음 | `document_idle` 주입으로 대부분 해결, 실패 시 에러 메시지 |
| 특정 노드 HTML fetch 실패 | 해당 노드 건너뛰고 나머지 계속, 콘솔 에러 로그 |
| 선택 노드 0개 상태에서 다운로드 | 버튼 `disabled`, 클릭 불가 |
| 부모와 자식 동시 선택 | 부모가 선택된 경우 하위 자식은 중복 다운로드에서 제외 |
| 파일명에 OS 금지 문자 | `\ / : * ? " < > |` → `_` 치환 |

---

## 11. 향후 확장 가능성 (Future Considerations)

- 다운로드 포맷 선택 (HTML / PDF / 텍스트)
- 다운로드 이력 관리
- 여러 공시 문서 간 비교/병합 다운로드
- 자동 폴더 구조 생성 (트리 계층에 따른 하위 폴더)

---

## 12. 릴리즈 체크리스트

- [ ] 모든 파일 생성 완료
- [ ] JSZip 라이브러리 포함
- [ ] 아이콘 파일 준비
- [ ] Chrome 개발자 모드에서 로드 테스트
- [ ] DART 사업보고서 페이지에서 트리 표시 확인
- [ ] 단일 노드 선택 → 다운로드 확인
- [ ] 다중 노드 선택 → ZIP 다운로드 확인
- [ ] 부모/자식 중복 제거 확인
- [ ] 에러 케이스 테스트 (비DART 페이지 등)
```

---

PRD 문서입니다. 앞서 분석한 DART 페이지의 실제 기술 구조(jstree, `viewer.do` API, `original` 메타데이터 등)를 모두 반영했습니다. 프로젝트 폴더에 `PRD.md`로 저장해주시면 됩니다. 

수정이나 추가할 내용 있으면 말씀해주세요!