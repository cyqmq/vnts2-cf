import test from "node:test";
import assert from "node:assert/strict";
import { renderLoginHtml, renderPeerLoginHtml, renderAdminLoginHtml, renderLogLoginHtml } from "../src/ui-pages.js";

const PAYLOAD = '</script><script>alert(1)</script>';

for (const [name, render] of [
  ["房间登录页", renderLoginHtml],
  ["互联登录页", renderPeerLoginHtml],
  ["管理员登录页", renderAdminLoginHtml],
  ["日志登录页", renderLogLoginHtml]
]) {
  test(`${name} 的 message 会转义 script 逃逸`, () => {
    const html = render(PAYLOAD);
    // 原始 </script> 不得出现在内嵌脚本中，否则可提前闭合标签注入 XSS
    assert.ok(!html.includes(PAYLOAD), "message 中包含未转义的 </script>");
    assert.ok(html.includes("\\u003c/script>"), "应以 \\u003c 转义形式出现");
  });

  test(`${name} 无 message 时正常渲染`, () => {
    const html = render(undefined);
    assert.ok(html.includes("message: ''"));
  });
}
