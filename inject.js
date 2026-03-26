// inject.js - 페이지 컨텍스트에서 실행되어 jstree 데이터를 추출
(function () {
  var maxRetries = 10;
  var retryInterval = 500; // ms
  var attempt = 0;
  var targetOrigin = window.location.origin;
  var startedAt = performance.now();

  function logInjectTiming(step, detail) {
    console.info("[DART AI][inject]", step, detail || "");
  }

  function postTreeResult(payload) {
    window.postMessage(payload, targetOrigin);
  }

  function getSinglePageDocParams() {
    var currentValues =
      typeof currentDocValues !== "undefined" ? currentDocValues : null;
    var searchParams = new URLSearchParams(window.location.search);

    var rcpNo =
      (currentValues && currentValues.rcpNo) || searchParams.get("rcpNo") || "";
    var dcmNo =
      (currentValues && currentValues.dcmNo) || searchParams.get("dcmNo") || "";

    if (!rcpNo || !dcmNo) {
      return null;
    }

    return {
      rcpNo: rcpNo,
      dcmNo: dcmNo,
      eleId: (currentValues && currentValues.eleId) || "0",
      offset: (currentValues && currentValues.offset) || "0",
      length: (currentValues && currentValues.length) || "0",
      dtd: (currentValues && currentValues.dtd) || "HTML",
    };
  }

  function postSinglePageOrError(errorMessage) {
    var docParams = getSinglePageDocParams();
    if (docParams) {
      postTreeResult({
        type: "DART_TREE_DATA",
        success: true,
        singlePage: true,
        data: [],
        docParams: docParams,
      });
      return;
    }

    postTreeResult({
      type: "DART_TREE_DATA",
      success: false,
      error: errorMessage,
    });
  }

  function tryExtract() {
    attempt++;
    try {
      var docParams = getSinglePageDocParams();
      var listTreeElement = document.getElementById("listTree");

      if (!listTreeElement && docParams) {
        logInjectTiming("singlePage.fast-path", {
          elapsedMs: Math.round(performance.now() - startedAt),
          attempt: attempt,
          reason: "listTree-missing",
        });
        postTreeResult({
          type: "DART_TREE_DATA",
          success: true,
          singlePage: true,
          data: [],
          docParams: docParams,
        });
        return;
      }

      if (typeof jQuery === "undefined" || !jQuery("#listTree").jstree) {
        if (attempt < maxRetries) {
          logInjectTiming("jstree.wait", {
            elapsedMs: Math.round(performance.now() - startedAt),
            attempt: attempt,
          });
          setTimeout(tryExtract, retryInterval);
          return;
        }
        postSinglePageOrError("jstree를 찾을 수 없습니다. DART 문서 페이지인지 확인해주세요.");
        return;
      }

      var tree = jQuery("#listTree").jstree(true);
      var rootNode = tree && tree.get_node ? tree.get_node("#") : null;
      if (!tree || !rootNode || !Array.isArray(rootNode.children) || !rootNode.children.length) {
        if (docParams && typeof cnt !== "undefined" && Number(cnt) === 0) {
          logInjectTiming("singlePage.fast-path", {
            elapsedMs: Math.round(performance.now() - startedAt),
            attempt: attempt,
            reason: "empty-toc",
          });
          postTreeResult({
            type: "DART_TREE_DATA",
            success: true,
            singlePage: true,
            data: [],
            docParams: docParams,
          });
          return;
        }
        if (attempt < maxRetries) {
          logInjectTiming("root.wait", {
            elapsedMs: Math.round(performance.now() - startedAt),
            attempt: attempt,
          });
          setTimeout(tryExtract, retryInterval);
          return;
        }
        postSinglePageOrError("트리 데이터가 아직 로드되지 않았습니다.");
        return;
      }

      function buildNodeData(tree, nodeId) {
        var node = tree.get_node(nodeId);
        var original = node.original || {};
        return {
          id: node.id,
          text: (node.text || "").trim(),
          rcpNo: original.rcpNo || "",
          dcmNo: original.dcmNo || "",
          eleId: original.eleId || "",
          offset: original.offset || "",
          length: original.length || "",
          dtd: original.dtd || "",
          children: (node.children || []).map(function (childId) {
            return buildNodeData(tree, childId);
          }),
        };
      }

      var rootChildren = rootNode.children;
      var data = rootChildren.map(function (childId) {
        return buildNodeData(tree, childId);
      });

      logInjectTiming("tree.ready", {
        elapsedMs: Math.round(performance.now() - startedAt),
        attempt: attempt,
        rootCount: rootChildren.length,
      });
      postTreeResult({ type: "DART_TREE_DATA", success: true, data: data });
    } catch (e) {
      if (attempt < maxRetries) {
        logInjectTiming("extract.retry", {
          elapsedMs: Math.round(performance.now() - startedAt),
          attempt: attempt,
          message: e.message,
        });
        setTimeout(tryExtract, retryInterval);
        return;
      }
      postTreeResult(
        { type: "DART_TREE_DATA", success: false, error: e.message },
      );
    }
  }

  tryExtract();
})();
