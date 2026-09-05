/*
------------------------------------------
@Author: sm
@Date: 2026.06.01
@Description: 梦想家TSE微信小程序签到
cron: 58 12 * * *
------------------------------------------
变量名：mengxiangjia
变量值：YYB服务器地址@账号ID或OpenID，多账号用 & 或换行
依赖变量：YYB_SERVER（服务器地址@账号ID或OpenID）
------------------------------------------
*/

const { Env, yybCacheKey } = require("./env.js");
const $ = new Env("梦想家TSE微信小程序签到");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const WeChatServer = require("./wcs.js");

const ckName = "mengxiangjia";
const MINI_APP_ID = "wx696605f7e70c1e24";
const VERSION = "2.30.6";
const API_BASE = "https://smp-api.iyouke.com/dtapi";
const TOKEN_CACHE_FILE = path.join(__dirname, "mengxiangjia_token_cache.json");
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) MicroMessenger/3.9.12 MiniProgramEnv/Windows WindowsWechat/WMPF";

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

function maskToken(token = "") {
    const value = String(token || "");
    return value ? `${value.slice(0, 6)}***${value.slice(-6)}` : "";
}

function formatSignDate(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}/${month}/${day}`;
}

function isTokenError(message = "") {
    return /401|403|token|登录|授权|未登录|invalid/i.test(String(message));
}

class Task {
    constructor(openid) {
        this.index = $.userIdx++;
        this.account = parseAccount(openid) || {};
        this.openid = this.account.ref || "";
        this.cacheId = yybCacheKey(this.account.server, this.account.ref);
        this.wechat = this.account.server ? new WeChatServer({ url: this.account.server, appid: MINI_APP_ID, auth: process.env.wx_auth || "" }) : null;
        this.loginResult = {};
    }

    get accessToken() {
        return this.loginResult.access_token || this.loginResult.accessToken || "";
    }

    async run() {
        if (!this.account.ref) {
            $.log(`账号[${this.index}] ❌ YYB_SERVER 格式无效（应为 服务器地址@账号ID或OpenID）`);
            return;
        }
        const cached = this.getCachedToken();
        if (cached?.access_token || cached?.accessToken) {
            this.loginResult = cached;
            $.log(`账号[${this.index}] 使用缓存token: ${maskToken(this.accessToken)}`);
            if (!(await this.checkToken())) {
                this.removeCachedToken();
                $.log(`账号[${this.index}] 缓存token失效，重新code登录`);
            }
        }

        if (!this.accessToken) {
            await this.loginByWxCode();
            if (!this.accessToken) return;
        }

        await this.getPointsInfo("签到前");
        await this.getSignConfig();
        const today = await this.getTodaySignItem();
        if (today?.daySignStatus === 2) {
            $.log(`账号[${this.index}] 今日已签到`);
        } else {
            await this.signIn(today?.dateStr);
        }
        await this.getPointsInfo("签到后");
    }

    getCachedToken() {
        const cache = readTokenCache();
        return cache[this.cacheId] || null;
    }

    saveCachedToken() {
        if (!this.accessToken) return;
        const cache = readTokenCache();
        cache[this.cacheId] = {
            ...this.loginResult,
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
        this.loginResult = {};
    }

    headers(withToken = true) {
        const headers = {
            "User-Agent": USER_AGENT,
            "Referer": `https://servicewechat.com/${MINI_APP_ID}/5/page-frame.html`,
            "Accept": "application/json, text/plain, */*",
            "appId": MINI_APP_ID,
            "version": VERSION,
            "envVersion": "release",
        };
        if (withToken && this.accessToken) headers.Authorization = `bearer${this.accessToken}`;
        return headers;
    }

    async request({ method = "GET", apiPath, data = {}, params = {}, needToken = true }) {
        const options = {
            method,
            url: `${API_BASE}${apiPath}`,
            headers: this.headers(needToken),
            timeout: 15000,
            validateStatus: () => true,
        };
        if (method.toUpperCase() === "GET") options.params = params;
        else options.data = data;

        const { status, data: result } = await axios.request(options);
        if (status !== 200) throw new Error(`HTTP ${status}: ${typeof result === "string" ? result.slice(0, 200) : JSON.stringify(result)}`);
        if (result && Object.prototype.hasOwnProperty.call(result, "error") && Number(result.error) !== 0) {
            const err = new Error(result.errorMsg || result.error_msg || result.message || JSON.stringify(result));
            err.code = result.error;
            throw err;
        }
        return result;
    }

    async getWxCode() {
        if (!this.wechat) throw new Error("YYB_SERVER 格式无效（应为 服务器地址@账号ID或OpenID），无法获取code");
        const { data } = await this.wechat.getCode(this.account.ref);
        return data.data.code;
    }

    async loginByWxCode() {
        try {
            const code = await this.getWxCode();
            const data = await this.request({
                method: "POST",
                apiPath: "/appLogin",
                needToken: false,
                data: {
                    principal: code,
                    appType: 1,
                },
            });
            this.loginResult = data || {};
            this.saveCachedToken();
            $.log(`账号[${this.index}] 登录成功: userId=${data?.userId || ""} token=${maskToken(this.accessToken)}`);
        } catch (e) {
            $.log(`账号[${this.index}] 登录失败: ${e.message || e}`);
        }
    }

    async checkToken() {
        try {
            await this.getPointsInfo("缓存校验");
            return true;
        } catch (e) {
            return false;
        }
    }

    async getSignConfig() {
        try {
            const result = await this.request({ apiPath: "/pointsSign/config/query" });
            const data = result?.data || {};
            $.log(`账号[${this.index}] 签到配置: ${Number(data.signEnable) === 1 ? "已开启" : "未开启"} 日签${data.signReward ?? ""}积分`);
            return data;
        } catch (e) {
            $.log(`账号[${this.index}] 获取签到配置失败: ${e.message || e}`);
            return {};
        }
    }

    async getTodaySignItem() {
        try {
            const result = await this.request({
                apiPath: "/pointsSign/user/sign/list",
                params: { v4Flag: true },
            });
            const list = Array.isArray(result?.data) ? result.data : [];
            const today = list.find((item) => item?.isToday) || {};
            $.log(`账号[${this.index}] 今日签到状态: ${today.dateStr || ""} status=${today.daySignStatus ?? "未知"}`);
            return today;
        } catch (e) {
            $.log(`账号[${this.index}] 获取签到列表失败: ${e.message || e}`);
            return {};
        }
    }

    async getPointsInfo(label = "积分") {
        const result = await this.request({ apiPath: "/pointsSign/user/pointsInfo/query" });
        const data = result?.data || {};
        $.log(`账号[${this.index}] ${label}: ${data.pointsNums ?? "未知"}积分 连签${data.seriesDays ?? 0}天 今日${data.signTodayResult ? "已签" : "未签"}`);
        return data;
    }

    async signIn(dateStr) {
        const date = dateStr ? dateStr.replace(/-/g, "/") : formatSignDate();
        try {
            const result = await this.request({
                apiPath: "/pointsSign/user/sign",
                params: { date },
            });
            const data = result?.data || {};
            $.log(`账号[${this.index}] 签到成功: +${data.signReward ?? 0}积分${data.extraSignReward ? ` 额外+${data.extraSignReward}` : ""}`);
        } catch (e) {
            const message = String(e.message || e);
            if (/已签到|重复签到/.test(message)) {
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
