/*
------------------------------------------
@Author: sm
@Date: 2026.05.31
@Description: 天牛旧衣服回收签到
cron: 4 15 * * *
------------------------------------------
变量名：tnjy
变量值：YYB服务器地址@账号ID或OpenID，多账号用 & 或换行
------------------------------------------
*/

const { Env, yybCacheKey } = require("./env.js");
const $ = new Env("天牛旧衣服回收签到");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const WeChatServer = require("./wcs.js");

const MINI_APP_ID = "wx887c2f947bffa76e";
const PAGE_VERSION = "6";
const API_BASE = "https://tianniunew.fzjingzhou.com";
const TOKEN_CACHE_FILE = path.join(__dirname, "tnjy_token_cache.json");
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) MicroMessenger/3.9.12 MiniProgramEnv/Windows WindowsWechat/WMPF";
const GUEST_TOKEN = "wek2020123456788wek";

let ckName = "tnjy";

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

function readTokenCache() {
    try {
        if (!fs.existsSync(TOKEN_CACHE_FILE)) return {};
        return JSON.parse(fs.readFileSync(TOKEN_CACHE_FILE, "utf8")) || {};
    } catch (e) {
        return {};
    }
}

function writeTokenCache(cache) {
    try {
        fs.writeFileSync(TOKEN_CACHE_FILE, JSON.stringify(cache, null, 2), "utf8");
    } catch (e) {
        $.log(`写入token缓存失败: ${e.message || e}`);
    }
}

function formBody(data = {}) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(data)) {
        if (value !== undefined && value !== null) params.append(key, String(value));
    }
    return params;
}

function isTokenError(message) {
    return /token|登录|验证失败|9999|401|403|expire|过期|失效/i.test(String(message || ""));
}

class Task {
    constructor(openid) {
        this.index = $.userIdx++;
        this.yyb = parseAccount(openid);
        this.openid = this.yyb ? this.yyb.ref : String(openid || "").trim();
        this.cacheId = this.yyb ? yybCacheKey(this.yyb.server, this.yyb.ref) : this.openid;
        this.wechat = this.yyb ? new WeChatServer({ url: this.yyb.server, appid: MINI_APP_ID, auth: process.env.wx_auth || "" }) : null;
        this.session = {};
    }

    async run() {
        if (!this.yyb) {
            $.log(`账号[${this.index}] ❌ YYB_SERVER 格式无效（应为 服务器地址@账号ID或OpenID）`);
            return;
        }
        const cached = this.getCachedToken();
        if (cached) {
            this.session = cached;
            $.log(`账号[${this.index}] 使用缓存token`);
            if (!(await this.checkToken())) {
                this.removeCachedToken();
                $.log(`账号[${this.index}] 缓存token失效，重新登录`);
            }
        }

        if (!this.session.token) {
            await this.loginByWxCode();
            if (!this.session.token) return;
        }

        await this.doSign();
        this.saveCachedToken();
    }

    getCachedToken() {
        const cache = readTokenCache();
        return cache[this.cacheId] || null;
    }

    saveCachedToken() {
        if (!this.session.token) return;
        const cache = readTokenCache();
        cache[this.cacheId] = {
            token: this.session.token,
            userInfo: this.session.userInfo || {},
            newOrder: this.session.newOrder || null,
            updatedAt: new Date().toISOString(),
        };
        writeTokenCache(cache);
    }

    removeCachedToken() {
        const cache = readTokenCache();
        if (cache[this.cacheId]) {
            delete cache[this.cacheId];
            writeTokenCache(cache);
        }
        this.session = {};
    }

    headers() {
        return {
            "content-type": "application/x-www-form-urlencoded",
            "platform": "MP-WEIXIN",
            "User-Agent": USER_AGENT,
            "Referer": `https://servicewechat.com/${MINI_APP_ID}/${PAGE_VERSION}/page-frame.html`,
        };
    }

    async request(apiPath, data = {}, options = {}) {
        const token = options.noauth ? GUEST_TOKEN : (this.session.token || GUEST_TOKEN);
        const res = await axios.post(`${API_BASE}${apiPath}`, formBody({
            ...(data || {}),
            token,
        }), {
            headers: this.headers(),
            timeout: 20000,
            validateStatus: () => true,
        });

        if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
        if (Number(res.data?.code) !== 1000) {
            const error = new Error(res.data?.msg || `接口错误: ${res.data?.code || "unknown"}`);
            error.data = res.data;
            throw error;
        }
        return res.data;
    }

    async getLoginCode() {
        const { data } = await this.wechat.getCode(this.yyb.ref);
        return data.data.code;
    }

    async loginByWxCode() {
        try {
            const code = await this.getLoginCode();
            const res = await this.request("/api/login/getWxMiniProgramSessionKey", {
                code,
                gdtVid: "",
            }, { noauth: true });
            const data = res.data || {};
            this.session = {
                token: data.token || res.token || "",
                userInfo: data.personInfo || {},
                newOrder: data.newOrder || null,
            };
            if (!this.session.token) throw new Error("登录未返回token");
            this.saveCachedToken();
            $.log(`账号[${this.index}] 登录成功`);
        } catch (e) {
            $.log(`账号[${this.index}] 登录失败: ${e.message || e}`);
        }
    }

    async checkToken() {
        try {
            const res = await this.request("/api/Person/index");
            if (res.data) this.session.userInfo = res.data;
            return true;
        } catch (e) {
            return false;
        }
    }

    async doSign() {
        try {
            const res = await this.request("/api/Person/sign");
            const beans = res.data;
            $.log(`账号[${this.index}] 签到成功${beans !== undefined ? `，获得${beans}环保币` : ""}`);
        } catch (e) {
            const message = e.message || e;
            if (/已签到|今日已|重复|已经签到/.test(String(message))) {
                $.log(`账号[${this.index}] 今日已签到`);
                return;
            }
            $.log(`账号[${this.index}] 签到失败: ${message}`);
            if (isTokenError(message)) this.removeCachedToken();
        }
    }
}

!(async () => {
    $.checkEnv("YYB_SERVER");
    const manualList = String(process.env[ckName] || "").split(/\r?\n|&/).map((item) => item.trim()).filter(Boolean);
    for (const item of manualList) if (!$.userList.includes(item)) $.userList.push(item);
    $.userCount = $.userList.length;
    if (!$.userCount) { $.log(`未找到变量 YYB_SERVER 或 ${ckName}`); return; }
    for (const openid of $.userList) {
        await new Task(openid).run();
    }
})()
    .catch((e) => $.log(e.message || e))
    .finally(() => $.done());
