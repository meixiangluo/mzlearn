// 公网构建：不内置任何服务端密钥（publishableKey/endpoint 一律不留）。
// AI 生成走「DeepSeek 直连」：用户在「模型配置」页粘贴自己的 DeepSeek API Key，
// 仅存本浏览器 localStorage，由浏览器直调 api.deepseek.com（CORS 已实测放行）。
window.HXW_PUBLIC_CONFIG = {};
