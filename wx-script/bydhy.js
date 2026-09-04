/*
比亚迪海洋(mina) - 微信小程序静默登录 + 每日签到 — YYB Go（应用宝协议）适配版
青龙变量：YYB_SERVER=yyb-go:8000@账号ID或OpenID
多账号时每行一个，可在账号后加 #备注。
cron: 28 9 * * *
小程序 AppID：wxf62054ec313d6f53
*/

const { Env, yybCacheKey } = require("./env.js");
const $ = new Env("比亚迪海洋签到");
const axios = require("axios");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const MINI_APP_ID = "wxf62054ec313d6f53";
const BASE = "https://mina.bydoceanauto.com";
const AES_KEY = "3993014457161851";
const AES_IV = "PDVcDRWMrBlLHTqh";
const APPKEY = "hyMinaApi";
const APPSECRET = "Kfl%BOk6C5PwARw8";
const TOKEN_CACHE_FILE = path.join(__dirname, "bydhy_token_cache.json");
const USER_AGENT =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 " +
    "MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF";

const DECRYPT_CODE_URL = `${BASE}/?service=mina.decryptCode`;
const SIGN_URL = `${BASE}/?s=ForCommonUcSrv.forward&serviceDir=activity/sign/signIn`;

function readCache() {
    try {
        if (!fs.existsSync(TOKEN_CACHE_FILE)) return {};
        return JSON.parse(fs.readFileSync(TOKEN_CACHE_FILE, "utf8")) || {};
    } catch (e) {
        return {};
    }
}
function writeCache(cache) {
    try {
        fs.writeFileSync(TOKEN_CACHE_FILE, JSON.stringify(cache, null, 2), "utf8");
    } catch (e) {
        $.log(`写入缓存失败: ${e.message || e}`);
    }
}
function parseAccount(raw = "") {
    return parseYYBAccount(raw);
}
function short(v, n = 200) {
    const t = typeof v === "string" ? v : JSON.stringify(v);
    return !t ? "" : t.length > n ? `${t.slice(0, n)}...` : t;
}
function aesEncrypt(text) {
    const c = crypto.createCipheriv("aes-128-cbc", AES_KEY, AES_IV);
    return Buffer.concat([c.update(text, "utf8"), c.final()]).toString("base64");
}
function aesDecrypt(b64) {
    try {
        const d = crypto.createDecipheriv("aes-128-cbc", AES_KEY, AES_IV);
        return Buffer.concat([d.update(Buffer.from(b64, "base64")), d.final()]).toString("utf8");
    } catch (e) {
        return null;
    }
}
function genNonce(n = 16) {
    const cs = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    return Array.from({ length: n }, () => cs[Math.floor(Math.random() * cs.length)]).join("");
}
function commonHeaders() {
    const nonce = genNonce();
    const curtime = String(Math.floor(Date.now() / 1000));
    return {
        "Content-Type": "application/json",
        "X-Clienttraceid": `mina-${crypto.randomUUID()}`,
        Nonce: nonce,
        Curtime: curtime,
        Checksum: crypto.createHash("sha256").update(`${APPSECRET}${nonce}${curtime}`).digest("hex"),
        Appkey: APPKEY,
        "User-Agent": USER_AGENT,
        Xweb_xhr: "1",
        Accept: "*/*",
        Referer: `https://servicewechat.com/${MINI_APP_ID}/115/page-frame.html`,
    };
}

function parseYYBAccount(raw = "") {
    const text = String(raw).trim();
    const at = text.lastIndexOf("@");
    if (at <= 0) return { server: "", openid: "", remark: "" };
    const rawServer = text.slice(0, at).trim().replace(/\/$/, "");
    const [openid, remark] = text.slice(at + 1).split("#").map((v) => (v || "").trim());
    const server = /^https?:\/\//i.test(rawServer) ? rawServer : `http://${rawServer}`;
    return { server, openid, remark: remark || "" };
}

