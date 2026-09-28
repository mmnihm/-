import fs from "node:fs";
import path from "node:path";

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
      const stream = fs.createReadStream(localPath);
      let transferred = 0;
      let lastReport = 0;
      stream.on("data", chunk => {
        transferred += chunk.length;
        const now = Date.now();
        if (typeof onProgress === "function" && (now - lastReport >= 500 || transferred === stat.size)) {
          lastReport = now;
          try { onProgress(transferred, stat.size); } catch {}
        }
      });
      const r = await request(target, {
        method: "PUT",
        username,
        password,
        headers: {
          "content-type": "application/octet-stream",
          "content-length": String(stat.size)
        },
        body: stream,
        duplex: "half",
        timeoutMs: Math.max(120000, Math.min(30 * 60 * 1000, 120000 + Math.ceil(stat.size / 1024 / 1024) * 3000))
      });
      if (![200,201,204].includes(r.status)) {
        let detail = "";
        try { detail = (await r.text()).slice(0,300); } catch {}
        throw new Error("123云盘上传失败 HTTP " + r.status + (detail ? "：" + detail : ""));
      }
      return {size:stat.size};
    }
  };
}
