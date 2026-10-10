import fs from "node:fs";
import path from "node:path";
import { Agent } from "undici";

const webDavDispatcher = new Agent({
  connectTimeout: 30000,
  headersTimeout: 30 * 60 * 1000,
  bodyTimeout: 30 * 60 * 1000
});

function cleanBaseUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) throw new Error("123云盘 WebDAV 地址不能为空");
  return raw.endsWith("/") ? raw : raw + "/";
}

function encodePathPart(value) {
  return encodeURIComponent(String(value || "").replace(/[\\/:*?"<>|]/g, "_").trim() || "未命名");
}

function joinUrl(base, remotePath = "") {
  const root = cleanBaseUrl(base);
  const parts = String(remotePath || "").split("/").filter(Boolean).map(encodePathPart);
  return root + parts.join("/") + (parts.length ? "/" : "");
}

function authHeader(username, password) {
  return "Basic " + Buffer.from(String(username) + ":" + String(password)).toString("base64");
}

async function request(url, options = {}) {
  const controller = new AbortController();
  const timeoutMs = Number(options.timeoutMs || 30000);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = {
      authorization: authHeader(options.username, options.password),
      ...(options.headers || {})
    };
    return await fetch(url, {
      ...options,
      headers,
      signal: controller.signal,
      dispatcher: webDavDispatcher
    });
  } catch (e) {
    if (e?.name === "AbortError") throw new Error("123云盘请求超时");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export function createWebDavClient(config = {}) {
  const baseUrl = cleanBaseUrl(config.url);
  const username = String(config.username || "");
  const password = String(config.password || "");
  if (!username || !password) throw new Error("123云盘 WebDAV 账号或密码未配置");

  return {
    async test() {
      const r = await request(baseUrl, {
        method: "PROPFIND",
        username,
        password,
        headers: {"Depth":"0"},
        timeoutMs: 20000
      });
      if (![200,207].includes(r.status)) {
        throw new Error("WebDAV 连接失败 HTTP " + r.status);
      }
      return true;
    },

    async ensureDirectory(remotePath) {
      const clean = String(remotePath || "").split("/").filter(Boolean);
      let created = false;
      let existing = false;
      let current = "";
      for (const part of clean) {
        current = current ? current + "/" + part : part;
        const url = joinUrl(baseUrl, current);
        const probe = await request(url, {
          method: "PROPFIND",
          username,
          password,
          headers: {"Depth":"0"},
          timeoutMs: 20000
        });
        if ([200,207].includes(probe.status)) {
          existing = true;
          continue;
        }
        if (![404,405].includes(probe.status)) {
          throw new Error("检查123云盘目录失败 HTTP " + probe.status + "：" + part);
        }

        const mk = await request(url, {
          method: "MKCOL",
          username,
          password,
          timeoutMs: 20000
        });
        if (![200,201,204,405,409].includes(mk.status)) {
          throw new Error("123云盘当前 WebDAV 无法创建目录「" + part + "」，HTTP " + mk.status);
        }

        const verify = await request(url, {
          method: "PROPFIND",
          username,
          password,
          headers: {"Depth":"0"},
          timeoutMs: 20000
        });
        if (![200,207].includes(verify.status)) {
          throw new Error("123云盘目录创建后无法确认：「" + part + "」 HTTP " + verify.status);
        }
        created = true;
      }
      return {created,existing};
    },

    async uploadFile(localPath, remoteDir, fileName, onProgress) {
      const stat = await fs.promises.stat(localPath);
      if (!stat.isFile()) throw new Error("待上传文件不存在");
      await this.ensureDirectory(remoteDir);
      const target = joinUrl(baseUrl, remoteDir) + encodePathPart(fileName);
      let lastError = null;
      // 有限重试，423 锁定与网络瞬时错误采用不同退避策略。
      const maxAttempts = 4;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          const currentStat = await fs.promises.stat(localPath);
          if (!currentStat.isFile() || currentStat.size !== stat.size) {
            throw new Error("本地文件大小发生变化");
          }
          const body = fs.createReadStream(localPath);
          if (typeof onProgress === "function") {
            try { onProgress(0, stat.size); } catch {}
          }
          let r;
          try {
            r = await request(target, {
              method: "PUT",
              username,
              password,
              headers: {
                "content-type": "application/octet-stream",
                "content-length": String(stat.size)
              },
              body,
              duplex: "half",
              timeoutMs: Math.max(180000, Math.min(30 * 60 * 1000, 180000 + Math.ceil(stat.size / 1024 / 1024) * 4000))
            });
          } catch (e) {
            body.destroy();
            throw e;
          }
          if (![200,201,204].includes(r.status)) {
            let detail = "";
            try { detail = (await r.text()).slice(0,300); } catch {}
            throw new Error("123云盘上传失败 HTTP " + r.status + (detail ? "：" + detail : ""));
          }
          if (typeof onProgress === "function") {
            try { onProgress(stat.size, stat.size); } catch {}
          }
          return {size: stat.size};
        } catch (e) {
          lastError = e;
          const message = String(e?.message || e);
          const locked = /(?:HTTP\s*)?423|Locked/i.test(message);
          const retryable = locked ||
            /(?:HTTP\s*)?(?:408|429|5\d\d)\\b|content-length|请求超时|fetch failed|ECONNRESET|ETIMEDOUT|network|UND_ERR_HEADERS_TIMEOUT|Headers Timeout Error|EPIPE|UND_ERR_SOCKET/i.test(message);
          console.warn("⚠️ 123云盘上传:", fileName, "attempt=" + attempt + "/" + maxAttempts, message);
          if (!retryable || attempt === maxAttempts) break;
          // 423 使用 10/30/60 秒退避，避免连续请求继续撞上服务端锁。
          const delay = locked
            ? [10000, 30000, 60000][attempt - 1]
            : Math.min(20000, 5000 * attempt);
          console.warn("⏳ " + Math.ceil(delay / 1000) + " 秒后重试上传:", fileName);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
      throw lastError || new Error("123云盘上传失败");
    }
  };
}