async function getYYBCode(server, ref, appId) {
    const response = await axios.request({
        method: "POST",
        url: server + "/wxapp/getCode",
        data: { ref, app_id: appId },
        headers: { "Content-Type": "application/json" },
        timeout: 30000,
        validateStatus: () => true,
    });
    const payload = response.data || {};
    const code = payload?.data?.result?.code
        || payload?.data?.code
        || payload?.result?.code
        || payload?.code;
    if (response.status !== 200 || !code || typeof code !== "string") {
        throw new Error(`YYB Go 取 code 失败: ${JSON.stringify(payload)}`);
    }
    return code;
}

class Task {
    constructor(raw) {
        this.index = $.userIdx++;
        this.account = parseAccount(raw);
        this.cacheKey = yybCacheKey(this.account.server, this.account.openid);
        this.sessionId = "";
    }
    log(text) {
        $.log(`账号[${this.index}]${this.account.remark ? `[${this.account.remark}]` : ""} ${text}`);
    }
    /** 发 AES 加密请求，返回解密后的对象 */
    async post(url, plainObj) {
        const res = await axios.request({
            method: "POST", url, data: aesEncrypt(JSON.stringify(plainObj)),
            headers: commonHeaders(), timeout: 20000, validateStatus: () => true,
            transformRequest: [(d) => d],
        });
        const t = typeof res.data === "string" ? res.data.trim() : JSON.stringify(res.data);
        const dec = aesDecrypt(t);
        if (dec) { try { return JSON.parse(dec); } catch (e) {} }
        if (res.data && typeof res.data === "object") return res.data;
        try { return JSON.parse(t); } catch (e) { return { _raw: t.slice(0, 160) }; }
    }
    async getCode() {
        return getYYBCode(this.account.server, this.account.openid, MINI_APP_ID);
    }

    async login() {
        const code = await this.getCode();
        const res = await this.post(DECRYPT_CODE_URL, { code });
        this.sessionId = res.session_id || (res.data || {}).session_id || "";
        if (!this.sessionId) throw new Error(`登录未获得 session_id: ${short(res)}`);
        const cache = readCache();
        cache[this.cacheKey] = { sessionId: this.sessionId, updatedAt: new Date().toISOString() };
        writeCache(cache);
        this.log("登录成功");
    }
    async sign(retry = true) {
        const res = await this.post(SIGN_URL, { date: "", belong_brand: "hy", session_id: this.sessionId, app_version: "460", app_client: "mina" });
        const ret = Number(res?.ret);
        const msg = res?.msg || res?.message || "";
        if (ret === 0) {
            const d = res.data || {};
            return this.log(`✅ 签到成功${d.integral !== undefined ? `，积分 ${d.integral}` : ""}${d.continuous !== undefined ? `，连续 ${d.continuous} 天` : ""}${msg ? `（${msg}）` : ""}`);
        }
        if (/已签|签到过|重复|已完成/.test(msg)) return this.log(`✅ 今日已签到（${msg}）`);
        if (ret === 50010) return this.log(`⚠️ 该微信号的比亚迪账号未完成升级/注册（${msg}），需先在比亚迪App里完成账号升级`);
        if (retry && /session|登录|未授权|失效|过期|token/i.test(msg)) {
            this.log("会话失效，重新登录后重试");
            this.sessionId = "";
            await this.login();
            return this.sign(false);
        }
        this.log(`❌ 签到失败(ret=${ret}): ${msg || short(res)}`);
    }
    async ensureLogin() {
        const cached = readCache()[this.cacheKey] || {};
        if (!this.sessionId && cached.sessionId) { this.sessionId = cached.sessionId; this.log("使用缓存session"); return; }
        if (!this.sessionId) await this.login();
    }
    async run() {
        if (!this.account.server || !this.account.openid) { this.log("跳过：变量值里没有 openid"); return; }
        try {
            await this.ensureLogin();
            await this.sign();
        } catch (e) {
            this.log(`执行失败: ${e.message || e}`);
        }
    }
}

!(async () => {
    $.checkEnv();
    if (!$.userCount) {
        $.log("未配置 YYB_SERVER，格式：yyb-go:8000@账号ID或OpenID");
        return;
    }
    for (let i = 0; i < $.userList.length; i++) {
        await new Task($.userList[i]).run();
        if (i < $.userList.length - 1) await $.wait(1500, 3000);
    }
})()
    .catch((e) => $.log(e.message || e))
    .finally(() => $.done());
