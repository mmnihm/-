import fs from "node:fs";
import path from "node:path";
import { Transform } from "node:stream";

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
      signal: controller.signal
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
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const body = await fs.promises.readFile(localPath);
          if (body.length !== stat.size) throw new Error("本地文件大小发生变化");
          if (typeof onProgress === "function") {
            try { onProgress(0, body.length); } catch {}
          }
          const r = await request(target, {
            method: "PUT",
            username,
            password,
            headers: {
              "content-type": "application/octet-stream",
              "content-length": String(body.length)
            },
            body,
            timeoutMs: Math.max(180000, Math.min(30 * 60 * 1000, 180000 + Math.ceil(body.length / 1024 / 1024) * 4000))
          });
          if (![200,201,204].includes(r.status)) {
            let detail = "";
            try { detail = (await r.text()).slice(0,300); } catch {}
            throw new Error("123云盘上传失败 HTTP " + r.status + (detail ? "：" + detail : ""));
          }
          if (typeof onProgress === "function") {
            try { onProgress(body.length, body.length); } catch {}
          }
          return {size: body.length};
        } catch (e) {
          lastError = e;
          const message = String(e?.message || e);
          const locked = /423|Locked/.test(message);
          const retryable = locked || /content-length|请求超时|fetch failed|ECONNRESET|ETIMEDOUT|network/i.test(message);
          console.warn("⚠️ 123云盘上传重试:", fileName, attempt + "/3", message);
          if (!retryable || attempt === 3) break;
          await new Promise(resolve => setTimeout(resolve, locked ? 20000 * attempt : 3000 * attempt));
        }
      }
      throw lastError || new Error("123云盘上传失败");
    }
  };
}
