/*
------------------------------------------
@Description: 趣淘卡 - 微信小程序静默登录 + 每日签到
cron: 7 14 * * *
------------------------------------------
变量名：qutaoka
变量值：YYB服务器地址@账号ID或OpenID，多账号用 & 或换行分隔（可加 #备注）

依赖变量：
YYB_SERVER     服务器地址@账号ID或OpenID，多账号换行或 & 分隔
------------------------------------------
契约（appid wx479a4a95ec031d79，host taotaoka.languoyun.cn）：
  登录  POST /api/login    form: code=<code>&nickname=&headimg=&pid=
        -> status==1，data 本身就是 token 字符串（不是对象）
        之后所有请求带请求头 token: <token>
  资料  POST /api/user
  签到  POST /api/sign_add  -> status==1 成功
这个后端的成功码是 status==1（不是 code），失败原因在 msg。
------------------------------------------
*/

const { Env, yybCacheKey } = require("./env.js");
const $ = new Env("趣淘卡");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const WeChatServer = require("./wcs.js");

const ckName = "qutaoka";
const MINI_APP_ID = "wx479a4a95ec031d79";
const BASE = "https://taotaoka.languoyun.cn";
const TOKEN_CACHE_FILE = path.join(__dirname, "qutaoka_token_cache.json");
const USER_AGENT =
    "Mozilla/5.0 (Linux; Android 12; M2012K11AC Build/SKQ1.220303.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Version/4.0 Chrome/134.0.6998.136 Mobile Safari/537.36 MicroMessenger/8.0.48.2580(0x28003036) MiniProgramEnv/android";

const EP_LOGIN = "/api/login";
const EP_USER = "/api/user";
const EP_SIGN = "/api/sign_add";

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
        $.log(`写入token缓存失败: ${e.message || e}`);
    }
}

function parseAccount(raw = "") {
    const text = String(raw).trim(), at = text.lastIndexOf("@");
    if (at <= 0) return null;
    const rawServer = text.slice(0, at).trim().replace(/\/+$/, "");
    const identity = text.slice(at + 1), hash = identity.indexOf("#");
    const ref = (hash >= 0 ? identity.slice(0, hash) : identity).trim();
    const remark = (hash >= 0 ? identity.slice(hash + 1) : "").trim();
    if (!rawServer || !ref) return null;
    return { server: /^https?:\/\//i.test(rawServer) ? rawServer : `http://${rawServer}`, ref, openid: ref, remark };
}

function short(v, n = 200) {
    const t = typeof v === "string" ? v : JSON.stringify(v);
    return !t ? "" : t.length > n ? `${t.slice(0, n)}...` : t;
}

function form(obj) {
    return Object.entries(obj)
        .map(([k, v]) => `${k}=${encodeURIComponent(v === undefined || v === null ? "" : v)}`)
        .join("&");
}

const isOk = (res) => Number(res?.status) === 1;
const msgOf = (res) => res?.msg || res?.message || short(res);
const isAlreadyDone = (t) => /已签|已经签|签到过|重复|already/i.test(String(t || ""));
const isAuthError = (t) => /登录|token|未授权|失效|过期|重新/i.test(String(t || ""));

class Task {
    constructor(raw) {
        this.index = $.userIdx++;
        this.account = parseAccount(raw) || {};
        this.cacheId = yybCacheKey(this.account.server, this.account.ref);
        this.wechat = this.account.server ? new WeChatServer({ url: this.account.server, appid: MINI_APP_ID, auth: process.env.wx_auth || "" }) : null;
        this.token = "";
    }

    log(text) {
        $.log(`账号[${this.index}]${this.account.remark ? `[${this.account.remark}]` : ""} ${text}`);
    }

    async request(apiPath, body = null) {
        const res = await axios.request({
            method: "POST",
            url: `${BASE}${apiPath}`,
            data: body ? form(body) : "",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                "User-Agent": USER_AGENT,
                Referer: `https://servicewechat.com/${MINI_APP_ID}/0/page-frame.html`,
                ...(this.token ? { token: this.token } : {}),
            },
            timeout: 20000,
            validateStatus: () => true,
        });
        if (res.status !== 200) throw new Error(`${apiPath} HTTP ${res.status}: ${short(res.data)}`);
        return res.data;
    }

    /** wcs.getCode 在 status:false 时也 resolve，必须自己判失败 */
    async getCode() {
        const { data } = await this.wechat.getCode(this.account.ref);
        return data.data.code;
    }

    async login() {
        const code = await this.getCode();
        const res = await this.request(EP_LOGIN, { code, nickname: "", headimg: "", pid: "" });
        if (!isOk(res)) throw new Error(`登录失败: ${msgOf(res)}`);
        // 这个接口的 data 直接就是 token 字符串
        this.token = typeof res.data === "string" ? res.data : (res.data || {}).token || "";
        if (!this.token) throw new Error(`登录未返回 token: ${short(res)}`);
        const cache = readCache();
        cache[this.cacheId] = { token: this.token, updatedAt: new Date().toISOString() };
        writeCache(cache);
        this.log("登录成功");
    }

    async ensureLogin() {
        const cached = readCache()[this.cacheId] || {};
        if (!this.token && cached.token) {
            this.token = cached.token;
            if (await this.queryUser(false)) {
                this.log("使用缓存token");
                return;
            }
            this.log("缓存token失效，重新登录");
            this.token = "";
        }
        if (!this.token) await this.login();
    }

    async queryUser(needLog = true) {
        const res = await this.request(EP_USER);
        if (!isOk(res)) {
            if (needLog) this.log(`读取资料失败: ${msgOf(res)}`);
            return false;
        }
        const d = res.data || {};
        if (needLog) {
            const bits = [];
            for (const k of ["nickname", "nick_name", "mobile", "integral", "points", "score", "balance"]) {
                if (d[k] !== undefined && d[k] !== "") bits.push(`${k}=${d[k]}`);
            }
            this.log(`会员: ${bits.join(" ") || short(d, 120)}`);
        }
        return true;
    }

    async sign(retry = true) {
        const res = await this.request(EP_SIGN);
        if (isOk(res)) return this.log("✅ 签到成功");
        if (isAlreadyDone(msgOf(res))) return this.log(`✅ 今日已签到（${msgOf(res)}）`);
        if (retry && isAuthError(msgOf(res))) {
            this.log("会话失效，重新登录后重试");
            this.token = "";
            await this.login();
            return this.sign(false);
        }
        this.log(`❌ 签到失败: ${msgOf(res)}`);
    }

    async run() {
        if (!this.account.openid) {
            this.log("❌ YYB_SERVER 格式无效（应为 服务器地址@账号ID或OpenID）");
            return;
        }
        try {
            await this.ensureLogin();
            await this.queryUser();
            await this.sign();
        } catch (e) {
            this.log(`执行失败: ${e.message || e}`);
        }
    }
}

!(async () => {
    $.checkEnv("YYB_SERVER");
    const manualList = String(process.env[ckName] || "").split(/\r?\n|&/).map((item) => item.trim()).filter(Boolean);
    for (const item of manualList) if (!$.userList.includes(item)) $.userList.push(item);
    $.userCount = $.userList.length;
    if (!$.userCount) { $.log(`未找到变量 YYB_SERVER 或 ${ckName}`); return; }
    if (!$.userCount) {
        $.log(`未找到变量 ${ckName}`);
        return;
    }
    for (let i = 0; i < $.userList.length; i++) {
        await new Task($.userList[i]).run();
        if (i < $.userList.length - 1) await $.wait(1500, 3000);
    }
})()
    .catch((e) => $.log(e.message || e))
    .finally(() => $.done());
