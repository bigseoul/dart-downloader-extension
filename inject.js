// inject.js - 페이지 컨텍스트에서 실행되어 jstree 데이터를 추출
(function () {
  var maxRetries = 10;
  var retryInterval = 500; // ms
  var attempt = 0;
  var targetOrigin = window.location.origin;

  function postTreeResult(payload) {
    window.postMessage(payload, targetOrigin);
  }

  function tryExtract() {
    attempt++;
    try {
      if (typeof jQuery === "undefined" || !jQuery("#listTree").jstree) {
        if (attempt < maxRetries) {
          setTimeout(tryExtract, retryInterval);
          return;
        }
        postTreeResult(
          {
            type: "DART_TREE_DATA",
            success: false,
            error: "jstree를 찾을 수 없습니다. DART 문서 페이지인지 확인해주세요.",
          }
        );
        return;
      }

      var tree = jQuery("#listTree").jstree(true);
      var rootNode = tree && tree.get_node ? tree.get_node("#") : null;
      if (!tree || !rootNode || !Array.isArray(rootNode.children) || !rootNode.children.length) {
        if (attempt < maxRetries) {
          setTimeout(tryExtract, retryInterval);
          return;
        }
        postTreeResult(
          {
            type: "DART_TREE_DATA",
            success: false,
            error: "트리 데이터가 아직 로드되지 않았습니다.",
          }
        );
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

      postTreeResult({ type: "DART_TREE_DATA", success: true, data: data });
    } catch (e) {
      if (attempt < maxRetries) {
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
