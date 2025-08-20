// netlify/edge-functions/proxy.ts

import { Context } from "@netlify/edge-functions";

/**
 * 从原始请求头中挑选出需要转发的请求头
 * @param headers 原始请求头
 * @param keys 需要挑选的键名 (可以是字符串或正则表达式)
 * @returns 挑出的新请求头
 */
const pickHeaders = (headers: Headers, keys: (string | RegExp)[]): Headers => {
  const picked = new Headers();
  for (const key of headers.keys()) {
    if (keys.some((k) => (typeof k === "string" ? k === key : k.test(key)))) {
      const value = headers.get(key);
      if (typeof value === "string") {
        picked.set(key, value);
      }
    }
  }
  return picked;
};

/**
 * 跨域资源共享 (CORS) 相关的响应头
 */
const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
  "access-control-allow-headers": "Content-Type, Authorization, x-goog-api-key, x-goog-api-client",
};

/**
 * Netlify Edge Function 的主处理函数
 */
export default async (request: Request, context: Context) => {

  // 处理浏览器的 OPTIONS 预检请求
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204, // No Content
      headers: CORS_HEADERS,
    });
  }

  const { pathname, searchParams } = new URL(request.url);

  // 如果访问根路径，返回一个简单的说明页面
  if (pathname === "/") {
    const blank_html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Google PaLM/Gemini API Proxy on Netlify Edge</title>
</head>
<body>
  <h1>Google PaLM/Gemini API Proxy on Netlify Edge</h1>
  <p>This is a proxy for the Google Generative Language API, deployed on Netlify Edge Functions.</p>
  <p>For technical details, please visit <a href="https://simonmy.com/posts/使用netlify反向代理google-palm-api.html">https://simonmy.com/posts/使用netlify反向代理google-palm-api.html</a></p>
</body>
</html>
    `;
    return new Response(blank_html, {
      headers: {
        ...CORS_HEADERS,
        "content-type": "text/html;charset=UTF-8",
      },
    });
  }

  // 构造目标 API 的 URL
  const targetUrl = new URL(pathname, "https://generativelanguage.googleapis.com");
  
  // 将客户端的查询参数附加到目标 URL
  searchParams.forEach((value, key) => {
    // Netlify 可能会添加一个内部用的 _path 参数，我们不需要它
    if (key !== "_path") {
      targetUrl.searchParams.append(key, value);
    }
  });

  // 挑选并转发必要的请求头
  const forwardedHeaders = pickHeaders(request.headers, [
    "content-type",
    "x-goog-api-client",
    "x-goog-api-key",
    "authorization", // 兼容使用 Authorization 头的场景
  ]);

  // 向 Google API 发起请求
  const googleResponse = await fetch(targetUrl, {
    body: request.body,
    method: request.method,
    headers: forwardedHeaders,
  });

  // ---- 核心优化：稳定的流式响应处理 ----

  // 复制 Google API 的响应头
  const responseHeaders = new Headers(googleResponse.headers);

  // 添加 CORS 头
  Object.entries(CORS_HEADERS).forEach(([key, value]) => {
    responseHeaders.set(key, value);
  });

  // 删除可能导致问题的响应头
  // Netlify Edge 会自动处理压缩和内容长度，手动设置可能导致冲突
  responseHeaders.delete("content-encoding");
  responseHeaders.delete("content-length");
  responseHeaders.delete("alt-svc"); // Google 常用的一个头部，代理时移除更安全

  // 如果上游响应没有 body，直接返回
  if (!googleResponse.body) {
    return new Response(null, {
        headers: responseHeaders,
        status: googleResponse.status,
        statusText: googleResponse.statusText,
    });
  }
  
  // 创建一个 TransformStream，它提供一对可读和可写的流
  // 我们将把上游的响应流 "泵" 入这个流，然后把它的可读端返回给客户端
  const { readable, writable } = new TransformStream();
  googleResponse.body.pipeTo(writable);

  // 返回一个新的 Response，其 body 是我们创建的可读流
  return new Response(readable, {
    headers: responseHeaders,
    status: googleResponse.status,
    statusText: googleResponse.statusText,
  });
};
